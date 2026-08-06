const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const sessionStore = require('../lib/session-store');
const { compareRawFiles } = require('../lib/raw-files');

// ── #64: PORT from env is a string ────────────────────────────────────────────
test('#64 the port fallback increments numerically, not by concatenation', () => {
    // The bug: process.env.PORT is a string, so port + 1 gave '3001' + 1 = '30011'.
    const asShipped = parseInt('3001', 10) || 3001;
    assert.strictEqual(asShipped + 1, 3002);
    assert.notStrictEqual(asShipped + 1, '30011');
});

test('#64 the server binds a free port and reports it', async () => {
    // Occupy the preferred port so the fallback path is exercised end to end.
    const blocker = http.createServer((_, res) => res.end('busy'));
    await new Promise(resolve => blocker.listen(3401, resolve));

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: '3401' },
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    const bound = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server never reported a port:\n${output}`)), 12000);
        const onData = data => {
            output += data.toString();
            const match = output.match(/running at http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve(parseInt(match[1], 10)); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
    }).finally(() => { child.kill(); blocker.close(); });

    assert.strictEqual(bound, 3402, `expected the next port, got ${bound}`);
});

// ── #75: module-global state shared by every tab ──────────────────────────────
test('#75 two sessions keep independent comparison state', () => {
    sessionStore.clearAll();
    const tabA = sessionStore.getState('tab-a');
    const tabB = sessionStore.getState('tab-b');

    tabA.lastProdPath = '/models/project-x';
    tabB.lastProdPath = '/models/project-y';

    assert.strictEqual(sessionStore.getState('tab-a').lastProdPath, '/models/project-x');
    assert.strictEqual(sessionStore.getState('tab-b').lastProdPath, '/models/project-y');
});

test('#75 the session id comes from the header, then the query, then default', () => {
    const req = headers => ({ get: name => headers[name] || null, query: {} });
    assert.strictEqual(sessionStore.sessionIdOf(req({ 'x-ma-session': 'abc' })), 'abc');
    assert.strictEqual(sessionStore.sessionIdOf({ get: () => null, query: { session: 'from-query' } }), 'from-query');
    assert.strictEqual(sessionStore.sessionIdOf({ get: () => null, query: {} }), 'default');
});

test('#75 old sessions are evicted so the map cannot grow without bound', () => {
    sessionStore.clearAll();
    for (let i = 0; i < sessionStore.MAX_SESSIONS + 15; i++) {
        sessionStore.getState(`tab-${i}`);
    }
    assert.ok(sessionStore.sessionCount() <= sessionStore.MAX_SESSIONS,
        `expected at most ${sessionStore.MAX_SESSIONS}, got ${sessionStore.sessionCount()}`);
});

// ── #22: /api/compare left stale Fabric state behind ──────────────────────────
test('#22 resetComparison clears every field, not just three', () => {
    const state = sessionStore.getState('reset-test');
    Object.assign(state, {
        lastComparison: { diffs: [] },
        lastDevModel: {},
        lastProdPath: '/old/path',
        lastProdModel: {},
        lastProdFabricInfo: { workspaceId: 'W1', semanticModelId: 'M1' }
    });

    sessionStore.resetComparison(state);
    assert.strictEqual(state.lastComparison, null);
    assert.strictEqual(state.lastDevModel, null);
    assert.strictEqual(state.lastProdPath, null);
    assert.strictEqual(state.lastProdModel, null);
    assert.strictEqual(state.lastProdFabricInfo, null, 'the Fabric target is disarmed');
    sessionStore.clearAll();
});

// ── #71: Fabric deploy uploaded a stale full-definition snapshot ──────────────
test('#71 compareRawFiles detects every kind of drift', () => {
    const atCompareTime = {
        'model.tmdl': 'model Model\n\tculture: en-US\n',
        'tables/Sales.tmdl': 'table Sales\n',
        'tables/Old.tmdl': 'table Old\n'
    };
    const rightNow = {
        'model.tmdl': 'model Model\n\tculture: en-US\n',
        'tables/Sales.tmdl': 'table Sales\n\n\tmeasure New = 1\n', // someone else edited it
        'tables/Fresh.tmdl': 'table Fresh\n'                        // someone else added it
    };

    const drift = compareRawFiles(atCompareTime, rightNow);
    assert.deepStrictEqual(drift, [
        { file: 'tables/Fresh.tmdl', change: 'added' },
        { file: 'tables/Old.tmdl', change: 'removed' },
        { file: 'tables/Sales.tmdl', change: 'modified' }
    ]);
});

test('#71 an untouched model reports no drift', () => {
    const files = { 'model.tmdl': 'model Model\n\tculture: en-US\n' };
    assert.deepStrictEqual(compareRawFiles(files, { ...files }), []);
});

test('#71 line-ending differences alone are not drift', () => {
    const before = { 'model.tmdl': 'model Model\r\n\tculture: en-US\r\n' };
    const after = { 'model.tmdl': 'model Model\n\tculture: en-US' };
    assert.deepStrictEqual(compareRawFiles(before, after), []);
});
