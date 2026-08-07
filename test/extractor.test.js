const test = require('node:test');
const assert = require('node:assert');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { extractAll } = require('../comparison/extractor');
const { childKey, rootKey } = require('../comparison/keys');
const H = require('./helpers/tmdl');

test.after(() => H.cleanup());

/** Compare two definition folders and return the diff list. */
function diffOf(devFiles, prodFiles) {
    const dev = loadModelFromFolder(H.makeModelFolder(devFiles));
    const prod = loadModelFromFolder(H.makeModelFolder(prodFiles));
    return compareModels(dev, prod, 'dev', 'prod');
}

function objectsOf(files) {
    return extractAll(loadModelFromFolder(H.makeModelFolder(files)));
}

const BASE = {
    'database.tmdl': H.databaseTmdl(),
    'model.tmdl': H.modelTmdl(['table Sales'])
};

// ── #19: refreshPolicy changes were invisible ─────────────────────────────────
test('#19 a refreshPolicy change is reported as a diff', () => {
    const table = periods => [
        'table Sales',
        '',
        '\trefreshPolicy basic',
        `\t\trollingWindowPeriods: ${periods}`,
        `\t\tincrementalPeriods: ${periods === 12 ? 3 : 30}`,
        ''
    ].join('\n');

    const result = diffOf(
        { ...BASE, 'tables/Sales.tmdl': table(12) },
        { ...BASE, 'tables/Sales.tmdl': table(60) }
    );
    const diff = result.diffs.find(d => d.objectType === 'table');
    assert.ok(diff, 'table reported as modified');
    assert.ok((diff.propertyDiffs || []).some(p => p.propertyName === 'refreshPolicy'));
});

// ── #20: variation blocks produced phantom expression diffs ───────────────────
test('#20 an identical date column with a per-environment variation GUID is not a diff', () => {
    const table = guid => [
        'table Sales',
        '',
        '\tcolumn OrderDate',
        '\t\tdataType: dateTime',
        '',
        '\t\tvariation Variation',
        '\t\t\tisDefault',
        `\t\t\trelationship: ${guid}`,
        ''
    ].join('\n');

    const dev = objectsOf({ ...BASE, 'tables/Sales.tmdl': table('aaaa-1111') });
    const col = dev[childKey('column', 'Sales', 'OrderDate')];
    assert.strictEqual(col.properties.expression, undefined, 'plain data column has no phantom expression');
    assert.match(col.properties.variations, /relationship: aaaa-1111/);

    // …and a real variation change IS detected
    const result = diffOf(
        { ...BASE, 'tables/Sales.tmdl': table('aaaa-1111') },
        { ...BASE, 'tables/Sales.tmdl': table('bbbb-2222') }
    );
    const diff = result.diffs.find(d => d.objectType === 'column');
    assert.ok(diff && diff.propertyDiffs.some(p => p.propertyName === 'variations'));
});

// ── #21: formatStringDefinition / detailRowsDefinition never detected ─────────
test('#21 a formatStringDefinition change is reported', () => {
    const table = fmt => [
        'table Sales',
        '',
        '\tmeasure Total = SUM(Sales[Amount])',
        '',
        '\t\tformatStringDefinition =',
        `\t\t\t\t${fmt}`,
        ''
    ].join('\n');

    const result = diffOf(
        { ...BASE, 'tables/Sales.tmdl': table('SWITCH(TRUE(), [Total] > 1000, "#,0,K", "#,0")') },
        { ...BASE, 'tables/Sales.tmdl': table('"#,0"') }
    );
    const diff = result.diffs.find(d => d.objectType === 'measure');
    assert.ok(diff, 'measure reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'formatStringDefinition'));
});

test('#21 a flat `formatStringDefinition = value` property is still read', () => {
    const objects = objectsOf({
        ...BASE,
        'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatStringDefinition = "#,0"\n'
    });
    const measure = objects[childKey('measure', 'Sales', 'Total')];
    assert.match(measure.properties.formatStringDefinition, /#,0/);
});

// ── #29: relationship identity included isActive / crossFilteringBehavior ─────
test('#29 flipping isActive is a MODIFY, not an Add + Remove pair', () => {
    const files = isActive => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn DimId\n\t\tdataType: int64\n',
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n',
        'relationships.tmdl': [
            'relationship rel-guid-1',
            `\tisActive: ${isActive}`,
            '\tfromColumn: Sales.DimId',
            '\ttoColumn: Dim.Id',
            ''
        ].join('\n')
    });

    const result = diffOf(files('true'), files('false'));
    const relDiffs = result.diffs.filter(d => d.objectType === 'relationship');
    assert.strictEqual(relDiffs.length, 1, 'exactly one relationship diff');
    assert.strictEqual(relDiffs[0].type, 2, 'reported as modified');
    assert.ok(relDiffs[0].propertyDiffs.some(p => p.propertyName === 'isActive'));
});

