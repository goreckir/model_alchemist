/**
 * Deployment Engine v2 — Applies selected changes from DEV to PROD.
 * 
 * Supports:
 * - Adding new tables (copy .tmdl file)
 * - Removing tables (delete .tmdl file)
 * - Adding/removing/modifying objects within tables (manipulate file blocks)
 * - Adding/removing/modifying relationships (manipulate relationships.tmdl)
 * - Adding/removing/modifying expressions (manipulate expressions.tmdl)
 * - Adding/removing roles, perspectives, cultures (copy/delete files)
 * - Backup before deployment
 */

const fs = require('fs');
const path = require('path');
const {
    findObjectBlock,
    findTopLevelBlock,
    removeObjectBlock,
    replaceObjectBlock,
    replaceTableHeader,
    appendTopLevelBlock,
    appendChildBlock,
    addRefEntry,
    removeRefEntry,
    ensureModelProperty
} = require('./tmdl-writer');
const { validateDependencies } = require('./validator');
const { loadModelFromFolder } = require('../parser/model-loader');

/**
 * Deploy selected diffs from DEV model to PROD folder.
 * 
 * @param {Array} selectedDiffs - Array of diff objects to deploy
 * @param {object} devModel - Loaded DEV model (with rawFiles)
 * @param {string} prodPath - Path to PROD definition/ folder
 * @param {object} options - { dryRun: boolean, backup: boolean, prodModel?: object }
 * @returns {object} Deployment result { success, actions, errors, warnings, backupPath }
 */
function deployChanges(selectedDiffs, devModel, prodPath, options = {}) {
    const { dryRun = false, backup = true } = options;
    const result = { success: true, actions: [], errors: [], warnings: [], backupPath: null };

    // Dependency validation (uses prodModel if provided, otherwise loads from prodPath)
    try {
        const prodModel = options.prodModel || loadModelFromFolder(prodPath);
        const validation = validateDependencies(selectedDiffs, devModel, prodModel);
        result.warnings = validation.warnings;
        if (validation.errors.length > 0) {
            result.success = false;
            result.errors.push(...validation.errors.map(e => ({
                operation: { action: 'validate', identityKey: e.identityKey },
                error: `[${e.code}] ${e.message}`
            })));
            if (!dryRun) {
                // Hard errors block real deployment; dry-run still reports planned ops.
                return result;
            }
        }
    } catch (validationErr) {
        result.warnings.push({
            code: 'VALIDATION_SKIPPED',
            message: `Walidacja zaleznosci pominieta: ${validationErr.message}`
        });
    }

    // Create backup if requested
    if (backup && !dryRun) {
        const backupDir = createBackup(prodPath);
        result.backupPath = backupDir;
        result.actions.push({ type: 'backup', message: `Backup created: ${backupDir}` });
    }

    // Group diffs by their target file to minimize file I/O
    const fileOps = planFileOperations(selectedDiffs, devModel, prodPath);

    // Execute operations
    for (const op of fileOps) {
        try {
            if (dryRun) {
                result.actions.push({ type: 'dryrun', ...op.description });
            } else {
                executeOperation(op, prodPath);
                result.actions.push({ type: 'applied', ...op.description });
            }
        } catch (err) {
            result.errors.push({ operation: op.description, error: err.message });
            result.success = false;
        }
    }

    return result;
}

/**
 * Plan all file operations from selected diffs.
 *
 * When a table is being Added or Removed in the same batch, its child diffs
 * (column/measure/hierarchy/partition/calculationGroup/calculationItem) are
 * skipped because the whole table file is being written/deleted in one op.
 * Otherwise the child append would produce duplicate declarations (e.g. two
 * `column Name` entries in a calculation-group table file).
 */
