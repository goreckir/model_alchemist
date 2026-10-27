const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createService } = require('../core/service');
const sessionStore = require('../lib/session-store');
const activityLog = require('../lib/activity-log');

// The VS Code extension calls core/service.js directly, without Express.
// These tests drive it the same way.

const DEV = path.join(__dirname, '..', 'demo', 'dev', 'Apothecary.SemanticModel');
const PROD = path.join(__dirname, '..', 'demo', 'prod', 'Apothecary.SemanticModel');

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-service-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('service: defaults reports the backup folder the host injected', () => {
    const service = createService({ backupDir: '/host/backups' });
    const { status, body } = service.defaults();
    assert.strictEqual(status, 200);
    assert.strictEqual(body.backupPath, '/host/backups');
});

test('service: compare, preview and deploy run without HTTP and keep state per session', async t => {
    const work = tempDir(t);
    activityLog.setLogDir(path.join(work, 'logs'));
    const target = path.join(work, 'Apothecary.SemanticModel');
    fs.cpSync(PROD, target, { recursive: true });

    const service = createService({ backupDir: path.join(work, 'backups') });
    const panelA = sessionStore.getState('panel-a');
    const panelB = sessionStore.getState('panel-b');

    const compared = service.compare(panelA, { devPath: DEV, prodPath: target });
    assert.strictEqual(compared.status, 200);
    assert.ok(compared.body.diffs.length > 0);

    // The other panel has not compared anything.
    const elsewhere = await service.deploy(panelB, { selectedKeys: [compared.body.diffs[0].identityKey] });
    assert.strictEqual(elsewhere.status, 400);

    // A modified object that deploys cleanly on its own.
    let chosen = null;
    for (const diff of compared.body.diffs.filter(d => d.type === 2)) {
        const preview = await service.previewDeploy(panelA, { selectedKeys: [diff.identityKey] });
        if (preview.status === 200 && preview.body.success && !(preview.body.errors || []).length) { chosen = diff; break; }
    }
    assert.ok(chosen, 'the Demo Kit has a modified object that deploys on its own');

    const deployed = await service.deploy(panelA, { selectedKeys: [chosen.identityKey], backup: true, backupPath: path.join(work, 'backups') });
    assert.strictEqual(deployed.status, 200);
    assert.strictEqual(deployed.body.success, true);
    assert.strictEqual(fs.readdirSync(path.join(work, 'backups')).length, 1);

    const after = service.compare(panelA, { devPath: DEV, prodPath: target });
    assert.strictEqual(after.body.diffs.length, compared.body.diffs.length - 1);
});

test('service: a missing input is a 400 body, never a throw', async () => {
    const service = createService({});
    const state = sessionStore.getState('panel-c');
    assert.deepStrictEqual(service.compare(state, {}), { status: 400, body: { error: 'Both devPath and prodPath are required.' } });
    assert.strictEqual((await service.compareFabric(state, {})).status, 400);
    assert.strictEqual(service.resolveModel(state, {}).status, 400);
});

test('service: Fabric calls use the injected auth, not the MSAL module', async () => {
    let asked = 0;
    const auth = {
        isAuthenticated: () => false,
        isLoginPending: () => false,
        getAccessToken: async () => { asked++; return null; },
        getAccountInfo: () => null,
        getLastAuthError: () => 'signed out in the host',
        cancelLogin: () => {},
        logout: () => {},
        loginInteractive: async () => {}
    };
    const service = createService({ auth });
    const { status, body } = await service.fabricStatus();
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { status: 'disconnected', reason: 'signed out in the host' });
    assert.strictEqual(asked, 1);
});

test('activity log: setLogDir moves where events are written and read', t => {
    const dir = tempDir(t);
    activityLog.setLogDir(dir);
    activityLog.logEvent('compare', { marker: 'moved' });
    assert.strictEqual(activityLog.LOG_FILE, path.join(dir, 'activity.jsonl'));
    assert.ok(fs.existsSync(path.join(dir, 'activity.jsonl')));
    assert.strictEqual(activityLog.readEvents(1)[0].marker, 'moved');
});
