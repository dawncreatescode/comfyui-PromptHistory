/** Styles for the history panel and the file manager (shared by both nodes). */

const STYLE_ID = "ph-styles-v2";

const CSS = `
.ph-overlay {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center;
}
.ph-card {
    position: relative;
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
.ph-card:focus { outline: none; }
.ph-card.ph-expanded {
    width: min(1020px, calc(100vw - 24px));
    height: 93vh;
}
.ph-header {
    padding: 12px 14px 0;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
}
.ph-title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.ph-title  { font-size: 14px; font-weight: 600; flex: 1; }
.ph-close, .ph-expand {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 6px; border-radius: 6px;
    opacity: 0.55; transition: opacity 0.15s;
}
.ph-close { font-size: 18px; }
.ph-close:hover, .ph-expand:hover { opacity: 1; background: rgba(255,255,255,0.08); }

/* ── Sources ── */
.ph-sources-row {
    display: flex; flex-wrap: wrap; gap: 5px;
    margin-bottom: 8px; align-items: center;
}
.ph-sources-label { font-size: 11px; opacity: 0.45; flex-shrink: 0; margin-right: 2px; }
.ph-chip {
    padding: 2px 10px; font-size: 11px; cursor: pointer; border-radius: 12px;
    border: 1px solid var(--border-color, #555);
    background: var(--comfy-input-bg, #2b2b2b);
    color: var(--comfy-text, #999);
    transition: all 0.12s; white-space: nowrap;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis;
}
.ph-chip.active { background: #1e4a7a; border-color: #4a7aaa; color: #cde; }
.ph-chip:hover  { filter: brightness(1.2); }

/* ── Save-to ── */
.ph-saveto-row { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.ph-saveto-label { font-size: 11px; opacity: 0.45; flex-shrink: 0; }
.ph-saveto-warn  { font-size: 11px; color: #e0b070; white-space: nowrap; }
.ph-saveto-warn[hidden] { display: none; }
.ph-saveto {
    flex: 1; padding: 3px 8px; font-size: 11px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 6px; cursor: pointer; outline: none;
    max-width: 320px;
}

/* ── Search ── */
.ph-search-row { display: flex; gap: 6px; margin-bottom: 8px; }
.ph-search {
    flex: 1; padding: 7px 10px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 8px; outline: none; font-size: 13px;
    transition: border-color 0.15s;
    user-select: text;
}
.ph-search:focus { border-color: #6a8aaa; }

/* ── Option toggles + scope + sort ── */
.ph-opts-row {
    display: flex; gap: 4px; margin-bottom: 10px;
    flex-wrap: wrap; align-items: center;
}
.ph-toggle {
    padding: 3px 10px; font-size: 11px; cursor: pointer;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #bbb);
    border-radius: 6px; white-space: nowrap;
    transition: background 0.12s, border-color 0.12s;
}
.ph-toggle:hover  { filter: brightness(1.18); }
.ph-toggle.active { background: #1e4a7a; border-color: #4a7aaa; color: #cde; }
.ph-scope, .ph-sort, .ph-mgr-select {
    padding: 3px 8px; font-size: 11px;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 6px; cursor: pointer; outline: none;
}
.ph-sort { margin-left: auto; }

/* ── List header: select-all, hint, count ── */
.ph-listhead {
    display: flex; align-items: center; gap: 8px;
    padding: 0 14px 0 0; min-height: 28px; flex-shrink: 0;
    font-size: 11px;
    border-bottom: 1px solid var(--border-color, #3a3a3a);
}
.ph-all {
    display: flex; align-items: center; gap: 0;
    background: none; border: none; color: inherit; cursor: pointer;
    padding: 0; font-size: 11px; opacity: 0.75;
}
.ph-all:hover { opacity: 1; }
.ph-all .ph-gutter { cursor: pointer; padding: 5px 0; }
.ph-hint  { opacity: 0.5; font-style: italic; flex: 1; text-align: center;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-count { opacity: 0.5; margin-left: auto; white-space: nowrap; }

/* ── Content area: list on left, preview on right ── */
.ph-content { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.ph-body {
    flex: 1; overflow-y: auto; min-width: 0; min-height: 80px;
    border-right: 1px solid var(--border-color, #3a3a3a);
    scrollbar-width: thin; scrollbar-color: #444 transparent;
    outline: none;
}
.ph-body::-webkit-scrollbar       { width: 6px; }
.ph-body::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

/* ── Preview ── */
.ph-preview {
    width: 280px; flex-shrink: 0;
    padding: 10px 14px 12px;
    overflow-y: auto;
    font-size: 12px; line-height: 1.6;
    scrollbar-width: thin; scrollbar-color: #444 transparent;
}
.ph-preview::-webkit-scrollbar       { width: 6px; }
.ph-preview::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
.ph-preview:empty::before {
    content: "Hover or use the arrow keys to preview"; opacity: 0.25; font-style: italic;
}
.ph-card.ph-expanded .ph-preview { width: 400px; }
.ph-preview-section { margin-bottom: 14px; }
.ph-preview-section:last-child { margin-bottom: 0; }
.ph-preview-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; min-height: 20px; }
.ph-preview-label {
    font-size: 10px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; opacity: 0.5; flex: 1;
}
.ph-copy {
    background: none; border: 1px solid var(--border-color, #555); color: inherit;
    font-size: 10px; padding: 1px 7px; border-radius: 5px; cursor: pointer; opacity: 0.6;
}
.ph-copy:hover { opacity: 1; }
.ph-preview-text {
    white-space: pre-wrap; word-break: break-word;
    color: rgba(221,221,221,0.85);
    user-select: text; cursor: text;
}
.ph-tone-pos .ph-preview-text, .ph-tone-pos .ph-preview-label { color: #8ecf9c; }
.ph-tone-neg .ph-preview-text, .ph-tone-neg .ph-preview-label { color: #cf9898; }
.ph-preview-empty { opacity: 0.35; font-style: italic; }

/* ── Row ── */
.ph-row {
    display: flex; align-items: stretch; gap: 8px;
    padding: 0 14px 0 0; cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.035);
}
.ph-row.active  { background: rgba(255,255,255,0.07); }
.ph-row.ticked  { background: rgba(40,80,140,0.20); }
.ph-row.ticked.active { background: rgba(40,80,140,0.34); }
.ph-row.ph-flash { background: rgba(70,150,90,0.30); transition: background 0.2s; }
.ph-row-main { flex: 1; min-width: 0; padding: 7px 0; }
.ph-row-line {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-size: 13px; line-height: 1.4;
}
.ph-row-line + .ph-row-line { font-size: 12px; margin-top: 2px; opacity: 0.9; }
.ph-row-line.ph-tone-pos { color: #8ecf9c; }
.ph-row-line.ph-tone-neg { color: #cf9898; }
.ph-row-line.ph-line-empty { opacity: 0.25; font-style: italic; color: var(--comfy-text, #ddd); }
.ph-row-meta { font-size: 10px; opacity: 0.4; margin-top: 2px; }

/* ── Tick gutter: the whole left edge of a row toggles the tick ── */
.ph-gutter {
    width: 40px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; touch-action: none;
}
.ph-gutter:hover .ph-tick { border-color: #7aa7d6; }
.ph-tick {
    width: 18px; height: 18px; box-sizing: border-box;
    border: 1.5px solid #666; border-radius: 4px;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; line-height: 1; color: #fff;
    pointer-events: none;
}
.ph-tick.on   { background: #2f6cab; border-color: #4a8fd6; }
.ph-tick.some { background: rgba(47,108,171,0.45); border-color: #4a8fd6; }
.ph-tick.wide { width: auto; min-width: 18px; padding: 0 3px; }

/* ── Source badge ── */
.ph-badge {
    font-size: 10px; padding: 1px 7px; border-radius: 10px; flex-shrink: 0; align-self: center;
    background: rgba(255,255,255,0.07); color: rgba(221,221,221,0.45);
    max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ph-badge.ph-pair { background: rgba(120,150,220,0.16); color: rgba(190,205,240,0.8); max-width: none; }

/* ── Row buttons: queue this one, delete ── */
.ph-row-btn {
    background: none; border: none; cursor: pointer;
    font-size: 13px; padding: 3px 7px; border-radius: 4px;
    opacity: 0; flex-shrink: 0; align-self: center; transition: opacity 0.15s;
}
.ph-row:hover .ph-row-btn, .ph-row.active .ph-row-btn { opacity: 0.6; }
.ph-run { color: #8fc79b; }
.ph-run:hover { opacity: 1 !important; background: rgba(80,170,100,0.18); }
.ph-del { color: #c87; margin-left: 6px; }
.ph-del:hover { opacity: 1 !important; background: rgba(200,80,80,0.18); }

/* ── Empty / error / load more ── */
.ph-empty { padding: 32px 16px; text-align: center; opacity: 0.45; font-size: 13px; line-height: 1.6; }
.ph-error { padding: 14px; color: #f88; font-size: 12px; }
.ph-more {
    display: block; width: 100%; padding: 10px; font-size: 11px; cursor: pointer;
    background: none; border: none; color: inherit; opacity: 0.55; text-align: center;
}
.ph-more:hover { opacity: 1; background: rgba(255,255,255,0.05); }

/* ── Undo bar ── */
.ph-undo {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 14px; font-size: 12px; flex-shrink: 0;
    background: rgba(160,120,40,0.20);
    border-top: 1px solid rgba(200,160,60,0.35);
}
.ph-undo[hidden] { display: none; }
.ph-undo-text { flex: 1; }

/* ── Footer ── */
.ph-footer {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border-color, #3a3a3a);
    flex-shrink: 0;
}
.ph-btn {
    padding: 6px 14px; font-size: 12px; cursor: pointer;
    background: var(--comfy-input-bg, #2b2b2b);
    border: 1px solid var(--border-color, #555);
    color: var(--comfy-text, #ddd);
    border-radius: 8px; transition: filter 0.12s; white-space: nowrap;
}
.ph-btn:hover   { filter: brightness(1.18); }
.ph-btn:disabled { opacity: 0.45; cursor: default; filter: none; }
.ph-btn.small   { padding: 3px 10px; font-size: 11px; border-radius: 6px; }
.ph-btn.primary { background: #1e4a7a; border-color: #4a7aaa; color: #e4eefa; font-weight: 600; }
.ph-btn.danger  { border-color: #733; color: #f99; }
.ph-btn.danger:hover { background: rgba(160,40,40,0.22); }
.ph-spacer { flex: 1; }
.ph-sel-info { font-size: 12px; white-space: nowrap; }
.ph-link {
    background: none; border: none; color: #8fb8e6; cursor: pointer;
    font-size: 12px; padding: 0 2px; text-decoration: underline;
}
.ph-link:hover { color: #b9d6f5; }
.ph-status { font-size: 11px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-status.error { color: #f99; opacity: 1; }
[hidden].ph-btn, [hidden].ph-sel-info, [hidden].ph-status { display: none; }

/* ── Recent batches popover ── */
.ph-recent {
    position: absolute; left: 14px; bottom: 52px; z-index: 2;
    width: min(460px, calc(100% - 28px)); max-height: 60%;
    overflow-y: auto;
    background: var(--comfy-menu-bg, #1e1e1e);
    border: 1px solid var(--border-color, #555);
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0,0,0,0.6);
}
.ph-recent[hidden] { display: none; }
.ph-recent-head { padding: 8px 12px 6px; font-size: 11px; opacity: 0.5; }
.ph-recent-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 8px 7px 12px; cursor: pointer;
    border-top: 1px solid rgba(255,255,255,0.05);
}
.ph-recent-row:hover { background: rgba(255,255,255,0.06); }
.ph-recent-row.ph-flash { background: rgba(70,150,90,0.30); transition: background 0.2s; }
.ph-recent-main { flex: 1; min-width: 0; }
.ph-recent-title { font-size: 12px; }
.ph-recent-sub {
    font-size: 11px; opacity: 0.5;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── Manage-files modal ── */
.ph-mgr-section { padding: 10px 14px 8px; border-bottom: 1px solid var(--border-color, #3a3a3a); }
.ph-mgr-section:last-child { border-bottom: none; }
.ph-mgr-label { font-size: 11px; opacity: 0.45; margin-bottom: 6px; }
.ph-mgr-row   { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.ph-mgr-name  { font-size: 13px; font-weight: 500; flex-shrink: 0; }
.ph-mgr-path  {
    font-size: 10px; opacity: 0.4; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ph-mgr-del {
    background: none; border: none; color: #c87;
    cursor: pointer; font-size: 14px; padding: 2px 6px;
    border-radius: 4px; opacity: 0.65; flex-shrink: 0;
    transition: opacity 0.15s;
}
.ph-mgr-del:hover { opacity: 1; background: rgba(200,80,80,0.18); }
.ph-mgr-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ph-mgr-toggle {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 12px; padding: 2px 0; opacity: 0.6; text-align: left;
}
.ph-mgr-toggle:hover { opacity: 1; }
.ph-mgr-danger { margin-top: 6px; }
.ph-mgr-count { font-size: 11px; opacity: 0.5; flex: 1; white-space: nowrap; }
.ph-mgr-armed {
    background: rgba(160,40,40,0.16); border: 1px solid rgba(200,80,80,0.35);
    border-radius: 6px; padding: 6px 8px; margin: 2px 0;
}
.ph-mgr-ask { flex: 1; font-size: 12px; line-height: 1.4; color: #fbb; }
.ph-mgr-add-row { display: flex; gap: 6px; }
.ph-mgr-tag {
    font-size: 10px; padding: 1px 7px; border-radius: 10px; flex-shrink: 0; white-space: nowrap;
    background: rgba(120,150,220,0.16); color: rgba(190,205,240,0.85);
}
.ph-mgr-note { font-size: 11px; line-height: 1.4; color: #e0b070; padding: 4px 0 2px; }
.ph-mgr-side { display: flex; align-items: center; gap: 8px; }
.ph-mgr-side[hidden] { display: none; }
.ph-mgr-side .ph-mgr-label { margin-bottom: 0; }

/* ── Search highlight ── */
mark.ph-highlight {
    background: rgba(255,200,50,0.32);
    color: inherit; border-radius: 2px; padding: 0 1px;
}
`;

export function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}
