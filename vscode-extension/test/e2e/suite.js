// Runs inside the VS Code extension host started by run.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const ROOT = path.join(__dirname, '..', '..', '..');
const DEV = path.join(ROOT, 'demo', 'dev', 'Apothecary.SemanticModel');
const PROD = path.join(ROOT, 'demo', 'prod', 'Apothecary.SemanticModel');

/** Resolve once a message/reply pair satisfies `predicate`, or fail after `ms`. */
function waitFor(api, predicate, what, ms = 60000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { stop(); reject(new Error(`timed out waiting for ${what}`)); }, ms);
        const stop = api.onMessage((msg, reply) => {
            if (predicate(msg, reply)) { clearTimeout(timer); stop(); resolve({ msg, reply }); }
        });
    });
}

async function run() {
    const ext = vscode.extensions.getExtension('goreckir.model-alchemist');
    assert.ok(ext, 'the extension is loaded');
    const api = await ext.activate();

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-e2e-target-'));
    const target = path.join(work, 'Apothecary.SemanticModel');
    fs.cpSync(PROD, target, { recursive: true });

    const seen = [];
    api.onMessage(msg => seen.push(msg.type === 'request' ? `${msg.method} ${msg.path}` : msg.type));

    const ready = waitFor(api, msg => msg.type === 'ready', 'the page to load under the CSP and post ready');
    const compared = waitFor(api, (msg, reply) => msg.path === '/api/compare' && reply, 'the comparison');

    await vscode.commands.executeCommand('modelAlchemist.compareWith', vscode.Uri.file(DEV), vscode.Uri.file(target));

    await ready;
    const { reply } = await compared;
    assert.strictEqual(reply.status, 200, JSON.stringify(reply.body).slice(0, 300));

    // The same comparison computed directly, without the webview.
    const { loadModelFromFolder } = require(path.join(ROOT, 'parser', 'model-loader'));
    const { compareModels } = require(path.join(ROOT, 'comparison', 'engine'));
    const expected = compareModels(loadModelFromFolder(DEV), loadModelFromFolder(target), DEV, target).diffs.length;
    assert.strictEqual(reply.body.diffs.length, expected);

    for (const step of ['GET /api/defaults', 'POST /api/resolve-model']) {
        assert.ok(seen.includes(step), `the page called ${step}; saw ${seen.join(', ')}`);
    }

    // The activity log went to the extension's storage, not next to the bundle.
    const logFile = path.join(api.folders().logDir, 'activity.jsonl');
    assert.ok(fs.existsSync(logFile), `activity log at ${logFile}`);
    assert.ok(!fs.existsSync(path.join(ext.extensionPath, 'logs')), 'nothing written into the extension folder');

    console.log(`E2E ok: ${reply.body.diffs.length} differences through the webview; messages: ${seen.join(', ')}`);
    fs.rmSync(work, { recursive: true, force: true });
}

module.exports = { run };
