/**
 * Pure UI logic — no DOM, no fetch.
 *
 * Everything here is exercised by the test suite and consumed by app.js through
 * the `MAPure` global. Keeping filtering, group indexing, escaping and export
 * formatting out of the DOM code is what makes those defects testable at all.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MAPure = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TYPE_BY_FILTER = { Added: 0, Removed: 1, Modified: 2 };

    /**
     * Filter the diff list exactly the way the UI renders it.
     *
     * Search applies from the FIRST character. The old code only re-rendered at
     * length >= 2 or 0, so at one character the list still showed the previous
     * two-character result set while the box displayed a different query — and
     * "Select All Visible" then selected that stale subset.
     */
    function filterDiffs(diffs, { activeGroup = null, activeFilter = 'all', searchTerm = '' } = {}) {
        let out = diffs || [];
        if (activeGroup !== null && activeGroup !== undefined) {
            out = out.filter(d => d.changeGroup === activeGroup);
        }
        if (activeFilter && activeFilter !== 'all') {
            const type = TYPE_BY_FILTER[activeFilter];
            out = out.filter(d => d.type === type);
        }
        const term = String(searchTerm || '').trim().toLowerCase();
        if (term.length >= 1) {
            out = out.filter(d => String(d.displayName || '').toLowerCase().includes(term));
        }
        return out;
    }

    /**
     * Index groups by member key.
     *
     * Membership used to be tested with `group.memberKeys.includes(key)` inside a
     * per-group `filter`, an O(diffs x members) string scan re-run on every
     * keystroke. A Map of Sets makes it O(1) per lookup.
     *
     * @returns {{ byKey: Map<string, object>, memberSets: Map<string, Set<string>> }}
     */
    function buildGroupIndex(groups) {
        const byKey = new Map();
        const memberSets = new Map();
        for (const group of groups || []) {
            const set = new Set(group.memberKeys || []);
            memberSets.set(group.groupId, set);
            for (const key of set) {
                // Groups are disjoint by construction; first writer wins if not.
                if (!byKey.has(key)) byKey.set(key, group);
            }
        }
        return { byKey, memberSets };
    }

    /**
     * Split visible diffs into the groups that should render, plus the ungrouped
     * remainder. Every diff appears exactly once across the result.
     */
    function partitionByGroup(visibleDiffs, groups, index) {
        const { byKey } = index || buildGroupIndex(groups);
        const groupBuckets = new Map();
        const remaining = [];
        const claimed = new Set();

        for (const diff of visibleDiffs) {
            const group = byKey.get(diff.identityKey);
            if (!group || claimed.has(diff.identityKey)) {
                if (!claimed.has(diff.identityKey)) { remaining.push(diff); claimed.add(diff.identityKey); }
                continue;
            }
            claimed.add(diff.identityKey);
            if (!groupBuckets.has(group.groupId)) groupBuckets.set(group.groupId, { group, diffs: [] });
            groupBuckets.get(group.groupId).diffs.push(diff);
        }

        return { groups: [...groupBuckets.values()], remaining };
    }

    /**
     * How many members of a group the current filter hides.
     * An atomic group always deploys in full, so the UI must say when the user is
     * only looking at part of it.
     */
    function hiddenMemberCount(group, visibleKeys) {
        let hidden = 0;
        for (const key of group.memberKeys || []) {
            if (!visibleKeys.has(key)) hidden++;
        }
        return hidden;
    }

    /** HTML-escape text content. */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Escape a value for use inside a double-quoted HTML attribute.
     *
     * The textContent/innerHTML round-trip used before escaped & < > but NOT the
     * double quote, so a name like `Sales "Net"` truncated the attribute and
     * Expand All rendered an empty details panel.
     */
    function escapeAttr(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Escape a value for a Markdown table cell.
     *
     * Only `|` was escaped before. Multi-line values (annotations, refreshPolicy,
     * variations, formatStringDefinition, KPI expressions) terminated the row
     * mid-cell and the rest of the table turned into loose text.
     */
    function markdownCell(value) {
        if (value === null || value === undefined) return '—';
        return String(value)
            .replace(/\\/g, '\\\\')
            .replace(/\|/g, '\\|')
            .replace(/\r\n/g, '\n')
            .replace(/\n/g, '<br>');
    }

    /** Map a Power BI refresh status onto the UI's state machine. */
    function mapRefreshStatus(status) {
        const s = String(status || '').toLowerCase();
        if (s === 'completed') return 'completed';
        if (s === 'failed' || s === 'timedout') return 'failed';
        if (s === 'cancelled' || s === 'disabled') return 'cancelled';
        return 'inProgress';
    }

    return {
        filterDiffs,
        buildGroupIndex,
        partitionByGroup,
        hiddenMemberCount,
        escapeHtml,
        escapeAttr,
        markdownCell,
        mapRefreshStatus
    };
});
