/**
 * Product screenshots — boots the real server, runs a real comparison against a
 * throwaway pair of models, and captures the UI. Nothing here is mocked: what
 * you see in the README is what the app renders.
 *
 * Run from the repo root:  node assets/src/screenshots.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(PLAYWRIGHT);

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..');
const PORT = 3777;

// ── Demo models ──────────────────────────────────────────────────────────────
const database = 'database Contoso\n\tcompatibilityLevel: 1567\n';

const modelTmdl = culture => [
    'model Model', `\tculture: ${culture}`, '',
    'ref table Sales', 'ref table Product', 'ref table Date', 'ref role Regional Manager', ''
].join('\n');

const salesTable = ({ marginMeasure, legacyMeasure, amountType, server, revenueFormat }) => [
    'table Sales', '\tlineageTag: sales-target-tag', '',
    '\tcolumn Amount', `\t\tdataType: ${amountType}`, '\t\tsourceColumn: Amount',
    '\t\tformatString: #,0.00', '\t\tsummarizeBy: sum', '\t\tlineageTag: amount-target-tag', '',
    '\tcolumn ProductKey', '\t\tdataType: int64', '\t\tsourceColumn: ProductKey', '',
    '\tmeasure Revenue = SUM(Sales[Amount])', `\t\tformatString: ${revenueFormat}`,
    '\t\tdisplayFolder: Core', '',
    ...(marginMeasure ? [
        "\tmeasure 'Margin %' =",
        '\t\t\tDIVIDE(',
        '\t\t\t    SUM(Sales[Amount]) - SUM(Sales[Cost]),',
        '\t\t\t    SUM(Sales[Amount])',
        '\t\t\t)',
        '\t\tformatString: 0.00%',
        '\t\tdisplayFolder: Core', ''
    ] : []),
    ...(legacyMeasure ? [
        "\tmeasure 'Legacy Total' = SUM(Sales[Amount])",
        '\t\tformatString: #,0',
        '\t\tisHidden',
        '\t\tdisplayFolder: Deprecated', ''
    ] : []),
    '\tpartition Sales = m', '\t\tmode: import', '\t\tsource =',
    '\t\t\t\tlet',
    `\t\t\t\t    Source = Sql.Database("${server}", "Contoso"),`,
    '\t\t\t\t    Sales = Source{[Schema="dbo",Item="FactSales"]}[Data]',
    '\t\t\t\tin',
    '\t\t\t\t    Sales', ''
].join('\n');

const productTable = [
    'table Product', '', '\tcolumn ProductKey', '\t\tdataType: int64', '\t\tsourceColumn: ProductKey', '',
    '\tcolumn Category', '\t\tdataType: string', '\t\tsourceColumn: Category', ''
].join('\n');

const dateTable = [
    'table Date', '', '\tcolumn Date', '\t\tdataType: dateTime', '\t\tsourceColumn: Date', '',
    '\thierarchy Calendar', '', '\t\tlevel Year', '\t\t\tcolumn: Date', ''
].join('\n');

const roleFile = filter => [
    'role Regional Manager', '\tmodelPermission: read', '',
    `\ttablePermission Sales = ${filter}`, '',
    '\tmember manager@contoso.com', '\t\tmemberType: user', ''
].join('\n');

const relationships = crossFilter => [
    'relationship a1b2c3d4-0000-0000-0000-000000000001',
    ...(crossFilter ? [`\tcrossFilteringBehavior: ${crossFilter}`] : []),
    '\tfromColumn: Sales.ProductKey', '\ttoColumn: Product.ProductKey', ''
].join('\n');

const SOURCE = {
    'database.tmdl': database,
    'model.tmdl': modelTmdl('en-GB'),
    'tables/Sales.tmdl': salesTable({ marginMeasure: true, legacyMeasure: false, amountType: 'decimal', server: 'sql-prod-eu', revenueFormat: '#,0' }),
    'tables/Product.tmdl': productTable,
    'tables/Date.tmdl': dateTable,
    'roles/Regional Manager.tmdl': roleFile('[Amount] > 0 && [Category] <> "Internal"'),
    'relationships.tmdl': relationships('bothDirections')
};
const TARGET = {
    'database.tmdl': database,
    'model.tmdl': modelTmdl('en-US'),
    'tables/Sales.tmdl': salesTable({ marginMeasure: false, legacyMeasure: true, amountType: 'double', server: 'sql-dev-eu', revenueFormat: '0.00' }),
    'tables/Product.tmdl': productTable,
    'tables/Date.tmdl': dateTable,
    'roles/Regional Manager.tmdl': roleFile('[Amount] > 0'),
    'relationships.tmdl': relationships(null)
};

function writeModel(files, label) {
    const root = path.join(os.tmpdir(), 'model-alchemist-demo', label);
    fs.rmSync(root, { recursive: true, force: true });
    const semanticModel = path.join(root, 'Contoso Sales.SemanticModel');
    const def = path.join(semanticModel, 'definition');
    fs.mkdirSync(def, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(def, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf-8');
    }
    return { root, def, semanticModel };
}

(async () => {
    const source = writeModel(SOURCE, 'feature-margin');
    const target = writeModel(TARGET, 'main');

    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: { ...process.env, PORT: String(PORT) }, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise(r => setTimeout(r, 1600));

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
    const problems = [];
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

    // Drive the real inputs, exactly as a user would.
    await page.fill('#dev-path', source.semanticModel);
    await page.dispatchEvent('#dev-path', 'change');
    await page.fill('#prod-path', target.semanticModel);
    await page.dispatchEvent('#prod-path', 'change');
    await page.waitForTimeout(600);
    await page.click('#btn-compare');
    await page.waitForSelector('#results-panel:not(.hidden)', { timeout: 15000 });
    await page.waitForTimeout(700);

    // Open the atomic group and expand two diffs so the inline diff is visible.
    const groupHeader = page.locator('.diff-group .diff-group-header').first();
    if (await groupHeader.count()) { await groupHeader.click(); await page.waitForTimeout(400); }
    const headers = page.locator('.diff-object-header-left');
    const toExpand = Math.min(4, await headers.count());
    for (let i = 0; i < toExpand; i++) { await headers.nth(i).click(); await page.waitForTimeout(250); }
    await page.waitForTimeout(500);

    await page.screenshot({ path: path.join(OUT, 'screenshot-compare.png') });

    // Select everything, then open the deploy preview.
    await page.click('#btn-select-all');
    await page.waitForTimeout(300);

    // The backup field defaults to an absolute path on the machine that ran this
    // script. Neutralise it so the published screenshot carries no local path.
    await page.evaluate(() => {
        const input = document.getElementById('backup-path');
        if (input) input.value = 'D:\\PowerBI\\_backups';
    });

    await page.click('#btn-deploy');
    await page.waitForSelector('#deploy-modal:not(.hidden)', { timeout: 10000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'screenshot-deploy-preview.png') });

    for (const name of ['screenshot-compare.png', 'screenshot-deploy-preview.png']) {
        console.log(`${name.padEnd(32)} ${(fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0)} KB`);
    }
    console.log(problems.length ? `PAGE PROBLEMS: ${problems.join(' | ')}` : 'no console/page errors');

    await browser.close();
    server.kill();
    fs.rmSync(path.join(os.tmpdir(), 'model-alchemist-demo'), { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
