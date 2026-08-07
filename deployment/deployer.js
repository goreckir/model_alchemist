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
 * - Row-level-security membership and per-tablePermission edits
 * - Backup before deployment
 * - Transactional execution: stop on the first failure and roll every file back
 * - Cardinality change validation warnings for relationships
 */

const fs = require('fs');
const path = require('path');
const {
    findObjectBlock,
    removeObjectBlock,
    replaceObjectBlock,
    replaceTableHeader,
    replaceBlockHeader,
    appendTopLevelBlock,
    appendChildBlock,
    appendChildBlockNested,
    addRefEntry,
    removeRefEntry,
    ensureModelProperty,
    ensureTopLevelProperty,
    mergeReplacementBlock,
    mergeModelBlock
} = require('./tmdl-writer');
const { validateDependencies, COMPAT_LEVEL_REQUIREMENTS, getCompatibilityLevel } = require('./validator');
const { loadModelFromFolder } = require('../parser/model-loader');
const { extractAll } = require('../comparison/extractor');
const { rootKey } = require('../comparison/keys');

/** Child keywords that must survive a header-only replacement. */
const TABLE_CHILD_KEYWORDS = ['column', 'measure', 'hierarchy', 'partition', 'calculationGroup', 'calculationItem'];
const ROLE_CHILD_KEYWORDS = ['tablePermission', 'member'];

/**
 * Deploy selected diffs from DEV model to PROD folder.
 *
 * @param {Array} selectedDiffs - Array of diff objects to deploy
 * @param {object} devModel - Loaded DEV model (with rawFiles)
 * @param {string} prodPath - Path to PROD definition/ folder
 * @param {object} options - { dryRun, backup, prodModel?, allDiffs?, atomic? }
 * @returns {object} Deployment result { success, actions, errors, warnings, backupPath }
 */
function deployChanges(selectedDiffs, devModel, prodPath, options = {}) {
    const { dryRun = false, backup = true, backupPath, atomic = true } = options;
    const result = { success: true, actions: [], errors: [], warnings: [], backupPath: null };

    // Resolve the target model ONCE and reuse it for validation AND planning.
    // Planning used to receive options.prodModel (often undefined) while validation
    // used a freshly loaded copy, so an omitted prodModel made the compatibility
    // check see `null` and unconditionally rewrite compatibilityLevel — a silent
    // downgrade when the target was already higher.
    let prodModel = options.prodModel || null;
    let cascadeRels = [];
    try {
        if (!prodModel) prodModel = loadModelFromFolder(prodPath);
        const validation = validateDependencies(selectedDiffs, devModel, prodModel, options.allDiffs || []);
        result.warnings = validation.warnings;
        cascadeRels = validation.cascadeRels || [];
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
            message: `Dependency validation skipped: ${validationErr.message}`
        });
    }

    let extractionFailed = false;
    const context = {
        prodModel,
        prodObjects: prodModel ? safeExtract(prodModel, () => { extractionFailed = true; }) : {}
    };
    if (!prodModel || extractionFailed) {
        result.warnings.push({
            code: 'TARGET_PATHS_GUESSED',
            message: 'The target model could not be indexed, so target file paths for this deploy are guessed from ' +
                'object names (e.g. tables/<name>.tmdl) instead of the real file layout. Guessed paths can miss ' +
                'renamed or relocated files; review the plan carefully before applying it.'
        });
    }

    // Check for relationship cardinality changes that require data validation
    const cardinalityChanges = selectedDiffs.filter(d =>
        d.objectType === 'relationship' && d.cardinalityChange && d.cardinalityChange.requiresDataValidation
    );

    for (const relChange of cardinalityChanges) {
        const fromType = relChange.cardinalityChange.from;
        const toType = relChange.cardinalityChange.to;
        const relName = relChange.displayName;

        result.warnings.push({
            code: 'RELATIONSHIP_CARDINALITY_CHANGE',
            message: `WARNING: Changing relationship cardinality "${relName}" from ${fromType} to ${toType}.\n` +
                     `Ensure that key columns in tables do not contain duplicates:\n` +
                     `- For many-to-one: the "one" side column (toColumn) must not have duplicates\n` +
                     `- For one-to-many: the "one" side column (fromColumn) must not have duplicates\n` +
                     `- For one-to-one: both columns must be unique\n` +
                     `Fabric will block deployment if data does not meet cardinality requirements.\n` +
                     `If deployment fails - refresh table data and try again.`
        });
    }

    // Group diffs by their target file to minimize file I/O
    const fileOps = planFileOperations(selectedDiffs, devModel, prodPath, prodModel, context);

    // Auto-cascade: remove orphaned relationships detected by validator
    for (const rel of cascadeRels) {
        const relName = rel.relName || rel.displayName;
        fileOps.push({
            action: 'removeTopLevel',
            targetPath: path.join(prodPath, rel.sourceFile || 'relationships.tmdl'),
            objectType: 'relationship',
            objectName: relName,
            description: { action: 'remove', objectType: 'relationship', name: rel.displayName, file: rel.sourceFile || 'relationships.tmdl', reason: 'auto-cascade: referenced column/table removed' }
        });
    }

    // Surface everything a raw-block replacement would ship beyond the reviewed
    // property diffs, so the preview never understates the deployed change.
    result.warnings.push(...collectUnreviewedChangeWarnings(fileOps));

    // Create backup if requested
    if (backup && !dryRun) {
        const backupDir = createBackup(prodPath, backupPath);
        result.backupPath = backupDir;
        result.actions.push({ type: 'backup', message: `Backup created: ${backupDir}` });
    }

    if (dryRun) {
        for (const op of fileOps) {
            if (IDEMPOTENT_ACTIONS.has(op.action) && !wouldChangeFile(op)) continue;
            result.actions.push({ type: 'dryrun', ...op.description });
        }
        return result;
    }

    executeAll(fileOps, prodPath, result, atomic);
    return result;
}