// ── #30: partitions keyed by GUID-suffixed name ───────────────────────────────
test('#30 identical partitions with different GUID suffixes are not Added + Removed', () => {
    const files = guid => ({
        ...BASE,
        'tables/Sales.tmdl': [
            'table Sales',
            '',
            `\tpartition Sales-${guid} = m`,
            '\t\tmode: import',
            '\t\tsource =',
            '\t\t\t\tlet Source = Sql.Database("s", "d") in Source',
            ''
        ].join('\n')
    });

    const result = diffOf(
        files('aaaaaaaa-1111-2222-3333-444444444444'),
        files('bbbbbbbb-5555-6666-7777-888888888888')
    );
    const partitionDiffs = result.diffs.filter(d => d.objectType === 'partition');
    assert.deepStrictEqual(partitionDiffs, [], 'no partition diffs for an unchanged partition');
});

test('#30 the real GUID name is still carried for the deployer', () => {
    const objects = objectsOf({
        ...BASE,
        'tables/Sales.tmdl': 'table Sales\n\n\tpartition Sales-aaaaaaaa-1111-2222-3333-444444444444 = m\n\t\tmode: import\n'
    });
    const partition = objects[childKey('partition', 'Sales', 'Sales')];
    assert.ok(partition, 'partition keyed by its normalized name');
    assert.strictEqual(partition.realName, 'Sales-aaaaaaaa-1111-2222-3333-444444444444');
});

// ── finding 4.1: partition key collisions silently dropped an object ─────────
test('4.1 two partitions normalizing to the same base name both survive extractAll', () => {
    const objects = objectsOf({
        ...BASE,
        'tables/Sales.tmdl': [
            'table Sales', '',
            '\tpartition Foo-aaaaaaaa-1111-2222-3333-444444444444 = m',
            '\t\tmode: import',
            '\t\tsource =',
            '\t\t\t\tlet Source = Sql.Database("s", "d1") in Source',
            '',
            '\tpartition Foo-bbbbbbbb-5555-6666-7777-888888888888 = m',
            '\t\tmode: import',
            '\t\tsource =',
            '\t\t\t\tlet Source = Sql.Database("s", "d2") in Source',
            ''
        ].join('\n')
    });
    const partitionKeys = Object.keys(objects).filter(k => k.startsWith('partition:'));
    assert.strictEqual(partitionKeys.length, 2, 'both colliding partitions are kept, not overwritten');
});

test('4.1 DEV/PROD listing the same colliding partitions in opposite file order yields zero diffs', () => {
    const block = (guid, source) => [
        `\tpartition Foo-${guid} = m`,
        '\t\tmode: import',
        '\t\tsource =',
        `\t\t\t\tlet Source = Sql.Database("s", "${source}") in Source`,
        ''
    ].join('\n');

    const devTable = ['table Sales', '',
        block('aaaaaaaa-1111-2222-3333-444444444444', 'd1'),
        block('bbbbbbbb-5555-6666-7777-888888888888', 'd2')
    ].join('\n');
    // Same two partitions, listed in the opposite order, with GUIDs regenerated per environment.
    const prodTable = ['table Sales', '',
        block('22222222-5555-6666-7777-888888888888', 'd2'),
        block('11111111-1111-2222-3333-444444444444', 'd1')
    ].join('\n');

    const result = diffOf(
        { ...BASE, 'tables/Sales.tmdl': devTable },
        { ...BASE, 'tables/Sales.tmdl': prodTable }
    );
    assert.deepStrictEqual(result.diffs.filter(d => d.objectType === 'partition'), []);
});

