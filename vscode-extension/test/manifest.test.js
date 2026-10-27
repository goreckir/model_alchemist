const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');
const manifest = require(path.join(EXT, 'package.json'));
const { contributes } = manifest;
const commandIds = contributes.commands.map(c => c.command);

test('the Activity Bar entry has an icon that ships in the VSIX', () => {
    const [container] = contributes.viewsContainers.activitybar;
    assert.strictEqual(container.title, 'Model Alchemist');
    const icon = path.join(EXT, container.icon);
    assert.ok(fs.existsSync(icon), container.icon);
    const ignored = fs.readFileSync(path.join(EXT, '.vscodeignore'), 'utf-8').split(/\r?\n/);
    assert.ok(!ignored.some(line => line && container.icon.startsWith(line.replace(/\*\*$/, ''))), 'not excluded by .vscodeignore');
});

test('the start view belongs to the Activity Bar container and has welcome content', () => {
    const container = contributes.viewsContainers.activitybar[0].id;
    const views = contributes.views[container];
    assert.ok(views && views.some(v => v.id === 'modelAlchemist.start'));
    assert.ok(contributes.viewsWelcome.some(w => w.view === 'modelAlchemist.start'));
});

test('every button on the start view runs a contributed command', () => {
    const links = contributes.viewsWelcome.flatMap(w => [...w.contents.matchAll(/\(command:([\w.]+)\)/g)].map(m => m[1]));
    assert.ok(links.length >= 2);
    for (const id of links) assert.ok(commandIds.includes(id), id);
});

test('the start view tree is registered by the extension', () => {
    const src = fs.readFileSync(path.join(EXT, 'src', 'extension.js'), 'utf-8');
    assert.match(src, /registerTreeDataProvider\('modelAlchemist\.start'/);
});