/** extractAll can throw on a malformed model; never let that kill a deploy plan. */
function safeExtract(model, onFailure) {
    try { return extractAll(model); } catch { if (onFailure) onFailure(); return {}; }
}

// Ops that are idempotent "ensure" checks — only report/apply them if they'd
// actually change the target file, so the preview/result don't show misleading
// "will modify" entries for properties that are already correctly set (e.g.
// discourageImplicitMeasures already true on TARGET).
const IDEMPOTENT_ACTIONS = new Set(['ensureModelProperty', 'ensureTopLevelProperty']);

/**
 * Execute planned operations.
 *
 * Atomic mode (the default) snapshots every file an operation can touch, stops at
 * the first failure and restores all of them. The previous loop recorded the error
 * and CARRIED ON, so a failure at operation 5 of 12 left a half-written model that
 * matched neither source nor target and could only be recovered by hand.
 */
function executeAll(fileOps, prodPath, result, atomic) {
    const snapshot = new Map();
    const capture = filePath => {
        if (!filePath || snapshot.has(filePath)) return;
        snapshot.set(filePath, fs.existsSync(filePath)
            ? { existed: true, content: fs.readFileSync(filePath, 'utf-8') }
            : { existed: false });
    };

    if (atomic) {
        for (const op of fileOps) {
            capture(op.targetPath);
            if (op.updateModelRef) capture(path.join(prodPath, 'model.tmdl'));
        }
    }

    const applied = [];
    for (const op of fileOps) {
        let failure = null;
        try {
            const opResult = executeOperation(op, prodPath) || { changed: true };
            if (opResult.changed === false) {
                if (IDEMPOTENT_ACTIONS.has(op.action)) continue; // already correct on TARGET
                failure = opResult.reason
                    || `Operation ${op.action} did not modify the file (block not found in the target).`;
                result.warnings.push({ code: opResult.code || 'OPERATION_NOOP', operation: op.description, message: failure });
            } else {
                applied.push({ type: 'applied', ...op.description });
            }
        } catch (err) {
            failure = err.message;
        }

        if (failure) {
            result.errors.push({ operation: op.description, error: failure });
            result.success = false;
            if (atomic) {
                const { restored, failed } = rollback(snapshot);
                result.rolledBack = true;
                if (failed.length > 0) {
                    result.errors.push({
                        operation: { action: 'rollback' },
                        code: 'ROLLBACK_INCOMPLETE',
                        error: `${failed.length} file(s) could not be restored during rollback: ${failed.map(f => f.filePath).join(', ')}. The target is left in a partially-deployed state.`
                    });
                    result.actions.push({
                        type: 'rollback',
                        message: `Deployment stopped at a failing operation. ${restored} file(s) restored, but ${failed.length} file(s) could NOT be restored — the target is NOT guaranteed unchanged.`
                    });
                } else {
                    result.actions.push({
                        type: 'rollback',
                        message: `Deployment stopped at a failing operation. ${restored} file(s) restored to their pre-deployment content — the target is unchanged.`
                    });
                }
                return result;
            }
        }
    }

    result.actions.push(...applied);
    return result;
}

/**
 * Restore every captured file.
 * @returns {{ restored: number, failed: Array<{ filePath: string, error: string }> }}
 */
function rollback(snapshot) {
    let restored = 0;
    const failed = [];
    for (const [filePath, state] of snapshot) {
        try {
            if (state.existed) {
                if (fs.readFileSync(filePath, 'utf-8') !== state.content) {
                    fs.writeFileSync(filePath, state.content, 'utf-8');
                    restored++;
                }
            } else if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                restored++;
            }
        } catch (err) {
            // Surfaced to the caller as ROLLBACK_INCOMPLETE — never silently swallowed.
            failed.push({ filePath, error: err.message });
        }
    }
    return { restored, failed };
}

