/**
 * Select Prompt From History — ComfyUI frontend extension
 *
 * History panel supporting multiple JSON files:
 *  - Source chips to toggle which files are active (random/sequential modes)
 *  - "Save to" selector to pick which file receives new prompts
 *  - Immediate save when selecting a prompt (no generation run needed)
 *  - Per-row source badge, full-text search, sort, keyboard navigation
 */

import { app } from "../../scripts/app.js";

const NODE_TYPE = "SelectPromptHistory";

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
    return val.trim() || "custom_nodes/comfyui-PromptHistory/history/prompt_history.json";
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

function itemMatchesAll(text, terms, opts) {
    return terms.every(({ text: q, quoted }) => {
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
    });
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
            out += `<mark class="sph-highlight">${escHtml(text.slice(s, e))}</mark>`;
            pos = e;
        }
        return out + escHtml(text.slice(pos));
    } catch { return escHtml(text); }
}

// ─── API ───────────────────────────────────────────────────────────────────

async function apiListMulti(paths, query = "", opts = {}) {
    const res = await fetch("/select_prompt_history/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            history_paths:  paths,
            query,
            case_sensitive: opts.caseSensitive ?? false,
            whole_word:     opts.wholeWord     ?? false,
            use_regex:      opts.useRegex      ?? false,
            sort_by:        opts.sortBy        ?? "recent",
            max_results:    opts.maxResults ?? 300,
        }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiSaveImmediate(path, text) {
    const res = await fetch("/prompt_history/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_path: path, text, max_entries: 500_000 }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiDelete(path, key) {
    const res = await fetch("/prompt_history/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_path: path, key }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

async function apiClear(path) {
    const res = await fetch("/prompt_history/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_path: path }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

// ─── CSS ───────────────────────────────────────────────────────────────────

function injectCSS() {
    const ID = "sph-styles-v1";
    if (document.getElementById(ID)) return;
    const style = document.createElement("style");
    style.id = ID;
    style.textContent = `
.sph-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
}
.sph-card {
    width: min(680px, calc(100vw - 24px));
    height: clamp(320px, 70vh, 760px);
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
.sph-header {
    padding: 12px 14px 0;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
}
.sph-title-row {
    display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
}
.sph-title  { font-size: 14px; font-weight: 600; flex: 1; }
.sph-total  { font-size: 11px; opacity: 0.45; }
.sph-close, .sph-expand {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 6px;
    opacity: 0.55; transition: opacity 0.15s;
}
.sph-close  { font-size: 18px; }
.sph-close:hover, .sph-expand:hover { opacity: 1; background: rgba(255,255,255,0.08); }
.sph-card.sph-expanded {
    width: min(960px, calc(100vw - 24px));
    height: 93vh;
}

/* ── Sources ── */
.sph-sources-row {
    display: flex; flex-wrap: wrap; gap: 5px;
    margin-bottom: 8px; align-items: center;
}
.sph-sources-label { font-size: 11px; opacity: 0.45; flex-shrink: 0; margin-right: 2px; }
.sph-chip {
    padding: 2px 10px; font-size: 11px; cursor: pointer; border-radius: 12px;
    border: 1px solid var(--border-color, #555);
    background: var(--comfy-input-bg, #2b2b2b);
    color: var(--comfy-text, #999);
    transition: all 0.12s; white-space: nowrap;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis;
}
.sph-chip.active { background: #1e4a7a; border-color: #4a7aaa; color: #cde; }
.sph-chip:hover  { filter: brightness(1.2); }

/* ── Save-to ── */
.sph-saveto-row {
    display: flex; align-items: center; gap: 6px; margin-bottom: 10px;
}
.sph-saveto-label { font-size: 11px; opacity: 0.45; flex-shrink: 0; }
.sph-saveto {
    flex: 1; padding: 3px 8px; font-size: 11px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 6px; cursor: pointer; outline: none;
    max-width: 320px;
}

/* ── Search ── */
.sph-search-row { display: flex; gap: 6px; margin-bottom: 8px; }
.sph-search {
    flex: 1; padding: 7px 10px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 8px; outline: none; font-size: 13px;
    transition: border-color 0.15s;
}
.sph-search:focus { border-color: #6a8aaa; }

/* ── Option toggles + sort ── */
.sph-opts-row {
    display: flex; gap: 4px; margin-bottom: 10px;
    flex-wrap: wrap; align-items: center;
}
.sph-toggle {
    padding: 3px 10px; font-size: 11px; cursor: pointer;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #bbb);
    border-radius: 6px; white-space: nowrap;
    transition: background 0.12s, border-color 0.12s;
}
.sph-toggle:hover  { filter: brightness(1.18); }
.sph-toggle.active { background: #1e4a7a; border-color: #4a7aaa; color: #cde; }
.sph-sort {
    margin-left: auto; padding: 3px 8px; font-size: 11px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 6px; cursor: pointer; outline: none;
}

/* ── Content area: list on left, preview panel on right ── */
.sph-content {
    display: flex; flex: 1; min-height: 0; overflow: hidden;
}

/* ── List body ── */
.sph-body {
    flex: 1; overflow-y: auto; min-width: 0; min-height: 80px;
    border-right: 1px solid var(--border-color, #3a3a3a);
    scrollbar-width: thin; scrollbar-color: #444 transparent;
}
.sph-body::-webkit-scrollbar       { width: 6px; }
.sph-body::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

/* ── Preview side panel ── */
.sph-preview {
    width: 255px; flex-shrink: 0;
    padding: 12px 14px;
    overflow-y: auto;
    font-size: 12px; line-height: 1.65;
    white-space: pre-wrap; word-break: break-word;
    color: rgba(221,221,221,0.82);
    scrollbar-width: thin;
    scrollbar-color: #444 transparent;
}
.sph-preview::-webkit-scrollbar { width: 6px; }
.sph-preview::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
.sph-preview:empty::before {
    content: "Hover a prompt to preview";
    opacity: 0.25; font-style: italic;
}
.sph-card.sph-expanded .sph-preview { width: 380px; }

/* ── Row ── */
.sph-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 14px; cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.035);
    transition: background 0.1s;
}
.sph-row:hover, .sph-row.active { background: rgba(255,255,255,0.07); }
.sph-row.active { background: rgba(40,80,140,0.28); }
.sph-row-main    { flex: 1; min-width: 0; }
.sph-row-preview {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-size: 13px; line-height: 1.4;
}
.sph-row-meta { font-size: 10px; opacity: 0.4; margin-top: 2px; }

/* ── Source badge ── */
.sph-badge {
    font-size: 10px; padding: 1px 7px; border-radius: 10px; flex-shrink: 0;
    background: rgba(255,255,255,0.07);
    color: rgba(221,221,221,0.45);
    max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── Delete button ── */
.sph-del {
    background: none; border: none; color: #c87;
    cursor: pointer; font-size: 14px; padding: 3px 6px;
    border-radius: 4px; opacity: 0; flex-shrink: 0; transition: opacity 0.15s;
}
.sph-row:hover .sph-del { opacity: 0.65; }
.sph-del:hover { opacity: 1 !important; background: rgba(200,80,80,0.18); }

/* ── Empty state ── */
.sph-empty {
    padding: 32px 16px; text-align: center;
    opacity: 0.45; font-size: 13px; line-height: 1.6;
}

/* ── Footer ── */
.sph-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
}
.sph-btn {
    padding: 6px 14px; font-size: 12px; cursor: pointer;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 8px; transition: filter 0.12s;
}
.sph-btn:hover  { filter: brightness(1.18); }
.sph-btn.danger { border-color: #733; color: #f99; }
.sph-btn.danger:hover { background: rgba(160,40,40,0.22); }
.sph-spacer { flex: 1; }
.sph-error  { padding: 14px; color: #f88; font-size: 12px; }

/* ── Manage-files modal overrides ── */
.sph-mgr-section {
    padding: 10px 14px 8px;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
}
.sph-mgr-section:last-child { border-bottom: none; }
.sph-mgr-label {
    font-size: 11px; opacity: 0.45; margin-bottom: 6px;
}
.sph-mgr-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 0;
}
.sph-mgr-name { font-size: 13px; font-weight: 500; flex-shrink: 0; }
.sph-mgr-path {
    font-size: 10px; opacity: 0.4; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sph-mgr-del {
    background: none; border: none; color: #c87;
    cursor: pointer; font-size: 14px; padding: 2px 6px;
    border-radius: 4px; opacity: 0.65; flex-shrink: 0;
    transition: opacity 0.15s;
}
.sph-mgr-del:hover { opacity: 1; background: rgba(200,80,80,0.18); }
.sph-mgr-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.sph-mgr-add-row { display: flex; gap: 6px; }

/* ── Search highlight ── */
mark.sph-highlight {
    background: rgba(255, 200, 50, 0.32);
    color: inherit; border-radius: 2px; padding: 0 1px;
}

/* ── Queue checkbox ── */
.sph-row-check {
    width: 18px; height: 18px; flex-shrink: 0;
    accent-color: #4a7aaa; cursor: pointer; margin-right: 4px;
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
        // If the save_to_path is no longer in the list, reset it to the first entry
        const saveW = getWidget(node, "save_to_path");
        if (saveW && deduped.length && !deduped.includes(saveW.value)) {
            setWidgetValue(node, "save_to_path", deduped[0]);
        }
        return deduped;
    }

    const overlay = el("div", "sph-overlay");
    const card    = el("div", "sph-card");
    // This modal sizes to its content — switch off the main panel's fixed flex height
    card.style.cssText = "width: min(500px, calc(100vw - 24px)); display: block; height: auto;";

    // Header
    const header   = el("div", "sph-header");
    const titleRow = el("div", "sph-title-row");
    const closeBtn = btn("sph-close", "×", close);
    closeBtn.title = "Close";
    titleRow.append(el("span", "sph-title", "History Files"), el("span", "sph-spacer"), closeBtn);
    header.appendChild(titleRow);

    // Scrollable body — plain block (sph-body has an unwanted border-right for the main panel)
    const body = document.createElement("div");
    body.style.cssText = "overflow-y: auto; max-height: min(55vh, 340px);";

    // Section: discovered files (populated by scan)
    const scanSection = el("div", "sph-mgr-section");
    scanSection.style.display = "none"; // hidden until scan returns results
    body.appendChild(scanSection);

    // Section: current files list
    const listSection = el("div", "sph-mgr-section");
    body.appendChild(listSection);

    // Section: add by path
    const addSection  = el("div", "sph-mgr-section");
    const addLabel    = el("div", "sph-mgr-label", "Add by path:");
    const addRow      = el("div", "sph-mgr-add-row");
    const addInput    = el("input", "sph-search");
    addInput.type        = "text";
    addInput.placeholder = "custom_nodes/comfyui-PromptHistory/my_history.json";
    addInput.style.cssText = "flex: 1; font-size: 12px; padding: 5px 8px;";
    const addBtn = btn("sph-btn", "Add", () => {
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

    // Footer
    const footer = el("div", "sph-footer");
    footer.append(el("span", "sph-spacer"), btn("sph-btn", "Done", close));

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
        const lbl = el("div", "sph-mgr-label", paths.length ? "Current files:" : "No files configured yet.");
        listSection.appendChild(lbl);
        paths.forEach(path => {
            const row  = el("div", "sph-mgr-row");
            const name = el("span", "sph-mgr-name", pathBasename(path));
            name.title = path;
            const full = el("span", "sph-mgr-path", path);
            const del  = btn("sph-mgr-del", "×", () => {
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
            const res  = await fetch("/select_prompt_history/scan");
            const data = await res.json();
            if (!data.ok) return;
            const current   = readPaths();
            const notAdded  = (data.files ?? []).filter(f => !current.includes(f));
            scanSection.style.display = notAdded.length ? "" : "none";
            scanSection.innerHTML = "";
            if (!notAdded.length) return;
            scanSection.appendChild(el("div", "sph-mgr-label", "Found in node folder — click to add:"));
            const chips = el("div", "sph-mgr-chips");
            notAdded.forEach(f => {
                const chip = btn("sph-chip", "+ " + pathBasename(f), () => {
                    writePaths([...readPaths(), f]);
                    renderList();
                    loadScan();
                });
                chip.title = f;
                chips.appendChild(chip);
            });
            scanSection.appendChild(chips);
        } catch { /* scan errors are non-fatal */ }
    }

    renderList();
    loadScan();
}

// ─── Panel ─────────────────────────────────────────────────────────────────

function openPanel(node) {
    injectCSS();

    // ── State ──
    const allPaths = getHistoryPaths(node);
    if (!allPaths.length) {
        openManagePanel(node);
        return;
    }

    // activePaths: null = all sources active; Set = explicit selection
    const savedActive = getActivePaths(node);
    let activePaths = savedActive.length > 0 ? new Set(savedActive) : null;

    let savePath  = getSavePath(node);
    let items           = [];
    let selectedIdx     = -1;
    let searchTimer     = null;
    let currentPatterns = [];

    // Queue selection — persisted on the node so it survives panel close/reopen
    if (!node.__sph_queue) node.__sph_queue = { selected: new Set(), items: new Map() };
    const queueSelected = node.__sph_queue.selected;
    const queueItems    = node.__sph_queue.items;

    const opts = {
        caseSensitive: false,
        wholeWord:     false,
        useRegex:      false,
        sortBy:        "recent",
    };

    // ── DOM helpers ──
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

    // ── Build DOM ──
    const overlay = el("div", "sph-overlay");
    const card    = el("div", "sph-card");

    // Title row
    const header   = el("div", "sph-header");
    const titleRow = el("div", "sph-title-row");
    const titleEl  = el("span", "sph-title", "Select Prompt From History");
    const totalEl  = el("span", "sph-total");
    const expandBtn = btn("sph-expand", "⤢", () => {
        const expanded = card.classList.toggle("sph-expanded");
        node.__sph_expanded = expanded;
        expandBtn.textContent = expanded ? "⤡" : "⤢";
        expandBtn.title = expanded ? "Restore size" : "Expand";
    });
    expandBtn.title = "Expand";
    if (node.__sph_expanded) {
        card.classList.add("sph-expanded");
        expandBtn.textContent = "⤡";
        expandBtn.title = "Restore size";
    }

    const closeBtn = btn("sph-close", "×", close);
    closeBtn.title = "Close  (Esc)";
    titleRow.append(titleEl, totalEl, expandBtn, closeBtn);

    // Source chips
    const sourcesRow   = el("div", "sph-sources-row");
    const sourcesLabel = el("span", "sph-sources-label", "Sources:");
    sourcesRow.appendChild(sourcesLabel);

    function isActive(path) {
        return activePaths === null || activePaths.has(path);
    }

    function persistActivePaths() {
        const toSave = activePaths === null ? [] : [...activePaths];
        setWidgetValue(node, "active_paths", JSON.stringify(toSave));
    }

    function togglePath(path) {
        if (activePaths === null) {
            // All were active — toggling one off: make all-except-that-one explicit
            activePaths = new Set(allPaths.filter(p => p !== path));
        } else if (activePaths.has(path)) {
            activePaths.delete(path);
            // If we've disabled all, keep at least one (the last toggled) enabled
            if (activePaths.size === 0) activePaths.add(path);
        } else {
            activePaths.add(path);
            // If all paths are now active, collapse back to null (= all)
            if (allPaths.every(p => activePaths.has(p))) activePaths = null;
        }
        persistActivePaths();
        updateChips();
        doSearch();
    }

    const chipEls = new Map();
    allPaths.forEach(path => {
        const chip = el("button", "sph-chip" + (isActive(path) ? " active" : ""));
        chip.textContent = pathBasename(path);
        chip.title = path;
        chip.onclick = () => togglePath(path);
        chipEls.set(path, chip);
        sourcesRow.appendChild(chip);
    });

    function updateChips() {
        allPaths.forEach(path => {
            const chip = chipEls.get(path);
            if (chip) chip.classList.toggle("active", isActive(path));
        });
    }

    // Save-to row
    const savetoRow   = el("div", "sph-saveto-row");
    const savetoLabel = el("span", "sph-saveto-label", "Save to:");
    const savetoSel   = el("select", "sph-saveto");
    allPaths.forEach(path => {
        const opt = document.createElement("option");
        opt.value = path;
        opt.textContent = pathBasename(path);
        opt.title = path;
        if (path === savePath) opt.selected = true;
        savetoSel.appendChild(opt);
    });
    savetoSel.onchange = () => {
        savePath = savetoSel.value;
        setWidgetValue(node, "save_to_path", savePath);
    };
    savetoRow.append(savetoLabel, savetoSel);

    // Search
    const searchRow = el("div", "sph-search-row");
    const searchEl  = el("input", "sph-search");
    searchEl.type = "text";
    searchEl.placeholder = "Search prompts\u2026";
    searchEl.autocomplete = "off";
    searchEl.spellcheck = false;
    searchRow.appendChild(searchEl);

    // Option toggles
    const optsRow = el("div", "sph-opts-row");
    function makeToggle(label, title, key) {
        const b = document.createElement("button");
        b.className = "sph-toggle"; b.textContent = label; b.title = title;
        b.onclick = () => { opts[key] = !opts[key]; b.classList.toggle("active", opts[key]); doSearch(); };
        return b;
    }
    const caseTgl = makeToggle("Aa",      "Case Sensitive", "caseSensitive");
    const wordTgl = makeToggle("\\bW\\b", "Whole Word",     "wholeWord");
    const rxTgl   = makeToggle(".*",      "Regex",          "useRegex");
    const sortSel = el("select", "sph-sort");
    [["recent", "\u2193 Recent"], ["alpha", "A\u2013Z"], ["hits", "\u2191 Most Used"]].forEach(([v, lbl]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = lbl;
        sortSel.appendChild(o);
    });
    sortSel.onchange = () => { opts.sortBy = sortSel.value; doSearch(); };
    optsRow.append(caseTgl, wordTgl, rxTgl, el("span", "sph-spacer"), sortSel);

    header.append(titleRow, sourcesRow, savetoRow, searchRow, optsRow);

    // Preview box
    const previewBox = el("div", "sph-preview");

    // Body
    const body = el("div", "sph-body");

    // Footer
    const footer    = el("div", "sph-footer");
    const clearBtn  = btn("sph-btn danger", "Clear Active Sources", onClearAll);
    const footSpc   = el("span", "sph-spacer");
    const queueBtn  = btn("sph-btn", "Queue 0", doQueue);
    queueBtn.title  = "Queue selected prompts for execution in order";
    queueBtn.style.display = "none";
    const cancelBtn = btn("sph-btn", "Cancel", close);
    footer.append(clearBtn, footSpc, queueBtn, cancelBtn);

    const contentArea = el("div", "sph-content");
    contentArea.append(body, previewBox);
    card.append(header, contentArea, footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // ── Close ──
    function close() {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
    }
    // Deliberately not closing on overlay click — users may miss-click while
    // checking queue boxes. Use × or Esc to close.

    // ── Preview ──
    function showPreview(text) {
        if (!text) { previewBox.textContent = ""; return; }
        previewBox.innerHTML = highlightHtml(text, currentPatterns);
    }

    // ── Render ──
    function setActive(idx) {
        selectedIdx = idx;
        card.querySelectorAll(".sph-row").forEach((r, i) => {
            r.classList.toggle("active", i === idx);
            if (i === idx) r.scrollIntoView({ block: "nearest" });
        });
        showPreview(idx >= 0 && items[idx] ? items[idx].text : "");
    }

    function renderList() {
        body.innerHTML = "";
        if (!items.length) {
            const empty = el("div", "sph-empty");
            const q = searchEl.value.trim();
            empty.innerHTML = q
                ? `No prompts matching <strong>${escHtml(q)}</strong>`
                : "No history in the active sources yet.";
            body.appendChild(empty);
            totalEl.textContent = "";
            selectedIdx = -1;
            previewBox.textContent = "";
            return;
        }

        totalEl.textContent = `${items.length} result${items.length !== 1 ? "s" : ""}`;

        items.forEach((item, idx) => {
            const row  = el("div", "sph-row");
            if (idx === selectedIdx) row.classList.add("active");

            // Queue checkbox
            const check = document.createElement("input");
            check.type = "checkbox";
            check.className = "sph-row-check";
            check.checked = queueSelected.has(item.key);
            check.title = "Add to queue";
            check.onclick = e => {
                e.stopPropagation();
                if (check.checked) { queueSelected.add(item.key); queueItems.set(item.key, item); }
                else               { queueSelected.delete(item.key); queueItems.delete(item.key); }
                updateQueueBtn();
            };

            const main    = el("div", "sph-row-main");
            const preview = el("div", "sph-row-preview");
            preview.innerHTML = highlightHtml(item.preview || item.text.slice(0, 120), currentPatterns);
            const meta    = el("div", "sph-row-meta");
            const parts   = [];
            if (item.ts)       parts.push(item.ts);
            if (item.hits > 1) parts.push(`used ${item.hits}\u00d7`);
            meta.textContent = parts.join(" \u00b7 ");
            main.append(preview, meta);

            const badge = el("span", "sph-badge", pathBasename(item.source || ""));
            badge.title = item.source || "";

            const delBtn = el("button", "sph-del");
            delBtn.textContent = "\u2715";
            delBtn.title = "Remove from history";
            delBtn.onclick = async e => {
                e.stopPropagation();
                try {
                    await apiDelete(item.source, item.key);
                    doSearch();
                } catch (err) {
                    console.error("[SelectPromptHistory] delete:", err);
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
            await apiSaveImmediate(savePath, item.text);
        } catch (err) {
            console.error("[SelectPromptHistory] immediate save failed:", err);
        }
        setWidgetValue(node, "text", item.text);
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
        const originalText = getWidget(node, "text")?.value ?? "";

        if (originalMode !== "edit") setWidgetValue(node, "mode", "edit");

        for (const item of toQueue) {
            setWidgetValue(node, "text", item.text);
            try { await app.queuePrompt(0, 1); }
            catch (e) { console.error("[SelectPromptHistory] queuePrompt failed:", e); }
        }

        setWidgetValue(node, "text", originalText);
        if (originalMode !== "edit") setWidgetValue(node, "mode", originalMode);

        queueSelected.clear();
        queueItems.clear();
        node.__sph_queue = { selected: new Set(), items: new Map() };
        close();
    }

    // ── Search ──
    function getEffectivePaths() {
        if (activePaths === null) return allPaths;
        return allPaths.filter(p => activePaths.has(p));
    }

    function doSearch() {
        const paths = getEffectivePaths();
        if (!paths.length) {
            body.innerHTML = `<div class="sph-empty">No sources selected.</div>`;
            totalEl.textContent = "";
            return;
        }
        const raw        = searchEl.value;
        const terms      = parseQuery(raw);
        currentPatterns  = buildPatterns(terms, opts);
        const multiTerm  = terms.length > 1;
        const backendQuery = multiTerm ? "" : raw;
        const backendOpts  = multiTerm ? { ...opts, maxResults: 5000 } : opts;
        apiListMulti(paths, backendQuery, backendOpts)
            .then(data => {
                let results = data.items ?? [];
                if (multiTerm) results = results.filter(it => itemMatchesAll(it.text, terms, opts));
                items = results;
                if (selectedIdx >= items.length) selectedIdx = -1;
                renderList();
            })
            .catch(err => {
                body.innerHTML = `<div class="sph-error">Error: ${escHtml(String(err.message ?? err))}</div>`;
            });
    }

    // ── Clear all active sources ──
    async function onClearAll() {
        const paths = getEffectivePaths();
        const names = paths.map(pathBasename).join(", ");
        if (!confirm(`Clear ALL history from:\n${names}\n\nThis cannot be undone.`)) return;
        try {
            for (const path of paths) await apiClear(path);
            doSearch();
        } catch (err) {
            console.error("[SelectPromptHistory] clear:", err);
        }
    }

    // ── Keyboard navigation ──
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

    // ── Launch ──
    doSearch();
    requestAnimationFrame(() => searchEl.focus());
}

// ─── Node attachment ───────────────────────────────────────────────────────

function attachToNode(node) {
    if (node.__sph_attached || node.type !== NODE_TYPE) return;
    node.__sph_attached = true;

    const modeWidget      = getWidget(node, "mode");
    const textWidget      = getWidget(node, "text");
    const pathsWidget     = getWidget(node, "history_paths");
    const saveToWidget    = getWidget(node, "save_to_path");
    const activeWidget    = getWidget(node, "active_paths");
    const maxWidget       = getWidget(node, "max_entries");

    // Hide widgets managed exclusively through the panel buttons
    for (const w of [pathsWidget, saveToWidget, activeWidget, maxWidget]) {
        if (!w) continue;
        w.computeSize = () => [0, -4];
        w.draw        = () => {};
    }

    // Grey out text widget in auto modes
    function syncTextState() {
        if (!textWidget) return;
        const mode   = modeWidget?.value;
        const isAuto = mode === "random" || mode === "sequential";
        textWidget.disabled = isAuto;
        if (textWidget.label !== undefined) {
            textWidget.label = isAuto ? `text (ignored in ${mode} mode)` : "text";
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
    node.__sph_syncTextState = syncTextState;

    // Buttons are appended first, then the panel button is repositioned between
    // mode and text. onConfigure uses a name-keyed restore (see SERIALIZED_WIDGET_ORDER)
    // to avoid positional corruption from this insert.
    const panelBtn = node.addWidget(
        "button",
        "Select Prompts\u2026",
        "",
        () => openPanel(node),
        { serialize: false },
    );
    panelBtn.serialize = false;

    const manageBtn = node.addWidget(
        "button",
        "Manage Files\u2026",
        "",
        () => openManagePanel(node),
        { serialize: false },
    );
    manageBtn.serialize = false;

    // Move the panel button to sit between mode and text.
    // Manage Files stays at the bottom (order: mode → Select Prompts… → text → … → Manage Files…).
    if (textWidget) {
        const textIdx  = node.widgets.indexOf(textWidget);
        const panelIdx = node.widgets.indexOf(panelBtn);
        if (textIdx >= 0 && panelIdx > textIdx) {
            node.widgets.splice(panelIdx, 1);
            node.widgets.splice(textIdx, 0, panelBtn);
        }
    }

    // Defer resize only for fresh nodes, not workflow restores
    node.__sph_is_configure = false;
    setTimeout(() => {
        if (node.__sph_is_configure) return;
        try { node.setSize(node.computeSize()); } catch (_) { /* ignore */ }
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) { /* ignore */ }
    }, 0);
}

// ─── Extension registration ────────────────────────────────────────────────

app.registerExtension({
    name: "select_prompt_history.v1",

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            attachToNode(this);
            return result;
        };

        // LiteGraph's serialize() writes widget values using index-based assignment
        // (widgets_values[widgetIndex] = value), so serialize:false widgets that sit
        // in the middle of the array leave null holes. The restore code reads with a
        // sequential counter, so every value after a hole lands in the wrong widget.
        //
        // Fix: rewrite widgets_values as a compact array (no holes) after the base
        // serialize runs. This matches what the sequential restore expects.
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

        // Widget names in the compact serialization order (must match Python INPUT_TYPES).
        const SERIALIZED_WIDGET_ORDER = [
            "mode", "text", "auto_save",
            "history_paths", "save_to_path", "active_paths", "max_entries",
        ];

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info, ...rest) {
            this.__sph_is_configure = true;

            // Build a name→value snapshot from the compact widgets_values array,
            // then re-apply after LiteGraph's own restore to ensure correct values
            // even when the sequential restore is offset by the repositioned button.
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
            this.__sph_syncTextState?.();
            return result;
        };
    },
});
