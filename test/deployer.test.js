const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { deployChanges, planFileOperations } = require('../deployment/deployer');
const { appendChildBlockNested, mergeModelBlock, preserveLineageTags } = require('../deployment/tmdl-writer');
const H = require('./helpers/tmdl');

test.after(() => H.cleanup());

/** Build DEV + PROD folders, compare, and return everything a deploy needs. */
function scenario(devFiles, prodFiles) {
    const devPath = H.makeModelFolder(devFiles);
    const prodPath = H.makeModelFolder(prodFiles);
    const devModel = loadModelFromFolder(devPath);
    const prodModel = loadModelFromFolder(prodPath);
    const comparison = compareModels(devModel, prodModel, devPath, prodPath);
    return { devPath, prodPath, devModel, prodModel, comparison };
}

function deploy(s, predicate, options = {}) {
    const selected = s.comparison.diffs.filter(predicate);
    return {
        selected,
        result: deployChanges(selected, s.devModel, s.prodPath, {
            backup: false, prodModel: s.prodModel, allDiffs: s.comparison.diffs, ...options
        })
    };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf-8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const errorText = result => (result.errors || []).map(e => e.error).join(' | ');

const TWO_TABLES = {
    'database.tmdl': H.databaseTmdl(),
    'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']),
    'tables/Sales.tmdl': 'table Sales\n\n\tcolumn DimId\n\t\tdataType: int64\n',
    'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n'
};

// ── #23: adding a relationship when relationships.tmdl does not exist ─────────
test('#23 adding a relationship creates relationships.tmdl instead of silently doing nothing', () => {
    const dev = {
        ...TWO_TABLES,
        'relationships.tmdl': 'relationship rel-1\n\tfromColumn: Sales.DimId\n\ttoColumn: Dim.Id\n'
    };
    const s = scenario(dev, TWO_TABLES); // PROD has no relationships.tmdl at all
    assert.ok(!exists(s.prodPath, 'relationships.tmdl'), 'precondition: target file missing');

    const { result } = deploy(s, d => d.objectType === 'relationship');
    assert.strictEqual(result.success, true, errorText(result));
    assert.ok(exists(s.prodPath, 'relationships.tmdl'), 'the file was created');
    assert.match(read(s.prodPath, 'relationships.tmdl'), /fromColumn: Sales\.DimId/);
});

// ── #24: adding a calculation group wrote every item twice ────────────────────
test('#24 adding a calculation group writes each calculationItem exactly once', () => {
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
        'tables/CG.tmdl': 'table CG\n\n\tcolumn Name\n\t\tdataType: string\n'
    };

    const s = scenario(dev, prod);
    const { result } = deploy(s, d => ['calculationGroup', 'calculationItem'].includes(d.objectType));
    assert.strictEqual(result.success, true, errorText(result));

    const written = read(s.prodPath, 'tables/CG.tmdl');
    const count = needle => written.split(needle).length - 1;
    assert.strictEqual(count('calculationItem Current'), 1, 'Current written once');
    assert.strictEqual(count('calculationItem YTD'), 1, 'YTD written once');
    assert.strictEqual(count('calculationGroup'), 1, 'calculationGroup written once');
});

// ── #25: roleMember diffs had no planner case ─────────────────────────────────
test('#25 adding an RLS role member actually writes it', () => {
    const roleFile = members => [
        'role Viewer',
        '\tmodelPermission: read',
        '',
        '\ttablePermission Sales = [Amount] > 0',
        ...members.map(m => ['', `\tmember ${m}`, '\t\tmemberType: user']).flat(),
        ''
    ].join('\n');

    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'role Viewer']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n'
    };
    const s = scenario(
        { ...base, 'roles/Viewer.tmdl': roleFile(['alice@corp.com', 'bob@corp.com']) },
        { ...base, 'roles/Viewer.tmdl': roleFile(['alice@corp.com']) }
    );

    const { selected, result } = deploy(s, d => d.objectType === 'roleMember');
    assert.strictEqual(selected.length, 1, 'the new member is a diff');
    assert.strictEqual(result.success, true, errorText(result));
    assert.ok(result.actions.some(a => a.type === 'applied'), 'an operation was applied');
    assert.match(read(s.prodPath, 'roles/Viewer.tmdl'), /member bob@corp\.com/);
});

