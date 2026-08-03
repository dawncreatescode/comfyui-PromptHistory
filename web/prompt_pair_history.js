/**
 * Select Prompt Pair From History — ComfyUI frontend extension
 *
 * History panel for positive+negative prompt pairs.
 * Each stored entry keeps both prompts together so random/sequential
 * always yields a matching pair.
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "SelectPromptPairHistory";
const DEFAULT_PATH = "custom_nodes/comfyui-PromptHistory/history/prompt_pair_history.json";

// ─── Helpers ───────────────────────────────────────────────────────────────

function getWidget(node, name) {
    return (node?.widgets ?? []).find(w => w?.name === name) ?? null;
}

function getHistoryPaths(node) {
    const w = getWidget(node, "history_paths");
    const val = typeof w?.value === "string" ? w.value : "";
    return val.split("\n").map(s => s.trim()).filter(Boolean);
}

function getSavePath(node) {
    const w = getWidget(node, "save_to_path");
    const val = typeof w?.value === "string" ? w.value : "";
    return val.trim() || DEFAULT_PATH;
}

function getActivePaths(node) {
    const w = getWidget(node, "active_paths");
    try {
        const parsed = JSON.parse(w?.value || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function setWidgetValue(node, name, value) {
    const w = getWidget(node, name);
    if (!w) return;
    w.value = (value == null && w.type !== "button") ? "" : value;
    const safe = w.value;
    try { w.callback?.(safe, app.canvas, node, 0, 0); } catch (_) { /* ignore */ }
    try { node.onWidgetChanged?.(w, safe); } catch (_) { /* ignore */ }
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) { /* ignore */ }
}

function pathBasename(path) {
    return path.split(/[/\\]/).pop() || path;
}

function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseQuery(raw) {
    const terms = [];
    for (const m of raw.matchAll(/"([^"]+)"|(\S+)/g)) {
        const text = (m[1] ?? m[2]).trim();
        if (text) terms.push({ text, quoted: !!m[1] });
    }
    return terms;
}

function buildPatterns(terms, opts) {
    return terms.flatMap(({ text, quoted }) => {
        try {
            const flags = opts.caseSensitive ? "g" : "gi";
            if (opts.useRegex && !quoted) {
                return [new RegExp(text, flags)];
            }
            const pat = (opts.wholeWord && !quoted)
                ? new RegExp("\\b" + escapeRegex(text) + "\\b", flags)
                : new RegExp(escapeRegex(text), flags);
            return [pat];
        } catch { return []; }
    });
}

function textMatchesTerm(text, q, quoted, opts) {
    try {
        if (opts.useRegex && !quoted) {
            return new RegExp(q, opts.caseSensitive ? "" : "i").test(text);
        }
        if (opts.wholeWord && !quoted) {
            return new RegExp("\\b" + escapeRegex(q) + "\\b", opts.caseSensitive ? "" : "i").test(text);
        }
        const needle = opts.caseSensitive ? q : q.toLowerCase();
        const hay    = opts.caseSensitive ? text : text.toLowerCase();
        return hay.includes(needle);
    } catch { return false; }
}

// Every term must match at least one of the in-scope fields of the pair.
function pairMatchesAll(item, terms, opts) {
    const fields = [];
    if (opts.searchIn !== "negative") fields.push(item.positive ?? "");
    if (opts.searchIn !== "positive") fields.push(item.negative ?? "");
    return terms.every(({ text: q, quoted }) =>
        fields.some(f => textMatchesTerm(f, q, quoted, opts))
    );
}

function highlightHtml(text, patterns) {
    if (!patterns || !patterns.length) return escHtml(text);
    try {
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
        let out = "", pos = 0;
        for (const [s, e] of merged) {
            out += escHtml(text.slice(pos, s));
            out += `<mark class="pph-highlight">${escHtml(text.slice(s, e))}</mark>`;
            pos = e;
        }
        return out + escHtml(text.slice(pos));
    } catch { return escHtml(text); }
}

// ─── API ───────────────────────────────────────────────────────────────────

