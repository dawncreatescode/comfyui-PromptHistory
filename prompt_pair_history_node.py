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
  POST /prompt_pair_history/delete  — remove one pair (key) or several (keys)
  POST /prompt_pair_history/restore — undo a delete
  POST /prompt_pair_history/clear   — wipe all pairs from a file
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import threading
import time
from typing import Any, Dict, List

try:
    from server import PromptServer
    from aiohttp import web
except ImportError:
    PromptServer = None
    web = None

try:
    from . import _history_common as _common
except ImportError:  # imported as a plain module (tests)
    import _history_common as _common

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMFY_ROOT = os.path.dirname(os.path.dirname(_HERE))
# See select_prompt_history_node.py: derive the node folder from the real install location.
_NODE_DIR_REL = os.path.relpath(_HERE, _COMFY_ROOT).replace(os.sep, "/")
_DEFAULT_PAIR_HISTORY_PATH = f"{_NODE_DIR_REL}/history/prompt_pair_history.json"
_PAIR_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# History file helpers
# ---------------------------------------------------------------------------

def _resolve_path(path: str) -> str:
    if os.path.isabs(path):
        return path
    return os.path.join(_COMFY_ROOT, path)


def _history_path_error(path: Any) -> str | None:
    """Return a reason the HTTP endpoints must refuse to write to ``path``, else None.

    The endpoints accept arbitrary paths from the browser; limiting writes to
    .json files keeps them from overwriting unrelated files on the server.
    """
    if not isinstance(path, str) or not path.strip():
        return "history_path is empty"
    if not path.strip().lower().endswith(".json"):
        return "history_path must point to a .json file"
    return None


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


def _clean_entry(entry: Any) -> Dict[str, Any] | None:
    """Validate an entry sent back by the browser (undo of a delete)."""
    if not isinstance(entry, dict):
        return None
    positive = entry.get("positive", "")
    negative = entry.get("negative", "")
    meta = _common.clean_meta(entry)
    if meta is None or not isinstance(positive, str) or not isinstance(negative, str):
        return None
    if not positive.strip() and not negative.strip():
        return None
    return {
        "key": meta["key"],
        "positive": positive,
        "negative": negative,
        "ts": meta["ts"],
        "hits": meta["hits"],
    }


def _list_response(body: Dict[str, Any]) -> Dict[str, Any]:
    """Search and merge the requested pair files (body of the list endpoint)."""
    history_paths = body.get("history_paths", [])
    if not isinstance(history_paths, list):
        history_paths = []
    search_in = body.get("search_in", "positive")
    if search_in not in ("positive", "negative", "both"):
        search_in = "positive"
    sort_by = body.get("sort_by", "recent")
    offset, size = _common.page_bounds(body)
    matchers = _common.build_term_matchers(
        body.get("query", ""),
        case_sensitive=bool(body.get("case_sensitive", False)),
        whole_word=bool(body.get("whole_word", False)),
        use_regex=bool(body.get("use_regex", False)),
    )

    # One entry per key; for a pair stored in several files the newest copy wins.
    with _PAIR_LOCK:
        per_file = [(path, _load_pair_history(path)) for path in history_paths if isinstance(path, str)]
    merged = _common.merge_newest(per_file)

    total = len(merged)

    if sort_by == "alpha":
        merged.sort(key=lambda x: str(x.get("positive", "")).lower())
    elif sort_by == "hits":
        merged.sort(key=lambda x: x.get("hits", 0) if isinstance(x.get("hits"), int) else 0, reverse=True)
    else:
        merged.sort(key=lambda x: str(x.get("ts", "")), reverse=True)

    if matchers:
        def _fields(it: Dict[str, Any]) -> List[str]:
            fields = []
            if search_in != "negative":
                fields.append(str(it.get("positive", "")))
            if search_in != "positive":
                fields.append(str(it.get("negative", "")))
            return fields

        merged = [it for it in merged if _common.entry_matches(_fields(it), matchers)]

    return {
        "ok": True,
        "total": total,
        "matched": len(merged),
        "offset": offset,
        "items": [
            {
                "key":              it["key"],
                "positive":         it.get("positive", ""),
                "negative":         it.get("negative", ""),
                "positive_preview": _build_preview(it.get("positive", "")),
                "negative_preview": _build_preview(it.get("negative", "")),
                "ts":               it.get("ts", ""),
                "hits":             it.get("hits", 1),
                "source":           it.get("source", ""),
            }
            for it in merged[offset:offset + size]
        ],
    }


def _delete_entries(path: str, keys: List[str]) -> List[Dict[str, Any]]:
    """Remove pairs by key; returns what was removed (with positions) for undo."""
    with _PAIR_LOCK:
        kept, removed = _common.remove_keys(_load_pair_history(path), keys)
        if removed:
            _save_pair_history(path, kept)
    return removed


def _restore_entries(path: str, removed: Any) -> int:
    """Put back pairs returned by :func:`_delete_entries`."""
    with _PAIR_LOCK:
        items, restored = _common.restore_removed(_load_pair_history(path), removed, _clean_entry)
        if restored:
            _save_pair_history(path, items)
    return restored


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

        auto_mode = mode in ("random", "sequential")

        with _PAIR_LOCK:
            # Edit mode never picks from history, so it skips reading the files.
            merged: List[Dict[str, Any]] = []
            seen: set = set()
            for path in (effective_paths if auto_mode else ()):
                for item in _load_pair_history(path):
                    k = item.get("key")
                    if k and k not in seen:
                        seen.add(k)
                        merged.append(item)

            if mode == "random" and merged:
                chosen = random.choice(merged)
                used_positive = chosen.get("positive", "")
                used_negative = chosen.get("negative", "")
            elif mode == "sequential" and merged:
                seq_key = "|".join(sorted(effective_paths))
                idx = SelectPromptPairHistoryNode._seq_index.get(seq_key, 0) % len(merged)
                chosen = merged[idx]
                used_positive = chosen.get("positive", "")
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

        result = (used_positive, used_negative, pos_cond, neg_cond)
        if auto_mode:
            # Tell the frontend which pair this run picked (shown on the node).
            return {"ui": {"prompt_history_used": [used_positive, used_negative]}, "result": result}
        return result


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
            return web.json_response(_list_response(await request.json()))
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
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
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
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            removed = _delete_entries(path, _common.keys_from_body(body))
            return web.json_response({"ok": True, "removed": removed})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_pair_history/restore")
    async def _pph_restore(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_PAIR_HISTORY_PATH)
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            restored = _restore_entries(path, body.get("removed"))
            return web.json_response({"ok": True, "restored": restored})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_pair_history/clear")
    async def _pph_clear(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_PAIR_HISTORY_PATH)
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
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
