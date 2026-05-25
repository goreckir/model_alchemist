/**
 * Model Extractor v2 — Converts parsed TMDL objects into identity-keyed dictionaries.
 * Enhanced: preserves source file info and raw blocks for deployment.
 */

const CHANGE_GROUPS = {
    TABLES: 'Tables',
    COLUMNS: 'Columns',
    MEASURES: 'Measures',
    RELATIONSHIPS: 'Relationships',
    ROLES: 'Roles & Row-Level Security',
    CALCULATION_GROUPS: 'Calculation Groups',
    HIERARCHIES: 'Hierarchies',
    PERSPECTIVES: 'Perspectives',
    TRANSLATIONS: 'Translations',
    DATA_SOURCES: 'Data Sources & Parameters',
    MODEL_PROPERTIES: 'Model Properties',
    NAMED_EXPRESSIONS: 'Named Expressions'
};

/**
 * Extract all model objects into an identity-keyed dictionary.
 * Each object includes sourceFile and rawBlock for deployment.
 */
function extractAll(model) {
    const objects = {};

    for (const table of model.tables) {
        if (table.type === 'table') extractTable(table, objects);
    }
    for (const rel of model.relationships) {
        if (rel.type === 'relationship') extractRelationship(rel, objects);
    }
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
    if (model.modelConfig && model.modelConfig.length > 0) {
        extractModelProperties(model.modelConfig[0], objects);
    }

    return objects;
}

function extractTable(table, objects) {
    const tableName = table.name;
    const key = `table:${tableName}`;

    objects[key] = {
        objectType: 'table',
        identityKey: key,
        displayName: tableName,
        changeGroup: CHANGE_GROUPS.TABLES,
        sourceFile: table.file,
        rawBlock: table.rawBlock,
        properties: {
            isHidden: table.properties.isHidden || 'false',
            isPrivate: table.properties.isPrivate || 'false',
            description: table.properties.description || ''
        }
    };

    for (const child of table.children) {
        switch (child.type) {
            case 'column': extractColumn(tableName, child, table.file, objects); break;
            case 'measure': extractMeasure(tableName, child, table.file, objects); break;
            case 'hierarchy': extractHierarchy(tableName, child, table.file, objects); break;
            case 'partition': extractPartition(tableName, child, table.file, objects); break;
            case 'calculationgroup': extractCalculationGroup(tableName, child, table.file, objects); break;
        }
    }
}

function extractColumn(tableName, col, sourceFile, objects) {
    const key = `column:${tableName}.${col.name}`;
    const props = {
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
        sortByColumn: col.properties.sortByColumn || ''
    };
    if (col.expression) props.expression = col.expression;

    objects[key] = {
        objectType: 'column',
        identityKey: key,
        displayName: `${tableName}.${col.name}`,
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.COLUMNS,
        sourceFile,
        rawBlock: col.rawBlock,
        properties: props
    };
}

function extractMeasure(tableName, measure, sourceFile, objects) {
    const key = `measure:${tableName}.${measure.name}`;
    const props = {
        expression: measure.expression || '',
        formatString: measure.properties.formatString || '',
        displayFolder: measure.properties.displayFolder || '',
        isHidden: measure.properties.isHidden || 'false',
        description: measure.properties.description || ''
    };

    for (const child of measure.children || []) {
        if (child.type === 'kpi') {
            props['kpi.statusExpression'] = child.properties.statusExpression || child.expression || '';
            props['kpi.targetExpression'] = child.properties.targetExpression || '';
            props['kpi.trendExpression'] = child.properties.trendExpression || '';
        }
    }

    objects[key] = {
        objectType: 'measure',
        identityKey: key,
        displayName: `${tableName}.${measure.name}`,
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.MEASURES,
        sourceFile,
        rawBlock: measure.rawBlock,
        properties: props
    };
}

function extractHierarchy(tableName, hier, sourceFile, objects) {
    const key = `hierarchy:${tableName}.${hier.name}`;
    const props = {
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
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.HIERARCHIES,
        sourceFile,
        rawBlock: hier.rawBlock,
        properties: props
    };
}

function extractPartition(tableName, partition, sourceFile, objects) {
    const key = `partition:${tableName}.${partition.name}`;
    const partitionType = partition.expression || '';
    const sourceExpression = partition.properties.source || '';
    const props = {
        mode: partition.properties.mode || 'import',
        type: partitionType,
        expression: sourceExpression
    };

    objects[key] = {
        objectType: 'partition',
        identityKey: key,
        displayName: `${tableName}.${partition.name}`,
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.TABLES,
        sourceFile,
        rawBlock: partition.rawBlock,
        properties: props
    };
}

