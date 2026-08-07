/**
 * End-to-end round trip: compare a rich DEV model against PROD, deploy every
 * difference, re-compare, and expect nothing left. This is the single strongest
 * assertion that planning, path resolution and the writers agree with the
 * comparison — a silent no-op or a wrong write shows up as a leftover diff.
 */
const test = require('node:test');
const assert = require('node:assert');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { deployChanges } = require('../deployment/deployer');
const H = require('./helpers/tmdl');

test.after(() => H.cleanup());

function model({ measureFormat, columnType, partitionServer, culture, roleFilter, member, exprBody, hidden }) {
    return {
        'database.tmdl': H.databaseTmdl(1567),
        'model.tmdl': [
            'model Model',
            `\tculture: ${culture}`,
            '',
            'ref table Sales',
            'ref table Dim',
            'ref role Viewer',
            'ref perspective Exec',
            'ref cultureInfo pl-PL',
            ''
        ].join('\n'),
        'tables/Sales.tmdl': [
            'table Sales',
            ...(hidden ? ['\tisHidden'] : []),
            '\tlineageTag: sales-tag',
            '',
            '\tcolumn Amount',
            `\t\tdataType: ${columnType}`,
            '\t\tsourceColumn: Amount',
            '\t\tlineageTag: amount-tag',
            '',
            '\tcolumn DimId',
            '\t\tdataType: int64',
            '\t\tsourceColumn: DimId',
            '',
            '\tmeasure Total = SUM(Sales[Amount])',
            `\t\tformatString: ${measureFormat}`,
            '',
            '\thierarchy Geography',
            '',
            '\t\tlevel Country',
            '\t\t\tcolumn: DimId',
            '',
            '\tpartition Sales = m',
            '\t\tmode: import',
            '\t\tsource =',
            `\t\t\t\tlet Source = Sql.Database("${partitionServer}", "db") in Source`,
            ''
        ].join('\n'),
        'tables/Dim.tmdl': [
            'table Dim',
            '',
            '\tcolumn Id',
            '\t\tdataType: int64',
            '\t\tsourceColumn: Id',
            ''
        ].join('\n'),
        'relationships.tmdl': [
            'relationship rel-guid-target',
            '\tfromColumn: Sales.DimId',
            '\ttoColumn: Dim.Id',
            ''
        ].join('\n'),
        'expressions.tmdl': `expression Helper =\n\t\tlet x = ${exprBody} in x\n`,
        'roles/Viewer.tmdl': [
            'role Viewer',
            '\tmodelPermission: read',
            '',
            `\ttablePermission Sales = ${roleFilter}`,
            '',
            `\tmember ${member}`,
            '\t\tmemberType: user',
            ''
        ].join('\n'),
        'perspectives/Exec.tmdl': [
            'perspective Exec',
            '',
            '\tperspectiveTable Sales',
            '',
            '\t\tperspectiveColumn Amount',
            ''
        ].join('\n'),
        'cultures/pl-PL.tmdl': [
            'cultureInfo pl-PL',
            '',
            '\ttranslations',
            '\t\tmodel Model',
            '\t\t\ttable Sales',
            '\t\t\t\tmeasure Total',
            `\t\t\t\t\tcaption: ${measureFormat === '#,0' ? 'Suma' : 'Razem'}`,
            ''
        ].join('\n')
    };
}

const DEV = model({
    measureFormat: '#,0', columnType: 'double', partitionServer: 'dev-sql',
    culture: 'pl-PL', roleFilter: '[Amount] > 100', member: 'dev-user@corp.com',
    exprBody: '1', hidden: true
});
const PROD = model({
    measureFormat: '0.00', columnType: 'int64', partitionServer: 'prod-sql',
    culture: 'en-US', roleFilter: '[Amount] > 0', member: 'dev-user@corp.com',
    exprBody: '2', hidden: false
});

test('round trip: deploying every diff leaves nothing to deploy', () => {
    const devPath = H.makeModelFolder(DEV);
    const prodPath = H.makeModelFolder(PROD);

    const devModel = loadModelFromFolder(devPath);
    const prodModel = loadModelFromFolder(prodPath);
    const before = compareModels(devModel, prodModel, devPath, prodPath);

    assert.ok(before.diffs.length >= 6, `expected a rich diff set, got ${before.diffs.length}`);
    const kinds = new Set(before.diffs.map(d => d.objectType));
    for (const kind of ['table', 'column', 'measure', 'partition', 'expression', 'tablePermission', 'culture', 'model']) {
        assert.ok(kinds.has(kind), `expected a ${kind} diff, got: ${[...kinds].join(', ')}`);
    }

    const result = deployChanges(before.diffs, devModel, prodPath, {
        backup: false, prodModel, allDiffs: before.diffs
    });
    assert.strictEqual(result.success, true, (result.errors || []).map(e => e.error).join(' | '));
    assert.ok(!result.rolledBack, 'no rollback');

    // Re-load the target from disk and compare again.
    const after = compareModels(devModel, loadModelFromFolder(prodPath), devPath, prodPath);
    assert.deepStrictEqual(
        after.diffs.map(d => `${d.objectType} ${d.displayName}`),
        [],
        'the target now matches the source'
    );
});

test('round trip: per-environment identifiers are NOT copied from source', () => {
    const devPath = H.makeModelFolder(DEV);
    const prodPath = H.makeModelFolder({
        ...PROD,
        // The target carries its own lineage tags; they must survive the deploy.
        'tables/Sales.tmdl': PROD['tables/Sales.tmdl']
            .replace('lineageTag: sales-tag', 'lineageTag: PROD-sales')
            .replace('lineageTag: amount-tag', 'lineageTag: PROD-amount')
    });

    const devModel = loadModelFromFolder(devPath);
    const prodModel = loadModelFromFolder(prodPath);
    const comparison = compareModels(devModel, prodModel, devPath, prodPath);

    const result = deployChanges(comparison.diffs, devModel, prodPath, {
        backup: false, prodModel, allDiffs: comparison.diffs
    });
    assert.strictEqual(result.success, true, (result.errors || []).map(e => e.error).join(' | '));

    const written = H.readDef(prodPath, 'tables/Sales.tmdl');
    assert.match(written, /lineageTag: PROD-sales/, "the table's target lineage tag survives");
    assert.match(written, /lineageTag: PROD-amount/, "the column's target lineage tag survives");
    assert.ok(!written.includes('sales-tag'), "the source's table lineage tag is not copied");
    assert.ok(!written.includes('amount-tag'), "the source's column lineage tag is not copied");
});

test('round trip: an identical pair of models produces no diffs and no operations', () => {
    const devPath = H.makeModelFolder(DEV);
    const prodPath = H.makeModelFolder(DEV);
    const devModel = loadModelFromFolder(devPath);
    const prodModel = loadModelFromFolder(prodPath);

    const comparison = compareModels(devModel, prodModel, devPath, prodPath);
    assert.deepStrictEqual(comparison.diffs, [], 'identical models compare clean');
    assert.deepStrictEqual(comparison.renames, [], 'and report no renames');
});
