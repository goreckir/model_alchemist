'use strict';

/**
 * Fabric target model readiness client (MVP).
 * Queries INFO.PARTITIONS() via executeDaxQueries and normalizes the result
 * into plain records for lib/model-readiness.js to classify.
 *
 * Chosen provider: executeDaxQueries (Apache Arrow response), because the
 * older JSON executeQueries endpoint does not support INFO functions.
 * See requirements/TARGET_MODEL_READINESS_MVP_PLAN.md, "Technical approach".
 */

const apiClient = require('./api-client');

/**
 * apache-arrow (JS) has no built-in LZ4/ZSTD codec; it only supports compressed
 * IPC batches via a pluggable `compressionRegistry`. Fabric's executeDaxQueries
 * response uses LZ4_FRAME (confirmed live 2026-08-13 — decoding failed with
 * "codec not found" until this was registered). `lz4js` is pure JS (no native
 * build step) and implements the LZ4 Frame format Arrow expects here.
 */
let lz4CodecRegistered = false;
function ensureLz4CodecRegistered() {
    if (lz4CodecRegistered) return;
    const { compressionRegistry, CompressionType } = require('apache-arrow');
    const lz4js = require('lz4js');
    compressionRegistry.set(CompressionType.LZ4_FRAME, {
        decode: (bytes) => lz4js.decompress(bytes)
    });
    lz4CodecRegistered = true;
}

/**
 * INFO.PARTITIONS() carries the runtime State for both regular table
 * partitions and calculated-table partitions, which covers the MVP's object
 * coverage without querying INFO.COLUMNS/MEASURES/HIERARCHIES/CALCULATIONITEMS.
 * Table names are joined in because INFO.PARTITIONS() only exposes TableID.
 * Verified against a live Fabric model on 2026-08-13 (via XMLA), including the
 * NATURALLEFTOUTERJOIN column-name-matching join on TableID.
 */
const DAX_QUERY = [
    'EVALUATE',
    'SELECTCOLUMNS(',
    '    NATURALLEFTOUTERJOIN(',
    '        INFO.PARTITIONS(),',
    '        SELECTCOLUMNS(INFO.TABLES(), "TableID", [ID], "TableName", [Name])',
    '    ),',
    '    "Table", [TableName],',
    '    "Partition", [Name],',
    '    "State", [State],',
    '    "RefreshedTime", [RefreshedTime],',
    '    "ErrorMessage", [ErrorMessage]',
    ')'
].join('\n');

/** Deployment succeeded, but runtime state could not be read — never treat this as "ready". */
class ReadinessUnavailableError extends Error {
    constructor(reasonCode, message) {
        super(message);
        this.name = 'ReadinessUnavailableError';
        this.reasonCode = reasonCode;
    }
}

function classifyHttpFailure(status, bodyText) {
    switch (status) {
        case 401:
            return new ReadinessUnavailableError('READINESS_UNAUTHORIZED', 'Fabric rejected the access token used for the readiness check.');
        case 403:
            return new ReadinessUnavailableError('READINESS_FORBIDDEN', 'Insufficient permissions to inspect runtime object state. This can require dataset build/admin permission or the "Dataset Execute Queries REST API" tenant setting.');
        case 404:
            return new ReadinessUnavailableError('READINESS_NOT_FOUND', 'The semantic model could not be found for the readiness check.');
        case 429:
            return new ReadinessUnavailableError('READINESS_THROTTLED', 'Fabric throttled the readiness check request. Try again later.');
        default:
            return new ReadinessUnavailableError('READINESS_REQUEST_FAILED', `Readiness check request failed (HTTP ${status}).${bodyText ? ' ' + bodyText.slice(0, 300) : ''}`);
    }
}

/**
 * Split a buffer containing one or more concatenated Arrow IPC streams.
 * Each stream ends with the IPC end-of-stream marker: a 0xFFFFFFFF continuation
 * token followed by a zero-length marker (8 bytes total).
 */
function splitConcatenatedArrowStreams(buffer) {
    const EOS = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);
    const streams = [];
    let start = 0;
    let idx;
    while (start < buffer.length && (idx = buffer.indexOf(EOS, start)) !== -1) {
        const end = idx + EOS.length;
        streams.push(buffer.subarray(start, end));
        start = end;
    }
    if (start < buffer.length) {
        streams.push(buffer.subarray(start));
    }
    return streams.filter(s => s.length > 0);
}

