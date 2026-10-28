/**
 * The only module that runs Git.
 *
 * Every call is execFile/spawn with an argument array (never a shell), with a
 * timeout, bounded output, and an environment that keeps Git from waiting on a
 * terminal prompt nobody sees. Failures become a GitError with a stable code;
 * messages never carry raw Git output, and anything that might be a URL is
 * redacted first.
 *
 * Callers pass a repository root obtained from inspectRepository(); nothing
 * here trusts a path, ref or file name from the client without checking it.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** HTTP status each code answers with. */
const STATUS = {
    INVALID_INPUT: 400,
    GIT_NOT_INSTALLED: 400,
    REPOSITORY_NOT_FOUND: 404,
    REPOSITORY_UNSAFE: 400,
    REVISION_NOT_FOUND: 404,
    MODEL_NOT_FOUND: 404,
    AUTHENTICATION_REQUIRED: 401,
    FETCH_IN_PROGRESS: 409,
    FETCH_FAILED: 502,
    GIT_IDENTITY_MISSING: 400,
    GIT_TIMEOUT: 504,
    GIT_FAILED: 500
};

const MESSAGES = {
    GIT_NOT_INSTALLED: 'Git is not installed or not on the PATH. Install Git (https://git-scm.com) and restart Model Alchemist.',
    REPOSITORY_NOT_FOUND: 'The path is not inside a Git repository with a working tree.',
    REPOSITORY_UNSAFE: 'Git refuses to read this repository because it is owned by another user. Mark it as safe with: git config --global --add safe.directory <repository path>',
    AUTHENTICATION_REQUIRED: 'Git could not authenticate with the remote. Sign in with your usual Git tools (Git Credential Manager or SSH) and try again.',
    FETCH_IN_PROGRESS: 'A fetch for this repository is already running.',
    FETCH_FAILED: 'Fetching from the remote failed.',
    GIT_IDENTITY_MISSING: 'Git has no user name or e-mail. Set them with git config user.name and git config user.email.',
    GIT_TIMEOUT: 'Git did not answer in time.'
};

class GitError extends Error {
    constructor(code, message) {
        super(message || MESSAGES[code] || 'Git failed.');
        this.name = 'GitError';
        this.code = code;
        this.status = STATUS[code] || 500;
    }
}

/** Remove credentials and query strings from anything that looks like a URL. */
function redact(text) {
    return String(text == null ? '' : text)
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)[?#]\S*/gi, '$1');
}

function gitEnv() {
    return Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: '0',   // fail instead of waiting for a username/password prompt
        GIT_OPTIONAL_LOCKS: '0',    // read-only commands never take the index lock
        LC_ALL: 'C',                // English messages, so classify() can read them
        LANGUAGE: 'C'
    });
}

/** Map Git's stderr to a stable code; `fallback` when nothing specific matches. */
function classify(stderr, fallback) {
    const s = String(stderr || '');
    if (/dubious ownership/i.test(s)) return new GitError('REPOSITORY_UNSAFE');
    if (/not a git repository|must be run in a work tree/i.test(s)) return new GitError('REPOSITORY_NOT_FOUND');
    if (/authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|could not read from remote repository/i.test(s)) {
        return new GitError('AUTHENTICATION_REQUIRED');
    }
    if (/please tell me who you are|empty ident name|unable to auto-detect email/i.test(s)) return new GitError('GIT_IDENTITY_MISSING');
    if (fallback && MESSAGES[fallback]) return new GitError(fallback);
    const firstLine = redact(s.split(/\r?\n/).find(l => l.trim()) || '').slice(0, 200);
    return new GitError(fallback || 'GIT_FAILED', firstLine ? `Git failed: ${firstLine}` : 'Git failed.');
}

/**
 * Run git with an argument array. Resolves to { stdout: Buffer, stderr: string }.
 * `fallback` is the code used when the failure is not recognised.
 */
function run(args, { cwd, timeout = DEFAULT_TIMEOUT_MS, fallback } = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd,
            env: gitEnv(),
            timeout,
            maxBuffer: MAX_OUTPUT_BYTES,
            encoding: 'buffer',
            windowsHide: true
        }, (err, stdout, stderr) => {
            const errText = stderr ? stderr.toString('utf-8') : '';
            if (err) {
                if (err.code === 'ENOENT') return reject(new GitError('GIT_NOT_INSTALLED'));
                if (err.killed || err.signal) return reject(new GitError('GIT_TIMEOUT'));
                return reject(classify(errText, fallback));
            }
            resolve({ stdout, stderr: errText });
        });
    });
}

const text = buf => buf.toString('utf-8');

// ===== Input checks =====

