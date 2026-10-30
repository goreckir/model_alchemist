/**
 * Temporary Git repositories built from the Demo Kit, for the Git tests.
 *
 *   main = demo/prod, dev = demo/dev, model at Apothecary.SemanticModel
 *
 * With { origin: true } the repository gets a bare `origin` it has pushed
 * both branches to, and main tracks origin/main. Real Git, no network.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEMO_DEV = path.join(__dirname, '..', '..', 'demo', 'dev', 'Apothecary.SemanticModel');
const DEMO_PROD = path.join(__dirname, '..', '..', 'demo', 'prod', 'Apothecary.SemanticModel');
const MODEL = 'Apothecary.SemanticModel';

function sh(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }).trim();
}

function tempDir(t, prefix = 'ma-git-') {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** Copy a model folder; with crlf: true every .tmdl file gets CRLF line endings. */
function copyModel(from, to, { crlf = false } = {}) {
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
    if (!crlf) return;
    const walk = dir => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.tmdl')) fs.writeFileSync(full, fs.readFileSync(full, 'utf-8').replace(/\r?\n/g, '\r\n'));
        }
    };
    walk(to);
}

function makeRepo(t, { origin = false, crlf = false } = {}) {
    const repo = tempDir(t);
    sh(repo, 'init', '--quiet', '--initial-branch=main');
    sh(repo, 'config', 'user.name', 'Test');
    sh(repo, 'config', 'user.email', 'test@example.com');
    sh(repo, 'config', 'core.autocrlf', 'false');
    sh(repo, 'config', 'commit.gpgsign', 'false');
    copyModel(DEMO_PROD, path.join(repo, MODEL), { crlf });
    fs.writeFileSync(path.join(repo, 'Apothecary.pbip'), '{}');
    fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'prod');
    sh(repo, 'switch', '--quiet', '-c', 'dev');
    copyModel(DEMO_DEV, path.join(repo, MODEL), { crlf });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'dev');
    sh(repo, 'switch', '--quiet', 'main');

    let bare = null;
    if (origin) {
        bare = tempDir(t, 'ma-git-origin-');
        sh(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
        sh(repo, 'remote', 'add', 'origin', bare);
        sh(repo, 'push', '--quiet', '-u', 'origin', 'main', 'dev');
    }
    return { repo, origin: bare };
}

module.exports = { DEMO_DEV, DEMO_PROD, MODEL, sh, tempDir, copyModel, makeRepo };