test('#25 removing an RLS role member actually removes it', () => {
    const roleFile = members => [
        'role Viewer',
        '\tmodelPermission: read',
        ...members.map(m => ['', `\tmember ${m}`, '\t\tmemberType: user']).flat(),
        ''
    ].join('\n');

    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['role Viewer'])
    };
    const s = scenario(
        { ...base, 'roles/Viewer.tmdl': roleFile(['alice@corp.com']) },
        { ...base, 'roles/Viewer.tmdl': roleFile(['alice@corp.com', 'bob@corp.com']) }
    );

    const { result } = deploy(s, d => d.objectType === 'roleMember' && d.type === 1);
    assert.strictEqual(result.success, true, errorText(result));
    const written = read(s.prodPath, 'roles/Viewer.tmdl');
    assert.ok(!written.includes('bob@corp.com'), 'bob removed');
    assert.match(written, /member alice@corp\.com/, 'alice kept');
});

// ── #26: tablePermission modify overwrote the whole role file ─────────────────
test('#26 changing one RLS filter keeps the PROD role members', () => {
    const roleFile = (filter, members) => [
        'role Viewer',
        '\tmodelPermission: read',
        '',
        `\ttablePermission Sales = ${filter}`,
        ...members.map(m => ['', `\tmember ${m}`, '\t\tmemberType: user']).flat(),
        ''
    ].join('\n');

    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'role Viewer']),
        'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Amount\n\t\tdataType: double\n'
    };
    const s = scenario(
        { ...base, 'roles/Viewer.tmdl': roleFile('[Amount] > 100', ['dev-user@corp.com']) },
        { ...base, 'roles/Viewer.tmdl': roleFile('[Amount] > 0', ['prod-user@corp.com']) }
    );

    const { result } = deploy(s, d => d.objectType === 'tablePermission');
    assert.strictEqual(result.success, true, errorText(result));

    const written = read(s.prodPath, 'roles/Viewer.tmdl');
    assert.match(written, /\[Amount\] > 100/, 'the selected filter change is deployed');
    assert.match(written, /member prod-user@corp\.com/, 'PROD membership is preserved');
    assert.ok(!written.includes('dev-user@corp.com'), 'DEV membership is NOT pushed to PROD');
});

// ── #39: file paths were rebuilt from object names ────────────────────────────
test('#39 a table whose file name differs from its name still deploys', () => {
    const table = hidden => `table 'Sales EU'\n${hidden ? '\tisHidden\n' : ''}\n\tcolumn Amount\n\t\tdataType: double\n`;
    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(["table 'Sales EU'"])
    };
    // The table lives in Table_001.tmdl, not in "Sales EU.tmdl".
    const s = scenario(
        { ...base, 'tables/Table_001.tmdl': table(true) },
        { ...base, 'tables/Table_001.tmdl': table(false) }
    );

    const { selected, result } = deploy(s, d => d.objectType === 'table');
    assert.strictEqual(selected.length, 1, 'the table change is a diff');
    assert.strictEqual(result.success, true, errorText(result));
    assert.match(read(s.prodPath, 'tables/Table_001.tmdl'), /isHidden/);
    assert.ok(result.actions.some(a => a.file === 'tables/Table_001.tmdl'), 'the real file is reported');
});

