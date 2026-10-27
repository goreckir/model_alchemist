/**
 * Fabric deployment: drift check against the live definition, apply in a temp
 * folder, upload, then work out which tables need a refresh.
 *
 * Fabric calls go through the module objects (fabricAuth, fabricApi,
 * readinessClient) rather than destructured functions, so tests can stub them.
 * A host with its own sign-in passes `options.auth` with the same interface.
 */
const fs = require('fs');
const path = require('path');
const { loadModelFromFolder } = require('../parser/model-loader');
const { deployChanges } = require('../deployment/deployer');
const { mergeDeployResultIntoResponse } = require('../lib/deploy-response');
const fabricAuth = require('../fabric/auth');
const fabricApi = require('../fabric/api-client');
const readinessClient = require('../fabric/readiness-client');
const modelReadiness = require('../lib/model-readiness');
const { normalizePath } = require('../fabric/model-loader');
const { compareRawFiles } = require('../lib/raw-files');

/**
 * Get a valid Fabric token or fail with a clear message.
 *
 * `await a() || b()` binds the await to the first call only, so when it resolved
 * null the fallback produced an un-awaited Promise and the upload went out with
 * `Authorization: Bearer [object Promise]`, failing as a cryptic 401.
 */
async function requireFabricToken(auth = fabricAuth) {
    const token = await auth.getAccessToken();
    if (!token) {
        throw new Error('Not authenticated to Fabric (the session token expired). Sign in again and retry.');
    }
    return token;
}

/** Fetch the live definition of a Fabric model as a { relativePath: content } map. */
async function fetchFabricRawFiles(token, fabricInfo) {
    const files = await fabricApi.getSemanticModelDefinition(token, fabricInfo.workspaceId, fabricInfo.semanticModelId);
    const rawFiles = {};
    for (const file of files || []) {
        rawFiles[normalizePath(file.path)] = file.content;
    }
    return rawFiles;
}

/**
 * Post-deployment target model readiness inspection (MVP).
 * Never throws — a failed inspection is reported as "unavailable", not as a
 * deployment failure and never as a fabricated "ready" state.
 */
async function inspectTargetReadiness(token, fabricInfo) {
    try {
        const records = await readinessClient.getPartitionReadiness(token, fabricInfo.workspaceId, fabricInfo.semanticModelId);
        return modelReadiness.buildReadinessSnapshot(records);
    } catch (err) {
        const reasonCode = err.reasonCode || 'READINESS_REQUEST_FAILED';
        const message = err.reasonCode
            ? err.message
            : 'The definition was deployed, but runtime object state could not be inspected.';
        return modelReadiness.buildUnavailableSnapshot(reasonCode, message);
    }
}

/**
 * Deploy changes to a Fabric semantic model.
 * Strategy: re-fetch the live definition, apply changes in a temp dir, upload.
 */
