/**
 * Accept API calls only from the app's own page.
 *
 * Listening on 127.0.0.1 keeps other machines out, but a web page open in the
 * user's browser can still send requests to http://localhost:<port>. The API
 * has no authentication, so two things are checked on every /api request:
 *
 *   - Host must name this computer. A page that re-points its own domain at
 *     127.0.0.1 (DNS rebinding) still sends its own domain in Host.
 *   - A request the browser marks as coming from another site is refused:
 *     Origin, when present, must equal the address the request was sent to,
 *     and Sec-Fetch-Site, when present, must be same-origin or none (typed
 *     address, bookmark).
 *
 * Requests without these headers (curl, scripts, tests) pass: they do not come
 * from a browser page, and anything that can run them can already read the disk.
 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = ['0.0.0.0', '::', '[::]'];

function hostnameOf(hostHeader) {
    try {
        return new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * @param {Record<string, string | undefined>} headers lower-cased request headers
 * @param {{ bindHost?: string }} [options] the address the server listens on, when not the default
 * @returns {string | null} why the request is refused, or null when it is allowed
 */
function refusalReason(headers, { bindHost } = {}) {
    const host = headers.host;
    const bind = (bindHost || '').toLowerCase();
    // Listening on every interface is the user's explicit choice (HOST); the
    // server is then reached by names this module cannot know.
    if (!WILDCARD_HOSTS.includes(bind)) {
        const allowed = bind ? LOOPBACK_HOSTS.concat(bind, `[${bind}]`) : LOOPBACK_HOSTS;
        const name = host ? hostnameOf(host) : null;
        if (!name || !allowed.includes(name)) return 'The Host header does not name this computer.';
    }

    const origin = headers.origin;
    if (origin !== undefined) {
        let originHost = null;
        try { originHost = new URL(origin).host.toLowerCase(); } catch { /* "null" or malformed */ }
        if (!originHost || originHost !== String(host || '').toLowerCase()) {
            return 'The request comes from another site.';
        }
    }

    const site = headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return 'The request comes from another site.';
    }
    return null;
}

/** Express middleware: 403 for any request refusalReason() rejects. */
function localRequestsOnly(options) {
    return (req, res, next) => {
        const reason = refusalReason(req.headers, options);
        if (!reason) return next();
        res.status(403).json({ error: `Request refused. ${reason}` });
    };
}

module.exports = { localRequestsOnly, refusalReason };
