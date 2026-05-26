/**
 * TMDL Writer — Manipulates TMDL file content for deployment operations.
 * 
 * Operations:
 * - Append an object block to a file (add measure/column to table, add relationship)
 * - Remove an object block from a file (remove measure/column, remove relationship)
 * - Replace an object block in a file (modify measure/column/relationship)
 * 
 * Works at the raw text level using indentation-based block detection.
 */

const { getIndentLevel, isObjectDeclaration, quoteName } = require('../parser/tmdl-parser');

/**
 * Find the line range of a child object within a file's content.
 * Used to locate a specific measure/column/partition/etc. inside a table file.
 * 
 * @param {string} content - File content
 * @param {string} objectType - e.g. 'measure', 'column', 'partition'
 * @param {string} objectName - The object name to find
 * @param {number} parentIndent - Indentation level of the parent (0 for top-level, 1 for table children)
 * @returns {{ startLine: number, endLine: number, block: string } | null}
 */
function findObjectBlock(content, objectType, objectName, parentIndent) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const targetIndent = parentIndent + 1;
    const quotedName = quoteName(objectName);
    
    // Build possible patterns for matching
    const patterns = [
        `${objectType} ${quotedName}`,
        `${objectType} ${objectName}`
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const indent = getIndentLevel(line);
        const trimmed = line.trim();

        if (indent !== targetIndent) continue;

        // Check if this line matches our target object
        const matchesPattern = patterns.some(p => 
            trimmed === p || 
            trimmed.startsWith(p + ' ') || 
            trimmed.startsWith(p + '\t') ||
            trimmed === p + ' =' ||
            trimmed.startsWith(p + ' =')
        );

        if (!matchesPattern) continue;

        // Found the start — look backwards for /// description lines at same indent
        let blockStart = i;
        while (blockStart > 0) {
            const prevLine = lines[blockStart - 1];
            const prevTrimmed = prevLine.trim();
            const prevIndent = getIndentLevel(prevLine);
            if (prevIndent === targetIndent && prevTrimmed.startsWith('///')) {
                blockStart--;
            } else {
                break;
            }
        }

        // Find the end
        const startLine = blockStart;
        let endLine = i + 1;
        while (endLine < lines.length) {
            const nextLine = lines[endLine];
            const nextTrimmed = nextLine.trim();
            if (!nextTrimmed) { endLine++; continue; }
            const nextIndent = getIndentLevel(nextLine);
            if (nextIndent <= targetIndent) break;
            endLine++;
        }

        // Skip trailing blank lines
        while (endLine > startLine + 1 && !lines[endLine - 1].trim()) {
            endLine--;
        }

        return {
            startLine,
            endLine,
            block: lines.slice(startLine, endLine).join('\n')
        };
    }

    return null;
}

/**
 * Find a top-level object block (indent 0) by type and name.
 */
function findTopLevelBlock(content, objectType, objectName) {
    return findObjectBlock(content, objectType, objectName, -1);
}

/**
 * Remove an object block from file content.
 * @returns {string} Modified file content
 */
function removeObjectBlock(content, objectType, objectName, parentIndent) {
    const location = findObjectBlock(content, objectType, objectName, parentIndent);
    if (!location) return content;

    const lines = content.replace(/\r\n/g, '\n').split('\n');
    
    // Also remove a blank line after the block if present
    let endLine = location.endLine;
    if (endLine < lines.length && !lines[endLine].trim()) {
        endLine++;
    }

    lines.splice(location.startLine, endLine - location.startLine);
    return lines.join('\n');
}

/**
 * Replace an object block in file content with new content.
 * Preserves `lineageTag` values from the existing target block to avoid breaking
 * report bindings (PBIR visuals bind to model objects by lineageTag, not by name).
 * @returns {string} Modified file content
 */
function replaceObjectBlock(content, objectType, objectName, parentIndent, newBlock) {
    const location = findObjectBlock(content, objectType, objectName, parentIndent);
    if (!location) return content;

    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const oldBlock = lines.slice(location.startLine, location.endLine).join('\n');
    const mergedBlock = preserveLineageTags(oldBlock, newBlock);
    const newBlockLines = mergedBlock.split('\n');

    lines.splice(location.startLine, location.endLine - location.startLine, ...newBlockLines);
    return lines.join('\n');
}

const DECL_KEYWORDS_RE = /^(table|column|measure|hierarchy|level|partition|relationship|role|tablepermission|columnpermission|member|perspective|perspectivetable|perspectivemeasure|perspectivecolumn|perspectivehierarchy|cultureinfo|culture|expression|function|model|calculationgroup|calculationitem|dataSource|annotation|extendedproperty|kpi|alternateof|translations|linguisticmetadata|database)\b/i;

