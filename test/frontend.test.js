const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Pure = require('../public/js/pure.js');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf-8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

const diff = (key, name, type = 2, changeGroup = 'Measures') =>
    ({ identityKey: key, displayName: name, type, changeGroup });

// ── #70: search at exactly one character kept the previous result set ─────────
test('#70 filtering applies from the first character', () => {
    const diffs = [diff('m1', 'Alpha'), diff('m2', 'Ab'), diff('m3', 'Zulu')];

    assert.deepStrictEqual(
        Pure.filterDiffs(diffs, { searchTerm: 'ab' }).map(d => d.displayName),
        ['Ab']
    );
    // One character must narrow to everything containing "a", not keep the "ab" set.
    assert.deepStrictEqual(
        Pure.filterDiffs(diffs, { searchTerm: 'a' }).map(d => d.displayName),
        ['Alpha', 'Ab']
    );
    assert.strictEqual(Pure.filterDiffs(diffs, { searchTerm: '' }).length, 3);
});

test('#70 the search box re-renders on every keystroke', () => {
    assert.ok(
        !/searchTerm\.length >= 2/.test(APP_JS),
        'the two-character render threshold is gone'
    );
});

test('#70 group and type filters still compose with search', () => {
    const diffs = [
        diff('m1', 'Alpha', 0, 'Measures'),
        diff('m2', 'Alpha Two', 2, 'Measures'),
        diff('t1', 'Alpha Table', 0, 'Tables & Relationships')
    ];
    const out = Pure.filterDiffs(diffs, { activeGroup: 'Measures', activeFilter: 'Added', searchTerm: 'alpha' });
    assert.deepStrictEqual(out.map(d => d.identityKey), ['m1']);
});

// ── #27: Select All Visible selected the previous view when the list was empty ─
test('#27 lastVisibleDiffs is assigned before the empty-state early return', () => {
    const renderStart = APP_JS.indexOf('function renderDiffs()');
    const assignment = APP_JS.indexOf('lastVisibleDiffs = diffs', renderStart);
    const earlyReturn = APP_JS.indexOf('No differences found for the selected filter', renderStart);
    assert.ok(assignment > -1 && earlyReturn > -1, 'both landmarks exist');
    assert.ok(assignment < earlyReturn, 'the assignment happens first');
});

// ── #28 / #46: group membership must be one place and one bucket ──────────────
test('#46 partitionByGroup places each diff in exactly one bucket', () => {
    const diffs = [diff('expr:Load', 'LoadData'), diff('t:A', 'TableA'), diff('t:B', 'TableB')];
    // The pathological input: one key claimed by two groups.
    const groups = [
        { groupId: 'refresh:TableA', memberKeys: ['expr:Load', 't:A'] },
        { groupId: 'refresh:TableB', memberKeys: ['expr:Load', 't:B'] }
    ];

    const index = Pure.buildGroupIndex(groups);
    const { groups: buckets, remaining } = Pure.partitionByGroup(diffs, groups, index);

    const seen = new Set();
    for (const bucket of buckets) {
        for (const d of bucket.diffs) {
            assert.ok(!seen.has(d.identityKey), `${d.identityKey} rendered twice`);
            seen.add(d.identityKey);
        }
    }
    for (const d of remaining) {
        assert.ok(!seen.has(d.identityKey), `${d.identityKey} rendered twice`);
        seen.add(d.identityKey);
    }
    assert.strictEqual(seen.size, diffs.length, 'every diff is rendered exactly once');
});

test('#28 hiddenMemberCount reports members the filter hides', () => {
    const group = { groupId: 'g1', memberKeys: ['a', 'b', 'c'] };
    assert.strictEqual(Pure.hiddenMemberCount(group, new Set(['a'])), 2);
    assert.strictEqual(Pure.hiddenMemberCount(group, new Set(['a', 'b', 'c'])), 0);
});

