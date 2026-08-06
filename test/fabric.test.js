const test = require('node:test');
const assert = require('node:assert');
const auth = require('../fabric/auth');
const api = require('../fabric/api-client');
const refreshStore = require('../lib/refresh-store');
const { loadModelFromFabric } = require('../fabric/model-loader');

// ── #35: getAccessToken fell back to an expired cached token ──────────────────
test('#35 tokenIsValid rejects expired and near-expiry tokens', () => {
    const now = Date.now();
    assert.strictEqual(auth.tokenIsValid(new Date(now + 10 * 60 * 1000), now), true, 'valid for 10 more minutes');
    assert.strictEqual(auth.tokenIsValid(new Date(now - 1000), now), false, 'already expired');
    assert.strictEqual(auth.tokenIsValid(new Date(now + 30 * 1000), now), false, 'inside the skew window');
    assert.strictEqual(auth.tokenIsValid(null, now), false, 'no expiry known');
    assert.strictEqual(auth.tokenIsValid('not-a-date', now), false, 'unparseable expiry');
});

test('#35 an expired cached token is dropped instead of returned', async () => {
    auth.tokenCache.accessToken = 'stale-token';
    auth.tokenCache.expiresOn = new Date(Date.now() - 60 * 1000);

    const token = await auth.getAccessToken();
    assert.strictEqual(token, null, 'no token is handed out');
    assert.strictEqual(auth.tokenCache.accessToken, null, 'the cache is cleared');
    assert.strictEqual(auth.isAuthenticated(), false, 'the UI is told we are disconnected');
});

test('#35 a still-valid cached token is reused when silent refresh is unavailable', async () => {
    auth.tokenCache.accessToken = 'fresh-token';
    auth.tokenCache.expiresOn = new Date(Date.now() + 30 * 60 * 1000);

    assert.strictEqual(await auth.getAccessToken(), 'fresh-token');
    auth.logout();
});

// ── #38: list endpoints read only the first page ──────────────────────────────
test('#38 listAllPages follows continuationToken across pages', async () => {
    const seen = [];
    const fakeRequest = async (url) => {
        seen.push(url);
        if (!url.includes('continuationToken')) {
            return { value: [{ id: '1' }, { id: '2' }], continuationToken: 'page2' };
        }
        if (url.includes('continuationToken=page2')) {
            return { value: [{ id: '3' }], continuationToken: 'page3' };
        }
        return { value: [{ id: '4' }] };
    };

    const items = await api.listAllPages('https://api.fabric.microsoft.com/v1/workspaces', 'token', fakeRequest);
    assert.deepStrictEqual(items.map(i => i.id), ['1', '2', '3', '4']);
    assert.strictEqual(seen.length, 3, 'three requests were made');
});

test('#38 listAllPages follows continuationUri when the API returns one', async () => {
    const fakeRequest = async (url) => (url.endsWith('/next')
        ? { value: [{ id: 'b' }] }
        : { value: [{ id: 'a' }], continuationUri: 'https://api.fabric.microsoft.com/v1/next' });

    const items = await api.listAllPages('https://api.fabric.microsoft.com/v1/workspaces', 'token', fakeRequest);
    assert.deepStrictEqual(items.map(i => i.id), ['a', 'b']);
});

test('#38 listWorkspaces returns workspaces from every page', async () => {
    const fakeRequest = async (url) => (url.includes('continuationToken')
        ? { value: [{ id: 'w2', displayName: 'Page Two Workspace' }] }
        : { value: [{ id: 'w1', displayName: 'Page One Workspace' }], continuationToken: 'next' });

    const workspaces = await api.listWorkspaces('token', fakeRequest);
    assert.deepStrictEqual(workspaces.map(w => w.name), ['Page One Workspace', 'Page Two Workspace']);
});

test('#38 listSemanticModels paginates too', async () => {
    const fakeRequest = async (url) => (url.includes('continuationToken')
        ? { value: [{ id: 'm2', displayName: 'Model Two' }] }
        : { value: [{ id: 'm1', displayName: 'Model One' }], continuationToken: 'next' });

    const models = await api.listSemanticModels('token', 'ws-1', fakeRequest);
    assert.deepStrictEqual(models.map(m => m.name), ['Model One', 'Model Two']);
    assert.ok(models.every(m => m.workspaceId === 'ws-1'));
});

// ── #66: a slow but successful deploy was reported as failed ──────────────────
test('#66 an operation timeout is explicitly indeterminate', () => {
    const err = api.operationTimeoutError(600000);
    assert.strictEqual(err.code, 'OPERATION_TIMEOUT');
    assert.strictEqual(err.indeterminate, true);
    assert.match(err.message, /MAY STILL BE RUNNING/);
    assert.match(err.message, /600s/);
});

// ── #52: Fabric per-file parse errors were downgraded to a warning ────────────
test('#52 a Fabric model with an unparseable file fails loudly', async () => {
    const healthy = [
        { path: 'definition/model.tmdl', content: 'model Model\n\tculture: en-US\n\nref table Sales\n' },
        { path: 'definition/tables/Sales.tmdl', content: 'table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n' }
    ];
    const model = await loadModelFromFabric('token', 'ws', 'model', 'Test', async () => healthy);
    assert.strictEqual(model.tables.length, 1, 'a healthy model still loads');

    // A part returned without a payload — previously console.warn'd, and the whole
    // table silently vanished from the comparison.
    const broken = [
        healthy[0],
        { path: 'definition/tables/Sales.tmdl', content: undefined }
    ];
    await assert.rejects(
        () => loadModelFromFabric('token', 'ws', 'model', 'Test', async () => broken),
        /Failed to parse 1 TMDL file/
    );
});

// ── #65: TimedOut / Cancelling never reached a terminal state ─────────────────
test('#65 refresh statuses map to terminal states', () => {
    assert.strictEqual(refreshStore.mapStatus('TimedOut'), 'failed');
    assert.strictEqual(refreshStore.mapStatus('Cancelling'), 'inProgress');
    assert.strictEqual(refreshStore.mapStatus('Cancelled'), 'cancelled');
    assert.strictEqual(refreshStore.mapStatus('Completed'), 'completed');
    assert.strictEqual(refreshStore.mapStatus('Failed'), 'failed');
    assert.strictEqual(refreshStore.mapStatus('InProgress'), 'inProgress');
    assert.strictEqual(refreshStore.mapStatus('NotStarted'), 'inProgress');
    assert.strictEqual(refreshStore.mapStatus('202'), 'inProgress');
});
