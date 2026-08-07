/**
 * Deployment Dependency Validator
 *
 * Validates that a selected set of diffs is internally consistent w.r.t. the target model.
 * Returns warnings (non-blocking) and errors (recommended to block, but caller decides).
 *
 * Checks:
 *  - Adding column requires parent table to exist (in target or also being added).
 *  - Adding relationship requires both endpoint columns to exist after deploy.
 *  - Removing a table that is referenced by relationships not also being removed.
 *  - Removing a column referenced by any relationship not also being removed.
 *  - Adding a measure: best-effort scan of DAX for table/column refs (warning only).
 */

const { extractAll } = require('../comparison/extractor');
const { rootKey, childKey } = require('../comparison/keys');
const { parseColumnRef, unquote } = require('../comparison/refs');

// Minimum compatibility level required for specific TMDL features.
const COMPAT_LEVEL_REQUIREMENTS = {
    function: 1702, // UDF (User Defined Functions) require TOM compatibility level >= 1702
};

/**
 * Parse compatibilityLevel from a model's database.tmdl content.
 * Returns null if not found / not parseable.
 */
function getCompatibilityLevel(model) {
    if (!model || !model.rawFiles) return null;
    const content = model.rawFiles['database.tmdl'] || model.rawFiles['database'];
    if (!content) return null;
    const m = content.match(/compatibilityLevel:\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {Array} selectedDiffs
 * @param {object} devModel
 * @param {object} prodModel
 * @param {Array} [allDiffs=[]] - Full diff list from last comparison (for pre-deploy order warnings).
 * @returns {{ warnings: Array<{code:string,message:string,identityKey?:string}>, errors: Array<{code:string,message:string,identityKey?:string}> }}
 */
function validateDependencies(selectedDiffs, devModel, prodModel, allDiffs = []) {
    const warnings = [];
    const errors = [];

    // Compatibility level check (e.g. UDF requires >= 1702).
    // The deployer auto-bumps compatibilityLevel when needed, so this is a
    // warning only (informational) — does not block deployment.
    const targetCompat = getCompatibilityLevel(prodModel);
    if (targetCompat !== null) {
        for (const d of selectedDiffs) {
            if (d.type === 1) continue; // remove never needs higher compat
            const required = COMPAT_LEVEL_REQUIREMENTS[d.objectType];
            if (required && targetCompat < required) {
                warnings.push({
                    code: 'COMPAT_LEVEL_AUTO_BUMP',
                    identityKey: d.identityKey,
                    message: `${d.objectType} '${d.displayName}' requires compatibilityLevel >= ${required}, target is at ${targetCompat}. compatibilityLevel will be raised to ${required} in database.tmdl automatically.`
                });
            }
        }
    }

    const prodObjects = extractAll(prodModel);
    const devObjects = extractAll(devModel);

    // Build sets of identityKeys in target after applying selected diffs (Adds add, Removes remove).
    const afterKeys = new Set(Object.keys(prodObjects));
    const addedKeys = new Set();
    const removedKeys = new Set();

    for (const d of selectedDiffs) {
        if (d.type === 0) { afterKeys.add(d.identityKey); addedKeys.add(d.identityKey); }
        else if (d.type === 1) { afterKeys.delete(d.identityKey); removedKeys.add(d.identityKey); }
    }

    // 1. Adding column requires its parent table to exist after.
    for (const d of selectedDiffs) {
        if (d.type === 0 && d.objectType === 'column' && d.parentTable) {
            const tableKey = rootKey('table', d.parentTable);
            if (!afterKeys.has(tableKey)) {
                errors.push({
                    code: 'MISSING_PARENT_TABLE',
                    identityKey: d.identityKey,
                    message: `Column ${d.displayName} needs table '${d.parentTable}', which is not in the target and is not selected to be added.`
                });
            }
        }
        // Same for measure/hierarchy/partition
        if (d.type === 0 && ['measure', 'hierarchy', 'partition', 'calculationItem'].includes(d.objectType) && d.parentTable) {
            const tableKey = rootKey('table', d.parentTable);
            if (!afterKeys.has(tableKey)) {
                errors.push({
                    code: 'MISSING_PARENT_TABLE',
                    identityKey: d.identityKey,
                    message: `${d.objectType} ${d.displayName} needs table '${d.parentTable}', which is not in the target.`
                });
            }
        }
        // A calculationItem also needs its calculationGroup. Without this check a
        // partially selected item was appended at the wrong indent and the model
        // could not be parsed by Power BI.
        if (d.type === 0 && d.objectType === 'calculationItem' && d.parentTable) {
            const cgKey = rootKey('calculationGroup', d.parentTable);
            if (!afterKeys.has(cgKey)) {
                errors.push({
                    code: 'MISSING_CALCULATION_GROUP',
                    identityKey: d.identityKey,
                    message: `calculationItem ${d.displayName} needs a calculation group in table '${d.parentTable}', which is not in the target and is not selected to be added.`
                });
            }
        }
    }

    // 2. Adding relationship requires both endpoint columns to exist after.
    for (const d of selectedDiffs) {
        if (d.type === 0 && d.objectType === 'relationship') {
            const devRel = devObjects[d.identityKey];
            if (!devRel) continue;
            const fromCol = devRel.properties.fromColumn || '';
            const toCol = devRel.properties.toColumn || '';
            for (const colRef of [fromCol, toCol]) {
                if (!colRef) continue;
                const { table: tbl, column: col } = parseColumnRef(colRef);
                if (!tbl || !col) continue;
                if (!afterKeys.has(childKey('column', tbl, col))) {
                    errors.push({
                        code: 'MISSING_RELATIONSHIP_ENDPOINT',
                        identityKey: d.identityKey,
                        message: `Relationship ${d.displayName} needs column '${colRef}', which is not in the target and is not selected to be added.`
                    });
                }
            }
        }
    }

    // 2b. Adding a relationship on a column pair the target already uses.
    // Analysis Services rejects a duplicate relationship, and the upload fails
    // after a plan that looked clean.
    {
        const endpointsOf = obj => {
            const from = parseColumnRef(obj.properties.fromColumn || '');
            const to = parseColumnRef(obj.properties.toColumn || '');
            return `${String(from.table).toLowerCase()}.${String(from.column).toLowerCase()}` +
                ` -> ${String(to.table).toLowerCase()}.${String(to.column).toLowerCase()}`;
        };
        const targetEndpoints = new Map();
        for (const obj of Object.values(prodObjects)) {
            if (obj.objectType !== 'relationship') continue;
            if (removedKeys.has(obj.identityKey)) continue;
            targetEndpoints.set(endpointsOf(obj), obj.displayName);
        }
        for (const d of selectedDiffs) {
            if (d.type !== 0 || d.objectType !== 'relationship') continue;
            const devRel = devObjects[d.identityKey];
            if (!devRel) continue;
            const existing = targetEndpoints.get(endpointsOf(devRel));
            if (existing) {
                errors.push({
                    code: 'DUPLICATE_RELATIONSHIP',
                    identityKey: d.identityKey,
                    message: `Relationship ${d.displayName} uses the same column pair as '${existing}', which already exists in the target. Analysis Services rejects duplicate relationships: deploy this as a modification of the existing relationship, or remove that one.`
                });
            }
        }
    }

    // 3. Removing a column referenced by relationships in target not also being removed.
    //    → Auto-cascade: collect orphaned relationships for automatic removal.
    const targetRels = Object.values(prodObjects).filter(o => o.objectType === 'relationship');
    const cascadeRels = []; // relationships to auto-remove (will be handled by deployer)
    const cascadedRelKeys = new Set();
    const relEndpoints = rel => [
        parseColumnRef(rel.properties.fromColumn || ''),
        parseColumnRef(rel.properties.toColumn || '')
    ];
    const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

    for (const d of selectedDiffs) {
        if (d.type === 1 && d.objectType === 'column') {
            const colName = d.displayName; // "Table.Column"
            for (const rel of targetRels) {
                const refsColumn = relEndpoints(rel).some(ep =>
                    sameName(ep.table, d.parentTable) && sameName(ep.column, d.objectName));
                if (refsColumn && !removedKeys.has(rel.identityKey) && !cascadedRelKeys.has(rel.identityKey)) {
                    cascadedRelKeys.add(rel.identityKey);
                    cascadeRels.push(rel);
                    warnings.push({
                        code: 'CASCADE_RELATIONSHIP_REMOVE',
                        identityKey: rel.identityKey,
                        message: `Relationship '${rel.displayName}' will be removed automatically because column '${colName}' is being removed.`
                    });
                }
            }
        }
        // 4. Removing a table → check relationships using its columns.
        // Endpoint tables are compared by EXACT parsed name. A `startsWith(tbl + '.')`
        // test also matched a different table whose name extends this one with a dot
        // segment ('Sales' vs 'Sales.EU') and silently removed its relationship.
        if (d.type === 1 && d.objectType === 'table') {
            const tbl = d.displayName;
            for (const rel of targetRels) {
                const refsTable = relEndpoints(rel).some(ep => sameName(ep.table, tbl));
                if (refsTable && !removedKeys.has(rel.identityKey) && !cascadedRelKeys.has(rel.identityKey)) {
                    cascadedRelKeys.add(rel.identityKey);
                    cascadeRels.push(rel);
                    warnings.push({
                        code: 'CASCADE_RELATIONSHIP_REMOVE',
                        identityKey: rel.identityKey,
                        message: `Relationship '${rel.displayName}' will be removed automatically because table '${tbl}' is being removed.`
                    });
                }
            }
        }
    }

    // 4b. Removing a table also strands every perspective, culture translation and
    // role tablePermission that references it. Only relationships were cascaded, so
    // the written model was invalid: the local PBIP would not load and the Fabric
    // upload failed after a plan that reported success.
    {
        const removedTables = selectedDiffs
            .filter(d => d.type === 1 && d.objectType === 'table')
            .map(d => d.displayName);

        if (removedTables.length > 0) {
            const selectedKeys = new Set(selectedDiffs.map(d => d.identityKey));
            const dangling = [];

            for (const tbl of removedTables) {
                for (const obj of Object.values(prodObjects)) {
                    // Skip holders that are themselves being removed or replaced by a
                    // DEV version in this same deploy.
                    if (selectedKeys.has(obj.identityKey)) continue;

                    if (obj.objectType === 'perspective') {
                        const tables = String(obj.properties.includedTables || '').split(', ').filter(Boolean);
                        if (tables.some(t => sameName(t, tbl))) {
                            dangling.push(`perspective '${obj.displayName}'`);
                        }
                    } else if (obj.objectType === 'tablePermission') {
                        if (sameName(obj.objectName, tbl) && !selectedKeys.has(rootKey('role', obj.parentRole))) {
                            dangling.push(`role '${obj.parentRole}' (tablePermission ${obj.objectName})`);
                        }
                    } else if (obj.objectType === 'culture') {
                        if (cultureReferencesTable(obj.rawBlock, tbl)) {
                            dangling.push(`translations '${obj.displayName}'`);
                        }
                    }
                }

                if (dangling.length > 0) {
                    errors.push({
                        code: 'DANGLING_TABLE_REF',
                        identityKey: rootKey('table', tbl),
                        message: `Removing table '${tbl}' would leave dangling references in: ${[...new Set(dangling)].join(', ')}. ` +
                            `The written model would be invalid. Select those objects for deployment too (their source versions no longer reference the table), or remove them along with the table.`
                    });
                    dangling.length = 0;
                }
            }
        }
    }

    // 5. Relationship deployment order — pre-deploy warning.
    // When a selected relationship (added or modified) has unselected structural changes
    // on its endpoint tables (partition with expression change, column add/remove),
    // Fabric may reject the updateDefinition call with "missing options" until those
    // table changes are deployed and the data is refreshed first.
    {
        const selectedRelKeys = new Set(selectedDiffs.filter(d => d.objectType === 'relationship' && (d.type === 0 || d.type === 2)).map(d => d.identityKey));
        const selectedDiffKeys = new Set(selectedDiffs.map(d => d.identityKey));

        // Structural change: partition with expression, or column add/remove
        function isStructuralDiff(d) {
            if (d.objectType === 'column' && (d.type === 0 || d.type === 1)) return true;
            if (d.objectType === 'partition' && d.type !== 1) {
                return (d.propertyDiffs || []).some(p => p.propertyName === 'expression');
            }
            return false;
        }

        function parseRelEndpoints(relDiff) {
            let fromRef, toRef;
            if (relDiff.type === 2) {
                [fromRef, toRef] = relDiff.displayName.split(' \u2192 ');
            } else {
                const vp = relDiff.type === 0 ? 'devValue' : 'prodValue';
                const fp = (relDiff.propertyDiffs || []).find(p => p.propertyName === 'fromColumn');
                const tp = (relDiff.propertyDiffs || []).find(p => p.propertyName === 'toColumn');
                fromRef = fp ? fp[vp] : null;
                toRef   = tp ? tp[vp] : null;
                if (!fromRef && !toRef) [fromRef, toRef] = relDiff.displayName.split(' \u2192 ');
            }
            return { fromTable: parseColumnRef(fromRef).table, toTable: parseColumnRef(toRef).table };
        }

        for (const relKey of selectedRelKeys) {
            const relDiff = selectedDiffs.find(d => d.identityKey === relKey);
            if (!relDiff) continue;
            const { fromTable, toTable } = parseRelEndpoints(relDiff);

            // Find UNSELECTED structural diffs on either endpoint table
            const pendingByTable = {};
            for (const d of allDiffs) {
                if (selectedDiffKeys.has(d.identityKey)) continue; // already selected — no issue
                if (!isStructuralDiff(d)) continue;
                const tbl = d.parentTable;
                if (tbl === fromTable || tbl === toTable) {
                    if (!pendingByTable[tbl]) pendingByTable[tbl] = [];
                    pendingByTable[tbl].push(d.displayName);
                }
            }

            if (Object.keys(pendingByTable).length > 0) {
                const tableList = Object.entries(pendingByTable)
                    .map(([tbl, names]) => `'${tbl}' (${names.slice(0, 3).join(', ')}${names.length > 3 ? ' ...' : ''})`)
                    .join('; ');
                warnings.push({
                    code: 'RELATIONSHIP_PENDING_TABLE_CHANGES',
                    identityKey: relDiff.identityKey,
                    message: `Relationship '${relDiff.displayName}' references table(s) with undeployed structural changes: ${tableList}. ` +
                        `Fabric may reject this deployment with "missing options" until those table changes are deployed and refreshed first. ` +
                        `Recommended: deploy the table changes first, trigger the data refresh, then redeploy the relationship separately.`
                });
            }
        }
    }

    // 6 (renumbered). Added measure: best-effort DAX scan for missing column refs (warning, never error)
    for (const d of selectedDiffs) {
        if (d.type === 0 && d.objectType === 'measure') {
            const devMeasure = devObjects[d.identityKey];
            if (!devMeasure) continue;
            const expr = devMeasure.properties.expression || '';
            // Look for 'Table'[Column] or Table[Column] patterns
            const refRe = /'?([A-Za-z_][\w\s]*?)'?\[([^\]]+)\]/g;
            let m;
            const missing = new Set();
            while ((m = refRe.exec(expr)) !== null) {
                const tbl = m[1].trim();
                const col = m[2].trim();
                const colKey = childKey('column', tbl, col);
                const measKey = childKey('measure', tbl, col);
                if (!afterKeys.has(colKey) && !afterKeys.has(measKey)) {
                    missing.add(`${tbl}[${col}]`);
                }
            }
            if (missing.size > 0) {
                warnings.push({
                    code: 'MEASURE_REF_MISSING',
                    identityKey: d.identityKey,
                    message: `Measure ${d.displayName} references objects that are not present: ${[...missing].join(', ')}. Check whether they are selected to be added.`
                });
            }
        }
    }

    // 7. Perspective references: every perspectiveTable/Column/Measure/Hierarchy
    // referenced inside a perspective file must exist in the target after deploy.
    // Otherwise Fabric AS rejects the model with:
    //   "Property Column of object 'perspective column' refers to an object
    //    which cannot be found"
    for (const d of selectedDiffs) {
        if (d.type === 1) continue; // removing a perspective is always safe
        if (d.objectType !== 'perspective') continue;
        const devObj = devObjects[d.identityKey];
        if (!devObj || !devObj.rawBlock) continue;
        const missing = findMissingPerspectiveRefs(devObj.rawBlock, afterKeys);
        if (missing.length > 0) {
            const list = missing.slice(0, 8).map(r => `${r.type} '${r.path}'`).join(', ');
            const more = missing.length > 8 ? ` (+${missing.length - 8} wiecej)` : '';
            errors.push({
                code: 'PERSPECTIVE_REF_MISSING',
                identityKey: d.identityKey,
                message: `Perspective '${d.displayName}' references objects that do not exist in the target: ${list}${more}. Add the missing objects to this deployment, or remove those references from the perspective in the source and compare again.`
            });
        }
    }

    return { warnings, errors, cascadeRels };
}

/**
 * Scan a perspective rawBlock and return refs (perspectiveTable / perspectiveColumn
 * / perspectiveMeasure / perspectiveHierarchy) that don't resolve in `afterKeys`.
 *
 * @param {string} rawBlock
 * @param {Set<string>} afterKeys
 * @returns {Array<{type: 'table'|'column'|'measure'|'hierarchy', path: string}>}
 */
function findMissingPerspectiveRefs(rawBlock, afterKeys) {
    const missing = [];
    const lines = rawBlock.replace(/\r\n/g, '\n').split('\n');
    // `unquote` also un-escapes doubled apostrophes. Stripping only the outer
    // quotes left `Int''l Sales`, which never matched the real name `Int'l Sales`
    // and aborted a valid deploy with a false PERSPECTIVE_REF_MISSING error.
    const stripName = s => unquote(s);
    let currentTable = null;
    let currentTableMissing = false;

    for (const line of lines) {
        const trimmed = line.trim();
        let m;
        if ((m = trimmed.match(/^perspectiveTable\s+(.+?)\s*$/i))) {
            currentTable = stripName(m[1]);
            currentTableMissing = !afterKeys.has(rootKey('table', currentTable));
            if (currentTableMissing) {
                missing.push({ type: 'table', path: currentTable });
            }
            continue;
        }
        if (!currentTable || currentTableMissing) continue; // skip children of missing table to avoid noise
        if ((m = trimmed.match(/^perspectiveColumn\s+(.+?)\s*$/i))) {
            const col = stripName(m[1]);
            if (!afterKeys.has(childKey('column', currentTable, col))) {
                missing.push({ type: 'column', path: `${currentTable}.${col}` });
            }
        } else if ((m = trimmed.match(/^perspectiveMeasure\s+(.+?)\s*$/i))) {
            const meas = stripName(m[1]);
            if (!afterKeys.has(childKey('measure', currentTable, meas))) {
                missing.push({ type: 'measure', path: `${currentTable}.${meas}` });
            }
        } else if ((m = trimmed.match(/^perspectiveHierarchy\s+(.+?)\s*$/i))) {
            const hier = stripName(m[1]);
            if (!afterKeys.has(childKey('hierarchy', currentTable, hier))) {
                missing.push({ type: 'hierarchy', path: `${currentTable}.${hier}` });
            }
        }
    }
    return missing;
}

/** Does a culture (translations) block translate the given table? */
function cultureReferencesTable(rawBlock, tableName) {
    if (!rawBlock) return false;
    const target = String(tableName).toLowerCase();
    for (const line of String(rawBlock).replace(/\r\n/g, '\n').split('\n')) {
        const m = line.trim().match(/^table\s+(.+?)\s*$/i);
        if (m && String(unquote(m[1])).toLowerCase() === target) return true;
    }
    return false;
}

module.exports = {
    validateDependencies, COMPAT_LEVEL_REQUIREMENTS, getCompatibilityLevel,
    findMissingPerspectiveRefs, cultureReferencesTable
};
