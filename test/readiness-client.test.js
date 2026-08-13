const test = require('node:test');
const assert = require('node:assert');
const { getPartitionReadiness, splitConcatenatedArrowStreams, ReadinessUnavailableError, DAX_QUERY } = require('../fabric/readiness-client');

const EOS = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);

function okResponse(body = Buffer.alloc(0)) {
    return { status: 200, headers: {}, body };
}

// ── DAX_QUERY: the confirmed, working query ────────────────────────────────────
test('readiness-client: DAX_QUERY joins INFO.PARTITIONS() with INFO.TABLES() by TableID', () => {
    assert.match(DAX_QUERY, /INFO\.PARTITIONS\(\)/);
    assert.match(DAX_QUERY, /INFO\.TABLES\(\)/);
    assert.match(DAX_QUERY, /NATURALLEFTOUTERJOIN/);
});

// ── splitConcatenatedArrowStreams ───────────────────────────────────────────────
test('readiness-client: splitConcatenatedArrowStreams splits on the IPC end-of-stream marker', () => {
    const streamA = Buffer.concat([Buffer.from('stream-a'), EOS]);
    const streamB = Buffer.concat([Buffer.from('stream-b'), EOS]);
    const combined = Buffer.concat([streamA, streamB]);

    const parts = splitConcatenatedArrowStreams(combined);
    assert.strictEqual(parts.length, 2);
    assert.deepStrictEqual(parts[0], streamA);
    assert.deepStrictEqual(parts[1], streamB);
});

test('readiness-client: splitConcatenatedArrowStreams keeps a trailing fragment without an EOS marker', () => {
    const streamA = Buffer.concat([Buffer.from('stream-a'), EOS]);
    const trailing = Buffer.from('no-marker-here');
    const combined = Buffer.concat([streamA, trailing]);

    const parts = splitConcatenatedArrowStreams(combined);
    assert.strictEqual(parts.length, 2);
    assert.deepStrictEqual(parts[1], trailing);
});

test('readiness-client: splitConcatenatedArrowStreams returns an empty array for an empty buffer', () => {
    assert.deepStrictEqual(splitConcatenatedArrowStreams(Buffer.alloc(0)), []);
});

// ── getPartitionReadiness: success paths ────────────────────────────────────────
test('readiness-client: getPartitionReadiness normalizes decoded rows into plain records', async () => {
    const deps = {
        executeDaxQueries: async () => okResponse(Buffer.from('fake-arrow-body')),
        decodeArrowBuffer: async () => [{
            isError: false,
            rows: [
                { '[Table]': 'Sales', '[Partition]': 'Sales', '[State]': 1, '[RefreshedTime]': '2026-01-01T00:00:00Z', '[ErrorMessage]': null },
                { '[Table]': 'Dates', '[Partition]': 'Dates', '[State]': 3 }
            ]
        }]
    };

    const records = await getPartitionReadiness('token', 'ws', 'model', deps);
    assert.strictEqual(records.length, 2);
    assert.deepStrictEqual(records[0], {
        table: 'Sales', objectType: 'partition', name: 'Sales', stateCode: 1,
        refreshedTime: '2026-01-01T00:00:00Z', errorMessage: null
    });
    assert.deepStrictEqual(records[1], {
        table: 'Dates', objectType: 'partition', name: 'Dates', stateCode: 3,
        refreshedTime: null, errorMessage: null
    });
});

test('readiness-client: getPartitionReadiness converts BigInt stateCode and epoch-ms refreshedTime (real Arrow decode shape)', async () => {
    const deps = {
        executeDaxQueries: async () => okResponse(Buffer.from('fake-arrow-body')),
        decodeArrowBuffer: async () => [{
            isError: false,
            rows: [
                { '[Table]': 'Sales', '[Partition]': 'Sales', '[State]': 1n, '[RefreshedTime]': 1786534660987, '[ErrorMessage]': null }
            ]
        }]
    };

    const records = await getPartitionReadiness('token', 'ws', 'model', deps);
    assert.deepStrictEqual(records[0], {
        table: 'Sales', objectType: 'partition', name: 'Sales', stateCode: 1,
        refreshedTime: new Date(1786534660987).toISOString(), errorMessage: null
    });
    assert.strictEqual(typeof records[0].stateCode, 'number');
});

