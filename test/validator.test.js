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
    assert.match(dangling.message, /perspective 'Exec'/);
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
    assert.match(dangling.message, /role 'Viewer'/);
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

// ── Missing DAX user-defined function ─────────────────────────────────────────
// A measure (or any other DAX object) that calls a function the target does not
// have was deployed without a word, and the target model no longer evaluated.
const FN_MARGIN = 'function MarginRatio = (revenue, cost) => DIVIDE(revenue - cost, revenue)\n';
const salesTable = (...extra) => [
    'table Sales',
    '',
    '\tmeasure Revenue = 1',
    '',
    '\tmeasure Cost = 1',
    '',
    ...extra,
    '\tcolumn Amount',
    '\t\tdataType: double',
    ''
].join('\n');

function udfModels(devExtra, prodExtra = [], devFiles = {}, prodFiles = {}) {
    const dev = {
        'database.tmdl': H.databaseTmdl(1702),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': salesTable(...devExtra),
        'functions.tmdl': FN_MARGIN,
        ...devFiles
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(1702),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': salesTable(...prodExtra),
        ...prodFiles
    };
    return setup(dev, prod);
}

test('a measure calling a function missing from the target is blocked', () => {
    const { devModel, prodModel, comparison } = udfModels(['\tmeasure Margin = MarginRatio ( [Revenue], [Cost] )', '']);
    const selected = pick(comparison, d => d.objectType === 'measure' && d.displayName === 'Sales.Margin');
    assert.strictEqual(selected.length, 1);

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    const err = result.errors.find(e => e.code === 'MISSING_FUNCTION');
    assert.ok(err, `expected MISSING_FUNCTION, got ${JSON.stringify(result.errors)}`);
    assert.strictEqual(err.identityKey, selected[0].identityKey);
    assert.match(err.message, /MarginRatio/);
});

test('selecting the function together with the measure passes', () => {
    const { devModel, prodModel, comparison } = udfModels(['\tmeasure Margin = MarginRatio ( [Revenue], [Cost] )', '']);
    const selected = pick(comparison, d =>
        (d.objectType === 'measure' && d.displayName === 'Sales.Margin') || d.objectType === 'function');
    assert.strictEqual(selected.length, 2);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('MISSING_FUNCTION'), JSON.stringify(result.errors));
});

test('a modified measure calling a function the target already has passes', () => {
    const { devModel, prodModel, comparison } = udfModels(
        ['\tmeasure Margin = MarginRatio ( [Revenue], [Cost] ) * 100', ''],
        ['\tmeasure Margin = MarginRatio ( [Revenue], [Cost] )', ''],
        {}, { 'functions.tmdl': FN_MARGIN }
    );
    const selected = pick(comparison, d => d.objectType === 'measure');
    assert.strictEqual(selected.length, 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('MISSING_FUNCTION'), JSON.stringify(result.errors));
});

test('function names inside strings, comments and column refs are not calls', () => {
    const { devModel, prodModel, comparison } = udfModels([
        '\tmeasure Label = "MarginRatio(" & [MarginRatio (old)] // MarginRatio ( x )',
        '',
        "\tmeasure Other = COUNTROWS ( 'MarginRatio (t)' ) /* MarginRatio ( 1, 2 ) */ -- MarginRatio(3)",
        ''
    ]);
    const selected = pick(comparison, d => d.objectType === 'measure');
    assert.strictEqual(selected.length, 2);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('MISSING_FUNCTION'), JSON.stringify(result.errors));
});

test('built-in DAX functions are never reported as missing', () => {
    const { devModel, prodModel, comparison } = udfModels([
        '\tmeasure Safe = DIVIDE ( SUM ( Sales[Amount] ), CALCULATE ( COUNTROWS ( Sales ) ) )',
        ''
    ]);
    const selected = pick(comparison, d => d.objectType === 'measure');
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.deepStrictEqual(result.errors, []);
});

