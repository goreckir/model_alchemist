/**
 * Build a parsed model from a map of definition/ files.
 *
 * The folder loader and the Git loader both go through here, so a model read
 * from a branch is parsed exactly like the same files read from disk: the same
 * set of files, the same order of parsing, the same indentation check.
 *
 * `files` maps a definition-relative path ('model.tmdl', 'tables/Sales.tmdl')
 * to its text. Only the paths the TMDL folder layout defines are read; anything
 * else in the map is ignored, as the folder loader ignores other files on disk.
 */
const path = require('path');
const { parseTmdlFile } = require('./tmdl-parser');

/** Top-level files, in the order the folder loader has always parsed them. */
const ROOT_FILES = ['database.tmdl', 'model.tmdl', 'relationships.tmdl', 'expressions.tmdl', 'dataSources.tmdl', 'functions.tmdl'];

/** Folders whose direct *.tmdl children hold one or more objects each. */
const OBJECT_DIRS = ['tables', 'roles', 'perspectives', 'cultures'];

/** True for a definition-relative path the model is built from. */
function isDefinitionFile(relPath) {
    if (ROOT_FILES.includes(relPath)) return true;
    const slash = relPath.indexOf('/');
    if (slash < 0) return false;
    const dir = relPath.slice(0, slash);
    const rest = relPath.slice(slash + 1);
    return OBJECT_DIRS.includes(dir) && rest.endsWith('.tmdl') && !rest.includes('/');
}

function emptyModel(meta) {
    return Object.assign({
        name: null,
        sourcePath: null,
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
    }, meta);
}

/**
 * @param {Object<string,string>} files  definition-relative path → content
 * @param {object} meta                 name, sourcePath and any extra fields (sourceType, git …)
 * @returns {object} model, the shape loadModelFromFolder has always returned
 */
function buildModelFromFiles(files, meta = {}) {
    const has = p => Object.prototype.hasOwnProperty.call(files, p);
    if (!has('model.tmdl') && !has('database.tmdl')) {
        throw new Error(`Not a valid TMDL definition: ${meta.sourcePath || meta.name || 'model'}. Expected model.tmdl or database.tmdl`);
    }

    const model = emptyModel(meta);
    const read = relPath => {
        const content = files[relPath];
        validateTmdlIndentation(content, relPath);
        model.rawFiles[relPath] = content;
        return content;
    };

    if (has('database.tmdl')) {
        model.database = parseTmdlFile(read('database.tmdl'), 'database.tmdl');
    }
    if (has('model.tmdl')) {
        const parsed = parseTmdlFile(read('model.tmdl'), 'model.tmdl');
        model.modelConfig = parsed.filter(o => o.type === 'model');
        model.refs = parsed.filter(o => o.type === 'ref');
    }
    if (has('relationships.tmdl')) model.relationships = parseTmdlFile(read('relationships.tmdl'), 'relationships.tmdl');
    if (has('expressions.tmdl')) model.expressions = parseTmdlFile(read('expressions.tmdl'), 'expressions.tmdl');
    if (has('dataSources.tmdl')) model.dataSources = parseTmdlFile(read('dataSources.tmdl'), 'dataSources.tmdl');
    if (has('functions.tmdl')) model.functions = parseTmdlFile(read('functions.tmdl'), 'functions.tmdl');

    // Object folders keep the order the caller listed their files in.
    for (const dir of OBJECT_DIRS) {
        for (const relPath of Object.keys(files)) {
            if (!relPath.startsWith(`${dir}/`) || !isDefinitionFile(relPath)) continue;
            model[dir].push(...parseTmdlFile(read(relPath), relPath));
        }
    }

    return model;
}

/**
 * Validate that the TMDL file uses tab indentation (required by TMDL spec).
 * Throws if any non-empty line starts with space characters where indentation is expected.
 * This prevents silent failures in parser/writer that count only \t for indent levels.
 */
function validateTmdlIndentation(content, filePath) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // Only flag lines that start with a space AND have non-whitespace content (i.e. indented content)
        if (line[0] === ' ' && line.trim().length > 0) {
            throw new Error(
                `Invalid TMDL indentation in ${path.basename(filePath)} (line ${i + 1}): ` +
                `file uses space indentation but TMDL requires tab characters (\\t). ` +
                `Convert leading spaces to tabs (Power BI Desktop TMDL editor uses tabs by default).`
            );
        }
    }
}

module.exports = { buildModelFromFiles, isDefinitionFile, ROOT_FILES, OBJECT_DIRS };
