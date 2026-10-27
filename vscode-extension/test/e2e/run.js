/**
 * End-to-end test in a real VS Code: the extension is loaded from this folder,
 * its panel renders public/ in a webview, and a "Compare with…" on the Demo Kit
 * must travel webview → router → core and back.
 *
 * Uses the VS Code on this machine (VSCODE_PATH, else `code` on the PATH) with a
 * throwaway user-data and extensions folder, so the user's setup is untouched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

function findCode() {
    if (process.env.VSCODE_PATH) return process.env.VSCODE_PATH;
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const cli = execFileSync(lookup, ['code'], { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    // `code` is a launcher script in <install>/bin; the executable is next to that folder.
    if (process.platform === 'win32') return path.join(path.dirname(path.dirname(cli)), 'Code.exe');
    return fs.realpathSync(cli);
}

(async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-e2e-'));
    try {
        await runTests({
            vscodeExecutablePath: findCode(),
            extensionDevelopmentPath: path.join(__dirname, '..', '..'),
            extensionTestsPath: path.join(__dirname, 'suite.js'),
            launchArgs: [
                path.join(__dirname, '..', '..', '..', 'demo'),
                '--disable-extensions',
                '--disable-workspace-trust',
                '--skip-welcome',
                `--user-data-dir=${path.join(sandbox, 'user-data')}`,
                `--extensions-dir=${path.join(sandbox, 'extensions')}`
            ]
        });
    } catch (err) {
        console.error('End-to-end test failed:', err.message || err);
        process.exitCode = 1;
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
})();
