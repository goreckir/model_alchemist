const test = require('node:test');
const assert = require('node:assert');
const { contentSignature } = require('../comparison/rename-detector');

// ── finding 4.4: raw NUL byte + undelimited signature joins ──────────────────
test('4.4 the module source contains no raw NUL byte (git must treat it as text)', () => {
    const fs = require('fs');
    const buf = fs.readFileSync(require.resolve('../comparison/rename-detector.js'));
    assert.ok(!buf.includes(0), 'no literal 0x00 byte in the source file');
});

test('4.4 property sets that would concatenate identically produce different signatures', () => {
    // Without a delimiter, ['a=1', 'ab=2'] and ['a=1a', 'b=2'] both concatenate to 'a=1ab=2'.
    const diffA = { objectType: 'measure', type: 0, propertyDiffs: [
        { propertyName: 'a', devValue: '1' },
        { propertyName: 'ab', devValue: '2' }
    ] };
    const diffB = { objectType: 'measure', type: 0, propertyDiffs: [
        { propertyName: 'a', devValue: '1a' },
        { propertyName: 'b', devValue: '2' }
    ] };

    assert.notStrictEqual(contentSignature(diffA), contentSignature(diffB));
});
