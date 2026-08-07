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
    const name = objectName == null ? '' : String(objectName);
    const quotedName = quoteName(name);

    // Build possible patterns for matching. A bare declaration (`calculationGroup`
    // with no name) has no name part at all — without this the block could never
    // be found and every calculation-group remove/modify failed.
    const patterns = name === ''
        ? [objectType]
        : [`${objectType} ${quotedName}`, `${objectType} ${name}`];

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
function replaceObjectBlock(content, objectType, objectName, parentIndent, newBlock, mergeFn) {
    const location = findObjectBlock(content, objectType, objectName, parentIndent);
    if (!location) return content;

    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const oldBlock = lines.slice(location.startLine, location.endLine).join('\n');
    const mergedBlock = (mergeFn || mergeReplacementBlock)(oldBlock, newBlock);
    const newBlockLines = mergedBlock.split('\n');

    lines.splice(location.startLine, location.endLine - location.startLine, ...newBlockLines);
    return lines.join('\n');
}

const DECL_KEYWORDS_RE = /^(table|column|measure|hierarchy|level|partition|relationship|role|tablepermission|columnpermission|member|perspective|perspectivetable|perspectivemeasure|perspectivecolumn|perspectivehierarchy|cultureinfo|culture|expression|function|model|calculationgroup|calculationitem|dataSource|annotation|extendedproperty|kpi|alternateof|translations|linguisticmetadata|database)\b/i;

// Both per-environment identifiers. sourceLineageTag drives Fabric git integration
// and Direct Lake column mapping — overwriting it with DEV's value can silently
// rebind or break an object's source mapping, so it is preserved like lineageTag.
const LINEAGE_TAG_RE = /^(lineageTag|sourceLineageTag)(:\s*)(.+?)\s*$/;

/** Indentation prefix of a line, verbatim. */
function indentOf(line) {
    return line.substring(0, line.length - line.trimStart().length);
}

/**
 * Collect map of "indent|declaration|tagName" -> tag value from a TMDL block.
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
        const tagMatch = trimmed.match(LINEAGE_TAG_RE);
        if (tagMatch) {
            const parent = stack.length ? stack[stack.length - 1] : null;
            if (parent) tags.set(`${parent[0]}|${parent[1]}|${tagMatch[1]}`, tagMatch[3]);
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
 * Rewrite a new block: replace lineageTag / sourceLineageTag values with values
 * from oldTags where the parent declaration matches (same indent + declaration).
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
        const tagMatch = trimmed.match(LINEAGE_TAG_RE);
        if (tagMatch) {
            const parent = stack.length ? stack[stack.length - 1] : null;
            if (parent) {
                const key = `${parent[0]}|${parent[1]}|${tagMatch[1]}`;
                if (oldTags.has(key)) {
                    lines[i] = indentOf(line) + tagMatch[1] + tagMatch[2] + oldTags.get(key);
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

const PBI_ANNOTATION_RE = /^annotation\s+PBI_/i;

/**
 * Walk a block and report, for every line, the enclosing declaration key.
 * @returns {Array<{ indent: number, trimmed: string, parentKey: string|null }>}
 */
function walkBlock(lines) {
    const stack = [];
    return lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) {
            return { indent: getIndentLevel(line), trimmed, parentKey: stack.length ? stack[stack.length - 1][2] : null };
        }
        const indent = getIndentLevel(line);
        while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
        const parentKey = stack.length ? stack[stack.length - 1][2] : null;
        if (DECL_KEYWORDS_RE.test(trimmed) && !PBI_ANNOTATION_RE.test(trimmed)) {
            const decl = trimmed.replace(/\s*=.*$/, '').trim();
            stack.push([indent, decl, `${indent}|${decl}`]);
        }
        return { indent, trimmed, parentKey };
    });
}

