const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRouter, modelFolderOf, isInside } = require('../src/router');
const { createService } = require('../../core/service');
const { ROUTES, matchRoute } = require('../../core/routes');
const sessionStore = require('../../lib/session-store');
const activityLog = require('../../lib/activity-log');
const unavailableAuth = require('../src/auth-unavailable');

const ROOT = path.join(__dirname, '..', '..');
const DEV = path.join(ROOT, 'demo', 'dev', 'Apothecary.SemanticModel');
const PROD = path.join(ROOT, 'demo', 'prod', 'Apothecary.SemanticModel');

/** A host that records its calls and answers as told. */
function fakeHost(overrides = {}) {
    const calls = [];
    const host = {
        calls,
        onReady: () => calls.push(['ready']),
        pickFolder: async args => { calls.push(['pickFolder', args]); return { cancelled: false, filePath: '/picked/X.SemanticModel' }; },
        saveFile: async args => { calls.push(['saveFile', args]); return { saved: true, path: '/out/' + args.filename }; },
        confirmDeploy: async folder => { calls.push(['confirmDeploy', folder]); return true; }
    };
    return Object.assign(host, overrides);
}

function setup(t, hostOverrides) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-router-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    activityLog.setLogDir(path.join(work, 'logs'));
    const target = path.join(work, 'Apothecary.SemanticModel');
    fs.cpSync(PROD, target, { recursive: true });
    const host = fakeHost(hostOverrides);
    const state = sessionStore.getState('router-' + Math.random());
    const router = createRouter({ service: createService({ auth: unavailableAuth, backupDir: path.join(work, 'backups') }), state, host });
    let id = 0;
    const call = (method, p, body, query) => router.handle({ type: 'request', id: ++id, method, path: p, query, body });
    return { work, target, host, router, state, call };
}

test('every route in the shared table matches itself, and the router knows every operation', () => {
    const service = createService({});
    for (const r of ROUTES) {
        const concrete = r.path.replace(':requestId', 'abc');
        const m = matchRoute(r.method, concrete);
        assert.ok(m && m.route === r, `${r.method} ${r.path}`);
        assert.strictEqual(typeof service[r.operation], 'function', r.operation);
    }
    assert.deepStrictEqual(matchRoute('GET', '/api/fabric/refresh/status/req%201').params, { requestId: 'req 1' });
    assert.strictEqual(matchRoute('GET', '/api/compare'), null, 'method matters');
    assert.strictEqual(matchRoute('GET', '/api/fabric/refresh/status/'), null, 'an empty parameter does not match');
});

test('compare and a clean deploy run through messages like the web app runs them over HTTP', async t => {
    const { target, host, call, work } = setup(t);

    const compared = await call('POST', '/api/compare', { devPath: DEV, prodPath: target });
    assert.strictEqual(compared.type, 'response');
    assert.strictEqual(compared.status, 200);
    const diffs = compared.body.diffs;
    assert.ok(diffs.length > 1);

    let chosen = null;
    for (const d of diffs.filter(x => x.type === 2)) {
        const pv = await call('POST', '/api/deploy/preview', { selectedKeys: [d.identityKey] });
        if (pv.body.success && !(pv.body.errors || []).length) { chosen = d; break; }
    }
    assert.ok(chosen);
    assert.ok(!host.calls.some(c => c[0] === 'confirmDeploy'), 'a preview never asks about unsaved files');

    const deployed = await call('POST', '/api/deploy', { selectedKeys: [chosen.identityKey], backup: true, backupPath: path.join(work, 'backups') });
    assert.strictEqual(deployed.status, 200);
    assert.strictEqual(deployed.body.success, true);
    assert.deepStrictEqual(host.calls.find(c => c[0] === 'confirmDeploy'), ['confirmDeploy', target], 'asked about the .SemanticModel folder, not definition/');

    const after = await call('POST', '/api/compare', { devPath: DEV, prodPath: target });
    assert.strictEqual(after.body.diffs.length, diffs.length - 1);
});

test('a deploy the host declines writes nothing', async t => {
    const { target, call } = setup(t, { confirmDeploy: async () => false });
    const compared = await call('POST', '/api/compare', { devPath: DEV, prodPath: target });
    const before = fs.readFileSync(path.join(target, 'definition', 'model.tmdl'), 'utf-8');

    const deployed = await call('POST', '/api/deploy', { selectedKeys: compared.body.diffs.map(d => d.identityKey), backup: false });
    assert.strictEqual(deployed.status, 409);
    assert.match(deployed.body.error, /unsaved changes/);
    assert.strictEqual(fs.readFileSync(path.join(target, 'definition', 'model.tmdl'), 'utf-8'), before);
});

test('the folder picker is the host dialog, answered in the web server\'s shape', async t => {
    const { host, call } = setup(t);
    const reply = await call('GET', '/api/pick-file', undefined, { target: 'dev', initialdir: 'C:\\Models' });
    assert.deepStrictEqual(reply.body, { cancelled: false, filePath: '/picked/X.SemanticModel' });
    assert.deepStrictEqual(host.calls[0], ['pickFolder', { target: 'dev', initialdir: 'C:\\Models' }]);
});

test('exports are saved by the host; a failing save is reported, not thrown', async t => {
    const { router } = setup(t);
    const ok = await router.handle({ type: 'saveFile', id: 7, filename: 'm.csv', content: 'a', mimeType: 'text/csv', bom: true });
    assert.deepStrictEqual(ok, { type: 'saveFileResult', id: 7, saved: true, path: '/out/m.csv' });

    const failing = createRouter({ service: createService({}), state: {}, host: fakeHost({ saveFile: async () => { throw new Error('disk full'); } }) });
    assert.deepStrictEqual(
        await failing.handle({ type: 'saveFile', id: 8, filename: 'm.csv', content: 'a' }),
        { type: 'saveFileResult', id: 8, saved: false, error: 'disk full' }
    );
});

test('Fabric reports why it is unavailable instead of opening a browser', async t => {
    const { call } = setup(t);
    assert.deepStrictEqual((await call('GET', '/api/fabric/status')).body, { status: 'disconnected', reason: unavailableAuth.REASON });
    const login = await call('POST', '/api/fabric/login');
    assert.strictEqual(login.status, 401);
    assert.strictEqual(login.body.error, unavailableAuth.REASON);
});

test('unknown routes, ready and stray messages', async t => {
    const { router, host, call } = setup(t);
    assert.strictEqual((await call('GET', '/api/nope')).status, 404);
    assert.strictEqual(await router.handle({ type: 'ready' }), null);
    assert.deepStrictEqual(host.calls.at(-1), ['ready']);
    assert.strictEqual(await router.handle(null), null);
    assert.strictEqual(await router.handle({ type: 'other' }), null);
});

test('path helpers', () => {
    assert.strictEqual(modelFolderOf(path.join('a', 'M.SemanticModel', 'definition')), path.join('a', 'M.SemanticModel'));
    assert.strictEqual(modelFolderOf(path.join('a', 'M.SemanticModel')), path.join('a', 'M.SemanticModel'));
    assert.ok(isInside(path.join('/m', 'M.SemanticModel', 'definition', 'model.tmdl'), path.join('/m', 'M.SemanticModel')));
    assert.ok(!isInside(path.join('/m', 'M.SemanticModel2', 'model.tmdl'), path.join('/m', 'M.SemanticModel')));
    assert.ok(!isInside(path.join('/m', 'Other.tmdl'), path.join('/m', 'M.SemanticModel')));
});
