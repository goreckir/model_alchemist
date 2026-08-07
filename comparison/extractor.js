/**
 * Model Extractor v2 — Converts parsed TMDL objects into identity-keyed dictionaries.
 * Enhanced: preserves source file info and raw blocks for deployment.
 */

const { rootKey, childKey } = require('./keys');

const CHANGE_GROUPS = {
    TABLES: 'Tables & Relationships',
    MEASURES: 'Measures',
    ROLES: 'Roles & Row-Level Security',
    CALCULATION_GROUPS: 'Calculation Groups',
    HIERARCHIES: 'Hierarchies',
    PERSPECTIVES: 'Perspectives',
    TRANSLATIONS: 'Translations',
    DATA_SOURCES: 'Data Sources & Parameters',
    MODEL_PROPERTIES: 'Model Properties',
    NAMED_EXPRESSIONS: 'Named Expressions',
    FUNCTIONS: 'Functions'
};

// Per-environment identifiers. Never compared (they legitimately differ between
// DEV and PROD) and preserved by the deployer when a block is replaced.
const ENV_PROPERTIES = new Set(['lineageTag', 'sourceLineageTag']);

/**
 * Serialize all child blocks of a given type into a deterministic, sorted, normalized
 * string — used to detect changes in annotation / extendedProperty / refreshPolicy /
 * formatStringDefinition / detailRowsDefinition without requiring explicit per-property
 * extraction. Returns '' when no such children.
 */
function serializeChildren(obj, types) {
    if (!obj || !obj.children) return '';
    const typeSet = new Set(types.map(t => t.toLowerCase()));
    const blocks = [];
    for (const child of obj.children) {
        if (typeSet.has((child.type || '').toLowerCase())) {
            const raw = (child.rawBlock || '').trim();
            // Skip PBI_* annotations — these are runtime state set by the Power BI
            // engine (e.g. PBI_ResultType = Table/Exception after refresh) and must
            // not be compared or deployed.
            if (child.type === 'annotation' && /^annotation\s+PBI_/i.test(raw)) continue;
            blocks.push(raw);
        }
    }
    blocks.sort();
    return blocks.join('\n');
}

/**
 * Read a `<name> = <DAX>` definition (formatStringDefinition / detailRowsDefinition).
 * Modern TMDL emits these as nested blocks, but a flat `name = value` property is
 * also valid input — read both so the value is never silently dropped.
 */
function serializeDefinition(obj, name) {
    const fromChildren = serializeChildren(obj, [name]);
    if (fromChildren) return fromChildren;
    const flat = obj && obj.properties ? obj.properties[name] : null;
    return flat ? String(flat).trim() : '';
}

/** Copy every parsed property except the per-environment identifiers. */
function copyProperties(obj) {
    const out = {};
    for (const [key, value] of Object.entries((obj && obj.properties) || {})) {
        if (ENV_PROPERTIES.has(key)) continue;
        out[key] = value;
    }
    return out;
}

// Power BI Desktop suffixes partition names with a GUID that is regenerated per
// environment. Strip it so the same partition is not reported Added + Removed.
const GUID_SUFFIX_RE = /-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BARE_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Returns the GUID-stripped base name, or '' when the name carries no stable
// signal at all (a bare GUID, or a name that strips down to nothing) — such
// partitions are grouped and ordered by content signature instead.
function normalizePartitionName(name) {
    const raw = String(name || '');
    if (BARE_GUID_RE.test(raw)) return '';
    return raw.replace(GUID_SUFFIX_RE, '') || '';
}

// Deterministic content fingerprint used to order same-named (or nameless)
// partitions independently of file listing order, so DEV/PROD pair up even
// when the two environments enumerate partitions in a different order.
function partitionContentSignature(partition) {
    const mode = partition.properties.mode || 'import';
    const sourceExpression = partition.properties.source || partition.expression || '';
    return `${mode}\u0001${sourceExpression}`;
}

