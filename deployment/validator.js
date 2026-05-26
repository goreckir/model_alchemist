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
 * @returns {{ warnings: Array<{code:string,message:string,identityKey?:string}>, errors: Array<{code:string,message:string,identityKey?:string}> }}
 */
function validateDependencies(selectedDiffs, devModel, prodModel) {
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
                    message: `Obiekt ${d.objectType} '${d.displayName}' wymaga compatibilityLevel >= ${required}, target ma ${targetCompat}. compatibilityLevel zostanie automatycznie podniesiony do ${required} w database.tmdl.`
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
            const tableKey = `table:${d.parentTable}`;
            if (!afterKeys.has(tableKey)) {
                errors.push({
                    code: 'MISSING_PARENT_TABLE',
                    identityKey: d.identityKey,
                    message: `Dodawana kolumna ${d.displayName} wymaga tabeli '${d.parentTable}' \u2014 brak jej w target i nie zaznaczono jej do dodania.`
                });
            }
        }
        // Same for measure/hierarchy/partition
        if (d.type === 0 && ['measure', 'hierarchy', 'partition', 'calculationItem'].includes(d.objectType) && d.parentTable) {
            const tableKey = `table:${d.parentTable}`;
            if (!afterKeys.has(tableKey)) {
                errors.push({
                    code: 'MISSING_PARENT_TABLE',
                    identityKey: d.identityKey,
                    message: `Dodawany obiekt ${d.displayName} (${d.objectType}) wymaga tabeli '${d.parentTable}' \u2014 brak jej w target.`
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
                // colRef is typically Table.Column or 'Table'.'Column'
                const norm = colRef.replace(/'/g, '');
                const dotIdx = norm.lastIndexOf('.');
                if (dotIdx < 0) continue;
                const tbl = norm.substring(0, dotIdx);
                const col = norm.substring(dotIdx + 1);
                const colKey = `column:${tbl}.${col}`;
                if (!afterKeys.has(colKey)) {
                    errors.push({
                        code: 'MISSING_RELATIONSHIP_ENDPOINT',
                        identityKey: d.identityKey,
                        message: `Dodawana relacja ${d.displayName} wymaga kolumny '${colRef}' \u2014 brak jej w target i nie zaznaczono do dodania.`
                    });
                }
            }
        }
    }

    // 3. Removing a column referenced by relationships in target not also being removed.
    const targetRels = Object.values(prodObjects).filter(o => o.objectType === 'relationship');
    for (const d of selectedDiffs) {
        if (d.type === 1 && d.objectType === 'column') {
            const colName = d.displayName; // "Table.Column"
            for (const rel of targetRels) {
                const fromCol = (rel.properties.fromColumn || '').replace(/'/g, '');
                const toCol = (rel.properties.toColumn || '').replace(/'/g, '');
                if ((fromCol === colName || toCol === colName) && !removedKeys.has(rel.identityKey)) {
                    warnings.push({
                        code: 'ORPHAN_RELATIONSHIP',
                        identityKey: d.identityKey,
                        message: `Usuwana kolumna '${colName}' jest uzywana w relacji ${rel.displayName} \u2014 nie zaznaczono jej do usuniecia. Relacja stanie sie nieprawidlowa.`
                    });
                }
            }
        }
        // 4. Removing a table → check relationships using its columns
        if (d.type === 1 && d.objectType === 'table') {
            const tbl = d.displayName;
            for (const rel of targetRels) {
                const fromCol = (rel.properties.fromColumn || '').replace(/'/g, '');
                const toCol = (rel.properties.toColumn || '').replace(/'/g, '');
                const refsTable = fromCol.startsWith(tbl + '.') || toCol.startsWith(tbl + '.');
                if (refsTable && !removedKeys.has(rel.identityKey)) {
                    warnings.push({
                        code: 'ORPHAN_RELATIONSHIP',
                        identityKey: d.identityKey,
                        message: `Usuwana tabela '${tbl}' jest uzywana w relacji ${rel.displayName} \u2014 relacja nie zaznaczona do usuniecia.`
                    });
                }
            }
        }
    }

    // 5. Added measure: best-effort DAX scan for missing column refs (warning, never error)
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
                const colKey = `column:${tbl}.${col}`;
                const measKey = `measure:${tbl}.${col}`;
                if (!afterKeys.has(colKey) && !afterKeys.has(measKey)) {
                    missing.add(`${tbl}[${col}]`);
                }
            }
            if (missing.size > 0) {
                warnings.push({
                    code: 'MEASURE_REF_MISSING',
                    identityKey: d.identityKey,
                    message: `Dodawany measure ${d.displayName} odwoluje sie do nieobecnych obiektow: ${[...missing].join(', ')}. Sprawdz czy sa zaznaczone do dodania.`
                });
            }
        }
    }

    return { warnings, errors };
}

module.exports = { validateDependencies, COMPAT_LEVEL_REQUIREMENTS, getCompatibilityLevel };
