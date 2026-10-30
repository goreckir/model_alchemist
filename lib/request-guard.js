/**
 * Only this machine's own pages may call the API.
 *
 * The server listens on the loopback interface, so nothing on the network can
 * reach it. That alone does not stop a web page open in the user's browser
 * from sending requests to http://localhost:<port>: a deploy or a Git push
 * would then run with the user's files and credentials. This guard refuses
 * any /api request that:
 *   - names a host other than localhost / 127.0.0.1 / [::1] (DNS rebinding),
 *   - carries an Origin that is not this server's own origin,
 *   - is marked cross-site by the browser (Sec-Fetch-Site), which also covers
 *     GET requests such as the folder picker.
 * Requests without Origin (curl, scripts on this machine) are allowed: a local
 * process can already do anything the server can.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** 'localhost:3001' / '[::1]:3001' / '127.0.0.1' → hostname, lower-case, without brackets. */
function hostnameOf(hostHeader) {
    const value = String(hostHeader || '').trim().toLowerCase();
    if (!value) return '';
    if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
    return value.split(':')[0];
}

function isLoopbackHost(hostHeader) {
    return LOOPBACK.has(hostnameOf(hostHeader));
}

/** Why a request is refused, or null when it may go through. */
function rejectReason(headers) {
    const host = headers.host;
    if (!isLoopbackHost(host)) return 'The API only answers requests addressed to localhost.';

    const site = headers['sec-fetch-site'];
    if (site === 'cross-site') return 'Requests from other websites are not allowed.';

    const origin = headers.origin;
    if (origin !== undefined) {
        let url;
        try { url = new URL(origin); } catch { return 'Requests from other websites are not allowed.'; }
        if (url.host.toLowerCase() !== String(host).toLowerCase() || !isLoopbackHost(url.host)) {
            return 'Requests from other websites are not allowed.';
        }
    }
    return null;
}

/** Express middleware for /api routes. */
function requestGuard(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    const reason = rejectReason(req.headers);
    if (reason) return res.status(403).json({ error: reason, code: 'FORBIDDEN_ORIGIN' });
    next();
}

module.exports = { requestGuard, rejectReason, isLoopbackHost, hostnameOf };