// Assigns a final identity name to every partition child of a table. Partitions
// that normalize to the same base name (or share no stable name at all) are
// sorted by content signature — never by file order — before collision
// ordinals (`Foo`, `Foo#2`, …) are appended, so identical DEV/PROD listings
// pair up regardless of order and no partition is silently overwritten.
function assignPartitionNames(partitionChildren) {
    const groups = new Map();
    for (const child of partitionChildren) {
        const base = normalizePartitionName(child.name);
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base).push(child);
    }

    const names = new Map();
    for (const [base, children] of groups) {
        const sorted = [...children].sort((a, b) => {
            const sigA = partitionContentSignature(a);
            const sigB = partitionContentSignature(b);
            return sigA < sigB ? -1 : sigA > sigB ? 1 : 0;
        });
        sorted.forEach((child, i) => {
            names.set(child, base ? (i === 0 ? base : `${base}#${i + 1}`) : `#${i + 1}`);
        });
    }
    return names;
}

/**
 * Extract all model objects into an identity-keyed dictionary.
 * Each object includes sourceFile and rawBlock for deployment.
 */
function extractAll(model) {
    const objects = {};

    for (const table of model.tables) {
        if (table.type === 'table') extractTable(table, objects);
    }
    extractRelationships(model.relationships.filter(r => r.type === 'relationship'), objects);
    for (const expr of model.expressions) {
        if (expr.type === 'expression') extractExpression(expr, objects);
    }
    for (const role of model.roles) {
        if (role.type === 'role') extractRole(role, objects);
    }
    for (const persp of model.perspectives) {
        if (persp.type === 'perspective') extractPerspective(persp, objects);
    }
    for (const culture of model.cultures) {
        if (culture.type === 'cultureinfo' || culture.type === 'culture') extractCulture(culture, objects);
    }
    for (const ds of model.dataSources) {
        if (ds.type === 'datasource') extractDataSource(ds, objects);
    }
    for (const func of (model.functions || [])) {
        if (func.type === 'function') extractFunction(func, objects);
    }
    if (model.modelConfig && model.modelConfig.length > 0) {
        extractModelProperties(model.modelConfig[0], objects);
    }

    return objects;
}

function extractTable(table, objects) {
    const tableName = table.name;
    const key = rootKey('table', tableName);

    // If table has a calculationGroup child, classify it as Calculation Group
    const hasCalcGroup = table.children.some(c => c.type === 'calculationgroup');

    objects[key] = {
        objectType: 'table',
        identityKey: key,
        displayName: tableName,
        objectName: tableName,
        changeGroup: hasCalcGroup ? CHANGE_GROUPS.CALCULATION_GROUPS : CHANGE_GROUPS.TABLES,
        sourceFile: table.file,
        rawBlock: table.rawBlock,
        properties: {
            // Real name is compared so a case-only rename surfaces as a modify
            // (identity keys are case-insensitive, matching Analysis Services).
            name: tableName,
            isHidden: table.properties.isHidden || 'false',
            isPrivate: table.properties.isPrivate || 'false',
            description: table.properties.description || '',
            // lineageTag/sourceLineageTag intentionally excluded from comparison —
            // they are per-environment identifiers preserved by the deployer.
            dataCategory: table.properties.dataCategory || '',
            excludeFromModelRefresh: table.properties.excludeFromModelRefresh || 'false',
            showAsVariationsOnly: table.properties.showAsVariationsOnly || 'false',
            annotations: serializeChildren(table, ['annotation', 'extendedProperty']),
            refreshPolicy: serializeChildren(table, ['refreshPolicy'])
        }
    };

    const partitionNames = assignPartitionNames(table.children.filter(c => c.type === 'partition'));
    for (const child of table.children) {
        switch (child.type) {
            case 'column': extractColumn(tableName, child, table.file, objects, hasCalcGroup); break;
            case 'measure': extractMeasure(tableName, child, table.file, objects); break;
            case 'hierarchy': extractHierarchy(tableName, child, table.file, objects); break;
            case 'partition': extractPartition(tableName, child, table.file, objects, hasCalcGroup, partitionNames.get(child)); break;
            case 'calculationgroup': extractCalculationGroup(tableName, child, table.file, objects); break;
        }
    }
}