test('4.1 a genuinely changed partition among collisions is still detected', () => {
    const block = (guid, source) => [
        `\tpartition Foo-${guid} = m`,
        '\t\tmode: import',
        '\t\tsource =',
        `\t\t\t\tlet Source = Sql.Database("s", "${source}") in Source`,
        ''
    ].join('\n');

    const devTable = ['table Sales', '',
        block('aaaaaaaa-1111-2222-3333-444444444444', 'd1'),
        block('bbbbbbbb-5555-6666-7777-888888888888', 'd2')
    ].join('\n');
    const prodTable = ['table Sales', '',
        block('11111111-1111-2222-3333-444444444444', 'd1'),
        block('22222222-5555-6666-7777-888888888888', 'd3') // genuinely different source
    ].join('\n');

    const result = diffOf(
        { ...BASE, 'tables/Sales.tmdl': devTable },
        { ...BASE, 'tables/Sales.tmdl': prodTable }
    );
    const partitionDiffs = result.diffs.filter(d => d.objectType === 'partition');
    assert.strictEqual(partitionDiffs.length, 1, 'only the genuinely changed partition is reported');
});

// ── finding 4.2: relationship ordinal keys were file-order-dependent ─────────
function relPairFiles({ devOrder, prodOrder, prodCross }) {
    const relBlock = (guid, isActive) => [
        `relationship ${guid}`,
        isActive !== undefined ? `\tisActive: ${isActive}` : null,
        prodCross && guid === prodCross.guid ? `\tcrossFilteringBehavior: ${prodCross.value}` : null,
        '\tfromColumn: Sales.DimId',
        '\ttoColumn: Dim.Id',
        ''
    ].filter(l => l !== null).join('\n');

    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn DimId\n\t\tdataType: int64\n',
        'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n'
    };
    return {
        ...base,
        'relationships.tmdl': devOrder.map(([guid, isActive]) => relBlock(guid, isActive)).join('\n')
    };
}

test('4.2 an active+inactive pair listed in opposite order in DEV vs PROD produces zero diffs', () => {
    const dev = relPairFiles({ devOrder: [['11111111-1111-1111-1111-111111111111', 'false'], ['22222222-2222-2222-2222-222222222222', 'true']] });
    // Opposite file order, GUIDs regenerated per environment, semantically identical.
    const prod = relPairFiles({ devOrder: [['44444444-4444-4444-4444-444444444444', 'true'], ['33333333-3333-3333-3333-333333333333', 'false']] });

    const result = diffOf(dev, prod);
    assert.deepStrictEqual(result.diffs.filter(d => d.objectType === 'relationship'), []);
});

test('4.2 one relationship gaining crossFilteringBehavior targets the correct PROD GUID', () => {
    const dev = relPairFiles({ devOrder: [['11111111-1111-1111-1111-111111111111', 'false'], ['22222222-2222-2222-2222-222222222222', 'true']] });
    const prod = relPairFiles({
        devOrder: [['33333333-3333-3333-3333-333333333333', 'false'], ['44444444-4444-4444-4444-444444444444', 'true']],
        prodCross: { guid: '33333333-3333-3333-3333-333333333333', value: 'bothDirections' }
    });

    const result = diffOf(dev, prod);
    const relDiffs = result.diffs.filter(d => d.objectType === 'relationship');
    assert.strictEqual(relDiffs.length, 1, 'exactly one relationship diff');
    assert.strictEqual(relDiffs[0].targetObjectName, '33333333-3333-3333-3333-333333333333', 'targets the relationship that actually changed');
    assert.ok(relDiffs[0].propertyDiffs.some(p => p.propertyName === 'crossFilteringBehavior'));
});

