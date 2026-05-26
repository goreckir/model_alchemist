/**
 * Lightweight append-only activity log.
 *
 * Each entry is a single JSON line stored in <repo>/logs/activity.jsonl.
 * Used to audit compare / deploy / refresh actions performed via the API.
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'activity.jsonl');

function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Append a log entry.
 * @param {string} eventType e.g. 'compare', 'deploy', 'refresh', 'refresh-status'
 * @param {object} payload arbitrary serializable details
 */
function logEvent(eventType, payload = {}) {
    try {
        ensureDir();
        const entry = {
            timestamp: new Date().toISOString(),
            event: eventType,
            ...payload
        };
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
        // Logging must never break the request flow.
        console.error('activity-log write failed:', err.message);
    }
}

/**
 * Read the most recent N entries (newest last).
 * Returns an array of parsed entries; malformed lines are skipped.
 */
function readEvents(limit = 200) {
    if (!fs.existsSync(LOG_FILE)) return [];
    const text = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const slice = lines.slice(-Math.max(1, limit));
    const out = [];
    for (const line of slice) {
        try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
}

function clearLog() {
    if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
}

module.exports = { logEvent, readEvents, clearLog, LOG_FILE };