function extractColumn(tableName, col, sourceFile, objects, isCalcGroupTable) {
    const key = childKey('column', tableName, col.name);
    // Start from EVERY parsed property: a fixed whitelist silently dropped
    // anything not listed (isAvailableInMdx, encodingHint variants, …).
    const props = copyProperties(col);
    Object.assign(props, {
        name: col.name,
        dataType: col.properties.dataType || '',
        sourceColumn: col.properties.sourceColumn || '',
        formatString: col.properties.formatString || '',
        displayFolder: col.properties.displayFolder || '',
        isHidden: col.properties.isHidden || 'false',
        isKey: col.properties.isKey || 'false',
        isNullable: col.properties.isNullable || 'true',
        isUnique: col.properties.isUnique || 'false',
        description: col.properties.description || '',
        dataCategory: col.properties.dataCategory || '',
        summarizeBy: col.properties.summarizeBy || 'default',
        sortByColumn: col.properties.sortByColumn || '',
        summarizationSetBy: col.properties.summarizationSetBy || '',
        encodingHint: col.properties.encodingHint || '',
        annotations: serializeChildren(col, ['annotation', 'extendedProperty']),
        formatStringDefinition: serializeDefinition(col, 'formatStringDefinition'),
        detailRowsDefinition: serializeDefinition(col, 'detailRowsDefinition'),
        variations: serializeChildren(col, ['variation']),
        // Aggregation table mapping — invisible before, so a wrong mapping stayed in PROD.
        alternateOf: serializeChildren(col, ['alternateOf'])
    });
    if (col.expression) props.expression = col.expression;

    objects[key] = {
        objectType: 'column',
        identityKey: key,
        displayName: `${tableName}.${col.name}`,
        objectName: col.name,
        parentTable: tableName,
        changeGroup: isCalcGroupTable ? CHANGE_GROUPS.CALCULATION_GROUPS : CHANGE_GROUPS.TABLES,
        sourceFile,
        rawBlock: col.rawBlock,
        properties: props
    };
}

function extractMeasure(tableName, measure, sourceFile, objects) {
    const key = childKey('measure', tableName, measure.name);
    const props = {
        name: measure.name,
        expression: measure.expression || '',
        formatString: measure.properties.formatString || '',
        displayFolder: measure.properties.displayFolder || '',
        isHidden: measure.properties.isHidden || 'false',
        description: measure.properties.description || '',
        // lineageTag intentionally excluded from comparison —
        // per-environment identifier preserved by the deployer.
        dataCategory: measure.properties.dataCategory || '',
        annotations: serializeChildren(measure, ['annotation', 'extendedProperty']),
        formatStringDefinition: serializeDefinition(measure, 'formatStringDefinition'),
        detailRowsDefinition: serializeDefinition(measure, 'detailRowsDefinition')
    };

    for (const child of measure.children || []) {
        if (child.type === 'kpi') {
            // Copy EVERY kpi property — statusGraphic / trendGraphic changes were
            // invisible when only the three expressions were read.
            for (const [name, value] of Object.entries(copyProperties(child))) {
                props[`kpi.${name}`] = value;
            }
            props['kpi.statusExpression'] = child.properties.statusExpression || child.expression || '';
            props['kpi.targetExpression'] = child.properties.targetExpression || '';
            props['kpi.trendExpression'] = child.properties.trendExpression || '';
            props['kpi.annotations'] = serializeChildren(child, ['annotation', 'extendedProperty']);
        }
    }

    objects[key] = {
        objectType: 'measure',
        identityKey: key,
        displayName: `${tableName}.${measure.name}`,
        objectName: measure.name,
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.MEASURES,
        sourceFile,
        rawBlock: measure.rawBlock,
        properties: props
    };
}

