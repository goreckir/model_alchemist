/**
 * TextDiff — lightweight text diffing for the property panel.
 *
 * Provides:
 *   TextDiff.inline(oldStr, newStr)  → { oldHtml, newHtml }
 *       Word-level diff of two single-line values. Changed fragments are wrapped
 *       in <span class="diff-inline-added"> / <span class="diff-inline-removed">.
 *   TextDiff.lineRows(oldStr, newStr) → { rows, changedCount }
 *       Line-level diff of two multiline values. Each row is
 *       { type: 'equal'|'add'|'del'|'mod', newHtml, oldHtml } where newHtml is
 *       the NEW (source/dev) side and oldHtml the OLD (target/prod) side;
 *       null means "no line on this side" (placeholder). 'mod' rows additionally
 *       carry word-level inline highlighting.
 *
 * No external dependencies. LCS with common prefix/suffix trimming and a size
 * guard (falls back to whole del+add when inputs are too large/dissimilar).
 */
(function (global) {
    'use strict';

    const MAX_LCS_CELLS = 1000000; // guard for the DP table (n*m)

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** Tokenize into words / whitespace runs / single punctuation chars. */
    function tokenize(str) {
        return String(str).match(/[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g) || [];
    }

    /**
     * LCS-based diff over two arrays of strings.
     * Returns merged ops: [{ type: 'equal'|'del'|'add', tokens: [...] }]
     * 'del' = present in a (old) only, 'add' = present in b (new) only.
     */
    function diffArrays(a, b) {
        // Trim common prefix
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        // Trim common suffix
        let endA = a.length, endB = b.length;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

        const midA = a.slice(start, endA);
        const midB = b.slice(start, endB);

        let midOps;
        if (midA.length === 0 && midB.length === 0) {
            midOps = [];
        } else if (midA.length === 0) {
            midOps = [{ type: 'add', tokens: midB }];
        } else if (midB.length === 0) {
            midOps = [{ type: 'del', tokens: midA }];
        } else if (midA.length * midB.length > MAX_LCS_CELLS) {
            // Too large — degrade gracefully to full replace
            midOps = [{ type: 'del', tokens: midA }, { type: 'add', tokens: midB }];
        } else {
            midOps = lcsOps(midA, midB);
        }

        const ops = [];
        if (start > 0) ops.push({ type: 'equal', tokens: a.slice(0, start) });
        ops.push(...midOps);
        if (endA < a.length) ops.push({ type: 'equal', tokens: a.slice(endA) });
        return mergeOps(ops);
    }

    /** Classic LCS dynamic programming + backtrack producing per-token ops. */
    function lcsOps(a, b) {
        const n = a.length, m = b.length;
        const w = m + 1;
        const dp = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i * w + j] = a[i] === b[j]
                    ? dp[(i + 1) * w + j + 1] + 1
                    : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
            }
        }
        const ops = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) {
                ops.push({ type: 'equal', tokens: [a[i]] });
                i++; j++;
            } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
                ops.push({ type: 'del', tokens: [a[i]] });
                i++;
            } else {
                ops.push({ type: 'add', tokens: [b[j]] });
                j++;
            }
        }
        while (i < n) ops.push({ type: 'del', tokens: [a[i++]] });
        while (j < m) ops.push({ type: 'add', tokens: [b[j++]] });
        return ops;
    }

    /** Merge consecutive ops of the same type. */
    function mergeOps(ops) {
        const merged = [];
        for (const op of ops) {
            const last = merged[merged.length - 1];
            if (last && last.type === op.type) {
                last.tokens.push(...op.tokens);
            } else {
                merged.push({ type: op.type, tokens: op.tokens.slice() });
            }
        }
        return merged;
    }

    /**
     * Word-level inline diff. old = target/prod value, new = source/dev value.
     * @returns {{ oldHtml: string, newHtml: string }}
     */
    function inline(oldStr, newStr) {
        const ops = diffArrays(tokenize(oldStr), tokenize(newStr));
        let oldHtml = '', newHtml = '';
        for (const op of ops) {
            const text = esc(op.tokens.join(''));
            if (op.type === 'equal') {
                oldHtml += text;
                newHtml += text;
            } else if (op.type === 'del') {
                oldHtml += `<span class="diff-inline-removed">${text}</span>`;
            } else {
                newHtml += `<span class="diff-inline-added">${text}</span>`;
            }
        }
        return { oldHtml, newHtml };
    }

    /**
     * Line-level diff producing aligned side-by-side rows.
     * Del/add hunks are paired line-by-line into 'mod' rows with inline
     * word-level highlighting (like GitHub / VS Code).
     * @returns {{ rows: Array<{type: string, newHtml: string|null, oldHtml: string|null}>, changedCount: number }}
     */
    function lineRows(oldStr, newStr) {
        const oldLines = String(oldStr).replace(/\r\n/g, '\n').split('\n');
        const newLines = String(newStr).replace(/\r\n/g, '\n').split('\n');
        const ops = diffArrays(oldLines, newLines);

        const rows = [];
        let pendingDel = [];
        let pendingAdd = [];

        const flush = () => {
            const k = Math.min(pendingDel.length, pendingAdd.length);
            for (let i = 0; i < k; i++) {
                // When the LCS size guard degrades to whole del+add, aligned pairs
                // are often identical lines — emit them as 'equal', not 'mod'.
                if (pendingDel[i] === pendingAdd[i]) {
                    const h = esc(pendingDel[i]);
                    rows.push({ type: 'equal', newHtml: h, oldHtml: h });
                    continue;
                }
                const r = inline(pendingDel[i], pendingAdd[i]);
                rows.push({ type: 'mod', newHtml: r.newHtml, oldHtml: r.oldHtml });
            }
            for (let i = k; i < pendingDel.length; i++) {
                rows.push({ type: 'del', newHtml: null, oldHtml: esc(pendingDel[i]) });
            }
            for (let i = k; i < pendingAdd.length; i++) {
                rows.push({ type: 'add', newHtml: esc(pendingAdd[i]), oldHtml: null });
            }
            pendingDel = [];
            pendingAdd = [];
        };

        for (const op of ops) {
            if (op.type === 'equal') {
                flush();
                for (const line of op.tokens) {
                    const h = esc(line);
                    rows.push({ type: 'equal', newHtml: h, oldHtml: h });
                }
            } else if (op.type === 'del') {
                pendingDel.push(...op.tokens);
            } else {
                pendingAdd.push(...op.tokens);
            }
        }
        flush();

        const changedCount = rows.reduce((n, r) => n + (r.type !== 'equal' ? 1 : 0), 0);
        return { rows, changedCount };
    }

    global.TextDiff = { inline, lineRows };
})(window);
