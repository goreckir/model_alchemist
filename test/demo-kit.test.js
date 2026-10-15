/**
 * Demo Kit regression: the Default Scenario (demo/dev → demo/prod) is the model
 * new users try first and the source of the campaign recordings. It must cover
 * every Change Group, and deploying it must leave only the Prod-only RLS members
 * behind. See docs/adr/0001-demo-kit-single-synthetic-model.md.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { deployChanges } = require('../deployment/deployer');
const { CHANGE_GROUPS } = require('../comparison/extractor');
const { readModel, buildProd, DEV_MODEL, PROD_MODEL } = require('../demo/scenarios');
const H = require('./helpers/tmdl');

test.after(() => H.cleanup());

test('demo/prod is exactly what demo/scenarios.js derives from demo/dev', () => {
    const expected = buildProd(readModel(DEV_MODEL));
    const actual = readModel(PROD_MODEL);
    assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const file of Object.keys(expected)) {
        assert.strictEqual(actual[file], expected[file], `${file} is stale; run node demo/scenarios.js`);
    }
});

test('Default Scenario covers every Change Group', () => {
    const result = compareModels(loadModelFromFolder(DEV_MODEL), loadModelFromFolder(PROD_MODEL), DEV_MODEL, PROD_MODEL);
    const covered = new Set(result.diffs.map(d => d.changeGroup));
    const missing = Object.values(CHANGE_GROUPS).filter(group => !covered.has(group));
    assert.deepStrictEqual(missing, [], `Change Groups without a difference: ${missing.join(', ')}`);
});

test('deploying the Default Scenario leaves only the Prod-only RLS members', () => {
    const devModel = loadModelFromFolder(DEV_MODEL);
    const prodPath = H.makeModelFolder(readModel(PROD_MODEL));
    const prodModel = loadModelFromFolder(prodPath);
    const before = compareModels(devModel, prodModel, DEV_MODEL, prodPath);

    const selected = before.diffs.filter(d => d.objectType !== 'roleMember');
    const result = deployChanges(selected, devModel, prodPath, { backup: false, prodModel, allDiffs: before.diffs });
    assert.strictEqual(result.success, true, (result.errors || []).map(e => e.error).join(' | '));

    const after = compareModels(devModel, loadModelFromFolder(prodPath), DEV_MODEL, prodPath);
    assert.deepStrictEqual(
        after.diffs.map(d => `${d.objectType} ${d.displayName}`).sort(),
        [
            'roleMember Regional Manager → auditor@apothecary.example',
            'roleMember Regional Manager → manager.north@apothecary.example'
        ]
    );
});