/** Extract every `annotation PBI_*` block, grouped by enclosing declaration. */
function collectPbiAnnotations(block) {
    const lines = String(block).replace(/\r\n/g, '\n').split('\n');
    const walked = walkBlock(lines);
    const byParent = new Map();

    for (let i = 0; i < lines.length; i++) {
        if (!PBI_ANNOTATION_RE.test(walked[i].trimmed)) continue;
        const annIndent = walked[i].indent;
        let end = i + 1;
        while (end < lines.length) {
            const t = lines[end].trim();
            if (t && getIndentLevel(lines[end]) <= annIndent) break;
            end++;
        }
        while (end > i + 1 && !lines[end - 1].trim()) end--;
        const parent = walked[i].parentKey || '';
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(lines.slice(i, end));
        i = end - 1;
    }
    return byParent;
}

/**
 * Carry the TARGET's PBI_* annotations into a replacement block and drop the
 * source's.
 *
 * PBI_* annotations are Power BI engine runtime state (PBI_ResultType,
 * PBI_QueryOrder, PBI_FormatHint …). The extractor deliberately excludes them
 * from comparison, so shipping DEV's copies inside a raw block replacement
 * deployed a change the user never reviewed.
 */
function preserveTargetAnnotations(oldBlock, newBlock) {
    if (!oldBlock || !newBlock) return newBlock;
    const targetAnnotations = collectPbiAnnotations(oldBlock);

    // 1. Strip the source's PBI_* annotations.
    const srcLines = String(newBlock).replace(/\r\n/g, '\n').split('\n');
    const srcWalk = walkBlock(srcLines);
    const kept = [];
    const keptWalk = [];
    for (let i = 0; i < srcLines.length; i++) {
        if (PBI_ANNOTATION_RE.test(srcWalk[i].trimmed)) {
            const annIndent = srcWalk[i].indent;
            let end = i + 1;
            while (end < srcLines.length) {
                const t = srcLines[end].trim();
                if (t && getIndentLevel(srcLines[end]) <= annIndent) break;
                end++;
            }
            i = end - 1;
            continue;
        }
        kept.push(srcLines[i]);
        keptWalk.push(srcWalk[i]);
    }

    if (targetAnnotations.size === 0) return kept.join('\n');

    // 2. Re-insert the target's annotations at the end of the matching parent region.
    const insertions = [];
    for (const [parentKey, blocks] of targetAnnotations) {
        const parentIndent = parentKey === '' ? -1 : parseInt(parentKey.split('|')[0], 10);
        let insertAt = -1;
        for (let i = 0; i < kept.length; i++) {
            if (keptWalk[i].parentKey !== parentKey) continue;
            insertAt = i + 1;
        }
        if (insertAt < 0) {
            // Parent no longer exists in the replacement block — only re-attach
            // top-level annotations, otherwise the indentation would be wrong.
            if (parentKey !== '') continue;
            insertAt = kept.length;
        }
        void parentIndent;
        insertions.push({ at: insertAt, lines: blocks.flat() });
    }

    insertions.sort((a, b) => b.at - a.at);
    for (const insertion of insertions) {
        kept.splice(insertion.at, 0, ...insertion.lines);
    }
    return kept.join('\n');
}

/**
 * Full merge applied to every raw-block replacement: keep the target's
 * per-environment identifiers and its PBI_* runtime annotations.
 */
