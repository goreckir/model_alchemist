const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeRepo, sh, tempDir, MODEL } = require('./helpers/git-repo');
const { deployToGit, cleanupAbandonedWorktrees, defaultBranchName, pullRequestBody, WORKTREE_PREFIX } = require('../core/git-deploy');
const prProvider = require('../git/pr-provider');
const { rejectReason } = require('../lib/request-guard');
const { createService } = require('../core/service');
const sessionStore = require('../lib/session-store');
const activityLog = require('../lib/activity-log');

// Deploying into a Git branch: a new branch from the compared commit, in a
// temporary worktree, then push and a draft pull request. Real Git, temporary
// repositories with a bare origin, a stubbed pull-request call.

function service(t) {
    const work = tempDir(t, 'ma-git-log-');
    activityLog.setLogDir(path.join(work, 'logs'));
    return createService({ auth: { getAccessToken: async () => null }, backupDir: path.join(work, 'backups') });
}

const gitSide = (repo, ref) => ({ type: 'git', repoPath: repo, ref, modelPath: MODEL });

/**
 * Compare dev → main and pick a modified object that deploys cleanly on its own.
 * Measures first: replacing a measure block is idempotent, which the
 * "nothing to commit" test relies on.
 */
async function compareAndPick(t, repo, sessionId) {
    const svc = service(t);
    const state = sessionStore.getState(sessionId);
    const compared = await svc.compareFabric(state, { devSource: gitSide(repo, 'dev'), prodSource: gitSide(repo, 'main') });
    assert.strictEqual(compared.status, 200, JSON.stringify(compared.body));
    const modified = compared.body.diffs.filter(d => d.type === 2);
    const ordered = modified.filter(d => d.objectType === 'measure').concat(modified.filter(d => d.objectType !== 'measure'));
    for (const diff of ordered) {
        const preview = await svc.previewDeploy(state, { selectedKeys: [diff.identityKey], openPullRequest: false });
        if (preview.status === 200 && preview.body.success && !(preview.body.errors || []).length) {
            return { svc, state, diff, comparison: compared.body };
        }
    }
    throw new Error('no modified object deploys on its own');
}

function worktreeCount(repo) {
    return sh(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;
}

function leftoverWorktreeFolders() {
    return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(WORKTREE_PREFIX));
}

// ── preview ───────────────────────────────────────────────────────────────────

test('git deploy: the preview plans the branch and creates nothing', async t => {
    const { repo } = makeRepo(t, { origin: true });
    const { svc, state, diff } = await compareAndPick(t, repo, 'gd-preview');
    const before = sh(repo, 'branch', '--list');

    const preview = await svc.previewDeploy(state, { selectedKeys: [diff.identityKey] });
    assert.strictEqual(preview.status, 200);
    const g = preview.body.git;
    assert.strictEqual(g.baseRef, 'main');
    assert.strictEqual(g.baseSha, sh(repo, 'rev-parse', 'main'));
    assert.strictEqual(g.remote, 'origin');
    assert.strictEqual(g.baseBranch, 'main');
    assert.match(g.branchName, /^model-alchemist\/dev-\d{8}-\d{4}$/);
    assert.match(g.commitMessage, /^Promote 1 object from dev \([0-9a-f]{7}\)\n\n- Update /);
    assert.strictEqual(g.draft, true, 'a draft by default');
    assert.strictEqual(g.openPullRequest, true);
    assert.strictEqual(g.provider, 'unknown', 'a bare folder remote is neither GitHub nor Azure DevOps');
    assert.ok(g.problems.some(p => p.code === 'PR_UNSUPPORTED_REMOTE' && !p.blocking));
    assert.ok(preview.body.actions.length > 0, 'the planned file operations are listed');

    assert.strictEqual(worktreeCount(repo), 1, 'no worktree for a preview');
    assert.strictEqual(sh(repo, 'branch', '--list'), before, 'no branch for a preview');
});

