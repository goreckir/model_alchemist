/**
 * Comparison Engine v2 — Core algorithm (F3 from spec).
 * Enhanced: each diff carries sourceFile and rawBlock info for deployment.
 */

const { extractAll, CHANGE_GROUPS } = require('./extractor');

function compareModels(devModel, prodModel, devPath, prodPath) {
    const devObjects = extractAll(devModel);
    const prodObjects = extractAll(prodModel);

    const diffs = [];

    // Added: in DEV but not in PROD
    for (const [key, devObj] of Object.entries(devObjects)) {
        if (!prodObjects[key]) {
            diffs.push({
                type: 0,
                objectType: devObj.objectType,
                identityKey: key,
                displayName: devObj.displayName,
                changeGroup: devObj.changeGroup,
                parentTable: devObj.parentTable || null,
                sourceFile: devObj.sourceFile,
                rawBlock: devObj.rawBlock,
                propertyDiffs: Object.entries(devObj.properties).map(([name, value]) => ({
                    propertyName: name,
                    devValue: value,
                    prodValue: null
                }))
            });
        }
    }

    // Removed: in PROD but not in DEV
    for (const [key, prodObj] of Object.entries(prodObjects)) {
        if (!devObjects[key]) {
            diffs.push({
                type: 1,
                objectType: prodObj.objectType,
                identityKey: key,
                displayName: prodObj.displayName,
                changeGroup: prodObj.changeGroup,
                parentTable: prodObj.parentTable || null,
                sourceFile: prodObj.sourceFile,
                rawBlock: prodObj.rawBlock,
                propertyDiffs: Object.entries(prodObj.properties).map(([name, value]) => ({
                    propertyName: name,
                    devValue: null,
                    prodValue: value
                }))
            });
        }
    }

    // Modified: in both but different
    for (const [key, devObj] of Object.entries(devObjects)) {
        const prodObj = prodObjects[key];
        if (!prodObj) continue;

        const propertyDiffs = computePropertyDiffs(devObj.properties, prodObj.properties);
        if (propertyDiffs.length > 0) {
            diffs.push({
                type: 2,
                objectType: devObj.objectType,
                identityKey: key,
                displayName: devObj.displayName,
                changeGroup: devObj.changeGroup,
                parentTable: devObj.parentTable || null,
                sourceFile: devObj.sourceFile,
                rawBlock: devObj.rawBlock,
                propertyDiffs
            });
        }
    }

    const summary = {};
    for (const group of Object.values(CHANGE_GROUPS)) {
        summary[group] = 0;
    }
    for (const diff of diffs) {
        summary[diff.changeGroup] = (summary[diff.changeGroup] || 0) + 1;
    }

    return {
        devModelName: devModel.name || 'DEV Model',
        prodModelName: prodModel.name || 'PROD Model',
        devSource: devPath,
        prodSource: prodPath,
        timestamp: new Date().toISOString(),
        diffs,
        groups: computeGroups(diffs, devObjects),
        summary
    };
}

function computePropertyDiffs(devProps, prodProps) {
    const diffs = [];
    const allKeys = new Set([...Object.keys(devProps), ...Object.keys(prodProps)]);

    for (const key of allKeys) {
        const devVal = normalizeValue(devProps[key]);
        const prodVal = normalizeValue(prodProps[key]);
        if (devVal !== prodVal) {
            diffs.push({
                propertyName: key,
                devValue: devProps[key] ?? null,
                prodValue: prodProps[key] ?? null
            });
        }
    }
    return diffs;
}

function normalizeValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

/**
 * Compute atomic groups for diffs that must be deployed together.
 * Rule: If a partition expression changed, group it with all sourceColumn-based
 * column changes (add/remove/structural modify) in that table.
 * Metadata-only column changes (isHidden, formatString, etc.) stay independent.
 */
function computeGroups(diffs, devObjects) {
    const groups = [];

    // Find all partition diffs (added, removed, or modified)
    const partitionDiffs = diffs.filter(d => d.objectType === 'partition');

    // Track which tables need refresh (table name → set of member keys)
    const refreshTables = new Map();

    for (const partDiff of partitionDiffs) {
        const tableName = partDiff.parentTable;
        if (!tableName) continue;

        // Check if partition expression actually changed (not just mode)
        if (partDiff.type === 2) {
            const hasExprChange = (partDiff.propertyDiffs || []).some(p => p.propertyName === 'expression');
            if (!hasExprChange) continue;
        }

        if (!refreshTables.has(tableName)) {
            refreshTables.set(tableName, new Set());
        }
    }

    // Find named expressions that changed and map them to tables via ALL partitions (not just changed)
    const namedExprDiffs = diffs.filter(d => d.changeGroup === 'Named Expressions');
    // Build complete partition map from devObjects (includes unchanged partitions)
    const allPartitions = Object.values(devObjects).filter(o => o.objectType === 'partition');

    for (const exprDiff of namedExprDiffs) {
        const exprName = exprDiff.displayName;
        // Find tables whose partitions reference this expression name
        const referencingTables = new Set();
        for (const part of allPartitions) {
            const partExpr = part.properties.expression || part.properties.type || '';
            if (partExpr.includes(exprName)) {
                referencingTables.add(part.parentTable);
            }
        }

        if (referencingTables.size > 0) {
            for (const tbl of referencingTables) {
                if (!refreshTables.has(tbl)) {
                    refreshTables.set(tbl, new Set());
                }
                refreshTables.get(tbl).add(exprDiff.identityKey);
            }
        }
    }

    // For each table needing refresh, gather ALL diffs for that table
    for (const [tableName, extraKeys] of refreshTables) {
        const tableDiffs = diffs.filter(d => d.parentTable === tableName);
        const tableObjDiff = diffs.find(d => d.objectType === 'table' && d.displayName === tableName);

        const memberKeys = new Set(extraKeys);
        for (const d of tableDiffs) {
            memberKeys.add(d.identityKey);
        }
        if (tableObjDiff) {
            memberKeys.add(tableObjDiff.identityKey);
        }

        if (memberKeys.size > 0) {
            groups.push({
                groupId: `refresh:${tableName}`,
                label: tableName,
                reason: 'Power Query expression change requires atomic deployment with dependent columns',
                memberKeys: [...memberKeys],
                requiresRefresh: true
            });
        }
    }

    // Merge groups that share named expression members (expression referenced by multiple tables)
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                // Check if they share any named expression key
                const sharedExpr = groups[i].memberKeys.some(k =>
                    k.startsWith('expression:') && groups[j].memberKeys.includes(k)
                );
                if (sharedExpr) {
                    // Merge j into i
                    const mergedKeys = new Set([...groups[i].memberKeys, ...groups[j].memberKeys]);
                    const labels = [...new Set([...groups[i].label.split(', '), ...groups[j].label.split(', ')])];
                    groups[i].memberKeys = [...mergedKeys];
                    groups[i].label = labels.join(', ');
                    groups[i].groupId = `refresh:${labels.join('+')}`;
                    groups.splice(j, 1);
                    merged = true;
                    break;
                }
            }
            if (merged) break;
        }
    }

    return groups;
}

module.exports = { compareModels };
