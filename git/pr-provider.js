/**
 * Pull requests through the hosting provider's own CLI.
 *
 * GitHub goes through `gh`, Azure DevOps through `az repos`. Both already hold
 * the user's sign-in, so Model Alchemist never sees a token. The provider is
 * recognised from the remote URL. Pull requests are drafts unless the caller
 * says otherwise.
 *
 * Nothing runs through a shell. On Windows `az` is a .cmd wrapper, which Node
 * will not start without one; the wrapper only runs `..\python.exe -IBm
 * azure.cli`, so that is what is started instead.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { redact } = require('./git-client');

const prError = (code, message, status) => Object.assign(new Error(message), { code, status });

const CLI_HELP = {
    github: 'GitHub CLI (gh) was not found. Install it from https://cli.github.com and sign in with "gh auth login".',
    azure: 'Azure CLI (az) was not found. Install it, add the azure-devops extension ("az extension add --name azure-devops") and sign in with "az login".'
};

/**
 * What a remote URL points at.
 * Returns { kind: 'github' | 'azure' | 'unknown', webUrl?, ... }.
 */
function parseRemote(url) {
    const value = String(url || '').trim();
    let host;
    let urlPath;
    const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(value);
    if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        host = scp[1];
        urlPath = scp[2];
    } else {
        try {
            const u = new URL(value);
            if (!/^(https?|ssh|git):$/.test(u.protocol)) return { kind: 'unknown' };
            host = u.hostname;
            urlPath = u.pathname;
        } catch {
            return { kind: 'unknown' };
        }
    }
    host = host.toLowerCase();
    const parts = urlPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/').map(decodeURIComponent);

    if (host === 'github.com' || host.endsWith('.ghe.com')) {
        const [owner, repo] = parts;
        if (owner && repo) return { kind: 'github', host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
    }
    if (host === 'dev.azure.com' && parts[2] === '_git') return azure(parts[0], parts[1], parts[3]);
    if (host === 'ssh.dev.azure.com' && parts[0] === 'v3') return azure(parts[1], parts[2], parts[3]);
    if (host.endsWith('.visualstudio.com') && parts[1] === '_git') return azure(host.split('.')[0], parts[0], parts[2]);
    return { kind: 'unknown', host };
}

function azure(org, project, repo) {
    if (!org || !project || !repo) return { kind: 'unknown' };
    const enc = encodeURIComponent;
    return {
        kind: 'azure',
        org,
        project,
        repo,
        orgUrl: `https://dev.azure.com/${enc(org)}`,
        webUrl: `https://dev.azure.com/${enc(org)}/${enc(project)}/_git/${enc(repo)}`
    };
}

/** The page where the user can open the pull request by hand. */
function compareUrl(info, base, head) {
    if (info.kind === 'github') return `${info.webUrl}/compare/${encodeURI(base)}...${encodeURI(head)}?expand=1`;
    if (info.kind === 'azure') return `${info.webUrl}/pullrequestcreate?sourceRef=${encodeURIComponent(head)}&targetRef=${encodeURIComponent(base)}`;
    return null;
}

/** First file called `name` on the PATH (with PATHEXT on Windows), or null. */
function findExecutable(name, env = process.env) {
    const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch { /* not here */ }
        }
    }
    return null;
}

/** How to start the provider's CLI without a shell: { name, file, prefix, env } or null. */
function resolveCli(kind, env = process.env) {
    if (kind === 'github') {
        const gh = findExecutable('gh', env);
        if (!gh || /\.(cmd|bat)$/i.test(gh)) return null;
        return { name: 'gh', file: gh, prefix: [], env: {} };
    }
    if (kind === 'azure') {
        const az = findExecutable('az', env);
        if (!az) return null;
        if (/\.(cmd|bat)$/i.test(az)) {
            const python = path.resolve(path.dirname(az), '..', 'python.exe');
            if (!fs.existsSync(python)) return null;
            return { name: 'az', file: python, prefix: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } };
        }
        return { name: 'az', file: az, prefix: [], env: {} };
    }
    return null;
}

/** Run a CLI with an argument array and optional stdin. Resolves to { stdout, stderr }. */
function runCli(cli, args, { cwd, input, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = execFile(cli.file, cli.prefix.concat(args), {
            cwd,
            env: Object.assign({}, process.env, cli.env, { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }),
            timeout,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true
        }, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
        if (input !== undefined) {
            child.stdin.on('error', () => { /* reported through the callback */ });
            child.stdin.end(input);
        }
    });
}

/**
 * Open a pull request.
 * @returns {Promise<{ url: string, number: number|null, draft: boolean }>}
 * Throws { code: 'PR_UNSUPPORTED_REMOTE' | 'PR_CLI_MISSING' | 'PR_CREATE_FAILED' }.
 */
async function createPullRequest({ info, base, head, title, body, draft = true, cwd, cli, exec = runCli }) {
    if (!info || (info.kind !== 'github' && info.kind !== 'azure')) {
        throw prError('PR_UNSUPPORTED_REMOTE', 'The remote is neither GitHub nor Azure DevOps, so no pull request can be opened from here. The branch was pushed; open the pull request in your Git hosting service.', 400);
    }
    const tool = cli === undefined ? resolveCli(info.kind) : cli;
    if (!tool) throw prError('PR_CLI_MISSING', CLI_HELP[info.kind], 400);

    try {
        if (info.kind === 'github') {
            const repo = `${info.host === 'github.com' ? '' : info.host + '/'}${info.owner}/${info.repo}`;
            const args = ['pr', 'create', '--repo', repo, '--base', base, '--head', head, '--title', title, '--body-file', '-'];
            if (draft) args.push('--draft');
            const { stdout } = await exec(tool, args, { cwd, input: body });
            const url = (stdout.match(/https?:\/\/\S+/g) || []).pop();
            if (!url) throw prError('PR_CREATE_FAILED', 'GitHub CLI did not return the pull request address.', 502);
            const number = /\/pull\/(\d+)/.exec(url);
            return { url, number: number ? Number(number[1]) : null, draft };
        }

        // Azure DevOps: --description takes one value per line; a line starting
        // with "-" would be read as an option, so list bullets use "*".
        const lines = String(body || '').split(/\r?\n/).map(l => (l.startsWith('-') ? `*${l.slice(1)}` : l)).filter(l => l.trim());
        const args = ['repos', 'pr', 'create',
            '--organization', info.orgUrl, '--project', info.project, '--repository', info.repo,
            '--source-branch', head, '--target-branch', base, '--title', title,
            '--draft', draft ? 'true' : 'false', '--output', 'json', '--only-show-errors'];
        if (lines.length) args.push('--description', ...lines);
        const { stdout } = await exec(tool, args, { cwd });
        let id = null;
        try { id = JSON.parse(stdout).pullRequestId; } catch { /* checked below */ }
        if (!id) throw prError('PR_CREATE_FAILED', 'Azure CLI did not return the pull request number.', 502);
        return { url: `${info.webUrl}/pullrequest/${id}`, number: Number(id), draft };
    } catch (err) {
        if (err.code === 'PR_CREATE_FAILED') throw err;
        if (err.code === 'ENOENT') throw prError('PR_CLI_MISSING', CLI_HELP[info.kind], 400);
        const detail = redact(String(err.stderr || err.message || '').split(/\r?\n/).find(l => l.trim()) || '').slice(0, 300);
        throw prError('PR_CREATE_FAILED', `Opening the pull request failed${detail ? `: ${detail}` : '.'}`, 502);
    }
}

module.exports = { parseRemote, compareUrl, findExecutable, resolveCli, runCli, createPullRequest };
