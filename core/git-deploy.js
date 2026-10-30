/**
 * Deploy selected changes into a Git branch, then (optionally) push it and
 * open a draft pull request.
 *
 * The twin of core/fabric-deploy.js: the target's files are materialised, the
 * existing deployer applies only the ticked objects, and the result goes back
 * to where the target lives. Here "back" is a new branch:
 *
 *   1. checks: branch name, branch does not exist, Git identity set
 *   2. a temporary worktree at the TARGET COMMIT THAT WAS COMPARED (pinned);
 *      if the target branch moved since, that is a warning, not a block:
 *      the pull request shows whether the branch still merges
 *   3. deployChanges() into <worktree>/<model>/definition
 *   4. nothing outside the model may have changed; nothing at all → no commit
 *   5. new branch, stage the model folder only, commit
 *   6. push to the remote the target branch tracks, open a draft PR
 *   7. remove the worktree; the branch stays
 *
 * The user's own checkout, index and current branch are never touched.
 * A preview (dryRun) creates no worktree and no branch.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const git = require('../git/git-client');
const prProvider = require('../git/pr-provider');
const { loadModelFromFolder } = require('../parser/model-loader');
const { deployChanges } = require('../deployment/deployer');
const { mergeDeployResultIntoResponse } = require('../lib/deploy-response');

const WORKTREE_PREFIX = 'model-alchemist-worktree-';
const CHANGE_WORD = { 0: 'Add', 1: 'Remove', 2: 'Update' };

// ===== Defaults the user can edit =====

function slug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'changes';
}

/** Short words for where the changes come from: "dev (ba0828b)", "Sales", "Fabric Sales/Model". */
function sourceLabel(meta) {
    if (!meta) return 'the source model';
    if (meta.type === 'git') return `${meta.ref} (${meta.shortSha})`;
    if (meta.type === 'fabric') return `Fabric ${meta.workspaceName}/${meta.modelName}`;
    const parts = String(meta.path || '').split(/[\\/]/).filter(Boolean);
    const folder = parts.reverse().find(p => p.toLowerCase() !== 'definition') || 'local model';
    return folder.replace(/\.SemanticModel$/i, '');
}

function defaultBranchName(sources, now = new Date()) {
    const s = sources && sources.source;
    const base = s && s.type === 'git' ? s.ref.split('/').pop() : sourceLabel(s);
    const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    return `model-alchemist/${slug(base)}-${stamp}`;
}

function describeDiff(d) {
    return `${CHANGE_WORD[d.type] || 'Change'} ${d.objectType} ${d.displayName}`;
}

function defaultCommitMessage(selectedDiffs, sources) {
    const n = selectedDiffs.length;
    const subject = `Promote ${n} object${n === 1 ? '' : 's'} from ${sourceLabel(sources && sources.source)}`;
    const lines = selectedDiffs.slice(0, 50).map(d => `- ${describeDiff(d)}`);
    if (selectedDiffs.length > 50) lines.push(`- … and ${selectedDiffs.length - 50} more`);
    return `${subject.slice(0, 100)}\n\n${lines.join('\n')}\n\nSelected and applied with Model Alchemist.`;
}

const mdCell = v => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** The pull request description: what was promoted, from where, onto which commit. */
function pullRequestBody(selectedDiffs, sources, warnings, plan) {
    const s = sources && sources.source;
    const rows = selectedDiffs.map(d => `| ${CHANGE_WORD[d.type] || 'Change'} | ${mdCell(d.objectType)} | ${mdCell(d.displayName)} | ${mdCell(d.changeGroup)} |`);
    const out = [
        `Promotes **${selectedDiffs.length}** selected object${selectedDiffs.length === 1 ? '' : 's'} from ${mdCell(sourceLabel(s))}${s && s.type === 'git' ? ` \`${s.resolvedSha}\`` : ''} into \`${plan.baseBranch}\`.`,
        '',
        `Based on \`${plan.baseRef}\` at \`${plan.baseSha}\`, the commit that was compared. Everything else in the target model is unchanged.`,
        '',
        '| Change | Type | Object | Group |',
        '|---|---|---|---|',
        ...rows
    ];
    const notable = (warnings || []).filter(w => w && w.code);
    if (notable.length) {
        out.push('', '**Warnings from the deploy preview**', '');
        for (const w of notable.slice(0, 20)) out.push(`* \`${w.code}\` ${mdCell(w.message || '')}`);
    }
    out.push('', '_Created with Model Alchemist._');
    return out.join('\n');
}

// ===== Target description shared by preview and deploy =====

