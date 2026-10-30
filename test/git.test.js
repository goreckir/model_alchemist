const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const git = require('../git/git-client');
const gitModels = require('../git/model-loader');
const { buildModelFromFiles, isDefinitionFile } = require('../parser/build-model');
const { loadModelFromFolder } = require('../parser/model-loader');
const { compareModels } = require('../comparison/engine');
const { createService } = require('../core/service');
const { matchRoute } = require('../core/routes');
const sessionStore = require('../lib/session-store');
const activityLog = require('../lib/activity-log');
const Pure = require('../public/js/pure.js');

// Every test builds its own repository from the Demo Kit:
//   main = demo/prod, dev = demo/dev, model at Apothecary.SemanticModel.
// Real Git, no network.

const DEMO_DEV = path.join(__dirname, '..', 'demo', 'dev', 'Apothecary.SemanticModel');
const DEMO_PROD = path.join(__dirname, '..', 'demo', 'prod', 'Apothecary.SemanticModel');
const MODEL = 'Apothecary.SemanticModel';

function sh(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', env: Object.assign({}, process.env, { LC_ALL: 'C' }) }).trim();
}

function tempDir(t, prefix = 'ma-git-') {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function replaceModel(repo, from) {
    fs.rmSync(path.join(repo, MODEL), { recursive: true, force: true });
    fs.cpSync(from, path.join(repo, MODEL), { recursive: true });
}

function makeRepo(t) {
    const repo = tempDir(t);
    sh(repo, 'init', '--quiet', '--initial-branch=main');
    sh(repo, 'config', 'user.name', 'Test');
    sh(repo, 'config', 'user.email', 'test@example.com');
    sh(repo, 'config', 'core.autocrlf', 'false');
    sh(repo, 'config', 'commit.gpgsign', 'false');
    replaceModel(repo, DEMO_PROD);
    fs.writeFileSync(path.join(repo, 'Apothecary.pbip'), '{}');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'prod');
    sh(repo, 'switch', '--quiet', '-c', 'dev');
    replaceModel(repo, DEMO_DEV);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'dev');
    sh(repo, 'switch', '--quiet', 'main');
    return repo;
}

function service(t) {
    const work = tempDir(t, 'ma-git-log-');
    activityLog.setLogDir(path.join(work, 'logs'));
    // No Fabric sign-in: Git and local comparisons must not need one.
    const auth = { getAccessToken: async () => null };
    return createService({ auth, backupDir: path.join(work, 'backups') });
}

const gitSide = (repo, ref, modelPath = MODEL) => ({ type: 'git', repoPath: repo, ref, modelPath });

// ── git-client ────────────────────────────────────────────────────────────────

test('git: a path inside a .SemanticModel finds the repository root and the model', async t => {
    const repo = makeRepo(t);
    const info = await git.inspectRepository(path.join(repo, MODEL, 'definition', 'tables'));
    assert.strictEqual(path.resolve(info.root), path.resolve(repo));
    assert.strictEqual(info.currentBranch, 'main');
    assert.strictEqual(info.modelPathHint, MODEL);

    const fromPbip = await git.inspectRepository(path.join(repo, 'Apothecary.pbip'));
    assert.strictEqual(fromPbip.modelPathHint, MODEL);
});

test('git: a folder outside any repository is REPOSITORY_NOT_FOUND', async t => {
    const plain = tempDir(t);
    await assert.rejects(git.inspectRepository(plain), e => e.code === 'REPOSITORY_NOT_FOUND' && e.status === 404);
    await assert.rejects(git.inspectRepository(path.join(plain, 'missing')), e => e.code === 'REPOSITORY_NOT_FOUND');
    await assert.rejects(git.inspectRepository(''), e => e.code === 'INVALID_INPUT');
});

test('git: branches resolve to SHAs; missing and option-like refs are refused', async t => {
    const repo = makeRepo(t);
    const sha = await git.resolveCommit(repo, 'dev');
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.strictEqual(sha, sh(repo, 'rev-parse', 'dev'));

    await assert.rejects(git.resolveCommit(repo, 'no-such-branch'), e => e.code === 'REVISION_NOT_FOUND' && /Fetch/.test(e.message));
    await assert.rejects(git.resolveCommit(repo, '--upload-pack=calc'), e => e.code === 'INVALID_INPUT');
    await assert.rejects(git.resolveCommit(repo, 'main dev'), e => e.code === 'INVALID_INPUT');
});

