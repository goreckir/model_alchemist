/**
 * Are the installed packages the ones package-lock.json asks for?
 *
 * `git pull` updates package-lock.json but not node_modules. The server then
 * starts normally on the old packages and fails later in ways that do not
 * point at the cause (an outdated MSAL produced AADSTS70007 at sign-in).
 * Checked once at start-up; reading a few hundred small package.json files
 * takes milliseconds.
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {string} root folder holding package-lock.json and node_modules
 * @returns {{ name: string, locked: string, installed: string | null }[]} empty when everything matches
 */
function findOutdatedDependencies(root) {
    let lock;
    try {
        lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    } catch {
        return []; // No lockfile (or unreadable): nothing to compare against.
    }
    const outdated = [];
    for (const [key, entry] of Object.entries(lock.packages || {})) {
        if (!key.startsWith('node_modules/') || !entry.version || entry.link) continue;
        let installed = null;
        try {
            installed = JSON.parse(fs.readFileSync(path.join(root, key, 'package.json'), 'utf8')).version || null;
        } catch {
            // Dev and optional packages may be left out on purpose (--omit=dev, other platforms).
            if (entry.dev || entry.optional || entry.devOptional) continue;
        }
        if (installed !== entry.version) {
            outdated.push({ name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), locked: entry.version, installed });
        }
    }
    return outdated;
}

/**
 * The message printed when packages are out of date.
 * @param {string} root the folder to run npm ci in (the one holding package-lock.json)
 */
function outdatedMessage(outdated, root, max = 5) {
    const lines = outdated.slice(0, max).map(d => `  ${d.name}: installed ${d.installed || 'missing'}, expected ${d.locked}`);
    if (outdated.length > max) lines.push(`  ...and ${outdated.length - max} more`);
    return [
        'Installed packages do not match package-lock.json (did you run "git pull" without "npm ci"?):',
        ...lines,
        '',
        `Run "npm ci" in the Model Alchemist folder: ${root}`,
        'For example, in a terminal:',
        process.platform === 'win32' ? `  cd /d "${root}"` : `  cd "${root}"`,
        '  npm ci',
        'Then start Model Alchemist again.'
    ].join('\n');
}

module.exports = { findOutdatedDependencies, outdatedMessage };