// ── File resolution ──────────────────────────────────────────────────────────
// TMDL does not require a file name to match the object name (loaders scan the
// folder). Rebuilding paths as `tables/<displayName>.tmdl` therefore missed the
// real file whenever they differed: planning returned nothing and the deploy
// reported success without writing anything.

/** Relative path of the DEV file that holds this diff's source block. */
function devFileKey(diff, fallback) {
    return diff.sourceFile || fallback;
}

/** Relative path of the TARGET file that holds (or will hold) this object. */
function targetFileKey(diff, context, fallback) {
    if (diff.type !== 0 && diff.targetFile) return diff.targetFile;
    const prodObj = context.prodObjects[diff.identityKey];
    if (prodObj && prodObj.sourceFile) return prodObj.sourceFile;
    if (diff.type === 0 && diff.sourceFile) return diff.sourceFile; // new file mirrors DEV
    return fallback;
}

/** Relative path of the TARGET file holding a child's parent table. */
function parentTableFileKey(diff, context, fallback) {
    if (diff.type !== 0 && diff.targetFile) return diff.targetFile;
    const table = context.prodObjects[rootKey('table', diff.parentTable)];
    if (table && table.sourceFile) return table.sourceFile;
    if (diff.sourceFile) return diff.sourceFile;
    return fallback;
}

/** Relative path of the TARGET file holding a role. */
function roleFileKey(roleName, context, fallback) {
    const role = context.prodObjects[rootKey('role', roleName)];
    return (role && role.sourceFile) || fallback;
}

/**
 * Plan all file operations from selected diffs.
 *
 * When a table is being Added or Removed in the same batch, its child diffs
 * (column/measure/hierarchy/partition/calculationGroup/calculationItem) are
 * skipped because the whole table file is being written/deleted in one op.
 * The same holds for a calculationGroup being added: its rawBlock already
 * contains every calculationItem.
 */