function extractHierarchy(tableName, hier, sourceFile, objects) {
    const key = childKey('hierarchy', tableName, hier.name);
    const props = {
        name: hier.name,
        displayFolder: hier.properties.displayFolder || '',
        isHidden: hier.properties.isHidden || 'false'
    };
    let levelIdx = 0;
    for (const child of hier.children || []) {
        if (child.type === 'level') {
            props[`level[${levelIdx}]`] = child.name;
            if (child.properties.column) props[`level[${levelIdx}].column`] = child.properties.column;
            levelIdx++;
        }
    }

    objects[key] = {
        objectType: 'hierarchy',
        identityKey: key,
        displayName: `${tableName}.${hier.name}`,
        objectName: hier.name,
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.HIERARCHIES,
        sourceFile,
        rawBlock: hier.rawBlock,
        properties: props
    };
}

function extractPartition(tableName, partition, sourceFile, objects, isCalcGroupTable, normalized) {
    const key = childKey('partition', tableName, normalized);
    const partitionType = partition.expression || '';
    const sourceExpression = partition.properties.source || '';
    const props = {
        name: normalized,
        mode: partition.properties.mode || 'import',
        type: partitionType,
        expression: sourceExpression,
        dataView: partition.properties.dataView || '',
        queryGroup: partition.properties.queryGroup || '',
        annotations: serializeChildren(partition, ['annotation', 'extendedProperty'])
    };

    objects[key] = {
        objectType: 'partition',
        identityKey: key,
        displayName: `${tableName}.${normalized}`,
        // Real TMDL name (usually `<Table>-<GUID>`, different per environment).
        // The deployer needs it to locate the block in the target file.
        objectName: normalized,
        realName: partition.name,
        parentTable: tableName,
        changeGroup: isCalcGroupTable ? CHANGE_GROUPS.CALCULATION_GROUPS : CHANGE_GROUPS.TABLES,
        sourceFile,
        rawBlock: partition.rawBlock,
        properties: props
    };
}

function extractCalculationGroup(tableName, calcGroup, sourceFile, objects) {
    const key = rootKey('calculationGroup', tableName);
    objects[key] = {
        objectType: 'calculationGroup',
        identityKey: key,
        displayName: tableName,
        // A calculationGroup block is declared bare (`calculationGroup`) or with a
        // name — never derived from displayName, which is just the table name.
        objectName: calcGroup.name || '',
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.CALCULATION_GROUPS,
        sourceFile,
        rawBlock: calcGroup.rawBlock,
        properties: { precedence: calcGroup.properties.precedence || '0' }
    };

    for (const item of calcGroup.children || []) {
        if (item.type === 'calculationitem') {
            const itemKey = childKey('calculationItem', tableName, item.name);
            objects[itemKey] = {
                objectType: 'calculationItem',
                identityKey: itemKey,
                displayName: `${tableName}.${item.name}`,
                objectName: item.name,
                parentTable: tableName,
                changeGroup: CHANGE_GROUPS.CALCULATION_GROUPS,
                sourceFile,
                rawBlock: item.rawBlock,
                properties: {
                    name: item.name,
                    expression: item.expression || '',
                    ordinal: item.properties.ordinal || '0',
                    formatStringDefinition: serializeDefinition(item, 'formatStringDefinition')
                }
            };
        }
    }
}