async function deployToFabric(selectedDiffs, devModel, prodModel, fabricInfo, options = {}) {
    const { dryRun = false, backup = false, backupPath, force = false, auth = fabricAuth } = options;
    const os = require('os');
    const tmpDir = path.join(os.tmpdir(), `model-alchemist-deploy-${Date.now()}`);
    const result = { success: true, actions: [], errors: [], backupPath: null };
    // Set to a freshly-loaded model when a forced deploy re-plans against the
    // live Fabric definition (finding 4.6); otherwise the original snapshot is used.
    let effectiveProdModel = prodModel;

    try {
        // A Fabric deploy replaces the WHOLE definition. Seeding it from the
        // snapshot captured at compare time silently reverted anything another
        // user, a pipeline or a Desktop publish changed in the meantime — with no
        // warning and no trace. Re-fetch the live definition and refuse to deploy
        // over changes the user has not seen.
        let baseFiles = prodModel.rawFiles;
        let forcedOverDrift = false;
        if (!dryRun) {
            const token = await requireFabricToken(auth);
            const currentFiles = await fetchFabricRawFiles(token, fabricInfo);
            const drift = compareRawFiles(prodModel.rawFiles, currentFiles);

            if (drift.length > 0 && !force) {
                result.success = false;
                const list = drift.slice(0, 10).map(d => `${d.file} (${d.change})`).join(', ');
                const more = drift.length > 10 ? ` (+${drift.length - 10} more)` : '';
                result.errors.push({
                    operation: { action: 'fabric-precheck' },
                    code: 'PROD_CHANGED_SINCE_COMPARE',
                    error: `The Fabric model changed after this comparison was taken: ${list}${more}. ` +
                        `Deploying now would upload the older snapshot and silently revert those changes. ` +
                        `Re-run the comparison, review the differences, and deploy again.`
                });
                return result;
            }
            // Deploy on top of the CURRENT definition, never the stale snapshot.
            baseFiles = currentFiles;
            if (drift.length > 0) {
                forcedOverDrift = true;
                result.warnings = result.warnings || [];
                result.warnings.push({
                    code: 'PROD_CHANGED_SINCE_COMPARE_FORCED',
                    message: `Deploying over ${drift.length} file(s) changed since the comparison, at your request. ` +
                        `The deployment plan was re-computed against the live definition, not the stale comparison snapshot.`
                });
            }
        }

        // Create backup if requested and backupPath is provided.
        // Written from the SAME snapshot the deploy is applied to, so a restore
        // actually returns the model to the state it was in.
        if (backup && backupPath && !dryRun) {
            const modelName = prodModel.name || 'SemanticModel';
            const semanticModelFolder = `${modelName}.SemanticModel`;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const backupDestination = path.join(backupPath, `${semanticModelFolder}_backup_${timestamp}`);

            fs.mkdirSync(backupDestination, { recursive: true });
            const defDir = path.join(backupDestination, 'definition');
            fs.mkdirSync(defDir, { recursive: true });
            for (const [filePath, content] of Object.entries(baseFiles)) {
                const fullPath = path.join(defDir, filePath);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, content, 'utf-8');
            }
            result.backupPath = backupDestination;
            result.actions.push({ type: 'backup', message: `Backup created: ${backupDestination}` });
        }

        // Write the base definition to a temp directory
        fs.mkdirSync(tmpDir, { recursive: true });
        for (const [filePath, content] of Object.entries(baseFiles)) {
            const fullPath = path.join(tmpDir, filePath);
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf-8');
        }

        // Finding 4.6: a forced deploy over drift used to keep planning operations
        // against the compare-time prodModel while uploading the live files as the
        // base — target names/paths could then point at blocks that had moved or
        // no longer existed. Re-extract the model from what was actually just
        // written (the live definition) so the plan matches the upload base.
        if (forcedOverDrift) {
            effectiveProdModel = loadModelFromFolder(tmpDir);
        }

        // Run deployer against temp dir (no backup for Fabric)
        const deployResult = deployChanges(selectedDiffs, devModel, tmpDir, { dryRun, backup: false, prodModel: effectiveProdModel, allDiffs: options.allDiffs || [] });

        if (!deployResult.success) {
            return deployResult;
        }

        if (dryRun) {
            // For dry-run, just return the planned actions
            return deployResult;
        }

        // Read back modified files from temp dir
        const updatedFiles = {};
        readDirRecursive(tmpDir, tmpDir, updatedFiles);

        // Upload to Fabric
        const token = await requireFabricToken(auth);
        await fabricApi.updateSemanticModelDefinition(
            token,
            fabricInfo.workspaceId,
            fabricInfo.semanticModelId,
            updatedFiles
        );

        mergeDeployResultIntoResponse(result, deployResult);
        result.actions.push({ type: 'fabric-upload', message: 'Definition uploaded to Fabric successfully.' });

        // Determine which tables need refresh after metadata deploy.
        // The comparison is passed in, never re-read from shared state after the
        // upload await — a concurrent compare used to replace it mid-deploy and
        // affected tables were then silently omitted from the refresh plan.
        const tablesNeedingRefresh = detectTablesNeedingRefresh(selectedDiffs, options.comparison || null);
        if (tablesNeedingRefresh !== null) {
            result.tablesNeedingRefresh = tablesNeedingRefresh;
        }

        // Post-deployment runtime-state inspection (MVP): informational only.
        // A failed inspection must NOT fail the deployment or be reported as ready —
        // see requirements/TARGET_MODEL_READINESS_MVP_PLAN.md.
        result.targetReadiness = await inspectTargetReadiness(token, fabricInfo);
    } catch (err) {
        result.success = false;
        
        // Check if error is related to relationship deployment
        const relChanges = selectedDiffs.filter(d => d.objectType === 'relationship');
        const hasCardinalityChanges = selectedDiffs.some(d => 
            d.objectType === 'relationship' && d.cardinalityChange && d.cardinalityChange.requiresDataValidation
        );
        
        let errorMessage = err.message;

        // The client stopped waiting but Fabric may have finished the upload.
        // Saying "failed" would be a lie the user acts on.
        if (err.indeterminate) {
            result.indeterminate = true;
            errorMessage += '\n\n⚠️ The deployment result is UNKNOWN, not failed. ' +
                'Check the model in the Fabric portal before retrying — a retry on an already-updated model is safe, ' +
                'but do not assume nothing changed.';
        }

        // Add helpful context for relationship errors
        if (relChanges.length > 0 && (
            errorMessage.includes('missing options') ||
            errorMessage.includes('cardinality') ||
            errorMessage.includes('duplicate') ||
            errorMessage.includes('uniqueness')
        )) {
            errorMessage += '\n\n⚠️ RELATIONSHIP DEPLOYMENT FAILED\n\n';
            
            if (hasCardinalityChanges) {
                errorMessage += 'Cardinality change detected. Common causes:\n';
                errorMessage += '1. Key column contains duplicates (on the "one" side of the relationship)\n';
                errorMessage += '2. Table data does not meet cardinality requirements\n';
                errorMessage += '3. Table needs refresh before relationship change\n\n';
            }
            
            errorMessage += '📋 SOLUTION:\n';
            errorMessage += '1. Refresh data in tables participating in the relationship\n';
            errorMessage += '2. Check that key columns do not have duplicates:\n';
            
            for (const rel of relChanges) {
                if (rel.cardinalityChange) {
                    const toType = rel.cardinalityChange.to;
                    errorMessage += `   - Relationship: ${rel.displayName}\n`;
                    errorMessage += `   - Change: ${rel.cardinalityChange.from} → ${toType}\n`;
                    
                    if (toType.includes('many-to-one')) {
                        errorMessage += `   - Check: toColumn must be unique (no duplicates)\n`;
                    } else if (toType.includes('one-to-many')) {
                        errorMessage += `   - Check: fromColumn must be unique (no duplicates)\n`;
                    } else if (toType.includes('one-to-one')) {
                        errorMessage += `   - Check: both columns must be unique (no duplicates)\n`;
                    }
                }
            }
            
            errorMessage += '3. After refreshing data - retry deployment\n';
        }
        
        result.errors.push({ operation: { action: 'fabric-upload' }, error: errorMessage });
    } finally {
        // Cleanup temp dir
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    return result;
}