test('git: listBranches marks the checked-out branch and separates remotes', async t => {
    const repo = makeRepo(t);
    const clone = tempDir(t);
    sh(clone, 'clone', '--quiet', repo, '.');

    const { branches } = await git.listBranches(clone);
    const current = branches.find(b => b.current);
    assert.strictEqual(current.name, 'main');
    assert.strictEqual(current.type, 'local');
    assert.ok(branches.some(b => b.type === 'remote' && b.name === 'origin/dev'));
    assert.ok(!branches.some(b => b.name === 'origin/HEAD'), 'the symbolic origin/HEAD is not a branch');
});

test('git: fetch picks up new commits; a second fetch at the same time is refused', async t => {
    const upstream = makeRepo(t);
    const clone = tempDir(t);
    sh(clone, 'clone', '--quiet', upstream, '.');
    const before = await git.resolveCommit(clone, 'origin/dev');

    sh(upstream, 'switch', '--quiet', 'dev');
    fs.appendFileSync(path.join(upstream, MODEL, 'definition', 'model.tmdl'), '\n');
    sh(upstream, 'commit', '--quiet', '-am', 'more');

    const result = await git.fetchAll(clone);
    assert.strictEqual(result.fetched, true);
    assert.notStrictEqual(await git.resolveCommit(clone, 'origin/dev'), before);

    let release;
    const held = git.withRepoLock(clone, () => new Promise(r => { release = r; }));
    await assert.rejects(git.fetchAll(clone), e => e.code === 'FETCH_IN_PROGRESS' && e.status === 409);
    release();
    await held;
});

test('git: a repository without remotes fetches nothing', async t => {
    const repo = makeRepo(t);
    assert.deepStrictEqual(await git.fetchAll(repo), { fetched: false, remotes: [] });
});

test('git: uncommitted files are counted per folder', async t => {
    const repo = makeRepo(t);
    assert.strictEqual(await git.countUncommitted(repo, MODEL), 0);
    fs.appendFileSync(path.join(repo, MODEL, 'definition', 'model.tmdl'), '\n');
    fs.writeFileSync(path.join(repo, MODEL, 'definition', 'tables', 'New.tmdl'), 'table New\n');
    assert.strictEqual(await git.countUncommitted(repo, MODEL), 2);
});

test('git: URLs in messages lose their credentials and query strings', () => {
    assert.strictEqual(git.redact('https://user:token@github.com/o/r.git?x=1 failed'), 'https://***@github.com/o/r.git failed');
    assert.strictEqual(git.redact('ssh://git@host/r.git'), 'ssh://***@host/r.git');
});

// ── model discovery and loading ───────────────────────────────────────────────

test('git models: discovery needs definition/model.tmdl or database.tmdl', async t => {
    const repo = makeRepo(t);
    fs.mkdirSync(path.join(repo, 'Decoy.SemanticModel'));
    fs.writeFileSync(path.join(repo, 'Decoy.SemanticModel', 'readme.md'), 'not a model');
    fs.mkdirSync(path.join(repo, 'more', 'Second.SemanticModel', 'definition'), { recursive: true });
    fs.copyFileSync(path.join(DEMO_PROD, 'definition', 'database.tmdl'), path.join(repo, 'more', 'Second.SemanticModel', 'definition', 'database.tmdl'));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'more');

    const models = await gitModels.discoverModels(repo, await git.resolveCommit(repo, 'main'));
    assert.deepStrictEqual(models.map(m => m.modelPath), [MODEL, 'more/Second.SemanticModel']);
    assert.strictEqual(models[0].name, 'Apothecary');
});

