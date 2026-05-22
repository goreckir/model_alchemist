/**
 * Fabric Model Loader — Loads a semantic model from Fabric via REST API (TMDL definition).
 * Implements F5 from the specification.
 * Converts the Fabric TMDL definition into the same format as loadModelFromFolder.
 */

const { parseTmdlFile } = require('../parser/tmdl-parser');
const { getSemanticModelDefinition } = require('./api-client');

/**
 * Load a semantic model from Microsoft Fabric.
 * @param {string} accessToken - Valid Azure AD access token
 * @param {string} workspaceId - Fabric workspace ID
 * @param {string} semanticModelId - Semantic model ID
 * @param {string} modelName - Display name of the model
 * @returns {object} Parsed model (same structure as loadModelFromFolder)
 */
async function loadModelFromFabric(accessToken, workspaceId, semanticModelId, modelName) {
    // Retrieve TMDL definition from Fabric REST API
    const files = await getSemanticModelDefinition(accessToken, workspaceId, semanticModelId);

    if (!files || files.length === 0) {
        throw new Error(`No TMDL files returned for model "${modelName}".`);
    }

    const model = {
        name: modelName,
        sourcePath: `fabric://${workspaceId}/${semanticModelId}`,
        sourceType: 'fabric',
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
        rawFiles: {}
    };

    // Organize files by path and parse them
    for (const file of files) {
        const filePath = normalizePath(file.path);
        model.rawFiles[filePath] = file.content;

        // Skip non-TMDL files
        if (!filePath.endsWith('.tmdl')) continue;

        try {
            const parsed = parseTmdlFile(file.content, filePath);

            if (filePath === 'database.tmdl') {
                model.database = parsed;
            } else if (filePath === 'model.tmdl') {
                model.modelConfig = parsed.filter(o => o.type === 'model');
                model.refs = parsed.filter(o => o.type === 'ref');
            } else if (filePath === 'relationships.tmdl') {
                model.relationships = parsed;
            } else if (filePath === 'expressions.tmdl') {
                model.expressions = parsed;
            } else if (filePath === 'dataSources.tmdl') {
                model.dataSources = parsed;
            } else if (filePath === 'functions.tmdl') {
                model.functions = parsed;
            } else if (filePath.startsWith('tables/')) {
                model.tables.push(...parsed);
            } else if (filePath.startsWith('roles/')) {
                model.roles.push(...parsed);
            } else if (filePath.startsWith('perspectives/')) {
                model.perspectives.push(...parsed);
            } else if (filePath.startsWith('cultures/')) {
                model.cultures.push(...parsed);
            }
        } catch (err) {
            console.warn(`Warning: Failed to parse Fabric TMDL file "${filePath}": ${err.message}`);
        }
    }

    return model;
}

/**
 * Normalize file paths from Fabric API (remove leading slashes, standardize separators,
 * strip 'definition/' prefix to match local model rawFiles format).
 */
function normalizePath(filePath) {
    let normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    // Strip 'definition/' prefix so rawFiles keys match local model format
    if (normalized.startsWith('definition/')) {
        normalized = normalized.slice('definition/'.length);
    }
    return normalized;
}

module.exports = { loadModelFromFabric };
