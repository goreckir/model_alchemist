/**
 * Expression references — best-effort scanners that find which model-level
 * names a DAX or Power Query (M) expression uses.
 *
 * They are lexical, not full parsers: they skip string literals, comments and
 * the places where a name is only a label (DAX column refs, M field access,
 * M step and lambda parameter names), and report every remaining identifier
 * that matches one of the candidate names. Callers pass only names the model
 * defines (functions, named expressions, tables), so built-in DAX and M
 * functions can never be reported.
 */

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_.]/;

/** Build a case-insensitive lookup: lower-cased name -> real name. */
function nameIndex(names) {
    const index = new Map();
    for (const name of names) {
        if (name) index.set(String(name).toLowerCase(), name);
    }
    return index;
}

/** Skip a delimited literal whose closing char is escaped by doubling it. */
function skipDoubled(text, i, close) {
    i++;
    while (i < text.length) {
        if (text[i] === close) {
            if (text[i + 1] === close) { i += 2; continue; }
            return i + 1;
        }
        i++;
    }
    return i;
}

function skipLineComment(text, i) {
    const end = text.indexOf('\n', i);
    return end < 0 ? text.length : end;
}

function skipBlockComment(text, i) {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
}

/**
 * Names of user-defined functions that a DAX expression calls.
 * A call is an identifier directly followed by `(`. Strings, comments,
 * 'quoted table names' and [column refs] are skipped.
 *
 * @param {string} expr
 * @param {Iterable<string>} functionNames - candidate function names
 * @returns {string[]} real names of the functions called, in first-use order
 */
function findDaxFunctionCalls(expr, functionNames) {
    const index = nameIndex(functionNames);
    const found = new Set();
    const text = String(expr || '');
    if (index.size === 0 || !text) return [];

    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '"') { i = skipDoubled(text, i, '"'); continue; }
        if (ch === "'") { i = skipDoubled(text, i, "'"); continue; }
        if (ch === '[') { i = skipDoubled(text, i, ']'); continue; }
        if ((ch === '/' && next === '/') || (ch === '-' && next === '-')) { i = skipLineComment(text, i); continue; }
        if (ch === '/' && next === '*') { i = skipBlockComment(text, i); continue; }
        if (IDENT_START.test(ch)) {
            let end = i + 1;
            while (end < text.length && IDENT_CHAR.test(text[end])) end++;
            const name = text.slice(i, end);
            let k = end;
            while (k < text.length && /\s/.test(text[k])) k++;
            if (text[k] === '(' && index.has(name.toLowerCase())) found.add(index.get(name.toLowerCase()));
            i = end;
            continue;
        }
        i++;
    }
    return [...found];
}

/**
 * Tokenise M into identifiers, skipping strings and comments.
 * Dotted names (`Table.Buffer`) are one token, so library functions never
 * match a model name. `#date`-style keywords are skipped.
 */
function mTokens(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '/' && next === '/') { i = skipLineComment(text, i); continue; }
        if (ch === '/' && next === '*') { i = skipBlockComment(text, i); continue; }
        if (ch === '#' && next === '"') {
            const end = skipDoubled(text, i + 1, '"');
            const name = text.slice(i + 2, end - 1).replace(/""/g, '"');
            tokens.push({ name, start: i, end });
            i = end;
            continue;
        }
        if (ch === '"') { i = skipDoubled(text, i, '"'); continue; }
        if (ch === '#' && next && IDENT_START.test(next)) {
            i++;
            while (i < text.length && IDENT_CHAR.test(text[i])) i++;
            continue;
        }
        if (IDENT_START.test(ch)) {
            let end = i + 1;
            while (end < text.length && IDENT_CHAR.test(text[end])) end++;
            tokens.push({ name: text.slice(i, end), start: i, end });
            i = end;
            continue;
        }
        tokens.push({ punct: ch, start: i, end: i + 1 });
        i++;
    }
    return tokens.filter(t => t.name !== undefined || !/\s/.test(t.punct));
}

/**
 * Model-level names (named expressions, parameters, table queries) that a
 * Power Query expression references, either as `#"Quoted Name"` or as a bare
 * identifier. Names the expression defines itself are not references: let
 * steps and record fields (`Name =`), lambda parameters (`(a, b) =>`) and
 * field access (`[Name]`).
 *
 * @param {string} expr
 * @param {Iterable<string>} names - candidate model-level names
 * @returns {string[]} real names referenced, in first-use order
 */
function findMReferences(expr, names) {
    const index = nameIndex(names);
    const text = String(expr || '');
    if (index.size === 0 || !text) return [];

    const tokens = mTokens(text);
    const locals = new Set();
    const isPunct = (t, p) => t && t.punct === p;

    for (let n = 0; n < tokens.length; n++) {
        const t = tokens[n];
        // `Name =` but not `Name =>`: a let step or a record field.
        if (t.name !== undefined && isPunct(tokens[n + 1], '=') && !isPunct(tokens[n + 2], '>')) {
            locals.add(t.name.toLowerCase());
        }
        // `( ... ) =>`: every identifier inside the parentheses is a parameter
        // (or a type name after `as`, which is harmless to ignore).
        if (isPunct(t, ')') && isPunct(tokens[n + 1], '=') && isPunct(tokens[n + 2], '>')) {
            let depth = 0;
            for (let k = n; k >= 0; k--) {
                if (isPunct(tokens[k], ')')) depth++;
                else if (isPunct(tokens[k], '(')) { depth--; if (depth === 0) break; }
                else if (tokens[k].name !== undefined && depth === 1) locals.add(tokens[k].name.toLowerCase());
            }
        }
    }

    const found = new Set();
    for (let n = 0; n < tokens.length; n++) {
        const t = tokens[n];
        if (t.name === undefined) continue;
        const key = t.name.toLowerCase();
        if (!index.has(key) || locals.has(key)) continue;
        if (isPunct(tokens[n - 1], '[') && isPunct(tokens[n + 1], ']')) continue; // field access
        found.add(index.get(key));
    }
    return [...found];
}

module.exports = { findDaxFunctionCalls, findMReferences };
