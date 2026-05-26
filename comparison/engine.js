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
                modelName: devObj.modelName,
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
                modelName: prodObj.modelName,
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
                modelName: devObj.modelName,
                changeGroup: devObj.changeGroup,
                parentTable: devObj.parentTable || null,
                sourceFile: devObj.sourceFile,
                rawBlock: devObj.rawBlock,
                // For relationships: real TMDL name (GUID) in target — used by deployer
                // to locate the existing block during replace/remove (DEV's GUID differs).
                targetRelName: prodObj.relName,
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

    // Find named expressions/parameters that changed and map them to tables via ALL partitions
    const namedExprDiffs = diffs.filter(d => d.objectType === 'expression');
    // Separate parameters from non-parameter expressions (parameters are in 'Data Sources & Parameters' group)
    const parameterDiffs = namedExprDiffs.filter(d => d.changeGroup === CHANGE_GROUPS.DATA_SOURCES);
    const nonParamExprDiffs = namedExprDiffs.filter(d => d.changeGroup !== CHANGE_GROUPS.DATA_SOURCES);

    // Build complete partition map from devObjects (includes unchanged partitions)
    const allPartitions = Object.values(devObjects).filter(o => o.objectType === 'partition');
    // Build complete expressions map (all expressions in DEV model, not just changed ones)
    const allExpressions = Object.values(devObjects).filter(o => o.objectType === 'expression');

    // Word-boundary aware identifier match. Power Query identifiers are letters,
    // digits and underscores; the M language also allows quoted identifiers via
    // `#"..."`. Using a plain `String.includes` produces false positives when one
    // identifier is a substring of another (e.g. `silver_SP2_Dim_MRA` matches
    // `silver_SP2_Dim_MRAFI`). We enforce that the matched name is not preceded
    // or followed by another identifier character.
    const IDENT_CHAR = /[A-Za-z0-9_]/;
    function containsIdentifier(body, name) {
        if (!body || !name) return false;
        let from = 0;
        while (true) {
            const idx = body.indexOf(name, from);
            if (idx < 0) return false;
            const prev = idx === 0 ? '' : body.charAt(idx - 1);
            const next = idx + name.length >= body.length ? '' : body.charAt(idx + name.length);
            if (!IDENT_CHAR.test(prev) && !IDENT_CHAR.test(next)) return true;
            from = idx + 1;
        }
    }

    // Resolve transitive dependencies: param → expression → ... → partition
    // For each changed expression, find all expressions that (transitively) depend on it
    function findDependentExprNames(changedName) {
        const dependents = new Set();
        const queue = [changedName];
        while (queue.length > 0) {
            const name = queue.shift();
            for (const expr of allExpressions) {
                if (dependents.has(expr.displayName)) continue;
                if (expr.displayName === name) continue;
                const body = expr.properties.expression || '';
                if (containsIdentifier(body, name)) {
                    dependents.add(expr.displayName);
                    queue.push(expr.displayName);
                }
            }
        }
        return dependents;
    }

    // Find tables affected by a set of expression names (direct or via partitions)
    function findAffectedTables(exprNames) {
        const tables = new Set();
        for (const part of allPartitions) {
            const partExpr = part.properties.expression || part.properties.type || '';
            for (const depName of exprNames) {
                if (containsIdentifier(partExpr, depName)) {
                    tables.add(part.parentTable);
                    break;
                }
            }
        }
        return tables;
    }

    // Process NON-parameter expressions → add to table refresh groups
    for (const exprDiff of nonParamExprDiffs) {
        const exprName = exprDiff.displayName;
        const allDependentNames = findDependentExprNames(exprName);
        allDependentNames.add(exprName);

        const referencingTables = findAffectedTables(allDependentNames);

        if (referencingTables.size > 0) {
            for (const tbl of referencingTables) {
                if (!refreshTables.has(tbl)) {
                    refreshTables.set(tbl, new Set());
                }
                refreshTables.get(tbl).add(exprDiff.identityKey);
            }
        }
    }

    // Process PARAMETERS → create separate parameter groups (not merged with table groups)
    const parameterGroups = [];
    for (const paramDiff of parameterDiffs) {
        const paramName = paramDiff.displayName;
        const allDependentNames = findDependentExprNames(paramName);
        allDependentNames.add(paramName);

        const affectedTables = findAffectedTables(allDependentNames);
        const tableCount = affectedTables.size;

        if (tableCount > 0) {
            parameterGroups.push({
                groupId: `param-refresh:${paramName}`,
                label: `Parameter '${paramName}' affecting ${tableCount} ${tableCount === 1 ? 'table' : 'tables'}`,
                reason: `Parameter change requires refresh of dependent tables: ${[...affectedTables].join(', ')}`,
                memberKeys: [paramDiff.identityKey],
                affectedTables: [...affectedTables],
                requiresRefresh: true,
                isParameterGroup: true
            });
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

    // Calculation Groups: added/removed items or ordinal changes require refresh of CG table
    const calcItemDiffs = diffs.filter(d => d.objectType === 'calculationItem');
    const cgTablesNeedingRefresh = new Set();

    for (const ciDiff of calcItemDiffs) {
        const tableName = ciDiff.parentTable;
        if (!tableName) continue;
        // Added or removed calc item → refresh needed
        if (ciDiff.type === 0 || ciDiff.type === 1) {
            cgTablesNeedingRefresh.add(tableName);
        }
        // Modified calc item → only if ordinal changed
        if (ciDiff.type === 2) {
            const hasOrdinalChange = (ciDiff.propertyDiffs || []).some(p => p.propertyName === 'ordinal');
            if (hasOrdinalChange) cgTablesNeedingRefresh.add(tableName);
        }
    }

    // Also check calculationGroup-level changes (e.g. precedence)
    const calcGroupDiffs = diffs.filter(d => d.objectType === 'calculationGroup' && d.type === 2);
    for (const cgDiff of calcGroupDiffs) {
        const hasPrecedenceChange = (cgDiff.propertyDiffs || []).some(p => p.propertyName === 'precedence');
        if (hasPrecedenceChange && cgDiff.parentTable) {
            cgTablesNeedingRefresh.add(cgDiff.parentTable);
        }
    }

    for (const tableName of cgTablesNeedingRefresh) {
        // Skip if already in a refresh group from partition logic
        if (refreshTables.has(tableName)) continue;

        const tableDiffs = diffs.filter(d => d.parentTable === tableName);
        const tableObjDiff = diffs.find(d => d.objectType === 'table' && d.displayName === tableName);

        const memberKeys = new Set();
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
                reason: 'Calculation group structural change (added/removed items or ordinal) requires refresh',
                memberKeys: [...memberKeys],
                requiresRefresh: true
            });
        }
    }

    // Column/Table deletions: group with dependent relationship deletions.
    // When a column is removed and a relationship using that column is also removed,
    // they should be in the same atomic group (selected/deselected together).
    const removedColumns = diffs.filter(d => d.type === 1 && d.objectType === 'column');
    const removedTables = diffs.filter(d => d.type === 1 && d.objectType === 'table');
    const removedRelationships = diffs.filter(d => d.type === 1 && d.objectType === 'relationship');

    if (removedRelationships.length > 0 && (removedColumns.length > 0 || removedTables.length > 0)) {
        // Build lookup: column name (Table.Column) → set of relationship identityKeys
        const colToRelKeys = new Map();
        for (const rel of removedRelationships) {
            const fromCol = (rel.propertyDiffs || []).find(p => p.propertyName === 'fromColumn');
            const toCol = (rel.propertyDiffs || []).find(p => p.propertyName === 'toColumn');
            const fromName = (fromCol && (fromCol.prodValue || fromCol.devValue) || '').replace(/'/g, '');
            const toName = (toCol && (toCol.prodValue || toCol.devValue) || '').replace(/'/g, '');
            if (fromName) {
                if (!colToRelKeys.has(fromName)) colToRelKeys.set(fromName, new Set());
                colToRelKeys.get(fromName).add(rel.identityKey);
            }
            if (toName) {
                if (!colToRelKeys.has(toName)) colToRelKeys.set(toName, new Set());
                colToRelKeys.get(toName).add(rel.identityKey);
            }
        }

        // Group: column deletion + its dependent relationship deletions
        const assignedRelKeys = new Set();
        for (const colDiff of removedColumns) {
            const colName = colDiff.displayName; // "Table.Column"
            const relKeys = colToRelKeys.get(colName);
            if (!relKeys || relKeys.size === 0) continue;

            const memberKeys = new Set([colDiff.identityKey]);
            for (const rk of relKeys) {
                memberKeys.add(rk);
                assignedRelKeys.add(rk);
            }
            // Also include parent table deletion if present
            const tableDiff = removedTables.find(t => t.displayName === colDiff.parentTable);
            if (tableDiff) memberKeys.add(tableDiff.identityKey);

            // Check if column is already in a group
            const existingGroup = groups.find(g => g.memberKeys.includes(colDiff.identityKey));
            if (existingGroup) {
                // Merge relationship keys into existing group
                for (const rk of relKeys) {
                    if (!existingGroup.memberKeys.includes(rk)) {
                        existingGroup.memberKeys.push(rk);
                    }
                }
            } else {
                groups.push({
                    groupId: `cascade:${colDiff.parentTable}`,
                    label: `${colDiff.parentTable} (removal)`,
                    reason: 'Column removal with dependent relationships — must be deployed together',
                    memberKeys: [...memberKeys],
                    requiresRefresh: false
                });
            }
        }

        // Table deletions: any remaining relationships referencing this table
        for (const tblDiff of removedTables) {
            const tblName = tblDiff.displayName;
            const relKeys = new Set();
            for (const [colName, rks] of colToRelKeys) {
                if (colName.startsWith(tblName + '.')) {
                    for (const rk of rks) {
                        if (!assignedRelKeys.has(rk)) relKeys.add(rk);
                    }
                }
            }
            if (relKeys.size === 0) continue;
            const existingGroup = groups.find(g => g.memberKeys.includes(tblDiff.identityKey));
            if (existingGroup) {
                for (const rk of relKeys) {
                    if (!existingGroup.memberKeys.includes(rk)) {
                        existingGroup.memberKeys.push(rk);
                    }
                }
            } else {
                const memberKeys = new Set([tblDiff.identityKey, ...relKeys]);
                // Also add child columns/partitions of this table
                const childDiffs = diffs.filter(d => d.type === 1 && d.parentTable === tblName);
                for (const cd of childDiffs) memberKeys.add(cd.identityKey);
                groups.push({
                    groupId: `cascade:${tblName}`,
                    label: `${tblName} (removal)`,
                    reason: 'Table removal with dependent relationships — must be deployed together',
                    memberKeys: [...memberKeys],
                    requiresRefresh: false
                });
            }
        }
    }

    // Sort groups alphabetically by label
    groups.sort((a, b) => a.label.localeCompare(b.label));

    // Merge groups that share named expression members (expression referenced by multiple tables)
    // Only merge non-parameter groups
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < groups.length; i++) {
            if (groups[i].isParameterGroup) continue;
            for (let j = i + 1; j < groups.length; j++) {
                if (groups[j].isParameterGroup) continue;
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

    // Add parameter groups at the beginning
    groups.unshift(...parameterGroups.sort((a, b) => a.label.localeCompare(b.label)));

    return groups;
}

module.exports = { compareModels };