test('#39 a missing DEV source is reported as an error, not silent success', () => {
    const s = scenario(TWO_TABLES, TWO_TABLES);
    const fakeDiff = {
        type: 2, objectType: 'table', identityKey: 'table:ghost', displayName: 'Ghost',
        sourceFile: 'tables/Ghost.tmdl', rawBlock: 'table Ghost\n', propertyDiffs: []
    };
    const result = deployChanges([fakeDiff], s.devModel, s.prodPath, { backup: false, prodModel: s.prodModel });
    assert.strictEqual(result.success, false);
    assert.match(errorText(result), /Source block .* was not found/);
});

// ── #40: child object name derived by splitting displayName on dots ───────────
test('#40 removing a calculation group works', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': 'table CG\n\n\tcolumn Name\n\t\tdataType: string\n'
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': [
            'table CG',
            '',
            '\tcolumn Name',
            '\t\tdataType: string',
            '',
            '\tcalculationGroup',
            '\t\tprecedence: 10',
            ''
        ].join('\n')
    };

    const s = scenario(dev, prod);
    const { selected, result } = deploy(s, d => d.objectType === 'calculationGroup');
    assert.strictEqual(selected.length, 1, 'the calculation group removal is a diff');
    assert.strictEqual(result.success, true, errorText(result));
    assert.ok(!read(s.prodPath, 'tables/CG.tmdl').includes('calculationGroup'), 'the block is gone');
});

test('#40 a measure on a table whose name contains a dot can be modified', () => {
    const table = fmt => `table 'v1.2 Metrics'\n\n\tmeasure Total = 1\n\t\tformatString: ${fmt}\n`;
    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(["table 'v1.2 Metrics'"])
    };
    const s = scenario(
        { ...base, 'tables/metrics.tmdl': table('#,0') },
        { ...base, 'tables/metrics.tmdl': table('0.00') }
    );

    const { result } = deploy(s, d => d.objectType === 'measure');
    assert.strictEqual(result.success, true, errorText(result));
    assert.match(read(s.prodPath, 'tables/metrics.tmdl'), /formatString: #,0/);
});

// ── #41: calculationItem insert fell back to an invalid indent-2 append ───────
test('#41 appendChildBlockNested refuses to append when the parent block is missing', () => {
    const content = 'table CG\n\n\tcolumn Name\n\t\tdataType: string\n';
    const result = appendChildBlockNested(content, '\t\tcalculationItem X = 1', 1);
    assert.strictEqual(result, null, 'no invalid TMDL is produced');
});

test('#41 a partial calculationItem selection is blocked with a clear error', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': 'table CG\n\n\tcalculationGroup\n\n\t\tcalculationItem Current = SELECTEDMEASURE()\n'
    };
    const prod = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table CG']),
        'tables/CG.tmdl': 'table CG\n\n\tcolumn Name\n\t\tdataType: string\n'
    };

    const s = scenario(dev, prod);
    const before = read(s.prodPath, 'tables/CG.tmdl');
    const { result } = deploy(s, d => d.objectType === 'calculationItem');

    assert.strictEqual(result.success, false, 'the deploy is blocked');
    assert.match(errorText(result), /MISSING_CALCULATION_GROUP/);
    assert.strictEqual(read(s.prodPath, 'tables/CG.tmdl'), before, 'the target file is untouched');
});

// ── #42 / #72: lineage tags on a header replacement ───────────────────────────
test('#42 modifying a table header preserves the target lineageTag', () => {
    const table = (hidden, tag) => [
        'table Sales',
        ...(hidden ? ['\tisHidden'] : []),
        `\tlineageTag: ${tag}`,
        '',
        '\tcolumn Amount',
        '\t\tdataType: double',
        `\t\tlineageTag: col-${tag}`,
        ''
    ].join('\n');

    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': table(true, 'DEV') },
        { ...base, 'tables/Sales.tmdl': table(false, 'PROD') }
    );

    const { result } = deploy(s, d => d.objectType === 'table');
    assert.strictEqual(result.success, true, errorText(result));

    const written = read(s.prodPath, 'tables/Sales.tmdl');
    assert.match(written, /isHidden/, 'the reviewed change is deployed');
    assert.match(written, /lineageTag: PROD/, 'the target lineage tag survives');
    assert.ok(!written.includes('lineageTag: DEV'), "DEV's lineage tag is not copied");
});