/** The remote and base branch a pull request goes to, from the target branch. */
async function resolveRemote(root, ref, branches, remotes) {
    const split = full => {
        const remote = remotes.filter(r => full.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
        return remote ? { remote, baseBranch: full.slice(remote.length + 1) } : null;
    };
    const entry = branches.find(b => b.name === ref);
    if (entry && entry.type === 'remote') return split(ref);
    if (entry && entry.upstream) {
        const viaUpstream = split(entry.upstream);
        if (viaUpstream) return viaUpstream;
    }
    if (remotes.length === 1) return { remote: remotes[0], baseBranch: ref };
    if (remotes.includes('origin')) return { remote: 'origin', baseBranch: ref };
    return null;
}

/**
 * Everything the dialog shows about a Git target, and the problems that would
 * stop a deploy. Never throws for an expected problem: it lists it.
 */
async function describeTarget(gitInfo, selectedDiffs, options = {}) {
    const root = gitInfo.repoRoot;
    const sources = options.sources || {};
    const problems = [];
    const { branches } = await git.listBranches(root);
    const remotes = await git.listRemotes(root);

    const plan = {
        repoRoot: root,
        baseRef: gitInfo.ref,
        baseSha: gitInfo.sha,
        baseShortSha: gitInfo.sha.slice(0, 7),
        modelPath: gitInfo.modelPath,
        movedBy: 0,
        remote: null,
        baseBranch: gitInfo.ref,
        provider: 'none',
        cliAvailable: false,
        compareUrl: null,
        branchName: (options.branchName || '').trim() || defaultBranchName(sources, options.now),
        commitMessage: (options.commitMessage || '').trim() || defaultCommitMessage(selectedDiffs, sources),
        openPullRequest: options.openPullRequest !== false,
        draft: options.draft !== false,
        problems
    };
    plan.prTitle = (options.prTitle || '').trim() || plan.commitMessage.split('\n')[0];

    // The branch may have moved since the comparison (a new commit, a reset).
    try {
        plan.movedBy = await git.commitsSince(root, gitInfo.sha, gitInfo.ref);
    } catch {
        problems.push({ code: 'TARGET_BRANCH_GONE', blocking: false, message: `"${gitInfo.ref}" no longer exists; the new branch still starts from ${plan.baseShortSha}.` });
    }

    try {
        plan.branchName = await git.validateBranchName(root, plan.branchName);
        if (await git.branchExists(root, plan.branchName)) {
            problems.push({ code: 'BRANCH_EXISTS', blocking: true, message: `A branch named "${plan.branchName}" already exists. Choose another name.` });
        }
    } catch (err) {
        problems.push({ code: err.code || 'INVALID_INPUT', blocking: true, message: err.message });
    }

    try {
        await git.assertIdentity(root);
    } catch (err) {
        problems.push({ code: err.code, blocking: true, message: err.message });
    }

    const target = await resolveRemote(root, gitInfo.ref, branches, remotes);
    if (target) {
        Object.assign(plan, target);
        const info = prProvider.parseRemote(await git.remoteUrl(root, target.remote));
        plan.provider = info.kind;
        plan.remoteInfo = info;
        plan.compareUrl = prProvider.compareUrl(info, target.baseBranch, plan.branchName);
        plan.cliAvailable = !!prProvider.resolveCli(info.kind);
        if (plan.openPullRequest && info.kind === 'unknown') {
            problems.push({ code: 'PR_UNSUPPORTED_REMOTE', blocking: false, message: `"${target.remote}" is neither GitHub nor Azure DevOps: the branch will be pushed, the pull request has to be opened by hand.` });
        } else if (plan.openPullRequest && !plan.cliAvailable) {
            problems.push({ code: 'PR_CLI_MISSING', blocking: false, message: `${info.kind === 'github' ? 'GitHub CLI (gh)' : 'Azure CLI (az)'} was not found: the branch will be pushed, the pull request has to be opened by hand.` });
        }
    } else if (plan.openPullRequest) {
        problems.push({ code: 'NO_REMOTE', blocking: true, message: 'The target branch has no remote to push to. Choose "Local branch only" or add a remote.' });
    }

    return plan;
}

/** What the browser may see of the plan (no internal objects). */
function publicPlan(plan) {
    const { remoteInfo, ...rest } = plan;
    return rest;
}

// ===== Line endings =====
// The TMDL writer works in LF. A file it touches is written back with the line
// endings it had, so the commit holds only the real change, whatever the
// repository's core.autocrlf.

function eolSnapshot(folder) {
    const styles = {};
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else styles[full] = fs.readFileSync(full, 'utf-8').includes('\r\n') ? 'crlf' : 'lf';
        }
    };
    if (fs.existsSync(folder)) walk(folder);
    return styles;
}