// Deterministic tiebreaker for relationships sharing a fromColumn/toColumn pair —
// sorted by property signature (never by file order) before ordinal suffixes are
// assigned, so DEV/PROD listing the same relationships in different order still
// produce identical keys and diffs never point at the wrong PROD relationship.
function relationshipSortSignature(rel) {
    const isActive = rel.properties.isActive || 'true';
    const crossFilter = rel.properties.crossFilteringBehavior || 'oneDirection';
    const securityFilter = rel.properties.securityFilteringBehavior || '';
    // GUID (rel.name) is a last-resort tiebreaker only — used solely to keep the
    // sort stable when two relationships in the SAME file share every other
    // property; it does not attempt to pair across environments by itself.
    return `${isActive}\u0001${crossFilter}\u0001${securityFilter}\u0001${rel.name || ''}`;
}

function extractRelationships(relationships, objects) {
    const groups = new Map();
    for (const rel of relationships) {
        const fromCol = rel.properties.fromColumn || '';
        const toCol = rel.properties.toColumn || '';
        const displayName = `${fromCol} → ${toCol}`;
        if (!groups.has(displayName)) groups.set(displayName, []);
        groups.get(displayName).push(rel);
    }

    for (const [displayName, group] of groups) {
        const sorted = [...group].sort((a, b) => {
            const sigA = relationshipSortSignature(a);
            const sigB = relationshipSortSignature(b);
            return sigA < sigB ? -1 : sigA > sigB ? 1 : 0;
        });
        const baseKey = rootKey('relationship', displayName);
        sorted.forEach((rel, i) => {
            const key = i === 0 ? baseKey : `${baseKey}#${i + 1}`;
            extractRelationship(rel, key, displayName, objects);
        });
    }
}

function extractRelationship(rel, key, displayName, objects) {
    const fromCol = rel.properties.fromColumn || '';
    const toCol = rel.properties.toColumn || '';
    const isActive = rel.properties.isActive || 'true';
    const crossFilter = rel.properties.crossFilteringBehavior || 'oneDirection';

    objects[key] = {
        objectType: 'relationship',
        identityKey: key,
        displayName,
        // Real TMDL name (typically a GUID). Different between DEV/PROD, used by deployer
        // to locate the existing block in target during modify/remove.
        relName: rel.name,
        realName: rel.name,
        objectName: rel.name,
        changeGroup: CHANGE_GROUPS.TABLES,
        sourceFile: rel.file,
        rawBlock: rel.rawBlock,
        properties: {
            fromColumn: fromCol,
            toColumn: toCol,
            // TMDL uses fromCardinality / toCardinality (not a single "cardinality").
            // Defaults: fromCardinality = 'many', toCardinality = 'one' (standard many-to-one).
            // These fields are omitted in TMDL when they hold the default value.
            fromCardinality: rel.properties.fromCardinality || 'many',
            toCardinality: rel.properties.toCardinality || 'one',
            crossFilteringBehavior: crossFilter,
            isActive,
            securityFilteringBehavior: rel.properties.securityFilteringBehavior || '',
            joinOnDateBehavior: rel.properties.joinOnDateBehavior || '',
            relyOnReferentialIntegrity: rel.properties.relyOnReferentialIntegrity || 'false',
            annotations: serializeChildren(rel, ['annotation', 'extendedProperty'])
        }
    };
}

