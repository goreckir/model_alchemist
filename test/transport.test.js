const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../public/js/transport.js');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');

/** A stand-in for the webview: records what the UI posts, delivers the host's answers. */
function fakeWebview() {
    const listeners = [];
    const posted = [];
    return {
        posted,
        vscodeApi: { postMessage: msg => posted.push(msg) },
        windowRef: { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); } },
        answer: data => listeners.forEach(fn => fn({ data }))
    };
}

// ── Webview: API calls become messages ────────────────────────────────────────
test('webview: a POST is posted as a request message with the parsed body', () => {
    const wv = fakeWebview();
    const transport = T.createWebviewTransport(wv);
    transport.request('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devPath: 'a', prodPath: 'b' })
    });
    assert.deepStrictEqual(wv.posted, [{
        id: 1, type: 'request', method: 'POST', path: '/api/compare', query: {}, body: { devPath: 'a', prodPath: 'b' }
    }]);
});

test('webview: a GET carries its query string as an object', () => {
    const wv = fakeWebview();
    T.createWebviewTransport(wv).request(`/api/pick-file?target=dev&initialdir=${encodeURIComponent('C:\\Models\\My Model')}`);
    assert.strictEqual(wv.posted[0].method, 'GET');
    assert.strictEqual(wv.posted[0].path, '/api/pick-file');
    assert.deepStrictEqual(wv.posted[0].query, { target: 'dev', initialdir: 'C:\\Models\\My Model' });
    assert.strictEqual(wv.posted[0].body, undefined);
});

test('webview: the answer resolves to what app.js reads from a fetch Response', async () => {
    const wv = fakeWebview();
    const pending = T.createWebviewTransport(wv).request('/api/deploy', { method: 'POST', body: '{}' });
    wv.answer({ type: 'response', id: 1, status: 400, body: { error: 'No changes selected for deployment.' } });
    const response = await pending;
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.status, 400);
    assert.deepStrictEqual(await response.json(), { error: 'No changes selected for deployment.' });
});

test('webview: concurrent calls are matched to their own answers', async () => {
    const wv = fakeWebview();
    const transport = T.createWebviewTransport(wv);
    const first = transport.request('/api/fabric/status');
    const second = transport.request('/api/defaults');
    wv.answer({ type: 'response', id: 2, status: 200, body: { which: 'defaults' } });
    wv.answer({ type: 'response', id: 1, status: 200, body: { which: 'status' } });
    assert.deepStrictEqual(await (await first).json(), { which: 'status' });
    assert.deepStrictEqual(await (await second).json(), { which: 'defaults' });
    assert.strictEqual(transport.pendingCount(), 0);
});

test('webview: messages that are not answers to this UI are ignored', () => {
    const wv = fakeWebview();
    const transport = T.createWebviewTransport(wv);
    transport.request('/api/version');
    wv.answer(null);
    wv.answer({ type: 'response', id: 99, status: 200, body: {} });
    wv.answer({ type: 'something-else' });
    assert.strictEqual(transport.pendingCount(), 1);
});

test('webview: an export is posted as saveFile, not downloaded', async () => {
    const wv = fakeWebview();
    const saving = T.createWebviewTransport(wv).saveFile({ filename: 'Model_diff.csv', content: 'a,b', mimeType: 'text/csv', bom: true });
    assert.deepStrictEqual(wv.posted[0], { id: 1, type: 'saveFile', filename: 'Model_diff.csv', content: 'a,b', mimeType: 'text/csv', bom: true });
    wv.answer({ type: 'saveFileResult', id: 1, saved: true, path: '/out/Model_diff.csv' });
    assert.deepStrictEqual(await saving, { saved: true, path: '/out/Model_diff.csv', error: undefined });
});

// ── Browser: unchanged HTTP behaviour ─────────────────────────────────────────
test('browser: requests go to fetch with the session header added', async () => {
    const calls = [];
    const transport = T.createFetchTransport({
        sessionId: 'tab-1',
        fetchImpl: (url, options) => { calls.push({ url, options }); return Promise.resolve('response'); }
    });
    assert.strictEqual(await transport.request('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 'response');
    assert.deepStrictEqual(calls, [{
        url: '/api/compare',
        options: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-ma-session': 'tab-1' }, body: '{}' }
    }]);
});

test('the host is detected from acquireVsCodeApi, called once', () => {
    let acquired = 0;
    const webview = T.createTransport({
        sessionId: 's',
        globalRef: { acquireVsCodeApi: () => { acquired++; return { postMessage() {} }; }, addEventListener() {} }
    });
    assert.strictEqual(webview.kind, 'webview');
    assert.strictEqual(acquired, 1);

    const browser = T.createTransport({ sessionId: 's', globalRef: { fetch() {}, document: {} } });
    assert.strictEqual(browser.kind, 'http');
});

// ── index.html runs under a strict Content Security Policy ───────────────────
test('index.html has no inline event handlers or inline scripts', () => {
    assert.doesNotMatch(INDEX_HTML, /\son[a-z]+\s*=/i, 'no onclick="" and similar');
    assert.doesNotMatch(INDEX_HTML, /<script>(?!\s*<\/script>)/, 'no inline <script> blocks');
});

test('index.html loads transport.js before app.js', () => {
    const transportAt = INDEX_HTML.indexOf('js/transport.js');
    const appAt = INDEX_HTML.indexOf('js/app.js');
    assert.ok(transportAt > 0 && transportAt < appAt);
});