function planFileOperations(selectedDiffs, devModel, prodPath) {
    const operations = [];

    const tablesBeingAdded = new Set();
    const tablesBeingRemoved = new Set();
    for (const d of selectedDiffs) {
        if (d.objectType === 'table') {
            if (d.type === 0) tablesBeingAdded.add(d.displayName);
            else if (d.type === 1) tablesBeingRemoved.add(d.displayName);
        }
    }

    const CHILD_OBJECT_TYPES = new Set(['column', 'measure', 'hierarchy', 'partition', 'calculationGroup', 'calculationItem']);

    // Detect whether any selected diff introduces a calculation group into the
    // target. Calculation groups require `discourageImplicitMeasures: true` on
    // the model; otherwise Fabric/AS rejects the model with:
    // "The Model 'Model' property DiscourageImplicitMeasures must be set to true
    //  in order to create any calculation groups."
    let needsDiscourageImplicit = false;
    for (const d of selectedDiffs) {
        if (d.type === 1) continue; // remove doesn't introduce a CG
        if (d.objectType === 'calculationGroup' || d.objectType === 'calculationItem') {
            needsDiscourageImplicit = true;
            break;
        }
        if (d.objectType === 'table' && d.type === 0 && typeof d.rawBlock === 'string' && /\bcalculationGroup\b/.test(d.rawBlock)) {
            needsDiscourageImplicit = true;
            break;
        }
    }

    for (const diff of selectedDiffs) {
        if (CHILD_OBJECT_TYPES.has(diff.objectType) && diff.parentTable) {
            if (diff.type === 0 && tablesBeingAdded.has(diff.parentTable)) continue;
            if (diff.type === 1 && tablesBeingRemoved.has(diff.parentTable)) continue;
        }
        const ops = planSingleDiff(diff, devModel, prodPath);
        operations.push(...ops);
    }

    if (needsDiscourageImplicit) {
        operations.push({
            action: 'ensureModelProperty',
            targetPath: path.join(prodPath, 'model.tmdl'),
            propName: 'discourageImplicitMeasures',
            propValue: 'true',
            description: { action: 'modify', objectType: 'model', name: 'discourageImplicitMeasures', file: 'model.tmdl', reason: 'calculationGroup requires discourageImplicitMeasures=true' }
        });
    }

    return operations;
}

/**
 * Plan operations for a single diff.
 */
function planSingleDiff(diff, devModel, prodPath) {
    const ops = [];
    const { type, objectType, identityKey, displayName, rawBlock, parentTable } = diff;

    switch (objectType) {
        case 'table':
            ops.push(...planTableOp(diff, devModel, prodPath));
            break;
        case 'column':
        case 'measure':
        case 'hierarchy':
        case 'partition':
        case 'calculationGroup':
        case 'calculationItem':
            ops.push(...planChildObjectOp(diff, devModel, prodPath));
            break;
        case 'relationship':
            ops.push(...planRelationshipOp(diff, devModel, prodPath));
            break;
        case 'expression':
            ops.push(...planExpressionOp(diff, devModel, prodPath));
            break;
        case 'function':
            ops.push(...planFunctionOp(diff, devModel, prodPath));
            break;
        case 'model':
            ops.push(...planModelOp(diff, devModel, prodPath));
            break;
        case 'role':
        case 'tablePermission':
            ops.push(...planRoleOp(diff, devModel, prodPath));
            break;
        case 'perspective':
            ops.push(...planFileBasedOp(diff, devModel, prodPath, 'perspectives'));
            break;
        case 'culture':
            ops.push(...planFileBasedOp(diff, devModel, prodPath, 'cultures'));
            break;
        case 'dataSource':
            ops.push(...planDataSourceOp(diff, devModel, prodPath));
            break;
        default:
            break;
    }

    return ops;
}

/**
 * Plan operations for table-level changes.
 */
function planTableOp(diff, devModel, prodPath) {
    const tableName = diff.displayName;
    const fileName = `${tableName}.tmdl`;
    const targetFile = path.join(prodPath, 'tables', fileName);
    const sourceFileKey = `tables/${fileName}`;

    if (diff.type === 0) {
        // ADD: copy entire table file from DEV to PROD
        const content = devModel.rawFiles[sourceFileKey];
        if (!content) return [];
        return [{
            action: 'writeFile',
            targetPath: targetFile,
            content,
            updateModelRef: { type: 'add', refType: 'table', name: tableName },
            description: { action: 'add', objectType: 'table', name: tableName, file: `tables/${fileName}` }
        }];
    } else if (diff.type === 1) {
        // REMOVE: delete table file from PROD
        return [{
            action: 'deleteFile',
            targetPath: targetFile,
            updateModelRef: { type: 'remove', refType: 'table', name: tableName },
            description: { action: 'remove', objectType: 'table', name: tableName, file: `tables/${fileName}` }
        }];
    } else {
        // MODIFY: atomic table-modify — update only table header (declaration + table-level props),
        // preserving children (columns/measures/hierarchies/partitions) in target.
        const devContent = devModel.rawFiles[sourceFileKey];
        if (!devContent) return [];
        return [{
            action: 'replaceTableHeader',
            targetPath: targetFile,
            devContent,
            tableName,
            description: { action: 'modify', objectType: 'table', name: tableName, file: `tables/${fileName}`, atomic: true }
        }];
    }
}