// ── deploy ────────────────────────────────────────────────────────────────────

test('git deploy: local branch only commits exactly the selection and leaves the checkout alone', async t => {
    const { repo } = makeRepo(t);
    fs.appendFileSync(path.join(repo, 'README.md'), 'uncommitted edit\n');
    const statusBefore = sh(repo, 'status', '--porcelain');
    const { svc, state, diff, comparison } = await compareAndPick(t, repo, 'gd-local');

    const res = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'promote/one', openPullRequest: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true, JSON.stringify(res.body.errors));
    const g = res.body.git;
    assert.strictEqual(g.branch, 'promote/one');
    assert.strictEqual(g.pushed, false);
    assert.strictEqual(g.stoppedAt, null);
    assert.strictEqual(sh(repo, 'rev-parse', 'promote/one'), g.commitSha);
    assert.strictEqual(sh(repo, 'rev-parse', 'promote/one^'), sh(repo, 'rev-parse', 'main'), 'branched from the compared commit');

    const changed = sh(repo, 'diff', '--name-only', 'main', 'promote/one').split('\n');
    assert.ok(changed.length >= 1 && changed.every(f => f.startsWith(`${MODEL}/definition/`)), changed.join(', '));

    // The user's checkout: same branch, same uncommitted edit, no extra worktree.
    assert.strictEqual(sh(repo, 'branch', '--show-current'), 'main');
    assert.strictEqual(sh(repo, 'status', '--porcelain'), statusBefore);
    assert.strictEqual(worktreeCount(repo), 1);

    // The new branch now holds that object exactly as dev has it.
    const again = await svc.compareFabric(sessionStore.getState('gd-local-2'), { devSource: gitSide(repo, 'dev'), prodSource: gitSide(repo, 'promote/one') });
    assert.ok(!again.body.diffs.some(d => d.identityKey === diff.identityKey), 'the deployed object no longer differs');
    assert.strictEqual(again.body.diffs.length, comparison.diffs.length - 1);
});

test('git deploy: push and a draft pull request with the selection in its body', async t => {
    const { repo, origin } = makeRepo(t, { origin: true });
    const { state, diff, comparison } = await compareAndPick(t, repo, 'gd-pr');
    const gitInfo = state.lastProdGitInfo;
    const calls = [];

    const result = await deployToGit([diff], state.lastDevModel, state.lastProdModel, gitInfo, {
        allDiffs: comparison.diffs,
        sources: comparison.sources,
        branchName: 'promote/pr',
        createPullRequest: async args => { calls.push(args); return { url: 'https://example.test/pr/7', number: 7, draft: args.draft }; }
    });

    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.strictEqual(result.git.pushed, true);
    assert.match(sh(origin, 'branch', '--list', 'promote/pr'), /promote\/pr/, 'the branch is on the remote');
    assert.deepStrictEqual(result.git.pullRequest, { url: 'https://example.test/pr/7', number: 7, draft: true });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].base, 'main');
    assert.strictEqual(calls[0].head, 'promote/pr');
    assert.strictEqual(calls[0].draft, true);
    assert.match(calls[0].title, /^Promote 1 object from dev/);
    assert.ok(calls[0].body.includes(diff.displayName.replace(/\|/g, '\\|')), 'the PR body lists the object');
    assert.ok(calls[0].body.includes(gitInfo.sha), 'the PR body names the base commit');
});

test('git deploy: a target branch that moved is a warning; the branch starts from the compared commit', async t => {
    const { repo } = makeRepo(t);
    const { svc, state, diff } = await compareAndPick(t, repo, 'gd-moved');
    const compared = sh(repo, 'rev-parse', 'main');
    sh(repo, 'commit', '--quiet', '--allow-empty', '-m', 'someone else');

    const res = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'promote/moved', openPullRequest: false });
    assert.strictEqual(res.body.success, true, JSON.stringify(res.body.errors));
    assert.ok(res.body.warnings.some(w => w.code === 'TARGET_BRANCH_MOVED' && /1 new commit/.test(w.message)));
    assert.strictEqual(sh(repo, 'rev-parse', 'promote/moved^'), compared);
});

