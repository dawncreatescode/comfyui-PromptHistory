"""
Select Prompt Pair From History — ComfyUI custom node

Stores and retrieves positive+negative prompt pairs from JSON history files.

Modes:
  edit        — use the text typed in the node
  random      — pick a random pair from active history files
  sequential  — cycle through pairs in order

HTTP endpoints:
  POST /prompt_pair_history/list    — search & merge pairs across files
  POST /prompt_pair_history/save    — upsert a pair into a file
  POST /prompt_pair_history/delete  — remove a pair by key
  POST /prompt_pair_history/clear   — wipe all pairs from a file
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import threading
import time
from typing import Any, Dict, List

try:
    from server import PromptServer
    from aiohttp import web
except ImportError:
    PromptServer = None
    web = None

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMFY_ROOT = os.path.dirname(os.path.dirname(_HERE))
_DEFAULT_PAIR_HISTORY_PATH = "custom_nodes/comfyui-PromptHistory/history/prompt_pair_history.json"
_PAIR_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# History file helpers
# ---------------------------------------------------------------------------

def _resolve_path(path: str) -> str:
    if os.path.isabs(path):
        return path
    return os.path.join(_COMFY_ROOT, path)


def _load_pair_history(path: str) -> List[Dict[str, Any]]:
    abs_path = _resolve_path(path)
    if not os.path.exists(abs_path):
        return []
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            return []
        out = []
        for x in data:
            if not isinstance(x, dict):
                continue
            if x.get("positive") or x.get("negative"):
                out.append(x)
            elif x.get("text"):
                # Single-prompt entry: surface as positive-only pair (read-only compat)
                out.append({**x, "positive": x["text"], "negative": ""})
        return out
    except Exception:
        return []


def _save_pair_history(path: str, items: List[Dict[str, Any]]) -> None:
    abs_path = _resolve_path(path)
    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = abs_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, abs_path)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _hash_pair(positive: str, negative: str) -> str:
    combined = positive.strip() + "\x00" + negative.strip()
    return hashlib.sha1(combined.encode("utf-8", errors="ignore")).hexdigest()[:16]


def _build_preview(text: str, max_chars: int = 100) -> str:
    flat = " ".join(text.split())
    if len(flat) > max_chars:
        flat = flat[:max_chars].rstrip() + "…"
    return flat


def _build_matcher(
    query: str,
    *,
    case_sensitive: bool = False,
    whole_word: bool = False,
    use_regex: bool = False,
):
    """Return a callable(text) -> bool for the query. Mirrors the single-prompt
    node's _search_items matching rules (substring / whole word / regex)."""
    try:
        if use_regex:
            flags = 0 if case_sensitive else re.IGNORECASE
            pat = re.compile(query, flags)
            return lambda text: bool(pat.search(text))
        if whole_word:
            flags = 0 if case_sensitive else re.IGNORECASE
            pat = re.compile(r"\b" + re.escape(query) + r"\b", flags)
            return lambda text: bool(pat.search(text))
        if case_sensitive:
            return lambda text: query in text
        q_lower = query.lower()
        return lambda text: q_lower in text.lower()
    except re.error:
        q_fb = query if case_sensitive else query.lower()
        return lambda text: q_fb in (text if case_sensitive else text.lower())


def _upsert_pair(
    items: List[Dict[str, Any]],
    positive: str,
    negative: str,
    max_entries: int = 10_000,
) -> List[Dict[str, Any]]:
    positive = positive.strip()
    negative = negative.strip()
    if not positive and not negative:
        return items
    key = _hash_pair(positive, negative)
    items = list(items)
    for i, item in enumerate(items):
        if item.get("key") == key:
            old = items.pop(i)
            items.insert(0, {
                "key": key,
                "positive": positive,
                "negative": negative,
                "ts": _now_iso(),
                "hits": old.get("hits", 1) + 1,
            })
            break
    else:
        items.insert(0, {
            "key": key,
            "positive": positive,
            "negative": negative,
            "ts": _now_iso(),
            "hits": 1,
        })
    if max_entries > 0:
        items = items[:max_entries]
    return items