function planFileOperations(selectedDiffs, devModel, prodPath, prodModel, context = { prodObjects: {} }) {
    const operations = [];

    const tablesBeingAdded = new Set();
    const tablesBeingRemoved = new Set();
    const calcGroupsBeingAdded = new Set();
    for (const d of selectedDiffs) {
        if (d.objectType === 'table') {
            if (d.type === 0) tablesBeingAdded.add(d.displayName);
            else if (d.type === 1) tablesBeingRemoved.add(d.displayName);
        } else if (d.objectType === 'calculationGroup' && d.type === 0 && d.parentTable) {
            calcGroupsBeingAdded.add(d.parentTable);
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
            // A calculationGroup ADD carries its items inside its rawBlock. Without
            // this the item was inserted a second time and the model became
            // unloadable (duplicate object names).
            if (diff.type === 0 && diff.objectType === 'calculationItem' && calcGroupsBeingAdded.has(diff.parentTable)) continue;
        }
        const ops = planSingleDiff(diff, devModel, prodPath, context);
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

    // Detect required compatibilityLevel bumps (e.g. UDF requires >= 1702).
    // If the target's current compatibilityLevel is below the highest required
    // level among selected diffs, auto-bump it in database.tmdl so the deploy
    // succeeds instead of failing with COMPAT_LEVEL_TOO_LOW.
    let requiredCompat = 0;
    for (const d of selectedDiffs) {
        if (d.type === 1) continue;
        const req = COMPAT_LEVEL_REQUIREMENTS[d.objectType];
        if (req && req > requiredCompat) requiredCompat = req;
    }
    if (requiredCompat > 0) {
        const currentCompat = prodModel ? getCompatibilityLevel(prodModel) : null;
        // Never lower an existing level: only bump when the target is genuinely below.
        if (currentCompat === null || currentCompat < requiredCompat) {
            operations.push({
                action: 'ensureTopLevelProperty',
                targetPath: path.join(prodPath, 'database.tmdl'),
                blockKeyword: 'database',
                propName: 'compatibilityLevel',
                propValue: String(requiredCompat),
                description: {
                    action: 'modify',
                    objectType: 'database',
                    name: 'compatibilityLevel',
                    file: 'database.tmdl',
                    reason: `auto-bump to ${requiredCompat} (required by deployed object)`
                }
            });
        }
    }

    return operations;
}

/**
 * Plan operations for a single diff.
 */
function planSingleDiff(diff, devModel, prodPath, context) {
    const ops = [];

    switch (diff.objectType) {
        case 'table':
            ops.push(...planTableOp(diff, devModel, prodPath, context));
            break;
        case 'column':
        case 'measure':
        case 'hierarchy':
        case 'partition':
        case 'calculationGroup':
        case 'calculationItem':
            ops.push(...planChildObjectOp(diff, devModel, prodPath, context));
            break;
        case 'relationship':
            ops.push(...planRelationshipOp(diff, devModel, prodPath, context));
            break;
        case 'expression':
            ops.push(...planTopLevelOp(diff, devModel, prodPath, context, 'expression', 'expressions.tmdl'));
            break;
        case 'function':
            ops.push(...planTopLevelOp(diff, devModel, prodPath, context, 'function', 'functions.tmdl'));
            break;
        case 'dataSource':
            ops.push(...planTopLevelOp(diff, devModel, prodPath, context, 'dataSource', 'dataSources.tmdl'));
            break;
        case 'model':
            ops.push(...planModelOp(diff, devModel, prodPath, context));
            break;
        case 'role':
            ops.push(...planRoleOp(diff, devModel, prodPath, context));
            break;
        case 'tablePermission':
            ops.push(...planRoleChildOp(diff, devModel, prodPath, context, 'tablePermission'));
            break;
        case 'roleMember':
            ops.push(...planRoleChildOp(diff, devModel, prodPath, context, 'member'));
            break;
        case 'perspective':
            ops.push(...planFileBasedOp(diff, devModel, prodPath, context, 'perspectives'));
            break;
        case 'culture':
            ops.push(...planFileBasedOp(diff, devModel, prodPath, context, 'cultures'));
            break;
        default:
            break;
    }

    return ops;
}

/**
 * Plan operations for table-level changes.
 */
function planTableOp(diff, devModel, prodPath, context) {
    const tableName = diff.displayName;
    const fallback = `tables/${tableName}.tmdl`;
    const sourceFileKey = devFileKey(diff, fallback);
    const targetKey = targetFileKey(diff, context, fallback);
    const targetFile = path.join(prodPath, targetKey);

    if (diff.type === 0) {
        // ADD: copy entire table file from DEV to PROD
        const content = devModel.rawFiles[sourceFileKey];
        if (!content) return [missingSourceOp(diff, sourceFileKey)];
        return [{
            action: 'writeFile',
            targetPath: targetFile,
            content,
            ensureDir: true,
            updateModelRef: { type: 'add', refType: 'table', name: tableName },
            description: { action: 'add', objectType: 'table', name: tableName, file: targetKey }
        }];
    } else if (diff.type === 1) {
        // REMOVE: delete table file from PROD
        return [{
            action: 'deleteFile',
            targetPath: targetFile,
            updateModelRef: { type: 'remove', refType: 'table', name: tableName },
            description: { action: 'remove', objectType: 'table', name: tableName, file: targetKey }
        }];
    }

    // MODIFY: atomic table-modify — update only table header (declaration + table-level props),
    // preserving children (columns/measures/hierarchies/partitions) in target.
    const devContent = devModel.rawFiles[sourceFileKey];
    if (!devContent) return [missingSourceOp(diff, sourceFileKey)];
    return [{
        action: 'replaceTableHeader',
        targetPath: targetFile,
        devContent,
        tableName,
        description: { action: 'modify', objectType: 'table', name: tableName, file: targetKey, atomic: true }
    }];
}

/**
 * Plan operations for child objects (columns, measures, etc.) within a table.
 */
function planChildObjectOp(diff, devModel, prodPath, context) {
    const tableName = diff.parentTable;
    if (!tableName) return [];

    const fallback = `tables/${tableName}.tmdl`;
    const targetKey = parentTableFileKey(diff, context, fallback);
    const targetFile = path.join(prodPath, targetKey);
    const objectType = diff.objectType;

    // The child's own TMDL name comes from the extractor. Deriving it by splitting
    // displayName on dots produced '' for calculation groups (whose displayName is
    // just the table name) and mangled every child of a table containing a dot.
    // For remove/modify we need the name as it appears in the TARGET file, which
    // differs from the logical name for GUID-suffixed partitions.
    const objectName = diff.type === 0
        ? (diff.objectName != null ? diff.objectName : '')
        : (diff.targetObjectName != null ? diff.targetObjectName : diff.objectName || '');

    // calculationItem lives at indent 2 (child of calculationGroup at indent 1)
    const parentIndent = (objectType === 'calculationItem') ? 1 : 0;

    if (diff.type === 0) {
        return [{
            action: 'appendChild',
            targetPath: targetFile,
            childBlock: diff.rawBlock,
            parentIndent,
            childType: objectType,
            childName: objectName,
            description: { action: 'add', objectType, name: diff.displayName, file: targetKey }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'removeChild',
            targetPath: targetFile,
            childType: objectType,
            childName: objectName,
            parentIndent,
            description: { action: 'remove', objectType, name: diff.displayName, file: targetKey }
        }];
    }
    return [{
        action: 'replaceChild',
        targetPath: targetFile,
        childType: objectType,
        childName: objectName,
        newBlock: diff.rawBlock,
        parentIndent,
        reviewedProperties: (diff.propertyDiffs || []).map(p => p.propertyName),
        description: { action: 'modify', objectType, name: diff.displayName, file: targetKey }
    }];
}

/**
 * Plan operations for relationship changes.
 */
function planRelationshipOp(diff, devModel, prodPath, context) {
    const fallback = 'relationships.tmdl';
    const targetKey = targetFileKey(diff, context, fallback);
    const targetFile = path.join(prodPath, targetKey);

    // For modify/remove we must locate the existing relationship in the target file.
    // TMDL names are usually GUIDs and differ across environments — use targetRelName
    // (set by engine from prod object) when available, otherwise fall back to parsing
    // the rawBlock first line (which is correct for Remove diffs whose rawBlock = prod).
    function extractRelName(rawBlock) {
        const m = rawBlock ? rawBlock.match(/^relationship\s+(.+)$/m) : null;
        return m ? m[1].trim().replace(/^'|'$/g, '') : diff.displayName;
    }
    const relName = diff.targetRelName || diff.targetObjectName || extractRelName(diff.rawBlock);

    if (diff.type === 0) {
        return [{
            action: 'appendTopLevel',
            targetPath: targetFile,
            block: diff.rawBlock,
            // A model with no relationships yet has no relationships.tmdl. Without
            // this the operation silently did nothing and still reported success.
            createIfMissing: true,
            description: { action: 'add', objectType: 'relationship', name: diff.displayName, file: targetKey }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'removeTopLevel',
            targetPath: targetFile,
            objectType: 'relationship',
            objectName: relName,
            description: { action: 'remove', objectType: 'relationship', name: diff.displayName, file: targetKey }
        }];
    }
    return [{
        action: 'replaceTopLevel',
        targetPath: targetFile,
        objectType: 'relationship',
        objectName: relName,
        newBlock: diff.rawBlock,
        reviewedProperties: (diff.propertyDiffs || []).map(p => p.propertyName),
        description: { action: 'modify', objectType: 'relationship', name: diff.displayName, file: targetKey }
    }];
}

/**
 * Plan operations for a top-level object living in a shared file
 * (expressions.tmdl / functions.tmdl / dataSources.tmdl).
 */
function planTopLevelOp(diff, devModel, prodPath, context, objectType, fallbackFile) {
    const targetKey = targetFileKey(diff, context, fallbackFile);
    const targetFile = path.join(prodPath, targetKey);
    const name = diff.objectName || diff.displayName;

    if (diff.type === 0) {
        return [{
            action: 'appendTopLevel',
            targetPath: targetFile,
            block: diff.rawBlock,
            createIfMissing: true,
            description: { action: 'add', objectType, name: diff.displayName, file: targetKey }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'removeTopLevel',
            targetPath: targetFile,
            objectType,
            objectName: name,
            description: { action: 'remove', objectType, name: diff.displayName, file: targetKey }
        }];
    }
    return [{
        action: 'replaceTopLevel',
        targetPath: targetFile,
        objectType,
        objectName: name,
        newBlock: diff.rawBlock,
        reviewedProperties: (diff.propertyDiffs || []).map(p => p.propertyName),
        description: { action: 'modify', objectType, name: diff.displayName, file: targetKey }
    }];
}

/**
 * Plan operations for model-level property changes (model.tmdl, the `model X` declaration).
 * Only the model's own properties are replaced; refs and PBI_* annotations are preserved.
 */
function planModelOp(diff, devModel, prodPath, context) {
    const targetKey = targetFileKey(diff, context, 'model.tmdl');
    const targetFile = path.join(prodPath, targetKey);

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
            action: 'replaceModelBlock',
            targetPath: targetFile,
            objectType: 'model',
            objectName: modelName,
            newBlock: diff.rawBlock,
            reviewedProperties: (diff.propertyDiffs || []).map(p => p.propertyName),
            description: { action: 'modify', objectType: 'model', name: diff.displayName, file: targetKey }
        }];
    }
    return [];
}