test('#72 sourceLineageTag is preserved, not just lineageTag', () => {
    const oldBlock = '\tcolumn Amount\n\t\tlineageTag: PROD-1\n\t\tsourceLineageTag: PROD-SRC\n';
    const newBlock = '\tcolumn Amount\n\t\tlineageTag: DEV-1\n\t\tsourceLineageTag: DEV-SRC\n';
    const merged = preserveLineageTags(oldBlock, newBlock);
    assert.match(merged, /lineageTag: PROD-1/);
    assert.match(merged, /sourceLineageTag: PROD-SRC/);
    assert.ok(!merged.includes('DEV-SRC'), 'DEV sourceLineageTag is not deployed');
});

test('#72 PBI_* annotations are excluded from comparison AND from deployment', () => {
    const table = (fmt, hint) => [
        'table Sales',
        '',
        '\tmeasure Total = 1',
        `\t\tformatString: ${fmt}`,
        '',
        `\t\tannotation PBI_FormatHint = ${hint}`,
        ''
    ].join('\n');

    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': table('#,0', '{"isDevHint":true}') },
        { ...base, 'tables/Sales.tmdl': table('0.00', '{"isProdHint":true}') }
    );

    const { result } = deploy(s, d => d.objectType === 'measure');
    assert.strictEqual(result.success, true, errorText(result));

    const written = read(s.prodPath, 'tables/Sales.tmdl');
    assert.match(written, /formatString: #,0/, 'the reviewed change is deployed');
    assert.match(written, /isProdHint/, 'the target PBI_* annotation survives');
    assert.ok(!written.includes('isDevHint'), 'the DEV PBI_* annotation is not deployed');
});

test('#72 the preview names block content that ships beyond the reviewed properties', () => {
    // `changedProperty` is not part of the measure comparison, but a block-level
    // modify deploys it anyway. The preview must say so.
    const table = (fmt, changed) => [
        'table Sales',
        '',
        '\tmeasure Total = 1',
        `\t\tformatString: ${fmt}`,
        `\t\tchangedProperty = ${changed}`,
        ''
    ].join('\n');

    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': table('#,0', 'FormatString') },
        { ...base, 'tables/Sales.tmdl': table('0.00', 'IsHidden') }
    );

    const selected = s.comparison.diffs.filter(d => d.objectType === 'measure');
    const reviewed = selected[0].propertyDiffs.map(p => p.propertyName);
    assert.ok(reviewed.includes('formatString'), 'formatString is reviewed');
    assert.ok(!reviewed.includes('changedProperty'), 'changedProperty is NOT reviewed');

    const { result } = deploy(s, d => d.objectType === 'measure', { dryRun: true });
    const warning = (result.warnings || []).find(w => w.code === 'UNREVIEWED_BLOCK_CHANGES');
    assert.ok(warning, 'the preview warns about unreviewed block content');
    assert.match(warning.message, /changedProperty/);
});

