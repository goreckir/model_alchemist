/**
 * Model Loader v2 — Loads a semantic model from a TMDL definition/ folder.
 * Implements F1 from the specification.
 * Enhanced: stores raw file content for deployment operations.
 */

const fs = require('fs');
const path = require('path');
const { parseTmdlFile } = require('./tmdl-parser');

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

    const model = {
        name: path.basename(path.dirname(folderPath)),
        sourcePath: folderPath,
        database: null,
        modelConfig: null,
        tables: [],
        relationships: [],
        expressions: [],
        dataSources: [],
        functions: [],
        roles: [],
        perspectives: [],
        cultures: [],
        refs: [],
        // Raw file content map for deployment
        rawFiles: {}
    };

    // 1. Parse database.tmdl
    if (hasDatabaseTmdl) {
        const fp = path.join(folderPath, 'database.tmdl');
        const content = readFile(fp);
        model.rawFiles['database.tmdl'] = content;
        model.database = parseTmdlFile(content, 'database.tmdl');
    }

    // 2. Parse model.tmdl
    if (hasModelTmdl) {
        const fp = path.join(folderPath, 'model.tmdl');
        const content = readFile(fp);
        model.rawFiles['model.tmdl'] = content;
        const parsed = parseTmdlFile(content, 'model.tmdl');
        model.modelConfig = parsed.filter(o => o.type === 'model');
        model.refs = parsed.filter(o => o.type === 'ref');
    }

    // 3. Parse relationships.tmdl
    const relPath = path.join(folderPath, 'relationships.tmdl');
    if (fs.existsSync(relPath)) {
        const content = readFile(relPath);
        model.rawFiles['relationships.tmdl'] = content;
        model.relationships = parseTmdlFile(content, 'relationships.tmdl');
    }

    // 4. Parse expressions.tmdl
    const exprPath = path.join(folderPath, 'expressions.tmdl');
    if (fs.existsSync(exprPath)) {
        const content = readFile(exprPath);
        model.rawFiles['expressions.tmdl'] = content;
        model.expressions = parseTmdlFile(content, 'expressions.tmdl');
    }

    // 5. Parse dataSources.tmdl
    const dsPath = path.join(folderPath, 'dataSources.tmdl');
    if (fs.existsSync(dsPath)) {
        const content = readFile(dsPath);
        model.rawFiles['dataSources.tmdl'] = content;
        model.dataSources = parseTmdlFile(content, 'dataSources.tmdl');
    }

    // 6. Parse functions.tmdl
    const funcPath = path.join(folderPath, 'functions.tmdl');
    if (fs.existsSync(funcPath)) {
        const content = readFile(funcPath);
        model.rawFiles['functions.tmdl'] = content;
        model.functions = parseTmdlFile(content, 'functions.tmdl');
    }

    // 7. Parse table files
    const tablesDir = path.join(folderPath, 'tables');
    if (fs.existsSync(tablesDir)) {
        const tableFiles = fs.readdirSync(tablesDir).filter(f => f.endsWith('.tmdl'));
        for (const file of tableFiles) {
            const fp = path.join(tablesDir, file);
            const content = readFile(fp);
            model.rawFiles[`tables/${file}`] = content;
            const parsed = parseTmdlFile(content, `tables/${file}`);
            model.tables.push(...parsed);
        }
    }

    // 8. Parse roles
    const rolesDir = path.join(folderPath, 'roles');
    if (fs.existsSync(rolesDir)) {
        const roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.tmdl'));
        for (const file of roleFiles) {
            const fp = path.join(rolesDir, file);
            const content = readFile(fp);
            model.rawFiles[`roles/${file}`] = content;
            const parsed = parseTmdlFile(content, `roles/${file}`);
            model.roles.push(...parsed);
        }
    }

    // 9. Parse perspectives
    const perspDir = path.join(folderPath, 'perspectives');
    if (fs.existsSync(perspDir)) {
        const perspFiles = fs.readdirSync(perspDir).filter(f => f.endsWith('.tmdl'));
        for (const file of perspFiles) {
            const fp = path.join(perspDir, file);
            const content = readFile(fp);
            model.rawFiles[`perspectives/${file}`] = content;
            const parsed = parseTmdlFile(content, `perspectives/${file}`);
            model.perspectives.push(...parsed);
        }
    }

    // 10. Parse cultures
    const culturesDir = path.join(folderPath, 'cultures');
    if (fs.existsSync(culturesDir)) {
        const cultureFiles = fs.readdirSync(culturesDir).filter(f => f.endsWith('.tmdl'));
        for (const file of cultureFiles) {
            const fp = path.join(culturesDir, file);
            const content = readFile(fp);
            model.rawFiles[`cultures/${file}`] = content;
            const parsed = parseTmdlFile(content, `cultures/${file}`);
            model.cultures.push(...parsed);
        }
    }

    return model;
}

function readFile(filePath) {
    return fs.readFileSync(filePath, 'utf-8');
}

module.exports = { loadModelFromFolder };
