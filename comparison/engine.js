/**
 * Comparison Engine v2 — Core algorithm (F3 from spec).
 * Enhanced: 
 * - Each diff carries sourceFile and rawBlock info for deployment.
 * - Detects relationship cardinality changes and flags them for data validation warnings.
 */

const { extractAll, CHANGE_GROUPS } = require('./extractor');
const { tableFromColRef, colFromRef } = require('./refs');
const { detectRenames } = require('./rename-detector');

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
                parentRole: devObj.parentRole || null,
                objectName: devObj.objectName,
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
                parentRole: prodObj.parentRole || null,
                objectName: prodObj.objectName,
                // Real name in the TARGET file (partition GUID suffix, relationship
                // GUID): the deployer locates the block to delete with this, never
                // by re-deriving a name from displayName.
                targetObjectName: prodObj.realName || prodObj.objectName,
                sourceFile: prodObj.sourceFile,
                targetFile: prodObj.sourceFile,
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
            const diff = {
                type: 2,
                objectType: devObj.objectType,
                identityKey: key,
                displayName: devObj.displayName,
                modelName: devObj.modelName,
                changeGroup: devObj.changeGroup,
                parentTable: devObj.parentTable || null,
                parentRole: devObj.parentRole || null,
                objectName: devObj.objectName,
                sourceFile: devObj.sourceFile,
                targetFile: prodObj.sourceFile,
                rawBlock: devObj.rawBlock,
                // For relationships: real TMDL name (GUID) in target — used by deployer
                // to locate the existing block during replace/remove (DEV's GUID differs).
                targetRelName: prodObj.relName,
                // Same idea generalised: the target's real name for any object whose
                // TMDL name differs from its logical name (partition GUID suffixes).
                targetObjectName: prodObj.realName || prodObj.objectName,
                propertyDiffs
            };

            // Detect cardinality changes in relationships
            if (devObj.objectType === 'relationship') {
                const devFromCard = devObj.properties.fromCardinality || 'many';
                const devToCard = devObj.properties.toCardinality || 'one';
                const prodFromCard = prodObj.properties.fromCardinality || 'many';
                const prodToCard = prodObj.properties.toCardinality || 'one';
                
                const devType = `${devFromCard}-to-${devToCard}`;
                const prodType = `${prodFromCard}-to-${prodToCard}`;
                
                if (devType !== prodType) {
                    diff.cardinalityChange = {
                        from: prodType,
                        to: devType,
                        requiresDataValidation: devToCard === 'one' || devFromCard === 'one'
                    };
                }
            }

            diffs.push(diff);
        }
    }

    // Pair up Add/Remove diffs that are really one rename, so the user sees a
    // correlated change with a data-loss warning instead of dozens of unrelated
    // Add and Remove entries.
    const renames = detectRenames(diffs, devObjects, prodObjects);

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
        renames,
        groups: computeGroups(diffs, devObjects, renames),
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
 *
 * Rule: if a partition expression changed, group it with the STRUCTURAL changes
 * of that table (column add/remove, column expression/sourceColumn/dataType
 * changes, other partitions, the table object itself). Metadata-only changes
 * (formatString, isHidden, displayFolder, description, annotations) stay
 * independent — they deploy on their own and must not drag an unrelated fix into
 * an atomic group, which used to raise a false "incomplete atomic group" warning.
 *
 * Groups are made DISJOINT at the end: a diff that qualified for two groups was
 * rendered twice in the UI with independent checkboxes that fell out of sync.
 */

/** Structural properties whose change alters the shape or the data of a table. */
const STRUCTURAL_PROPERTIES = new Set(['expression', 'sourceColumn', 'dataType', 'type', 'mode', 'source']);

function isStructuralDiff(diff) {
    switch (diff.objectType) {
        case 'table':
            return diff.type === 0 || diff.type === 1;
        case 'partition':
            return true;
        case 'column':
            if (diff.type === 0 || diff.type === 1) return true;
            return (diff.propertyDiffs || []).some(p => STRUCTURAL_PROPERTIES.has(p.propertyName));
        case 'calculationItem':
            if (diff.type === 0 || diff.type === 1) return true;
            return (diff.propertyDiffs || []).some(p => p.propertyName === 'ordinal');
        case 'calculationGroup':
            return (diff.propertyDiffs || []).some(p => p.propertyName === 'precedence');
        default:
            return false;
    }
}