function extractCalculationGroup(tableName, calcGroup, sourceFile, objects) {
    const key = `calculationGroup:${tableName}`;
    objects[key] = {
        objectType: 'calculationGroup',
        identityKey: key,
        displayName: tableName,
        parentTable: tableName,
        changeGroup: CHANGE_GROUPS.CALCULATION_GROUPS,
        sourceFile,
        rawBlock: calcGroup.rawBlock,
        properties: { precedence: calcGroup.properties.precedence || '0' }
    };

    for (const item of calcGroup.children || []) {
        if (item.type === 'calculationitem') {
            const itemKey = `calculationItem:${tableName}.${item.name}`;
            objects[itemKey] = {
                objectType: 'calculationItem',
                identityKey: itemKey,
                displayName: `${tableName}.${item.name}`,
                parentTable: tableName,
                changeGroup: CHANGE_GROUPS.CALCULATION_GROUPS,
                sourceFile,
                rawBlock: item.rawBlock,
                properties: { expression: item.expression || '', ordinal: item.properties.ordinal || '0' }
            };
        }
    }
}

function extractRelationship(rel, objects) {
    const fromCol = rel.properties.fromColumn || '';
    const toCol = rel.properties.toColumn || '';
    const semanticKey = `${fromCol} → ${toCol}`;
    const key = `relationship:${semanticKey}`;

    objects[key] = {
        objectType: 'relationship',
        identityKey: key,
        displayName: semanticKey,
        changeGroup: CHANGE_GROUPS.RELATIONSHIPS,
        sourceFile: rel.file,
        rawBlock: rel.rawBlock,
        properties: {
            fromColumn: fromCol,
            toColumn: toCol,
            cardinality: rel.properties.cardinality || '',
            crossFilteringBehavior: rel.properties.crossFilteringBehavior || 'oneDirection',
            isActive: rel.properties.isActive || 'true',
            securityFilteringBehavior: rel.properties.securityFilteringBehavior || ''
        }
    };
}

function extractRole(role, objects) {
    const key = `role:${role.name}`;
    objects[key] = {
        objectType: 'role',
        identityKey: key,
        displayName: role.name,
        changeGroup: CHANGE_GROUPS.ROLES,
        sourceFile: role.file,
        rawBlock: role.rawBlock,
        properties: { modelPermission: role.properties.modelPermission || '' }
    };
    for (const child of role.children || []) {
        if (child.type === 'tablepermission') {
            const tpKey = `tablePermission:${role.name}.${child.name}`;
            objects[tpKey] = {
                objectType: 'tablePermission',
                identityKey: tpKey,
                displayName: `${role.name} → ${child.name}`,
                parentRole: role.name,
                changeGroup: CHANGE_GROUPS.ROLES,
                sourceFile: role.file,
                rawBlock: child.rawBlock,
                properties: { filterExpression: child.expression || child.properties.filterExpression || '' }
            };
        }
    }
}

function extractExpression(expr, objects) {
    const key = `expression:${expr.name}`;
    objects[key] = {
        objectType: 'expression',
        identityKey: key,
        displayName: expr.name,
        changeGroup: CHANGE_GROUPS.NAMED_EXPRESSIONS,
        sourceFile: expr.file,
        rawBlock: expr.rawBlock,
        properties: {
            expression: expr.expression || '',
            kind: expr.properties.kind || 'm'
        }
    };
}

function extractPerspective(persp, objects) {
    const key = `perspective:${persp.name}`;
    const tables = [];
    for (const child of persp.children || []) {
        if (child.type === 'perspectivetable') tables.push(child.name);
    }
    objects[key] = {
        objectType: 'perspective',
        identityKey: key,
        displayName: persp.name,
        changeGroup: CHANGE_GROUPS.PERSPECTIVES,
        sourceFile: persp.file,
        rawBlock: persp.rawBlock,
        properties: { description: persp.properties.description || '', includedTables: tables.join(', ') }
    };
}

function extractCulture(culture, objects) {
    const key = `culture:${culture.name}`;
    objects[key] = {
        objectType: 'culture',
        identityKey: key,
        displayName: culture.name,
        changeGroup: CHANGE_GROUPS.TRANSLATIONS,
        sourceFile: culture.file,
        rawBlock: culture.rawBlock,
        properties: { locale: culture.name }
    };
}

function extractDataSource(ds, objects) {
    const key = `dataSource:${ds.name}`;
    objects[key] = {
        objectType: 'dataSource',
        identityKey: key,
        displayName: ds.name,
        changeGroup: CHANGE_GROUPS.DATA_SOURCES,
        sourceFile: ds.file,
        rawBlock: ds.rawBlock,
        properties: { type: ds.properties.type || '' }
    };
}

function extractModelProperties(modelObj, objects) {
    objects['model:properties'] = {
        objectType: 'model',
        identityKey: 'model:properties',
        displayName: 'Model Properties',
        changeGroup: CHANGE_GROUPS.MODEL_PROPERTIES,
        sourceFile: modelObj.file,
        rawBlock: modelObj.rawBlock,
        properties: {
            culture: modelObj.properties.culture || '',
            defaultPowerBIDataSourceVersion: modelObj.properties.defaultPowerBIDataSourceVersion || ''
        }
    };
}

module.exports = { extractAll, CHANGE_GROUPS };