// ── #43: model-properties modify replaced the whole model block ───────────────
test('#43 a model modify keeps refs indented inside the model block', () => {
    const modelFile = (culture, indentRefs) => {
        const refIndent = indentRefs ? '\t' : '';
        return [
            'model Model',
            `\tculture: ${culture}`,
            '',
            `${refIndent}ref table Sales`,
            `${refIndent}ref table Dim`,
            ''
        ].join('\n');
    };

    const s = scenario(
        {
            'database.tmdl': H.databaseTmdl(),
            'model.tmdl': modelFile('pl-PL', false), // DEV uses column-0 refs
            'tables/Sales.tmdl': 'table Sales\n',
            'tables/Dim.tmdl': 'table Dim\n'
        },
        {
            'database.tmdl': H.databaseTmdl(),
            'model.tmdl': modelFile('en-US', true), // TARGET indents refs under the model
            'tables/Sales.tmdl': 'table Sales\n',
            'tables/Dim.tmdl': 'table Dim\n'
        }
    );

    const { selected, result } = deploy(s, d => d.objectType === 'model');
    assert.strictEqual(selected.length, 1, 'the model change is a diff');
    assert.strictEqual(result.success, true, errorText(result));

    const written = read(s.prodPath, 'model.tmdl');
    assert.match(written, /culture: pl-PL/, 'the reviewed change is deployed');
    assert.match(written, /ref table Sales/, 'the Sales ref survives');
    assert.match(written, /ref table Dim/, 'the Dim ref survives');
});

test('#43 mergeModelBlock keeps target refs and drops source refs', () => {
    const target = 'model Model\n\tculture: en-US\n\tref table Sales\n';
    const dev = 'model Model\n\tculture: pl-PL\n';
    const merged = mergeModelBlock(target, dev);
    assert.match(merged, /culture: pl-PL/);
    assert.match(merged, /ref table Sales/);
});

// ── #62: missing prodModel caused an unconditional compatibilityLevel rewrite ─
test('#62 a higher target compatibilityLevel is never downgraded', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(1704),
        'model.tmdl': H.modelTmdl([]),
        'functions.tmdl': 'function MyFn = (x) => x + 1\n'
    };
    const prod = { 'database.tmdl': H.databaseTmdl(1704), 'model.tmdl': H.modelTmdl([]) };

    const s = scenario(dev, prod);
    const selected = s.comparison.diffs.filter(d => d.objectType === 'function');
    assert.strictEqual(selected.length, 1, 'the UDF is an Add');

    // The library caller omits prodModel entirely — the deployer must still load it.
    const result = deployChanges(selected, s.devModel, s.prodPath, { backup: false });
    assert.strictEqual(result.success, true, errorText(result));
    assert.match(read(s.prodPath, 'database.tmdl'), /compatibilityLevel: 1704/, 'level untouched');
});

test('#62 a target below the required level is still bumped', () => {
    const dev = {
        'database.tmdl': H.databaseTmdl(1702),
        'model.tmdl': H.modelTmdl([]),
        'functions.tmdl': 'function MyFn = (x) => x + 1\n'
    };
    const prod = { 'database.tmdl': H.databaseTmdl(1567), 'model.tmdl': H.modelTmdl([]) };

    const s = scenario(dev, prod);
    const selected = s.comparison.diffs.filter(d => d.objectType === 'function');
    const result = deployChanges(selected, s.devModel, s.prodPath, { backup: false });
    assert.strictEqual(result.success, true, errorText(result));
    assert.match(read(s.prodPath, 'database.tmdl'), /compatibilityLevel: 1702/);
});

// ── #74: local deploy was not transactional ───────────────────────────────────
test('#74 a failing operation rolls every earlier write back', () => {
    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim'])
    };
    const s = scenario(
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tmeasure Count = 2\n\t\tformatString: #,0\n'
        },
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: 0.00\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tmeasure Count = 2\n\t\tformatString: 0.00\n'
        }
    );

    const before = {
        sales: read(s.prodPath, 'tables/Sales.tmdl'),
        dim: read(s.prodPath, 'tables/Dim.tmdl')
    };

    // Two real measure modifies plus one that cannot be applied (no such block).
    const selected = s.comparison.diffs.filter(d => d.objectType === 'measure');
    assert.strictEqual(selected.length, 2, 'both measures changed');
    selected.push({
        type: 2, objectType: 'measure', identityKey: 'measure:sales.ghost', displayName: 'Sales.Ghost',
        objectName: 'Ghost', targetObjectName: 'Ghost', parentTable: 'Sales',
        sourceFile: 'tables/Sales.tmdl', targetFile: 'tables/Sales.tmdl',
        rawBlock: '\tmeasure Ghost = 1', propertyDiffs: []
    });

    const result = deployChanges(selected, s.devModel, s.prodPath, {
        backup: false, prodModel: s.prodModel, allDiffs: s.comparison.diffs
    });

    assert.strictEqual(result.success, false, 'the deploy reports failure');
    assert.strictEqual(result.rolledBack, true, 'rollback happened');
    assert.strictEqual(read(s.prodPath, 'tables/Sales.tmdl'), before.sales, 'Sales.tmdl restored');
    assert.strictEqual(read(s.prodPath, 'tables/Dim.tmdl'), before.dim, 'Dim.tmdl restored');
});

