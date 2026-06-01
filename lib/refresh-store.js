/**
 * Refresh Session Store — tracks all refresh operations during the app session
 * and persists history to daily log files.
 *
 * Log structure: logs/refresh/<modelName>/<YYYY-MM-DD>_<sessionStartISO>.jsonl
 */
const fs = require('fs');
const path = require('path');

const LOG_BASE = path.join(__dirname, '..', 'logs', 'refresh');

function localISO(date) {
    const d = date || new Date();
    const off = d.getTimezoneOffset();
    const local = new Date(d.getTime() - off * 60000);
    return local.toISOString().slice(0, -1); // e.g. 2026-05-26T22:01:25.653
}

const SESSION_START = localISO().replace(/[:.]/g, '-');

// In-memory store: array of refresh records for current session
const sessionRefreshes = [];

/**
 * @typedef {Object} RefreshObject
 * @property {string} table
 * @property {string} [partition]
 * @property {string} status - 'inProgress'|'completed'|'failed'|'cancelled'
 * @property {string} [startTime]
 * @property {string} [endTime]
 * @property {string} [message]
 */

/**
 * @typedef {Object} RefreshRecord
 * @property {string} id - requestId from Enhanced Refresh API
 * @property {string} modelName
 * @property {string} workspaceId
 * @property {string} semanticModelId
 * @property {string} status - 'inProgress'|'completed'|'failed'|'cancelled'|'unknown'
 * @property {string} startTime - ISO string
 * @property {string} [endTime] - ISO string
 * @property {string[]} requestedTables - tables requested for refresh
 * @property {RefreshObject[]} objects - per-object status
 */

function createRefreshRecord(requestId, modelName, workspaceId, semanticModelId, tables, tableDetails, refreshType, options = {}) {
    const record = {
        id: requestId,
        modelName: modelName || 'unknown',
        workspaceId,
        semanticModelId,
        status: 'inProgress',
        refreshType: refreshType || 'automatic',
        startTime: localISO(),
        endTime: null,
        requestedTables: tables || [],
        tableDetails: (tableDetails || []).map(td => ({
            table: td.table,
            refreshType: td.refreshType || 'automatic',
            reasons: td.reasons || []
        })),
        objects: (tables || []).map(t => {
            const detail = (tableDetails || []).find(td => td.table === t);
            return {
                table: t,
                refreshType: detail ? detail.refreshType : 'automatic',
                reasons: detail ? detail.reasons : [],
                status: 'inProgress',
                startTime: null,
                endTime: null,
                message: null
            };
        }),
        // Post-refresh calculate phase tracking
        needsPostCalculate: options.needsPostCalculate || false,
        postCalculateTriggered: false,
        postCalculateRequestId: null
    };
    sessionRefreshes.push(record);
    persistRecord(record);
    return record;
}

function updateRefreshRecord(requestId, apiResponse) {
    const record = sessionRefreshes.find(r => r.id === requestId);
    if (!record) return null;

    if (apiResponse.status) {
        record.status = mapStatus(apiResponse.status);
    }
    if (apiResponse.startTime) record.startTime = apiResponse.startTime;
    if (apiResponse.endTime) record.endTime = apiResponse.endTime;
    // Capture top-level error message (present when the whole refresh fails)
    if (apiResponse.serviceExceptionJson) {
        record.serviceExceptionJson = apiResponse.serviceExceptionJson;
    }

    // Update per-object status if API returns objects array
    if (apiResponse.objects && Array.isArray(apiResponse.objects)) {
        record.objects = apiResponse.objects.map(obj => ({
            table: obj.table || '',
            partition: obj.partition || null,
            status: mapStatus(obj.status || 'Unknown'),
            startTime: obj.startTime || null,
            endTime: obj.endTime || null,
            message: obj.serviceExceptionJson || obj.message || null
        }));
    }

    persistRecord(record);
    return record;
}

function getRefreshRecord(requestId) {
    return sessionRefreshes.find(r => r.id === requestId) || null;
}

function getSessionHistory() {
    return [...sessionRefreshes];
}

function getActiveRefresh() {
    return sessionRefreshes.find(r => r.status === 'inProgress') || null;
}

function mapStatus(apiStatus) {
    const s = String(apiStatus || '').toLowerCase();
    if (s === 'completed') return 'completed';
    if (s === 'failed') return 'failed';
    if (s === 'cancelled' || s === 'disabled') return 'cancelled';
    if (s === 'inprogress' || s === 'notstarted') return 'inProgress';
    if (/^\d+$/.test(s)) return 'inProgress'; // HTTP status code (e.g. 202) means still running
    return 'unknown';
}

function persistRecord(record) {
    try {
        const modelDir = path.join(LOG_BASE, sanitize(record.modelName));
        if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

        const day = record.startTime.slice(0, 10); // YYYY-MM-DD
        const fileName = `${day}_${SESSION_START}.jsonl`;
        const filePath = path.join(modelDir, fileName);

        // Only persist when something meaningful changed (avoid noisy inProgress repeats)
        const snapshot = record.status + '|' + (record.objects || []).map(o => `${o.table}:${o.status}`).join(',');
        if (record._lastSnapshot === snapshot) return; // no change — skip write
        record._lastSnapshot = snapshot;

        const { _lastSnapshot, ...data } = record;
        fs.appendFileSync(filePath, JSON.stringify({ ...data, _ts: localISO() }) + '\n', 'utf-8');
    } catch (err) {
        console.error('refresh-store persist failed:', err.message);
    }
}

function sanitize(name) {
    return (name || 'unknown').replace(/[^a-zA-Z0-9_\-. ]/g, '_').slice(0, 80);
}

module.exports = {
    createRefreshRecord,
    updateRefreshRecord,
    getRefreshRecord,
    getSessionHistory,
    getActiveRefresh
};