# ---------------------------------------------------------------------------
# Path parsing helpers (same logic as in select_prompt_history_node)
# ---------------------------------------------------------------------------

def _parse_paths(raw: str) -> List[str]:
    seen: set = set()
    out: List[str] = []
    for line in raw.splitlines():
        p = line.strip()
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _parse_active(raw: str) -> List[str]:
    try:
        parsed = json.loads(raw) if raw and raw.strip() else []
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


# ---------------------------------------------------------------------------
# ComfyUI Node
# ---------------------------------------------------------------------------

class SelectPromptPairHistoryNode:
    """
    Select Prompt Pair From History

    Stores and retrieves positive+negative prompt pairs. In random/sequential
    mode, both prompts are pulled from the same history entry so they always
    stay together.
    """

    _seq_index: Dict[str, int] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["edit", "random", "sequential"], {"default": "edit"}),
                "positive": ("STRING", {"multiline": True, "default": ""}),
                "negative": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "clip": ("CLIP",),
                "auto_save": (
                    "BOOLEAN",
                    {"default": True, "label_on": "auto save on", "label_off": "auto save off"},
                ),
                "history_paths": (
                    "STRING",
                    {"multiline": False, "default": _DEFAULT_PAIR_HISTORY_PATH},
                ),
                "save_to_path": (
                    "STRING",
                    {"default": _DEFAULT_PAIR_HISTORY_PATH, "multiline": False},
                ),
                "active_paths": (
                    "STRING",
                    {"default": "", "multiline": False},
                ),
                "max_entries": (
                    "INT",
                    {"default": 500_000, "min": 1, "max": 10_000_000},
                ),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative", "positive_conditioning", "negative_conditioning")
    FUNCTION = "execute"
    CATEGORY = "Prompt Tools"

    @classmethod
    def IS_CHANGED(cls, mode: str, positive: str = "", negative: str = "", **_kwargs):
        if mode in ("random", "sequential"):
            return float("nan")
        return positive + "\x00" + negative

    def execute(
        self,
        mode: str,
        positive: str,
        negative: str,
        clip=None,
        auto_save: bool = True,
        history_paths: str = _DEFAULT_PAIR_HISTORY_PATH,
        save_to_path: str = _DEFAULT_PAIR_HISTORY_PATH,
        active_paths: str = "",
        max_entries: int = 500_000,
    ):
        all_paths = _parse_paths(history_paths) or [_DEFAULT_PAIR_HISTORY_PATH]
        active_list = _parse_active(active_paths)
        effective_paths = [p for p in all_paths if p in active_list] if active_list else all_paths

        with _PAIR_LOCK:
            merged: List[Dict[str, Any]] = []
            seen: set = set()
            for path in effective_paths:
                for item in _load_pair_history(path):
                    k = item.get("key")
                    if k and k not in seen:
                        seen.add(k)
                        merged.append(item)

            if mode == "random" and merged:
                chosen = random.choice(merged)
                used_positive = chosen["positive"]
                used_negative = chosen.get("negative", "")
            elif mode == "sequential" and merged:
                seq_key = "|".join(sorted(effective_paths))
                idx = SelectPromptPairHistoryNode._seq_index.get(seq_key, 0) % len(merged)
                chosen = merged[idx]
                used_positive = chosen["positive"]
                used_negative = chosen.get("negative", "")
                SelectPromptPairHistoryNode._seq_index[seq_key] = idx + 1
            else:
                used_positive = positive.strip()
                used_negative = negative.strip()

            if auto_save and (used_positive or used_negative):
                save = save_to_path.strip() or all_paths[0]
                existing = _load_pair_history(save)
                _save_pair_history(save, _upsert_pair(existing, used_positive, used_negative, max_entries=max_entries))

        pos_cond = None
        neg_cond = None
        if clip is not None:
            try:
                import nodes as comfy_nodes  # noqa: PLC0415
                pos_cond = comfy_nodes.CLIPTextEncode().encode(clip, used_positive)[0]
                neg_cond = comfy_nodes.CLIPTextEncode().encode(clip, used_negative)[0]
            except Exception as exc:
                print(f"[SelectPromptPairHistory] CLIP encode failed: {exc}")

        return (used_positive, used_negative, pos_cond, neg_cond)


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