test('git deploy: an existing branch name blocks the deploy before anything is written', async t => {
    const { repo } = makeRepo(t);
    const { svc, state, diff } = await compareAndPick(t, repo, 'gd-exists');

    const res = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'dev', openPullRequest: false });
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errors[0].code, 'BRANCH_EXISTS');
    assert.strictEqual(worktreeCount(repo), 1);

    const bad = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'bad..name', openPullRequest: false });
    assert.strictEqual(bad.body.errors[0].code, 'INVALID_INPUT');
});

test('git deploy: a missing Git identity is reported before anything is written', async t => {
    const { repo } = makeRepo(t);
    const { svc, state, diff } = await compareAndPick(t, repo, 'gd-ident');
    sh(repo, 'config', '--unset', 'user.name');
    sh(repo, 'config', '--unset', 'user.email');
    const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = path.join(tempDir(t), 'none');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    t.after(() => {
        if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g;
        if (saved.s === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.s;
    });

    const res = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'promote/ident', openPullRequest: false });
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.errors[0].code, 'GIT_IDENTITY_MISSING');
});

test('git deploy: changes already in the target branch commit nothing', async t => {
    const { repo } = makeRepo(t);
    const { state, diff, comparison } = await compareAndPick(t, repo, 'gd-noop');
    const first = await deployToGit([diff], state.lastDevModel, state.lastProdModel, state.lastProdGitInfo, { allDiffs: comparison.diffs, sources: comparison.sources, branchName: 'promote/first', openPullRequest: false });
    assert.strictEqual(first.success, true, JSON.stringify(first.errors));

    // Same change onto the branch that already has it.
    const onFirst = Object.assign({}, state.lastProdGitInfo, { ref: 'promote/first', sha: first.git.commitSha });
    const second = await deployToGit([diff], state.lastDevModel, state.lastProdModel, onFirst, { allDiffs: comparison.diffs, sources: comparison.sources, branchName: 'promote/second', openPullRequest: false });
    assert.strictEqual(second.success, false);
    assert.ok(second.errors.some(e => e.code === 'NOTHING_TO_COMMIT'), JSON.stringify(second.errors));
    assert.strictEqual(sh(repo, 'branch', '--list', 'promote/second'), '', 'no branch for an empty change');
});

test('git deploy: a failed push keeps the committed local branch and says where it stopped', async t => {
    const { repo } = makeRepo(t, { origin: true });
    const { svc, state, diff } = await compareAndPick(t, repo, 'gd-push');
    sh(repo, 'remote', 'set-url', 'origin', path.join(tempDir(t), 'missing-remote'));

    const res = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'promote/push' });
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.git.stoppedAt, 'push');
    assert.strictEqual(res.body.git.pushed, false);
    assert.ok(res.body.git.commitSha);
    assert.strictEqual(sh(repo, 'rev-parse', 'promote/push'), res.body.git.commitSha);
    assert.ok(res.body.errors.some(e => e.code === 'PUSH_FAILED'));
    assert.strictEqual(worktreeCount(repo), 1);
});

test('git deploy: a CRLF repository keeps CRLF and the commit holds only the real change', async t => {
    const { repo } = makeRepo(t, { crlf: true });
    const { svc, state, diff } = await compareAndPick(t, repo, 'gd-crlf');

    const res = await svc.deploy(state, { selectedKeys: [diff.identityKey], branchName: 'promote/crlf', openPullRequest: false });
    assert.strictEqual(res.body.success, true, JSON.stringify(res.body.errors));
    for (const line of sh(repo, 'diff', '--numstat', 'main', 'promote/crlf').split('\n')) {
        const [added, removed, file] = line.split('\t');
        assert.ok(Number(added) + Number(removed) < 40, `${file} rewritten: +${added} -${removed}`);
        const content = sh(repo, 'show', `promote/crlf:${file}`);
        assert.ok(!/[^\r]\n/.test(content), `${file} keeps CRLF`);
    }
});