test('#74 a clean deploy still applies everything', () => {
    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim'])
    };
    const s = scenario(
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tmeasure Count = 2\n\t\tformatString: #,0\n'
        },
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: 0.00\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tmeasure Count = 2\n\t\tformatString: 0.00\n'
        }
    );

    const { result } = deploy(s, d => d.objectType === 'measure');
    assert.strictEqual(result.success, true, errorText(result));
    assert.ok(!result.rolledBack);
    assert.match(read(s.prodPath, 'tables/Sales.tmdl'), /formatString: #,0/);
    assert.match(read(s.prodPath, 'tables/Dim.tmdl'), /formatString: #,0/);
});

// ── finding 4.7: rollback failures were silently swallowed ──────────────────
test('#4.7 a restore that throws during rollback is reported as ROLLBACK_INCOMPLETE, not "unchanged"', (t) => {
    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Dim'])
    };
    const s = scenario(
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tmeasure Count = 2\n\t\tformatString: #,0\n'
        },
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: 0.00\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tmeasure Count = 2\n\t\tformatString: 0.00\n'
        }
    );

    const salesPath = path.join(s.prodPath, 'tables/Sales.tmdl');
    const original = fs.writeFileSync;
    let salesWrites = 0;
    t.mock.method(fs, 'writeFileSync', (targetPath, ...args) => {
        if (targetPath === salesPath) {
            salesWrites++;
            // Let the real deploy write through; only the rollback restore fails
            // (simulating the file becoming unwritable, e.g. locked/read-only).
            if (salesWrites > 1) throw new Error('EACCES: simulated read-only file');
        }
        return original.call(fs, targetPath, ...args);
    });

    const selected = s.comparison.diffs.filter(d => d.objectType === 'measure');
    assert.strictEqual(selected.length, 2, 'both measures changed');
    selected.push({
        type: 2, objectType: 'measure', identityKey: 'measure:sales.ghost', displayName: 'Sales.Ghost',
        objectName: 'Ghost', targetObjectName: 'Ghost', parentTable: 'Sales',
        sourceFile: 'tables/Sales.tmdl', targetFile: 'tables/Sales.tmdl',
        rawBlock: '\tmeasure Ghost = 1', propertyDiffs: []
    });

    const result = deployChanges(selected, s.devModel, s.prodPath, {
        backup: false, prodModel: s.prodModel, allDiffs: s.comparison.diffs
    });

    assert.strictEqual(result.success, false, 'the deploy reports failure');
    assert.strictEqual(result.rolledBack, true, 'rollback was attempted');
    const rollbackError = result.errors.find(e => e.code === 'ROLLBACK_INCOMPLETE');
    assert.ok(rollbackError, 'a ROLLBACK_INCOMPLETE error is reported');
    assert.match(rollbackError.error, /Sales\.tmdl/);
    const rollbackAction = result.actions.find(a => a.type === 'rollback');
    assert.ok(rollbackAction, 'a rollback action is recorded');
    assert.doesNotMatch(rollbackAction.message, /the target is unchanged/,
        'must not claim the target is unchanged when a restore failed');
});