def _register_pair_routes() -> None:
    if PromptServer is None or web is None:
        return

    routes = PromptServer.instance.routes

    @routes.post("/prompt_pair_history/list")
    async def _pph_list(request):
        try:
            body = await request.json()
            history_paths: List[str] = body.get("history_paths", [])
            query    = body.get("query", "").strip()
            case_sensitive = bool(body.get("case_sensitive", False))
            whole_word     = bool(body.get("whole_word", False))
            use_regex      = bool(body.get("use_regex", False))
            search_in      = body.get("search_in", "positive")
            if search_in not in ("positive", "negative", "both"):
                search_in = "positive"
            sort_by  = body.get("sort_by", "recent")
            max_results = int(body.get("max_results", 300))

            merged: List[Dict[str, Any]] = []
            seen: set = set()
            with _PAIR_LOCK:
                for path in history_paths:
                    for item in _load_pair_history(path):
                        k = item.get("key")
                        if k and k not in seen:
                            seen.add(k)
                            merged.append({**item, "source": path})

            total = len(merged)

            if sort_by == "alpha":
                merged.sort(key=lambda x: x.get("positive", "").lower())
            elif sort_by == "hits":
                merged.sort(key=lambda x: x.get("hits", 0), reverse=True)
            else:
                merged.sort(key=lambda x: x.get("ts", ""), reverse=True)

            if query:
                matcher = _build_matcher(
                    query,
                    case_sensitive=case_sensitive,
                    whole_word=whole_word,
                    use_regex=use_regex,
                )

                def _entry_matches(it: Dict[str, Any]) -> bool:
                    if search_in in ("positive", "both") and matcher(it.get("positive", "")):
                        return True
                    if search_in in ("negative", "both") and matcher(it.get("negative", "")):
                        return True
                    return False

                merged = [it for it in merged if _entry_matches(it)]

            results = merged[:max_results]

            return web.json_response({
                "ok": True,
                "total": total,
                "items": [
                    {
                        "key":              it["key"],
                        "positive":         it["positive"],
                        "negative":         it.get("negative", ""),
                        "positive_preview": _build_preview(it["positive"]),
                        "negative_preview": _build_preview(it.get("negative", "")),
                        "ts":               it.get("ts", ""),
                        "hits":             it.get("hits", 1),
                        "source":           it.get("source", ""),
                    }
                    for it in results
                ],
            })
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_pair_history/save")
    async def _pph_save(request):
        try:
            body = await request.json()
            path     = body.get("history_path", _DEFAULT_PAIR_HISTORY_PATH)
            positive = body.get("positive", "").strip()
            negative = body.get("negative", "").strip()
            max_entries = int(body.get("max_entries", 500_000))
            if not positive and not negative:
                return web.json_response({"ok": False, "error": "empty pair"}, status=400)
            with _PAIR_LOCK:
                _save_pair_history(path, _upsert_pair(_load_pair_history(path), positive, negative, max_entries=max_entries))
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_pair_history/delete")
    async def _pph_delete(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_PAIR_HISTORY_PATH)
            key  = body.get("key", "")
            with _PAIR_LOCK:
                items = [x for x in _load_pair_history(path) if x.get("key") != key]
                _save_pair_history(path, items)
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_pair_history/clear")
    async def _pph_clear(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_PAIR_HISTORY_PATH)
            with _PAIR_LOCK:
                _save_pair_history(path, [])
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)


_register_pair_routes()


# ---------------------------------------------------------------------------
# ComfyUI registration
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "SelectPromptPairHistory": SelectPromptPairHistoryNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SelectPromptPairHistory": "Select Prompt Pair From History",
}
