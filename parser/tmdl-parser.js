/**
 * TMDL Parser v2 — Parses TMDL files into structured objects.
 * Enhanced version that preserves raw text blocks for deployment.
 *
 * Handles:
 * - Tab-based indentation (semantic)
 * - Single-quote escaping for names
 * - Multi-line expressions (= assignment)
 * - Property assignments (: assignment)
 * - Boolean shorthand (property alone = true)
 * - ref keyword for collection ordering
 * - Backtick-verbatim blocks
 * - RAW TEXT preservation per object block (for deployment)
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse a single TMDL file into a list of object declarations.
 * @param {string} content - File content
 * @param {string} filePath - For error reporting
 * @returns {Array} Array of parsed objects (each with .rawBlock preserving original text)
 */
function parseTmdlFile(content, filePath) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const objects = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const indent = getIndentLevel(line);
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('---')) {
            i++;
            continue;
        }

        if (indent === 0) {
            const parsed = parseObjectBlock(lines, i, 0, filePath);
            if (parsed) {
                objects.push(parsed.object);
                i = parsed.nextLine;
            } else {
                i++;
            }
        } else {
            i++;
        }
    }

    return objects;
}

/**
 * Parse an object block starting at the given line.
 * Preserves raw text (startLine..endLine) for deployment purposes.
 */
function parseObjectBlock(lines, startLine, baseIndent, filePath) {
    const line = lines[startLine];
    const trimmed = line.trim();

    // Check for ref keyword
    if (trimmed.startsWith('ref ')) {
        const parts = trimmed.split(/\s+/);
        return {
            object: {
                type: 'ref',
                refType: parts[1],
                refName: extractName(trimmed.substring(trimmed.indexOf(parts[1]) + parts[1].length).trim()),
                line: startLine + 1,
                startLine,
                endLine: startLine + 1
            },
            nextLine: startLine + 1
        };
    }

    // Parse object declaration
    const declaration = parseDeclaration(trimmed);
    if (!declaration) return null;

    const obj = {
        type: declaration.type,
        name: declaration.name,
        properties: {},
        children: [],
        expression: null,
        line: startLine + 1,
        startLine,
        endLine: startLine + 1,
        file: filePath
    };

    if (declaration.hasExpression) {
        obj.expression = declaration.expressionValue;
    }

    // Parse child properties and nested objects
    let i = startLine + 1;
    while (i < lines.length) {
        const childLine = lines[i];
        const childIndent = getIndentLevel(childLine);
        const childTrimmed = childLine.trim();

        if (childTrimmed && childIndent <= baseIndent) break;
        if (!childTrimmed) { i++; continue; }

        if (childIndent === baseIndent + 1) {
            // 1. Nested object declaration
            if (isObjectDeclaration(childTrimmed)) {
                const childParsed = parseObjectBlock(lines, i, baseIndent + 1, filePath);
                if (childParsed) {
                    obj.children.push(childParsed.object);
                    i = childParsed.nextLine;
                    continue;
                }
                i++;
            } else if (childTrimmed.includes(':') && !childTrimmed.startsWith("'")) {
                // 2. Property assignment (key: value)
                const prop = parseProperty(childTrimmed);
                if (prop) obj.properties[prop.name] = prop.value;
                i++;
            } else if (childTrimmed.includes(' =') || childTrimmed.endsWith(' =')) {
                // 3. Multi-line expression property
                const exprResult = parseMultiLineExpression(lines, i, baseIndent + 1);
                if (exprResult.propName) {
                    obj.properties[exprResult.propName] = exprResult.value;
                }
                i = exprResult.nextLine;
            } else if (isBooleanShorthand(childTrimmed)) {
                obj.properties[childTrimmed] = 'true';
                i++;
            } else {
                if (obj.expression !== null || declaration.hasExpression) {
                    const exprLines = [childTrimmed];
                    i++;
                    while (i < lines.length) {
                        const nextLine = lines[i];
                        const nextIndent = getIndentLevel(nextLine);
                        const nextTrimmed = nextLine.trim();
                        if (!nextTrimmed) { i++; continue; }
                        if (nextIndent > baseIndent + 1) {
                            exprLines.push(nextTrimmed);
                            i++;
                        } else break;
                    }
                    obj.expression = obj.expression
                        ? obj.expression + '\n' + exprLines.join('\n')
                        : exprLines.join('\n');
                } else {
                    i++;
                }
            }
        } else if (childIndent > baseIndent + 1) {
            if (obj.expression === null && !declaration.hasExpression) {
                obj.expression = childTrimmed;
            } else if (obj.expression !== null) {
                obj.expression += '\n' + childTrimmed;
            }
            i++;
        } else {
            break;
        }
    }

    obj.endLine = i;
    // Store raw block text
    obj.rawBlock = lines.slice(startLine, i).join('\n');

    return { object: obj, nextLine: i };
}

