/**
 * Identity keys — the single place where an object's comparison identity is built.
 *
 * Two rules the rest of the codebase must not re-implement:
 *
 * 1. UNAMBIGUOUS SEPARATOR. `type:parent.name` collides whenever a name contains
 *    a dot: table `A` + column `B.C` and table `A.B` + column `C` both produced
 *    `column:A.B.C`, and the later object silently overwrote the earlier one.
 *    Each part is escaped (`\` -> `\\`, `.` -> `\.`) before joining, so the parts
 *    are always recoverable and can never collide.
 *
 * 2. CASE-INSENSITIVE. Analysis Services treats object names as
 *    case-insensitive-unique, so `Total Sales` and `Total SALES` are the SAME
 *    object, not an Add + Remove pair. Keys are folded to lower case; extractors
 *    additionally publish the real name as a compared `name` property, so a
 *    case-only rename still surfaces as a modify instead of vanishing.
 */

function fold(value) {
    return String(value == null ? '' : value).toLowerCase();
}

function escapePart(value) {
    return fold(value).replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

/** Key for a top-level object: table, role, expression, perspective, culture… */
function rootKey(type, name) {
    return `${type}:${escapePart(name)}`;
}

/** Key for an object owned by another one: column, measure, tablePermission… */
function childKey(type, parent, name) {
    return `${type}:${escapePart(parent)}.${escapePart(name)}`;
}

module.exports = { rootKey, childKey, fold, escapePart };