test('git deploy: abandoned worktrees are removed and pruned; fresh ones are left alone', async t => {
    const { repo } = makeRepo(t);
    const tmp = tempDir(t, 'ma-tmp-');
    const old = path.join(tmp, `${WORKTREE_PREFIX}old`);
    const fresh = path.join(tmp, `${WORKTREE_PREFIX}fresh`);
    sh(repo, 'worktree', 'add', '--detach', '--quiet', old, 'main');
    sh(repo, 'worktree', 'add', '--detach', '--quiet', fresh, 'main');
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(old, longAgo, longAgo);

    const removed = await cleanupAbandonedWorktrees({ tmpDir: tmp });
    assert.deepStrictEqual(removed, [old]);
    assert.ok(!fs.existsSync(old));
    assert.ok(fs.existsSync(fresh));
    assert.strictEqual(worktreeCount(repo), 2, 'the abandoned one is pruned from Git too');
});

test('git deploy: defaults for branch name and PR body', () => {
    const sources = { source: { type: 'git', ref: 'origin/feature/Margin Fix', shortSha: 'abc1234', resolvedSha: 'abc1234def' } };
    assert.strictEqual(defaultBranchName(sources, new Date('2026-10-28T13:45:00Z')), 'model-alchemist/margin-fix-20261028-1345');
    const body = pullRequestBody([{ type: 0, objectType: 'measure', displayName: "Sales.'A|B'", changeGroup: 'Measures' }], sources, [{ code: 'X', message: 'careful' }],
        { baseBranch: 'main', baseRef: 'main', baseSha: 'f00' });
    assert.match(body, /\| Add \| measure \| Sales\.'A\\\|B' \| Measures \|/);
    assert.match(body, /`X` careful/);
    assert.match(body, /at `f00`/);
});

test('git deploy: no worktree folder is left in the temp directory', () => {
    // Runs after the deploy tests in this file (node:test runs a file's tests in order).
    const fresh = leftoverWorktreeFolders().filter(n => Date.now() - fs.statSync(path.join(os.tmpdir(), n)).mtimeMs < 5 * 60 * 1000);
    assert.deepStrictEqual(fresh, []);
});

// ── pull-request provider ─────────────────────────────────────────────────────

test('pr provider: GitHub and Azure DevOps remotes are recognised', () => {
    const gh = prProvider.parseRemote('git@github.com:goreckir/model_alchemist.git');
    assert.deepStrictEqual([gh.kind, gh.owner, gh.repo], ['github', 'goreckir', 'model_alchemist']);
    assert.strictEqual(prProvider.parseRemote('https://github.com/o/r').webUrl, 'https://github.com/o/r');
    assert.strictEqual(prProvider.parseRemote('https://user:tok@github.com/o/r.git').kind, 'github');

    for (const url of ['https://dev.azure.com/org/Proj%20X/_git/repo', 'https://org@dev.azure.com/org/Proj%20X/_git/repo', 'git@ssh.dev.azure.com:v3/org/Proj%20X/repo', 'https://org.visualstudio.com/Proj%20X/_git/repo']) {
        const az = prProvider.parseRemote(url);
        assert.deepStrictEqual([az.kind, az.org, az.project, az.repo], ['azure', 'org', 'Proj X', 'repo'], url);
    }
    assert.strictEqual(prProvider.parseRemote('C:/repos/origin').kind, 'unknown');
    assert.strictEqual(prProvider.parseRemote('https://gitlab.com/o/r.git').kind, 'unknown');

    assert.strictEqual(prProvider.compareUrl(gh, 'main', 'model-alchemist/x'), 'https://github.com/goreckir/model_alchemist/compare/main...model-alchemist/x?expand=1');
});

