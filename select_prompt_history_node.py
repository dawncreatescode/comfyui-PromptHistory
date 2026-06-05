"""
Select Prompt From History — ComfyUI custom node

Prompt history manager supporting multiple JSON history files.

Modes:
  edit        — use the text typed in the node
  random      — pick a random prompt from active history files
  sequential  — cycle through active history files in order

HTTP endpoints:
  POST /select_prompt_history/list   — search & merge across multiple files
  GET  /select_prompt_history/scan   — discover JSON files in the node folder
  POST /prompt_history/save          — upsert a prompt into a file
  POST /prompt_history/delete        — remove a prompt by key
  POST /prompt_history/clear         — wipe all prompts from a file

License: MIT
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
_DEFAULT_HISTORY_PATH = "custom_nodes/comfyui-PromptHistory/history/prompt_history.json"
_HIST_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# History file helpers
# ---------------------------------------------------------------------------

def _resolve_path(path: str) -> str:
    if os.path.isabs(path):
        return path
    return os.path.join(_COMFY_ROOT, path)


def _load_history(path: str) -> List[Dict[str, Any]]:
    abs_path = _resolve_path(path)
    if not os.path.exists(abs_path):
        return []
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict) and x.get("text")]
        return []
    except Exception:
        return []


def _save_history(path: str, items: List[Dict[str, Any]]) -> None:
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


def _hash_text(text: str) -> str:
    return hashlib.sha1(text.strip().encode("utf-8", errors="ignore")).hexdigest()[:16]


def _build_preview(text: str, max_chars: int = 120) -> str:
    flat = " ".join(text.split())
    if len(flat) > max_chars:
        flat = flat[:max_chars].rstrip() + "\u2026"
    return flat


def _upsert(
    items: List[Dict[str, Any]],
    text: str,
    max_entries: int = 10_000,
) -> List[Dict[str, Any]]:
    text = text.strip()
    if not text:
        return items
    key = _hash_text(text)
    items = list(items)
    for i, item in enumerate(items):
        if item.get("key") == key:
            old = items.pop(i)
            items.insert(0, {"key": key, "text": text, "ts": _now_iso(), "hits": old.get("hits", 1) + 1})
            break
    else:
        items.insert(0, {"key": key, "text": text, "ts": _now_iso(), "hits": 1})
    if max_entries > 0:
        items = items[:max_entries]
    return items


def _search_items(
    items: List[Dict[str, Any]],
    query: str,
    *,
    case_sensitive: bool = False,
    whole_word: bool = False,
    use_regex: bool = False,
    max_results: int = 300,
) -> List[Dict[str, Any]]:
    """Filter items by query. Caller is responsible for sorting before calling."""
    query = query.strip() if query else ""
    if not query:
        return items[:max_results]
    try:
        if use_regex:
            flags = 0 if case_sensitive else re.IGNORECASE
            pat = re.compile(query, flags)
            matcher = pat.search
        elif whole_word:
            flags = 0 if case_sensitive else re.IGNORECASE
            pat = re.compile(r"\b" + re.escape(query) + r"\b", flags)
            matcher = pat.search
        else:
            if case_sensitive:
                matcher = lambda text: query in text  # noqa: E731
            else:
                q_lower = query.lower()
                matcher = lambda text: q_lower in text.lower()  # noqa: E731
    except re.error:
        q_fb = query if case_sensitive else query.lower()
        matcher = lambda text: q_fb in (text if case_sensitive else text.lower())  # noqa: E731

    results: List[Dict[str, Any]] = []
    for item in items:
        if matcher(item.get("text", "")):
            results.append(item)
            if len(results) >= max_results:
                break
    return results


# ---------------------------------------------------------------------------
# Path parsing helper
# ---------------------------------------------------------------------------

def _parse_paths(raw: str) -> List[str]:
    """Return a deduplicated list of non-empty paths from a newline-separated string."""
    seen: set = set()
    out: List[str] = []
    for line in raw.splitlines():
        p = line.strip()
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _parse_active(raw: str) -> List[str]:
    """Parse the active_paths JSON string. Returns [] when all paths are active."""
    try:
        parsed = json.loads(raw) if raw and raw.strip() else []
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


# ---------------------------------------------------------------------------
# ComfyUI Node
# ---------------------------------------------------------------------------

class SelectPromptHistoryNode:
    """
    Select Prompt History

    Like Prompt History but supports multiple history files.
    Open the panel to search across files, toggle which are active,
    and choose where new prompts are saved.

    Modes:
      - edit:       use the text you typed / loaded from the panel
      - random:     pick a random prompt from all active history files
      - sequential: cycle through active history files in order, one prompt per run
    """

    _seq_index: Dict[str, int] = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["edit", "random", "sequential"], {"default": "edit"}),
                "text": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "clip": ("CLIP",),
                "auto_save": (
                    "BOOLEAN",
                    {"default": True, "label_on": "auto save on", "label_off": "auto save off"},
                ),
                # One path per line. Managed through the "Manage Files…" panel button.
                "history_paths": (
                    "STRING",
                    {"multiline": False, "default": _DEFAULT_HISTORY_PATH},
                ),
                # Hidden widgets — managed exclusively through the panel UI.
                "save_to_path": (
                    "STRING",
                    {"default": _DEFAULT_HISTORY_PATH, "multiline": False},
                ),
                "active_paths": (
                    "STRING",
                    {"default": "", "multiline": False},  # JSON array; empty = all active
                ),
                "max_entries": (
                    "INT",
                    {"default": 500_000, "min": 1, "max": 10_000_000},
                ),
            },
        }

    RETURN_TYPES = ("STRING", "CONDITIONING")
    RETURN_NAMES = ("text", "conditioning")
    FUNCTION = "execute"
    CATEGORY = "Prompt Tools"

    @classmethod
    def IS_CHANGED(cls, mode: str, text: str, **_kwargs):
        if mode in ("random", "sequential"):
            return float("nan")
        return text

    def execute(
        self,
        mode: str,
        text: str,
        clip=None,
        auto_save: bool = True,
        history_paths: str = _DEFAULT_HISTORY_PATH,
        save_to_path: str = _DEFAULT_HISTORY_PATH,
        active_paths: str = "",
        max_entries: int = 500_000,
    ):
        all_paths = _parse_paths(history_paths) or [_DEFAULT_HISTORY_PATH]
        active_list = _parse_active(active_paths)
        # Empty active_list means all paths are active
        effective_paths = [p for p in all_paths if p in active_list] if active_list else all_paths

        with _HIST_LOCK:
            # Merge items from all effective paths, dedup by key (first occurrence wins)
            merged: List[Dict[str, Any]] = []
            seen: set = set()
            for path in effective_paths:
                for item in _load_history(path):
                    k = item.get("key")
                    if k and k not in seen:
                        seen.add(k)
                        merged.append(item)

            if mode == "random" and merged:
                used_text = random.choice(merged)["text"]
            elif mode == "sequential" and merged:
                seq_key = "|".join(sorted(effective_paths))
                idx = SelectPromptHistoryNode._seq_index.get(seq_key, 0) % len(merged)
                used_text = merged[idx]["text"]
                SelectPromptHistoryNode._seq_index[seq_key] = idx + 1
            else:
                used_text = text.strip()

            if auto_save and used_text:
                save = save_to_path.strip() or all_paths[0]
                existing = _load_history(save)
                _save_history(save, _upsert(existing, used_text, max_entries=max_entries))

        conditioning = None
        if clip is not None:
            try:
                import nodes as comfy_nodes  # noqa: PLC0415
                conditioning = comfy_nodes.CLIPTextEncode().encode(clip, used_text)[0]
            except Exception as exc:
                print(f"[SelectPromptHistory] CLIP encode failed: {exc}")

        return (used_text, conditioning)


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

def _register_select_routes() -> None:
    if PromptServer is None or web is None:
        return

    routes = PromptServer.instance.routes

    @routes.post("/select_prompt_history/list")
    async def _sph_list(request):
        try:
            body = await request.json()
            history_paths: List[str] = body.get("history_paths", [])
            query        = body.get("query", "")
            case_sensitive = bool(body.get("case_sensitive", False))
            whole_word   = bool(body.get("whole_word", False))
            use_regex    = bool(body.get("use_regex", False))
            sort_by      = body.get("sort_by", "recent")
            max_results  = int(body.get("max_results", 300))

            # Load and merge from all requested paths, tagging each item with its source
            merged: List[Dict[str, Any]] = []
            seen: set = set()
            with _HIST_LOCK:
                for path in history_paths:
                    for item in _load_history(path):
                        k = item.get("key")
                        if k and k not in seen:
                            seen.add(k)
                            merged.append({**item, "source": path})

            total = len(merged)

            # Sort the merged list before filtering
            if sort_by == "alpha":
                merged.sort(key=lambda x: x.get("text", "").lower())
            elif sort_by == "hits":
                merged.sort(key=lambda x: x.get("hits", 0), reverse=True)
            else:  # recent: sort by timestamp across all sources
                merged.sort(key=lambda x: x.get("ts", ""), reverse=True)

            results = _search_items(
                merged, query,
                case_sensitive=case_sensitive,
                whole_word=whole_word,
                use_regex=use_regex,
                max_results=max_results,
            )

            return web.json_response({
                "ok": True,
                "total": total,
                "items": [
                    {
                        "key":     it["key"],
                        "text":    it["text"],
                        "preview": _build_preview(it["text"]),
                        "ts":      it.get("ts", ""),
                        "hits":    it.get("hits", 1),
                        "source":  it.get("source", ""),
                    }
                    for it in results
                ],
            })
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.get("/select_prompt_history/scan")
    async def _sph_scan(request):
        """Return relative paths (from ComfyUI root) for every .json file found
        in the node's own directory and its history/ subdirectory."""
        try:
            files = []
            for fname in sorted(os.listdir(_HERE)):
                if fname.lower().endswith(".json") and not fname.startswith("_"):
                    files.append(f"custom_nodes/comfyui-PromptHistory/{fname}")
            history_dir = os.path.join(_HERE, "history")
            if os.path.isdir(history_dir):
                for fname in sorted(os.listdir(history_dir)):
                    if fname.lower().endswith(".json") and not fname.startswith("_"):
                        files.append(f"custom_nodes/comfyui-PromptHistory/history/{fname}")
            return web.json_response({"ok": True, "files": files})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_history/save")
    async def _ph_save(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_HISTORY_PATH)
            text = body.get("text", "").strip()
            max_entries = int(body.get("max_entries", 500_000))
            if not text:
                return web.json_response({"ok": False, "error": "empty text"}, status=400)
            with _HIST_LOCK:
                _save_history(path, _upsert(_load_history(path), text, max_entries=max_entries))
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_history/delete")
    async def _ph_delete(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_HISTORY_PATH)
            key  = body.get("key", "")
            with _HIST_LOCK:
                items = [x for x in _load_history(path) if x.get("key") != key]
                _save_history(path, items)
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_history/clear")
    async def _ph_clear(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_HISTORY_PATH)
            with _HIST_LOCK:
                _save_history(path, [])
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)


_register_select_routes()


# ---------------------------------------------------------------------------
# ComfyUI registration
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "SelectPromptHistory": SelectPromptHistoryNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SelectPromptHistory": "Select Prompt From History",
}
