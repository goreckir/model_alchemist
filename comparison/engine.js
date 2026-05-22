/**
 * Comparison Engine v2 — Core algorithm (F3 from spec).
 * Enhanced: each diff carries sourceFile and rawBlock info for deployment.
 */

const { extractAll } = require('./extractor');

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

module.exports = { compareModels };