function restoreEol(files, styles) {
    const values = Object.values(styles);
    const majority = values.filter(v => v === 'crlf').length > values.length / 2 ? 'crlf' : 'lf';
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, 'utf-8');
        const lf = content.replace(/\r\n/g, '\n');
        const wanted = (styles[file] || majority) === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
        if (wanted !== content) fs.writeFileSync(file, wanted, 'utf-8');
    }
}

// ===== Preview and deploy =====

/**
 * @param {object[]} selectedDiffs
 * @param {object} devModel
 * @param {object} prodModel   the target model from the comparison
 * @param {object} gitInfo     { repoRoot, ref, sha, modelPath } from the comparison
 * @param {object} options     dryRun, allDiffs, sources, branchName, commitMessage,
 *                             prTitle, openPullRequest (default true), draft (default true),
 *                             force (deploy despite blocking problems is NOT allowed; ignored),
 *                             createPullRequest (injectable, tests)
 */
async function deployToGit(selectedDiffs, devModel, prodModel, gitInfo, options = {}) {
    const { dryRun = false } = options;
    const result = { success: true, actions: [], errors: [], warnings: [] };

    let plan;
    try {
        await git.inspectRepository(gitInfo.repoRoot);
        plan = await describeTarget(gitInfo, selectedDiffs, options);
    } catch (err) {
        result.success = false;
        result.errors.push({ operation: { action: 'git-precheck' }, code: err.code || 'GIT_FAILED', error: err.message });
        return result;
    }
    result.git = publicPlan(plan);

    if (plan.movedBy > 0) {
        result.warnings.push({
            code: 'TARGET_BRANCH_MOVED',
            message: `"${plan.baseRef}" has ${plan.movedBy} new commit${plan.movedBy === 1 ? '' : 's'} since the comparison. ` +
                `The new branch starts from the compared commit ${plan.baseShortSha}; the pull request shows whether it still merges cleanly.`
        });
    }

    if (dryRun) {
        const preview = previewInTempFolder(selectedDiffs, devModel, prodModel, options);
        preview.warnings = result.warnings.concat(preview.warnings || []);
        preview.git = result.git;
        return preview;
    }

    const blocking = plan.problems.filter(p => p.blocking);
    if (blocking.length) {
        result.success = false;
        for (const p of blocking) result.errors.push({ operation: { action: 'git-precheck' }, code: p.code, error: p.message });
        return result;
    }

    return git.withRepoLock(plan.repoRoot, () => applyInWorktree(selectedDiffs, devModel, plan, options, result));
}