test('#28 one code path selects a group, used by both the header and members', () => {
    assert.match(APP_JS, /function setGroupSelection\(/, 'the shared helper exists');
    const headerUse = /checkbox\.addEventListener\('click', \(e\) => \{\s*e\.stopPropagation\(\);\s*setGroupSelection\(group, checkbox\.checked, container\);/;
    assert.match(APP_JS, headerUse, 'the group header goes through it');
    assert.match(APP_JS, /setGroupSelection\(parentGroup, checkbox\.checked, container\.closest\('\.diff-group'\)\)/,
        'a member checkbox goes through it too');
});

test('#28 group selection state is computed from ALL members, not the visible ones', () => {
    assert.match(APP_JS, /const memberKeys = group\.memberKeys \|\| \[\];/);
    assert.match(APP_JS, /allSelected = memberKeys\.length > 0 && memberKeys\.every\(k => selectedKeys\.has\(k\)\)/);
});

// ── #45: errors rendered inside the hidden connection panel ───────────────────
test('#45 the error banner lives outside the connection panel', () => {
    const bannerAt = INDEX_HTML.indexOf('id="error-message"');
    const panelAt = INDEX_HTML.indexOf('id="connection-panel"');
    assert.ok(bannerAt > -1 && panelAt > -1, 'both elements exist');
    assert.ok(bannerAt < panelAt, 'the banner is declared before (outside) the panel');
});

test('#45 exactly one error-message element exists', () => {
    const count = INDEX_HTML.split('id="error-message"').length - 1;
    assert.strictEqual(count, 1);
});

// ── #67: data-key attribute was not quote-escaped ─────────────────────────────
test('#67 escapeAttr escapes double quotes', () => {
    assert.strictEqual(Pure.escapeAttr('Sales "Net"'), 'Sales &quot;Net&quot;');
    assert.strictEqual(Pure.escapeAttr("O'Brien"), 'O&#39;Brien');
    assert.strictEqual(Pure.escapeAttr('a & b < c'), 'a &amp; b &lt; c');
    assert.strictEqual(Pure.escapeAttr(null), '');
});

test('#67 a quoted name round-trips through a double-quoted attribute', () => {
    const key = 'measure:sales.Sales "Net"';
    const html = `<input data-key="${Pure.escapeAttr(key)}" />`;
    const extracted = html.match(/data-key="([^"]*)"/)[1];
    // Un-escape and confirm nothing was truncated at the first quote.
    const decoded = extracted
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    assert.strictEqual(decoded, key);
});

test('#67 the data-key attribute uses escapeAttr', () => {
    assert.match(APP_JS, /data-key="\$\{escapeAttr\(diff\.identityKey\)\}"/);
});

// ── #47: markdown export corrupted on multiline values and pipes ──────────────
test('#47 markdownCell neutralises newlines and pipes', () => {
    assert.strictEqual(Pure.markdownCell('a\nb'), 'a<br>b');
    assert.strictEqual(Pure.markdownCell('a\r\nb'), 'a<br>b');
    assert.strictEqual(Pure.markdownCell('Margin|Net'), 'Margin\\|Net');
    assert.strictEqual(Pure.markdownCell(null), '—');
    assert.strictEqual(Pure.markdownCell('back\\slash'), 'back\\\\slash');
});

test('#47 a multiline annotation stays inside one table row', () => {
    const value = 'annotation A = 1\nannotation B = 2';
    const row = `| annotations | ${Pure.markdownCell(value)} | ${Pure.markdownCell(null)} |`;
    assert.strictEqual(row.split('\n').length, 1, 'the row is a single line');
    assert.strictEqual(row.split('|').length - 1, 4, 'the row still has four pipes');
});

// ── #68: deploy preview ignored response.ok ───────────────────────────────────
test('#68 API responses are checked before being rendered', () => {
    assert.match(APP_JS, /async function apiJson\(response, fallbackMessage\)/);
    assert.match(APP_JS, /if \(!response\.ok\)/);
    assert.match(APP_JS, /const preview = await apiJson\(response, 'Preview failed'\)/);
    assert.match(APP_JS, /const result = await apiJson\(response, 'Deployment failed'\)/);
    assert.ok(
        !/const preview = await response\.json\(\)/.test(APP_JS),
        'the unchecked preview parse is gone'
    );
});

test('#68 a failed preview disables the confirm button', () => {
    assert.match(APP_JS, /Could not build the deployment preview/);
    assert.match(APP_JS, /btnConfirmDeploy\.disabled = true;/);
});

// ── #69: a second refresh abandoned polling of the first ──────────────────────
test('#69 each refresh gets its own poller', () => {
    assert.match(APP_JS, /const refreshPollers = new Map\(\)/);
    assert.match(APP_JS, /function stopRefreshPolling\(requestId\)/);
    assert.ok(!/refreshPollTimer/.test(APP_JS), 'the single global timer is gone');
    assert.match(APP_JS, /stopRefreshPolling\(requestId\);/, 'only the finished request stops polling');
});

// ── #75: the client must identify its tab ─────────────────────────────────────
test('#75 every API call carries the session header', () => {
    assert.match(APP_JS, /'x-ma-session': SESSION_ID/);
    assert.match(APP_JS, /sessionStorage\.getItem\('ma_sessionId'\)/);
    const codeLines = APP_JS.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const rawFetches = codeLines.join('\n').match(/(?<![.\w])fetch\(/g) || [];
    assert.strictEqual(rawFetches.length, 1, 'the only raw fetch is the one inside apiFetch');
});

// ── #76: quadratic re-render on every keystroke ───────────────────────────────
test('#76 group membership uses O(1) lookups, not includes() scans', () => {
    assert.ok(
        !/group\.memberKeys\.includes\(d\.identityKey\)/.test(APP_JS),
        'the per-group includes() scan is gone'
    );
    assert.match(APP_JS, /groupIndex = Pure\.buildGroupIndex/, 'the index is built once per comparison');
    assert.match(APP_JS, /searchDebounce = setTimeout\(renderDiffs, 120\)/, 'keystrokes are debounced');
});

test('#76 buildGroupIndex maps every member key to its group', () => {
    const groups = [
        { groupId: 'g1', memberKeys: ['a', 'b'] },
        { groupId: 'g2', memberKeys: ['c'] }
    ];
    const index = Pure.buildGroupIndex(groups);
    assert.strictEqual(index.byKey.get('a').groupId, 'g1');
    assert.strictEqual(index.byKey.get('b').groupId, 'g1');
    assert.strictEqual(index.byKey.get('c').groupId, 'g2');
    assert.strictEqual(index.byKey.get('missing'), undefined);
});

test('#76 lookups stay constant-time as the model grows', () => {
    const groups = [];
    for (let g = 0; g < 200; g++) {
        groups.push({ groupId: `g${g}`, memberKeys: Array.from({ length: 50 }, (_, i) => `k${g}-${i}`) });
    }
    const index = Pure.buildGroupIndex(groups);
    assert.strictEqual(index.byKey.size, 200 * 50);
    assert.strictEqual(index.byKey.get('k199-49').groupId, 'g199');
});

// ── pure helper sanity ────────────────────────────────────────────────────────
test('mapRefreshStatus treats TimedOut as failed', () => {
    assert.strictEqual(Pure.mapRefreshStatus('TimedOut'), 'failed');
    assert.strictEqual(Pure.mapRefreshStatus('Completed'), 'completed');
    assert.strictEqual(Pure.mapRefreshStatus('Cancelling'), 'inProgress');
    assert.strictEqual(Pure.mapRefreshStatus(undefined), 'inProgress');
});

test('every element id app.js binds exists in index.html', () => {
    const ids = new Set();
    for (const match of APP_JS.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(match[1]);
    assert.ok(ids.size > 20, `expected many ids, found ${ids.size}`);

    // An id is fine if the page declares it, or if app.js itself creates the
    // element (deploy animation overlay, the refresh offer inside the result modal).
    const createdInJs = id => APP_JS.includes(`id="${id}"`) || APP_JS.includes(`overlay.id = '${id}'`);
    const missing = [...ids].filter(id => !INDEX_HTML.includes(`id="${id}"`) && !createdInJs(id));
    assert.deepStrictEqual(missing, [], `ids referenced by app.js but absent from index.html: ${missing.join(', ')}`);
});

test('index.html loads pure.js before app.js', () => {
    const pureAt = INDEX_HTML.indexOf('js/pure.js');
    const appAt = INDEX_HTML.indexOf('js/app.js');
    assert.ok(pureAt > -1, 'pure.js is included');
    assert.ok(pureAt < appAt, 'pure.js loads first');
});

test('pure.js loads in a browser-like global and exports the same API', () => {
    const vm = require('node:vm');
    const sandbox = { self: {}, module: undefined };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pure.js'), 'utf-8'), sandbox);
    assert.ok(sandbox.MAPure, 'the MAPure global is defined for the browser');
    assert.deepStrictEqual(Object.keys(sandbox.MAPure).sort(), Object.keys(Pure).sort());
});