/**
 * Plan operations for child objects (columns, measures, etc.) within a table.
 */
function planChildObjectOp(diff, devModel, prodPath) {
    const tableName = diff.parentTable;
    if (!tableName) return [];

    const fileName = `${tableName}.tmdl`;
    const targetFile = path.join(prodPath, 'tables', fileName);
    const objectType = diff.objectType;
    const objectName = diff.displayName.split('.').slice(1).join('.');

    if (diff.type === 0) {
        // ADD: append the child block to the PROD table file
        return [{
            action: 'appendChild',
            targetPath: targetFile,
            childBlock: diff.rawBlock,
            description: { action: 'add', objectType, name: diff.displayName, file: `tables/${fileName}` }
        }];
    } else if (diff.type === 1) {
        // REMOVE: remove the child block from PROD table file
        return [{
            action: 'removeChild',
            targetPath: targetFile,
            childType: objectType,
            childName: objectName,
            description: { action: 'remove', objectType, name: diff.displayName, file: `tables/${fileName}` }
        }];
    } else {
        // MODIFY: replace the child block in PROD with DEV version
        return [{
            action: 'replaceChild',
            targetPath: targetFile,
            childType: objectType,
            childName: objectName,
            newBlock: diff.rawBlock,
            description: { action: 'modify', objectType, name: diff.displayName, file: `tables/${fileName}` }
        }];
    }
}

/**
 * Plan operations for relationship changes.
 */
function planRelationshipOp(diff, devModel, prodPath) {
    const targetFile = path.join(prodPath, 'relationships.tmdl');
    // For modify/remove we must locate the existing relationship in the target file.
    // TMDL names are usually GUIDs and differ across environments — use targetRelName
    // (set by engine from prod object) when available, otherwise fall back to parsing
    // the rawBlock first line (which is correct for Remove diffs whose rawBlock = prod).
    function extractRelName(rawBlock) {
        const m = rawBlock ? rawBlock.match(/^relationship\s+(.+)$/m) : null;
        return m ? m[1].trim().replace(/^'|'$/g, '') : diff.displayName;
    }
    const relName = diff.targetRelName || extractRelName(diff.rawBlock);

    if (diff.type === 0) {
        // ADD: append relationship block to relationships.tmdl
        return [{
            action: 'appendTopLevel',
            targetPath: targetFile,
            block: diff.rawBlock,
            description: { action: 'add', objectType: 'relationship', name: diff.displayName, file: 'relationships.tmdl' }
        }];
    } else if (diff.type === 1) {
        // REMOVE: remove relationship block from relationships.tmdl
        return [{
            action: 'removeTopLevel',
            targetPath: targetFile,
            objectType: 'relationship',
            objectName: relName,
            description: { action: 'remove', objectType: 'relationship', name: diff.displayName, file: 'relationships.tmdl' }
        }];
    } else {
        // MODIFY: replace relationship block (use TARGET's GUID to locate, DEV rawBlock as content)
        return [{
            action: 'replaceTopLevel',
            targetPath: targetFile,
            objectType: 'relationship',
            objectName: relName,
            newBlock: diff.rawBlock,
            description: { action: 'modify', objectType: 'relationship', name: diff.displayName, file: 'relationships.tmdl' }
        }];
    }
}

/**
 * Plan operations for expression changes.
 */
function planExpressionOp(diff, devModel, prodPath) {
    const targetFile = path.join(prodPath, 'expressions.tmdl');
    const exprName = diff.displayName;

    if (diff.type === 0) {
        return [{
            action: 'appendTopLevel',
            targetPath: targetFile,
            block: diff.rawBlock,
            createIfMissing: true,
            description: { action: 'add', objectType: 'expression', name: exprName, file: 'expressions.tmdl' }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'removeTopLevel',
            targetPath: targetFile,
            objectType: 'expression',
            objectName: exprName,
            description: { action: 'remove', objectType: 'expression', name: exprName, file: 'expressions.tmdl' }
        }];
    } else {
        return [{
            action: 'replaceTopLevel',
            targetPath: targetFile,
            objectType: 'expression',
            objectName: exprName,
            newBlock: diff.rawBlock,
            description: { action: 'modify', objectType: 'expression', name: exprName, file: 'expressions.tmdl' }
        }];
    }
}

