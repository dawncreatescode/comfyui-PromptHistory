/**
 * Recent queue batches, kept in the browser (localStorage).
 *
 * A batch stores the full prompt texts, not just history keys, so it can be
 * repeated even after the entries were deleted from the history files.
 */

const DEFAULT_MAX_BATCHES = 10;
// Keeps a store well inside the usual ~5 MB localStorage quota.
const DEFAULT_MAX_CHARS = 1_500_000;

function sameBatch(a, b) {
    if (a.length !== b.length) return false;
    return a.every((it, i) => it.key === b[i].key);
}

/**
 * @param {string} storageKey  localStorage key for this node type
 * @param {object} [opts]
 * @param {Storage} [opts.storage]  defaults to window.localStorage
 */
export function createBatchStore(storageKey, opts = {}) {
    const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
    const maxChars   = opts.maxChars   ?? DEFAULT_MAX_CHARS;

    function storage() {
        if (opts.storage) return opts.storage;
        try { return globalThis.localStorage ?? null; } catch { return null; }
    }

    function read() {
        try {
            const parsed = JSON.parse(storage()?.getItem(storageKey) || "[]");
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(b =>
                b && typeof b === "object" && Array.isArray(b.items) && b.items.length &&
                b.items.every(it => it && typeof it === "object" && typeof it.key === "string"));
        } catch {
            return [];
        }
    }

    function write(batches) {
        const store = storage();
        if (!store) return;
        let list = batches.slice(0, maxBatches);
        while (list.length) {
            const json = JSON.stringify(list);
            if (json.length <= maxChars || list.length === 1) {
                try {
                    store.setItem(storageKey, json);
                    return;
                } catch {
                    // Quota exceeded: fall through and drop the oldest batch.
                }
            }
            list = list.slice(0, -1);
        }
        try { store.removeItem(storageKey); } catch { /* ignore */ }
    }

    return {
        /** Newest first. */
        list() { return read(); },

        /** Record a queued batch. Repeating an existing batch moves it to the top. */
        add(items, now = Date.now()) {
            if (!Array.isArray(items) || !items.length) return null;
            const batch = { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, ts: now, items };
            const rest = read().filter(b => !sameBatch(b.items, items));
            write([batch, ...rest]);
            return batch;
        },

        remove(id) { write(read().filter(b => b.id !== id)); },

        clear() { write([]); },
    };
}

/** "14:05" for today, "Nov 12 14:05" otherwise. */
export function formatBatchTime(ts, now = new Date()) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (d.toDateString() === now.toDateString()) return time;
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
    return `${month} ${d.getDate()} ${time}`;
}
