const test = require('node:test');
const assert = require('node:assert');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { validateDependencies } = require('../deployment/validator');
const H = require('./helpers/tmdl');

test.after(() => H.cleanup());

function setup(devFiles, prodFiles) {
    const devModel = loadModelFromFolder(H.makeModelFolder(devFiles));
    const prodModel = loadModelFromFolder(H.makeModelFolder(prodFiles));
    const comparison = compareModels(devModel, prodModel, 'dev', 'prod');
    return { devModel, prodModel, comparison };
}

const pick = (comparison, predicate) => comparison.diffs.filter(predicate);
const codes = list => list.map(e => e.code);

// ── #41: calculationItem add was validated without its calculationGroup ───────
test('#41 adding a calculationItem without its calculationGroup is blocked', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': [
            'table CG',
            '',
            '\tcalculationGroup',
            '',
            '\t\tcalculationItem Current = SELECTEDMEASURE()',
            '',
            '\t\tcalculationItem YTD = TOTALYTD(SELECTEDMEASURE(), Dates[Date])',
            ''
        ].join('\n')
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': 'table CG\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    // Select ONLY one calculationItem — not the calculationGroup that must hold it.
    const selected = pick(comparison, d => d.objectType === 'calculationItem' && d.displayName === 'CG.Current');
    assert.strictEqual(selected.length, 1);

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(codes(result.errors).includes('MISSING_CALCULATION_GROUP'), 'the partial selection is blocked');
});

test('#41 selecting the calculationGroup together with the item passes', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': 'table CG\n\n\tcalculationGroup\n\n\t\tcalculationItem Current = SELECTEDMEASURE()\n'
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': 'table CG\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => ['calculationItem', 'calculationGroup'].includes(d.objectType));
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('MISSING_CALCULATION_GROUP'));
});

// ── #44: table removal cascaded relationships only ────────────────────────────
test('#44 removing a table referenced by a perspective is blocked', () => {
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'perspective Exec']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n',
        'perspectives/Exec.tmdl': 'perspective Exec\n\n\tperspectiveTable Sales\n\n\t\tperspectiveColumn Amount\n'
    };
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['perspective Exec']),
        'perspectives/Exec.tmdl': 'perspective Exec\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'table' && d.type === 1);
    assert.strictEqual(selected.length, 1, 'the table removal is in the diff set');

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    const dangling = result.errors.find(e => e.code === 'DANGLING_TABLE_REF');
    assert.ok(dangling, 'the dangling perspective reference is reported');
    assert.match(dangling.message, /perspektywa 'Exec'/);
});

test('#44 removing a table referenced by an RLS role is blocked', () => {
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'role Viewer']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n',
        'roles/Viewer.tmdl': "role Viewer\n\tmodelPermission: read\n\n\ttablePermission Sales = [Amount] > 0\n"
    };
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['role Viewer']),
        'roles/Viewer.tmdl': 'role Viewer\n\tmodelPermission: read\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'table' && d.type === 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    const dangling = result.errors.find(e => e.code === 'DANGLING_TABLE_REF');
    assert.ok(dangling, 'the dangling role reference is reported');
    assert.match(dangling.message, /rola 'Viewer'/);
});

test('#44 selecting the perspective too clears the block', () => {
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'perspective Exec']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n',
        'perspectives/Exec.tmdl': 'perspective Exec\n\n\tperspectiveTable Sales\n\n\t\tperspectiveColumn Amount\n'
    };
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['perspective Exec']),
        'perspectives/Exec.tmdl': 'perspective Exec\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => ['table', 'perspective'].includes(d.objectType));
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('DANGLING_TABLE_REF'));
});

// ── #60: escaped quotes in perspective names blocked valid deploys ────────────
test("#60 a table named Int'l Sales does not raise a false PERSPECTIVE_REF_MISSING", () => {
    const shared = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(["table 'Int''l Sales'", 'perspective Exec']),
        'tables/Intl.tmdl': "table 'Int''l Sales'\n\n\tcolumn Amount\n\t\tdataType: double\n"
    };
    const dev = {
        ...shared,
        'perspectives/Exec.tmdl': "perspective Exec\n\n\tperspectiveTable 'Int''l Sales'\n\n\t\tperspectiveColumn Amount\n"
    };
    const prod = { ...shared, 'perspectives/Exec.tmdl': 'perspective Exec\n' };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'perspective');
    assert.strictEqual(selected.length, 1, 'the perspective change is in the diff set');

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(
        !codes(result.errors).includes('PERSPECTIVE_REF_MISSING'),
        `unexpected block: ${JSON.stringify(result.errors)}`
    );
});

test('#60 a genuinely missing perspective ref is still blocked', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['perspective Exec']),
        'perspectives/Exec.tmdl': 'perspective Exec\n\n\tperspectiveTable Ghost\n'
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['perspective Exec']),
        'perspectives/Exec.tmdl': 'perspective Exec\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'perspective');
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(codes(result.errors).includes('PERSPECTIVE_REF_MISSING'));
});

// ── #61: table-removal cascade used startsWith ────────────────────────────────
test('#61 removing Sales does not cascade the relationship of Sales.EU', () => {
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', "table 'Sales.EU'", 'table Dim']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'tables/SalesEU.tmdl': "table 'Sales.EU'\n\n\tcolumn Id\n\t\tdataType: int64\n",
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'relationships.tmdl': [
            'relationship rel-eu',
            "\tfromColumn: 'Sales.EU'.Id",
            '\ttoColumn: Dim.Id',
            ''
        ].join('\n')
    };
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(["table 'Sales.EU'", 'table Dim']),
        'tables/SalesEU.tmdl': "table 'Sales.EU'\n\n\tcolumn Id\n\t\tdataType: int64\n",
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'relationships.tmdl': [
            'relationship rel-eu',
            "\tfromColumn: 'Sales.EU'.Id",
            '\ttoColumn: Dim.Id',
            ''
        ].join('\n')
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'table' && d.type === 1 && d.displayName === 'Sales');
    assert.strictEqual(selected.length, 1);

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.deepStrictEqual(result.cascadeRels, [], "the surviving table's relationship is left alone");
});

test('#61 a relationship that really belongs to the removed table IS cascaded', () => {
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'relationships.tmdl': 'relationship rel-1\n\tfromColumn: Sales.Id\n\ttoColumn: Dim.Id\n'
    };
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Dim']),
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n'
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'table' && d.type === 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.strictEqual(result.cascadeRels.length, 1, 'the orphaned relationship is cascaded');
});

// ── #29 (validator side): duplicate relationship guard ────────────────────────
test('#29 adding a relationship on a pair the target already uses is blocked', () => {
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn DimId\n\t\tdataType: int64\n',
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'relationships.tmdl': 'relationship rel-prod\n\tfromColumn: Sales.DimId\n\ttoColumn: Dim.Id\n'
    };
    const dev = {
        ...prod,
        // Same pair, twice: the second is genuinely new to the target.
        'relationships.tmdl': [
            'relationship rel-dev-1',
            '\tfromColumn: Sales.DimId',
            '\ttoColumn: Dim.Id',
            '',
            'relationship rel-dev-2',
            '\tisActive: false',
            '\tfromColumn: Sales.DimId',
            '\ttoColumn: Dim.Id',
            ''
        ].join('\n')
    };

    const { devModel, prodModel, comparison } = setup(dev, prod);
    const selected = pick(comparison, d => d.objectType === 'relationship' && d.type === 0);
    assert.strictEqual(selected.length, 1, 'the extra relationship is an Add');

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(codes(result.errors).includes('DUPLICATE_RELATIONSHIP'));
});
