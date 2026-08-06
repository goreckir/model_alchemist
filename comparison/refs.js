/**
 * TMDL reference parsing — one implementation, used by the engine, the validator
 * and the deployer.
 *
 * A column reference is `Table.Column`, `'Table Name'.Column`, `Table.'Col Name'`
 * or `'Table'.'Col'`, and a quoted name escapes an apostrophe by doubling it.
 * Naive handling (keeping the quotes, or stripping every quote before splitting)
 * produced two separate defects: relationship endpoints never matched their
 * column diffs, and a table-removal cascade removed relationships belonging to
 * unrelated tables whose names merely shared a prefix.
 */

/** Strip surrounding quotes and unescape doubled apostrophes. */
function unquote(value) {
    if (value == null) return null;
    const str = String(value).trim();
    if (str.length >= 2 && str.startsWith("'") && str.endsWith("'")) {
        return str.slice(1, -1).replace(/''/g, "'");
    }
    return str;
}

/** Read one (optionally quoted) name starting at `pos`. */
function readName(str, pos) {
    if (str[pos] === "'") {
        let out = '';
        let i = pos + 1;
        while (i < str.length) {
            if (str[i] === "'") {
                if (str[i + 1] === "'") { out += "'"; i += 2; continue; }
                return { name: out, next: i + 1 };
            }
            out += str[i];
            i++;
        }
        return { name: out, next: i }; // unterminated quote — best effort
    }
    const dot = str.indexOf('.', pos);
    if (dot < 0) return { name: str.substring(pos), next: str.length };
    return { name: str.substring(pos, dot), next: dot };
}

/**
 * Parse a column reference into its unquoted parts.
 * @returns {{ table: string|null, column: string|null }}
 */
function parseColumnRef(ref) {
    if (!ref) return { table: null, column: null };
    const str = String(ref).trim();

    const first = readName(str, 0);
    if (first.next >= str.length || str[first.next] !== '.') {
        return { table: null, column: first.name || null };
    }

    // Legacy unquoted ref carrying more than one dot ("Sales.EU.Amount"):
    // fall back to splitting at the LAST dot, which is what TMDL producers mean.
    if (str[0] !== "'" && str.indexOf('.', first.next + 1) >= 0) {
        const idx = str.lastIndexOf('.');
        return { table: unquote(str.substring(0, idx)), column: unquote(str.substring(idx + 1)) };
    }

    const second = readName(str, first.next + 1);
    return { table: first.name || null, column: second.name || null };
}

function tableFromColRef(ref) {
    return parseColumnRef(ref).table;
}

function colFromRef(ref) {
    return parseColumnRef(ref).column;
}

module.exports = { parseColumnRef, tableFromColRef, colFromRef, unquote, readName };