test('calculated columns, RLS filters and functions calling a missing function are blocked', () => {
    const { devModel, prodModel, comparison } = udfModels(
        ['\tcolumn Ratio = MarginRatio ( 2, 1 )', '\t\tdataType: double', ''],
        [],
        {
            'model.tmdl': H.modelTmdl(['table Sales', 'role Viewer']),
            'functions.tmdl': FN_MARGIN + '\nfunction MarginPct = (r, c) => MarginRatio(r, c) * 100\n',
            'roles/Viewer.tmdl': 'role Viewer\n\tmodelPermission: read\n\n\ttablePermission Sales = marginratio(1, 2) > 0\n'
        },
        {
            'model.tmdl': H.modelTmdl(['table Sales', 'role Viewer']),
            'roles/Viewer.tmdl': 'role Viewer\n\tmodelPermission: read\n'
        }
    );
    const selected = pick(comparison, d =>
        (d.objectType === 'column' && d.displayName === 'Sales.Ratio') ||
        d.objectType === 'tablePermission' ||
        (d.objectType === 'function' && d.displayName === 'MarginPct'));
    assert.strictEqual(selected.length, 3, selected.map(d => d.identityKey).join(', '));

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    const flagged = result.errors.filter(e => e.code === 'MISSING_FUNCTION').map(e => e.identityKey).sort();
    assert.deepStrictEqual(flagged, selected.map(d => d.identityKey).sort());
});

test('a calculation item calling a missing function is blocked', () => {
    const cg = item => `table CG\n\n\tcalculationGroup\n\n\t\tcalculationItem Current = ${item}\n`;
    const { devModel, prodModel, comparison } = udfModels([], [],
        { 'model.tmdl': H.modelTmdl(['table Sales', 'table CG']), 'tables/CG.tmdl': cg('MarginRatio(SELECTEDMEASURE(), 1)') },
        { 'model.tmdl': H.modelTmdl(['table Sales', 'table CG']), 'tables/CG.tmdl': cg('SELECTEDMEASURE()') });
    const selected = pick(comparison, d => d.objectType === 'calculationItem');
    assert.strictEqual(selected.length, 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(codes(result.errors).includes('MISSING_FUNCTION'), JSON.stringify(result.errors));
});

test('a calculated table calling a missing function is blocked', () => {
    const calc = source => `table Calc\n\n\tcolumn Value\n\t\tdataType: double\n\n\tpartition Calc = calculated\n\t\tmode: import\n\t\tsource = ${source}\n`;
    const { devModel, prodModel, comparison } = udfModels([], [],
        { 'model.tmdl': H.modelTmdl(['table Sales', 'table Calc']), 'tables/Calc.tmdl': calc('{ MarginRatio(2, 1) }') },
        { 'model.tmdl': H.modelTmdl(['table Sales', 'table Calc']), 'tables/Calc.tmdl': calc('{ 1 }') });
    const selected = pick(comparison, d => d.objectType === 'partition');
    assert.strictEqual(selected.length, 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(codes(result.errors).includes('MISSING_FUNCTION'), JSON.stringify(result.errors));
});

// ── Missing named expression / parameter in Power Query ──────────────────────
// A partition (or named expression) whose M references a query the target does
// not have deployed cleanly, and the next refresh failed.
const partitionTable = source => [
    'table Dates',
    '',
    '\tcolumn Date',
    '\t\tdataType: dateTime',
    '\t\tsourceColumn: Date',
    '',
    '\tpartition Dates = m',
    '\t\tmode: import',
    '\t\tsource =',
    ...source.map(line => `\t\t\t\t${line}`),
    ''
].join('\n');

const HOLIDAYS = [
    "expression 'Holiday Calendar' = {#date(2025, 1, 1)}",
    '',
    'expression fnDays = (n as number) => n',
    '',
    'expression RowCount = 10 meta [IsParameterQuery=true, Type="Number", IsParameterQueryRequired=true]',
    ''
].join('\n');

function mModels(devSource, prodSource, devExpressions = HOLIDAYS, prodExpressions = null) {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Dates']),
        'tables/Dates.tmdl': partitionTable(devSource),
        'expressions.tmdl': devExpressions
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Dates']),
        'tables/Dates.tmdl': partitionTable(prodSource)
    };
    if (prodExpressions) prod['expressions.tmdl'] = prodExpressions;
    return setup(dev, prod);
}

const BASE_M = ['let', '    Base = #table({"Date"}, {})', 'in', '    Base'];
const HOLIDAY_M = ['let', '    Holidays = List.Buffer(#"Holiday Calendar"),', '    Base = #table({"Date"}, {})', 'in', '    Base'];

test('a partition referencing a missing named expression is blocked', () => {
    const { devModel, prodModel, comparison } = mModels(HOLIDAY_M, BASE_M);
    const selected = pick(comparison, d => d.objectType === 'partition');
    assert.strictEqual(selected.length, 1);

    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    const err = result.errors.find(e => e.code === 'MISSING_EXPRESSION');
    assert.ok(err, `expected MISSING_EXPRESSION, got ${JSON.stringify(result.errors)}`);
    assert.strictEqual(err.identityKey, selected[0].identityKey);
    assert.match(err.message, /Holiday Calendar/);
});

test('selecting the named expression together with the partition passes', () => {
    const { devModel, prodModel, comparison } = mModels(HOLIDAY_M, BASE_M);
    const selected = pick(comparison, d =>
        d.objectType === 'partition' || (d.objectType === 'expression' && d.displayName === 'Holiday Calendar'));
    assert.strictEqual(selected.length, 2);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('MISSING_EXPRESSION'), JSON.stringify(result.errors));
});