// ── #32: alternateOf never compared ───────────────────────────────────────────
test('#32 an alternateOf change is reported', () => {
    const table = (summarization, base) => [
        'table Agg',
        '',
        '\tcolumn Amount',
        '\t\tdataType: double',
        '',
        '\t\talternateOf',
        `\t\t\tsummarization: ${summarization}`,
        `\t\t\tbaseColumn: ${base}`,
        ''
    ].join('\n');

    const files = (s, b) => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Agg']),
        'tables/Agg.tmdl': table(s, b)
    });

    const result = diffOf(files('sum', 'Sales.Amount'), files('count', 'Sales.OTHER'));
    const diff = result.diffs.find(d => d.objectType === 'column');
    assert.ok(diff, 'column reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'alternateOf'));
});

// ── #33: column property whitelist dropped everything not listed ──────────────
test('#33 isAvailableInMdx (a non-whitelisted property) is compared', () => {
    const files = extra => ({
        ...BASE,
        'tables/Sales.tmdl': `table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n${extra}`
    });

    const result = diffOf(files('\t\tisAvailableInMdx: false\n'), files(''));
    const diff = result.diffs.find(d => d.objectType === 'column');
    assert.ok(diff, 'column reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'isAvailableInMdx'));
});

test('#33 lineageTag stays out of the comparison', () => {
    const files = tag => ({
        ...BASE,
        'tables/Sales.tmdl': `table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n\t\tlineageTag: ${tag}\n\t\tsourceLineageTag: src-${tag}\n`
    });
    const result = diffOf(files('aaa'), files('bbb'));
    assert.deepStrictEqual(result.diffs, [], 'per-environment identifiers are never diffed');
});

// ── #34: culture linguisticMetadata (Q&A synonyms) never compared ─────────────
test('#34 a linguisticMetadata change is reported', () => {
    const files = term => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['cultureInfo en-US']),
        'cultures/en-US.tmdl': [
            'cultureInfo en-US',
            '',
            '\tlinguisticMetadata',
            `\t\tcontent: {"Entities": {"Sales": {"Terms": ["${term}"]}}}`,
            ''
        ].join('\n')
    });

    const result = diffOf(files('revenue'), files('turnover'));
    const diff = result.diffs.find(d => d.objectType === 'culture');
    assert.ok(diff, 'culture reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'linguisticMetadata'));
});

// ── #53: translation walk stopped one level short ─────────────────────────────
test('#53 a translated hierarchy-level caption is reported', () => {
    const files = caption => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['cultureInfo pl-PL']),
        'cultures/pl-PL.tmdl': [
            'cultureInfo pl-PL',
            '',
            '\ttranslations',
            '\t\tmodel Model',
            '\t\t\ttable Sales',
            '\t\t\t\thierarchy Dates',
            '\t\t\t\t\tlevel Year',
            `\t\t\t\t\t\tcaption: ${caption}`,
            ''
        ].join('\n')
    });

    const result = diffOf(files('Rok'), files('ROK ZMIENIONY'));
    const diff = result.diffs.find(d => d.objectType === 'culture');
    assert.ok(diff, 'culture reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'translations'));
});

test('#53 a translated displayFolder is reported', () => {
    const files = folder => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['cultureInfo pl-PL']),
        'cultures/pl-PL.tmdl': [
            'cultureInfo pl-PL',
            '',
            '\ttranslations',
            '\t\tmodel Model',
            '\t\t\ttable Sales',
            '\t\t\t\tmeasure Total',
            '\t\t\t\t\tcaption: Suma',
            `\t\t\t\t\tdisplayFolder: ${folder}`,
            ''
        ].join('\n')
    });

    const result = diffOf(files('Wskazniki'), files('Metryki'));
    const diff = result.diffs.find(d => d.objectType === 'culture');
    assert.ok(diff && diff.propertyDiffs.some(p => p.propertyName === 'translations'));
});

// ── #54: dataSource comparison covered only `type` ────────────────────────────
test('#54 a connectionDetails server change is reported', () => {
    const files = server => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl([]),
        'dataSources.tmdl': [
            'dataSource SqlSource',
            '\ttype: structured',
            '',
            '\tconnectionDetails',
            '\t\tprotocol: tds',
            `\t\tserver: ${server}`,
            ''
        ].join('\n')
    });

    const result = diffOf(files('dev-sql'), files('prod-sql.OTHER.com'));
    const diff = result.diffs.find(d => d.objectType === 'dataSource');
    assert.ok(diff, 'dataSource reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'connectionDetails'));
});