/**
 * Plan operations for role changes.
 *
 * A role modify replaces ONLY the role header. Writing the whole DEV role file
 * replaced the target's RLS members with DEV's (dev accounts in, prod accounts
 * out) and deployed every other unselected change in that file.
 */
function planRoleOp(diff, devModel, prodPath, context) {
    const roleName = diff.displayName;
    const fallback = `roles/${roleName}.tmdl`;
    const sourceFileKey = devFileKey(diff, fallback);
    const targetKey = diff.type === 0 ? sourceFileKey : roleFileKey(roleName, context, fallback);
    const targetFile = path.join(prodPath, targetKey);

    if (diff.type === 0) {
        const content = devModel.rawFiles[sourceFileKey];
        if (!content) return [missingSourceOp(diff, sourceFileKey)];
        return [{
            action: 'writeFile',
            targetPath: targetFile,
            content,
            ensureDir: true,
            updateModelRef: { type: 'add', refType: 'role', name: roleName },
            description: { action: 'add', objectType: 'role', name: roleName, file: targetKey }
        }];
    }
    if (diff.type === 1) {
        return [{
            action: 'deleteFile',
            targetPath: targetFile,
            updateModelRef: { type: 'remove', refType: 'role', name: roleName },
            description: { action: 'remove', objectType: 'role', name: roleName, file: targetKey }
        }];
    }

    const devContent = devModel.rawFiles[sourceFileKey];
    if (!devContent) return [missingSourceOp(diff, sourceFileKey)];
    return [{
        action: 'replaceBlockHeader',
        targetPath: targetFile,
        devContent,
        blockKeyword: 'role',
        blockName: roleName,
        childKeywords: ROLE_CHILD_KEYWORDS,
        description: { action: 'modify', objectType: 'role', name: roleName, file: targetKey, atomic: true }
    }];
}

