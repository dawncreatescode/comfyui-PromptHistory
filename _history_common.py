"""
Shared helpers for the prompt history nodes.

The leading underscore keeps the package loader in ``__init__.py`` from treating
this file as a node module.

Search rules (the history panel highlights with the same rules in JS):
  * A query is split into terms: ``"quoted phrases"`` and bare words.
  * Every term must match (AND). For entries with several text fields a term
    matches when it is found in at least one of the fields being searched.
  * Quoted terms are always literal substrings. Bare terms follow the
    whole-word / regex toggles.

License: MIT
"""

from __future__ import annotations

import re
from typing import Any, Callable, Dict, Iterable, List, Sequence, Tuple

_TERM_RE = re.compile(r'"([^"]+)"|(\S+)')

MAX_PAGE_SIZE = 5000


def parse_query(raw: Any) -> List[Tuple[str, bool]]:
    """Split a raw query into ``(text, quoted)`` terms."""
    if not isinstance(raw, str):
        return []
    terms: List[Tuple[str, bool]] = []
    for m in _TERM_RE.finditer(raw):
        quoted = m.group(1) is not None
        text = (m.group(1) if quoted else m.group(2)).strip()
        if text:
            terms.append((text, quoted))
    return terms


def _literal_matcher(text: str, case_sensitive: bool) -> Callable[[str], bool]:
    if case_sensitive:
        return lambda hay: text in hay
    needle = text.lower()
    return lambda hay: needle in hay.lower()


def build_term_matchers(
    raw: Any,
    *,
    case_sensitive: bool = False,
    whole_word: bool = False,
    use_regex: bool = False,
) -> List[Callable[[str], bool]]:
    """Return one ``callable(text) -> bool`` per query term (empty = match all)."""
    flags = 0 if case_sensitive else re.IGNORECASE
    matchers: List[Callable[[str], bool]] = []
    for text, quoted in parse_query(raw):
        if quoted or not (use_regex or whole_word):
            matchers.append(_literal_matcher(text, case_sensitive))
            continue
        try:
            source = text if use_regex else r"\b" + re.escape(text) + r"\b"
            pat = re.compile(source, flags)
        except re.error:
            # Half-typed regex: fall back to a literal match instead of an error.
            matchers.append(_literal_matcher(text, case_sensitive))
            continue
        matchers.append(lambda hay, _pat=pat: _pat.search(hay) is not None)
    return matchers


def entry_matches(fields: Sequence[str], matchers: Sequence[Callable[[str], bool]]) -> bool:
    """True when every term matches at least one of ``fields``."""
    return all(any(m(f) for f in fields) for m in matchers)


def page_bounds(body: Dict[str, Any], default_size: int = 300) -> Tuple[int, int]:
    """Read ``offset`` / ``max_results`` from a request body, clamped to sane values."""
    try:
        offset = int(body.get("offset", 0))
    except (TypeError, ValueError):
        offset = 0
    try:
        size = int(body.get("max_results", default_size))
    except (TypeError, ValueError):
        size = default_size
    return max(0, offset), max(1, min(MAX_PAGE_SIZE, size))


def keys_from_body(body: Dict[str, Any]) -> List[str]:
    """Collect the keys of a delete request: ``key`` (single) and/or ``keys`` (batch)."""
    keys: List[str] = []
    single = body.get("key")
    if isinstance(single, str) and single:
        keys.append(single)
    many = body.get("keys")
    if isinstance(many, list):
        keys.extend(k for k in many if isinstance(k, str) and k)
    return keys


def remove_keys(
    items: List[Dict[str, Any]],
    keys: Iterable[str],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Drop the entries whose key is in ``keys``.

    Returns ``(kept, removed)`` where ``removed`` is a list of
    ``{"index": original_position, "entry": entry}`` so the deletion can be undone.
    """
    wanted = set(keys)
    kept: List[Dict[str, Any]] = []
    removed: List[Dict[str, Any]] = []
    for i, item in enumerate(items):
        if item.get("key") in wanted:
            removed.append({"index": i, "entry": item})
        else:
            kept.append(item)
    return kept, removed


def restore_removed(
    items: List[Dict[str, Any]],
    removed: Any,
    clean_entry: Callable[[Any], Dict[str, Any] | None],
) -> Tuple[List[Dict[str, Any]], int]:
    """Re-insert entries produced by :func:`remove_keys` at their old positions.

    ``clean_entry`` validates one entry coming from the browser and returns the
    sanitised dict to store, or None to skip it. Entries whose key is already
    present are skipped, so restoring twice is harmless.
    """
    if not isinstance(removed, list):
        return items, 0
    pending: List[Tuple[int, Dict[str, Any]]] = []
    for rec in removed:
        if not isinstance(rec, dict):
            continue
        entry = clean_entry(rec.get("entry"))
        if entry is None:
            continue
        index = rec.get("index")
        pending.append((index if isinstance(index, int) and not isinstance(index, bool) else 0, entry))
    # Ascending original positions rebuild the original order exactly.
    pending.sort(key=lambda p: p[0])

    items = list(items)
    present = {it.get("key") for it in items}
    restored = 0
    for index, entry in pending:
        if entry["key"] in present:
            continue
        items.insert(max(0, min(index, len(items))), entry)
        present.add(entry["key"])
        restored += 1
    return items, restored


def clean_meta(entry: Dict[str, Any]) -> Dict[str, Any] | None:
    """Validate the fields every history entry shares: ``key``, ``ts``, ``hits``."""
    key = entry.get("key")
    if not isinstance(key, str) or not key or len(key) > 64:
        return None
    ts = entry.get("ts")
    hits = entry.get("hits")
    return {
        "key": key,
        "ts": ts if isinstance(ts, str) and len(ts) <= 40 else "",
        "hits": hits if isinstance(hits, int) and not isinstance(hits, bool) and hits > 0 else 1,
    }