function mergeReplacementBlock(oldBlock, newBlock) {
    return preserveTargetAnnotations(oldBlock, preserveLineageTags(oldBlock, newBlock));
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
 * Map our internal refType to the TMDL ref keyword used in model.tmdl.
 * Power BI uses 'cultureInfo' (not 'culture') for culture references.
 */
function refKeyword(refType) {
    if (refType === 'culture') return 'cultureInfo';
    return refType; // table, role, perspective
}

/**
 * Detect the indentation prefix used by existing top-level `ref` statements.
 * Power BI Desktop conventionally emits them WITHOUT indentation (column 0),
 * but some files may indent them under `model Model`. We mirror what the
 * file currently uses; default to no indent (Power BI Desktop convention).
 */
function detectRefIndent(lines) {
    for (const line of lines) {
        const m = line.match(/^(\s*)ref\s+\S+\s+/);
        if (m) return m[1];
    }
    return ''; // top-level, matches Power BI Desktop output
}

/**
 * Add a ref entry to model.tmdl for a new table/role/culture/perspective.
 * @param {string} content - model.tmdl content
 * @param {string} refType - 'table', 'role', 'culture' (→ cultureInfo), 'perspective'
 * @param {string} refName - Object name
 * @returns {string} Modified content
 */
function addRefEntry(content, refType, refName) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const keyword = refKeyword(refType);
    const quotedName = quoteName(refName);
    const indent = detectRefIndent(lines);
    const refLine = `${indent}ref ${keyword} ${quotedName}`;

    // Check if ref already exists (any indentation)
    for (const line of lines) {
        const t = line.trim();
        if (t === `ref ${keyword} ${quotedName}` || t === `ref ${keyword} ${refName}`) {
            return content;
        }
    }

    // Find the last ref line of the same keyword and insert after it
    let lastRefIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith(`ref ${keyword} `)) {
            lastRefIdx = i;
        }
    }

    if (lastRefIdx >= 0) {
        lines.splice(lastRefIdx + 1, 0, refLine);
    } else {
        // No existing refs of this keyword — insert after last ref of any kind,
        // or append at end of file if none exist.
        let lastAnyRefIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('ref ')) lastAnyRefIdx = i;
        }
        if (lastAnyRefIdx >= 0) {
            lines.splice(lastAnyRefIdx + 1, 0, refLine);
        } else {
            let insertIdx = lines.length;
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i].trim()) { insertIdx = i + 1; break; }
            }
            lines.splice(insertIdx, 0, '', refLine);
        }
    }

    return lines.join('\n');
}

/**
 * Remove a ref entry from model.tmdl.
 */
function removeRefEntry(content, refType, refName) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const keyword = refKeyword(refType);
    const quotedName = quoteName(refName);

    const filtered = lines.filter(line => {
        const trimmed = line.trim();
        return trimmed !== `ref ${keyword} ${quotedName}` && trimmed !== `ref ${keyword} ${refName}`;
    });

    return filtered.join('\n');
}

/**
 * Extract the "header" portion of a table block: lines from the `table <name>` declaration
 * down to (but excluding) the first child object declaration at parent+1 indent.
 * Children are: column/measure/hierarchy/partition/calculationGroup/calculationItem.
 *
 * @param {string} content - Full file content containing the table block
 * @param {string} tableName - Table name (used to anchor the start)
 * @returns {{ headerStart: number, headerEnd: number, firstChildStart: number|null, blockStart: number, blockEnd: number, headerLines: string[] } | null}
 */
function findTableHeader(content, tableName) {
    return findBlockHeader(content, 'table', tableName,
        ['column', 'measure', 'hierarchy', 'partition', 'calculationGroup', 'calculationItem']);
}

/**
 * Generalised header locator: the declaration plus its scalar properties, down to
 * (but excluding) the first child declaration listed in `childKeywords`.
 * Used for tables and for roles, whose members and tablePermissions must survive
 * a header-only replacement.
 */
function findBlockHeader(content, keyword, name, childKeywords) {
    const block = findTopLevelBlock(content, keyword, name);
    if (!block) return null;
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    let firstChildStart = null;
    for (let i = block.startLine + 1; i <= block.endLine; i++) {
        const ln = lines[i];
        if (!ln || ln.trim() === '') continue;
        const indent = getIndentLevel(ln);
        if (indent !== 1) continue;
        const trimmed = ln.trim();
        const firstWord = trimmed.split(/[\s\t]/)[0];
        if (childKeywords.includes(firstWord)) {
            firstChildStart = i;
            break;
        }
    }
    const headerEnd = firstChildStart !== null ? firstChildStart - 1 : block.endLine;
    return {
        blockStart: block.startLine,
        blockEnd: block.endLine,
        headerStart: block.startLine,
        headerEnd,
        firstChildStart,
        headerLines: lines.slice(block.startLine, headerEnd + 1)
    };
}