/**
 * Plan operations for a role's children: tablePermission and member.
 *
 * roleMember had no case at all, so a selected RLS membership change produced
 * zero operations and zero errors — a silent, security-relevant no-op.
 */
function planRoleChildOp(diff, devModel, prodPath, context, childType) {
    const roleName = diff.parentRole || String(diff.displayName).split(' → ')[0];
    const fallback = `roles/${roleName}.tmdl`;
    const targetKey = roleFileKey(roleName, context, fallback);
    const targetFile = path.join(prodPath, targetKey);
    const childName = diff.type === 0
        ? (diff.objectName || '')
        : (diff.targetObjectName || diff.objectName || '');

    const objectType = diff.objectType;

    if (diff.type === 0) {
        return [{
            action: 'appendChild',
            targetPath: targetFile,
            childBlock: diff.rawBlock,
            parentIndent: 0,
            childType,
            childName,
            description: { action: 'add', objectType, name: diff.displayName, file: targetKey }
        }];
    }
    if (diff.type === 1) {
        return [{
            action: 'removeChild',
            targetPath: targetFile,
            childType,
            childName,
            parentIndent: 0,
            description: { action: 'remove', objectType, name: diff.displayName, file: targetKey }
        }];
    }
    return [{
        action: 'replaceChild',
        targetPath: targetFile,
        childType,
        childName,
        newBlock: diff.rawBlock,
        parentIndent: 0,
        reviewedProperties: (diff.propertyDiffs || []).map(p => p.propertyName),
        description: { action: 'modify', objectType, name: diff.displayName, file: targetKey }
    }];
}

/**
 * Plan operations for file-based objects (perspectives, cultures).
 */
function planFileBasedOp(diff, devModel, prodPath, context, subdir) {
    const name = diff.displayName;
    const fallback = `${subdir}/${name}.tmdl`;
    const sourceFileKey = devFileKey(diff, fallback);
    const targetKey = diff.type === 0 ? sourceFileKey : targetFileKey(diff, context, fallback);
    const targetFile = path.join(prodPath, targetKey);
    const refType = subdir === 'roles' ? 'role' : subdir === 'perspectives' ? 'perspective' : 'culture';

    if (diff.type === 0) {
        const content = devModel.rawFiles[sourceFileKey];
        if (!content) return [missingSourceOp(diff, sourceFileKey)];
        return [{
            action: 'writeFile',
            targetPath: targetFile,
            content,
            ensureDir: true,
            updateModelRef: { type: 'add', refType, name },
            description: { action: 'add', objectType: diff.objectType, name, file: targetKey }
        }];
    } else if (diff.type === 1) {
        return [{
            action: 'deleteFile',
            targetPath: targetFile,
            updateModelRef: { type: 'remove', refType, name },
            description: { action: 'remove', objectType: diff.objectType, name, file: targetKey }
        }];
    }
    const content = devModel.rawFiles[sourceFileKey];
    if (!content) return [missingSourceOp(diff, sourceFileKey)];
    return [{
        action: 'writeFile',
        targetPath: targetFile,
        content,
        description: { action: 'modify', objectType: diff.objectType, name, file: targetKey }
    }];
}

/**
 * A plan step that cannot be built because the DEV source block is missing.
 * Returning [] used to make the deploy report success while doing nothing.
 */
function missingSourceOp(diff, sourceFileKey) {
    return {
        action: 'fail',
        reason: `Source block '${sourceFileKey}' was not found in the source model for ${diff.displayName}.`,
        code: 'DEV_SOURCE_MISSING',
        description: { action: diff.type === 1 ? 'remove' : diff.type === 0 ? 'add' : 'modify', objectType: diff.objectType, name: diff.displayName, file: sourceFileKey }
    };
}

// ── Preview honesty ──────────────────────────────────────────────────────────