test('bare identifiers referencing a missing function query or parameter are blocked', () => {
    const { devModel, prodModel, comparison } = mModels(
        ['let', '    Days = List.Transform({1..RowCount}, each fnDays(_)),', '    Base = #table({"Date"}, {})', 'in', '    Base'],
        BASE_M
    );
    const selected = pick(comparison, d => d.objectType === 'partition');
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    const err = result.errors.filter(e => e.code === 'MISSING_EXPRESSION');
    assert.strictEqual(err.length, 1, JSON.stringify(result.errors));
    assert.match(err[0].message, /fnDays/);
    assert.match(err[0].message, /RowCount/);
});

test('names in strings, comments, field access and local steps are not references', () => {
    const { devModel, prodModel, comparison } = mModels(
        [
            'let',
            '    // uses #"Holiday Calendar" and fnDays later',
            '    Label = "fnDays(#""Holiday Calendar"")",',
            '    /* RowCount */',
            '    RowCount = 3,',
            '    Base = #table({"Date", "fnDays"}, {}),',
            '    Pick = Table.SelectRows(Base, each [fnDays] <> RowCount),',
            '    Typed = Table.TransformColumnTypes(Pick, type table [#"Holiday Calendar" = text]),',
            '    Lambda = (fnDays) => fnDays + 1',
            'in',
            '    Typed'
        ],
        BASE_M
    );
    const selected = pick(comparison, d => d.objectType === 'partition');
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(!codes(result.errors).includes('MISSING_EXPRESSION'), JSON.stringify(result.errors));
});

test('a named expression referencing a missing named expression is blocked', () => {
    const exprs = HOLIDAYS + '\nexpression Holidays2 = List.Buffer(#"Holiday Calendar")\n';
    const { devModel, prodModel, comparison } = mModels(BASE_M, BASE_M, exprs);
    const selected = pick(comparison, d => d.objectType === 'expression' && d.displayName === 'Holidays2');
    assert.strictEqual(selected.length, 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.ok(codes(result.errors).includes('MISSING_EXPRESSION'), JSON.stringify(result.errors));
});

test('a referenced expression the target already has passes', () => {
    const { devModel, prodModel, comparison } = mModels(HOLIDAY_M, BASE_M, HOLIDAYS, HOLIDAYS);
    const selected = pick(comparison, d => d.objectType === 'partition');
    assert.strictEqual(selected.length, 1);
    const result = validateDependencies(selected, devModel, prodModel, comparison.diffs);
    assert.deepStrictEqual(result.errors, []);
});
