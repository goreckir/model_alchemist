/**
 * Raw-file snapshot comparison.
 *
 * A Fabric deploy seeds its working copy from the definition captured at COMPARE
 * time and then uploads EVERY file. The window between compare and deploy is
 * unbounded (the UI keeps a comparison open indefinitely), so anything another
 * user, a pipeline or a Desktop publish changed in between was silently reverted.
 * This detects that drift so the deploy can stop and say so.
 */

/**
 * @param {object} before - rawFiles captured at compare time
 * @param {object} after - rawFiles fetched immediately before deploy
 * @returns {Array<{ file: string, change: 'added'|'removed'|'modified' }>}
 */
function compareRawFiles(before, after) {
    const drift = [];
    const beforeFiles = before || {};
    const afterFiles = after || {};
    const names = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);

    for (const name of [...names].sort()) {
        const hasBefore = Object.prototype.hasOwnProperty.call(beforeFiles, name);
        const hasAfter = Object.prototype.hasOwnProperty.call(afterFiles, name);
        if (hasBefore && !hasAfter) drift.push({ file: name, change: 'removed' });
        else if (!hasBefore && hasAfter) drift.push({ file: name, change: 'added' });
        else if (normalize(beforeFiles[name]) !== normalize(afterFiles[name])) {
            drift.push({ file: name, change: 'modified' });
        }
    }
    return drift;
}

/** Line endings and a trailing newline are not a semantic change. */
function normalize(content) {
    return String(content == null ? '' : content).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

module.exports = { compareRawFiles };