test('git models: a model path must be relative, clean and discovered', () => {
    const discovered = [{ modelPath: 'a/Sales.SemanticModel', name: 'Sales' }];
    assert.strictEqual(gitModels.validateModelPath('a\\Sales.SemanticModel', discovered), 'a/Sales.SemanticModel');
    assert.strictEqual(gitModels.validateModelPath('a/Sales.SemanticModel/', discovered), 'a/Sales.SemanticModel');
    for (const bad of ['../Sales.SemanticModel', '/a/Sales.SemanticModel', 'C:/a/Sales.SemanticModel', 'a/./Sales.SemanticModel', 'a//Sales.SemanticModel', 'a/Sales', 'a\0/Sales.SemanticModel', '']) {
        assert.throws(() => gitModels.validateModelPath(bad, discovered), e => e.code === 'INVALID_INPUT', bad);
    }
    assert.throws(() => gitModels.validateModelPath('b/Sales.SemanticModel', discovered), e => e.code === 'MODEL_NOT_FOUND');
});

test('git models: a branch parses exactly like the same files on disk', async t => {
    const repo = makeRepo(t);
    for (const [ref, folder] of [['main', DEMO_PROD], ['dev', DEMO_DEV]]) {
        const sha = await git.resolveCommit(repo, ref);
        const fromGit = await gitModels.loadModelFromGitRef({ root: repo, sha, modelPath: MODEL, ref });
        const fromDisk = loadModelFromFolder(folder);
        assert.deepStrictEqual(Object.keys(fromGit.rawFiles).sort(), Object.keys(fromDisk.rawFiles).sort(), ref);
        assert.strictEqual(compareModels(fromGit, fromDisk, 'git', 'disk').diffs.length, 0, `${ref} equals its folder`);
        assert.strictEqual(fromGit.sourceType, 'git');
        assert.strictEqual(fromGit.git.sha, sha);
    }
});

test('git models: reading branches never touches the checkout', async t => {
    const repo = makeRepo(t);
    fs.appendFileSync(path.join(repo, MODEL, 'definition', 'model.tmdl'), '\n');
    const headBefore = sh(repo, 'rev-parse', 'HEAD');
    const statusBefore = sh(repo, 'status', '--porcelain');

    for (const ref of ['main', 'dev']) {
        const sha = await git.resolveCommit(repo, ref);
        await gitModels.loadModelFromGitRef({ root: repo, sha, modelPath: MODEL, ref });
    }

    assert.strictEqual(sh(repo, 'rev-parse', 'HEAD'), headBefore);
    assert.strictEqual(sh(repo, 'status', '--porcelain'), statusBefore);
    assert.strictEqual(sh(repo, 'branch', '--show-current'), 'main');
});

// ── shared model builder ──────────────────────────────────────────────────────

test('build-model: only the TMDL folder layout is read', () => {
    assert.ok(isDefinitionFile('model.tmdl'));
    assert.ok(isDefinitionFile('tables/Sales.tmdl'));
    assert.ok(!isDefinitionFile('tables/sub/Sales.tmdl'));
    assert.ok(!isDefinitionFile('tables/Sales.json'));
    assert.ok(!isDefinitionFile('diagramLayout.json'));

    const model = buildModelFromFiles({ 'model.tmdl': 'model Model\n', 'notes.txt': 'x' }, { name: 'M' });
    assert.deepStrictEqual(Object.keys(model.rawFiles), ['model.tmdl']);
    assert.throws(() => buildModelFromFiles({ 'tables/A.tmdl': 'table A\n' }), /Expected model.tmdl or database.tmdl/);
    assert.throws(() => buildModelFromFiles({ 'model.tmdl': 'model M\n  culture: en-US\n' }), /Invalid TMDL indentation/);
});

// ── service ───────────────────────────────────────────────────────────────────

test('service: branch to branch compares without a Fabric sign-in', async t => {
    const repo = makeRepo(t);
    const svc = service(t);
    const state = sessionStore.getState('git-a');

    const { status, body } = await svc.compareFabric(state, { devSource: gitSide(repo, 'dev'), prodSource: gitSide(repo, 'main') });
    assert.strictEqual(status, 200, JSON.stringify(body));

    const expected = compareModels(loadModelFromFolder(DEMO_DEV), loadModelFromFolder(DEMO_PROD), 'a', 'b').diffs.length;
    assert.strictEqual(body.diffs.length, expected);
    assert.strictEqual(body.sources.source.type, 'git');
    assert.strictEqual(body.sources.source.ref, 'dev');
    assert.strictEqual(body.sources.source.resolvedSha, sh(repo, 'rev-parse', 'dev'));
    assert.strictEqual(body.sources.target.shortSha, sh(repo, 'rev-parse', 'main').slice(0, 7));
    assert.match(body.devSource, /^Git: .+@dev \([0-9a-f]{7}\)\/Apothecary\.SemanticModel$/);

    assert.deepStrictEqual(state.lastProdGitInfo, { repoRoot: body.sources.target.repoRoot, ref: 'main', sha: body.sources.target.resolvedSha, modelPath: MODEL });
    assert.strictEqual(state.lastProdPath, null);
    assert.strictEqual(state.lastProdFabricInfo, null);
});

