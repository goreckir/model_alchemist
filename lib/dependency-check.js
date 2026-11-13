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
 * The message printed when packages are out of date. Written for someone who
 * double-clicked start.bat, not for a developer: what happened and what to do
 * come first, the package list last (for a bug report).
 * @param {string} root the folder to run npm ci in (the one holding package-lock.json)
 */
function outdatedMessage(outdated, root, max = 5) {
    const windows = process.platform === 'win32';
    const details = outdated.slice(0, max).map(d => `  ${d.name}: ${d.installed || 'missing'} (needs ${d.locked})`);
    if (outdated.length > max) details.push(`  ...and ${outdated.length - max} more`);
    return [
        'Model Alchemist cannot start: the update is not finished.',
        '',
        'Model Alchemist was updated, but the components it needs were not.',
        'To finish the update:',
        windows ? '  1. Open Command Prompt (press Win+R, type cmd, press Enter).' : '  1. Open a terminal.',
        '  2. Type these two commands, pressing Enter after each one:',
        windows ? `       cd /d "${root}"` : `       cd "${root}"`,
        '       npm ci',
        '     Wait until it finishes (about a minute; it needs an internet connection).',
        '  3. Start Model Alchemist again.',
        '',
        `Details: ${outdated.length} component(s) out of date:`,
        ...details
    ].join('\n');
}

module.exports = { findOutdatedDependencies, outdatedMessage };