/**
 * Parse a multi-line expression starting with `propName =` or just `=`
 */
function parseMultiLineExpression(lines, startLine, baseIndent) {
    const line = lines[startLine].trim();
    let propName = null;
    let firstLineValue = '';

    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
        propName = line.substring(0, eqIdx).trim();
        firstLineValue = line.substring(eqIdx + 1).trim();
    }

    const exprLines = [];
    if (firstLineValue) exprLines.push(firstLineValue);

    let i = startLine + 1;
    while (i < lines.length) {
        const nextLine = lines[i];
        const nextIndent = getIndentLevel(nextLine);
        const nextTrimmed = nextLine.trim();

        if (!nextTrimmed) { exprLines.push(''); i++; continue; }
        if (nextIndent > baseIndent) { exprLines.push(nextTrimmed); i++; }
        else break;
    }

    return { propName, value: exprLines.join('\n').trim(), nextLine: i };
}

/**
 * Parse a declaration line like "table 'Sales Amount'" or "measure Total ="
 * Also handles bare keywords without names (e.g. "calculationGroup", "translations")
 */
function parseDeclaration(line) {
    // Handle bare keyword (no name, no expression) — e.g. "calculationGroup", "translations"
    const bareMatch = line.match(/^(\w+)$/);
    if (bareMatch) {
        const type = bareMatch[1].toLowerCase();
        if (type === 'ref') return null;
        return { type, name: '', hasExpression: false, expressionValue: '' };
    }

    const match = line.match(/^(\w+)\s+(.+?)(?:\s*=\s*(.*))?$/);
    if (!match) return null;

    const type = match[1].toLowerCase();
    const nameAndRest = match[2];
    const exprPart = match[3];

    if (type === 'ref') return null;

    const name = extractName(nameAndRest.replace(/\s*=\s*$/, '').trim());

    return {
        type,
        name,
        hasExpression: exprPart !== undefined || nameAndRest.endsWith('='),
        expressionValue: exprPart || ''
    };
}

function parseProperty(line) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) return null;
    return { name: line.substring(0, colonIdx).trim(), value: line.substring(colonIdx + 1).trim() };
}

function extractName(str) {
    str = str.trim();
    if (str.startsWith("'") && str.endsWith("'")) {
        return str.slice(1, -1).replace(/''/g, "'");
    }
    if (str.endsWith('=')) {
        str = str.slice(0, -1).trim();
        if (str.startsWith("'") && str.endsWith("'")) {
            return str.slice(1, -1).replace(/''/g, "'");
        }
    }
    return str;
}

function isObjectDeclaration(line) {
    const objectTypes = [
        'table', 'column', 'measure', 'hierarchy', 'level',
        'partition', 'relationship', 'role', 'tablepermission',
        'columnpermission', 'member', 'perspective', 'perspectivetable',
        'perspectivemeasure', 'perspectivecolumn', 'perspectivehierarchy',
        'cultureinfo', 'culture', 'expression', 'datasource', 'function',
        'database', 'model', 'calculationgroup', 'calculationitem',
        'kpi', 'annotation', 'extendedproperty', 'alternateof',
        'translations', 'linguisticmetadata'
    ];
    return objectTypes.includes(line.split(/\s+/)[0].toLowerCase());
}

function isBooleanShorthand(line) {
    const boolProps = [
        'isHidden', 'isPrivate', 'isKey', 'isNullable', 'isUnique',
        'isActive', 'showAsVariationsOnly', 'isAvailableInMDX',
        'isDefaultLabel', 'isDefaultImage', 'isNameInferred',
        'isDataTypeInferred', 'excludeFromModelRefresh',
        'refreshBookmarkDataOnly'
    ];
    return boolProps.includes(line.trim());
}

function getIndentLevel(line) {
    let count = 0;
    for (const ch of line) {
        if (ch === '\t') count++;
        else break;
    }
    return count;
}

/**
 * Quote a TMDL name if necessary.
 */
function quoteName(name) {
    if (/[\s.=:']/.test(name)) {
        return "'" + name.replace(/'/g, "''") + "'";
    }
    return name;
}

module.exports = { parseTmdlFile, extractName, getIndentLevel, quoteName, isObjectDeclaration };
