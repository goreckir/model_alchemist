const test = require('node:test');
const assert = require('node:assert');
const modelReadiness = require('../lib/model-readiness');

// ── classifyState: every documented ObjectState value ─────────────────────────
test('readiness: classifyState maps every documented ObjectState code', () => {
    assert.deepStrictEqual(modelReadiness.classifyState(1), { state: 'Ready', category: 'ready', action: 'none' });
    assert.deepStrictEqual(modelReadiness.classifyState(3), { state: 'NoData', category: 'requiresRefresh', action: 'refresh' });
    assert.deepStrictEqual(modelReadiness.classifyState(4), { state: 'CalculationNeeded', category: 'requiresRecalculation', action: 'recalculate' });
    assert.deepStrictEqual(modelReadiness.classifyState(5), { state: 'SemanticError', category: 'error', action: 'inspect' });
    assert.deepStrictEqual(modelReadiness.classifyState(6), { state: 'EvaluationError', category: 'error', action: 'inspect' });
    assert.deepStrictEqual(modelReadiness.classifyState(7), { state: 'DependencyError', category: 'error', action: 'repair' });
    assert.deepStrictEqual(modelReadiness.classifyState(8), { state: 'Incomplete', category: 'requiresRefresh', action: 'refresh' });
    assert.deepStrictEqual(modelReadiness.classifyState(10), { state: 'ForceCalculationNeeded', category: 'requiresRecalculation', action: 'recalculate' });
});

test('readiness: classifyState treats unknown/missing/non-numeric codes as unknown, never ready', () => {
    assert.deepStrictEqual(modelReadiness.classifyState(2), { state: 'Unknown', category: 'unknown', action: 'inspect' });
    assert.deepStrictEqual(modelReadiness.classifyState(999), { state: 'Unknown', category: 'unknown', action: 'inspect' });
    assert.deepStrictEqual(modelReadiness.classifyState(undefined), { state: 'Unknown', category: 'unknown', action: 'inspect' });
    assert.deepStrictEqual(modelReadiness.classifyState(null), { state: 'Unknown', category: 'unknown', action: 'inspect' });
    assert.deepStrictEqual(modelReadiness.classifyState('not-a-number'), { state: 'Unknown', category: 'unknown', action: 'inspect' });
});

test('readiness: classifyState accepts numeric strings (Arrow may decode State as a string)', () => {
    assert.strictEqual(modelReadiness.classifyState('1').category, 'ready');
    assert.strictEqual(modelReadiness.classifyState('4').category, 'requiresRecalculation');
});

// ── buildReadinessSnapshot: aggregation ────────────────────────────────────────
test('readiness: buildReadinessSnapshot counts every category and lists only non-ready objects', () => {
    const records = [
        { table: 'Sales', name: 'Sales', stateCode: 1 },
        { table: 'Dates', name: 'Dates', stateCode: 3 },
        { table: 'Budget', name: 'Budget', stateCode: 4 },
        { table: 'Rates', name: 'Rates', stateCode: 5, errorMessage: 'bad expression' },
        { table: 'Rates2', name: 'Rates2', stateCode: 6 },
        { table: 'Rates3', name: 'Rates3', stateCode: 7 },
        { table: 'Staging', name: 'Staging', stateCode: 8 },
        { table: 'Calc', name: 'Calc', stateCode: 10 },
        { table: 'Weird', name: 'Weird', stateCode: 42 }
    ];

    const snapshot = modelReadiness.buildReadinessSnapshot(records, { checkedAt: '2026-01-01T00:00:00.000Z' });

    assert.strictEqual(snapshot.availability, 'available');
    assert.strictEqual(snapshot.checkedAt, '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(snapshot.summary, {
        ready: 1,
        requiresRefresh: 2,
        requiresRecalculation: 2,
        errors: 3,
        unknown: 1
    });
    assert.strictEqual(snapshot.objectsRequiringAttention.length, 8, 'every non-ready object is listed');
    assert.ok(!snapshot.objectsRequiringAttention.some(o => o.table === 'Sales'), 'the ready object is not listed');
});

test('readiness: buildReadinessSnapshot defaults checkedAt when not provided', () => {
    const snapshot = modelReadiness.buildReadinessSnapshot([]);
    assert.strictEqual(snapshot.availability, 'available');
    assert.ok(typeof snapshot.checkedAt === 'string' && snapshot.checkedAt.length > 0);
    assert.deepStrictEqual(snapshot.summary, { ready: 0, requiresRefresh: 0, requiresRecalculation: 0, errors: 0, unknown: 0 });
    assert.deepStrictEqual(snapshot.objectsRequiringAttention, []);
});

test('readiness: buildReadinessSnapshot handles duplicate table/partition records independently', () => {
    const records = [
        { table: 'Sales', name: 'Sales', stateCode: 3 },
        { table: 'Sales', name: 'Sales', stateCode: 3 }
    ];
    const snapshot = modelReadiness.buildReadinessSnapshot(records);
    assert.strictEqual(snapshot.summary.requiresRefresh, 2, 'duplicates are counted, not deduplicated at this layer');
    assert.strictEqual(snapshot.objectsRequiringAttention.length, 2);
});

test('readiness: buildReadinessSnapshot carries errorMessage and refreshedTime through, defaulting to null', () => {
    const snapshot = modelReadiness.buildReadinessSnapshot([
        { table: 'Rates', name: 'Rates', stateCode: 5, errorMessage: 'boom', refreshedTime: '2026-01-01T00:00:00Z' },
        { table: 'Dates', name: 'Dates', stateCode: 3 }
    ]);
    assert.strictEqual(snapshot.objectsRequiringAttention[0].errorMessage, 'boom');
    assert.strictEqual(snapshot.objectsRequiringAttention[0].refreshedTime, '2026-01-01T00:00:00Z');
    assert.strictEqual(snapshot.objectsRequiringAttention[1].errorMessage, null);
    assert.strictEqual(snapshot.objectsRequiringAttention[1].refreshedTime, null);
});

// ── buildUnavailableSnapshot: inspection failure never becomes "ready" ─────────
test('readiness: buildUnavailableSnapshot reports unavailable with the given reason and message', () => {
    const snapshot = modelReadiness.buildUnavailableSnapshot('READINESS_FORBIDDEN', 'no permission');
    assert.deepStrictEqual(snapshot, { availability: 'unavailable', reasonCode: 'READINESS_FORBIDDEN', message: 'no permission' });
    assert.notStrictEqual(snapshot.availability, 'available', 'a failed inspection is never reported as available/ready');
});

// ── strongerAction: precedence and null-safety ─────────────────────────────────
test('readiness: strongerAction picks refresh > recalculate > repair > inspect', () => {
    assert.strictEqual(modelReadiness.strongerAction('refresh', 'recalculate'), 'refresh');
    assert.strictEqual(modelReadiness.strongerAction('recalculate', 'refresh'), 'refresh');
    assert.strictEqual(modelReadiness.strongerAction('recalculate', 'repair'), 'recalculate');
    assert.strictEqual(modelReadiness.strongerAction('repair', 'inspect'), 'repair');
    assert.strictEqual(modelReadiness.strongerAction('inspect', 'inspect'), 'inspect');
});

test('readiness: strongerAction is null-safe', () => {
    assert.strictEqual(modelReadiness.strongerAction(null, 'refresh'), 'refresh');
    assert.strictEqual(modelReadiness.strongerAction('refresh', null), 'refresh');
    assert.strictEqual(modelReadiness.strongerAction(null, null), null);
    assert.strictEqual(modelReadiness.strongerAction(undefined, undefined), null);
});
