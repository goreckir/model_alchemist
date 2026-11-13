const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findOutdatedDependencies, outdatedMessage } = require('../lib/dependency-check');

function project(lockPackages, installed) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-deps-'));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...lockPackages } }));
    for (const [key, version] of Object.entries(installed)) {
        fs.mkdirSync(path.join(root, key), { recursive: true });
        fs.writeFileSync(path.join(root, key, 'package.json'), JSON.stringify({ version }));
    }
    return root;
}

test('dependency check: the repository itself is installed as locked', () => {
    assert.deepStrictEqual(findOutdatedDependencies(path.join(__dirname, '..')), []);
});

test('dependency check: a package older than the lockfile is reported (git pull without npm ci)', () => {
    const root = project(
        { 'node_modules/@azure/msal-node': { version: '7.2.2' }, 'node_modules/express': { version: '4.22.3' } },
        { 'node_modules/@azure/msal-node': '2.16.3', 'node_modules/express': '4.22.3' });
    assert.deepStrictEqual(findOutdatedDependencies(root), [{ name: '@azure/msal-node', locked: '7.2.2', installed: '2.16.3' }]);
});

test('dependency check: nested and missing packages are reported; omitted dev and optional ones are not', () => {
    const root = project({
        'node_modules/express': { version: '4.22.3' },
        'node_modules/express/node_modules/qs': { version: '6.16.2' },
        'node_modules/missing': { version: '1.0.0' },
        'node_modules/dev-only': { version: '1.0.0', dev: true },
        'node_modules/fsevents': { version: '2.3.3', optional: true }
    }, { 'node_modules/express': '4.22.3', 'node_modules/express/node_modules/qs': '6.15.4' });
    assert.deepStrictEqual(findOutdatedDependencies(root).map(d => `${d.name} ${d.installed}`), ['qs 6.15.4', 'missing null']);
});

test('dependency check: no lockfile means nothing to report', () => {
    assert.deepStrictEqual(findOutdatedDependencies(fs.mkdtempSync(path.join(os.tmpdir(), 'ma-deps-'))), []);
});

test('dependency check: the message names the fix and caps the list', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, locked: '2.0.0', installed: '1.0.0' }));
    const text = outdatedMessage(many, 'D:\\tools\\model_alchemist');
    assert.match(text, /npm ci/);
    // The folder is named, so the user knows where to run it.
    assert.ok(text.includes('D:\\tools\\model_alchemist'), text);
    assert.match(text, /p0: installed 1\.0\.0, expected 2\.0\.0/);
    assert.match(text, /and 2 more/);
    assert.match(outdatedMessage([{ name: 'x', locked: '1.0.0', installed: null }], '/tmp/ma'), /installed missing/);
});
