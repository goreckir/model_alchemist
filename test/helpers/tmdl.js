/**
 * Test helpers — build throwaway TMDL definition folders on disk and parse them
 * through the real loader, so tests exercise the same path the app uses.
 *
 * All TMDL content uses TAB indentation (the loader rejects space indentation).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const created = [];

/**
 * Create a temporary TMDL `definition/` folder.
 * @param {object} files - { 'model.tmdl': '...', 'tables/Sales.tmdl': '...' }
 * @returns {string} absolute path to the definition folder
 */
function makeModelFolder(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
    const defDir = path.join(root, 'Test.SemanticModel', 'definition');
    fs.mkdirSync(defDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(defDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf-8');
    }
    created.push(root);
    return defDir;
}

/** Create an empty temp directory (for backup targets etc.). */
function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
    created.push(dir);
    return dir;
}

/** Remove every folder this helper created. */
function cleanup() {
    for (const dir of created.splice(0)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/** Minimal valid model.tmdl with the given refs. */
function modelTmdl(refs = [], props = []) {
    const lines = ['model Model', '\tculture: en-US'];
    for (const p of props) lines.push(`\t${p}`);
    lines.push('');
    for (const r of refs) lines.push(`ref ${r}`);
    lines.push('');
    return lines.join('\n');
}

/** Minimal database.tmdl. */
function databaseTmdl(compatibilityLevel = 1567) {
    return `database Test\n\tcompatibilityLevel: ${compatibilityLevel}\n`;
}

/** Read a file from a definition folder. */
function readDef(defPath, rel) {
    return fs.readFileSync(path.join(defPath, rel), 'utf-8');
}

/** Does a file exist inside a definition folder? */
function existsDef(defPath, rel) {
    return fs.existsSync(path.join(defPath, rel));
}

/** Build a fake in-memory model object (rawFiles only) for deployer/validator tests. */
function rawModel(rawFiles, extra = {}) {
    return {
        name: 'Test',
        tables: [], relationships: [], expressions: [], dataSources: [],
        functions: [], roles: [], perspectives: [], cultures: [],
        refs: [], modelConfig: null, database: null,
        rawFiles,
        ...extra
    };
}

module.exports = {
    makeModelFolder, makeTempDir, cleanup, modelTmdl, databaseTmdl,
    readDef, existsDef, rawModel
};