/**
 * A modify replaces the object's whole raw block, but the UI only shows the
 * property-level diff. Report the lines that would change beyond the reviewed
 * properties so the preview never understates what is shipped.
 */
function collectUnreviewedChangeWarnings(fileOps) {
    const warnings = [];
    for (const op of fileOps) {
        if (!['replaceChild', 'replaceTopLevel', 'replaceModelBlock'].includes(op.action)) continue;
        const extra = unreviewedBlockChanges(op);
        if (extra && extra.length > 0) {
            warnings.push({
                code: 'UNREVIEWED_BLOCK_CHANGES',
                operation: op.description,
                message: `Deploying '${op.description.name}' replaces its whole TMDL block. Beyond the properties you reviewed, this also changes: ` +
                    `${extra.slice(0, 10).join('; ')}${extra.length > 10 ? ` (+${extra.length - 10} more)` : ''}.`
            });
        }
    }
    return warnings;
}

const PROPERTY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/;

function unreviewedBlockChanges(op) {
    try {
        if (!op.targetPath || !fs.existsSync(op.targetPath)) return null;
        const content = fs.readFileSync(op.targetPath, 'utf-8');
        const parentIndent = op.parentIndent == null ? -1 : op.parentIndent;
        const objectType = op.childType || op.objectType;
        const objectName = op.childName != null ? op.childName : op.objectName;
        const location = findObjectBlock(content, objectType, objectName, parentIndent);
        if (!location) return null;

        const merge = op.action === 'replaceModelBlock' ? mergeModelBlock : mergeReplacementBlock;
        const merged = merge(location.block, op.newBlock);
        const reviewed = new Set((op.reviewedProperties || []).map(p => String(p).toLowerCase()));

        const before = new Set(location.block.split('\n').map(l => l.trim()).filter(Boolean));
        const after = new Set(merged.split('\n').map(l => l.trim()).filter(Boolean));

        const changes = [];
        const note = (line, verb) => {
            const m = line.match(PROPERTY_LINE_RE);
            if (m) {
                if (reviewed.has(m[1].toLowerCase())) return;
                changes.push(`${verb} ${line}`);
                return;
            }
            // Only declarations are reported; expression continuation lines belong
            // to a property that was already reviewed and would only add noise.
            if (/^(annotation|extendedProperty|variation|alternateOf|refreshPolicy|kpi)\b/i.test(line)) {
                changes.push(`${verb} ${line}`);
            }
        };

        for (const line of after) if (!before.has(line)) note(line, '+');
        for (const line of before) if (!after.has(line)) note(line, '-');
        return changes;
    } catch {
        return null;
    }
}

/**
 * Read-only check: would an idempotent "ensure" op actually change its target file?
 * Used by the dry-run preview to skip no-op entries (e.g. discourageImplicitMeasures
 * already true on TARGET) without writing anything.
 */
function wouldChangeFile(op) {
    if (!fs.existsSync(op.targetPath)) return false;
    const content = fs.readFileSync(op.targetPath, 'utf-8');
    let updated;
    if (op.action === 'ensureModelProperty') {
        updated = ensureModelProperty(content, op.propName, op.propValue);
    } else if (op.action === 'ensureTopLevelProperty') {
        updated = ensureTopLevelProperty(content, op.blockKeyword, op.propName, op.propValue);
    } else {
        return true;
    }
    return updated !== content;
}

/**
 * Execute a single file operation.
 * Every branch returns an explicit { changed } result so a silent no-op can never
 * be reported as an applied change.
 */