// ── finding 2.2: guessed target paths were silent ────────────────────────────
test('#2.2 a target model that fails to extract warns TARGET_PATHS_GUESSED', () => {
    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n' },
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: 0.00\n' }
    );

    // A malformed prodModel (missing `.tables` etc.) makes extractAll() throw.
    const { result } = deploy(s, d => d.objectType === 'measure', { prodModel: {} });

    const warning = result.warnings.find(w => w.code === 'TARGET_PATHS_GUESSED');
    assert.ok(warning, 'a TARGET_PATHS_GUESSED warning is reported when extraction fails');
});

// ── live incident: removing a role while its tablePermission was also selected ──
// A whole-role REMOVE deletes roles/<role>.tmdl outright. A tablePermission/
// roleMember REMOVE diff for that same role then found its target file already
// gone and failed with TARGET_FILE_MISSING, which forced a rollback whose
// restore of the (legitimately, successfully) deleted role file then also
// failed — because rollback tried to read-compare a file that no longer
// existed instead of just recreating it. Fixed by (a) skipping the redundant
// child op, mirroring the existing table-children guard, and (b) making
// rollback tolerant of files deleted earlier in the same batch.
test('#78 removing a whole role skips its already-covered tablePermission child', () => {
    const roleFile = () => [
        'role Test_Role',
        '\tmodelPermission: read',
        '',
        '\ttablePermission Dim_MRA = [Region] = "EU"',
        ''
    ].join('\n');

    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Dim_MRA', 'role Test_Role']),
        'tables/Dim_MRA.tmdl': 'table Dim_MRA\n\n\tcolumn Region\n\t\tdataType: string\n'
    };
    const s = scenario(
        { ...base, 'model.tmdl': H.modelTmdl(['table Dim_MRA']) }, // role removed entirely in DEV
        { ...base, 'roles/Test_Role.tmdl': roleFile() }
    );

    const selected = s.comparison.diffs.filter(d => d.objectType === 'role' || d.objectType === 'tablePermission');
    assert.strictEqual(selected.length, 2, 'both the role removal and its child are selected');

    const ops = planFileOperations(selected, s.devModel, s.prodPath, s.prodModel);
    assert.strictEqual(ops.length, 1, 'only the whole-role deleteFile op is planned, not a redundant child op');

    const result = deployChanges(selected, s.devModel, s.prodPath, {
        backup: false, prodModel: s.prodModel, allDiffs: s.comparison.diffs
    });
    assert.strictEqual(result.success, true, errorText(result));
    assert.ok(!exists(s.prodPath, 'roles/Test_Role.tmdl'), 'the role file is gone');
});

test('#78 rollback recreates a file an earlier operation in the same batch had already deleted', () => {
    const base = {
        'database.tmdl': H.databaseTmdl(),
        'model.tmdl': H.modelTmdl(['table Sales', 'table Ghost'])
    };
    const s = scenario(
        {
            ...base,
            'model.tmdl': H.modelTmdl(['table Sales']), // Ghost removed entirely in DEV
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: 0.00\n'
        },
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n',
            'tables/Ghost.tmdl': 'table Ghost\n\n\tcolumn Id\n\t\tdataType: int64\n'
        }
    );

    const ghostFile = read(s.prodPath, 'tables/Ghost.tmdl');
    const selected = s.comparison.diffs.filter(d => d.objectType === 'table' || d.objectType === 'measure');
    // A table remove (deletes tables/Ghost.tmdl outright) plus a real measure
    // modify, plus one that cannot be applied — forces rollback after the
    // table has already been deleted.
    selected.push({
        type: 2, objectType: 'measure', identityKey: 'measure:sales.ghost', displayName: 'Sales.Ghost',
        objectName: 'Ghost', targetObjectName: 'Ghost', parentTable: 'Sales',
        sourceFile: 'tables/Sales.tmdl', targetFile: 'tables/Sales.tmdl',
        rawBlock: '\tmeasure Ghost = 1', propertyDiffs: []
    });

    const result = deployChanges(selected, s.devModel, s.prodPath, {
        backup: false, prodModel: s.prodModel, allDiffs: s.comparison.diffs
    });

    assert.strictEqual(result.success, false, 'the deploy reports failure');
    assert.strictEqual(result.rolledBack, true, 'rollback happened');
    assert.ok(!result.errors.some(e => e.code === 'ROLLBACK_INCOMPLETE'),
        'the deleted table file is fully recreated, not left missing');
    assert.strictEqual(read(s.prodPath, 'tables/Ghost.tmdl'), ghostFile, 'Ghost.tmdl restored exactly');
});