test('readiness-client: getPartitionReadiness merges rows across multiple concatenated batches', async () => {
    const deps = {
        executeDaxQueries: async () => okResponse(),
        decodeArrowBuffer: async () => [
            { isError: false, rows: [{ '[Table]': 'A', '[Partition]': 'A', '[State]': 1 }] },
            { isError: false, rows: [{ '[Table]': 'B', '[Partition]': 'B', '[State]': 4 }] }
        ]
    };
    const records = await getPartitionReadiness('token', 'ws', 'model', deps);
    assert.deepStrictEqual(records.map(r => r.table), ['A', 'B']);
});

test('readiness-client: getPartitionReadiness returns an empty array when there are no rows', async () => {
    const deps = {
        executeDaxQueries: async () => okResponse(),
        decodeArrowBuffer: async () => [{ isError: false, rows: [] }]
    };
    assert.deepStrictEqual(await getPartitionReadiness('token', 'ws', 'model', deps), []);
});

// ── getPartitionReadiness: failure paths never resolve to fabricated data ──────
test('readiness-client: an HTTP 401 becomes READINESS_UNAUTHORIZED', async () => {
    const deps = { executeDaxQueries: async () => ({ status: 401, headers: {}, body: Buffer.alloc(0) }) };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_UNAUTHORIZED'
    );
});

test('readiness-client: an HTTP 403 becomes READINESS_FORBIDDEN and mentions permissions', async () => {
    const deps = { executeDaxQueries: async () => ({ status: 403, headers: {}, body: Buffer.alloc(0) }) };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_FORBIDDEN' && /permission/i.test(err.message)
    );
});

test('readiness-client: an HTTP 404 becomes READINESS_NOT_FOUND', async () => {
    const deps = { executeDaxQueries: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }) };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_NOT_FOUND'
    );
});

test('readiness-client: an HTTP 429 becomes READINESS_THROTTLED', async () => {
    const deps = { executeDaxQueries: async () => ({ status: 429, headers: {}, body: Buffer.alloc(0) }) };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_THROTTLED'
    );
});

test('readiness-client: an unexpected HTTP 500 becomes READINESS_REQUEST_FAILED with a truncated body', async () => {
    const deps = { executeDaxQueries: async () => ({ status: 500, headers: {}, body: Buffer.from('internal server error detail') }) };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError
            && err.reasonCode === 'READINESS_REQUEST_FAILED'
            && /internal server error detail/.test(err.message)
    );
});

test('readiness-client: a request timeout becomes READINESS_TIMEOUT', async () => {
    const deps = {
        executeDaxQueries: async () => {
            const err = new Error('timed out');
            err.code = 'REQUEST_TIMEOUT';
            throw err;
        }
    };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_TIMEOUT'
    );
});

test('readiness-client: an unexpected network error becomes READINESS_REQUEST_FAILED', async () => {
    const deps = { executeDaxQueries: async () => { throw new Error('ECONNRESET'); } };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_REQUEST_FAILED'
    );
});

test('readiness-client: a malformed Arrow response becomes READINESS_MALFORMED_RESPONSE', async () => {
    const deps = {
        executeDaxQueries: async () => okResponse(),
        decodeArrowBuffer: async () => { throw new Error('bad magic bytes'); }
    };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_MALFORMED_RESPONSE'
    );
});

test('readiness-client: an engine-reported query error (IsError batch) becomes READINESS_QUERY_ERROR', async () => {
    const deps = {
        executeDaxQueries: async () => okResponse(),
        decodeArrowBuffer: async () => [{ isError: true, errorMessage: 'DAX syntax error', rows: [] }]
    };
    await assert.rejects(
        () => getPartitionReadiness('token', 'ws', 'model', deps),
        (err) => err instanceof ReadinessUnavailableError && err.reasonCode === 'READINESS_QUERY_ERROR' && /DAX syntax error/.test(err.message)
    );
});
