const test = require('node:test');
const assert = require('node:assert');
const { mergeDeployResultIntoResponse } = require('../lib/deploy-response');

// ── finding 4.5: Fabric deploy warnings/actions were dropped ────────────────
test('#4.5 warnings from a local deployChanges() are surfaced on the Fabric response', () => {
    const result = {
        success: true,
        actions: [{ type: 'backup', message: 'Backup created: /tmp/backup' }],
        errors: []
    };
    const deployResult = {
        success: true,
        actions: [{ type: 'applied', objectType: 'measure', name: 'Total' }],
        warnings: [{ code: 'UNREVIEWED_BLOCK_CHANGES', operation: {}, message: 'unreviewed block change' }]
    };

    mergeDeployResultIntoResponse(result, deployResult);

    assert.deepStrictEqual(
        result.actions.map(a => a.type),
        ['backup', 'applied'],
        'the backup action recorded before the upload must survive the merge'
    );
    assert.ok(result.warnings, 'warnings must be present on the response');
    assert.strictEqual(result.warnings.length, 1);
    assert.strictEqual(result.warnings[0].code, 'UNREVIEWED_BLOCK_CHANGES');
});

test('#4.5 a deploy result with no warnings does not add an empty warnings array', () => {
    const result = { success: true, actions: [], errors: [] };
    mergeDeployResultIntoResponse(result, { actions: [{ type: 'applied' }] });
    assert.strictEqual(result.warnings, undefined);
});