test('pr provider: gh is called with a draft, the body on stdin and no shell', async () => {
    const seen = [];
    const exec = async (cli, args, opts) => { seen.push({ args, opts }); return { stdout: 'https://github.com/o/r/pull/42\n', stderr: '' }; };
    const pr = await prProvider.createPullRequest({ info: prProvider.parseRemote('https://github.com/o/r'), base: 'main', head: 'b', title: 'T', body: 'B', cwd: '/x', cli: { file: 'gh', prefix: [] }, exec });
    assert.deepStrictEqual(pr, { url: 'https://github.com/o/r/pull/42', number: 42, draft: true });
    assert.deepStrictEqual(seen[0].args, ['pr', 'create', '--repo', 'o/r', '--base', 'main', '--head', 'b', '--title', 'T', '--body-file', '-', '--draft']);
    assert.strictEqual(seen[0].opts.input, 'B');
});

test('pr provider: az gets one description value per line, bullets cannot read as options', async () => {
    let seen;
    const exec = async (cli, args) => { seen = args; return { stdout: '{"pullRequestId": 9}', stderr: '' }; };
    const info = prProvider.parseRemote('https://dev.azure.com/org/proj/_git/repo');
    const pr = await prProvider.createPullRequest({ info, base: 'main', head: 'b', title: 'T', body: 'Line\n\n- item', draft: false, cli: { file: 'az', prefix: [] }, exec });
    assert.strictEqual(pr.url, 'https://dev.azure.com/org/proj/_git/repo/pullrequest/9');
    assert.deepStrictEqual(seen.slice(seen.indexOf('--draft'), seen.indexOf('--draft') + 2), ['--draft', 'false']);
    assert.deepStrictEqual(seen.slice(seen.indexOf('--description') + 1), ['Line', '* item']);
});

test('pr provider: a missing CLI and a failing CLI give stable codes, without secrets', async () => {
    const info = prProvider.parseRemote('https://github.com/o/r');
    await assert.rejects(prProvider.createPullRequest({ info, base: 'm', head: 'b', title: 't', body: '', cli: null }), e => e.code === 'PR_CLI_MISSING');
    await assert.rejects(prProvider.createPullRequest({ info: { kind: 'unknown' }, base: 'm', head: 'b', title: 't', body: '' }), e => e.code === 'PR_UNSUPPORTED_REMOTE');
    const failing = async () => { throw Object.assign(new Error('x'), { stderr: 'could not push to https://user:secret@github.com/o/r.git' }); };
    await assert.rejects(prProvider.createPullRequest({ info, base: 'm', head: 'b', title: 't', body: '', cli: { file: 'gh', prefix: [] }, exec: failing }),
        e => e.code === 'PR_CREATE_FAILED' && !e.message.includes('secret'));
});

// ── request guard ─────────────────────────────────────────────────────────────

test('request guard: only this server\'s own pages may call the API', () => {
    assert.strictEqual(rejectReason({ host: 'localhost:3001' }), null, 'no Origin: a local script');
    assert.strictEqual(rejectReason({ host: 'localhost:3001', origin: 'http://localhost:3001' }), null);
    assert.strictEqual(rejectReason({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001', 'sec-fetch-site': 'same-origin' }), null);
    assert.strictEqual(rejectReason({ host: '[::1]:3001', origin: 'http://[::1]:3001' }), null);

    assert.ok(rejectReason({ host: 'localhost:3001', origin: 'https://evil.example' }));
    assert.ok(rejectReason({ host: 'localhost:3001', origin: 'http://localhost:4000' }), 'another local port is another site');
    assert.ok(rejectReason({ host: 'localhost:3001', origin: 'null' }));
    assert.ok(rejectReason({ host: 'localhost:3001', 'sec-fetch-site': 'cross-site' }), 'a cross-site GET such as an image tag');
    assert.ok(rejectReason({ host: 'evil.example:3001' }), 'DNS rebinding');
    assert.ok(rejectReason({}));
});