/**
 * Plan operations for model-level property changes (model.tmdl, the `model X` declaration).
 * Only replace the model block itself; refs and other top-level entries are preserved.
 */
function planModelOp(diff, devModel, prodPath) {
    const targetFile = path.join(prodPath, 'model.tmdl');
    // Derive model name from diff (set by extractor) or fall back to parsing rawBlock first line.
    let modelName = diff.modelName;
    if (!modelName && diff.rawBlock) {
        const m = diff.rawBlock.match(/^\s*model\s+(.+?)\s*$/m);
        if (m) modelName = m[1].trim().replace(/^'|'$/g, '');
    }
    if (!modelName) modelName = 'Model';

    // Only modify is meaningful for the model object (add/remove of model itself isn't supported)
    if (diff.type === 2) {
        return [{
            action: 'replaceTopLevel',
            targetPath: targetFile,
            objectType: 'model',
            objectName: modelName,
            newBlock: diff.rawBlock,
            description: { action: 'modify', objectType: 'model', name: diff.displayName, file: 'model.tmdl' }
        }];
    }
    return [];
}

/**
 * Plan operations for UDF function changes (functions.tmdl, top-level).
 */
function planFunctionOp(diff, devModel, prodPath) {
    const targetFile = path.join(prodPath, 'functions.tmdl');
    const fnName = diff.displayName;

    if (diff.type === 0) {
        return [{
            action: 'appendTopLevel',
            targetPath: targetFile,
            block: diff.rawBlock,
            createIfMissing: true,
            description: { action: 'add', objectType: 'function', name: fnName, file: 'functions.tmdl' }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'removeTopLevel',
            targetPath: targetFile,
            objectType: 'function',
            objectName: fnName,
            description: { action: 'remove', objectType: 'function', name: fnName, file: 'functions.tmdl' }
        }];
    } else {
        return [{
            action: 'replaceTopLevel',
            targetPath: targetFile,
            objectType: 'function',
            objectName: fnName,
            newBlock: diff.rawBlock,
            description: { action: 'modify', objectType: 'function', name: fnName, file: 'functions.tmdl' }
        }];
    }
}

/**
 * Plan operations for role changes.
 */
function planRoleOp(diff, devModel, prodPath) {
    if (diff.objectType === 'role') {
        return planFileBasedOp(diff, devModel, prodPath, 'roles');
    }
    // tablePermission — modify the parent role file
    const roleName = diff.displayName.split(' → ')[0];
    const fileName = `${roleName}.tmdl`;
    const sourceFileKey = `roles/${fileName}`;
    const targetFile = path.join(prodPath, 'roles', fileName);
    const content = devModel.rawFiles[sourceFileKey];
    if (!content) return [];

    return [{
        action: 'writeFile',
        targetPath: targetFile,
        content,
        description: { action: diff.type === 0 ? 'add' : diff.type === 1 ? 'remove' : 'modify', objectType: 'tablePermission', name: diff.displayName, file: `roles/${fileName}` }
    }];
}

/**
 * Plan operations for file-based objects (roles, perspectives, cultures).
 */
function planFileBasedOp(diff, devModel, prodPath, subdir) {
    const name = diff.displayName;
    const fileName = `${name}.tmdl`;
    const sourceFileKey = `${subdir}/${fileName}`;
    const targetFile = path.join(prodPath, subdir, fileName);

    if (diff.type === 0) {
        const content = devModel.rawFiles[sourceFileKey];
        if (!content) return [];
        const refType = subdir === 'roles' ? 'role' : subdir === 'perspectives' ? 'perspective' : 'culture';
        return [{
            action: 'writeFile',
            targetPath: targetFile,
            content,
            ensureDir: true,
            updateModelRef: { type: 'add', refType, name },
            description: { action: 'add', objectType: diff.objectType, name, file: `${subdir}/${fileName}` }
        }];
    } else if (diff.type === 1) {
        const refType = subdir === 'roles' ? 'role' : subdir === 'perspectives' ? 'perspective' : 'culture';
        return [{
            action: 'deleteFile',
            targetPath: targetFile,
            updateModelRef: { type: 'remove', refType, name },
            description: { action: 'remove', objectType: diff.objectType, name, file: `${subdir}/${fileName}` }
        }];
    } else {
        const content = devModel.rawFiles[sourceFileKey];
        if (!content) return [];
        return [{
            action: 'writeFile',
            targetPath: targetFile,
            content,
            description: { action: 'modify', objectType: diff.objectType, name, file: `${subdir}/${fileName}` }
        }];
    }
}

