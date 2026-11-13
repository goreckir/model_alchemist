const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { refusalReason } = require('../lib/local-requests');
const { app } = require('../server');

const allowed = (headers, options) => refusalReason(headers, options) === null;

test('local requests: the app\'s own page and header-less clients are allowed', () => {
    assert.ok(allowed({ host: 'localhost:3001' }));
    assert.ok(allowed({ host: '127.0.0.1:3001' }));
    assert.ok(allowed({ host: '[::1]:3001' }));
    assert.ok(allowed({ host: 'localhost:3001', origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin' }));
    assert.ok(allowed({ host: 'localhost:3001', 'sec-fetch-site': 'none' }));
});

test('local requests: a foreign Host is refused (DNS rebinding)', () => {
    assert.ok(!allowed({ host: 'evil.example:3001' }));
    assert.ok(!allowed({ host: 'localhost.evil.example:3001' }));
    assert.ok(!allowed({}));
});

test('local requests: a request from another site is refused', () => {
    assert.ok(!allowed({ host: 'localhost:3001', origin: 'https://evil.example' }));
    assert.ok(!allowed({ host: 'localhost:3001', origin: 'null' }));
    // Another program's page on this computer is another origin too.
    assert.ok(!allowed({ host: 'localhost:3001', origin: 'http://localhost:5173' }));
    assert.ok(!allowed({ host: 'localhost:3001', 'sec-fetch-site': 'cross-site' }));
    assert.ok(!allowed({ host: 'localhost:3001', 'sec-fetch-site': 'same-site' }));
});

test('local requests: HOST widens the Host check but never the Origin check', () => {
    assert.ok(allowed({ host: '192.168.1.20:3001' }, { bindHost: '192.168.1.20' }));
    assert.ok(!allowed({ host: '192.168.1.21:3001' }, { bindHost: '192.168.1.20' }));
    assert.ok(allowed({ host: 'my-pc.lan:3001' }, { bindHost: '0.0.0.0' }));
    assert.ok(!allowed({ host: 'my-pc.lan:3001', origin: 'https://evil.example' }, { bindHost: '0.0.0.0' }));
});

test('local requests: the server answers 403 on /api and still serves the page', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const { port } = server.address();
    const get = (path, headers) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    try {
        assert.strictEqual(await get('/api/fabric/status', {}), 200);
        assert.strictEqual(await get('/api/fabric/status', { Origin: 'https://evil.example' }), 403);
        assert.strictEqual(await get('/api/fabric/status', { Host: 'evil.example' }), 403);
        // A link to the app from another site is a cross-site navigation; the page itself is harmless.
        assert.strictEqual(await get('/', { 'Sec-Fetch-Site': 'cross-site' }), 200);
    } finally {
        server.close();
    }
});
