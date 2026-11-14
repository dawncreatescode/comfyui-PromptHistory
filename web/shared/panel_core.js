/**
 * Prompt history — shared frontend for both nodes.
 *
 * "Select Prompt From History" and "Select Prompt Pair From History" differ
 * only in which text fields an entry has and which endpoints they talk to.
 * Each node file passes an adapter describing that to registerHistoryNode();
 * everything else (panel, file manager, queueing, node widgets) lives here.
 *
 * Adapter shape:
 *   nodeType, extensionName, tag       node class name, extension id, console prefix
 *   storageKey                         namespace for browser-side prefs / recent batches
 *   defaultPath                        fallback history path (replaced by the backend's)
 *   fields: [{name, label, tone?, emptyText?}]
 *                                      text widgets of the node = text fields of an entry
 *   widgetOrder                        widget names in Python INPUT_TYPES order
 *   endpoints: {list, save, delete, restore, clear}
 *   labels: {panelTitle, panelButton, manageTitle, noun, nouns, addPlaceholder}
 *   scopes?: {options: [[value, label]], default, fieldsFor(value), placeholder(value)}
 *                                      optional "search in" selector
 */

import { app } from "../../../scripts/app.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";

import { injectCSS } from "./styles.js";
import { OrderedSelection } from "./selection.js";
import { createBatchStore, formatBatchTime } from "./recent_batches.js";
import { escHtml, parseQuery, buildPatterns, highlightHtml, rowSnippet } from "./text_search.js";

const PAGE_SIZE    = 300;   // rows fetched per request
const ROW_CHARS    = 120;   // characters of a prompt shown in a list row
const UNDO_MS      = 7000;  // how long "Undo" stays available after a delete
const SEARCH_DELAY = 200;
const SORTS = [["recent", "↓ Recent"], ["alpha", "A–Z"], ["hits", "↑ Most Used"]];
const SCAN_ENDPOINT = "/select_prompt_history/scan";

// ─── Helpers ───────────────────────────────────────────────────────────────