function extractRole(role, objects) {
    const key = rootKey('role', role.name);

    // Collect table permission summaries for role-level view
    const tablePerms = (role.children || []).filter(c => c.type === 'tablepermission');
    const permSummary = tablePerms.map(tp => tp.name).join(', ');

    objects[key] = {
        objectType: 'role',
        identityKey: key,
        displayName: role.name,
        objectName: role.name,
        changeGroup: CHANGE_GROUPS.ROLES,
        sourceFile: role.file,
        rawBlock: role.rawBlock,
        properties: {
            name: role.name,
            modelPermission: role.properties.modelPermission || '',
            description: role.properties.description || '',
            tablePermissions: permSummary
        }
    };
    for (const child of tablePerms) {
        const tpKey = childKey('tablePermission', role.name, child.name);
        const filterExpr = child.expression || child.properties.filterExpression || '';
        objects[tpKey] = {
            objectType: 'tablePermission',
            identityKey: tpKey,
            displayName: `${role.name} → ${child.name}`,
            objectName: child.name,
            parentRole: role.name,
            changeGroup: CHANGE_GROUPS.ROLES,
            sourceFile: role.file,
            rawBlock: child.rawBlock,
            properties: {
                name: child.name,
                filterExpression: filterExpr,
                metadataPermission: child.properties.metadataPermission || '',
                columnPermissions: serializeChildren(child, ['columnpermission']),
                dataCoveragePermission: serializeChildren(child, ['dataCoveragePermission'])
            }
        };
    }

    // Extract role members
    const members = (role.children || []).filter(c => c.type === 'member');
    for (const member of members) {
        const mKey = childKey('roleMember', role.name, member.name);
        objects[mKey] = {
            objectType: 'roleMember',
            identityKey: mKey,
            displayName: `${role.name} → ${member.name}`,
            objectName: member.name,
            parentRole: role.name,
            changeGroup: CHANGE_GROUPS.ROLES,
            sourceFile: role.file,
            rawBlock: member.rawBlock,
            properties: {
                memberName: member.name,
                memberType: member.properties.memberType || member.properties.identityProvider || ''
            }
        };
    }
}

function extractExpression(expr, objects) {
    const key = rootKey('expression', expr.name);
    const exprValue = expr.expression || '';

    // Detect M parameters (IsParameterQuery in meta) vs shared queries
    const isParameter = exprValue.includes('IsParameterQuery');
    const group = isParameter ? CHANGE_GROUPS.DATA_SOURCES : CHANGE_GROUPS.NAMED_EXPRESSIONS;

    objects[key] = {
        objectType: 'expression',
        subType: isParameter ? 'parameter' : 'query',
        identityKey: key,
        displayName: expr.name,
        objectName: expr.name,
        changeGroup: group,
        sourceFile: expr.file,
        rawBlock: expr.rawBlock,
        properties: {
            name: expr.name,
            expression: exprValue,
            kind: expr.properties.kind || 'm'
        }
    };
}

function extractPerspective(persp, objects) {
    const key = rootKey('perspective', persp.name);
    const tables = [];
    const measures = [];
    const columns = [];
    const hierarchies = [];

    for (const child of persp.children || []) {
        if (child.type === 'perspectivetable') {
            tables.push(child.name);
            // Extract measures, columns, hierarchies from this perspective table
            for (const tableChild of child.children || []) {
                if (tableChild.type === 'perspectivemeasure') {
                    measures.push(`${child.name}.${tableChild.name}`);
                } else if (tableChild.type === 'perspectivecolumn') {
                    columns.push(`${child.name}.${tableChild.name}`);
                } else if (tableChild.type === 'perspectivehierarchy') {
                    hierarchies.push(`${child.name}.${tableChild.name}`);
                }
            }
        }
    }

    // Sort lists to ensure consistent comparison (order may differ between environments)
    tables.sort();
    measures.sort();
    columns.sort();
    hierarchies.sort();

    objects[key] = {
        objectType: 'perspective',
        identityKey: key,
        displayName: persp.name,
        objectName: persp.name,
        changeGroup: CHANGE_GROUPS.PERSPECTIVES,
        sourceFile: persp.file,
        rawBlock: persp.rawBlock,
        properties: {
            name: persp.name,
            description: persp.properties.description || '',
            includedTables: tables.join(', '),
            includedMeasures: measures.join(', '),
            includedColumns: columns.join(', '),
            includedHierarchies: hierarchies.join(', ')
        }
    };
}

/**
 * Walk a translations tree to arbitrary depth and record EVERY translated
 * property. The previous fixed 3-level walk that read only caption/description
 * missed hierarchy-level captions and translated displayFolders entirely.
 */
