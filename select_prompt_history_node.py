"""
Select Prompt From History — ComfyUI custom node

Prompt history manager supporting multiple JSON history files.

Modes:
  edit        — use the text typed in the node
  random      — pick a random prompt from active history files
  sequential  — cycle through active history files in order

Files written by the pair node can be used as sources too: this node then
offers one half of every pair (``pair_side``). Such files are read-only here;
nothing this node does adds to, changes or removes a pair entry.

HTTP endpoints:
  POST /select_prompt_history/list   — search & merge across multiple files
  GET  /select_prompt_history/scan   — discover JSON files in the node folder
  POST /select_prompt_history/file_info — own prompts / pair entries per file
  POST /prompt_history/save          — upsert a prompt into a file
  POST /prompt_history/delete        — remove one prompt (key) or several (keys)
  POST /prompt_history/restore       — undo a delete
  POST /prompt_history/clear         — delete all prompts from a file (pairs stay)

License: MIT
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
# Relative history paths are resolved against the ComfyUI root. The node folder
# segment is derived from where this package actually lives rather than
# hardcoded, because registry / Manager installs may lowercase or rename it.
_NODE_DIR_REL = os.path.relpath(_HERE, _COMFY_ROOT).replace(os.sep, "/")
_DEFAULT_HISTORY_PATH = f"{_NODE_DIR_REL}/history/prompt_history.json"
_HIST_LOCK = threading.Lock()


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


_PAIR_SIDES = ("positive", "negative")
_PAIR_FILE_ERROR = (
    "this file holds prompt pairs; the single-prompt node only reads it. "
    "Choose another file under 'Save to'."
)


def _pair_side(value: Any) -> str:
    return value if value in _PAIR_SIDES else "positive"


def _load_raw(path: str) -> List[Dict[str, Any]]:
    """Every entry of a history file, untouched.

    Includes entries this node does not own (prompt pairs). Everything that
    writes a file starts from this list, so those entries are never dropped.
    """
    abs_path = _resolve_path(path)
    if not os.path.exists(abs_path):
        return []
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        return []
    except Exception:
        return []


def _is_own(entry: Dict[str, Any]) -> bool:
    """A single-prompt entry, the kind this node writes."""
    text = entry.get("text")
    return isinstance(text, str) and bool(text)


def _is_pair(entry: Dict[str, Any]) -> bool:
    """A prompt-pair entry written by the pair node."""
    return not _is_own(entry) and bool(entry.get("positive") or entry.get("negative"))


def _has_pairs(raw: List[Dict[str, Any]]) -> bool:
    return any(_is_pair(x) for x in raw)


def _view(raw: List[Dict[str, Any]], pair_side: str = "positive") -> List[Dict[str, Any]]:
    """What this node offers from a file, in file order.

    Its own prompts as they are, plus the chosen half of every pair as a
    read-only entry (``from_pair``). A half is keyed by its text, so pairs that
    share it (typically the same negative) collapse into one entry, and it
    merges with the same prompt stored as a single entry elsewhere.
    """
    pair_side = _pair_side(pair_side)
    own_keys = {x.get("key") for x in raw if _is_own(x)}
    out: List[Dict[str, Any]] = []
    derived: Dict[str, int] = {}   # key -> position in ``out``
    for x in raw:
        if _is_own(x):
            out.append(x)
            continue
        if not _is_pair(x):
            continue
        half = x.get(pair_side)
        if not isinstance(half, str) or not half.strip():
            continue
        half = half.strip()
        key = _hash_text(half)
        if key in own_keys:
            continue   # the file's own copy of this prompt is the one to show
        entry = {"key": key, "text": half, "ts": x.get("ts", ""), "hits": x.get("hits", 1), "from_pair": True}
        at = derived.get(key)
        if at is None:
            derived[key] = len(out)
            out.append(entry)
        elif str(entry["ts"]) > str(out[at].get("ts", "")):
            out[at] = entry
    return out


def _load_history(path: str, pair_side: str = "positive") -> List[Dict[str, Any]]:
    """The prompts a file offers to this node (see :func:`_view`). Read-only use."""
    return _view(_load_raw(path), pair_side)


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
    """Add ``text`` to the raw entries of a file, or move it to the top."""
    text = text.strip()
    if not text:
        return items
    key = _hash_text(text)
    items = list(items)
    for i, item in enumerate(items):
        if item.get("key") == key and _is_own(item):
            old = items.pop(i)
            items.insert(0, {"key": key, "text": text, "ts": _now_iso(), "hits": old.get("hits", 1) + 1})
            break
    else:
        items.insert(0, {"key": key, "text": text, "ts": _now_iso(), "hits": 1})
    if max_entries > 0 and len(items) > max_entries:
        # The limit is on this node's prompts; other entries are not its to drop.
        kept: List[Dict[str, Any]] = []
        own = 0
        for item in items:
            if _is_own(item):
                own += 1
                if own > max_entries:
                    continue
            kept.append(item)
        items = kept
    return items


def _save_prompt(path: str, text: str, max_entries: int) -> str | None:
    """Upsert ``text`` into ``path``. Call with _HIST_LOCK held.

    Returns an error message instead of writing when the file holds prompt
    pairs: a plain prompt saved there would show up in the pair node as a
    positive-only pair.
    """
    raw = _load_raw(path)
    if _has_pairs(raw):
        return _PAIR_FILE_ERROR
    _save_history(path, _upsert(raw, text, max_entries=max_entries))
    return None


_warned_pair_targets: set = set()


def _warn_pair_target(path: str) -> None:
    if path in _warned_pair_targets:
        return
    _warned_pair_targets.add(path)
    print(f"[SelectPromptHistory] not saving to {path}: {_PAIR_FILE_ERROR}")


def _clean_entry(entry: Any) -> Dict[str, Any] | None:
    """Validate an entry sent back by the browser (undo of a delete)."""
    if not isinstance(entry, dict):
        return None
    text = entry.get("text")
    meta = _common.clean_meta(entry)
    if meta is None or not isinstance(text, str) or not text.strip():
        return None
    return {"key": meta["key"], "text": text, "ts": meta["ts"], "hits": meta["hits"]}


def _list_response(body: Dict[str, Any]) -> Dict[str, Any]:
    """Search and merge the requested history files (body of the list endpoint)."""
    history_paths = body.get("history_paths", [])
    if not isinstance(history_paths, list):
        history_paths = []
    sort_by = body.get("sort_by", "recent")
    pair_side = _pair_side(body.get("pair_side"))
    offset, size = _common.page_bounds(body)
    matchers = _common.build_term_matchers(
        body.get("query", ""),
        case_sensitive=bool(body.get("case_sensitive", False)),
        whole_word=bool(body.get("whole_word", False)),
        use_regex=bool(body.get("use_regex", False)),
    )

    # One entry per key; for a prompt stored in several files the newest copy wins.
    with _HIST_LOCK:
        per_file = [(path, _load_history(path, pair_side)) for path in history_paths if isinstance(path, str)]
    merged = _common.merge_newest(per_file)

    total = len(merged)

    if sort_by == "alpha":
        merged.sort(key=lambda x: str(x.get("text", "")).lower())
    elif sort_by == "hits":
        merged.sort(key=lambda x: x.get("hits", 0) if isinstance(x.get("hits"), int) else 0, reverse=True)
    else:  # recent: sort by timestamp across all sources
        merged.sort(key=lambda x: str(x.get("ts", "")), reverse=True)

    if matchers:
        merged = [it for it in merged if _common.entry_matches((str(it.get("text", "")),), matchers)]

    return {
        "ok": True,
        "total": total,
        "matched": len(merged),
        "offset": offset,
        "items": [
            {
                "key":     it["key"],
                "text":    it["text"],
                "preview": _build_preview(it["text"]),
                "ts":      it.get("ts", ""),
                "hits":    it.get("hits", 1),
                "source":  it.get("source", ""),
                # Half of a pair: can be used, but not deleted from this node.
                "from_pair": bool(it.get("from_pair")),
            }
            for it in merged[offset:offset + size]
        ],
    }


def _delete_entries(path: str, keys: List[str]) -> List[Dict[str, Any]]:
    """Remove this node's entries by key; returns what was removed (with positions) for undo."""
    with _HIST_LOCK:
        kept, removed = _common.remove_keys(_load_raw(path), keys, only=_is_own)
        if removed:
            _save_history(path, kept)
    return removed


