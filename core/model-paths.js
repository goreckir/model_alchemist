/**
 * Path resolution shared by every host: turns what a user picked (a .pbip, a
 * .pbism, a .SemanticModel folder or its definition/ folder) into the folder
 * the TMDL parser reads.
 */
const fs = require('fs');
const path = require('path');

/**
 * Resolve the actual definition/ folder path.
 * Users may enter the SemanticModel folder — we need the definition subfolder.
 */
function resolveDefinitionPath(folderPath) {
    const resolved = path.resolve(folderPath);
    const defSub = path.join(resolved, 'definition');
    if (fs.existsSync(defSub) && fs.existsSync(path.join(defSub, 'model.tmdl'))) {
        return defSub;
    }
    return resolved;
}

/**
 * Resolve a .pbip, .pbism file OR a folder path to the definition/ folder path.
 * Supports:
 *  - .pbip file → finds .SemanticModel/definition/ next to it
 *  - .pbism file → finds definition/ in same directory
 *  - .SemanticModel folder → finds definition/ inside
 *  - Any folder containing a .SemanticModel subfolder → resolves it
 *  - Any folder containing definition/model.tmdl → uses it directly
 */
function resolveModelFromFile(filePath) {
    const resolved = path.resolve(filePath);

    // Check if it's a directory
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        // Case 1: The folder itself IS a .SemanticModel folder
        if (/\.SemanticModel$/i.test(resolved)) {
            const defFolder = path.join(resolved, 'definition');
            if (fs.existsSync(defFolder) && fs.existsSync(path.join(defFolder, 'model.tmdl'))) {
                return defFolder;
            }
            // Maybe it's a flat structure without definition/ subfolder
            if (fs.existsSync(path.join(resolved, 'model.tmdl'))) {
                return resolved;
            }
            throw new Error(`Folder "${path.basename(resolved)}" does not contain a valid TMDL definition.`);
        }

        // Case 2: The folder is a definition/ folder itself (contains model.tmdl)
        if (fs.existsSync(path.join(resolved, 'model.tmdl'))) {
            return resolved;
        }

        // Case 3: The folder contains a .SemanticModel subfolder
        const entries = fs.readdirSync(resolved);
        const smDir = entries.find(e => e.endsWith('.SemanticModel') && fs.statSync(path.join(resolved, e)).isDirectory());
        if (smDir) {
            const defFolder = path.join(resolved, smDir, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return path.join(resolved, smDir);
        }

        throw new Error(`No .SemanticModel folder or TMDL definition found in "${path.basename(resolved)}". Select a .SemanticModel folder or a folder containing one.`);
    }

    // File path handling
    const ext = path.extname(resolved).toLowerCase();
    const dir = path.dirname(resolved);

    if (ext === '.pbip') {
        // .pbip file: look for <Name>.SemanticModel/definition/ in the same directory
        const baseName = path.basename(resolved, '.pbip');
        const smFolder = path.join(dir, `${baseName}.SemanticModel`);
        if (fs.existsSync(smFolder)) {
            const defFolder = path.join(smFolder, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return smFolder;
        }
        // Try any .SemanticModel folder in the same directory
        const entries = fs.readdirSync(dir);
        const smDirEntry = entries.find(e => e.endsWith('.SemanticModel') && fs.statSync(path.join(dir, e)).isDirectory());
        if (smDirEntry) {
            const defFolder = path.join(dir, smDirEntry, 'definition');
            if (fs.existsSync(defFolder)) return defFolder;
            return path.join(dir, smDirEntry);
        }
        throw new Error(`No .SemanticModel folder found next to ${path.basename(resolved)}`);
    }

    if (ext === '.pbism') {
        // definition.pbism: the definition/ folder is in the same directory
        const defFolder = path.join(dir, 'definition');
        if (fs.existsSync(defFolder)) return defFolder;
        return dir;
    }

    throw new Error(`Unsupported path: "${path.basename(resolved)}". Select a .SemanticModel folder, .pbip file, or .pbism file.`);
}

module.exports = { resolveDefinitionPath, resolveModelFromFile };
