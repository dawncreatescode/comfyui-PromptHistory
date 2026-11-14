/**
 * Ordered selection of history entries ("ticked" prompts).
 *
 * DOM-free. Keeps the order in which entries were ticked, because that is the
 * order they are queued in, and remembers an anchor for Shift-click ranges.
 */

export class OrderedSelection {
    constructor() {
        this._items = new Map();   // key -> item, in tick order
        this._positions = null;    // key -> 1-based position, rebuilt lazily
        this.anchorKey = null;     // last row the user toggled directly
    }

    get size() { return this._items.size; }

    has(key) { return this._items.has(key); }

    /** Items in tick (= queue) order. */
    items() { return [...this._items.values()]; }

    keys() { return [...this._items.keys()]; }

    /** 1-based queue position of a ticked entry, or 0 when it is not ticked. */
    position(key) {
        if (!this._positions) {
            this._positions = new Map();
            let n = 0;
            for (const k of this._items.keys()) this._positions.set(k, ++n);
        }
        return this._positions.get(key) ?? 0;
    }

    /** Tick or untick one entry. Returns true when its state changed. */
    set(item, on) {
        if (!item || item.key == null) return false;
        if (on) {
            if (this._items.has(item.key)) return false;
            this._items.set(item.key, item);
        } else if (!this._items.delete(item.key)) {
            return false;
        }
        this._positions = null;
        return true;
    }

    /** Flip one entry and make it the range anchor. Returns the new state. */
    toggle(item) {
        const on = !this.has(item.key);
        this.set(item, on);
        this.anchorKey = item.key;
        return on;
    }

    /** Tick or untick several entries, keeping the given order for new ticks. */
    setMany(items, on) {
        let changed = 0;
        for (const item of items) if (this.set(item, on)) changed++;
        return changed;
    }

    remove(key) {
        if (!this._items.delete(key)) return false;
        this._positions = null;
        if (this.anchorKey === key) this.anchorKey = null;
        return true;
    }

    clear() {
        this._items.clear();
        this._positions = null;
        this.anchorKey = null;
    }

    /** Replace the whole selection (used when a recent batch is re-ticked). */
    replace(items) {
        this.clear();
        this.setMany(items, true);
    }

    /**
     * Shift-click: apply the anchor row's state to every row between the anchor
     * and the target (inclusive), in list order. Without a usable anchor, or
     * when nothing is ticked at all (unticking a range would do nothing), it
     * behaves like a plain toggle of the target.
     */
    selectRange(visibleItems, targetKey) {
        const to = visibleItems.findIndex(it => it.key === targetKey);
        if (to < 0) return 0;
        const from = this.anchorKey == null
            ? -1
            : visibleItems.findIndex(it => it.key === this.anchorKey);
        if (from < 0 || this.size === 0) {
            this.toggle(visibleItems[to]);
            return 1;
        }
        const on = this.has(this.anchorKey);
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        // Walk away from the anchor so queue numbers follow the drag direction.
        const range = visibleItems.slice(lo, hi + 1);
        if (to < from) range.reverse();
        return this.setMany(range, on);
    }

    /** "all" | "some" | "none" for the select-all box over the visible rows. */
    coverage(visibleItems) {
        if (!visibleItems.length) return "none";
        let n = 0;
        for (const it of visibleItems) if (this.has(it.key)) n++;
        return n === 0 ? "none" : n === visibleItems.length ? "all" : "some";
    }
}