// ── regression: a dry run writes nothing ─────────────────────────────────────
test('regression: a dry run reports actions without touching the target', () => {
    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n' },
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: 0.00\n' }
    );
    const before = read(s.prodPath, 'tables/Sales.tmdl');

    const { result } = deploy(s, d => d.objectType === 'measure', { dryRun: true });
    assert.ok(result.actions.some(a => a.type === 'dryrun'));
    assert.strictEqual(read(s.prodPath, 'tables/Sales.tmdl'), before);
});

// ── regression: planFileOperations stays exported and usable ──────────────────
test('regression: planFileOperations produces ops without touching disk', () => {
    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n' },
        { ...base, 'tables/Sales.tmdl': 'table Sales\n' }
    );
    const ops = planFileOperations(
        s.comparison.diffs.filter(d => d.objectType === 'measure'),
        s.devModel, s.prodPath, s.prodModel, { prodObjects: {} }
    );
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].action, 'appendChild');
});

// ── finding 4.3: a case-only rename was detected but undeployable ─────────────
test('4.3 a sales -> Sales case-only table rename deploys and the header reads table Sales', () => {
    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Id\n\t\tdataType: int64\n' },
        { ...base, 'tables/Sales.tmdl': 'table sales\n\n\tcolumn Id\n\t\tdataType: int64\n' }
    );

    const { result } = deploy(s, d => d.objectType === 'table');
    assert.strictEqual(result.success, true, errorText(result));
    assert.match(read(s.prodPath, 'tables/Sales.tmdl'), /^table Sales\b/m, 'header rewritten with the DEV casing');
});

test('4.3 a measure rename differing only by case deploys the same way', () => {
    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales']) };
    const s = scenario(
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure Total = 1\n\t\tformatString: #,0\n' },
        { ...base, 'tables/Sales.tmdl': 'table Sales\n\n\tmeasure total = 1\n\t\tformatString: #,0\n' }
    );

    const { result } = deploy(s, d => d.objectType === 'measure');
    assert.strictEqual(result.success, true, errorText(result));
    assert.match(read(s.prodPath, 'tables/Sales.tmdl'), /measure Total = 1/, 'measure header rewritten with the DEV casing');
});

test('4.3 an unrelated table with a similar name is left untouched by the case-insensitive lookup', () => {
    const base = { 'database.tmdl': H.databaseTmdl(), 'model.tmdl': H.modelTmdl(['table Sales', 'table Dim']) };
    const s = scenario(
        {
            ...base,
            'tables/Sales.tmdl': 'table Sales\n\n\tcolumn Id\n\t\tdataType: int64\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n'
        },
        {
            ...base,
            'tables/Sales.tmdl': 'table sales\n\n\tcolumn Id\n\t\tdataType: int64\n',
            'tables/Dim.tmdl': 'table Dim\n\n\tcolumn Id\n\t\tdataType: int64\n'
        }
    );
    const before = read(s.prodPath, 'tables/Dim.tmdl');

    const { result } = deploy(s, d => d.objectType === 'table' && d.displayName === 'Sales');
    assert.strictEqual(result.success, true, errorText(result));
    assert.strictEqual(read(s.prodPath, 'tables/Dim.tmdl'), before, 'the unrelated Dim table is unaffected');
});