/**
 * Replace ONLY the table header (declaration + table-level properties) in target content,
 * preserving all children (columns, measures, hierarchies, partitions...).
 *
 * @param {string} targetContent - Existing target file content
 * @param {string} devContent - DEV file content (header source)
 * @param {string} tableName
 * @returns {string} New target content with header replaced; throws if either block missing
 */
function replaceTableHeader(targetContent, devContent, tableName) {
    return replaceBlockHeader(targetContent, devContent, 'table', tableName,
        ['column', 'measure', 'hierarchy', 'partition', 'calculationGroup', 'calculationItem']);
}

/**
 * Replace ONLY a block's header, preserving its children and the target's
 * per-environment identifiers.
 *
 * The header splice used to insert DEV's lines verbatim, lineage tags included,
 * so a cosmetic isHidden toggle rewrote the target's lineageTag and broke PBIR
 * bindings and Fabric object identity.
 */
function replaceBlockHeader(targetContent, devContent, keyword, name, childKeywords) {
    const targetH = findBlockHeader(targetContent, keyword, name, childKeywords);
    const devH = findBlockHeader(devContent, keyword, name, childKeywords);
    if (!targetH) throw new Error(`${keyword} '${name}' not found in target content`);
    if (!devH) throw new Error(`${keyword} '${name}' not found in DEV content`);

    const targetLines = targetContent.replace(/\r\n/g, '\n').split('\n');
    const mergedHeader = mergeReplacementBlock(
        targetH.headerLines.join('\n'),
        devH.headerLines.join('\n')
    ).split('\n');

    const newLines = [
        ...targetLines.slice(0, targetH.headerStart),
        ...mergedHeader,
        ...targetLines.slice(targetH.headerEnd + 1)
    ];
    return newLines.join('\n');
}

/**
 * Build the replacement for a `model` block.
 *
 * `findObjectBlock` keeps indented lines inside the block, and `ref` entries may
 * legitimately be indented under `model Model`. Sending DEV's whole model block
 * therefore deleted every ref from the target — a dangling model. This keeps the
 * target's ref lines and its PBI_* annotations, and takes DEV's properties.
 */
function mergeModelBlock(targetBlock, devBlock) {
    const REF_RE = /^ref\s+\S+/;
    const targetLines = String(targetBlock).replace(/\r\n/g, '\n').split('\n');
    const targetRefs = targetLines.filter(l => REF_RE.test(l.trim()));

    const withoutDevRefs = String(devBlock).replace(/\r\n/g, '\n').split('\n')
        .filter(l => !REF_RE.test(l.trim()))
        .join('\n');

    let merged = mergeReplacementBlock(targetBlock, withoutDevRefs);
    if (targetRefs.length > 0) {
        const lines = merged.split('\n');
        while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
        merged = [...lines, ...targetRefs].join('\n');
    }
    return merged;
}

/**
 * Ensure a simple property is present (and set to a given value) inside the
 * top-level `model Model` block of model.tmdl. Inserts the property right
 * after the `model` declaration if missing, or replaces the value if present
 * with a different one. Property must be a single-line `name: value`.
 *
 * @param {string} content - model.tmdl content
 * @param {string} propName - e.g. 'discourageImplicitMeasures'
 * @param {string} propValue - e.g. 'true'
 * @returns {string} Possibly modified content
 */
