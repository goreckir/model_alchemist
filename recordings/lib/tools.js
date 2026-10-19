/**
 * Locate the external tools: an env override first (FFMPEG, TESSERACT),
 * then PATH, then the usual Windows install locations (winget, Program Files).
 * A fresh winget install is not on PATH until a new shell, hence the fallbacks.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function onPath(exe) {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        return execFileSync(cmd, [exe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null;
    } catch { return null; }
}

function findUnder(dir, exe, depth = 4) {
    if (!dir || depth < 0 || !fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === exe) return full;
        if (entry.isDirectory()) {
            const hit = findUnder(full, exe, depth - 1);
            if (hit) return hit;
        }
    }
    return null;
}

const cache = {};
function tool(name, { env, exe, dirs }) {
    if (cache[name]) return cache[name];
    const found = process.env[env] || onPath(exe) || dirs.map(d => findUnder(d, exe)).find(Boolean);
    if (!found) throw new Error(`${name} not found. Install it or set ${env} to the full path of ${exe}.`);
    return (cache[name] = found);
}

const LOCAL = process.env.LOCALAPPDATA || '';
const WINGET = path.join(LOCAL, 'Microsoft', 'WinGet', 'Packages');
const wingetPackage = prefix => fs.existsSync(WINGET)
    ? fs.readdirSync(WINGET).filter(d => d.startsWith(prefix)).map(d => path.join(WINGET, d)) : [];

module.exports = {
    ffmpeg: () => tool('ffmpeg', { env: 'FFMPEG', exe: 'ffmpeg.exe', dirs: wingetPackage('Gyan.FFmpeg') }),
    ffprobe: () => tool('ffprobe', { env: 'FFPROBE', exe: 'ffprobe.exe', dirs: wingetPackage('Gyan.FFmpeg') }),
    tesseract: () => tool('tesseract', { env: 'TESSERACT', exe: 'tesseract.exe', dirs: ['C:\\Program Files\\Tesseract-OCR'] })
};
