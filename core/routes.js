/**
 * The API as a table: which service operation answers which method and path.
 *
 * server.js registers these with Express; the VS Code extension matches its
 * webview's request messages against the same table, so the two hosts cannot
 * drift apart. `input` turns a request ({ body, params, query }) into what the
 * operation takes.
 *
 * /api/pick-file is not here: a folder dialog belongs to the host (PowerShell
 * in the web app, showOpenDialog in VS Code).
 */
const fromBody = req => req.body;

const ROUTES = [
    { method: 'GET', path: '/api/version', operation: 'version' },
    { method: 'GET', path: '/api/defaults', operation: 'defaults' },

    { method: 'POST', path: '/api/compare', operation: 'compare' },
    { method: 'POST', path: '/api/compare-fabric', operation: 'compareFabric' },
    { method: 'POST', path: '/api/deploy', operation: 'deploy' },
    { method: 'POST', path: '/api/deploy/preview', operation: 'previewDeploy' },
    { method: 'POST', path: '/api/resolve-model', operation: 'resolveModel' },

    // Login opens the sign-in page; the host decides how.
    { method: 'POST', path: '/api/fabric/login', operation: 'fabricLogin' },
    { method: 'GET', path: '/api/fabric/status', operation: 'fabricStatus' },
    { method: 'POST', path: '/api/fabric/cancel-login', operation: 'fabricCancelLogin' },
    { method: 'POST', path: '/api/fabric/disconnect', operation: 'fabricDisconnect' },
    { method: 'POST', path: '/api/fabric/resolve', operation: 'fabricResolve' },
    { method: 'POST', path: '/api/fabric/refresh', operation: 'fabricRefresh' },
    { method: 'GET', path: '/api/fabric/refresh/status/:requestId', operation: 'fabricRefreshStatus', input: req => ({ requestId: req.params.requestId }) },
    { method: 'GET', path: '/api/fabric/refresh/history', operation: 'fabricRefreshHistory' },
    { method: 'GET', path: '/api/fabric/refresh/active', operation: 'fabricRefreshActive' },
    { method: 'GET', path: '/api/fabric/readiness', operation: 'fabricReadiness' },

    { method: 'GET', path: '/api/activity-log', operation: 'activityLog', input: req => ({ limit: req.query.limit }) }
].map(r => Object.assign({ input: fromBody }, r));

/**
 * Find the route for a method and path, with its `:param` values.
 * Returns null when nothing matches. Express does this itself; the extension
 * uses it for webview messages.
 */
function matchRoute(method, path, routes = ROUTES) {
    const wanted = String(path).split('/');
    for (const route of routes) {
        if (route.method !== String(method).toUpperCase()) continue;
        const parts = route.path.split('/');
        if (parts.length !== wanted.length) continue;
        const params = {};
        const ok = parts.every((part, i) => {
            if (part.startsWith(':')) { params[part.slice(1)] = decodeURIComponent(wanted[i]); return wanted[i] !== ''; }
            return part === wanted[i];
        });
        if (ok) return { route, params };
    }
    return null;
}

module.exports = { ROUTES, matchRoute };