function ensureTopLevelProperty(content, blockKeyword, propName, propValue) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const blockRe = new RegExp(`^${blockKeyword}\\b`);

    // Locate `<keyword> <name>` declaration at indent 0
    let blockStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const indent = getIndentLevel(lines[i]);
        const trimmed = lines[i].trim();
        if (indent === 0 && blockRe.test(trimmed)) {
            blockStart = i;
            break;
        }
    }
    if (blockStart < 0) return content; // no matching block — bail out

    // Determine end of block (first line at indent 0 after declaration, exclusive)
    let blockEnd = lines.length;
    for (let i = blockStart + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (getIndentLevel(lines[i]) === 0) {
            blockEnd = i;
            break;
        }
    }

    // Match both `propName: value` and TMDL boolean-shorthand `propName` (bare, meaning true).
    const propRe = new RegExp(`^\\s*${propName}\\s*:`);
    for (let i = blockStart + 1; i < blockEnd; i++) {
        const isColonForm = propRe.test(lines[i]);
        const isShorthandForm = lines[i].trim() === propName;
        if (isColonForm || isShorthandForm) {
            // Already present — replace value if differs
            const expected = `\t${propName}: ${propValue}`;
            if (lines[i] === expected || (isShorthandForm && propValue === 'true')) return content;
            lines[i] = expected;
            return lines.join('\n');
        }
    }

    // Not present — insert after block declaration
    lines.splice(blockStart + 1, 0, `\t${propName}: ${propValue}`);
    return lines.join('\n');
}

function ensureModelProperty(content, propName, propValue) {
    return ensureTopLevelProperty(content, 'model', propName, propValue);
}

/**
 * Append a child block nested inside a parent block at a given indent level.
 * Used for calculationItem (indent 2, inside calculationGroup at indent 1).
 * @param {string} content - The table file content
 * @param {string} childBlock - The raw block of the child (already at correct indentation)
 * @param {number} parentIndent - Indent level of the parent containing block (e.g. 1 for calculationGroup)
 * @returns {string} Modified file content
 */
function appendChildBlockNested(content, childBlock, parentIndent) {
    const lines = content.replace(/\r\n/g, '\n').split('\n');

    // Find the last occurrence of the parent block at the given indent
    // For calculationItem, parent is 'calculationGroup' at indent 1
    let parentStart = -1;
    for (let i = 0; i < lines.length; i++) {
        const indent = getIndentLevel(lines[i]);
        const trimmed = lines[i].trim();
        if (indent === parentIndent && DECL_KEYWORDS_RE.test(trimmed)) {
            // Check if this is the type of block that can contain our child
            const keyword = trimmed.split(/[\s\t]/)[0].toLowerCase();
            if (keyword === 'calculationgroup') {
                parentStart = i;
            }
        }
    }

    if (parentStart < 0) {
        // No calculationGroup in the target. Appending at the end of the file used
        // to nest the item under whatever the last block was, at the wrong indent,
        // producing TMDL Power BI cannot parse. Signal failure instead so the
        // deployer reports it rather than writing a broken model.
        return null;
    }

    // Find end of this parent block (first line at indent <= parentIndent after start)
    let insertPos = parentStart + 1;
    for (let i = parentStart + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) { insertPos = i + 1; continue; }
        const indent = getIndentLevel(lines[i]);
        if (indent <= parentIndent) break;
        insertPos = i + 1;
    }

    // Skip trailing blank lines within the block to insert before them
    while (insertPos > parentStart + 1 && !lines[insertPos - 1].trim()) {
        insertPos--;
    }

    const newLines = ['', ...childBlock.split('\n')];
    lines.splice(insertPos, 0, ...newLines);
    return lines.join('\n');
}

module.exports = {
    findObjectBlock,
    findTopLevelBlock,
    findTableHeader,
    findBlockHeader,
    removeObjectBlock,
    replaceObjectBlock,
    replaceTableHeader,
    replaceBlockHeader,
    appendTopLevelBlock,
    appendChildBlock,
    appendChildBlockNested,
    addRefEntry,
    removeRefEntry,
    ensureModelProperty,
    ensureTopLevelProperty,
    preserveLineageTags,
    preserveTargetAnnotations,
    mergeReplacementBlock,
    mergeModelBlock
};
