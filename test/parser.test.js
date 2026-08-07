const test = require('node:test');
const assert = require('node:assert');
const {
    parseTmdlFile, quoteName, parseDeclaration, splitDeclaration, isObjectDeclaration
} = require('../parser/tmdl-parser');

const findChild = (obj, type) => (obj.children || []).find(c => c.type === type);

// ── #48: a /// comment above a top-level ref crashed the whole model load ──────
test('#48 /// description above a top-level ref does not throw', () => {
    const content = [
        'model Model',
        '\tculture: en-US',
        '',
        '/// main fact table',
        'ref table Sales',
        ''
    ].join('\n');

    const objects = parseTmdlFile(content, 'model.tmdl');
    const ref = objects.find(o => o.type === 'ref');
    assert.ok(ref, 'ref object parsed');
    assert.strictEqual(ref.refName, 'Sales');
    assert.strictEqual(ref.properties.description, 'main fact table');
});

// ── #49: object names containing ' = ' were mis-split ─────────────────────────
test("#49 measure named 'A = B' keeps its name and full expression", () => {
    const content = [
        'table T',
        '',
        "\tmeasure 'A = B' = 1 + 1",
        ''
    ].join('\n');

    const table = parseTmdlFile(content, 'tables/T.tmdl')[0];
    const measure = findChild(table, 'measure');
    assert.strictEqual(measure.name, 'A = B');
    assert.strictEqual(measure.expression, '1 + 1');
});

test('#49 splitDeclaration ignores = inside quoted names', () => {
    assert.deepStrictEqual(
        splitDeclaration("measure 'A = B' = 1 + 1"),
        { head: "measure 'A = B'", expr: '1 + 1', hasExpr: true }
    );
    assert.deepStrictEqual(
        splitDeclaration('table Sales'),
        { head: 'table Sales', expr: '', hasExpr: false }
    );
});

test("#49 escaped '' inside a quoted name survives the split", () => {
    const decl = parseDeclaration("table 'Int''l = Sales'");
    assert.strictEqual(decl.type, 'table');
    assert.strictEqual(decl.name, "Int'l = Sales");
});

// ── #50: expression continuation lines misrouted into properties ──────────────
test('#50 DAX continuation at one indent level is not turned into a property', () => {
    const content = [
        'table T',
        '',
        '\tmeasure Total =',
        '\t\tVAR x = 1',
        '\t\tRETURN x',
        '',
        '\t\tformatString: #,0',
        ''
    ].join('\n');

    const table = parseTmdlFile(content, 'tables/T.tmdl')[0];
    const measure = findChild(table, 'measure');
    assert.match(measure.expression, /VAR x = 1/);
    assert.match(measure.expression, /RETURN x/);
    assert.strictEqual(measure.properties['VAR x'], undefined, 'no invented property');
    assert.strictEqual(measure.properties.formatString, '#,0', 'real property still parsed');
});

test('#50 a DAX line containing a colon is not parsed as a property', () => {
    const content = [
        'table T',
        '',
        '\tmeasure M =',
        '\t\tIF(TRUE(), "a:b", "c")',
        ''
    ].join('\n');

    const measure = findChild(parseTmdlFile(content, 'tables/T.tmdl')[0], 'measure');
    assert.match(measure.expression, /IF\(TRUE\(\), "a:b", "c"\)/);
    assert.deepStrictEqual(Object.keys(measure.properties), []);
});

// ── #51: quoteName quoted too few characters ──────────────────────────────────
test('#51 quoteName quotes every name that is not a bare identifier', () => {
    assert.strictEqual(quoteName('Sales'), 'Sales');
    assert.strictEqual(quoteName('Sales_EU2'), 'Sales_EU2');
    assert.strictEqual(quoteName('Sales(EU)'), "'Sales(EU)'");
    assert.strictEqual(quoteName('Sales%'), "'Sales%'");
    assert.strictEqual(quoteName('Sales-EU'), "'Sales-EU'");
    assert.strictEqual(quoteName('Sales, EU'), "'Sales, EU'");
    assert.strictEqual(quoteName('Sales+EU'), "'Sales+EU'");
    assert.strictEqual(quoteName('2024 Sales'), "'2024 Sales'");
    assert.strictEqual(quoteName("Int'l"), "'Int''l'");
    assert.strictEqual(quoteName('Order Date'), "'Order Date'");
});

