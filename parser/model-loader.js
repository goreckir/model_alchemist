/**
 * Model Loader v2 — Loads a semantic model from a TMDL definition/ folder.
 * Implements F1 from the specification.
 * Enhanced: stores raw file content for deployment operations.
 *
 * Reading and parsing are split: this file reads the definition files from
 * disk, parser/build-model.js turns them into a model. The Git loader feeds
 * the same builder from a commit, so both parse identically.
 */

const fs = require('fs');
const path = require('path');
const { buildModelFromFiles, ROOT_FILES, OBJECT_DIRS } = require('./build-model');

/**
 * Load a semantic model from a TMDL definition folder.
 * @param {string} folderPath - Path to the definition/ folder
 * @returns {object} Parsed model with all objects and raw file content
 */
function loadModelFromFolder(folderPath) {
    folderPath = path.resolve(folderPath);

    if (!fs.existsSync(folderPath)) {
        throw new Error(`Folder not found: ${folderPath}`);
    }

    if (fs.existsSync(path.join(folderPath, 'definition'))) {
        return loadModelFromFolder(path.join(folderPath, 'definition'));
    }

    const hasModelTmdl = fs.existsSync(path.join(folderPath, 'model.tmdl'));
    const hasDatabaseTmdl = fs.existsSync(path.join(folderPath, 'database.tmdl'));

    if (!hasModelTmdl && !hasDatabaseTmdl) {
        throw new Error(`Not a valid TMDL definition folder: ${folderPath}. Expected model.tmdl or database.tmdl`);
    }

    return buildModelFromFiles(readDefinitionFiles(folderPath), {
        name: path.basename(path.dirname(folderPath)),
        sourcePath: folderPath
    });
}

/** The definition files on disk, as a definition-relative path → content map. */
function readDefinitionFiles(folderPath) {
    const files = {};
    for (const name of ROOT_FILES) {
        const fp = path.join(folderPath, name);
        if (fs.existsSync(fp)) files[name] = fs.readFileSync(fp, 'utf-8');
    }
    for (const dir of OBJECT_DIRS) {
        const dirPath = path.join(folderPath, dir);
        if (!fs.existsSync(dirPath)) continue;
        for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.tmdl'))) {
            files[`${dir}/${file}`] = fs.readFileSync(path.join(dirPath, file), 'utf-8');
        }
    }
    return files;
}

module.exports = { loadModelFromFolder };
