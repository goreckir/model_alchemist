/**
 * Campaign recordings — drives the real Model Alchemist UI against Demo Kit
 * Scenarios and renders each take to MP4 (master + LinkedIn portrait) and GIF.
 *
 *   cd recordings && npm install && npx playwright install chromium
 *   node record.js                 every scene
 *   node record.js launch          one scene
 *   node record.js launch --raw    capture only, skip rendering and the privacy gate
 *
 * Safety: the app runs in Presentation Mode, models are copied to a neutral path
 * (MA_DEMO_ROOT, default C:\ModelAlchemistDemo), every take passes an OCR privacy
 * gate (lib/privacy.js) before it counts as done. Output: out/recordings/<scene>/.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startScreencast, installOverlay, director } = require('./lib/capture');
const { renderMaster, renderGif, renderLinkedIn } = require('./lib/render');
const privacy = require('./lib/privacy');
const fabric = require('./lib/fabric');
const SCENES = require('./scenes');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'recordings');
const DEMO_ROOT = process.env.MA_DEMO_ROOT || 'C:\\ModelAlchemistDemo';
const VIEWPORT = { width: 1600, height: 1000 };
const SCALE = 1.5; // capture at 2400×1500, render down for crisp text
const PORT = 3777;

// ── Models at a neutral path ─────────────────────────────────────────────────

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name === '.pbi') continue; // local Desktop cache, never part of a demo
        const src = path.join(from, entry.name), dst = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(src, dst); else fs.copyFileSync(src, dst);
    }
}

/** Fresh Source and Target copies for one take; the deploy writes into Target. */
function stageModels({ source, target }) {
    const base = path.join(DEMO_ROOT, 'Apothecary');
    fs.rmSync(base, { recursive: true, force: true });
    const staged = {
        source: path.join(base, 'dev', 'Apothecary.SemanticModel'),
        target: path.join(base, 'prod', 'Apothecary.SemanticModel'),
        backups: path.join(DEMO_ROOT, 'backups')
    };
    copyDir(source, staged.source);
    copyDir(target, staged.target);
    fs.rmSync(staged.backups, { recursive: true, force: true });
    fs.mkdirSync(staged.backups, { recursive: true });
    return staged;
}

// ── App ──────────────────────────────────────────────────────────────────────

function startApp() {
    process.env.MA_PRESENTATION = '1';
    // require() does not auto-start the server or open a system browser.
    const { app } = require(path.join(ROOT, 'server.js'));
    return new Promise(resolve => {
        const server = app.listen(PORT, () => resolve(server));
    });
}

// ── LinkedIn frame (title band above the video, footer below) ────────────────

async function renderLinkedInFrame(browser, scene, file) {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:1080px;height:1350px;
        background:linear-gradient(180deg,#1b1029 0%,#120b1d 100%);font-family:'Segoe UI',system-ui,sans-serif;color:#fff;
        display:flex;flex-direction:column;justify-content:space-between;">
      <div style="height:338px;box-sizing:border-box;padding:64px 64px 0;">
        <div style="font-size:24px;letter-spacing:.14em;text-transform:uppercase;color:#B78CFF;font-weight:600;">Model Alchemist</div>
        <div style="margin-top:20px;font-size:52px;line-height:1.12;font-weight:700;">${scene.headline}</div>
      </div>
      <div style="height:337px;box-sizing:border-box;padding:0 64px 64px;display:flex;align-items:flex-end;
        justify-content:space-between;font-size:26px;color:#d9ccf0;">
        <span>${scene.footer || 'Diff and selective deploy for Power BI semantic models'}</span>
        <span style="color:#B78CFF;font-weight:600;">Open source · MIT</span>
      </div></body></html>`);
    await page.screenshot({ path: file });
    await page.close();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function recordScene(browser, scene, { raw }) {
    const outDir = path.join(OUT, scene.name);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    const staged = stageModels(scene.models());
    if (scene.fabric) {
        // Off camera: put Fabric Prod back to the Default Scenario Target, with fresh data.
        console.log('  resetting Fabric Prod (off camera)…');
        const r = await fabric.resetProd(PORT, path.join(ROOT, 'demo', 'prod', 'Apothecary.SemanticModel'));
        console.log(`  reset: ${r.reset} difference(s) deployed, model refreshed`);
    }
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    await installOverlay(page);
    // The deploy dialog pre-fills its backup folder from here; keep it neutral.
    await page.addInitScript(dir => localStorage.setItem('ma_backupPath', dir), staged.backups);
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

    const d = director(page);
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    const cast = await startScreencast(page, path.join(outDir, 'frames'),
        { width: VIEWPORT.width * SCALE, height: VIEWPORT.height * SCALE });
    d.cast = cast;
    try {
        await scene.run(d, staged, { port: PORT, fabric });
    } catch (err) {
        // Kept for diagnosis only; out/ is git-ignored. Review it before sharing.
        await page.screenshot({ path: path.join(outDir, 'error.png') }).catch(() => {});
        throw err;
    }
    const frames = await cast.stop();
    await context.close();

    console.log(`  ${scene.name}: ${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`);
    if (problems.length) console.log(`  page problems: ${problems.join(' | ')}`);
    if (raw) return { scene: scene.name, raw: true };

    const master = renderMaster(frames, outDir, VIEWPORT);
    const gate = privacy.scan(master, outDir);
    if (gate.findings.length) {
        console.error(`  PRIVACY GATE FAILED for ${scene.name}:`);
        for (const f of gate.findings) console.error(`    ${f.second}s  ${f.rule}: ${f.text}`);
        fs.rmSync(outDir, { recursive: true, force: true });
        return { scene: scene.name, failed: 'privacy' };
    }
    if (!gate.localTermCount) console.warn('  note: recordings/privacy.local.json missing or empty; only generic patterns were checked');

    const gif = renderGif(master, outDir, scene.name);
    const framePng = path.join(outDir, 'linkedin-frame.png');
    await renderLinkedInFrame(browser, scene, framePng);
    const linkedin = renderLinkedIn(master, framePng, outDir, scene.name);
    fs.rmSync(path.join(outDir, 'frames'), { recursive: true, force: true });
    fs.rmSync(path.join(outDir, 'frames.txt'), { force: true });

    console.log(`  gif ${(gif.size / 1048576).toFixed(2)} MB${gif.oversize ? ' (OVER BUDGET)' : ''} · ${path.relative(ROOT, linkedin)}`);
    return { scene: scene.name, gif, linkedin, master };
}

(async () => {
    const args = process.argv.slice(2);
    const raw = args.includes('--raw');
    const names = args.filter(a => !a.startsWith('--'));
    const selected = names.length ? names.map(n => {
        const s = SCENES.find(x => x.name === n);
        if (!s) throw new Error(`Unknown scene "${n}". Known: ${SCENES.map(x => x.name).join(', ')}`);
        return s;
    }) : SCENES;

    // Scenes read out/scenarios/*, which demo/scenarios.js derives from the Demo Kit.
    require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'demo', 'scenarios.js')], { stdio: 'ignore' });
    const server = await startApp();
    if (selected.some(s => s.fabric)) await fabric.signIn(PORT);
    const browser = await chromium.launch();
    const results = [];
    try {
        for (const scene of selected) {
            console.log(`Recording ${scene.name}…`);
            results.push(await recordScene(browser, scene, { raw }));
        }
    } finally {
        await browser.close();
        server.close();
        fs.rmSync(path.join(DEMO_ROOT, 'Apothecary'), { recursive: true, force: true });
    }
    if (results.some(r => r.failed)) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