/**
 * Detect which tables need refresh after deploying metadata changes.
 * Returns an object with per-table refresh classification:
 * {
 *   refreshType: 'automatic'|'dataOnly'|'calculate',
 *   tables: [{ table, refreshType, reason }],
 *   isFullModel: boolean
 * }
 * Returns null if no refresh is needed.
 *
 * Rules:
 * - Parameters (IsParameterQuery) → no refresh needed
 * - Named expression (shared M query) → dataOnly for dependent tables (or all)
 * - Partition expression changed → dataOnly for that table
 * - New table added → full for that table
 * - New column with sourceColumn → dataOnly for that table
 * - Calculated column expression changed → calculate for that table
 * - Calculated table (mode: calculated) → calculate for that table
 * - Calculation item add/remove/ordinal → calculate for the CG table
 * - Parameter change → dataOnly for all dependent tables (resolved from comparison groups)
 */
function detectTablesNeedingRefresh(selectedDiffs, comparison) {
    const tableMap = new Map(); // tableName → { refreshType, reasons[] }

    // Collect tables being removed — they can't be refreshed
    const tablesBeingRemoved = new Set();
    for (const d of selectedDiffs) {
        if (d.objectType === 'table' && d.type === 1) {
            tablesBeingRemoved.add(d.displayName);
        }
    }

    function addTable(table, type, reason) {
        if (!table) return;
        if (tablesBeingRemoved.has(table)) return; // can't refresh a deleted table
        const existing = tableMap.get(table);
        if (!existing) {
            tableMap.set(table, { refreshType: type, reasons: [reason] });
        } else {
            existing.reasons.push(reason);
            // Escalate: dataOnly > calculate > full
            if (type === 'full' || existing.refreshType === 'full') {
                existing.refreshType = 'full';
            } else if (type === 'dataOnly' || existing.refreshType === 'dataOnly') {
                existing.refreshType = 'dataOnly';
            }
            // else both calculate — stays calculate
        }
    }

    let needsFullModel = false;

    // Build lookup of parameter groups from comparison (pre-computed dependency resolution)
    const paramGroupsByKey = new Map();
    if (comparison && comparison.groups) {
        for (const g of comparison.groups) {
            if (g.isParameterGroup && g.affectedTables) {
                for (const key of (g.memberKeys || [])) {
                    paramGroupsByKey.set(key, g.affectedTables);
                }
            }
        }
    }

    for (const diff of selectedDiffs) {
        const objType = diff.objectType;
        const diffType = diff.type; // 0=added, 1=removed, 2=modified

        // Named expression / parameter
        if (objType === 'expression') {
            // Check if this is a parameter or a shared query
            const exprValue = getExpressionValue(diff);
            if (isParameterExpression(exprValue)) {
                // Parameter changed → refresh dependent tables.
                // dataOnly is sufficient when gateway/credentials are properly
                // configured for the new parameter value.
                const affectedTables = paramGroupsByKey.get(diff.identityKey);
                if (affectedTables && affectedTables.length > 0) {
                    for (const tbl of affectedTables) {
                        addTable(tbl, 'dataOnly', `parameter '${diff.displayName}' changed`);
                    }
                }
                continue;
            }
            // Shared M query changed → all tables using it need data refresh
            // We can't easily resolve dependencies, so mark as full-model dataOnly
            needsFullModel = true;
            continue;
        }

        // Partition expression changed → check if calculated table or data table
        if (objType === 'partition') {
            if (diffType === 1) continue; // partition removed → no refresh needed
            const mode = getPartitionMode(diff);
            if (mode === 'calculated') {
                addTable(diff.parentTable, 'calculate', 'calculated table expression changed');
            } else {
                addTable(diff.parentTable, 'dataOnly', 'partition expression changed');
            }
        }

        // New table added → needs full refresh
        else if (objType === 'table' && diffType === 0) {
            addTable(diff.displayName, 'full', 'new table added');
        }

        // New column added (has sourceColumn) → table needs data refresh
        else if (objType === 'column' && diffType === 0) {
            const hasSourceCol = (diff.propertyDiffs || []).some(p => p.propertyName === 'sourceColumn' && p.devValue);
            const hasExpression = (diff.propertyDiffs || []).some(p => p.propertyName === 'expression' && p.devValue);
            if (hasExpression) {
                addTable(diff.parentTable, 'calculate', 'new calculated column');
            } else if (hasSourceCol) {
                addTable(diff.parentTable, 'dataOnly', 'new column with sourceColumn');
            }
        }

        // Column expression change (calculated column)
        else if (objType === 'column' && diffType === 2) {
            const hasExpr = (diff.propertyDiffs || []).some(p => p.propertyName === 'expression');
            if (hasExpr) {
                addTable(diff.parentTable, 'calculate', 'calculated column expression changed');
            }
        }

        // Calculation item added/removed → recalculate the CG table
        else if (objType === 'calculationItem' && (diffType === 0 || diffType === 1)) {
            addTable(diff.parentTable, 'calculate', `calculationItem ${diffType === 0 ? 'added' : 'removed'}`);
        }

        // Calculation item modified → only if ordinal changed
        else if (objType === 'calculationItem' && diffType === 2) {
            const hasOrdinalChange = (diff.propertyDiffs || []).some(p => p.propertyName === 'ordinal');
            if (hasOrdinalChange) {
                addTable(diff.parentTable, 'calculate', 'calculationItem ordinal changed');
            }
        }

        // Calculation group precedence changed
        else if (objType === 'calculationGroup' && diffType === 2) {
            const hasPrecedenceChange = (diff.propertyDiffs || []).some(p => p.propertyName === 'precedence');
            if (hasPrecedenceChange) {
                addTable(diff.parentTable, 'calculate', 'calculationGroup precedence changed');
            }
        }
    }

    if (tableMap.size === 0 && !needsFullModel) {
        return null; // no refresh needed
    }

    // Build tables array
    const tables = [];
    for (const [name, info] of tableMap) {
        tables.push({ table: name, refreshType: info.refreshType, reasons: info.reasons });
    }

    // Determine overall API refresh type
    let overallType = 'calculate';
    if (needsFullModel) {
        overallType = 'automatic';
    } else {
        const types = new Set(tables.map(t => t.refreshType));
        if (types.has('full')) overallType = 'automatic';
        else if (types.has('dataOnly') && types.has('calculate')) overallType = 'automatic';
        else if (types.has('dataOnly')) overallType = 'dataOnly';
        // else all calculate → 'calculate'
    }

    return {
        refreshType: overallType,
        tables,
        isFullModel: needsFullModel
    };
}

/** Extract expression value from a diff object */
function getExpressionValue(diff) {
    const exprProp = (diff.propertyDiffs || []).find(p => p.propertyName === 'expression');
    if (exprProp) return exprProp.devValue || exprProp.prodValue || '';
    // Fallback: check rawBlock
    return diff.rawBlock || '';
}

/** Check if an expression value is a Power Query parameter */
function isParameterExpression(exprValue) {
    return /IsParameterQuery\s*=\s*true/i.test(exprValue);
}

/** Get partition mode from diff's propertyDiffs */
function getPartitionMode(diff) {
    const modeProp = (diff.propertyDiffs || []).find(p => p.propertyName === 'mode');
    if (modeProp) return (modeProp.devValue || modeProp.prodValue || 'import').toLowerCase();
    return 'import';
}

/**
 * Recursively read all files in a directory into a { relativePath: content } dict.
 */
function readDirRecursive(baseDir, currentDir, result) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
            readDirRecursive(baseDir, fullPath, result);
        } else {
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            result[relPath] = fs.readFileSync(fullPath, 'utf-8');
        }
    }
}

module.exports = {
    requireFabricToken,
    fetchFabricRawFiles,
    inspectTargetReadiness,
    deployToFabric,
    detectTablesNeedingRefresh
};
