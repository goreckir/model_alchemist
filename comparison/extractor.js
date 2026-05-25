/**
 * Model Extractor v2 — Converts parsed TMDL objects into identity-keyed dictionaries.
 * Enhanced: preserves source file info and raw blocks for deployment.
 */

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
    const key = `table:${tableName}`;

    // If table has a calculationGroup child, classify it as Calculation Group
    const hasCalcGroup = table.children.some(c => c.type === 'calculationgroup');

    objects[key] = {
        objectType: 'table',
        identityKey: key,
        displayName: tableName,
        changeGroup: hasCalcGroup ? CHANGE_GROUPS.CALCULATION_GROUPS : CHANGE_GROUPS.TABLES,
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
            case 'column': extractColumn(tableName, child, table.file, objects, hasCalcGroup); break;
            case 'measure': extractMeasure(tableName, child, table.file, objects); break;
            case 'hierarchy': extractHierarchy(tableName, child, table.file, objects); break;
            case 'partition': extractPartition(tableName, child, table.file, objects); break;
            case 'calculationgroup': extractCalculationGroup(tableName, child, table.file, objects); break;
        }
    }
}

function extractColumn(tableName, col, sourceFile, objects, isCalcGroupTable) {
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
        changeGroup: isCalcGroupTable ? CHANGE_GROUPS.CALCULATION_GROUPS : CHANGE_GROUPS.TABLES,
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
        changeGroup: CHANGE_GROUPS.TABLES,
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

    // Collect table permission summaries for role-level view
    const tablePerms = (role.children || []).filter(c => c.type === 'tablepermission');
    const permSummary = tablePerms.map(tp => tp.name).join(', ');

    objects[key] = {
        objectType: 'role',
        identityKey: key,
        displayName: role.name,
        changeGroup: CHANGE_GROUPS.ROLES,
        sourceFile: role.file,
        rawBlock: role.rawBlock,
        properties: {
            modelPermission: role.properties.modelPermission || '',
            description: role.properties.description || '',
            tablePermissions: permSummary
        }
    };
    for (const child of tablePerms) {
        const tpKey = `tablePermission:${role.name}.${child.name}`;
        const filterExpr = child.expression || child.properties.filterExpression || '';
        objects[tpKey] = {
            objectType: 'tablePermission',
            identityKey: tpKey,
            displayName: `${role.name} → ${child.name}`,
            parentRole: role.name,
            changeGroup: CHANGE_GROUPS.ROLES,
            sourceFile: role.file,
            rawBlock: child.rawBlock,
            properties: {
                filterExpression: filterExpr
            }
        };
    }

    // Extract role members
    const members = (role.children || []).filter(c => c.type === 'member');
    for (const member of members) {
        const mKey = `roleMember:${role.name}.${member.name}`;
        objects[mKey] = {
            objectType: 'roleMember',
            identityKey: mKey,
            displayName: `${role.name} → ${member.name}`,
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
    const key = `expression:${expr.name}`;
    const exprValue = expr.expression || '';

    // Detect M parameters (IsParameterQuery in meta) vs shared queries
    const isParameter = exprValue.includes('IsParameterQuery');
    const group = isParameter ? CHANGE_GROUPS.DATA_SOURCES : CHANGE_GROUPS.NAMED_EXPRESSIONS;

    objects[key] = {
        objectType: 'expression',
        subType: isParameter ? 'parameter' : 'query',
        identityKey: key,
        displayName: expr.name,
        changeGroup: group,
        sourceFile: expr.file,
        rawBlock: expr.rawBlock,
        properties: {
            expression: exprValue,
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
    const props = { locale: culture.name };

    // Extract translation details from parsed children
    const translationsObj = (culture.children || []).find(c => c.type === 'translations');
    if (translationsObj) {
        const translations = [];
        for (const modelChild of translationsObj.children || []) {
            for (const tableChild of modelChild.children || []) {
                const tableName = tableChild.name;
                for (const objChild of tableChild.children || []) {
                    const objType = objChild.type; // column, measure, table, hierarchy
                    const objName = objChild.name;
                    const caption = objChild.properties.caption || '';
                    const description = objChild.properties.description || '';
                    const parts = [];
                    if (caption) parts.push(`caption: ${caption}`);
                    if (description) parts.push(`description: ${description}`);
                    if (parts.length > 0) {
                        translations.push(`${tableName}.${objName} (${objType}): ${parts.join(', ')}`);
                    }
                }
                // Table-level translations (caption/description on the table itself)
                if (tableChild.properties.caption || tableChild.properties.description) {
                    const parts = [];
                    if (tableChild.properties.caption) parts.push(`caption: ${tableChild.properties.caption}`);
                    if (tableChild.properties.description) parts.push(`description: ${tableChild.properties.description}`);
                    translations.push(`${tableName} (table): ${parts.join(', ')}`);
                }
            }
        }
        if (translations.length > 0) {
            props.translations = translations.join('\n');
        }
    }

    objects[key] = {
        objectType: 'culture',
        identityKey: key,
        displayName: culture.name,
        changeGroup: CHANGE_GROUPS.TRANSLATIONS,
        sourceFile: culture.file,
        rawBlock: culture.rawBlock,
        properties: props
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

function extractFunction(func, objects) {
    const key = `function:${func.name}`;
    objects[key] = {
        objectType: 'function',
        identityKey: key,
        displayName: func.name,
        changeGroup: CHANGE_GROUPS.FUNCTIONS,
        sourceFile: func.file,
        rawBlock: func.rawBlock,
        properties: {
            expression: func.expression || '',
            description: func.properties.description || ''
        }
    };
}

module.exports = { extractAll, CHANGE_GROUPS };