test('service: a Git target previews and deploys into a new branch', async t => {
    const repo = makeRepo(t);
    const svc = service(t);
    const state = sessionStore.getState('git-b');
    const compared = await svc.compareFabric(state, { devSource: gitSide(repo, 'dev'), prodSource: gitSide(repo, 'main') });
    const measure = compared.body.diffs.find(d => d.type === 2 && d.objectType === 'measure');

    const preview = await svc.previewDeploy(state, { selectedKeys: [measure.identityKey], openPullRequest: false });
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.git.baseRef, 'main');

    const res = await svc.deploy(state, { selectedKeys: [measure.identityKey], branchName: 'promote/service', openPullRequest: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true, JSON.stringify(res.body.errors));
    assert.strictEqual(sh(repo, 'rev-parse', 'promote/service'), res.body.git.commitSha);
    assert.strictEqual(sh(repo, 'branch', '--show-current'), 'main', 'the checkout stays on its branch');
});

test('service: Git mixes with local, and a later local compare clears the Git target', async t => {
    const repo = makeRepo(t);
    const svc = service(t);
    const state = sessionStore.getState('git-c');

    const gitToLocal = await svc.compareFabric(state, { devSource: gitSide(repo, 'dev'), prodSource: { type: 'local', path: DEMO_PROD } });
    assert.strictEqual(gitToLocal.status, 200);
    assert.strictEqual(gitToLocal.body.sources.target.type, 'local');
    assert.ok(state.lastProdPath);
    assert.strictEqual(state.lastProdGitInfo, null);

    const localToGit = await svc.compareFabric(state, { devSource: { type: 'local', path: DEMO_DEV }, prodSource: gitSide(repo, 'main') });
    assert.strictEqual(localToGit.status, 200);
    assert.strictEqual(localToGit.body.diffs.length, gitToLocal.body.diffs.length);
    assert.ok(state.lastProdGitInfo);
    assert.strictEqual(state.lastProdPath, null);

    const plain = svc.compare(state, { devPath: DEMO_DEV, prodPath: DEMO_PROD });
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(state.lastProdGitInfo, null, 'resetComparison clears the Git target');
});

