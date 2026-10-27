/**
 * Demo Kit regression: the Default Scenario (demo/dev → demo/prod) is the model
 * new users try first and the source of the campaign recordings. It must cover
 * every Change Group, and deploying all of it must leave no difference behind. See docs/adr/0001-demo-kit-single-synthetic-model.md.
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

test('deploying the whole Default Scenario leaves no difference', () => {
    const devModel = loadModelFromFolder(DEV_MODEL);
    const prodPath = H.makeModelFolder(readModel(PROD_MODEL));
    const prodModel = loadModelFromFolder(prodPath);
    const before = compareModels(devModel, prodModel, DEV_MODEL, prodPath);

    const result = deployChanges(before.diffs, devModel, prodPath, { backup: false, prodModel, allDiffs: before.diffs });
    assert.strictEqual(result.success, true, (result.errors || []).map(e => e.error).join(' | '));

    const after = compareModels(devModel, loadModelFromFolder(prodPath), DEV_MODEL, prodPath);
    assert.deepStrictEqual(after.diffs.map(d => `${d.objectType} ${d.displayName}`), []);
});

// Selective deploys that used to pass validation and leave the target broken:
// the Margin % measure without the MarginRatio function, and the Date table
// changes without the Holiday Calendar query their partition reads.
function deployOnly(predicate) {
    const devModel = loadModelFromFolder(DEV_MODEL);
    const prodPath = H.makeModelFolder(readModel(PROD_MODEL));
    const prodModel = loadModelFromFolder(prodPath);
    const before = compareModels(devModel, prodModel, DEV_MODEL, prodPath);
    const selected = before.diffs.filter(predicate);
    const result = deployChanges(selected, devModel, prodPath, { backup: false, prodModel, allDiffs: before.diffs });
    return { selected, result, after: H.readDef(prodPath, 'tables/Sales.tmdl') };
}

test('deploying Margin % without MarginRatio is blocked', () => {
    const { selected, result, after } = deployOnly(d => d.displayName === 'Sales.Margin %');
    assert.strictEqual(selected.length, 1);
    assert.strictEqual(result.success, false);
    assert.match(result.errors.map(e => e.error).join(' | '), /\[MISSING_FUNCTION\].*MarginRatio/);
    assert.doesNotMatch(after, /Margin %/, 'the target is left untouched');

    const both = deployOnly(d => d.displayName === 'Sales.Margin %' || d.displayName === 'MarginRatio');
    assert.strictEqual(both.selected.length, 2);
    assert.strictEqual(both.result.success, true, (both.result.errors || []).map(e => e.error).join(' | '));
});

test('deploying the Date table changes without Holiday Calendar is blocked', () => {
    const { selected, result } = deployOnly(d => d.parentTable === 'Date' && ['partition', 'column'].includes(d.objectType));
    assert.deepStrictEqual(selected.map(d => d.displayName).sort(), ['Date.Date', 'Date.Is Holiday']);
    assert.strictEqual(result.success, false);
    assert.match(result.errors.map(e => e.error).join(' | '), /\[MISSING_EXPRESSION\].*Holiday Calendar/);
});

test("the Price Index group counts tables that read Product's query", () => {
    const result = compareModels(loadModelFromFolder(DEV_MODEL), loadModelFromFolder(PROD_MODEL), DEV_MODEL, PROD_MODEL);
    const group = result.groups.find(g => g.groupId === "param-refresh:Price Index");
    assert.ok(group);
    assert.deepStrictEqual([...group.affectedTables].sort(), ['Product', 'Sales']);
    assert.strictEqual(group.label, "Parameter 'Price Index' affecting 2 tables");
});
