/**
 * Query parsing and match highlighting for the history panel. DOM-free.
 *
 * The backend filters with the same rules (see _history_common.py); this side
 * only needs them to highlight matches and to pick which part of a long prompt
 * a list row shows.
 */

export function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split a raw query into terms: "quoted phrases" and bare words. */
export function parseQuery(raw) {
    const terms = [];
    for (const m of String(raw ?? "").matchAll(/"([^"]+)"|(\S+)/g)) {
        const text = (m[1] ?? m[2]).trim();
        if (text) terms.push({ text, quoted: m[1] !== undefined });
    }
    return terms;
}

/** One global RegExp per term, for highlighting. Unusable terms are skipped. */
export function buildPatterns(terms, opts = {}) {
    const flags = opts.caseSensitive ? "g" : "gi";
    return terms.flatMap(({ text, quoted }) => {
        try {
            if (opts.useRegex && !quoted) return [new RegExp(text, flags)];
            if (opts.wholeWord && !quoted) return [new RegExp("\\b" + escapeRegex(text) + "\\b", flags)];
            return [new RegExp(escapeRegex(text), flags)];
        } catch {
            // Half-typed regex: the backend matches it literally, so highlight it literally.
            try { return [new RegExp(escapeRegex(text), flags)]; } catch { return []; }
        }
    });
}

/** Merged [start, end) ranges of every match in `text`. */
function matchRanges(text, patterns) {
    const ranges = [];
    for (const re of patterns) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            if (m[0].length) ranges.push([m.index, m.index + m[0].length]);
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
        const last = merged.at(-1);
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
    }
    return merged;
}

/** Escape `text` for HTML and wrap every match in <mark class="ph-highlight">. */
export function highlightHtml(text, patterns) {
    text = String(text ?? "");
    if (!patterns || !patterns.length) return escHtml(text);
    try {
        let out = "", pos = 0;
        for (const [s, e] of matchRanges(text, patterns)) {
            out += escHtml(text.slice(pos, s));
            out += `<mark class="ph-highlight">${escHtml(text.slice(s, e))}</mark>`;
            pos = e;
        }
        return out + escHtml(text.slice(pos));
    } catch {
        return escHtml(text);
    }
}

/**
 * One-line excerpt of a prompt for a list row. Normally the start of the
 * prompt; when the first search match lies beyond what the row can show, the
 * excerpt is moved so the match is visible.
 */
export function rowSnippet(text, patterns, maxChars = 120) {
    const flat = String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (flat.length <= maxChars) return flat;

    let start = 0;
    if (patterns && patterns.length) {
        try {
            const first = matchRanges(flat, patterns)[0];
            // Leave some context before the match once it would fall off the row.
            if (first && first[1] > maxChars - 10) start = Math.max(0, first[0] - 30);
        } catch { /* keep the head */ }
    }
    start = Math.min(start, flat.length - maxChars);
    const end = start + maxChars;
    return (start > 0 ? "…" : "") + flat.slice(start, end).trim() + (end < flat.length ? "…" : "");
}
