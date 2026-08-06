const test = require('node:test');
const assert = require('node:assert');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { parseColumnRef, tableFromColRef, colFromRef } = require('../comparison/refs');
const { childKey } = require('../comparison/keys');
const H = require('./helpers/tmdl');

test.after(() => H.cleanup());

function compare(devFiles, prodFiles) {
    const dev = loadModelFromFolder(H.makeModelFolder(devFiles));
    const prod = loadModelFromFolder(H.makeModelFolder(prodFiles));
    return compareModels(dev, prod, 'dev', 'prod');
}

// ── #31: quoted column refs in relationship endpoints ─────────────────────────
test('#31 parseColumnRef unquotes both parts', () => {
    assert.deepStrictEqual(parseColumnRef("Sales.'Order Date'"), { table: 'Sales', column: 'Order Date' });
    assert.deepStrictEqual(parseColumnRef("'Sales EU'.Amount"), { table: 'Sales EU', column: 'Amount' });
    assert.deepStrictEqual(parseColumnRef("'Sales EU'.'Order Date'"), { table: 'Sales EU', column: 'Order Date' });
    assert.deepStrictEqual(parseColumnRef('Sales.Amount'), { table: 'Sales', column: 'Amount' });
    assert.deepStrictEqual(parseColumnRef("'Int''l'.Amount"), { table: "Int'l", column: 'Amount' });
    assert.strictEqual(colFromRef("Sales.'Order Date'"), 'Order Date');
    assert.strictEqual(tableFromColRef("'Sales.EU'.Amount"), 'Sales.EU');
});

test('#31 a relationship on a quoted column is grouped with that column', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
        'tables/Sales.tmdl': "table Sales\n\n\tcolumn 'Order Date'\n\t\tdataType: dateTime\n",
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: dateTime\n',
        'relationships.tmdl': [
            'relationship rel-1',
            "\tfromColumn: Sales.'Order Date'",
            '\ttoColumn: Dim.Id',
            ''
        ].join('\n')
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
        'tables/Sales.tmdl': 'table Sales\n',
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: dateTime\n'
    };

    const result = compare(dev, prod);
    const relDiff = result.diffs.find(d => d.objectType === 'relationship');
    const colKey = childKey('column', 'Sales', 'Order Date');
    const group = result.groups.find(g => g.memberKeys.includes(relDiff.identityKey));

    assert.ok(group, 'the relationship is in a group');
    assert.ok(group.memberKeys.includes(colKey), 'the quoted endpoint column is in the same group');
});

// ── #59: refresh groups absorbed every diff of the table ──────────────────────
test('#59 a metadata-only measure change is not pulled into a partition refresh group', () => {
    const files = (source, fmt) => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': [
            'table Sales',
            '',
            '\tmeasure Total = 1',
            `\t\tformatString: ${fmt}`,
            '',
            '\tpartition Sales = m',
            '\t\tmode: import',
            '\t\tsource =',
            `\t\t\t\tlet Source = ${source} in Source`,
            ''
        ].join('\n')
    });

    const result = compare(files('Sql.Database("dev", "d")', '#,0'), files('Sql.Database("prod", "d")', '0.00'));
    const measureDiff = result.diffs.find(d => d.objectType === 'measure');
    const partitionDiff = result.diffs.find(d => d.objectType === 'partition');
    assert.ok(measureDiff && partitionDiff, 'both changes detected');

    const group = result.groups.find(g => g.memberKeys.includes(partitionDiff.identityKey));
    assert.ok(group, 'the partition change forms a refresh group');
    assert.ok(
        !group.memberKeys.includes(measureDiff.identityKey),
        'the unrelated formatString fix stays independent'
    );
});

test('#59 a structural column change IS pulled into the partition refresh group', () => {
    const files = (source, dataType) => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': [
            'table Sales',
            '',
            '\tcolumn Amount',
            `\t\tdataType: ${dataType}`,
            '\t\tsourceColumn: Amount',
            '',
            '\tpartition Sales = m',
            '\t\tmode: import',
            '\t\tsource =',
            `\t\t\t\tlet Source = ${source} in Source`,
            ''
        ].join('\n')
    });

    const result = compare(files('Sql.Database("dev", "d")', 'double'), files('Sql.Database("prod", "d")', 'int64'));
    const columnDiff = result.diffs.find(d => d.objectType === 'column');
    const partitionDiff = result.diffs.find(d => d.objectType === 'partition');
    const group = result.groups.find(g => g.memberKeys.includes(partitionDiff.identityKey));
    assert.ok(group.memberKeys.includes(columnDiff.identityKey), 'dataType change travels with the partition');
});

