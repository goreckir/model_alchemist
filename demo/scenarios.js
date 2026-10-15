/**
 * Demo Kit Scenarios — derives every Scenario from the one Source model
 * (demo/dev, built with Power BI Modeling MCP) by anchored text patches.
 * Each patch asserts its anchor occurs exactly once, so a change to the
 * Source model breaks the build loudly instead of producing a silently
 * different Scenario. See docs/adr/0001-demo-kit-single-synthetic-model.md.
 *
 *   node demo/scenarios.js            regenerate demo/prod and out/scenarios/*
 *   node demo/scenarios.js --check    fail if demo/prod differs from what the script produces
 */
const fs = require('fs');
const path = require('path');

const DEMO = __dirname;
const ROOT = path.join(DEMO, '..');
const MODEL = 'Apothecary.SemanticModel';
// Only the TMDL definition is derived; .pbi/ (local cache) and the PBIP shell files are not.
const DEV_MODEL = path.join(DEMO, 'dev', MODEL, 'definition');
const PROD_MODEL = path.join(DEMO, 'prod', MODEL, 'definition');
const OUT = path.join(ROOT, 'out', 'scenarios');

// ── In-memory model: { 'relative/path.tmdl': text with \n line endings } ─────

function readModel(dir) {
    const files = {};
    (function walk(rel) {
        for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(childRel);
            else files[childRel] = fs.readFileSync(path.join(dir, childRel), 'utf8').replace(/\r\n/g, '\n');
        }
    })('');
    return files;
}

function writeModel(files, dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text.replace(/\n/g, '\r\n'));
    }
}

// ── Patch primitives ─────────────────────────────────────────────────────────

function fileOf(files, rel) {
    if (!(rel in files)) throw new Error(`Scenario patch: no file ${rel}`);
    return files[rel];
}

function countOf(text, needle) {
    return text.split(needle).length - 1;
}

/** Replace a fragment that must occur exactly once. */
function replace(rel, from, to) {
    return files => {
        const text = fileOf(files, rel);
        const n = countOf(text, from);
        if (n !== 1) throw new Error(`Scenario patch: expected 1 match in ${rel}, found ${n}: ${JSON.stringify(from)}`);
        files[rel] = text.replace(from, () => to);
    };
}

/**
 * Remove one TMDL object: its header line (matched exactly, without indentation),
 * the `///` description above it, every deeper-indented line below it, and one
 * trailing blank line.
 */
function removeObject(rel, header) {
    return files => {
        const lines = fileOf(files, rel).split('\n');
        const hits = lines.map((l, i) => (l.trim() === header ? i : -1)).filter(i => i >= 0);
        if (hits.length !== 1) throw new Error(`Scenario patch: expected 1 "${header}" in ${rel}, found ${hits.length}`);
        const at = hits[0];
        const indent = lines[at].match(/^\t*/)[0].length;
        let start = at;
        while (start > 0 && lines[start - 1].trim().startsWith('///')) start--;
        let end = at + 1;
        while (end < lines.length && (lines[end].trim() === '' || lines[end].match(/^\t*/)[0].length > indent)) {
            // Stop at a blank line followed by a sibling or shallower object.
            if (lines[end].trim() === '') {
                let next = end + 1;
                while (next < lines.length && lines[next].trim() === '') next++;
                if (next >= lines.length || lines[next].match(/^\t*/)[0].length <= indent) { end++; break; }
            }
            end++;
        }
        lines.splice(start, end - start);
        files[rel] = lines.join('\n');
    };
}

function deleteFile(rel) {
    return files => {
        fileOf(files, rel);
        delete files[rel];
    };
}

function apply(base, patches) {
    const files = { ...base };
    for (const patch of patches) patch(files);
    return files;
}

// ── Patch sets ───────────────────────────────────────────────────────────────

const SALES = 'tables/Sales.tmdl';
const DATE = 'tables/Date.tmdl';
const MODEL_TMDL = 'model.tmdl';
const PL = 'cultures/pl-PL.tmdl';

/** Fictional members only (.example is a reserved domain). They exist in Prod and must survive a deploy. */
const prodRoleMembers = replace('roles/Regional Manager.tmdl',
    '\ttablePermission Store = Store[Region] IN { "Northern Reach", "Eastern Isles" }\n',
    '\ttablePermission Store = Store[Region] = "Northern Reach"\n' +
    '\n\tmember manager.north@apothecary.example\n\t\tmemberType: user\n' +
    '\n\tmember auditor@apothecary.example\n\t\tmemberType: user\n');

/**
 * Prod is the older model. Each line below is one difference the Default
 * Scenario shows, grouped by Change Group (see analysis/2026-10-15-demo-kit-design.md).
 */
