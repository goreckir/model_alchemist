/**
 * Per-session comparison state.
 *
 * All comparison state used to live in module-level singletons shared by every
 * browser tab. Whichever tab compared last won: tab A could click Deploy and have
 * its selected keys filtered against tab B's comparison, then written into tab B's
 * target. It was also the root cause behind the stale Fabric state and the
 * mid-deploy global mutation.
 *
 * The client sends a per-tab id in `x-ma-session`. Requests without one share a
 * 'default' session, so an older client keeps working exactly as before.
 */

const MAX_SESSIONS = 25;

const sessions = new Map();

function emptyState() {
    return {
        lastComparison: null,
        lastDevModel: null,
        lastProdPath: null,
        lastProdModel: null,
        lastProdFabricInfo: null,
        touchedAt: Date.now()
    };
}

/** Read the session id from a request. */
function sessionIdOf(req) {
    const header = req && typeof req.get === 'function' ? req.get('x-ma-session') : null;
    const query = req && req.query ? req.query.session : null;
    const raw = header || query || 'default';
    return String(raw).slice(0, 100);
}

/** Get (creating if needed) the state bag for a session id. */
function getState(id) {
    const key = id || 'default';
    let state = sessions.get(key);
    if (!state) {
        state = emptyState();
        sessions.set(key, state);
        evictOldest();
    }
    state.touchedAt = Date.now();
    return state;
}

/** Convenience: state for a request. */
function stateFor(req) {
    return getState(sessionIdOf(req));
}

/**
 * Clear every comparison field at once.
 *
 * /api/compare used to set only three of the five, so after a Fabric compare
 * followed by a local compare the Fabric model and dataset were still armed:
 * deploy validated against the wrong model and refresh hit a dataset no longer
 * in play.
 */
function resetComparison(state) {
    state.lastComparison = null;
    state.lastDevModel = null;
    state.lastProdPath = null;
    state.lastProdModel = null;
    state.lastProdFabricInfo = null;
    return state;
}

function evictOldest() {
    while (sessions.size > MAX_SESSIONS) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [key, state] of sessions) {
            if (key === 'default') continue;
            if (state.touchedAt < oldestAt) { oldestAt = state.touchedAt; oldestKey = key; }
        }
        if (!oldestKey) break;
        sessions.delete(oldestKey);
    }
}

/** Test/diagnostic helpers. */
function sessionCount() { return sessions.size; }
function clearAll() { sessions.clear(); }

module.exports = { sessionIdOf, getState, stateFor, resetComparison, sessionCount, clearAll, MAX_SESSIONS };