// ── #46: a diff belonging to two atomic groups ────────────────────────────────
test('#46 every diff belongs to at most one group', () => {
    // One shared M expression feeding two tables: it used to land in both
    // refresh:TableA and refresh:TableB with independent checkboxes.
    const files = body => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table TableA', 'table TableB']),
        'expressions.tmdl': `expression LoadData =\n\t\tlet x = ${body} in x\n`,
        'tables/TableA.tmdl': 'table TableA\n\n\tpartition TableA = m\n\t\tmode: import\n\t\tsource =\n\t\t\t\tLoadData\n',
        'tables/TableB.tmdl': 'table TableB\n\n\tpartition TableB = m\n\t\tmode: import\n\t\tsource =\n\t\t\t\tLoadData\n'
    });

    const result = compare(files('1'), files('2'));
    const seen = new Map();
    for (const group of result.groups) {
        for (const key of group.memberKeys) {
            assert.ok(
                !seen.has(key),
                `${key} appears in both "${seen.get(key)}" and "${group.groupId}"`
            );
            seen.set(key, group.groupId);
        }
    }
    assert.ok(seen.size > 0, 'groups were actually produced');
});

// ── #73: no rename detection ──────────────────────────────────────────────────
test('#73 a renamed table is detected and grouped with a data-loss warning', () => {
    const table = name => [
        `table ${name}`,
        '',
        '\tcolumn Amount',
        '\t\tdataType: double',
        '\t\tsourceColumn: Amount',
        '',
        '\tmeasure Total = 1',
        ''
    ].join('\n');

    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table FactSales']),
        'tables/FactSales.tmdl': table('FactSales')
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': table('Sales')
    };

    const result = compare(dev, prod);
    assert.strictEqual(result.renames.length, 1, 'exactly one rename detected');
    const rename = result.renames[0];
    assert.strictEqual(rename.objectType, 'table');
    assert.strictEqual(rename.fromName, 'Sales');
    assert.strictEqual(rename.toName, 'FactSales');

    const group = result.groups.find(g => g.isRename);
    assert.ok(group, 'a rename group exists');
    assert.match(group.reason, /all partition data is discarded/);
    // Both sides of the rename plus all their children travel together.
    assert.ok(group.memberKeys.includes(rename.addedKey));
    assert.ok(group.memberKeys.includes(rename.removedKey));
    assert.ok(group.memberKeys.includes(childKey('column', 'FactSales', 'Amount')));
    assert.ok(group.memberKeys.includes(childKey('column', 'Sales', 'Amount')));
});

test('#73 a renamed measure is detected', () => {
    const files = name => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': `table Sales\n\n\tmeasure ${name} = SUM(Sales[Amount])\n\t\tformatString: #,0\n`
    });

    const result = compare(files('Revenue'), files('Turnover'));
    assert.strictEqual(result.renames.length, 1);
    assert.deepStrictEqual(
        { from: result.renames[0].fromName, to: result.renames[0].toName },
        { from: 'Sales.Turnover', to: 'Sales.Revenue' }
    );
});

test('#73 ambiguous candidates are dropped instead of guessed', () => {
    // Two identical added measures and two identical removed measures: any pairing
    // would be a coin flip, so nothing is reported.
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': 'table Sales\n\n\tmeasure NewA = 1\n\n\tmeasure NewB = 1\n'
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': 'table Sales\n\n\tmeasure OldA = 1\n\n\tmeasure OldB = 1\n'
    };

    const result = compare(dev, prod);
    assert.deepStrictEqual(result.renames, [], 'no ambiguous rename is reported');
});

test('#73 an unchanged model reports no renames', () => {
    const files = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales']),
        'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n'
    };
    const result = compare(files, files);
    assert.deepStrictEqual(result.diffs, []);
    assert.deepStrictEqual(result.renames, []);
});