const PROD_PATCHES = [
    // Model properties: Prod still uses the British culture. (discourageImplicitMeasures
    // is not diffed by design, and a model with a calculation group needs it on.)
    replace(MODEL_TMDL, '\tculture: en-US\n', '\tculture: en-GB\n'),

    // Tables and relationships: Budget table is new in Dev
    deleteFile('tables/Budget.tmdl'),
    replace(MODEL_TMDL, 'ref table Budget\n', ''),
    removeObject('relationships.tmdl', 'relationship Budget_Date_Date_Date'),
    removeObject('relationships.tmdl', "relationship 'Budget_Store Key_Store_Store Key'"),

    // Tables: Date gains the Is Holiday column (depends on the Holiday Calendar expression)
    removeObject(DATE, "column 'Is Holiday'"),
    replace(DATE, '\t\t\t\t    Holidays = List.Buffer(#"Holiday Calendar"),\n', ''),
    replace(DATE, '\t\t\t\t    IsHoliday = Table.AddColumn(DayOfWeek, "Is Holiday", each if List.Contains(Holidays, [Date]) then "Yes" else "No", type text)\n', ''),
    replace(DATE, '\t\t\t\t    DayOfWeek = Table.AddColumn(DayOfWeekNumber, "Day of Week", each Date.ToText([Date], "ddd", "en-US"), type text),\n',
        '\t\t\t\t    DayOfWeek = Table.AddColumn(DayOfWeekNumber, "Day of Week", each Date.ToText([Date], "ddd", "en-US"), type text)\n'),
    replace(DATE, '\t\t\t\tin\n\t\t\t\t    IsHoliday\n', '\t\t\t\tin\n\t\t\t\t    DayOfWeek\n'),

    // Named expressions: Holiday Calendar is new in Dev
    removeObject('expressions.tmdl', "expression 'Holiday Calendar' ="),

    // Parameters: Dev raised prices by 5%
    replace('expressions.tmdl', "expression 'Price Index' = 1.05 meta", "expression 'Price Index' = 1.00 meta"),

    // Functions: MarginRatio is new in Dev, and Margin % depends on it
    deleteFile('functions.tmdl'),
    removeObject(SALES, "measure 'Margin %' = MarginRatio ( [Sales Amount], [Total Cost] )"),

    // Measures: Sales Amount shown with cents in Prod; Legacy Revenue was removed in Dev
    replace(SALES,
        "\tmeasure 'Sales Amount' = SUM ( Sales[Net Amount] )\n\t\tformatString: \\$#,0;(\\$#,0);\\$#,0\n",
        "\tmeasure 'Sales Amount' = SUM ( Sales[Net Amount] )\n\t\tformatString: \\$#,0.00;(\\$#,0.00);\\$#,0.00\n"),
    replace(SALES, '\tcolumn Date\n',
        '\t/// Superseded by Sales Amount; kept for an old report.\n' +
        "\tmeasure 'Legacy Revenue' = SUMX ( Sales, Sales[Net Amount] )\n" +
        '\t\tformatString: #,0\n\t\tisHidden\n\t\tdisplayFolder: Deprecated\n\t\tlineageTag: 6f1d2c9e-1b7a-4c55-9e0d-3a2f5b8c7d41\n\n' +
        '\tcolumn Date\n'),

    // Calculation groups: YoY % item is new in Dev
    removeObject('tables/Time Intelligence.tmdl', "calculationItem 'YoY %' ="),

    // Hierarchies: Dev added the Rarity level
    removeObject('tables/Product.tmdl', 'level Rarity'),

    // Roles / RLS: Dev widened the filter; Prod has members that must be preserved
    prodRoleMembers,

    // Perspectives: Budget Planning is new in Dev
    deleteFile('perspectives/Budget Planning.tmdl'),
    replace(MODEL_TMDL, "ref perspective 'Budget Planning'\n", ''),

    // Translations: de-DE is new in Dev; one pl-PL caption was reworded; no Budget or Margin % in Prod
    deleteFile('cultures/de-DE.tmdl'),
    replace(MODEL_TMDL, 'ref cultureInfo de-DE\n', ''),
    replace(PL, '\t\t\t\t\tcaption: Wartość sprzedaży\n', '\t\t\t\t\tcaption: Sprzedaż netto\n'),
    removeObject(PL, "measure 'Margin %'"),
    removeObject(PL, 'table Budget')
];

/** Small, single-purpose Scenarios for one Recording each. Source is Dev unless stated. */
const SCENARIOS = {
    // Changed fragments highlighted inside DAX and Power Query
    'object-diff': {
        target: [
            replace(SALES, "measure 'Average Selling Price' = DIVIDE ( [Sales Amount], [Quantity Sold] )",
                "measure 'Average Selling Price' = DIVIDE ( [Sales Amount], [Sales Lines] )"),
            replace(SALES, 'discount = if fnRandom(i, 5) < 0.2 then 0.1 else 0', 'discount = if fnRandom(i, 5) < 0.2 then 0.15 else 0')
        ]
    },
    // Prod-only RLS members survive a deploy of the changed role filter
    'rls-preserved': { target: [prodRoleMembers] },
    // A parameter change that requires refreshing only Product and Sales
    'scoped-refresh': {
        target: [replace('expressions.tmdl', "expression 'Price Index' = 1.05 meta", "expression 'Price Index' = 1.00 meta")]
    }
};

// ── Main ─────────────────────────────────────────────────────────────────────

function buildProd(base) {
    return apply(base, PROD_PATCHES);
}

function sameModel(a, b) {
    const keys = Object.keys(a).sort();
    if (keys.join('|') !== Object.keys(b).sort().join('|')) return false;
    return keys.every(k => a[k] === b[k]);
}

function main() {
    const base = readModel(DEV_MODEL);
    const prod = buildProd(base);

    if (process.argv.includes('--check')) {
        if (!sameModel(prod, readModel(PROD_MODEL))) {
            console.error('demo/prod is out of date. Run: node demo/scenarios.js');
            process.exit(1);
        }
        console.log('demo/prod matches the Default Scenario.');
        return;
    }

    writeModel(prod, PROD_MODEL);
    console.log(`Default Scenario: ${path.relative(ROOT, PROD_MODEL)}`);

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
        const dir = path.join(OUT, name);
        writeModel(apply(base, scenario.source || []), path.join(dir, 'source', MODEL, 'definition'));
        writeModel(apply(base, scenario.target || []), path.join(dir, 'target', MODEL, 'definition'));
        console.log(`Scenario ${name}: ${path.relative(ROOT, dir)}`);
    }
}

if (require.main === module) main();

module.exports = { readModel, buildProd, apply, SCENARIOS, DEV_MODEL, PROD_MODEL };
