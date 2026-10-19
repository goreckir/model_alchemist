/**
 * Off-camera Fabric helpers for the Fabric scenes. Everything here talks to the
 * running app's own API under a separate session id, so nothing appears in the
 * recorded browser tab.
 *
 * Workspace names come from MA_FABRIC_DEV / MA_FABRIC_PROD (defaults
 * Apothecary-Dev / Apothecary-Prod); the model is "Apothecary" in both.
 */
const DEV_WS = process.env.MA_FABRIC_DEV || 'Apothecary-Dev';
const PROD_WS = process.env.MA_FABRIC_PROD || 'Apothecary-Prod';
const MODEL = 'Apothecary';

const connectionString = ws => `Data Source=powerbi://api.powerbi.com/v1.0/myorg/${ws};Initial Catalog=${MODEL};`;

function client(port, session) {
    return async function api(method, route, body) {
        const res = await fetch(`http://localhost:${port}${route}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-ma-session': session },
            body: body ? JSON.stringify(body) : undefined
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${json.error || JSON.stringify(json)}`);
        return json;
    };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Interactive sign-in in the system browser (off camera). Resolves once connected. */
async function signIn(port, { timeoutMs = 5 * 60 * 1000 } = {}) {
    const api = client(port, 'rec-auth');
    const status = await api('GET', '/api/fabric/status');
    if (status.status === 'connected') return;
    console.log('  Sign in to Fabric in the browser window that opens (not recorded)…');
    api('POST', '/api/fabric/login').catch(() => {}); // resolves only after the browser flow
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        await sleep(2000);
        if ((await api('GET', '/api/fabric/status')).status === 'connected') return;
    }
    throw new Error('Fabric sign-in timed out.');
}

async function resolve(api, ws) {
    const info = await api('POST', '/api/fabric/resolve', { connectionString: connectionString(ws) });
    return { type: 'fabric', connectionString: connectionString(ws), workspaceId: info.workspaceId, semanticModelId: info.semanticModelId };
}

/**
 * Refresh straight through the app's Fabric client, not its /api/fabric/refresh
 * route, so the reset never shows up in the Model Refresh history on camera.
 */
async function refreshDirect(workspaceId, semanticModelId, { timeoutMs = 15 * 60 * 1000 } = {}) {
    const root = require('path').join(__dirname, '..', '..');
    const auth = require(require('path').join(root, 'fabric', 'auth'));
    const fabricApi = require(require('path').join(root, 'fabric', 'api-client'));
    const token = await auth.getAccessToken();
    const { requestId } = await fabricApi.refreshSemanticModel(token, workspaceId, semanticModelId, [], 'full');
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        await sleep(5000);
        const s = await fabricApi.getRefreshStatus(await auth.getAccessToken(), workspaceId, semanticModelId, requestId);
        // HTTP 202 while running; the body's status string once finished.
        if (typeof s.status === 'string' && !/^(Unknown|NotStarted|InProgress)$/i.test(s.status)) return s.status;
    }
    throw new Error('Refresh did not finish in time.');
}

/**
 * Make the Fabric Prod model match a local folder (normally demo/prod): compare,
 * deploy every difference, then refresh the whole model so data and processing
 * state are clean. Off camera, in its own session.
 */
async function resetProd(port, localTarget, { refresh = true } = {}) {
    const api = client(port, 'rec-reset');
    const prod = await resolve(api, PROD_WS);
    const cmp = await api('POST', '/api/compare-fabric', { devSource: { type: 'local', path: localTarget }, prodSource: prod });
    const keys = (cmp.diffs || []).map(d => d.identityKey);
    if (keys.length) console.log(`  reset restores: ${(cmp.diffs || []).map(d => `${d.objectType} ${d.displayName}`).join('; ')}`);
    if (keys.length) {
        const result = await api('POST', '/api/deploy', { selectedKeys: keys, backup: false });
        if (result.success === false) throw new Error(`Reset deploy failed: ${JSON.stringify(result.errors || result).slice(0, 500)}`);
    }
    if (refresh) {
        const status = await refreshDirect(prod.workspaceId, prod.semanticModelId);
        if (!/Completed/i.test(status)) throw new Error(`Reset refresh ended with ${status}`);
    }
    return { reset: keys.length };
}

/** Someone else publishes to Prod after the on-camera comparison (for the drift scene). */
async function publishBehindYourBack(port, localSource, pickDisplayNames) {
    const api = client(port, 'rec-colleague');
    const prod = await resolve(api, PROD_WS);
    const cmp = await api('POST', '/api/compare-fabric', { devSource: { type: 'local', path: localSource }, prodSource: prod });
    const keys = (cmp.diffs || []).filter(d => pickDisplayNames.includes(d.displayName)).map(d => d.identityKey);
    if (!keys.length) throw new Error(`Nothing to publish for ${pickDisplayNames.join(', ')}`);
    return api('POST', '/api/deploy', { selectedKeys: keys, backup: false });
}

module.exports = { signIn, resetProd, publishBehindYourBack, connectionString, DEV_WS, PROD_WS, MODEL };