// The preview runs the deployer as a dry run on the compared files, written to
// a temp folder exactly like the Fabric preview. No worktree, no branch.
function previewInTempFolder(selectedDiffs, devModel, prodModel, options) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-alchemist-git-preview-'));
    try {
        for (const [filePath, content] of Object.entries(prodModel.rawFiles || {})) {
            const full = path.join(tmpDir, filePath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content, 'utf-8');
        }
        return deployChanges(selectedDiffs, devModel, tmpDir, { dryRun: true, backup: false, prodModel, allDiffs: options.allDiffs || [] });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function applyInWorktree(selectedDiffs, devModel, plan, options, result) {
    const worktree = path.join(os.tmpdir(), `${WORKTREE_PREFIX}${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const git_ = result.git;
    git_.branch = null;
    git_.commitSha = null;
    git_.pushed = false;
    git_.pullRequest = null;
    git_.stoppedAt = 'worktree';

    try {
        await git.addWorktree(plan.repoRoot, worktree, plan.baseSha);
        const modelDir = path.join(worktree, ...plan.modelPath.split('/'));
        const definition = path.join(modelDir, 'definition');
        const styles = eolSnapshot(definition);

        // Apply. The target model is read from the worktree: the files the commit starts from.
        git_.stoppedAt = 'apply';
        const targetModel = loadModelFromFolder(definition);
        const applied = deployChanges(selectedDiffs, devModel, definition, { dryRun: false, backup: false, prodModel: targetModel, allDiffs: options.allDiffs || [] });
        mergeDeployResultIntoResponse(result, applied);
        if (!applied.success) {
            result.success = false;
            result.errors.push(...(applied.errors || []));
            return result;
        }

        const changed = await git.changedPaths(worktree);
        restoreEol(changed.map(p => path.join(worktree, ...p.split('/'))), styles);
        const outside = changed.filter(p => !p.startsWith(`${plan.modelPath}/`));
        if (outside.length) {
            result.success = false;
            result.errors.push({ operation: { action: 'git-commit' }, code: 'OUTSIDE_CHANGES', error: `The deploy changed files outside ${plan.modelPath}: ${outside.slice(0, 5).join(', ')}. Nothing was committed.` });
            return result;
        }
        if (!(await git.changedPaths(worktree)).length) {
            result.success = false;
            result.errors.push({ operation: { action: 'git-commit' }, code: 'NOTHING_TO_COMMIT', error: 'The selected changes are already in the target branch. Nothing was committed.' });
            return result;
        }

        // Commit on a new branch.
        git_.stoppedAt = 'commit';
        await git.createBranchHere(worktree, plan.branchName);
        await git.stageFolder(worktree, plan.modelPath);
        git_.commitSha = await git.commit(worktree, plan.commitMessage);
        git_.branch = plan.branchName;
        result.actions.push({ type: 'git-commit', message: `Committed ${git_.commitSha.slice(0, 7)} on new branch ${plan.branchName} (from ${plan.baseShortSha}).` });

        if (!plan.openPullRequest) {
            git_.stoppedAt = null;
            return result;
        }

        // Push, then the pull request. A failed push leaves the local branch for a retry.
        git_.stoppedAt = 'push';
        await git.pushBranch(worktree, plan.remote, plan.branchName);
        git_.pushed = true;
        result.actions.push({ type: 'git-push', message: `Pushed ${plan.branchName} to ${plan.remote}.` });

        git_.stoppedAt = 'pull-request';
        const create = options.createPullRequest || prProvider.createPullRequest;
        try {
            git_.pullRequest = await create({
                info: plan.remoteInfo,
                base: plan.baseBranch,
                head: plan.branchName,
                title: plan.prTitle,
                body: pullRequestBody(selectedDiffs, options.sources, result.warnings, plan),
                draft: plan.draft,
                cwd: plan.repoRoot
            });
            result.actions.push({ type: 'pull-request', message: `Opened ${plan.draft ? 'draft ' : ''}pull request ${git_.pullRequest.url}` });
            git_.stoppedAt = null;
        } catch (err) {
            // The branch is pushed: the user can open the PR by hand.
            result.warnings.push({ code: err.code || 'PR_CREATE_FAILED', message: `${err.message}${plan.compareUrl ? ` Open it here: ${plan.compareUrl}` : ''}` });
        }
        return result;
    } catch (err) {
        result.success = false;
        result.errors.push({ operation: { action: `git-${git_.stoppedAt}` }, code: err.code || 'GIT_FAILED', error: err.message });
        return result;
    } finally {
        await git.removeWorktree(plan.repoRoot, worktree);
        if (fs.existsSync(worktree)) {
            result.warnings.push({ code: 'WORKTREE_CLEANUP_FAILED', message: `The temporary folder ${worktree} could not be removed. Delete it and run "git worktree prune".` });
        }
    }
}

/**
 * Remove worktrees a crashed deploy left in the temp folder, and Git's record
 * of them. Only folders older than `olderThanMs`, so a deploy running in
 * another Model Alchemist window is left alone.
 */
async function cleanupAbandonedWorktrees({ tmpDir = os.tmpdir(), olderThanMs = 10 * 60 * 1000, now = Date.now() } = {}) {
    const removed = [];
    let entries = [];
    try { entries = fs.readdirSync(tmpDir); } catch { return removed; }
    for (const name of entries.filter(n => n.startsWith(WORKTREE_PREFIX))) {
        const dir = path.join(tmpDir, name);
        try {
            if (now - fs.statSync(dir).mtimeMs < olderThanMs) continue;
            const marker = path.join(dir, '.git');
            let repoRoot = null;
            if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
                const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(marker, 'utf-8'));
                // <repo>/.git/worktrees/<name> → <repo>
                if (m) repoRoot = path.resolve(m[1].trim(), '..', '..', '..');
            }
            fs.rmSync(dir, { recursive: true, force: true });
            if (repoRoot && fs.existsSync(repoRoot)) await git.pruneWorktrees(repoRoot).catch(() => {});
            removed.push(dir);
        } catch { /* leave it for next time */ }
    }
    return removed;
}

module.exports = {
    deployToGit,
    describeTarget,
    cleanupAbandonedWorktrees,
    defaultBranchName,
    defaultCommitMessage,
    pullRequestBody,
    sourceLabel,
    WORKTREE_PREFIX
};