/**
 * Collect map of "indent|declaration" -> lineageTag value from a TMDL block.
 */
function collectLineageTags(block) {
    const lines = block.replace(/\r\n/g, '\n').split('\n');
    const tags = new Map();
    const stack = []; // [[indent, declTrimmed], ...]
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const indent = getIndentLevel(line);
        while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
        const tagMatch = trimmed.match(/^lineageTag:\s*(.+?)\s*$/);
        if (tagMatch) {
            const parent = stack.length ? stack[stack.length - 1] : null;
            if (parent) tags.set(parent[0] + '|' + parent[1], tagMatch[1]);
            continue;
        }
        if (DECL_KEYWORDS_RE.test(trimmed)) {
            const decl = trimmed.replace(/\s*=.*$/, '').trim();
            stack.push([indent, decl]);
        }
    }
    return tags;
}

/**
 * Rewrite a new block: replace lineageTag values with values from oldTags
 * where the parent declaration matches (same indent + same declaration line).
 */
function preserveLineageTags(oldBlock, newBlock) {
    if (!oldBlock || !newBlock) return newBlock;
    const oldTags = collectLineageTags(oldBlock);
    if (oldTags.size === 0) return newBlock;

    const lines = newBlock.replace(/\r\n/g, '\n').split('\n');
    const stack = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;
        const indent = getIndentLevel(line);
        while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
        const tagMatch = trimmed.match(/^(lineageTag:\s*)(.+?)\s*$/);
        if (tagMatch) {
            const parent = stack.length ? stack[stack.length - 1] : null;
            if (parent) {
                const key = parent[0] + '|' + parent[1];
                if (oldTags.has(key)) {
                    const indentStr = line.substring(0, line.length - line.trimStart().length);
                    lines[i] = indentStr + tagMatch[1] + oldTags.get(key);
                }
            }
            continue;
        }
        if (DECL_KEYWORDS_RE.test(trimmed)) {
            const decl = trimmed.replace(/\s*=.*$/, '').trim();
            stack.push([indent, decl]);
        }
    }
    return lines.join('\n');
}

/**
 * Append an object block to a file at the end (top-level objects like relationships/expressions).
 * @returns {string} Modified file content
 */
function appendTopLevelBlock(content, newBlock) {
    content = content.replace(/\r\n/g, '\n');
    // Ensure file ends with newline, then add blank line separator
    if (!content.endsWith('\n')) content += '\n';
    content += '\n' + newBlock + '\n';
    return content;
}

/**
 * Append a child object block to a table file (inside the table's children).
 * Adds the block at the appropriate indentation at the end of the table's children.
 * @param {string} content - The table file content
 * @param {string} childBlock - The raw block of the child (from DEV) already indented correctly
 * @returns {string} Modified file content
 */
function appendChildBlock(content, childBlock) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    
    // Find the last non-empty line that belongs to the table content
    let insertPos = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim()) {
            insertPos = i + 1;
            break;
        }
    }

    // Add a blank line separator before the new block
    const newLines = ['', ...childBlock.split('\n')];
    lines.splice(insertPos, 0, ...newLines);
    return lines.join('\n');
}

/**
 * Add a ref entry to model.tmdl for a new table/role/culture.
 * @param {string} content - model.tmdl content
 * @param {string} refType - 'table', 'role', 'culture', 'perspective'
 * @param {string} refName - Object name
 * @returns {string} Modified content
 */
function addRefEntry(content, refType, refName) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const quotedName = quoteName(refName);
    const refLine = `\tref ${refType} ${quotedName}`;
    
    // Check if ref already exists
    for (const line of lines) {
        if (line.trim() === `ref ${refType} ${quotedName}` || line.trim() === `ref ${refType} ${refName}`) {
            return content; // Already exists
        }
    }

    // Find the last ref line of the same type and insert after it
    let lastRefIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith(`ref ${refType} `)) {
            lastRefIdx = i;
        }
    }

    if (lastRefIdx >= 0) {
        lines.splice(lastRefIdx + 1, 0, refLine);
    } else {
        // No existing refs of this type — append at end of file
        let insertIdx = lines.length;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim()) { insertIdx = i + 1; break; }
        }
        lines.splice(insertIdx, 0, refLine);
    }

    return lines.join('\n');
}

/**
 * Remove a ref entry from model.tmdl.
 */
function removeRefEntry(content, refType, refName) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const quotedName = quoteName(refName);
    
    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed !== `ref ${refType} ${quotedName}` && trimmed !== `ref ${refType} ${refName}`;
    });

    return filtered.join('\n');
}

module.exports = {
    findObjectBlock,
    findTopLevelBlock,
    removeObjectBlock,
    replaceObjectBlock,
    appendTopLevelBlock,
    appendChildBlock,
    addRefEntry,
    removeRefEntry
};