// ── #19 / #20 / #21 / #56: block types the parser did not recognise ───────────
test('#19 refreshPolicy is parsed as a child block, not swallowed into expression', () => {
    const content = [
        'table Sales',
        '',
        '\trefreshPolicy basic',
        '\t\trollingWindowPeriods: 12',
        '\t\tincrementalPeriods: 3',
        ''
    ].join('\n');

    const table = parseTmdlFile(content, 'tables/Sales.tmdl')[0];
    const policy = findChild(table, 'refreshpolicy');
    assert.ok(policy, 'refreshPolicy parsed as a child');
    assert.match(policy.rawBlock, /rollingWindowPeriods: 12/);
    assert.strictEqual(table.expression, null, 'nothing leaked into table.expression');
});

test('#20 column variation is parsed as a child block', () => {
    const content = [
        'table Sales',
        '',
        '\tcolumn OrderDate',
        '\t\tdataType: dateTime',
        '',
        '\t\tvariation Variation',
        '\t\t\tisDefault',
        '\t\t\trelationship: aaaa-bbbb',
        ''
    ].join('\n');

    const table = parseTmdlFile(content, 'tables/Sales.tmdl')[0];
    const col = findChild(table, 'column');
    assert.ok(findChild(col, 'variation'), 'variation parsed as a child');
    assert.strictEqual(col.expression, null, 'plain data column keeps a null expression');
});

test('#21 formatStringDefinition and detailRowsDefinition are child blocks', () => {
    const content = [
        'table T',
        '',
        '\tmeasure M = 1',
        '',
        '\t\tformatStringDefinition =',
        '\t\t\t\tSWITCH(TRUE(), [M] > 1000, "#,0,K", "#,0")',
        '',
        '\t\tdetailRowsDefinition =',
        '\t\t\t\tSELECTCOLUMNS(T, "x", T[a])',
        ''
    ].join('\n');

    const measure = findChild(parseTmdlFile(content, 'tables/T.tmdl')[0], 'measure');
    const fsd = findChild(measure, 'formatstringdefinition');
    const drd = findChild(measure, 'detailrowsdefinition');
    assert.ok(fsd, 'formatStringDefinition parsed as a child');
    assert.match(fsd.rawBlock, /#,0,K/);
    assert.ok(drd, 'detailRowsDefinition parsed as a child');
    assert.strictEqual(measure.expression, '1', 'measure expression untouched');
});

test('#56 dataAccessOptions and dataCoveragePermission are recognised blocks', () => {
    assert.ok(isObjectDeclaration('dataAccessOptions'));
    assert.ok(isObjectDeclaration('dataCoveragePermission ='));

    const content = [
        'model Model',
        '\tculture: en-US',
        '',
        '\tdataAccessOptions',
        '\t\tlegacyRedirects',
        '\t\treturnErrorValuesAsNull',
        ''
    ].join('\n');

    const model = parseTmdlFile(content, 'model.tmdl')[0];
    const opts = findChild(model, 'dataaccessoptions');
    assert.ok(opts, 'dataAccessOptions parsed as a child');
    assert.match(opts.rawBlock, /legacyRedirects/);
    assert.strictEqual(model.expression, null, 'nothing leaked into model.expression');
});

// ── regression guard: ordinary TMDL still parses the way it did ───────────────
test('regression: ordinary measure/column/partition properties still parse', () => {
    const content = [
        'table Sales',
        '\tisHidden',
        '\tlineageTag: tag-1',
        '',
        '\tcolumn Amount',
        '\t\tdataType: double',
        '\t\tsummarizeBy: sum',
        '\t\tsourceColumn: Amount',
        '',
        '\tmeasure Total = SUM(Sales[Amount])',
        '\t\tformatString: #,0',
        '',
        '\tpartition Sales = m',
        '\t\tmode: import',
        '\t\tsource =',
        '\t\t\t\tlet Source = Sql.Database("s", "d") in Source',
        ''
    ].join('\n');

    const table = parseTmdlFile(content, 'tables/Sales.tmdl')[0];
    assert.strictEqual(table.properties.isHidden, 'true');
    assert.strictEqual(table.properties.lineageTag, 'tag-1');

    const col = findChild(table, 'column');
    assert.strictEqual(col.properties.dataType, 'double');
    assert.strictEqual(col.properties.summarizeBy, 'sum');

    const measure = findChild(table, 'measure');
    assert.strictEqual(measure.expression, 'SUM(Sales[Amount])');
    assert.strictEqual(measure.properties.formatString, '#,0');

    const partition = findChild(table, 'partition');
    assert.strictEqual(partition.expression, 'm');
    assert.strictEqual(partition.properties.mode, 'import');
    assert.match(partition.properties.source, /Sql\.Database/);
});