def _restore_entries(path: str, removed: Any) -> int:
    """Put back entries returned by :func:`_delete_entries`."""
    with _HIST_LOCK:
        items, restored = _common.restore_removed(_load_raw(path), removed, _clean_entry)
        if restored:
            _save_history(path, items)
    return restored


def _clear_entries(path: str) -> int:
    """Delete every prompt of this node from a file; pair entries stay. Returns the number removed."""
    with _HIST_LOCK:
        raw = _load_raw(path)
        kept = [x for x in raw if not _is_own(x)]
        if len(kept) != len(raw):
            _save_history(path, kept)
    return len(raw) - len(kept)


def _file_info(paths: Any) -> Dict[str, Dict[str, int]]:
    """Per file: how many prompts are this node's own, and how many pair entries it holds."""
    info: Dict[str, Dict[str, int]] = {}
    if not isinstance(paths, list):
        return info
    with _HIST_LOCK:
        for path in paths:
            if not isinstance(path, str) or path in info:
                continue
            raw = _load_raw(path)
            info[path] = {
                "own":   sum(1 for x in raw if _is_own(x)),
                "pairs": sum(1 for x in raw if _is_pair(x)),
            }
    return info


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
                # Which half of a pair to use from files written by the pair
                # node. Hidden; set in "Manage Files…". Keep new inputs last so
                # the positional widget values of older workflows stay valid.
                "pair_side": (list(_PAIR_SIDES), {"default": "positive"}),
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
        pair_side: str = "positive",
    ):
        all_paths = _parse_paths(history_paths) or [_DEFAULT_HISTORY_PATH]
        active_list = _parse_active(active_paths)
        # Empty active_list means all paths are active
        effective_paths = [p for p in all_paths if p in active_list] if active_list else all_paths

        auto_mode = mode in ("random", "sequential")

        with _HIST_LOCK:
            # Merge items from all effective paths, dedup by key (first occurrence wins).
            # Edit mode never picks from history, so it skips reading the files.
            merged: List[Dict[str, Any]] = []
            seen: set = set()
            for path in (effective_paths if auto_mode else ()):
                for item in _load_history(path, pair_side):
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
                if _save_prompt(save, used_text, max_entries):
                    _warn_pair_target(save)

        conditioning = None
        if clip is not None:
            try:
                import nodes as comfy_nodes  # noqa: PLC0415
                conditioning = comfy_nodes.CLIPTextEncode().encode(clip, used_text)[0]
            except Exception as exc:
                print(f"[SelectPromptHistory] CLIP encode failed: {exc}")

        if auto_mode:
            # Tell the frontend which prompt this run picked (shown on the node).
            return {"ui": {"prompt_history_used": [used_text]}, "result": (used_text, conditioning)}
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
            return web.json_response(_list_response(await request.json()))
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
                    files.append(f"{_NODE_DIR_REL}/{fname}")
            history_dir = os.path.join(_HERE, "history")
            if os.path.isdir(history_dir):
                for fname in sorted(os.listdir(history_dir)):
                    if fname.lower().endswith(".json") and not fname.startswith("_"):
                        files.append(f"{_NODE_DIR_REL}/history/{fname}")
            return web.json_response({"ok": True, "files": files})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/select_prompt_history/file_info")
    async def _sph_file_info(request):
        try:
            body = await request.json()
            return web.json_response({"ok": True, "files": _file_info(body.get("paths"))})
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
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            with _HIST_LOCK:
                err = _save_prompt(path, text, max_entries)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            return web.json_response({"ok": True})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_history/delete")
    async def _ph_delete(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_HISTORY_PATH)
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            removed = _delete_entries(path, _common.keys_from_body(body))
            return web.json_response({"ok": True, "removed": removed})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_history/restore")
    async def _ph_restore(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_HISTORY_PATH)
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            restored = _restore_entries(path, body.get("removed"))
            return web.json_response({"ok": True, "restored": restored})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/prompt_history/clear")
    async def _ph_clear(request):
        try:
            body = await request.json()
            path = body.get("history_path", _DEFAULT_HISTORY_PATH)
            err = _history_path_error(path)
            if err:
                return web.json_response({"ok": False, "error": err}, status=400)
            return web.json_response({"ok": True, "removed": _clear_entries(path)})
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