/**
 * Plan operations for data source changes.
 */
function planDataSourceOp(diff, devModel, prodPath) {
    const targetFile = path.join(prodPath, 'dataSources.tmdl');
    const dsName = diff.displayName;

    if (diff.type === 0) {
        return [{
            action: 'appendTopLevel',
            targetPath: targetFile,
            block: diff.rawBlock,
            createIfMissing: true,
            description: { action: 'add', objectType: 'dataSource', name: dsName, file: 'dataSources.tmdl' }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'removeTopLevel',
            targetPath: targetFile,
            objectType: 'dataSource',
            objectName: dsName,
            description: { action: 'remove', objectType: 'dataSource', name: dsName, file: 'dataSources.tmdl' }
        }];
    } else {
        return [{
            action: 'replaceTopLevel',
            targetPath: targetFile,
            objectType: 'dataSource',
            objectName: dsName,
            newBlock: diff.rawBlock,
            description: { action: 'modify', objectType: 'dataSource', name: dsName, file: 'dataSources.tmdl' }
        }];
    }
}

/**
 * Execute a single file operation.
 */
function executeOperation(op, prodPath) {
    switch (op.action) {
        case 'writeFile': {
            if (op.ensureDir) {
                const dir = path.dirname(op.targetPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(op.targetPath, op.content, 'utf-8');
            break;
        }
        case 'deleteFile': {
            if (fs.existsSync(op.targetPath)) {
                fs.unlinkSync(op.targetPath);
            }
            break;
        }
        case 'appendChild': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = appendChildBlock(content, op.childBlock);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'removeChild': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = removeObjectBlock(content, op.childType, op.childName, 0);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'replaceChild': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = replaceObjectBlock(content, op.childType, op.childName, 0, op.newBlock);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'appendTopLevel': {
            if (!fs.existsSync(op.targetPath)) {
                if (op.createIfMissing) {
                    fs.writeFileSync(op.targetPath, op.block + '\n', 'utf-8');
                }
                break;
            }
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = appendTopLevelBlock(content, op.block);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'removeTopLevel': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = removeObjectBlock(content, op.objectType, op.objectName, -1);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'replaceTopLevel': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = replaceObjectBlock(content, op.objectType, op.objectName, -1, op.newBlock);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'replaceTableHeader': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            content = replaceTableHeader(content, op.devContent, op.tableName);
            fs.writeFileSync(op.targetPath, content, 'utf-8');
            break;
        }
        case 'ensureModelProperty': {
            if (!fs.existsSync(op.targetPath)) break;
            let content = fs.readFileSync(op.targetPath, 'utf-8');
            const updated = ensureModelProperty(content, op.propName, op.propValue);
            if (updated !== content) fs.writeFileSync(op.targetPath, updated, 'utf-8');
            break;
        }
    }

    // Handle model.tmdl ref updates
    if (op.updateModelRef) {
        const modelTmdlPath = path.join(prodPath, 'model.tmdl');
        if (fs.existsSync(modelTmdlPath)) {
            let modelContent = fs.readFileSync(modelTmdlPath, 'utf-8');
            if (op.updateModelRef.type === 'add') {
                modelContent = addRefEntry(modelContent, op.updateModelRef.refType, op.updateModelRef.name);
            } else {
                modelContent = removeRefEntry(modelContent, op.updateModelRef.refType, op.updateModelRef.name);
            }
            fs.writeFileSync(modelTmdlPath, modelContent, 'utf-8');
        }
    }
}

/**
 * Create a timestamped backup of the PROD folder.
 */
function createBackup(prodPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const parentDir = path.dirname(prodPath);
    const backupDir = path.join(parentDir, `definition_backup_${timestamp}`);
    
    copyDirSync(prodPath, backupDir);
    return backupDir;
}

/**
 * Recursively copy directory.
 */
function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

module.exports = { deployChanges };