function getWidget(node, name) {
    return (node?.widgets ?? []).find(w => w?.name === name) ?? null;
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

function getHistoryPaths(node) {
    const w = getWidget(node, "history_paths");
    const val = typeof w?.value === "string" ? w.value : "";
    return val.split("\n").map(s => s.trim()).filter(Boolean);
}

function getSavePath(node, adapter) {
    const w = getWidget(node, "save_to_path");
    const val = typeof w?.value === "string" ? w.value : "";
    return val.trim() || adapter.defaultPath;
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

function pathBasename(path) {
    return String(path).split(/[/\\]/).pop() || String(path);
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function btn(className, text, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = text;
    if (onClick) b.onclick = onClick;
    return b;
}

function plural(adapter, n) {
    return n === 1 ? adapter.labels.noun : adapter.labels.nouns;
}

function toast(severity, summary, detail) {
    try {
        const t = app.extensionManager?.toast;
        if (t?.add) { t.add({ severity, summary, detail, life: 4000 }); return; }
    } catch (_) { /* fall through */ }
    (severity === "error" ? console.error : console.info)(`[PromptHistory] ${summary}${detail ? ": " + detail : ""}`);
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
}

// ─── Widget value contract ─────────────────────────────────────────────────
//
// Saved workflows carry widget values positionally in `widgets_values`.
// The contract for these nodes is: INPUT_TYPES order, buttons and other
// frontend-only widgets never included.
// Newer ComfyUI frontends (>= 1.2x, July 2026) already drop `serialize:false`
// widgets from the positional array and add a name-keyed
// `widgets_values_named`; older ones write one slot per widget. Rather than
// guess which layout LiteGraph produced, serialize() below writes both forms
// itself from the widgets by name, and onConfigure() restores by name.
//
// Each adapter's `widgetOrder` must match its backend INPUT_TYPES. When a
// widget is added to a node's INPUT_TYPES, add it to that list and give it a
// default and a type rule in the two functions below.

const MODES = ["edit", "random", "sequential"];
const MAX_ENTRIES_DEFAULT = 500_000;
const MAX_ENTRIES_MIN     = 1;
const MAX_ENTRIES_MAX     = 10_000_000;

function widgetDefault(adapter, name) {
    switch (name) {
        case "mode":          return "edit";
        case "auto_save":     return true;
        case "history_paths": return adapter.defaultPath;
        case "save_to_path":  return adapter.defaultPath;
        case "max_entries":   return MAX_ENTRIES_DEFAULT;
        default:              return "";
    }
}

// Coerce a restored value to the type the backend validates against. Missing or
// corrupt values (e.g. a workflow saved while values were shifted by one slot)
// fall back to the widget default instead of being passed through, so an INT
// widget never ends up holding "" or a path string.
function coerceWidgetValue(adapter, name, val) {
    switch (name) {
        case "mode":
            return MODES.includes(val) ? val : widgetDefault(adapter, name);
        case "auto_save":
            if (typeof val === "boolean") return val;
            if (val === "true" || val === "false") return val === "true";
            return widgetDefault(adapter, name);
        case "max_entries": {
            if (val == null || val === "" || typeof val === "boolean") return MAX_ENTRIES_DEFAULT;
            const n = Math.trunc(Number(val));
            if (!Number.isFinite(n)) return MAX_ENTRIES_DEFAULT;
            return Math.min(MAX_ENTRIES_MAX, Math.max(MAX_ENTRIES_MIN, n));
        }
        default:
            // text fields, history_paths, save_to_path, active_paths
            return typeof val === "string" ? val : widgetDefault(adapter, name);
    }
}

function getMaxEntries(node, adapter) {
    return coerceWidgetValue(adapter, "max_entries", getWidget(node, "max_entries")?.value);
}

// Read saved widget values from serialized node info. Prefers the name-keyed
// form (order-independent), then fills gaps from the positional array.
function readSerializedWidgetValues(adapter, info) {
    const out = {};
    const named = info?.widgets_values_named;
    if (named && typeof named === "object" && !Array.isArray(named)) {
        for (const name of adapter.widgetOrder) {
            if (named[name] !== undefined) out[name] = named[name];
        }
    }
    const positional = info?.widgets_values;
    if (Array.isArray(positional)) {
        adapter.widgetOrder.forEach((name, i) => {
            if (out[name] === undefined && positional[i] !== undefined) out[name] = positional[i];
        });
    }
    return out;
}

// ─── Browser-side preferences and recent batches ───────────────────────────

function prefsKey(adapter) {
    return `comfyui-prompthistory.prefs.${adapter.storageKey}`;
}

function loadPrefs(adapter) {
    try {
        const parsed = JSON.parse(localStorage.getItem(prefsKey(adapter)) || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function savePrefs(adapter, prefs) {
    try { localStorage.setItem(prefsKey(adapter), JSON.stringify(prefs)); } catch (_) { /* ignore */ }
}

function batchStore(adapter) {
    if (!adapter.__batches) {
        adapter.__batches = createBatchStore(`comfyui-prompthistory.batches.${adapter.storageKey}`);
    }
    return adapter.__batches;
}

/** The part of an entry that is needed to queue it again later. */
function slimItem(adapter, item) {
    const out = { key: item.key };
    if (item.source) out.source = item.source;
    for (const f of adapter.fields) out[f.name] = typeof item[f.name] === "string" ? item[f.name] : "";
    return out;
}

function batchTitle(adapter, batch) {
    const n = batch.items.length;
    return `${formatBatchTime(batch.ts)} · ${n} ${plural(adapter, n)}`;
}

function batchPreview(adapter, batch, maxChars) {
    const first = batch.items[0] ?? {};
    const text = adapter.fields.map(f => first[f.name]).find(v => v) ?? "";
    return rowSnippet(text, [], maxChars);
}

// ─── Queueing ──────────────────────────────────────────────────────────────

/**
 * Queue one workflow run per entry, with the entry's text in the node.
 *
 * The node's own text and mode are put back afterwards, also when a run fails
 * to queue. Stops at the first failure. Resolves to {queued, total, error}.
 */
async function runQueue(node, adapter, entries, onProgress) {
    const total = entries.length;
    if (!total) return { queued: 0, total, error: null };
    if (typeof app.queuePrompt !== "function") {
        return { queued: 0, total, error: new Error("app.queuePrompt is not available in this ComfyUI version.") };
    }
    if (node.__ph_queueing) {
        return { queued: 0, total, error: new Error("This node is already queueing a batch.") };
    }
    node.__ph_queueing = true;

    const originalMode = getWidget(node, "mode")?.value;
    const originals = adapter.fields.map(f => getWidget(node, f.name)?.value ?? "");
    let queued = 0;
    let error = null;
    try {
        if (originalMode !== "edit") setWidgetValue(node, "mode", "edit");
        for (const entry of entries) {
            onProgress?.(queued, total);
            for (const f of adapter.fields) setWidgetValue(node, f.name, entry[f.name] ?? "");
            let accepted;
            try {
                accepted = await app.queuePrompt(0, 1);
            } catch (err) {
                error = err instanceof Error ? err : new Error(String(err));
                break;
            }
            // Current frontends resolve to false when the run was rejected (or when
            // another queue action is already in flight). Older ones resolve to
            // undefined on success, so only an explicit false counts as a failure.
            if (accepted === false) {
                error = new Error("ComfyUI did not accept the run.");
                break;
            }
            queued++;
        }
    } finally {
        adapter.fields.forEach((f, i) => setWidgetValue(node, f.name, originals[i]));
        if (originalMode !== "edit") setWidgetValue(node, "mode", originalMode);
        node.__ph_queueing = false;
    }
    if (error) console.error(`[${adapter.tag}] queueing stopped:`, error);
    return { queued, total, error };
}

/** Repeat a recent batch from the node's right-click menu (no panel involved). */
async function repeatBatch(node, adapter, batch) {
    const res = await runQueue(node, adapter, batch.items);
    if (res.error) {
        toast("error", "Prompt History", `Queued ${res.queued} of ${res.total}. ${res.error.message}`);
        return;
    }
    batchStore(adapter).add(batch.items);
    toast("success", "Prompt History", `Queued ${res.total} ${plural(adapter, res.total)}`);
}

// ─── Modal key handling ────────────────────────────────────────────────────
//
// One capture-phase listener per open modal. It always stops propagation so
// ComfyUI's global shortcuts (Ctrl+Enter = queue, single-letter sidebar keys…)
// cannot fire behind the modal; default actions such as typing are untouched.

function trapKeys(handler) {
    const listener = e => { e.stopPropagation(); handler(e); };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
}

// ─── File manager ──────────────────────────────────────────────────────────

function openManagePanel(node, adapter) {
    injectCSS();

    function readPaths() {
        return getHistoryPaths(node);
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

    const overlay = el("div", "ph-overlay");
    const card    = el("div", "ph-card");
    // This modal sizes to its content — switch off the main panel's fixed flex height
    card.style.cssText = "width: min(520px, calc(100vw - 24px)); display: block; height: auto;";

    const header   = el("div", "ph-header");
    const titleRow = el("div", "ph-title-row");
    const closeBtn = btn("ph-close", "×", close);
    closeBtn.title = "Close  (Esc)";
    titleRow.append(el("span", "ph-title", adapter.labels.manageTitle), closeBtn);
    header.appendChild(titleRow);

    const body = document.createElement("div");
    body.style.cssText = "overflow-y: auto; max-height: min(55vh, 340px);";

    // Section: discovered files (populated by scan)
    const scanSection = el("div", "ph-mgr-section");
    scanSection.style.display = "none";
    body.appendChild(scanSection);

    // Section: current files list
    const listSection = el("div", "ph-mgr-section");
    body.appendChild(listSection);

    // Section: add by path
    const addSection = el("div", "ph-mgr-section");
    const addRow     = el("div", "ph-mgr-add-row");
    const addInput   = el("input", "ph-search");
    addInput.type        = "text";
    addInput.placeholder = adapter.defaultPath.replace(/[^/]*$/, adapter.labels.addPlaceholder);
    addInput.style.cssText = "flex: 1; font-size: 12px; padding: 5px 8px;";
    const addBtn = btn("ph-btn", "Add", () => {
        const p = addInput.value.trim();
        if (!p) return;
        writePaths([...readPaths(), p]);
        addInput.value = "";
        renderList();
        loadScan();
    });
    addRow.append(addInput, addBtn);
    addSection.append(el("div", "ph-mgr-label", "Add by path:"), addRow);
    body.appendChild(addSection);

    const footer = el("div", "ph-footer");
    footer.append(el("span", "ph-spacer"), btn("ph-btn", "Done", close));

    card.append(header, body, footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const releaseKeys = trapKeys(e => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "Enter" && e.target === addInput) { e.preventDefault(); addBtn.click(); }
    });
    function close() {
        releaseKeys();
        overlay.remove();
    }

    async function clearFile(path) {
        const what = adapter.labels.nouns;
        if (!confirm(`Clear ALL ${what} from:\n${pathBasename(path)}\n\nThis cannot be undone.`)) return;
        try {
            await postJson(adapter.endpoints.clear, { history_path: path });
            toast("success", "Prompt History", `Cleared ${pathBasename(path)}`);
        } catch (err) {
            console.error(`[${adapter.tag}] clear:`, err);
            toast("error", "Prompt History", `Could not clear ${pathBasename(path)}: ${err.message ?? err}`);
        }
    }

    function renderList() {
        const paths = readPaths();
        listSection.innerHTML = "";
        listSection.appendChild(el("div", "ph-mgr-label", paths.length ? "Current files:" : "No files configured yet."));
        paths.forEach(path => {
            const row  = el("div", "ph-mgr-row");
            const name = el("span", "ph-mgr-name", pathBasename(path));
            name.title = path;
            const full = el("span", "ph-mgr-path", path);
            const clear = btn("ph-btn small danger", "Clear…", () => clearFile(path));
            clear.title = `Delete every entry in this file`;
            const del  = btn("ph-mgr-del", "×", () => {
                writePaths(readPaths().filter(p => p !== path));
                renderList();
                loadScan();
            });
            del.title = "Remove from this node (the file is kept)";
            row.append(name, full, clear, del);
            listSection.appendChild(row);
        });
    }

    async function loadScan() {
        try {
            const res  = await fetch(SCAN_ENDPOINT);
            const data = await res.json();
            if (!data.ok) return;
            const current  = readPaths();
            const notAdded = (data.files ?? []).filter(f => !current.includes(f));
            scanSection.style.display = notAdded.length ? "" : "none";
            scanSection.innerHTML = "";
            if (!notAdded.length) return;
            scanSection.appendChild(el("div", "ph-mgr-label", "Found in node folder — click to add:"));
            const chips = el("div", "ph-mgr-chips");
            notAdded.forEach(f => {
                const chip = btn("ph-chip", "+ " + pathBasename(f), () => {
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
    requestAnimationFrame(() => addInput.focus());
}

// ─── Panel ─────────────────────────────────────────────────────────────────

function openPanel(node, adapter) {
    injectCSS();
    if (node.__ph_panelOpen) return;

    const allPaths = getHistoryPaths(node);
    if (!allPaths.length) {
        openManagePanel(node, adapter);
        return;
    }
    node.__ph_panelOpen = true;

    const fields  = adapter.fields;
    const batches = batchStore(adapter);
    const prefs   = loadPrefs(adapter);
    // Ticked prompts live on the node so they survive closing the panel.
    const sel = (node.__ph_selection ??= new OrderedSelection());

    // activePaths: null = all sources active; Set = explicit selection
    const savedActive = getActivePaths(node);
    let activePaths = savedActive.length > 0 ? new Set(savedActive) : null;
    let savePath    = getSavePath(node, adapter);

    const scopeValues = adapter.scopes ? adapter.scopes.options.map(o => o[0]) : [];
    const opts = {
        caseSensitive: !!prefs.caseSensitive,
        wholeWord:     !!prefs.wholeWord,
        useRegex:      !!prefs.useRegex,
        sortBy:        SORTS.some(s => s[0] === prefs.sortBy) ? prefs.sortBy : "recent",
        searchIn:      adapter.scopes
            ? (scopeValues.includes(prefs.searchIn) ? prefs.searchIn : adapter.scopes.default)
            : null,
    };
    function rememberPrefs() {
        savePrefs(adapter, { ...opts, expanded: card.classList.contains("ph-expanded") });
    }

    let items        = [];     // search results loaded so far
    let matched      = 0;      // how many entries match in total
    let view         = [];     // rows on screen: `items`, or the ticked prompts
    let rowEls       = [];
    let activeIdx    = -1;     // highlighted row (hover / arrow keys)
    let showSelected = false;
    let patterns     = [];
    let searchSeq    = 0;
    let searchTimer  = null;
    let pending      = Promise.resolve();
    let loadingMore  = false;
    let busy         = false;  // a queue run is in progress
    let closed       = false;
    let paint        = null;   // drag down the gutter: {on, lastIdx}
    let undo         = null;   // {groups, timer}

    // ── DOM ──
    const overlay = el("div", "ph-overlay");
    const card    = el("div", "ph-card");
    card.tabIndex = -1;
    if (prefs.expanded) card.classList.add("ph-expanded");

    const header   = el("div", "ph-header");
    const titleRow = el("div", "ph-title-row");
    const expandBtn = btn("ph-expand", "", () => {
        card.classList.toggle("ph-expanded");
        syncExpandBtn();
        rememberPrefs();
    });
    function syncExpandBtn() {
        const expanded = card.classList.contains("ph-expanded");
        expandBtn.textContent = expanded ? "⤡" : "⤢";
        expandBtn.title = expanded ? "Restore size" : "Expand";
    }
    syncExpandBtn();
    const closeBtn = btn("ph-close", "×", close);
    closeBtn.title = "Close  (Esc)";
    titleRow.append(el("span", "ph-title", adapter.labels.panelTitle), expandBtn, closeBtn);

    // Source chips
    const sourcesRow = el("div", "ph-sources-row");
    sourcesRow.appendChild(el("span", "ph-sources-label", "Sources:"));

    function isActive(path) { return activePaths === null || activePaths.has(path); }

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
        setWidgetValue(node, "active_paths", JSON.stringify(activePaths === null ? [] : [...activePaths]));
        allPaths.forEach(p => chipEls.get(p)?.classList.toggle("active", isActive(p)));
        doSearch();
    }

    const chipEls = new Map();
    allPaths.forEach(path => {
        const chip = btn("ph-chip" + (isActive(path) ? " active" : ""), pathBasename(path), () => togglePath(path));
        chip.title = path;
        chipEls.set(path, chip);
        sourcesRow.appendChild(chip);
    });

    // Save-to
    const savetoRow = el("div", "ph-saveto-row");
    const savetoSel = el("select", "ph-saveto");
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
    savetoRow.append(el("span", "ph-saveto-label", "Save to:"), savetoSel);

    // Search
    const searchRow = el("div", "ph-search-row");
    const searchEl  = el("input", "ph-search");
    searchEl.type = "text";
    searchEl.autocomplete = "off";
    searchEl.spellcheck = false;
    searchEl.value = typeof node.__ph_lastQuery === "string" ? node.__ph_lastQuery : "";
    searchRow.appendChild(searchEl);
    function syncSearchPlaceholder() {
        searchEl.placeholder = adapter.scopes
            ? adapter.scopes.placeholder(opts.searchIn)
            : `Search ${adapter.labels.nouns}…`;
    }
    syncSearchPlaceholder();

    // Option toggles + scope + sort
    const optsRow = el("div", "ph-opts-row");
    function makeToggle(label, title, key) {
        const b = btn("ph-toggle" + (opts[key] ? " active" : ""), label, () => {
            opts[key] = !opts[key];
            b.classList.toggle("active", opts[key]);
            rememberPrefs();
            doSearch();
        });
        b.title = title;
        return b;
    }
    optsRow.append(
        makeToggle("Aa",      "Case Sensitive", "caseSensitive"),
        makeToggle("\\bW\\b", "Whole Word",     "wholeWord"),
        makeToggle(".*",      "Regex",          "useRegex"),
    );
    if (adapter.scopes) {
        const scopeSel = el("select", "ph-scope");
        scopeSel.title = "Which part of an entry to search";
        adapter.scopes.options.forEach(([v, lbl]) => {
            const o = document.createElement("option");
            o.value = v; o.textContent = lbl;
            scopeSel.appendChild(o);
        });
        scopeSel.value = opts.searchIn;
        scopeSel.onchange = () => {
            opts.searchIn = scopeSel.value;
            syncSearchPlaceholder();
            rememberPrefs();
            doSearch();
        };
        optsRow.appendChild(scopeSel);
    }
    const sortSel = el("select", "ph-sort");
    SORTS.forEach(([v, lbl]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = lbl;
        sortSel.appendChild(o);
    });
    sortSel.value = opts.sortBy;
    sortSel.onchange = () => { opts.sortBy = sortSel.value; rememberPrefs(); doSearch(); };
    optsRow.appendChild(sortSel);

    header.append(titleRow, sourcesRow, savetoRow, searchRow, optsRow);

    // List header: select-all, hint, count
    const listHead = el("div", "ph-listhead");
    const allBtn   = btn("ph-all", "", toggleAll);
    const allGut   = el("span", "ph-gutter");
    const allTick  = el("span", "ph-tick");
    allGut.appendChild(allTick);
    const allLabel = el("span", "", "Select all");
    allBtn.append(allGut, allLabel);
    allBtn.title = "Tick every row shown  (Ctrl+A)";
    const hintEl  = el("span", "ph-hint");
    const countEl = el("span", "ph-count");
    listHead.append(allBtn, hintEl, countEl);

    // List + preview
    const body = el("div", "ph-body");
    body.tabIndex = 0;
    const previewBox  = el("div", "ph-preview");
    const contentArea = el("div", "ph-content");
    contentArea.append(body, previewBox);
    const moreBtn = btn("ph-more", "", () => loadMore());

    // Undo bar
    const undoBar  = el("div", "ph-undo");
    undoBar.hidden = true;
    const undoText = el("span", "ph-undo-text");
    undoBar.append(undoText, btn("ph-btn small", "Undo", runUndo), btn("ph-close", "×", hideUndo));

    // Footer
    const footer    = el("div", "ph-footer");
    const recentBtn = btn("ph-btn", "Recent ▾", () => toggleRecent());
    const selInfo   = el("span", "ph-sel-info");
    const selCount  = el("span", "");
    const showSelBtn = btn("ph-link", "Show selected", () => {
        showSelected = !showSelected;
        activeIdx = -1;
        renderList();
    });
    const clearSelBtn = btn("ph-link", "Clear", () => { sel.clear(); afterSelectionChange(); });
    clearSelBtn.title = "Untick everything";
    selInfo.append(selCount, document.createTextNode(" · "), showSelBtn, document.createTextNode(" · "), clearSelBtn);
    const delSelBtn = btn("ph-btn danger", "", deleteSelected);
    delSelBtn.title = "Delete the ticked entries from history";
    const statusEl  = el("span", "ph-status");
    const queueBtn  = btn("ph-btn primary", "", doQueue);
    queueBtn.title  = "Queue one run per ticked entry, in the numbered order  (Ctrl+Enter)";
    const doneBtn   = btn("ph-btn", "Close", close);
    footer.append(recentBtn, selInfo, delSelBtn, el("span", "ph-spacer"), statusEl, queueBtn, doneBtn);

    // Recent batches popover
    const recentBox = el("div", "ph-recent");
    recentBox.hidden = true;

    card.append(header, listHead, contentArea, undoBar, footer, recentBox);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // ── Close ──
    // Deliberately not closing on overlay click — a stray click beside the
    // card should not throw away what the user is doing. Use × or Esc.
    function close() {
        if (closed) return;
        closed = true;
        releaseKeys();
        window.removeEventListener("pointerup", endPaint, true);
        window.removeEventListener("pointercancel", endPaint, true);
        clearTimeout(searchTimer);
        if (undo) clearTimeout(undo.timer);
        overlay.remove();
        node.__ph_panelOpen = false;
    }

    function setStatus(text, isError = false) {
        statusEl.textContent = text || "";
        statusEl.title = text || "";
        statusEl.classList.toggle("error", !!isError);
    }

    function setBusy(on) {
        busy = on;
        // Closing mid-run would hide whether the batch went through, so the
        // close buttons wait as well (Esc is ignored while busy).
        for (const b of [queueBtn, delSelBtn, recentBtn, allBtn, doneBtn, closeBtn]) b.disabled = on;
    }

    // ── Rows ──
    function fieldPatterns(name) {
        if (!adapter.scopes) return patterns;
        return adapter.scopes.fieldsFor(opts.searchIn).includes(name) ? patterns : [];
    }

    function buildRow(item, idx) {
        const row = el("div", "ph-row");
        row.dataset.idx = String(idx);

        const gutter = el("div", "ph-gutter");
        gutter.title = "Tick to queue · Shift-click for a range · drag to tick several";
        gutter.appendChild(el("span", "ph-tick"));

        const main = el("div", "ph-row-main");
        for (const f of fields) {
            const value = typeof item[f.name] === "string" ? item[f.name] : "";
            const line  = el("div", "ph-row-line" + (f.tone ? ` ph-tone-${f.tone}` : ""));
            if (!value && fields.length > 1) {
                line.classList.add("ph-line-empty");
                line.textContent = f.emptyText ?? `no ${f.label.toLowerCase()}`;
            } else {
                const pats = fieldPatterns(f.name);
                line.innerHTML = highlightHtml(rowSnippet(value, pats, ROW_CHARS), pats);
            }
            main.appendChild(line);
        }
        const parts = [];
        if (item.ts)       parts.push(item.ts);
        if (item.hits > 1) parts.push(`used ${item.hits}×`);
        if (parts.length) main.appendChild(el("div", "ph-row-meta", parts.join(" · ")));

        row.append(gutter, main);
        if (item.source) {
            const badge = el("span", "ph-badge", pathBasename(item.source));
            badge.title = item.source;
            row.appendChild(badge);
        }
        const runBtn = btn("ph-row-btn ph-run", "▶");
        runBtn.title = "Queue this one now, without loading it into the node  (Ctrl+Enter)";
        row.appendChild(runBtn);
        if (item.source) {
            const delBtn = btn("ph-row-btn ph-del", "✕");
            delBtn.title = "Remove from history (can be undone for a few seconds)";
            row.appendChild(delBtn);
        }
        return row;
    }

    function renderList({ keepScroll = false } = {}) {
        const scrollTop = body.scrollTop;
        if (showSelected && sel.size === 0) showSelected = false;
        view   = showSelected ? sel.items() : items;
        rowEls = [];
        body.textContent = "";

        if (!view.length) {
            const empty = el("div", "ph-empty");
            const q = searchEl.value.trim();
            empty.innerHTML = q
                ? `No ${escHtml(adapter.labels.nouns)} matching <strong>${escHtml(q)}</strong>`
                : "No history in the active sources yet.";
            body.appendChild(empty);
        } else {
            const frag = document.createDocumentFragment();
            view.forEach((item, idx) => {
                const row = buildRow(item, idx);
                rowEls.push(row);
                frag.appendChild(row);
            });
            body.appendChild(frag);
        }
        syncMore();

        if (activeIdx >= view.length) activeIdx = -1;
        setActive(activeIdx, false, true);
        refreshTicks();
        body.scrollTop = keepScroll ? scrollTop : 0;
    }

    function appendRows(fresh) {
        if (showSelected) { items.push(...fresh); syncMore(); return; }
        const frag = document.createDocumentFragment();
        for (const item of fresh) {
            items.push(item);
            const row = buildRow(item, rowEls.length);
            rowEls.push(row);
            frag.appendChild(row);
        }
        moreBtn.remove();
        body.appendChild(frag);
        syncMore();
        refreshTicks();
    }

    function syncMore() {
        moreBtn.remove();
        if (!showSelected && items.length && items.length < matched) {
            moreBtn.textContent =
                `Showing ${items.length.toLocaleString()} of ${matched.toLocaleString()} · Load more`;
            body.appendChild(moreBtn);
        }
        if (showSelected) {
            countEl.textContent = "ticked, in queue order";
        } else if (!items.length) {
            countEl.textContent = "";
        } else if (items.length < matched) {
            countEl.textContent = `${items.length.toLocaleString()} of ${matched.toLocaleString()}`;
        } else {
            countEl.textContent = `${matched.toLocaleString()} ${plural(adapter, matched)}`;
        }
    }

    /** Sync tick boxes, queue numbers and everything that depends on the selection. */
    function refreshTicks() {
        rowEls.forEach((row, i) => {
            const pos  = sel.position(view[i].key);
            const tick = row.firstChild.firstChild;
            row.classList.toggle("ticked", pos > 0);
            tick.classList.toggle("on", pos > 0);
            tick.classList.toggle("wide", pos > 99);
            tick.textContent = pos > 0 ? String(pos) : "";
        });

        const n = sel.size;
        const coverage = sel.coverage(view);
        allTick.classList.toggle("on", coverage === "all");
        allTick.classList.toggle("some", coverage === "some");
        allTick.textContent = coverage === "all" ? "✓" : coverage === "some" ? "–" : "";
        allLabel.textContent = coverage === "all" ? "Untick all" : "Select all";

        selInfo.hidden   = n === 0;
        delSelBtn.hidden = n === 0;
        queueBtn.hidden  = n === 0;
        selCount.textContent   = `${n} selected`;
        showSelBtn.textContent = showSelected ? "Show all" : "Show selected";
        delSelBtn.textContent  = `Delete ${n}…`;
        if (!busy) queueBtn.textContent = `Queue ${n}`;
        hintEl.textContent = n === 0
            ? ""
            : showSelected
                ? "Click the box to untick · double-click loads"
                : "Click ticks a row · double-click loads it";
    }

    function afterSelectionChange() {
        if (showSelected) renderList({ keepScroll: true });
        else refreshTicks();
    }

    // ── Highlight + preview ──
    function setActive(idx, scroll, force = false) {
        if (idx === activeIdx && !force) return;
        rowEls[activeIdx]?.classList.remove("active");
        activeIdx = idx;
        const row = rowEls[idx];
        if (row) {
            row.classList.add("active");
            // Only keyboard navigation scrolls. Scrolling on hover would move
            // the rows under the pointer while the user is aiming at one.
            if (scroll) row.scrollIntoView({ block: "nearest" });
        }
        renderPreview(view[idx] ?? null);
    }

    function renderPreview(item) {
        previewBox.textContent = "";
        if (!item) return;
        for (const f of fields) {
            const value   = typeof item[f.name] === "string" ? item[f.name] : "";
            const section = el("div", "ph-preview-section" + (f.tone ? ` ph-tone-${f.tone}` : ""));
            const head    = el("div", "ph-preview-head");
            head.appendChild(el("span", "ph-preview-label", fields.length > 1 ? f.label : ""));
            if (value) {
                const copy = btn("ph-copy", "Copy", async () => {
                    try {
                        await navigator.clipboard.writeText(value);
                        copy.textContent = "Copied";
                    } catch {
                        copy.textContent = "Copy failed";
                    }
                    setTimeout(() => { copy.textContent = "Copy"; }, 1200);
                });
                head.appendChild(copy);
            }
            const text = el("div", "ph-preview-text");
            if (value) text.innerHTML = highlightHtml(value, fieldPatterns(f.name));
            else { text.classList.add("ph-preview-empty"); text.textContent = "empty"; }
            section.append(head, text);
            previewBox.appendChild(section);
        }
    }

    function moveActive(delta, extend) {
        if (!view.length) return;
        const from = activeIdx;
        const to = from < 0
            ? (delta > 0 ? 0 : view.length - 1)
            : Math.max(0, Math.min(view.length - 1, from + delta));
        if (extend && !showSelected) {
            if (from >= 0) sel.set(view[from], true);
            sel.set(view[to], true);
            sel.anchorKey = view[to].key;
            refreshTicks();
        }
        setActive(to, true);
        // Move focus to the list so Space ticks; typing a character jumps back
        // to the search box (see onKeyDown).
        if (document.activeElement !== body) body.focus({ preventScroll: true });
    }

    // ── Pointer: ticking, painting, loading ──
    function rowIndexOf(target) {
        const row = target instanceof Element ? target.closest(".ph-row") : null;
        return row && row.parentNode === body ? Number(row.dataset.idx) : -1;
    }

    function endPaint() { paint = null; }
    window.addEventListener("pointerup", endPaint, true);
    window.addEventListener("pointercancel", endPaint, true);

    // Ticking happens on press, not on release, so that a press can turn into a
    // drag that paints the same state onto every row it passes.
    //   - on the tick gutter: always
    //   - anywhere else on a row: with Ctrl/Cmd or Shift held, or once something
    //     is ticked (sticky select) — the same cases in which a click would tick
    // `pressTicked` tells the click that follows the press that it is done.
    let pressTicked = false;
    body.addEventListener("pointerdown", e => {
        pressTicked = false;
        if (busy || e.button !== 0 || !(e.target instanceof Element)) return;
        if (e.target.closest(".ph-row-btn")) return;
        const idx = rowIndexOf(e.target);
        if (idx < 0) return;
        const onGutter = !!e.target.closest(".ph-gutter");
        // In the "show selected" view unticking removes the row, so only the box ticks there.
        const ticks = onGutter
            || (!showSelected && (e.ctrlKey || e.metaKey || e.shiftKey || sel.size > 0));
        if (!ticks) return;   // plain press with nothing ticked: the click loads the prompt

        pressTicked = true;
        e.preventDefault();   // no text selection, and no focus jump mid-drag
        body.focus({ preventScroll: true });
        const item = view[idx];
        if (e.shiftKey) {
            sel.selectRange(view, item.key);
        } else {
            const on = sel.toggle(item);
            paint = showSelected ? null : { on, lastIdx: idx };
        }
        afterSelectionChange();
    });

    body.addEventListener("pointermove", e => {
        const idx = rowIndexOf(e.target);
        if (idx < 0) return;
        if (paint && idx !== paint.lastIdx) {
            // A fast drag skips rows; fill everything between the last row and this one.
            const step = idx > paint.lastIdx ? 1 : -1;
            for (let i = paint.lastIdx + step; i !== idx + step; i += step) sel.set(view[i], paint.on);
            paint.lastIdx = idx;
            sel.anchorKey = view[idx].key;
            refreshTicks();
        }
        setActive(idx, false);
    });

    body.addEventListener("click", e => {
        if (busy || !(e.target instanceof Element)) return;
        const idx = rowIndexOf(e.target);
        if (idx < 0) return;
        const item = view[idx];
        if (e.target.closest(".ph-run")) { queueOne(item, rowEls[idx]); return; }
        if (e.target.closest(".ph-del")) { deleteItems([item]); return; }
        // Ticking (gutter, Ctrl/Shift, or sticky select once anything is ticked)
        // was done when the pointer went down; see the pointerdown handler.
        if (pressTicked || e.target.closest(".ph-gutter")) return;
        if (showSelected) return;   // rows vanish when unticked here; only the box unticks
        loadItem(item);
    });

    body.addEventListener("dblclick", e => {
        if (busy || !(e.target instanceof Element)) return;
        const idx = rowIndexOf(e.target);
        if (idx < 0 || e.target.closest(".ph-gutter, .ph-row-btn")) return;
        loadItem(view[idx]);
    });

    body.addEventListener("scroll", () => {
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 240) loadMore();
    });

    function toggleAll() {
        if (busy || !view.length) return;
        if (showSelected) sel.clear();
        else sel.setMany(view, sel.coverage(view) !== "all");
        afterSelectionChange();
    }

    // ── Load into the node ──
    async function loadItem(item) {
        if (!item || closed || busy) return;
        busy = true;   // a second click must not load twice
        try {
            const payload = { history_path: savePath, max_entries: getMaxEntries(node, adapter) };
            for (const f of fields) payload[f.name] = item[f.name] ?? "";
            await postJson(adapter.endpoints.save, payload);
        } catch (err) {
            console.error(`[${adapter.tag}] immediate save failed:`, err);
        }
        for (const f of fields) setWidgetValue(node, f.name, item[f.name] ?? "");
        busy = false;
        close();
    }

    // ── Queue ──
    async function doQueue() {
        if (busy) return;
        const entries = sel.items().map(it => slimItem(adapter, it));
        if (!entries.length) return;
        setBusy(true);
        setStatus("");
        const res = await runQueue(node, adapter, entries, (done, total) => {
            queueBtn.textContent = `Queueing ${done + 1}/${total}…`;
        });
        setBusy(false);
        if (closed) return;

        if (res.error) {
            // Keep the panel open with what is still to do ticked.
            sel.setMany(sel.items().slice(0, res.queued), false);
            setStatus(`Queued ${res.queued} of ${res.total}. ${res.error.message}`, true);
            afterSelectionChange();
            return;
        }
        batches.add(entries);
        sel.clear();
        close();
        toast("success", "Prompt History", `Queued ${res.total} ${plural(adapter, res.total)}`);
    }

    async function queueOne(item, row) {
        if (busy || !item) return;
        setBusy(true);
        setStatus("Queueing…");
        const res = await runQueue(node, adapter, [slimItem(adapter, item)]);
        setBusy(false);
        if (closed) return;
        refreshTicks();
        if (res.error) {
            setStatus(`Not queued. ${res.error.message}`, true);
            return;
        }
        setStatus("Queued 1 run");
        if (row?.isConnected) {
            row.classList.add("ph-flash");
            setTimeout(() => row.classList.remove("ph-flash"), 900);
        }
    }

    async function queueBatchAgain(batch) {
        if (busy) return;
        toggleRecent(false);
        setBusy(true);
        setStatus("");
        const res = await runQueue(node, adapter, batch.items, (done, total) => {
            setStatus(`Queueing ${done + 1}/${total}…`);
        });
        setBusy(false);
        if (closed) return;
        refreshTicks();
        if (res.error) {
            setStatus(`Queued ${res.queued} of ${res.total}. ${res.error.message}`, true);
            return;
        }
        batches.add(batch.items);
        close();
        toast("success", "Prompt History", `Queued ${res.total} ${plural(adapter, res.total)}`);
    }

    // ── Recent batches ──
    function toggleRecent(show = recentBox.hidden) {
        if (!show) { recentBox.hidden = true; return; }
        const list = batches.list();
        recentBox.textContent = "";
        recentBox.appendChild(el("div", "ph-recent-head", list.length
            ? "Recent queue batches — click one to tick its entries again"
            : "Batches you queue from this panel will be listed here."));
        for (const batch of list) {
            const row  = el("div", "ph-recent-row");
            const main = el("div", "ph-recent-main");
            main.append(
                el("div", "ph-recent-title", batchTitle(adapter, batch)),
                el("div", "ph-recent-sub", batchPreview(adapter, batch, 90)),
            );
            row.onclick = () => {
                sel.replace(batch.items);
                showSelected = true;
                activeIdx = -1;
                toggleRecent(false);
                renderList();
            };
            const again = btn("ph-btn small primary", "Queue again", e => {
                e.stopPropagation();
                queueBatchAgain(batch);
            });
            again.title = "Queue these entries now, with the workflow's current settings";
            const forget = btn("ph-mgr-del", "×", e => {
                e.stopPropagation();
                batches.remove(batch.id);
                toggleRecent(true);
            });
            forget.title = "Forget this batch";
            row.append(main, again, forget);
            recentBox.appendChild(row);
        }
        recentBox.hidden = false;
    }
    // A click elsewhere in the panel dismisses the popover.
    card.addEventListener("pointerdown", e => {
        if (recentBox.hidden || !(e.target instanceof Node)) return;
        if (!recentBox.contains(e.target) && !recentBtn.contains(e.target)) toggleRecent(false);
    }, true);

    // ── Delete + undo ──
    async function deleteItems(list) {
        const groups = new Map();
        for (const item of list) {
            if (!item?.source) continue;
            if (!groups.has(item.source)) groups.set(item.source, []);
            groups.get(item.source).push(item.key);
        }
        if (!groups.size) return;

        const done = [];
        let failure = null;
        for (const [path, keys] of groups) {
            try {
                const data = await postJson(adapter.endpoints.delete, { history_path: path, keys });
                if (data.removed?.length) done.push({ path, removed: data.removed });
            } catch (err) {
                failure = err;
                console.error(`[${adapter.tag}] delete:`, err);
            }
        }
        if (closed) return;
        for (const item of list) sel.remove(item.key);
        const n = done.reduce((sum, g) => sum + g.removed.length, 0);
        if (n) showUndo(`Deleted ${n} ${plural(adapter, n)}`, done);
        if (failure) setStatus(`Delete failed: ${failure.message ?? failure}`, true);
        doSearch({ keepScroll: true });
    }

    function deleteSelected() {
        if (busy) return;
        const list = sel.items().filter(it => it.source);
        if (!list.length) {
            setStatus("The ticked entries are no longer tied to a history file.", true);
            return;
        }
        const n = list.length;
        if (!confirm(`Delete ${n} ticked ${plural(adapter, n)} from history?\n\nYou can undo this for a few seconds afterwards.`)) return;
        deleteItems(list);
    }

    function showUndo(text, groups) {
        if (undo) clearTimeout(undo.timer);
        undoText.textContent = text;
        undoBar.hidden = false;
        undo = { groups, timer: setTimeout(hideUndo, UNDO_MS) };
    }

    function hideUndo() {
        if (undo) clearTimeout(undo.timer);
        undo = null;
        undoBar.hidden = true;
    }

    async function runUndo() {
        if (!undo) return;
        const groups = undo.groups;
        hideUndo();
        try {
            for (const g of groups) {
                await postJson(adapter.endpoints.restore, { history_path: g.path, removed: g.removed });
            }
        } catch (err) {
            console.error(`[${adapter.tag}] restore:`, err);
            setStatus(`Undo failed: ${err.message ?? err}`, true);
        }
        if (!closed) doSearch({ keepScroll: true });
    }

    // ── Search ──
    function effectivePaths() {
        return activePaths === null ? allPaths : allPaths.filter(p => activePaths.has(p));
    }

    function listRequest(offset) {
        const body = {
            history_paths:  effectivePaths(),
            query:          searchEl.value,
            case_sensitive: opts.caseSensitive,
            whole_word:     opts.wholeWord,
            use_regex:      opts.useRegex,
            sort_by:        opts.sortBy,
            offset,
            max_results:    PAGE_SIZE,
        };
        if (adapter.scopes) body.search_in = opts.searchIn;
        return postJson(adapter.endpoints.list, body);
    }

    function doSearch({ keepScroll = false } = {}) {
        clearTimeout(searchTimer);
        searchTimer = null;
        const seq = ++searchSeq;   // a slower, older response must not overwrite a newer one
        node.__ph_lastQuery = searchEl.value;
        patterns = buildPatterns(parseQuery(searchEl.value), opts);
        pending = listRequest(0)
            .then(data => {
                if (seq !== searchSeq || closed) return;
                items   = data.items ?? [];
                matched = typeof data.matched === "number" ? data.matched : items.length;
                if (!keepScroll) activeIdx = -1;
                renderList({ keepScroll });
            })
            .catch(err => {
                if (seq !== searchSeq || closed) return;
                items = []; matched = 0; view = []; rowEls = []; activeIdx = -1;
                body.innerHTML = `<div class="ph-error">Error: ${escHtml(String(err.message ?? err))}</div>`;
                previewBox.textContent = "";
                syncMore();
                refreshTicks();
            });
        return pending;
    }

    /** Run a debounced search now and resolve when the list is current. */
    function settleSearch() {
        if (searchTimer !== null) doSearch();
        return pending;
    }

    function loadMore() {
        if (loadingMore || showSelected || closed || items.length >= matched) return;
        loadingMore = true;
        const seq = searchSeq;
        listRequest(items.length)
            .then(data => {
                if (seq !== searchSeq || closed) return;
                const known = new Set(items.map(it => it.key));
                const fresh = (data.items ?? []).filter(it => !known.has(it.key));
                matched = typeof data.matched === "number" ? data.matched : matched;
                // Nothing new means the history changed under us; stop asking.
                if (!fresh.length) matched = items.length;
                appendRows(fresh);
            })
            .catch(err => console.error(`[${adapter.tag}] load more:`, err))
            .finally(() => { loadingMore = false; });
    }

    searchEl.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(doSearch, SEARCH_DELAY);
    });

    // ── Keyboard ──
    function onKeyDown(e) {
        if (closed || e.isComposing) return;
        const target   = e.target instanceof HTMLElement ? e.target : null;
        const tag      = target?.tagName ?? "";
        const inSearch = target === searchEl;
        const mod      = e.ctrlKey || e.metaKey;

        if (e.key === "Escape") {
            e.preventDefault();
            if (!recentBox.hidden) toggleRecent(false);
            else if (!busy) close();
            return;
        }
        if (busy) return;

        if (e.key === "Enter" && mod) {
            e.preventDefault();
            if (sel.size > 0) doQueue();
            else if (activeIdx >= 0) queueOne(view[activeIdx], rowEls[activeIdx]);
            return;
        }
        // Dropdowns keep all their keys; a focused button keeps Enter / Space.
        if (tag === "SELECT") return;
        if (tag === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;

        switch (e.key) {
            case "ArrowDown": e.preventDefault(); moveActive(1, e.shiftKey);   return;
            case "ArrowUp":   e.preventDefault(); moveActive(-1, e.shiftKey);  return;
            case "PageDown":  e.preventDefault(); moveActive(10, false);       return;
            case "PageUp":    e.preventDefault(); moveActive(-10, false);      return;
            case "Enter":
                e.preventDefault();
                // Wait for a search that is still in flight, so Enter never loads
                // a result from the previous query.
                settleSearch().then(() => {
                    if (closed || busy || !view.length) return;
                    loadItem(view[activeIdx >= 0 ? activeIdx : 0]);
                });
                return;
        }
        if (inSearch) return;   // everything else is typing

        if (e.key === " ") {
            e.preventDefault();
            if (activeIdx >= 0) { sel.toggle(view[activeIdx]); afterSelectionChange(); }
        } else if (mod && e.key.toLowerCase() === "a") {
            e.preventDefault();
            toggleAll();
        } else if (e.key === "Backspace" || (e.key.length === 1 && !mod && !e.altKey)) {
            // Typing while the list has focus continues the search.
            searchEl.focus();
        }
    }
    const releaseKeys = trapKeys(onKeyDown);

    // ── Launch ──
    refreshTicks();
    doSearch();
    requestAnimationFrame(() => { searchEl.focus(); searchEl.select(); });
}

// ─── Node attachment ───────────────────────────────────────────────────────

function setWidgetHidden(widget, hidden) {
    if (!widget || !!widget.hidden === hidden) return false;
    widget.hidden = hidden;
    widget.options = widget.options ?? {};
    widget.options.hidden = hidden;
    return true;
}

function attachToNode(node, adapter) {
    if (node.__ph_attached || node.type !== adapter.nodeType) return;
    node.__ph_attached = true;

    const modeWidget  = getWidget(node, "mode");
    const textWidgets = adapter.fields.map(f => getWidget(node, f.name)).filter(Boolean);

    // Hide widgets managed exclusively through the panel buttons
    for (const name of ["history_paths", "save_to_path", "active_paths", "max_entries"]) {
        const w = getWidget(node, name);
        if (!w) continue;
        // Current frontends (canvas and Vue node renderers) honour the hidden flag.
        w.hidden = true;
        w.options = w.options ?? {};
        w.options.hidden = true;
        // Older canvas-only frontends: collapse the row and skip drawing.
        w.computeSize = () => [0, -4];
        w.draw        = () => {};
    }

    // Buttons are appended first, then moved into place. serialize()/onConfigure()
    // work by widget name (see "Widget value contract"), so reordering widgets
    // here cannot shift saved values.
    const panelBtn = node.addWidget(
        "button", adapter.labels.panelButton, "",
        () => openPanel(node, adapter),
        { serialize: false },
    );
    panelBtn.serialize = false;

    const manageBtn = node.addWidget(
        "button", "Manage Files…", "",
        () => openManagePanel(node, adapter),
        { serialize: false },
    );
    manageBtn.serialize = false;

    // Read-only box showing what the last random/sequential run used. It is a
    // frontend-only widget: never serialized, never sent to the backend, and
    // the node's own text widgets are left alone so the edit text survives.
    let usedWidget = null;
    let editBtn    = null;
    try {
        usedWidget = ComfyWidgets.STRING(node, "last_used_prompt", ["STRING", { multiline: true }], app)?.widget ?? null;
        if (usedWidget) {
            usedWidget.serialize = false;
            usedWidget.options = usedWidget.options ?? {};
            usedWidget.options.serialize = false;
            usedWidget.options.read_only = true;
            usedWidget.label = "used by last run";
            const input = usedWidget.element ?? usedWidget.inputEl;
            if (input) {
                input.readOnly = true;
                input.placeholder = "The prompt picked by the last run appears here";
            }
            editBtn = node.addWidget(
                "button", "Edit this prompt", "",
                () => {
                    const used = node.__ph_used;
                    if (!used) return;
                    for (const f of adapter.fields) setWidgetValue(node, f.name, used[f.name] ?? "");
                    setWidgetValue(node, "mode", "edit");
                },
                { serialize: false },
            );
            editBtn.serialize = false;
        }
    } catch (err) {
        console.warn(`[${adapter.tag}] could not add the "used prompt" box:`, err);
        usedWidget = null;
        editBtn = null;
    }

    function moveBefore(widget, anchor) {
        if (!widget || !anchor) return;
        const from = node.widgets.indexOf(widget);
        if (from < 0) return;
        node.widgets.splice(from, 1);
        const to = node.widgets.indexOf(anchor);
        node.widgets.splice(to < 0 ? node.widgets.length : to, 0, widget);
    }
    function moveAfter(widget, anchor) {
        if (!widget || !anchor) return;
        const from = node.widgets.indexOf(widget);
        if (from < 0) return;
        node.widgets.splice(from, 1);
        const at = node.widgets.indexOf(anchor);
        node.widgets.splice(at < 0 ? node.widgets.length : at + 1, 0, widget);
    }
    // Order: mode → panel button → text field(s) → used box → Edit this prompt → … → Manage Files…
    if (textWidgets.length) {
        moveBefore(panelBtn, textWidgets[0]);
        moveAfter(usedWidget, textWidgets.at(-1));
        moveAfter(editBtn, usedWidget);
    }

    // Grey out the text widgets in auto modes and show the "used" box instead.
    function syncAutoState(grow = false) {
        const mode   = modeWidget?.value;
        const isAuto = mode === "random" || mode === "sequential";
        adapter.fields.forEach(f => {
            const w = getWidget(node, f.name);
            if (!w) return;
            w.disabled = isAuto;
            if (w.label !== undefined) w.label = isAuto ? `${f.name} (ignored in ${mode} mode)` : f.name;
        });
        let changed = setWidgetHidden(usedWidget, !isAuto);
        changed = setWidgetHidden(editBtn, !isAuto || !node.__ph_used) || changed;
        if (changed && grow) {
            // Make room for widgets that just appeared; never shrink the node.
            try {
                const need = node.computeSize();
                if (need[1] > node.size[1]) node.setSize([node.size[0], need[1]]);
            } catch (_) { /* ignore */ }
        }
        if (changed) {
            try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) { /* ignore */ }
        }
    }
    if (modeWidget) {
        const origCb = modeWidget.callback;
        modeWidget.callback = function (value, ...rest) {
            syncAutoState(true);
            return origCb?.apply(this, [value, ...rest]);
        };
    }
    syncAutoState();
    node.__ph_syncAutoState = syncAutoState;

    node.__ph_showUsed = values => {
        if (!usedWidget || !Array.isArray(values)) return;
        const used = {};
        adapter.fields.forEach((f, i) => { used[f.name] = typeof values[i] === "string" ? values[i] : ""; });
        node.__ph_used = used;
        usedWidget.value = adapter.fields.length === 1
            ? used[adapter.fields[0].name]
            : adapter.fields.map(f => `${f.label}:\n${used[f.name] || "(empty)"}`).join("\n\n");
        syncAutoState(true);
    };

    // Defer resize only for fresh nodes, not workflow restores
    node.__ph_is_configure = false;
    setTimeout(() => {
        if (node.__ph_is_configure) return;
        try { node.setSize(node.computeSize()); } catch (_) { /* ignore */ }
        try { app.graph?.setDirtyCanvas?.(true, true); } catch (_) { /* ignore */ }
    }, 0);
}

// ─── Extension registration ────────────────────────────────────────────────

export function registerHistoryNode(adapter) {
    app.registerExtension({
        name: adapter.extensionName,

        beforeRegisterNodeDef(nodeType, nodeData) {
            if (nodeData.name !== adapter.nodeType) return;

            // Use the backend's real default path: it is derived from the folder the
            // node is actually installed in (registry installs may rename/lowercase it).
            const backendDefault = nodeData.input?.optional?.history_paths?.[1]?.default;
            if (typeof backendDefault === "string" && backendDefault.trim()) {
                adapter.defaultPath = backendDefault.trim();
            }

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);
                attachToNode(this, adapter);
                return result;
            };

            const origSerialize = nodeType.prototype.serialize;
            nodeType.prototype.serialize = function () {
                const data = origSerialize?.apply(this, arguments) ?? {};
                const named = {};
                for (const name of adapter.widgetOrder) {
                    const w = getWidget(this, name);
                    named[name] = w && w.value !== undefined ? w.value : null;
                }
                // Positional form in INPUT_TYPES order (buttons excluded) for every
                // frontend; name-keyed form for frontends that restore by name.
                data.widgets_values       = adapter.widgetOrder.map(name => named[name]);
                data.widgets_values_named = named;
                return data;
            };

            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info, ...rest) {
                this.__ph_is_configure = true;

                const saved  = readSerializedWidgetValues(adapter, info);
                const result = onConfigure?.apply(this, [info, ...rest]);

                // Re-apply by name after LiteGraph's own restore so repositioned
                // widgets can never offset values, then normalize each value to
                // the type the backend expects.
                for (const name of adapter.widgetOrder) {
                    const w = getWidget(this, name);
                    if (!w) continue;
                    const raw = saved[name] !== undefined ? saved[name] : w.value;
                    w.value = coerceWidgetValue(adapter, name, raw);
                }
                this.__ph_syncAutoState?.();
                return result;
            };

            // The backend reports which prompt a random/sequential run picked.
            const onExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (output, ...rest) {
                const result = onExecuted?.apply(this, [output, ...rest]);
                const used = output?.prompt_history_used;
                if (Array.isArray(used)) this.__ph_showUsed?.(used);
                return result;
            };
        },

        // Right-click a node → repeat one of the recent queue batches.
        getNodeMenuItems(node) {
            if (node?.type !== adapter.nodeType) return [];
            const list = batchStore(adapter).list();
            if (!list.length) return [];
            return [
                null,
                {
                    content: "Repeat queue batch",
                    has_submenu: true,
                    submenu: {
                        options: list.map(batch => ({
                            content: `${batchTitle(adapter, batch)} — ${batchPreview(adapter, batch, 40)}`,
                            callback: () => { repeatBatch(node, adapter, batch); },
                        })),
                    },
                },
            ];
        },
    });
}