function computeGroups(diffs, devObjects, renames = []) {
    const groups = [];

    // Indexes built once. The previous per-group `diffs.filter(...)` scans made
    // both compare and every UI re-render quadratic in the number of diffs.
    const diffsByTable = new Map();
    const tableDiffByName = new Map();
    for (const diff of diffs) {
        if (diff.parentTable) {
            if (!diffsByTable.has(diff.parentTable)) diffsByTable.set(diff.parentTable, []);
            diffsByTable.get(diff.parentTable).push(diff);
        }
        if (diff.objectType === 'table') tableDiffByName.set(diff.displayName, diff);
    }
    const structuralDiffsOf = tableName => (diffsByTable.get(tableName) || []).filter(isStructuralDiff);

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

    // For each table needing refresh, gather its STRUCTURAL diffs (see header).
    for (const [tableName, extraKeys] of refreshTables) {
        const memberKeys = new Set(extraKeys);
        for (const d of structuralDiffsOf(tableName)) {
            memberKeys.add(d.identityKey);
        }
        const tableObjDiff = tableDiffByName.get(tableName);
        if (tableObjDiff && isStructuralDiff(tableObjDiff)) {
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

        const memberKeys = new Set();
        for (const d of structuralDiffsOf(tableName)) {
            memberKeys.add(d.identityKey);
        }
        const tableObjDiff = tableDiffByName.get(tableName);
        if (tableObjDiff && isStructuralDiff(tableObjDiff)) {
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

    // ── Relationship changes ────────────────────────────────────────────────────────────
    // For every relationship diff (added / removed / modified):
    //  1. Group it atomically with any column diffs whose columns are the key endpoints
    //     (fromColumn / toColumn) — e.g. when a table key column is renamed and the
    //     relationship is rewired accordingly.
    //  2. Set requiresRefresh: true on the endpoint tables — the AS engine must
    //     recalculate after any structural relationship change.
    //
    // Endpoint refs are parsed with the shared TMDL ref parser: keeping the quotes
    // meant a relationship on `Sales.'Order Date'` never matched its column diff,
    // so the column could be left behind and the deployed model was broken.

    const allRelDiffs  = diffs.filter(d => d.objectType === 'relationship');
    const allColDiffs  = diffs.filter(d => d.objectType === 'column');
    const allTblDiffs  = diffs.filter(d => d.objectType === 'table');
    // Tables being fully removed in this diff set → don't need refresh after removal
    const removedTblNames = new Set(allTblDiffs.filter(t => t.type === 1).map(t => t.displayName));

    const assignedRelKeys = new Set();

    for (const relDiff of allRelDiffs) {
        if (assignedRelKeys.has(relDiff.identityKey)) continue;

        // ── Extract fromColumn / toColumn reference strings ──────────────────────────
        let fromRef, toRef;
        if (relDiff.type === 2) {
            // Modified: from/to columns are the composite identity key → read from displayName
            [fromRef, toRef] = relDiff.displayName.split(' → ');
        } else {
            const valProp = relDiff.type === 0 ? 'devValue' : 'prodValue';
            const fp = (relDiff.propertyDiffs || []).find(p => p.propertyName === 'fromColumn');
            const tp = (relDiff.propertyDiffs || []).find(p => p.propertyName === 'toColumn');
            fromRef = fp ? fp[valProp] : null;
            toRef   = tp ? tp[valProp] : null;
            // Fallback: parse from displayName
            if (!fromRef && !toRef) [fromRef, toRef] = relDiff.displayName.split(' → ');
        }

        const fromTable = tableFromColRef(fromRef);
        const toTable   = tableFromColRef(toRef);
        const fromCol   = colFromRef(fromRef);
        const toCol     = colFromRef(toRef);

        // ── Collect atomic members ───────────────────────────────────────────────────
        const memberKeys = new Set([relDiff.identityKey]);

        // Key column diffs on the endpoint columns (any change type: added / removed / modified)
        for (const cd of allColDiffs) {
            if (fromTable && cd.parentTable === fromTable && cd.objectName === fromCol) {
                memberKeys.add(cd.identityKey);
            }
            if (toTable && cd.parentTable === toTable && cd.objectName === toCol) {
                memberKeys.add(cd.identityKey);
            }
        }

        // For removed / added rels: include parent table diff + full child cascade if table changes too
        for (const tblName of [fromTable, toTable]) {
            if (!tblName) continue;
            const tblDiff = allTblDiffs.find(t => t.displayName === tblName && t.type === relDiff.type);
            if (!tblDiff) continue;
            memberKeys.add(tblDiff.identityKey);
            if (relDiff.type === 1) {
                // Table removal: pull all child diffs (columns, partitions, measures …)
                for (const cd of (diffsByTable.get(tblName) || [])) {
                    if (cd.type === 1) memberKeys.add(cd.identityKey);
                }
            }
        }

        assignedRelKeys.add(relDiff.identityKey);

        // ── Refresh: only removed relationships need cascade awareness.
        // Added/modified relationships are pure metadata changes — Fabric AS processes
        // them via updateDefinition without requiring a separate data refresh.
        // (The "requires refresh" badge would mislead users into thinking Report_Volume
        //  or other endpoint tables need a data reload when they don't.)
        const isRemoval = relDiff.type === 1;
        const affectedTables = isRemoval
            ? [fromTable, toTable].filter(t => t && !removedTblNames.has(t))
            : [];
        const needsRefresh = isRemoval && affectedTables.length > 0;

        const relTypeLabel = relDiff.type === 0 ? 'added' : relDiff.type === 1 ? 'removed' : 'modified';
        const label  = `${fromRef || '?'} → ${toRef || '?'} (rel. ${relTypeLabel})`;
        const reason = relDiff.type === 1
            ? 'Relationship removal — must be deployed atomically with cascade column/table changes'
            : 'Relationship change — deploy table/partition changes on endpoint tables first if pending';

        // ── Merge into an existing group if any member is already grouped ────────────
        const existingGroup = groups.find(g => [...memberKeys].some(k => g.memberKeys.includes(k)));
        if (existingGroup) {
            for (const k of memberKeys) {
                if (!existingGroup.memberKeys.includes(k)) existingGroup.memberKeys.push(k);
            }
            if (needsRefresh) {
                existingGroup.requiresRefresh = true;
                if (!existingGroup.affectedTables) existingGroup.affectedTables = [];
                for (const t of affectedTables) {
                    if (!existingGroup.affectedTables.includes(t)) existingGroup.affectedTables.push(t);
                }
            }
        } else {
            groups.push({
                groupId: `rel:${relDiff.identityKey}`,
                label,
                reason,
                memberKeys: [...memberKeys],
                affectedTables,
                requiresRefresh: needsRefresh
            });
        }
    }

    // ── Renames ──────────────────────────────────────────────────────────────────
    // A rename arrives as an Add + a Remove. Bind them (and everything they drag
    // along) into one group carrying the data-loss warning, so the pair cannot be
    // deployed half-way and the consequence is stated up front.
    for (const rename of renames) {
        groups.push({
            groupId: `rename:${rename.removedKey}->${rename.addedKey}`,
            label: `${rename.fromName} → ${rename.toName} (renamed ${rename.objectType})`,
            reason: rename.objectType === 'table'
                ? `Rename detected. Deploying this drops '${rename.fromName}' and creates '${rename.toName}': all partition data is discarded and the new table needs a full refresh. Deploy the whole group or none of it.`
                : `Rename detected: '${rename.fromName}' becomes '${rename.toName}'. Deploy the whole group or none of it.`,
            memberKeys: [...rename.memberKeys],
            affectedTables: rename.affectedTables,
            requiresRefresh: rename.objectType === 'table',
            isRename: true,
            rename: { from: rename.fromName, to: rename.toName, objectType: rename.objectType }
        });
    }

    // Sort groups alphabetically by label
    groups.sort((a, b) => a.label.localeCompare(b.label));

    // Merge overlapping groups until every diff belongs to at most ONE group.
    // Before this, a diff shared by two groups (e.g. an M expression used by two
    // tables) rendered twice with checkboxes that toggled independently, so the
    // deployed set could differ from what the screen showed.
    mergeOverlappingGroups(groups);

    // Add parameter groups at the beginning
    groups.unshift(...parameterGroups.sort((a, b) => a.label.localeCompare(b.label)));

    return groups;
}

/** Union-merge every pair of groups that share a member key. Mutates `groups`. */
function mergeOverlappingGroups(groups) {
    let merged = true;
    while (merged) {
        merged = false;
        for (let i = 0; i < groups.length && !merged; i++) {
            if (groups[i].isParameterGroup) continue;
            const keysI = new Set(groups[i].memberKeys);
            for (let j = i + 1; j < groups.length; j++) {
                if (groups[j].isParameterGroup) continue;
                if (!groups[j].memberKeys.some(k => keysI.has(k))) continue;

                const target = groups[i];
                const source = groups[j];
                target.memberKeys = [...new Set([...target.memberKeys, ...source.memberKeys])];
                const labels = [...new Set([...target.label.split(', '), ...source.label.split(', ')])];
                target.label = labels.join(', ');
                target.groupId = `merged:${labels.join('+')}`;
                target.requiresRefresh = target.requiresRefresh || source.requiresRefresh;
                target.isRename = target.isRename || source.isRename;
                target.rename = target.rename || source.rename;
                if (source.affectedTables && source.affectedTables.length > 0) {
                    target.affectedTables = [...new Set([...(target.affectedTables || []), ...source.affectedTables])];
                }
                if (source.reason && target.reason !== source.reason && !target.reason.includes(source.reason)) {
                    target.reason = `${target.reason} | ${source.reason}`;
                }
                groups.splice(j, 1);
                merged = true;
                break;
            }
        }
    }
}

module.exports = { compareModels, computeGroups, isStructuralDiff };