async function apiList(paths, query = "", opts = {}) {
    const res = await fetch("/prompt_pair_history/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            history_paths:  paths,
            query,
            case_sensitive: opts.caseSensitive ?? false,
            whole_word:     opts.wholeWord     ?? false,
            use_regex:      opts.useRegex      ?? false,
            search_in:      opts.searchIn      ?? "positive",
            sort_by:        opts.sortBy        ?? "recent",
            max_results:    opts.maxResults    ?? 300,
        }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiSave(path, positive, negative) {
    const res = await fetch("/prompt_pair_history/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_path: path, positive, negative, max_entries: 500_000 }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiDelete(path, key) {
    const res = await fetch("/prompt_pair_history/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_path: path, key }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiClear(path) {
    const res = await fetch("/prompt_pair_history/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_path: path }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiScan() {
    const res = await fetch("/select_prompt_history/scan");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

// ─── CSS ───────────────────────────────────────────────────────────────────

function injectCSS() {
    const ID = "pph-styles-v1";
    if (document.getElementById(ID)) return;
    const style = document.createElement("style");
    style.id = ID;
    style.textContent = `
/* ── Shared layout (mirrors sph-* but with pph- prefix) ── */
.pph-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
}
.pph-card {
    width: min(720px, calc(100vw - 24px));
    height: clamp(360px, 72vh, 800px);
    background: var(--comfy-menu-bg, #1e1e1e);
    color: var(--comfy-text, #ddd);
    border: 1px solid var(--border-color, #444);
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.55);
    display: flex; flex-direction: column;
    overflow: hidden;
    font-family: system-ui, sans-serif; font-size: 13px;
    user-select: none;
}
.pph-header {
    padding: 12px 14px 0;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
}
.pph-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.pph-title  { font-size: 14px; font-weight: 600; flex: 1; }
.pph-total  { font-size: 11px; opacity: 0.45; }
.pph-close, .pph-expand {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 6px;
    opacity: 0.55; transition: opacity 0.15s;
}
.pph-close  { font-size: 18px; }
.pph-close:hover, .pph-expand:hover { opacity: 1; background: rgba(255,255,255,0.08); }
.pph-card.pph-expanded {
    width: min(1020px, calc(100vw - 24px));
    height: 93vh;
}

/* ── Sources ── */
.pph-sources-row {
    display: flex; flex-wrap: wrap; gap: 5px;
    margin-bottom: 8px; align-items: center;
}
.pph-sources-label { font-size: 11px; opacity: 0.45; flex-shrink: 0; margin-right: 2px; }
.pph-chip {
    padding: 2px 10px; font-size: 11px; cursor: pointer; border-radius: 12px;
    border: 1px solid var(--border-color, #555);
    background: var(--comfy-input-bg, #2b2b2b);
    color: var(--comfy-text, #999);
    transition: all 0.12s; white-space: nowrap;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis;
}
.pph-chip.active { background: #1e4a7a; border-color: #4a7aaa; color: #cde; }
.pph-chip:hover  { filter: brightness(1.2); }

/* ── Save-to ── */
.pph-saveto-row { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.pph-saveto-label { font-size: 11px; opacity: 0.45; flex-shrink: 0; }
.pph-saveto {
    flex: 1; padding: 3px 8px; font-size: 11px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 6px; cursor: pointer; outline: none;
    max-width: 320px;
}

/* ── Search ── */
.pph-search-row { display: flex; gap: 6px; margin-bottom: 8px; }
.pph-search {
    flex: 1; padding: 7px 10px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 8px; outline: none; font-size: 13px;
    transition: border-color 0.15s;
}
.pph-search:focus { border-color: #6a8aaa; }

/* ── Option toggles + scope + sort ── */
.pph-opts-row {
    display: flex; gap: 4px; margin-bottom: 10px;
    flex-wrap: wrap; align-items: center;
}
.pph-toggle {
    padding: 3px 10px; font-size: 11px; cursor: pointer;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #bbb);
    border-radius: 6px; white-space: nowrap;
    transition: background 0.12s, border-color 0.12s;
}
.pph-toggle:hover  { filter: brightness(1.18); }
.pph-toggle.active { background: #1e4a7a; border-color: #4a7aaa; color: #cde; }
.pph-scope, .pph-sort {
    padding: 3px 8px; font-size: 11px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 6px; cursor: pointer; outline: none;
}
.pph-sort { margin-left: auto; }

/* ── Content area ── */
.pph-content { display: flex; flex: 1; min-height: 0; overflow: hidden; }

/* ── List body ── */
.pph-body {
    flex: 1; overflow-y: auto; min-width: 0; min-height: 80px;
    border-right: 1px solid var(--border-color, #3a3a3a);
    scrollbar-width: thin; scrollbar-color: #444 transparent;
}
.pph-body::-webkit-scrollbar       { width: 6px; }
.pph-body::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

/* ── Preview panel ── */
.pph-preview {
    width: 280px; flex-shrink: 0;
    padding: 12px 14px;
    overflow-y: auto;
    font-size: 12px; line-height: 1.65;
    white-space: pre-wrap; word-break: break-word;
    scrollbar-width: thin; scrollbar-color: #444 transparent;
}
.pph-preview::-webkit-scrollbar       { width: 6px; }
.pph-preview::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
.pph-preview:empty::before {
    content: "Hover a pair to preview"; opacity: 0.25; font-style: italic;
}
.pph-card.pph-expanded .pph-preview { width: 400px; }
.pph-preview-label {
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; opacity: 0.5; margin-bottom: 4px;
}
.pph-preview-pos { color: #8ecf9c; margin-bottom: 14px; }
.pph-preview-neg { color: #cf9898; }
.pph-preview-text { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; }

/* ── Row ── */
.pph-row {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 14px; cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.035);
    transition: background 0.1s;
}
.pph-row:hover, .pph-row.active { background: rgba(255,255,255,0.07); }
.pph-row.active { background: rgba(40,80,140,0.28); }
.pph-row-main { flex: 1; min-width: 0; }
.pph-row-pos {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-size: 13px; line-height: 1.4; color: #8ecf9c;
}
.pph-row-neg {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-size: 12px; line-height: 1.4; color: #cf9898; opacity: 0.85;
    margin-top: 2px;
}
.pph-row-neg-empty { opacity: 0.25; font-style: italic; color: var(--comfy-text, #ddd); }
.pph-row-meta { font-size: 10px; opacity: 0.4; margin-top: 3px; }
.pph-row-sigil {
    font-size: 11px; font-weight: 700; flex-shrink: 0;
    margin-top: 2px; opacity: 0.55; width: 12px; text-align: center;
}

/* ── Source badge ── */
.pph-badge {
    font-size: 10px; padding: 1px 7px; border-radius: 10px; flex-shrink: 0; align-self: center;
    background: rgba(255,255,255,0.07); color: rgba(221,221,221,0.45);
    max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── Delete button ── */
.pph-del {
    background: none; border: none; color: #c87;
    cursor: pointer; font-size: 14px; padding: 3px 6px;
    border-radius: 4px; opacity: 0; flex-shrink: 0; align-self: center;
    transition: opacity 0.15s;
}
.pph-row:hover .pph-del { opacity: 0.65; }
.pph-del:hover { opacity: 1 !important; background: rgba(200,80,80,0.18); }

/* ── Queue checkbox ── */
.pph-row-check {
    width: 18px; height: 18px; flex-shrink: 0; align-self: center;
    accent-color: #4a7aaa; cursor: pointer; margin-right: 2px;
}

/* ── Empty / error ── */
.pph-empty {
    padding: 32px 16px; text-align: center;
    opacity: 0.45; font-size: 13px; line-height: 1.6;
}
.pph-error { padding: 14px; color: #f88; font-size: 12px; }

/* ── Footer ── */
.pph-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
}
.pph-btn {
    padding: 6px 14px; font-size: 12px; cursor: pointer;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 8px; transition: filter 0.12s;
}
.pph-btn:hover  { filter: brightness(1.18); }
.pph-btn.danger { border-color: #733; color: #f99; }
.pph-btn.danger:hover { background: rgba(160,40,40,0.22); }
.pph-spacer { flex: 1; }

/* ── Manage-files modal ── */
.pph-mgr-section {
    padding: 10px 14px 8px;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
}
.pph-mgr-section:last-child { border-bottom: none; }
.pph-mgr-label { font-size: 11px; opacity: 0.45; margin-bottom: 6px; }
.pph-mgr-row   { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.pph-mgr-name  { font-size: 13px; font-weight: 500; flex-shrink: 0; }
.pph-mgr-path  {
    font-size: 10px; opacity: 0.4; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pph-mgr-del {
    background: none; border: none; color: #c87;
    cursor: pointer; font-size: 14px; padding: 2px 6px;
    border-radius: 4px; opacity: 0.65; flex-shrink: 0;
    transition: opacity 0.15s;
}
.pph-mgr-del:hover { opacity: 1; background: rgba(200,80,80,0.18); }
.pph-mgr-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pph-mgr-add-row { display: flex; gap: 6px; }

/* ── Highlight ── */
mark.pph-highlight {
    background: rgba(255,200,50,0.32);
    color: inherit; border-radius: 2px; padding: 0 1px;
}
    `;
    document.head.appendChild(style);
}

// ─── File manager ──────────────────────────────────────────────────────────

function openManagePanel(node) {
    injectCSS();

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function btn(cls, text, onClick) {
        const b = document.createElement("button");
        b.className = cls; b.textContent = text; b.onclick = onClick;
        return b;
    }

    function readPaths() {
        const w = getWidget(node, "history_paths");
        return (typeof w?.value === "string" ? w.value : "")
            .split("\n").map(s => s.trim()).filter(Boolean);
    }

    function writePaths(paths) {
        const deduped = [...new Set(paths)];
        setWidgetValue(node, "history_paths", deduped.join("\n"));
        const saveW = getWidget(node, "save_to_path");
        if (saveW && deduped.length && !deduped.includes(saveW.value)) {
            setWidgetValue(node, "save_to_path", deduped[0]);
        }
        return deduped;
    }

    const overlay = el("div", "pph-overlay");
    const card    = el("div", "pph-card");
    card.style.cssText = "width: min(500px, calc(100vw - 24px)); display: block; height: auto;";

    const header   = el("div", "pph-header");
    const titleRow = el("div", "pph-title-row");
    const closeBtn = btn("pph-close", "×", close);
    closeBtn.title = "Close";
    titleRow.append(el("span", "pph-title", "Pair History Files"), el("span", "pph-spacer"), closeBtn);
    header.appendChild(titleRow);

    const body = document.createElement("div");
    body.style.cssText = "overflow-y: auto; max-height: min(55vh, 340px);";

    const scanSection = el("div", "pph-mgr-section");
    scanSection.style.display = "none";
    body.appendChild(scanSection);

    const listSection = el("div", "pph-mgr-section");
    body.appendChild(listSection);

    const addSection = el("div", "pph-mgr-section");
    const addLabel   = el("div", "pph-mgr-label", "Add by path:");
    const addRow     = el("div", "pph-mgr-add-row");
    const addInput   = el("input", "pph-search");
    addInput.type        = "text";
    addInput.placeholder = "custom_nodes/comfyui-PromptHistory/history/my_pairs.json";
    addInput.style.cssText = "flex: 1; font-size: 12px; padding: 5px 8px;";
    const addBtn = btn("pph-btn", "Add", () => {
        const p = addInput.value.trim();
        if (!p) return;
        writePaths([...readPaths(), p]);
        addInput.value = "";
        renderList();
        loadScan();
    });
    addInput.addEventListener("keydown", e => { if (e.key === "Enter") addBtn.click(); });
    addRow.append(addInput, addBtn);
    addSection.append(addLabel, addRow);
    body.appendChild(addSection);

    const footer = el("div", "pph-footer");
    footer.append(el("span", "pph-spacer"), btn("pph-btn", "Done", close));

    card.append(header, body, footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    document.addEventListener("keydown", onKeyDown);
    function onKeyDown(e) {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
    }
    function close() {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    }

    function renderList() {
        const paths = readPaths();
        listSection.innerHTML = "";
        listSection.appendChild(el("div", "pph-mgr-label", paths.length ? "Current files:" : "No files configured yet."));
        paths.forEach(path => {
            const row  = el("div", "pph-mgr-row");
            const name = el("span", "pph-mgr-name", pathBasename(path));
            name.title = path;
            const full = el("span", "pph-mgr-path", path);
            const del  = btn("pph-mgr-del", "×", () => {
                writePaths(readPaths().filter(p => p !== path));
                renderList();
                loadScan();
            });
            del.title = "Remove";
            row.append(name, full, del);
            listSection.appendChild(row);
        });
    }

    async function loadScan() {
        try {
            const data     = await apiScan();
            const current  = readPaths();
            const notAdded = (data.files ?? []).filter(f => !current.includes(f));
            scanSection.style.display = notAdded.length ? "" : "none";
            scanSection.innerHTML = "";
            if (!notAdded.length) return;
            scanSection.appendChild(el("div", "pph-mgr-label", "Found in node folder — click to add:"));
            const chips = el("div", "pph-mgr-chips");
            notAdded.forEach(f => {
                const chip = btn("pph-chip", "+ " + pathBasename(f), () => {
                    writePaths([...readPaths(), f]);
                    renderList();
                    loadScan();
                });
                chip.title = f;
                chips.appendChild(chip);
            });
            scanSection.appendChild(chips);
        } catch { /* non-fatal */ }
    }

    renderList();
    loadScan();
}

// ─── Panel ─────────────────────────────────────────────────────────────────

function openPanel(node) {
    injectCSS();

    const allPaths = getHistoryPaths(node);
    if (!allPaths.length) {
        openManagePanel(node);
        return;
    }

    const savedActive = getActivePaths(node);
    let activePaths = savedActive.length > 0 ? new Set(savedActive) : null;
    let savePath    = getSavePath(node);
    let items       = [];
    let selectedIdx = -1;
    let searchTimer = null;
    let currentPatterns = [];

    const opts = {
        caseSensitive: false,
        wholeWord:     false,
        useRegex:      false,
        searchIn:      "positive",
        sortBy:        "recent",
    };

    if (!node.__pph_queue) node.__pph_queue = { selected: new Set(), items: new Map() };
    const queueSelected = node.__pph_queue.selected;
    const queueItems    = node.__pph_queue.items;

    function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
    }
    function btn(className, text, onClick) {
        const b = document.createElement("button");
        b.className = className; b.textContent = text; b.onclick = onClick;
        return b;
    }

    // ── DOM ──
    const overlay = el("div", "pph-overlay");
    const card    = el("div", "pph-card");

    const header   = el("div", "pph-header");
    const titleRow = el("div", "pph-title-row");
    const titleEl  = el("span", "pph-title", "Select Prompt Pair From History");
    const totalEl  = el("span", "pph-total");

    const expandBtn = btn("pph-expand", "⤢", () => {
        const expanded = card.classList.toggle("pph-expanded");
        node.__pph_expanded = expanded;
        expandBtn.textContent = expanded ? "⤡" : "⤢";
        expandBtn.title = expanded ? "Restore size" : "Expand";
    });
    expandBtn.title = "Expand";
    if (node.__pph_expanded) {
        card.classList.add("pph-expanded");
        expandBtn.textContent = "⤡";
        expandBtn.title = "Restore size";
    }

    const closeBtn = btn("pph-close", "×", close);
    closeBtn.title = "Close  (Esc)";
    titleRow.append(titleEl, totalEl, expandBtn, closeBtn);

    // Sources
    const sourcesRow   = el("div", "pph-sources-row");
    const sourcesLabel = el("span", "pph-sources-label", "Sources:");
    sourcesRow.appendChild(sourcesLabel);

    function isActive(path) { return activePaths === null || activePaths.has(path); }

    function persistActivePaths() {
        const toSave = activePaths === null ? [] : [...activePaths];
        setWidgetValue(node, "active_paths", JSON.stringify(toSave));
    }

    function togglePath(path) {
        if (activePaths === null) {
            activePaths = new Set(allPaths.filter(p => p !== path));
        } else if (activePaths.has(path)) {
            activePaths.delete(path);
            if (activePaths.size === 0) activePaths.add(path);
        } else {
            activePaths.add(path);
            if (allPaths.every(p => activePaths.has(p))) activePaths = null;
        }
        persistActivePaths();
        updateChips();
        doSearch();
    }

    const chipEls = new Map();
    allPaths.forEach(path => {
        const chip = el("button", "pph-chip" + (isActive(path) ? " active" : ""));
        chip.textContent = pathBasename(path);
        chip.title = path;
        chip.onclick = () => togglePath(path);
        chipEls.set(path, chip);
        sourcesRow.appendChild(chip);
    });

    function updateChips() {
        allPaths.forEach(path => {
            chipEls.get(path)?.classList.toggle("active", isActive(path));
        });
    }

    // Save-to
    const savetoRow   = el("div", "pph-saveto-row");
    const savetoLabel = el("span", "pph-saveto-label", "Save to:");
    const savetoSel   = el("select", "pph-saveto");
    allPaths.forEach(path => {
        const opt = document.createElement("option");
        opt.value = path; opt.textContent = pathBasename(path); opt.title = path;
        if (path === savePath) opt.selected = true;
        savetoSel.appendChild(opt);
    });
    savetoSel.onchange = () => {
        savePath = savetoSel.value;
        setWidgetValue(node, "save_to_path", savePath);
    };
    savetoRow.append(savetoLabel, savetoSel);

    // Search
    const searchRow = el("div", "pph-search-row");
    const searchEl  = el("input", "pph-search");
    searchEl.type = "text";
    searchEl.autocomplete = "off";
    searchEl.spellcheck = false;
    searchRow.appendChild(searchEl);

    function syncSearchPlaceholder() {
        searchEl.placeholder = {
            positive: "Search positive prompts…",
            negative: "Search negative prompts…",
            both:     "Search positive or negative…",
        }[opts.searchIn];
    }
    syncSearchPlaceholder();

    // Option toggles + scope + sort
    const optsRow = el("div", "pph-opts-row");
    function makeToggle(label, title, key) {
        const b = document.createElement("button");
        b.className = "pph-toggle"; b.textContent = label; b.title = title;
        b.onclick = () => { opts[key] = !opts[key]; b.classList.toggle("active", opts[key]); doSearch(); };
        return b;
    }
    const caseTgl = makeToggle("Aa",      "Case Sensitive", "caseSensitive");
    const wordTgl = makeToggle("\\bW\\b", "Whole Word",     "wholeWord");
    const rxTgl   = makeToggle(".*",      "Regex",          "useRegex");

    const scopeSel = el("select", "pph-scope");
    scopeSel.title = "Which prompt of the pair to search";
    [["positive", "Positive"], ["negative", "Negative"], ["both", "Both"]].forEach(([v, lbl]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = lbl;
        scopeSel.appendChild(o);
    });
    scopeSel.onchange = () => {
        opts.searchIn = scopeSel.value;
        syncSearchPlaceholder();
        doSearch();
    };

    const sortSel = el("select", "pph-sort");
    [["recent", "↓ Recent"], ["alpha", "A–Z"], ["hits", "↑ Most Used"]].forEach(([v, lbl]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = lbl;
        sortSel.appendChild(o);
    });
    sortSel.onchange = () => { opts.sortBy = sortSel.value; doSearch(); };
    optsRow.append(caseTgl, wordTgl, rxTgl, scopeSel, sortSel);

    header.append(titleRow, sourcesRow, savetoRow, searchRow, optsRow);

    // Preview
    const previewBox = el("div", "pph-preview");

    // Body
    const body = el("div", "pph-body");

    // Footer
    const footer    = el("div", "pph-footer");
    const clearBtn  = btn("pph-btn danger", "Clear Active Sources", onClearAll);
    const footSpc   = el("span", "pph-spacer");
    const queueBtn  = btn("pph-btn", "Queue 0", doQueue);
    queueBtn.title  = "Queue selected pairs for execution in order";
    queueBtn.style.display = "none";
    const cancelBtn = btn("pph-btn", "Cancel", close);
    footer.append(clearBtn, footSpc, queueBtn, cancelBtn);

    const contentArea = el("div", "pph-content");
    contentArea.append(body, previewBox);
    card.append(header, contentArea, footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // ── Close ──
    function close() {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    }

    // Highlight only the fields the search scope actually covers
    function posPatterns() { return opts.searchIn !== "negative" ? currentPatterns : []; }
    function negPatterns() { return opts.searchIn !== "positive" ? currentPatterns : []; }

    // ── Preview ──
    function showPreview(item) {
        if (!item) { previewBox.innerHTML = ""; return; }
        const posHtml = highlightHtml(item.positive || "", posPatterns());
        const negHtml = highlightHtml(item.negative || "", negPatterns());
        previewBox.innerHTML =
            `<div class="pph-preview-pos"><div class="pph-preview-label">Positive</div><div class="pph-preview-text">${posHtml}</div></div>` +
            `<div class="pph-preview-neg"><div class="pph-preview-label">Negative</div><div class="pph-preview-text">${negHtml || '<em style="opacity:0.35">empty</em>'}</div></div>`;
    }

    // ── Render ──
    function setActive(idx) {
        selectedIdx = idx;
        card.querySelectorAll(".pph-row").forEach((r, i) => {
            r.classList.toggle("active", i === idx);
            if (i === idx) r.scrollIntoView({ block: "nearest" });
        });
        showPreview(idx >= 0 ? items[idx] : null);
    }

    function renderList() {
        body.innerHTML = "";
        if (!items.length) {
            const empty = el("div", "pph-empty");
            const q = searchEl.value.trim();
            empty.innerHTML = q
                ? `No pairs matching <strong>${escHtml(q)}</strong>`
                : "No history in the active sources yet.";
            body.appendChild(empty);
            totalEl.textContent = "";
            selectedIdx = -1;
            previewBox.innerHTML = "";
            return;
        }

        totalEl.textContent = `${items.length} pair${items.length !== 1 ? "s" : ""}`;

        items.forEach((item, idx) => {
            const row = el("div", "pph-row");
            if (idx === selectedIdx) row.classList.add("active");

            const check = document.createElement("input");
            check.type = "checkbox";
            check.className = "pph-row-check";
            check.checked = queueSelected.has(item.key);
            check.title = "Add to queue";
            check.onclick = e => {
                e.stopPropagation();
                if (check.checked) { queueSelected.add(item.key); queueItems.set(item.key, item); }
                else               { queueSelected.delete(item.key); queueItems.delete(item.key); }
                updateQueueBtn();
            };

            const main = el("div", "pph-row-main");

            const posLine = el("div", "pph-row-pos");
            posLine.innerHTML = highlightHtml(item.positive_preview || item.positive?.slice(0, 100) || "", posPatterns());

            const negCls = item.negative ? "pph-row-neg" : "pph-row-neg pph-row-neg-empty";
            const negLine = el("div", negCls);
            negLine.innerHTML = item.negative
                ? highlightHtml(item.negative_preview || item.negative?.slice(0, 100) || "", negPatterns())
                : "no negative";

            const meta  = el("div", "pph-row-meta");
            const parts = [];
            if (item.ts)       parts.push(item.ts);
            if (item.hits > 1) parts.push(`used ${item.hits}×`);
            meta.textContent = parts.join(" · ");

            main.append(posLine, negLine, meta);

            const badge = el("span", "pph-badge", pathBasename(item.source || ""));
            badge.title = item.source || "";

            const delBtn = el("button", "pph-del");
            delBtn.textContent = "×";
            delBtn.title = "Remove from history";
            delBtn.onclick = async e => {
                e.stopPropagation();
                try {
                    await apiDelete(item.source, item.key);
                    doSearch();
                } catch (err) {
                    console.error("[SelectPromptPairHistory] delete:", err);
                }
            };

            row.append(check, main, badge, delBtn);
            row.addEventListener("mouseenter", () => setActive(idx));
            row.addEventListener("click",      () => selectItem(item));
            body.appendChild(row);
        });
    }

    async function selectItem(item) {
        if (!item) return;
        try {
            await apiSave(savePath, item.positive, item.negative);
        } catch (err) {
            console.error("[SelectPromptPairHistory] immediate save failed:", err);
        }
        setWidgetValue(node, "positive", item.positive ?? "");
        setWidgetValue(node, "negative", item.negative ?? "");
        close();
    }

    // ── Queue ──
    function updateQueueBtn() {
        const n = queueSelected.size;
        queueBtn.style.display = n > 0 ? "" : "none";
        queueBtn.textContent = `Queue ${n}`;
    }

    async function doQueue() {
        const toQueue = [...queueSelected].map(k => queueItems.get(k)).filter(Boolean);
        if (!toQueue.length) return;

        if (typeof app.queuePrompt !== "function") {
            alert("app.queuePrompt is not available in this ComfyUI version.");
            return;
        }

        const modeW        = getWidget(node, "mode");
        const originalMode = modeW?.value;
        const originalPos  = getWidget(node, "positive")?.value ?? "";
        const originalNeg  = getWidget(node, "negative")?.value ?? "";

        if (originalMode !== "edit") setWidgetValue(node, "mode", "edit");

        for (const item of toQueue) {
            setWidgetValue(node, "positive", item.positive ?? "");
            setWidgetValue(node, "negative", item.negative ?? "");
            try { await app.queuePrompt(0, 1); }
            catch (e) { console.error("[SelectPromptPairHistory] queuePrompt failed:", e); }
        }

        setWidgetValue(node, "positive", originalPos);
        setWidgetValue(node, "negative", originalNeg);
        if (originalMode !== "edit") setWidgetValue(node, "mode", originalMode);

        queueSelected.clear();
        queueItems.clear();
        node.__pph_queue = { selected: new Set(), items: new Map() };
        close();
    }

    // ── Search ──
    function getEffectivePaths() {
        return activePaths === null ? allPaths : allPaths.filter(p => activePaths.has(p));
    }

    function doSearch() {
        const paths = getEffectivePaths();
        if (!paths.length) {
            body.innerHTML = `<div class="pph-empty">No sources selected.</div>`;
            totalEl.textContent = "";
            return;
        }
        const raw       = searchEl.value;
        const terms     = parseQuery(raw);
        currentPatterns = buildPatterns(terms, opts);
        // Multi-term queries are filtered client-side (the backend matches the
        // raw string as one query); fetch a larger window so filtering has data.
        const multiTerm    = terms.length > 1;
        const backendQuery = multiTerm ? "" : raw.trim();
        const backendOpts  = multiTerm ? { ...opts, maxResults: 5000 } : opts;
        apiList(paths, backendQuery, backendOpts)
            .then(data => {
                let results = data.items ?? [];
                if (multiTerm) results = results.filter(it => pairMatchesAll(it, terms, opts));
                items = results;
                if (selectedIdx >= items.length) selectedIdx = -1;
                renderList();
            })
            .catch(err => {
                body.innerHTML = `<div class="pph-error">Error: ${escHtml(String(err.message ?? err))}</div>`;
            });
    }

    // ── Clear ──
    async function onClearAll() {
        const paths = getEffectivePaths();
        const names = paths.map(pathBasename).join(", ");
        if (!confirm(`Clear ALL pairs from:\n${names}\n\nThis cannot be undone.`)) return;
        try {
            for (const path of paths) await apiClear(path);
            doSearch();
        } catch (err) {
            console.error("[SelectPromptPairHistory] clear:", err);
        }
    }

    // ── Keyboard ──
    function onKeyDown(e) {
        if (e.key === "Escape") { e.stopPropagation(); close(); return; }
        const inSearch = document.activeElement === searchEl;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(selectedIdx + 1, items.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(selectedIdx - 1, 0));
        } else if (e.key === "Enter" && !inSearch) {
            e.preventDefault();
            if (selectedIdx >= 0 && items[selectedIdx]) selectItem(items[selectedIdx]);
        } else if (e.key === "Enter" && inSearch) {
            if (items.length > 0) { setActive(0); selectItem(items[0]); }
        }
    }
    document.addEventListener("keydown", onKeyDown);

    searchEl.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(doSearch, 200);
    });
    searchEl.addEventListener("keydown", e => {
        if (["ArrowUp", "ArrowDown"].includes(e.key)) e.stopPropagation();
    });

    doSearch();
    requestAnimationFrame(() => searchEl.focus());
}

// ─── Node attachment ───────────────────────────────────────────────────────

function attachToNode(node) {
    if (node.__pph_attached || node.type !== NODE_TYPE) return;
    node.__pph_attached = true;

    const modeWidget     = getWidget(node, "mode");
    const positiveWidget = getWidget(node, "positive");
    const negativeWidget = getWidget(node, "negative");
    const pathsWidget    = getWidget(node, "history_paths");
    const saveToWidget   = getWidget(node, "save_to_path");
    const activeWidget   = getWidget(node, "active_paths");
    const maxWidget      = getWidget(node, "max_entries");

    for (const w of [pathsWidget, saveToWidget, activeWidget, maxWidget]) {
        if (!w) continue;
        w.computeSize = () => [0, -4];
        w.draw        = () => {};
    }

    function syncTextState() {
        const mode   = modeWidget?.value;
        const isAuto = mode === "random" || mode === "sequential";
        for (const w of [positiveWidget, negativeWidget]) {
            if (!w) continue;
            w.disabled = isAuto;
        }
        if (positiveWidget?.label !== undefined) {
            positiveWidget.label = isAuto ? `positive (ignored in ${mode} mode)` : "positive";
        }
        if (negativeWidget?.label !== undefined) {
            negativeWidget.label = isAuto ? `negative (ignored in ${mode} mode)` : "negative";
        }
    }
    if (modeWidget) {
        const origCb = modeWidget.callback;
        modeWidget.callback = function (value, ...rest) {
            syncTextState();
            return origCb?.apply(this, [value, ...rest]);
        };
    }
    syncTextState();
    node.__pph_syncTextState = syncTextState;

    const panelBtn = node.addWidget(
        "button", "Select Pairs…", "",
        () => openPanel(node),
        { serialize: false },
    );
    panelBtn.serialize = false;

    const manageBtn = node.addWidget(
        "button", "Manage Files…", "",
        () => openManagePanel(node),
        { serialize: false },
    );
    manageBtn.serialize = false;

    // Insert panel button between mode and positive
    if (positiveWidget) {
        const posIdx   = node.widgets.indexOf(positiveWidget);
        const panelIdx = node.widgets.indexOf(panelBtn);
        if (posIdx >= 0 && panelIdx > posIdx) {
            node.widgets.splice(panelIdx, 1);
            node.widgets.splice(posIdx, 0, panelBtn);
        }
    }

    node.__pph_is_configure = false;
    setTimeout(() => {
        if (node.__pph_is_configure) return;
        try { node.setSize(node.computeSize()); } catch (_) { /* ignore */ }
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) { /* ignore */ }
    }, 0);
}

// ─── Extension registration ────────────────────────────────────────────────

app.registerExtension({
    name: "prompt_pair_history.v1",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            attachToNode(this);
            return result;
        };

        const origSerialize = nodeType.prototype.serialize;
        nodeType.prototype.serialize = function () {
            const data = origSerialize?.apply(this, arguments) ?? {};
            if (Array.isArray(data.widgets_values) && this.widgets) {
                const compact = [];
                for (let i = 0; i < this.widgets.length; i++) {
                    if (this.widgets[i]?.serialize !== false) {
                        compact.push(data.widgets_values[i] ?? null);
                    }
                }
                data.widgets_values = compact;
            }
            return data;
        };

        // Must match Python INPUT_TYPES order exactly
        const SERIALIZED_WIDGET_ORDER = [
            "mode", "positive", "negative", "auto_save",
            "history_paths", "save_to_path", "active_paths", "max_entries",
        ];

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info, ...rest) {
            this.__pph_is_configure = true;

            const snapshot = {};
            if (Array.isArray(info?.widgets_values)) {
                SERIALIZED_WIDGET_ORDER.forEach((name, i) => {
                    if (info.widgets_values[i] !== undefined) snapshot[name] = info.widgets_values[i];
                });
            }

            const result = onConfigure?.apply(this, [info, ...rest]);

            for (const [name, val] of Object.entries(snapshot)) {
                const w = getWidget(this, name);
                if (w) w.value = val;
            }
            for (const w of this.widgets ?? []) {
                if (w?.value == null && w?.type !== "button") w.value = "";
            }
            this.__pph_syncTextState?.();
            return result;
        };
    },
});