test('service: the Git tab compares the last commit, not uncommitted edits', async t => {
    const repo = makeRepo(t);
    const svc = service(t);
    // An uncommitted edit on the checked-out branch (main): a new measure-free table file.
    fs.writeFileSync(path.join(repo, MODEL, 'definition', 'tables', 'Scratch.tmdl'), 'table Scratch\n\tlineageTag: x\n');

    const res = await svc.compareFabric(sessionStore.getState('git-d'), { devSource: gitSide(repo, 'main'), prodSource: { type: 'local', path: DEMO_PROD } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.diffs.length, 0);

    const models = await svc.gitModels(sessionStore.getState('git-d'), { repoPath: repo, ref: 'main' });
    assert.strictEqual(models.status, 200);
    assert.strictEqual(models.body.checkedOut, true);
    assert.strictEqual(models.body.models[0].uncommitted, 1);

    const other = await svc.gitModels(sessionStore.getState('git-d'), { repoPath: repo, ref: 'dev' });
    assert.strictEqual(other.body.checkedOut, false);
    assert.strictEqual(other.body.models[0].uncommitted, undefined);
});

test('service: bad Git input answers with a status and a stable code', async t => {
    const repo = makeRepo(t);
    const svc = service(t);
    const state = sessionStore.getState('git-e');
    const local = { type: 'local', path: DEMO_PROD };

    const missingRef = await svc.compareFabric(state, { devSource: gitSide(repo, 'nope'), prodSource: local });
    assert.strictEqual(missingRef.status, 404);
    assert.strictEqual(missingRef.body.code, 'REVISION_NOT_FOUND');

    const traversal = await svc.compareFabric(state, { devSource: gitSide(repo, 'dev', '../Apothecary.SemanticModel'), prodSource: local });
    assert.strictEqual(traversal.status, 400);
    assert.strictEqual(traversal.body.code, 'INVALID_INPUT');

    const notRepo = await svc.gitOpen(state, { path: tempDir(t) });
    assert.strictEqual(notRepo.status, 404);
    assert.strictEqual(notRepo.body.code, 'REPOSITORY_NOT_FOUND');

    const fabricNoToken = await svc.compareFabric(state, { devSource: { type: 'fabric', connectionString: 'x' }, prodSource: local });
    assert.strictEqual(fabricNoToken.status, 401, 'a Fabric side still needs a sign-in');

    const unknown = await svc.compareFabric(state, { devSource: { type: 'svn' }, prodSource: local });
    assert.strictEqual(unknown.status, 400);
});

test('service: open, branches and models describe the repository', async t => {
    const repo = makeRepo(t);
    const svc = service(t);
    const state = sessionStore.getState('git-f');

    const opened = await svc.gitOpen(state, { path: path.join(repo, MODEL) });
    assert.strictEqual(opened.status, 200);
    assert.strictEqual(opened.body.modelPathHint, MODEL);
    assert.deepStrictEqual(opened.body.remotes, []);

    const branches = await svc.gitBranches(state, { repoPath: repo });
    assert.deepStrictEqual(branches.body.branches.map(b => b.name).sort(), ['dev', 'main']);
    assert.strictEqual(branches.body.currentBranch, 'main');

    const models = await svc.gitModels(state, { repoPath: repo, ref: 'dev' });
    assert.strictEqual(models.body.sha, sh(repo, 'rev-parse', 'dev'));
    assert.deepStrictEqual(models.body.models.map(m => m.modelPath), [MODEL]);
});

test('routes: the Git operations are in the shared route table', () => {
    for (const [p, op] of [['/api/git/open', 'gitOpen'], ['/api/git/branches', 'gitBranches'], ['/api/git/models', 'gitModels'], ['/api/git/fetch', 'gitFetch']]) {
        assert.strictEqual(matchRoute('POST', p).route.operation, op);
    }
});

// ── UI logic ──────────────────────────────────────────────────────────────────

test('ui: branch and model defaults', () => {
    const branches = [
        { name: 'origin/main', type: 'remote' },
        { name: 'dev', type: 'local' },
        { name: 'main', type: 'local' }
    ];
    assert.strictEqual(Pure.pickBranch(branches, 'dev', 'main'), 'dev');
    assert.strictEqual(Pure.pickBranch(branches, 'gone', 'main'), 'main');
    assert.strictEqual(Pure.pickBranch(branches, null, null), 'dev');
    assert.strictEqual(Pure.pickBranch([], 'x', 'y'), '');

    const models = [{ modelPath: 'a/A.SemanticModel' }, { modelPath: 'b/B.SemanticModel' }];
    assert.strictEqual(Pure.pickModelPath(models, 'b/B.SemanticModel', 'a/A.SemanticModel'), 'b/B.SemanticModel');
    assert.strictEqual(Pure.pickModelPath(models, 'gone', 'a/A.SemanticModel'), 'a/A.SemanticModel');
    assert.strictEqual(Pure.pickModelPath(models, null, null), null, 'two models and no hint: the user chooses');
    assert.strictEqual(Pure.pickModelPath([models[0]], null, null), 'a/A.SemanticModel');
});

test('ui: a Git side says what is missing before it can compare', () => {
    const sel = Pure.emptyGitSelection();
    assert.strictEqual(Pure.gitSelectionProblem(sel), 'Open a Git repository');
    sel.repoRoot = '/r';
    assert.strictEqual(Pure.gitSelectionProblem(sel), 'Select a branch');
    sel.ref = 'main';
    assert.strictEqual(Pure.gitSelectionProblem(sel), 'This branch has no semantic model');
    sel.models = [{ modelPath: 'A.SemanticModel' }];
    assert.strictEqual(Pure.gitSelectionProblem(sel), 'Select a semantic model');
    sel.modelPath = 'A.SemanticModel';
    assert.strictEqual(Pure.gitSelectionProblem(sel), null);
    assert.deepStrictEqual(Pure.gitDescriptor(sel), { type: 'git', repoPath: '/r', ref: 'main', modelPath: 'A.SemanticModel' });
    assert.strictEqual(Pure.gitLabel(sel), '🌿 A @ main');
});

test('ui: the status line warns about uncommitted files on the checked-out branch', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const sel = Object.assign(Pure.emptyGitSelection(), {
        repoRoot: '/r', repoName: 'sales', ref: 'main', shortSha: 'abc1234', remotes: ['origin'],
        lastFetchAt: '2026-10-28T10:00:00Z', models: [{ modelPath: 'A.SemanticModel', uncommitted: 3 }], modelPath: 'A.SemanticModel'
    });
    assert.deepStrictEqual(Pure.gitStatusLine(sel, now), { text: 'sales · main @ abc1234 · last fetch 2 h ago', kind: '' });
    sel.checkedOut = true;
    const warned = Pure.gitStatusLine(sel, now);
    assert.strictEqual(warned.kind, 'warning');
    assert.match(warned.text, /3 uncommitted files in this model are not included; use the Local tab/);
    assert.strictEqual(Pure.relativeTime(null, now), 'never');
    assert.strictEqual(Pure.relativeTime('2026-10-27T12:00:00Z', now), '1 day ago');
});