function requireString(value, what, max = 4096) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
        throw new GitError('INVALID_INPUT', `${what} is missing or invalid.`);
    }
    return value.trim();
}

/** A branch, tag or commit as typed by the user: never an option, never a control character. */
function validateRef(ref) {
    const value = requireString(ref, 'Branch or revision', 256);
    if (value.startsWith('-') || /[\x00-\x20\x7f]/.test(value)) {
        throw new GitError('INVALID_INPUT', `"${value}" is not a valid branch or revision name.`);
    }
    return value;
}

// ===== Operations =====

async function assertAvailable() {
    const { stdout } = await run(['--version']);
    return text(stdout).trim();
}

/**
 * Find the repository a user-given path belongs to. The path may be the
 * repository, a folder inside it, a .SemanticModel folder or a .pbip file.
 * Returns { root, name, currentBranch, modelPathHint }.
 */
async function inspectRepository(inputPath) {
    const given = requireString(inputPath, 'Repository path');
    let dir = path.resolve(given);
    if (!fs.existsSync(dir)) throw new GitError('REPOSITORY_NOT_FOUND', `Path not found: ${given}`);

    let pbipName = null;
    if (fs.statSync(dir).isFile()) {
        if (path.extname(dir).toLowerCase() === '.pbip') pbipName = path.basename(dir, path.extname(dir));
        dir = path.dirname(dir);
    }
    const real = fs.realpathSync.native(dir);

    const { stdout } = await run(['rev-parse', '--show-toplevel'], { cwd: real, fallback: 'REPOSITORY_NOT_FOUND' });
    const root = path.resolve(text(stdout).trim());

    let currentBranch = null;
    try {
        const head = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root });
        currentBranch = text(head.stdout).trim() || null;
    } catch { /* detached HEAD */ }

    return { root, name: path.basename(root), currentBranch, modelPathHint: modelPathHint(root, real, pbipName) };
}

/** The .SemanticModel the user pointed into, as a repository-relative POSIX path. */
function modelPathHint(root, real, pbipName) {
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel ? rel.split(path.sep) : [];
    for (let i = parts.length; i > 0; i--) {
        if (/\.SemanticModel$/i.test(parts[i - 1])) return parts.slice(0, i).join('/');
    }
    if (pbipName) return parts.concat(`${pbipName}.SemanticModel`).join('/');
    return null;
}

/**
 * Local and remote-tracking branches.
 * Returns { branches: [{ name, ref, type, sha, shortSha, committedAt, current, upstream }], lastFetchAt }.
 */
