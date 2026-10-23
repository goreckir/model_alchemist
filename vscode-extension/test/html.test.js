const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildWebviewHtml, makeNonce } = require('../src/html');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');
const html = buildWebviewHtml(INDEX_HTML, {
    cspSource: 'https://webview.test',
    nonce: 'N0NCE',
    asWebviewUri: rel => `https://webview.test/public/${rel}`
});

test('every local script, stylesheet and icon points at a webview URI', () => {
    for (const ref of ['js/pure.js', 'js/transport.js', 'js/diff.js', 'js/app.js', 'css/style.css', 'favicon.png']) {
        assert.ok(html.includes(`"https://webview.test/public/${ref}"`), ref);
    }
    assert.doesNotMatch(html, /(src|href)="(css|js)\//, 'no relative reference is left');
});

test('every script carries the nonce, and the CSP allows only those', () => {
    const scripts = html.match(/<script\b[^>]*>/g);
    assert.ok(scripts.length >= 4);
    for (const tag of scripts) assert.match(tag, /nonce="N0NCE"/);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-N0NCE'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    assert.doesNotMatch(csp, /connect-src/, 'the page makes no network calls');
});

test('nonces are long and differ per page', () => {
    const a = makeNonce();
    assert.strictEqual(a.length, 32);
    assert.notStrictEqual(a, makeNonce());
});
