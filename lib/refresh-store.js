/**
 * Refresh Session Store — tracks all refresh operations during the app session
 * and persists history to daily log files.
 *
 * Log structure: logs/refresh/<modelName>/<YYYY-MM-DD>_<sessionStartISO>.jsonl
 */
const fs = require('fs');
const path = require('path');

const LOG_BASE = path.join(__dirname, '..', 'logs', 'refresh');
const SESSION_START = new Date().toISOString().replace(/[:.]/g, '-');

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

function createRefreshRecord(requestId, modelName, workspaceId, semanticModelId, tables, tableDetails, refreshType) {
    const record = {
        id: requestId,
        modelName: modelName || 'unknown',
        workspaceId,
        semanticModelId,
        status: 'inProgress',
        refreshType: refreshType || 'automatic',
        startTime: new Date().toISOString(),
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
        })
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
    const s = (apiStatus || '').toLowerCase();
    if (s === 'completed') return 'completed';
    if (s === 'failed') return 'failed';
    if (s === 'cancelled' || s === 'disabled') return 'cancelled';
    if (s === 'inprogress' || s === 'notstarted') return 'inProgress';
    return 'unknown';
}

function persistRecord(record) {
    try {
        const modelDir = path.join(LOG_BASE, sanitize(record.modelName));
        if (!fs.existsSync(modelDir)) fs.mkdirSync(modelDir, { recursive: true });

        const day = record.startTime.slice(0, 10); // YYYY-MM-DD
        const fileName = `${day}_${SESSION_START}.jsonl`;
        const filePath = path.join(modelDir, fileName);
        fs.appendFileSync(filePath, JSON.stringify({ ...record, _ts: new Date().toISOString() }) + '\n', 'utf-8');
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