// ── #55: KPI statusGraphic / trendGraphic invisible ───────────────────────────
test('#55 a KPI statusGraphic change is reported', () => {
    const files = graphic => ({
        ...BASE,
        'tables/Sales.tmdl': [
            'table Sales',
            '',
            '\tmeasure Total = 1',
            '',
            '\t\tkpi',
            '\t\t\tstatusExpression = 1',
            `\t\t\tstatusGraphic: ${graphic}`,
            ''
        ].join('\n')
    });

    const result = diffOf(files('Traffic Light'), files('Shapes'));
    const diff = result.diffs.find(d => d.objectType === 'measure');
    assert.ok(diff, 'measure reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'kpi.statusGraphic'));
});

// ── #56: dataAccessOptions was a dead lookup ──────────────────────────────────
test('#56 a dataAccessOptions difference is reported', () => {
    const withOptions = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': 'model Model\n\tculture: en-US\n\n\tdataAccessOptions\n\t\tlegacyRedirects\n\t\treturnErrorValuesAsNull\n'
    };
    const withoutOptions = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': 'model Model\n\tculture: en-US\n'
    };

    const result = diffOf(withOptions, withoutOptions);
    const diff = result.diffs.find(d => d.objectType === 'model');
    assert.ok(diff, 'model reported as modified');
    assert.ok(diff.propertyDiffs.some(p => p.propertyName === 'dataAccessOptions'));
});

// ── #57: ambiguous dot separator in identity keys ─────────────────────────────
test('#57 a dotted table name cannot mask a dotted column name', () => {
    const objects = objectsOf({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(["table A", "table 'A.B'"]),
        'tables/A.tmdl': "table A\n\n\tcolumn 'B.C'\n\t\tdataType: string\n",
        'tables/AB.tmdl': "table 'A.B'\n\n\tcolumn C\n\t\tdataType: string\n"
    });

    const keyOne = childKey('column', 'A', 'B.C');
    const keyTwo = childKey('column', 'A.B', 'C');
    assert.notStrictEqual(keyOne, keyTwo, 'the two columns get distinct keys');
    assert.ok(objects[keyOne], 'A / B.C survives');
    assert.ok(objects[keyTwo], 'A.B / C survives');
});

test('#57 a real change on a dotted column is not swallowed', () => {
    const files = dataType => ({
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(["table A", "table 'A.B'"]),
        'tables/A.tmdl': `table A\n\n\tcolumn 'B.C'\n\t\tdataType: ${dataType}\n`,
        'tables/AB.tmdl': "table 'A.B'\n\n\tcolumn C\n\t\tdataType: string\n"
    });

    const result = diffOf(files('int64'), files('string'));
    const diff = result.diffs.find(d => d.objectType === 'column');
    assert.ok(diff, 'the changed column still produces a diff');
    assert.strictEqual(diff.displayName, 'A.B.C');
});

// ── #58: identity keys were case-sensitive ────────────────────────────────────
test('#58 a case-only rename is one modify, not Add + Remove', () => {
    const files = name => ({
        ...BASE,
        'tables/Sales.tmdl': `table Sales\n\n\tmeasure '${name}' = 1\n`
    });

    const result = diffOf(files('Total Sales'), files('Total SALES'));
    const measureDiffs = result.diffs.filter(d => d.objectType === 'measure');
    assert.strictEqual(measureDiffs.length, 1, 'exactly one measure diff');
    assert.strictEqual(measureDiffs[0].type, 2, 'reported as modified');
    const nameProp = measureDiffs[0].propertyDiffs.find(p => p.propertyName === 'name');
    assert.ok(nameProp, 'the case change surfaces as a name property diff');
    assert.strictEqual(nameProp.devValue, 'Total Sales');
    assert.strictEqual(nameProp.prodValue, 'Total SALES');
});

test('#58 keys fold case for tables too', () => {
    assert.strictEqual(rootKey('table', 'Sales'), rootKey('table', 'SALES'));
});
