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

    /** Object-requiring-attention action → API refresh type, for merging into the refresh offer. */
    const READINESS_ACTION_TO_REFRESH_TYPE = { refresh: 'dataOnly', recalculate: 'calculate' };
    /** Matches the escalation order used by server.js detectTablesNeedingRefresh(): full > dataOnly > calculate > automatic. */
    const REFRESH_TYPE_STRENGTH = { automatic: 0, calculate: 1, dataOnly: 2, full: 3 };

    /**
     * Union the diff-based tablesNeedingRefresh recommendation with objects
     * observed post-deployment to actually require refresh/recalculation.
     * Returns null when neither source has anything to report.
     */
    function mergeRefreshInfoWithReadiness(tablesNeedingRefresh, targetReadiness) {
        const base = tablesNeedingRefresh || { refreshType: 'automatic', tables: [], isFullModel: false };
        const tableMap = new Map();
        for (const t of (base.tables || [])) {
            tableMap.set(t.table, { table: t.table, refreshType: t.refreshType, reasons: [...(t.reasons || [])] });
        }

        if (targetReadiness && targetReadiness.availability === 'available') {
            for (const obj of (targetReadiness.objectsRequiringAttention || [])) {
                const refreshType = READINESS_ACTION_TO_REFRESH_TYPE[obj.action];
                if (!refreshType) continue; // 'repair'/'inspect' objects are not auto-refreshable
                const reason = `observed state: ${obj.state}`;
                const existing = tableMap.get(obj.table);
                if (!existing) {
                    tableMap.set(obj.table, { table: obj.table, refreshType, reasons: [reason] });
                } else if (!existing.reasons.includes(reason)) {
                    existing.reasons.push(reason);
                    if ((REFRESH_TYPE_STRENGTH[refreshType] || 0) > (REFRESH_TYPE_STRENGTH[existing.refreshType] || 0)) {
                        existing.refreshType = refreshType;
                    }
                }
            }
        }

        const tables = Array.from(tableMap.values());
        if (tables.length === 0 && !base.isFullModel) return null;
        return { refreshType: base.refreshType || 'automatic', tables, isFullModel: base.isFullModel || false };
    }

    /**
     * Build a single { refreshType, tables, isFullModel } refresh request covering
     * several readiness objects at once (Refresh all / Refresh selected), escalating
     * to the strongest required refreshType the same way mergeRefreshInfoWithReadiness does.
     * @param {{table: string, action: string, state: string}[]} objects
     */
    function buildBulkRefreshInfo(objects) {
        const tableMap = new Map();
        for (const obj of (objects || [])) {
            const refreshType = READINESS_ACTION_TO_REFRESH_TYPE[obj.action];
            if (!refreshType) continue;
            const reason = `observed state: ${obj.state}`;
            const existing = tableMap.get(obj.table);
            if (!existing) {
                tableMap.set(obj.table, { table: obj.table, refreshType, reasons: [reason] });
            } else {
                if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
                if ((REFRESH_TYPE_STRENGTH[refreshType] || 0) > (REFRESH_TYPE_STRENGTH[existing.refreshType] || 0)) {
                    existing.refreshType = refreshType;
                }
            }
        }
        const tables = Array.from(tableMap.values());
        if (tables.length === 0) return null;
        const refreshType = tables.reduce((strongest, t) =>
            (REFRESH_TYPE_STRENGTH[t.refreshType] || 0) > (REFRESH_TYPE_STRENGTH[strongest] || 0) ? t.refreshType : strongest,
            'automatic');
        return { refreshType, tables, isFullModel: false };
    }

    /** Render the "Target processing state" section shown before the refresh offer (and, with actionable:true, in the Model Refresh panel). */
    function renderTargetReadiness(targetReadiness, options = {}) {
        const actionable = options.actionable === true;
        const selectedIndices = options.selectedIndices || new Set();
        if (targetReadiness.availability === 'unavailable') {
            return `<div style="margin-top: 16px; padding: 12px 16px; background: rgba(240, 180, 40, 0.08); border: 1px solid rgba(240, 180, 40, 0.35); border-radius: 8px;">` +
                `<p style="font-weight: 600; margin-bottom: 4px;">⚠ Target processing state unknown</p>` +
                `<p style="font-size: 12px; opacity: 0.85;">${actionable ? 'Model Alchemist could not inspect the target processing state.' : 'Deployment succeeded, but Model Alchemist could not inspect the target processing state.'}${targetReadiness.message ? ' ' + escapeHtml(targetReadiness.message) : ''}</p>` +
                `</div>`;
        }

        const objects = targetReadiness.objectsRequiringAttention || [];
        if (objects.length === 0) {
            return `<div style="margin-top: 16px; padding: 12px 16px; background: rgba(60, 180, 100, 0.08); border: 1px solid rgba(60, 180, 100, 0.3); border-radius: 8px;">` +
                `<p style="font-weight: 600; margin: 0;">✓ Target processing state checked: no objects require refresh or recalculation.</p>` +
                `</div>`;
        }

        const actionLabels = { refresh: 'Refresh data', recalculate: 'Recalculate', repair: 'Repair dependency', inspect: 'Inspect expression' };
        const refreshableIndices = objects
            .map((obj, i) => (READINESS_ACTION_TO_REFRESH_TYPE[obj.action] ? i : -1))
            .filter(i => i !== -1);
        let html = `<div style="margin-top: 16px; padding: 12px 16px; background: rgba(240, 90, 40, 0.08); border: 1px solid rgba(240, 90, 40, 0.3); border-radius: 8px;">`;
        html += `<p style="font-weight: 600; margin-bottom: 8px;">⚠ Target processing state: ${objects.length} object(s) require attention</p>`;

        if (actionable && refreshableIndices.length > 0) {
            const selectedCount = refreshableIndices.filter(i => selectedIndices.has(i)).length;
            const allSelected = selectedCount === refreshableIndices.length;
            html += `<div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">` +
                `<label style="font-size: 11px; display:flex; align-items:center; gap:4px; cursor:pointer;">` +
                `<input type="checkbox" id="readiness-select-all" ${allSelected ? 'checked' : ''}/> Select all</label>` +
                `<button id="btn-readiness-refresh-bulk" class="btn btn-secondary" style="padding:2px 10px; font-size:11px;">` +
                `↻ ${selectedCount > 0 ? `Refresh selected (${selectedCount})` : `Refresh all (${refreshableIndices.length})`}</button>` +
                `</div>`;
        }

        html += `<table class="refresh-objects-table" style="margin-bottom: 4px;">`;
        html += `<thead><tr>${actionable ? '<th></th>' : ''}<th>Object</th><th>Type</th><th>State</th><th>Required action</th>${actionable ? '<th></th>' : ''}</tr></thead><tbody>`;
        objects.forEach((obj, i) => {
            const label = actionLabels[obj.action] || obj.action;
            const refreshType = READINESS_ACTION_TO_REFRESH_TYPE[obj.action];
            html += `<tr>`;
            if (actionable) {
                html += `<td>${refreshType ? `<input type="checkbox" class="readiness-row-checkbox" data-idx="${i}" ${selectedIndices.has(i) ? 'checked' : ''}/>` : ''}</td>`;
            }
            html += `<td><code>${escapeHtml(obj.table)} / ${escapeHtml(obj.name || '')}</code></td>` +
                `<td>${escapeHtml(obj.objectType || '')}</td>` +
                `<td>${escapeHtml(obj.state || '')}</td>` +
                `<td>${escapeHtml(label)}${obj.errorMessage ? `<br><span style="font-size: 11px; opacity: 0.75;">${escapeHtml(obj.errorMessage)}</span>` : ''}</td>`;
            if (actionable) {
                html += `<td>${refreshType ? `<button class="btn btn-secondary btn-readiness-refresh" data-table="${escapeAttr(obj.table)}" data-action="${escapeAttr(obj.action)}" data-state="${escapeAttr(obj.state || '')}" style="padding:2px 8px; font-size:11px; white-space:nowrap;">↻ ${escapeHtml(label)}</button>` : '—'}</td>`;
            }
            html += `</tr>`;
        });
        html += `</tbody></table></div>`;
        return html;
    }

    return {
        filterDiffs,
        buildGroupIndex,
        partitionByGroup,
        hiddenMemberCount,
        escapeHtml,
        escapeAttr,
        markdownCell,
        mapRefreshStatus,
        READINESS_ACTION_TO_REFRESH_TYPE,
        REFRESH_TYPE_STRENGTH,
        mergeRefreshInfoWithReadiness,
        buildBulkRefreshInfo,
        renderTargetReadiness
    };
});
