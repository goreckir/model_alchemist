/**
 * Asset renderer — turns the HTML/SVG sources in this folder into the PNGs
 * referenced by README.md.
 *
 * Run from the repo root:  node assets/src/render.js
 * Requires Playwright's Chromium (dev-only; not a runtime dependency).
 */
const path = require('path');
const fs = require('fs');

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(PLAYWRIGHT);

const OUT_DIR = path.join(__dirname, '..');
const SRC_DIR = __dirname;

/** @type {Array<{file: string, out: string, width: number, height: number, scale?: number, transparent?: boolean}>} */
const TARGETS = [
    { file: 'logo.html',            out: 'logo.png',                    width: 512,  height: 512, scale: 2, transparent: true },
    // Same source, sized for the browser tab. Served from public/ by the app.
    { file: 'logo.html',            out: '../public/favicon.png',       width: 512,  height: 512, scale: 0.25, transparent: true },
    { file: "banner.html",          out: "banner.png",                  width: 1280, height: 360, scale: 2 },
    { file: 'diagram-flow.html',    out: 'diagram-how-it-works.png',    width: 1400, height: 760, scale: 2 },
    { file: 'diagram-coverage.html',out: 'diagram-coverage.png',        width: 1400, height: 1040, scale: 2 },
    { file: 'diagram-safety.html',  out: 'diagram-deploy-safety.png',   width: 1400, height: 830, scale: 2 },
    { file: 'diagram-sources.html', out: 'diagram-source-target.png',   width: 1400, height: 700, scale: 2 }
];

(async () => {
    const browser = await chromium.launch();
    for (const target of TARGETS) {
        const page = await browser.newPage({
            viewport: { width: target.width, height: target.height },
            deviceScaleFactor: target.scale || 2
        });
        await page.goto('file://' + path.join(SRC_DIR, target.file), { waitUntil: 'networkidle' });
        await page.screenshot({
            path: path.join(OUT_DIR, target.out),
            omitBackground: Boolean(target.transparent)
        });
        await page.close();
        const bytes = fs.statSync(path.join(OUT_DIR, target.out)).size;
        console.log(`${target.out.padEnd(32)} ${target.width}x${target.height}@${target.scale || 2}x  ${(bytes / 1024).toFixed(0)} KB`);
    }
    await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
