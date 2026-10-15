/**
 * Privacy gate: OCR sampled frames of a rendered take and fail if any of them
 * shows something that identifies a person, an organisation or a machine.
 *
 * Generic patterns live here. Personal terms (names, company, tenant) live in
 * recordings/privacy.local.json, which is git-ignored:
 *   { "terms": ["Jane Doe", "contoso"] }
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const tools = require('./tools');

const GENERIC = [
    { name: 'e-mail address', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, allow: /@apothecary\.example/i },
    { name: 'Windows user profile path', re: /\\Users\\|[/]Users[/]/i },
    { name: 'AppData path', re: /AppData/i },
    { name: 'OneDrive path', re: /OneDrive/i },
    { name: 'temp folder', re: /\\Temp\\|[/]tmp[/]|var[/]folders/i }
];

function localTerms() {
    const file = path.join(__dirname, '..', 'privacy.local.json');
    if (!fs.existsSync(file)) return [];
    return (JSON.parse(fs.readFileSync(file, 'utf8')).terms || []).filter(Boolean);
}

/** Compare ignoring case, spaces and punctuation, which OCR mangles. */
const squash = s => s.toLowerCase().replace(/[^a-z0-9@]/g, '');

function scan(master, workDir, { everySeconds = 1 } = {}) {
    const dir = path.join(workDir, 'ocr');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(tools.ffmpeg(), ['-y', '-loglevel', 'error', '-i', master, '-vf', `fps=1/${everySeconds},scale=iw*1.5:-1`, path.join(dir, '%04d.png')]);

    const terms = localTerms();
    const findings = [];
    for (const png of fs.readdirSync(dir).filter(f => f.endsWith('.png'))) {
        const text = execFileSync(tools.tesseract(), [path.join(dir, png), 'stdout', '--psm', '11'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const second = parseInt(png, 10) * everySeconds;
        for (const { name, re, allow } of GENERIC) {
            for (const line of text.split('\n')) {
                const m = line.match(re);
                if (m && !(allow && allow.test(m[0]))) findings.push({ second, rule: name, text: line.trim() });
            }
        }
        const flat = squash(text);
        for (const term of terms) {
            if (flat.includes(squash(term))) findings.push({ second, rule: 'local term', text: term });
        }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { findings, localTermCount: terms.length };
}

module.exports = { scan };
