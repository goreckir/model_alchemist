/**
 * Build the extension into dist/:
 *   dist/extension.js  the extension and the shared core (../core, ../parser, ...)
 *                      bundled into one file; `vscode` stays external
 *   dist/public/       the web UI, copied unchanged from ../public
 *   dist/icon.png      the marketplace icon, from ../assets/logo.png
 * and LICENSE copied from the repo root, where vsce expects it.
 *
 * The extension's version must equal the web app's: both ship the same core.
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const EXT = path.join(__dirname, '..');
const ROOT = path.join(EXT, '..');
const DIST = path.join(EXT, 'dist');

const rootVersion = require(path.join(ROOT, 'package.json')).version;
const extVersion = require(path.join(EXT, 'package.json')).version;
if (rootVersion !== extVersion) {
    console.error(`Version mismatch: package.json ${rootVersion}, vscode-extension/package.json ${extVersion}. Make them equal.`);
    process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });

esbuild.buildSync({
    entryPoints: [path.join(EXT, 'src', 'extension.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
    outfile: path.join(DIST, 'extension.js'),
    sourcemap: 'linked',
    logLevel: 'warning'
});

fs.cpSync(path.join(ROOT, 'public'), path.join(DIST, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'logo.png'), path.join(DIST, 'icon.png'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(EXT, 'LICENSE'));

console.log(`Built Model Alchemist ${extVersion} into ${path.relative(ROOT, DIST)}`);