function executeOperation(op, prodPath) {
    let outcome = { changed: true };

    switch (op.action) {
        case 'fail': {
            return { changed: false, code: op.code || 'PLAN_FAILED', reason: op.reason };
        }
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
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = (op.parentIndent && op.parentIndent > 0)
                ? appendChildBlockNested(before, op.childBlock, op.parentIndent)
                : appendChildBlock(before, op.childBlock);
            if (after === null) {
                return {
                    changed: false,
                    code: 'PARENT_BLOCK_MISSING',
                    reason: `Parent block for ${op.childType} '${op.childName}' was not found in ${path.basename(op.targetPath)}. ` +
                        `Select the calculationGroup for deployment together with its items.`
                };
            }
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: after !== before };
        }
        case 'removeChild': {
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = removeObjectBlock(before, op.childType, op.childName, op.parentIndent || 0);
            if (after === before) {
                return { changed: false, code: 'BLOCK_NOT_FOUND', reason: `Block ${op.childType} '${op.childName}' was not found in ${path.basename(op.targetPath)}` };
            }
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: true };
        }
        case 'replaceChild': {
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = replaceObjectBlock(before, op.childType, op.childName, op.parentIndent || 0, op.newBlock);
            if (after === before) {
                return { changed: false, code: 'BLOCK_NOT_FOUND', reason: `Block ${op.childType} '${op.childName}' was not found in ${path.basename(op.targetPath)} (the target does not have this object, or uses different indentation)` };
            }
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: true };
        }
        case 'appendTopLevel': {
            if (!fs.existsSync(op.targetPath)) {
                if (!op.createIfMissing) {
                    return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
                }
                const dir = path.dirname(op.targetPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(op.targetPath, op.block + '\n', 'utf-8');
                break;
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = appendTopLevelBlock(before, op.block);
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: after !== before };
        }
        case 'removeTopLevel': {
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = removeObjectBlock(before, op.objectType, op.objectName, -1);
            if (after === before) {
                return { changed: false, code: 'BLOCK_NOT_FOUND', reason: `Block ${op.objectType} '${op.objectName}' was not found in ${path.basename(op.targetPath)}` };
            }
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: true };
        }
        case 'replaceTopLevel':
        case 'replaceModelBlock': {
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const merge = op.action === 'replaceModelBlock' ? mergeModelBlock : undefined;
            const after = replaceObjectBlock(before, op.objectType, op.objectName, -1, op.newBlock, merge);
            if (after === before) {
                return { changed: false, code: 'BLOCK_NOT_FOUND', reason: `Block ${op.objectType} '${op.objectName}' was not found in ${path.basename(op.targetPath)} (the target does not have this object, or uses different indentation)` };
            }
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: true };
        }
        case 'replaceTableHeader': {
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = replaceTableHeader(before, op.devContent, op.tableName);
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: after !== before };
        }
        case 'replaceBlockHeader': {
            if (!fs.existsSync(op.targetPath)) {
                return { changed: false, code: 'TARGET_FILE_MISSING', reason: `Target file does not exist: ${op.targetPath}` };
            }
            const before = fs.readFileSync(op.targetPath, 'utf-8');
            const after = replaceBlockHeader(before, op.devContent, op.blockKeyword, op.blockName, op.childKeywords);
            fs.writeFileSync(op.targetPath, after, 'utf-8');
            return { changed: after !== before };
        }
        case 'ensureModelProperty': {
            if (!fs.existsSync(op.targetPath)) return { changed: false };
            const content = fs.readFileSync(op.targetPath, 'utf-8');
            const updated = ensureModelProperty(content, op.propName, op.propValue);
            if (updated === content) return { changed: false };
            fs.writeFileSync(op.targetPath, updated, 'utf-8');
            return { changed: true };
        }
        case 'ensureTopLevelProperty': {
            if (!fs.existsSync(op.targetPath)) return { changed: false };
            const content = fs.readFileSync(op.targetPath, 'utf-8');
            const updated = ensureTopLevelProperty(content, op.blockKeyword, op.propName, op.propValue);
            if (updated === content) return { changed: false };
            fs.writeFileSync(op.targetPath, updated, 'utf-8');
            return { changed: true };
        }
        default:
            return { changed: false, code: 'UNKNOWN_OPERATION', reason: `Unknown operation: ${op.action}` };
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

    return outcome;
}

/**
 * Create a timestamped backup of the entire .SemanticModel folder (P2 #12).
 *
 * `prodPath` points at the `definition/` sub-folder inside `<Model>.SemanticModel`.
 * Backing up only `definition/` is insufficient — `definition.pbism`, the diagram
 * layout, cached files and other sibling artifacts must also be preserved so the
 * model can be restored to a fully working state. We therefore back up the entire
 * parent (`.SemanticModel`) folder, placing the copy next to it.
 *
 * Backup naming:
 *   <ParentDir>/<SemanticModelFolderName>_backup_<timestamp>/
 *
 * Falls back to the legacy `definition_backup_<timestamp>` layout if the parent
 * folder name does not end with `.SemanticModel` (defensive: keeps behaviour for
 * non-standard layouts and the test fixtures).
 */
function createBackup(prodPath, customBackupPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const semanticModelDir = path.dirname(prodPath);
    const semanticModelName = path.basename(semanticModelDir);

    const isSemanticModelFolder = /\.SemanticModel$/i.test(semanticModelName);

    let backupDir;
    if (customBackupPath) {
        // Custom backup destination — place named backup inside provided folder
        const folderName = isSemanticModelFolder ? semanticModelName : path.basename(prodPath);
        backupDir = path.join(customBackupPath, `${folderName}_backup_${timestamp}`);
    } else {
        // Default: next to the semantic model folder
        const grandParent = path.dirname(semanticModelDir);
        backupDir = isSemanticModelFolder
            ? path.join(grandParent, `${semanticModelName}_backup_${timestamp}`)
            : path.join(semanticModelDir, `definition_backup_${timestamp}`);
    }

    const sourceDir = isSemanticModelFolder ? semanticModelDir : prodPath;
    copyDirSync(sourceDir, backupDir);
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

module.exports = { deployChanges, planFileOperations };
