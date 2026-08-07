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
    let pendingDescription = [];

    while (i < lines.length) {
        const line = lines[i];
        const indent = getIndentLevel(line);
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('---')) {
            i++;
            pendingDescription = [];
            continue;
        }

        // Collect /// description lines for the next object
        if (trimmed.startsWith('///')) {
            pendingDescription.push(trimmed.substring(3).trim());
            i++;
            continue;
        }

        // Skip regular comments (// but not ///)
        if (trimmed.startsWith('//')) {
            i++;
            pendingDescription = [];
            continue;
        }

        if (indent === 0) {
            const parsed = parseObjectBlock(lines, i, 0, filePath);
            if (parsed) {
                if (pendingDescription.length > 0) {
                    parsed.object.properties.description = pendingDescription.join('\n');
                    // Include /// lines in rawBlock for deployment
                    const descPrefix = pendingDescription.map(d => `/// ${d}`).join('\n');
                    parsed.object.rawBlock = descPrefix + '\n' + parsed.object.rawBlock;
                    pendingDescription = [];
                }
                objects.push(parsed.object);
                i = parsed.nextLine;
            } else {
                i++;
                pendingDescription = [];
            }
        } else {
            i++;
            pendingDescription = [];
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
                // refs carry no body, but a preceding `///` comment still writes a
                // description onto the object — keep the bag so that never throws.
                properties: {},
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
    let pendingDescription = [];
    while (i < lines.length) {
        const childLine = lines[i];
        const childIndent = getIndentLevel(childLine);
        const childTrimmed = childLine.trim();

        if (childTrimmed && childIndent <= baseIndent) break;
        if (!childTrimmed) { i++; pendingDescription = []; continue; }

        if (childIndent === baseIndent + 1) {
            // Collect /// description lines for the next child object
            if (childTrimmed.startsWith('///')) {
                pendingDescription.push(childTrimmed.substring(3).trim());
                i++;
                continue;
            }
            // Skip regular comments
            if (childTrimmed.startsWith('//')) {
                i++;
                pendingDescription = [];
                continue;
            }
            // 1. Nested object declaration
            if (isObjectDeclaration(childTrimmed)) {
                const childParsed = parseObjectBlock(lines, i, baseIndent + 1, filePath);
                if (childParsed) {
                    if (pendingDescription.length > 0) {
                        childParsed.object.properties.description = pendingDescription.join('\n');
                        // Include /// lines in rawBlock for deployment
                        const indent = '\t'.repeat(baseIndent + 1);
                        const descPrefix = pendingDescription.map(d => `${indent}/// ${d}`).join('\n');
                        childParsed.object.rawBlock = descPrefix + '\n' + childParsed.object.rawBlock;
                        pendingDescription = [];
                    }
                    obj.children.push(childParsed.object);
                    i = childParsed.nextLine;
                    continue;
                }
                i++;
                pendingDescription = [];
            } else if (PROP_COLON_RE.test(childTrimmed)) {
                // 2. Property assignment (key: value).
                //    A TMDL property name is a single identifier, so a DAX/M line that
                //    merely contains a colon (e.g. `IF(x, "a:b", "c")`) is not a property.
                const prop = parseProperty(childTrimmed);
                if (prop) obj.properties[prop.name] = prop.value;
                i++;
                pendingDescription = [];
            } else if (PROP_ASSIGN_RE.test(childTrimmed)) {
                // 3. Multi-line expression property (`propName = ...`). Same rule:
                //    the left side must be a single identifier, otherwise a DAX
                //    continuation line such as `VAR x = 1` would be swallowed as a
                //    property and truncate the expression.
                const exprResult = parseMultiLineExpression(lines, i, baseIndent + 1);
                if (exprResult.propName) {
                    obj.properties[exprResult.propName] = exprResult.value;
                }
                i = exprResult.nextLine;
                pendingDescription = [];
            } else if (isBooleanShorthand(childTrimmed)) {
                obj.properties[childTrimmed] = 'true';
                i++;
                pendingDescription = [];
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
                pendingDescription = [];
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
 * A TMDL property name is a single identifier. Both regexes anchor on that so a
 * DAX/M continuation line is never mistaken for a property assignment.
 */
const PROP_COLON_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*:/;
const PROP_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

/**
 * Split a declaration line at the first `=` that sits OUTSIDE a quoted name.
 * `measure 'A = B' = 1 + 1` must split after the quoted name, not inside it.
 * @returns {{ head: string, expr: string, hasExpr: boolean }}
 */
function splitDeclaration(line) {
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'") {
            if (inQuote && line[i + 1] === "'") { i++; continue; } // '' = escaped quote
            inQuote = !inQuote;
            continue;
        }
        if (!inQuote && ch === '=') {
            return { head: line.substring(0, i).trim(), expr: line.substring(i + 1).trim(), hasExpr: true };
        }
    }
    return { head: line.trim(), expr: '', hasExpr: false };
}

/**
 * Parse a declaration line like "table 'Sales Amount'" or "measure Total ="
 * Also handles bare keywords without names (e.g. "calculationGroup", "translations")
 * and bare keywords carrying an expression (e.g. "formatStringDefinition =").
 */
function parseDeclaration(line) {
    // Handle bare keyword (no name, no expression) — e.g. "calculationGroup", "translations"
    const bareMatch = line.match(/^(\w+)$/);
    if (bareMatch) {
        const type = bareMatch[1].toLowerCase();
        if (type === 'ref') return null;
        return { type, name: '', hasExpression: false, expressionValue: '' };
    }

    const { head, expr, hasExpr } = splitDeclaration(line);

    const named = head.match(/^(\w+)\s+(.+)$/);
    if (!named) {
        // Bare keyword with an expression — e.g. `formatStringDefinition =`
        const kw = head.match(/^(\w+)$/);
        if (kw && hasExpr) {
            const type = kw[1].toLowerCase();
            if (type === 'ref') return null;
            return { type, name: '', hasExpression: true, expressionValue: expr };
        }
        return null;
    }

    const type = named[1].toLowerCase();
    if (type === 'ref') return null;

    return {
        type,
        name: extractName(named[2].trim()),
        hasExpression: hasExpr,
        expressionValue: expr
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

const OBJECT_TYPES = [
    'table', 'column', 'measure', 'hierarchy', 'level',
    'partition', 'relationship', 'role', 'tablepermission',
    'columnpermission', 'member', 'perspective', 'perspectivetable',
    'perspectivemeasure', 'perspectivecolumn', 'perspectivehierarchy',
    'cultureinfo', 'culture', 'expression', 'datasource', 'function',
    'database', 'model', 'calculationgroup', 'calculationitem',
    'kpi', 'annotation', 'extendedproperty', 'alternateof',
    'translations', 'linguisticmetadata',
    // Blocks below were missing: their bodies leaked into the parent object's
    // `expression`, which made every property they carry invisible to the diff.
    'refreshpolicy',            // incremental refresh windows
    'variation',                // auto date/time column variations
    'dataaccessoptions',        // model-level data access flags
    'datacoveragepermission',   // tablePermission data coverage
    'formatstringdefinition',   // dynamic format strings (DAX)
    'detailrowsdefinition',     // detail rows expressions (DAX)
    'connectiondetails',        // dataSource connection (server, database, protocol)
    'credential'                // dataSource credential settings
];

function isObjectDeclaration(line) {
    return OBJECT_TYPES.includes(line.split(/\s+/)[0].toLowerCase());
}

function isBooleanShorthand(line) {
    const boolProps = [
        'isHidden', 'isPrivate', 'isKey', 'isNullable', 'isUnique',
        'isActive', 'showAsVariationsOnly', 'isAvailableInMDX',
        'isDefaultLabel', 'isDefaultImage', 'isNameInferred',
        'isDataTypeInferred', 'excludeFromModelRefresh',
        'refreshBookmarkDataOnly', 'discourageImplicitMeasures'
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
 *
 * A bare TMDL identifier is `[A-Za-z_][A-Za-z0-9_]*`. Anything else — spaces,
 * dots, parentheses, %, -, +, commas, a leading digit — must be quoted, or the
 * emitted `ref` / declaration line is invalid and the object cannot be found
 * again on remove. Quoting more than strictly required is always safe.
 */
function quoteName(name) {
    const str = String(name == null ? '' : name);
    if (str === '') return '';
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(str)) return str;
    return "'" + str.replace(/'/g, "''") + "'";
}

module.exports = {
    parseTmdlFile, extractName, getIndentLevel, quoteName,
    isObjectDeclaration, parseDeclaration, splitDeclaration, OBJECT_TYPES
};