/**
 * Decode a raw executeDaxQueries response body into normalized batches.
 * Requires the `apache-arrow` package. Loaded lazily so environments that
 * never call the readiness client are not required to have it installed.
 *
 * NOTE: record/dictionary batches in the response use LZ4_FRAME compression
 * per the Fabric REST API docs; see ensureLz4CodecRegistered() above. A decode
 * failure here surfaces as READINESS_MALFORMED_RESPONSE, never as a fabricated ready state.
 */
async function decodeArrowBufferDefault(buffer) {
    ensureLz4CodecRegistered();
    const { tableFromIPC } = require('apache-arrow');
    const streams = splitConcatenatedArrowStreams(buffer);
    const batches = [];

    for (const streamBuf of streams) {
        const table = tableFromIPC(streamBuf);
        const metadata = {};
        if (table.schema && table.schema.metadata) {
            for (const [key, value] of table.schema.metadata) metadata[key] = value;
        }

        if (metadata.IsError === 'true') {
            batches.push({ isError: true, errorMessage: metadata.FaultString || 'The readiness query returned an error.', rows: [] });
            continue;
        }

        const rows = table.toArray().map(row => (typeof row.toJSON === 'function' ? row.toJSON() : { ...row }));
        batches.push({ isError: false, rows });
    }

    return batches;
}

/**
 * Query and normalize partition-level readiness records for a semantic model.
 * @param {string} accessToken
 * @param {string} workspaceId
 * @param {string} semanticModelId
 * @param {object} [deps] - injectable dependencies for testing
 * @param {function} [deps.executeDaxQueries] - (accessToken, workspaceId, semanticModelId, query) => Promise<{status, headers, body: Buffer}>
 * @param {function} [deps.decodeArrowBuffer] - (Buffer) => Promise<{isError: boolean, errorMessage?: string, rows: object[]}[]>
 * @returns {Promise<{table: string, objectType: string, name: string, stateCode: number, refreshedTime: string|null, errorMessage: string|null}[]>}
 */
async function getPartitionReadiness(accessToken, workspaceId, semanticModelId, deps = {}) {
    const executeDaxQueries = deps.executeDaxQueries || apiClient.executeDaxQueriesRequest;
    const decodeArrowBuffer = deps.decodeArrowBuffer || decodeArrowBufferDefault;

    let response;
    try {
        response = await executeDaxQueries(accessToken, workspaceId, semanticModelId, DAX_QUERY);
    } catch (err) {
        if (err.code === 'REQUEST_TIMEOUT') {
            throw new ReadinessUnavailableError('READINESS_TIMEOUT', 'The readiness check timed out.');
        }
        throw new ReadinessUnavailableError('READINESS_REQUEST_FAILED', err.message);
    }

    if (response.status < 200 || response.status >= 300) {
        throw classifyHttpFailure(response.status, response.body ? response.body.toString('utf-8') : '');
    }

    let batches;
    try {
        batches = await decodeArrowBuffer(response.body);
    } catch (err) {
        throw new ReadinessUnavailableError('READINESS_MALFORMED_RESPONSE', `Could not decode the readiness response: ${err.message}`);
    }

    const records = [];
    for (const batch of batches) {
        if (batch.isError) {
            throw new ReadinessUnavailableError('READINESS_QUERY_ERROR', batch.errorMessage || 'The readiness query returned an error.');
        }
        for (const row of (batch.rows || [])) {
            // The DAX engine returns Arrow field names with the literal bracket
            // syntax (e.g. "[Table]"), and State as a BigInt (Dictionary<Int8, Int64>).
            const refreshedTimeRaw = row['[RefreshedTime]'];
            let refreshedTime = null;
            if (refreshedTimeRaw !== null && refreshedTimeRaw !== undefined) {
                refreshedTime = typeof refreshedTimeRaw === 'number' || typeof refreshedTimeRaw === 'bigint'
                    ? new Date(Number(refreshedTimeRaw)).toISOString()
                    : refreshedTimeRaw;
            }
            records.push({
                table: row['[Table]'],
                objectType: 'partition',
                name: row['[Partition]'],
                stateCode: row['[State]'] !== null && row['[State]'] !== undefined ? Number(row['[State]']) : row['[State]'],
                refreshedTime,
                errorMessage: row['[ErrorMessage]'] ?? null
            });
        }
    }

    return records;
}

module.exports = {
    DAX_QUERY,
    ReadinessUnavailableError,
    getPartitionReadiness,
    splitConcatenatedArrowStreams
};