test('ui: a branch that moved since it was selected is called out until it is compared', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    const sel = Object.assign(Pure.emptyGitSelection(), {
        repoRoot: '/r', repoName: 'sales', ref: 'main', shortSha: '180d370', movedFrom: '780ecf6',
        models: [{ modelPath: 'A.SemanticModel', uncommitted: 0 }], modelPath: 'A.SemanticModel'
    });
    const moved = Pure.gitStatusLine(sel, now);
    assert.strictEqual(moved.kind, 'warning');
    assert.strictEqual(moved.text, 'sales · main @ 180d370 · no remote. The branch moved since it was selected (was 780ecf6); Compare uses 180d370.');

    sel.checkedOut = true;
    sel.models[0].uncommitted = 2;
    assert.match(Pure.gitStatusLine(sel, now).text, /Compare uses 180d370\. 2 uncommitted files/, 'both notes, one full stop between them');

    sel.movedFrom = null;
    sel.models[0].uncommitted = 0;
    assert.deepStrictEqual(Pure.gitStatusLine(sel, now), { text: 'sales · main @ 180d370 · no remote', kind: '' });
});

test('ui: every comparison updates the Git panels with the commit it used', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf-8');
    // Compare and the results Refresh both go through it.
    assert.strictEqual((app.match(/syncGitFromComparison\(comparisonResult\)/g) || []).length, 2);
    // Coming back to the window re-reads the visible Git panels.
    assert.match(app, /addEventListener\('focus', refreshVisibleGitSides\)/);
});

test('ui: the Git deploy dialog summary, blocking problems and button label', () => {
    const plan = { baseRef: 'origin/main', baseShortSha: '780ecf6', remote: 'origin', provider: 'github', baseBranch: 'main',
        problems: [{ code: 'PR_CLI_MISSING', blocking: false }, { code: 'BRANCH_EXISTS', blocking: true }] };
    assert.strictEqual(Pure.gitPlanSummary(plan), 'New branch from origin/main @ 780ecf6, pushed to origin (GitHub); pull request into main.');
    assert.strictEqual(Pure.gitPlanSummary(Object.assign({}, plan, { remote: null })), 'New branch from origin/main @ 780ecf6; no remote to push to.');
    assert.deepStrictEqual(Pure.gitBlockingProblems(plan).map(p => p.code), ['BRANCH_EXISTS']);
    assert.strictEqual(Pure.gitConfirmLabel(true, true), 'Create branch and open draft PR');
    assert.strictEqual(Pure.gitConfirmLabel(true, false), 'Create branch and open PR');
    assert.strictEqual(Pure.gitConfirmLabel(false, true), 'Create local branch');
});