async function listBranches(root) {
    const format = ['%(refname)', '%(objectname)', '%(committerdate:unix)', '%(upstream:short)', '%(HEAD)', '%(symref)'].join('%00');
    const { stdout } = await run(['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'], { cwd: root });
    const branches = [];
    for (const line of text(stdout).split('\n')) {
        if (!line) continue;
        const [ref, sha, date, upstream, head, symref] = line.split('\0');
        if (symref) continue; // refs/remotes/origin/HEAD
        const local = ref.startsWith('refs/heads/');
        branches.push({
            name: ref.replace(local ? 'refs/heads/' : 'refs/remotes/', ''),
            ref,
            type: local ? 'local' : 'remote',
            sha,
            shortSha: sha.slice(0, 7),
            committedAt: date ? new Date(Number(date) * 1000).toISOString() : null,
            current: head === '*',
            upstream: upstream || null
        });
    }
    branches.sort((a, b) => (b.current - a.current) || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    return { branches, lastFetchAt: await lastFetchTime(root) };
}

/** When this repository last fetched, from FETCH_HEAD; null if it never did. */
async function lastFetchTime(root) {
    try {
        const { stdout } = await run(['rev-parse', '--git-path', 'FETCH_HEAD'], { cwd: root });
        const fetchHead = path.resolve(root, text(stdout).trim());
        return fs.existsSync(fetchHead) ? fs.statSync(fetchHead).mtime.toISOString() : null;
    } catch {
        return null;
    }
}

/** A branch, tag or commit → its full commit SHA. */
async function resolveCommit(root, ref) {
    const value = validateRef(ref);
    let stdout;
    try {
        ({ stdout } = await run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${value}^{commit}`], { cwd: root }));
    } catch (err) {
        if (err.code === 'GIT_FAILED') throw new GitError('REVISION_NOT_FOUND', `Branch or revision "${value}" was not found. If it exists on the remote, Fetch first.`);
        throw err;
    }
    const sha = text(stdout).trim();
    if (!SHA_RE.test(sha)) throw new GitError('REVISION_NOT_FOUND', `Branch or revision "${value}" was not found.`);
    return sha;
}

/** Every file path in a commit (repository-relative, POSIX), optionally under one folder. */
async function listTreePaths(root, sha, folder) {
    if (!SHA_RE.test(sha)) throw new GitError('INVALID_INPUT', 'A full commit SHA is required.');
    const args = ['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha];
    if (folder) args.push('--', folder);
    const { stdout } = await run(args, { cwd: root });
    return text(stdout).split('\0').filter(Boolean);
}

/**
 * Read many files of one commit in a single process (git cat-file --batch).
 * Returns { path: content } with UTF-8 text; a path missing from the commit is left out.
 */
function readBlobs(root, sha, paths, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!SHA_RE.test(sha)) return Promise.reject(new GitError('INVALID_INPUT', 'A full commit SHA is required.'));
    for (const p of paths) {
        if (typeof p !== 'string' || /[\0\n\r]/.test(p)) return Promise.reject(new GitError('INVALID_INPUT', 'Invalid file path.'));
    }
    if (paths.length === 0) return Promise.resolve({});

    return new Promise((resolve, reject) => {
        const child = spawn('git', ['cat-file', '--batch'], { cwd: root, env: gitEnv(), windowsHide: true });
        const chunks = [];
        let size = 0;
        let stderr = '';
        let settled = false;
        const fail = err => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(err); } };
        const timer = setTimeout(() => fail(new GitError('GIT_TIMEOUT')), timeout);

        child.on('error', err => fail(err.code === 'ENOENT' ? new GitError('GIT_NOT_INSTALLED') : new GitError('GIT_FAILED')));
        child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
        child.stdout.on('data', d => {
            size += d.length;
            if (size > MAX_OUTPUT_BYTES) return fail(new GitError('GIT_FAILED', 'The model is too large to read from Git.'));
            chunks.push(d);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) return reject(classify(stderr));
            try {
                resolve(parseBatch(Buffer.concat(chunks), paths));
            } catch (err) {
                reject(err);
            }
        });
        child.stdin.on('error', () => { /* reported through close */ });
        child.stdin.end(paths.map(p => `${sha}:${p}\n`).join(''));
    });
}

/** Parse `git cat-file --batch` output, one entry per requested path, in order. */
function parseBatch(buf, paths) {
    const files = {};
    let pos = 0;
    for (const p of paths) {
        const eol = buf.indexOf(0x0a, pos);
        if (eol < 0) throw new GitError('GIT_FAILED', 'Unexpected output from git cat-file.');
        const header = buf.slice(pos, eol).toString('utf-8');
        pos = eol + 1;
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!m) continue; // "<name> missing" or "ambiguous": no body follows
        const len = Number(m[2]);
        if (m[1] === 'blob') files[p] = buf.slice(pos, pos + len).toString('utf-8');
        pos += len + 1; // body + trailing newline
    }
    return files;
}

/** Number of changed, staged or untracked files under a folder of the working tree. */
async function countUncommitted(root, folder) {
    const { stdout } = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', folder], { cwd: root });
    const entries = text(stdout).split('\0').filter(Boolean);
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
        count++;
        if (/^[RC]/.test(entries[i])) i++; // a rename or copy carries its source path as the next entry
    }
    return count;
}

async function listRemotes(root) {
    const { stdout } = await run(['remote'], { cwd: root });
    return text(stdout).split('\n').map(s => s.trim()).filter(Boolean);
}

/** Fetch every remote. Refuses while another fetch of the same repository runs. */
async function fetchAll(root) {
    if (isLocked(root)) throw new GitError('FETCH_IN_PROGRESS');
    return withRepoLock(root, async () => {
        const remotes = await listRemotes(root);
        if (!remotes.length) return { fetched: false, remotes };
        await run(['fetch', '--all'], { cwd: root, timeout: FETCH_TIMEOUT_MS, fallback: 'FETCH_FAILED' });
        return { fetched: true, remotes };
    });
}

// ===== Per-repository lock =====
// Fetch and (later) worktree changes of one repository run one at a time, so
// two browser tabs, or the web app and the VS Code panel, cannot race.

const locks = new Map();
const lockKey = root => (process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root));

function isLocked(root) {
    return locks.has(lockKey(root));
}

async function withRepoLock(root, fn) {
    const key = lockKey(root);
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(r => { release = r; });
    const mine = previous.then(() => gate);
    locks.set(key, mine);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        if (locks.get(key) === mine) locks.delete(key);
    }
}

module.exports = {
    GitError,
    redact,
    validateRef,
    assertAvailable,
    inspectRepository,
    listBranches,
    resolveCommit,
    listTreePaths,
    readBlobs,
    countUncommitted,
    listRemotes,
    fetchAll,
    withRepoLock,
    isLocked,
    SHA_RE
};