function collectTranslations(node, pathParts, out) {
    for (const child of node.children || []) {
        const label = child.name ? `${child.type} '${child.name}'` : child.type;
        const nextPath = [...pathParts, label];
        const entries = Object.entries(child.properties || {})
            .filter(([, value]) => value !== '' && value != null)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => `${name}: ${value}`);
        if (entries.length > 0) {
            out.push(`${nextPath.join(' / ')}: ${entries.join(', ')}`);
        }
        collectTranslations(child, nextPath, out);
    }
}

function extractCulture(culture, objects) {
    const key = rootKey('culture', culture.name);
    const props = { name: culture.name, locale: culture.name };

    const translationsObj = (culture.children || []).find(c => c.type === 'translations');
    if (translationsObj) {
        const translations = [];
        collectTranslations(translationsObj, [], translations);
        if (translations.length > 0) {
            translations.sort();
            props.translations = translations.join('\n');
        }
    }

    // Q&A synonyms live in linguisticMetadata and were never compared.
    props.linguisticMetadata = serializeChildren(culture, ['linguisticMetadata']);

    objects[key] = {
        objectType: 'culture',
        identityKey: key,
        displayName: culture.name,
        objectName: culture.name,
        changeGroup: CHANGE_GROUPS.TRANSLATIONS,
        sourceFile: culture.file,
        rawBlock: culture.rawBlock,
        properties: props
    };
}

function extractDataSource(ds, objects) {
    const key = rootKey('dataSource', ds.name);
    // Compare the whole data source, not just `type`: a changed server or database
    // in connectionDetails used to be reported as NO DIFFS.
    const props = copyProperties(ds);
    props.name = ds.name;
    props.type = ds.properties.type || '';
    props.connectionDetails = serializeChildren(ds, ['connectionDetails']);
    props.credential = serializeChildren(ds, ['credential']);
    props.annotations = serializeChildren(ds, ['annotation', 'extendedProperty']);
    if (ds.expression) props.expression = ds.expression;

    objects[key] = {
        objectType: 'dataSource',
        identityKey: key,
        displayName: ds.name,
        objectName: ds.name,
        changeGroup: CHANGE_GROUPS.DATA_SOURCES,
        sourceFile: ds.file,
        rawBlock: ds.rawBlock,
        properties: props
    };
}

function extractModelProperties(modelObj, objects) {
    objects['model:properties'] = {
        objectType: 'model',
        identityKey: 'model:properties',
        displayName: 'Model Properties',
        modelName: modelObj.name || 'Model',
        objectName: modelObj.name || 'Model',
        changeGroup: CHANGE_GROUPS.MODEL_PROPERTIES,
        sourceFile: modelObj.file,
        rawBlock: modelObj.rawBlock,
        properties: {
            culture: modelObj.properties.culture || '',
            defaultPowerBIDataSourceVersion: modelObj.properties.defaultPowerBIDataSourceVersion || '',
            // discourageImplicitMeasures intentionally excluded — auto-managed by the
            // deployer's calculation-group logic (ensureModelProperty), not diffed here.
            defaultMeasure: modelObj.properties.defaultMeasure || '',
            sourceQueryCulture: modelObj.properties.sourceQueryCulture || '',
            collation: modelObj.properties.collation || '',
            annotations: serializeChildren(modelObj, ['annotation', 'extendedProperty']),
            dataAccessOptions: serializeChildren(modelObj, ['dataAccessOptions'])
        }
    };
}

function extractFunction(func, objects) {
    const key = rootKey('function', func.name);
    objects[key] = {
        objectType: 'function',
        identityKey: key,
        displayName: func.name,
        objectName: func.name,
        changeGroup: CHANGE_GROUPS.FUNCTIONS,
        sourceFile: func.file,
        rawBlock: func.rawBlock,
        properties: {
            name: func.name,
            expression: func.expression || '',
            description: func.properties.description || ''
        }
    };
}

module.exports = { extractAll, CHANGE_GROUPS, normalizePartitionName };
