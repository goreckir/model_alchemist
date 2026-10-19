/**
 * Capture helpers: a CDP screencast recorder plus the on-page overlay (fake
 * cursor, click ripple, caption) that a headless browser does not draw itself.
 */
const fs = require('fs');
const path = require('path');

/**
 * Records every rendered frame through the Chrome DevTools screencast. Frames
 * arrive only when the page changes, each with its own timestamp; render.js
 * turns them into a constant-rate video. Higher quality than Playwright's
 * built-in recordVideo, which is fixed at a low bitrate.
 */
async function startScreencast(page, framesDir, { width, height }) {
    fs.mkdirSync(framesDir, { recursive: true });
    const client = await page.context().newCDPSession(page);
    const frames = [];
    // Cuts: while paused, frames are dropped and the paused time is removed from
    // the timeline, so a long wait (a Fabric refresh) becomes a jump cut.
    let paused = false, pausedAt = 0, offset = 0;
    client.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
        await client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (paused) return;
        const file = path.join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t: metadata.timestamp - offset });
    });
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    return {
        pause() { if (!paused) { paused = true; pausedAt = Date.now() / 1000; } },
        resume() { if (paused) { offset += Date.now() / 1000 - pausedAt; paused = false; } },
        async stop() {
            await client.send('Page.stopScreencast');
            // The last frame needs a duration too: hold it until "now".
            frames.push({ file: null, t: Date.now() / 1000 - offset });
            fs.writeFileSync(path.join(framesDir, 'frames.json'), JSON.stringify(frames));
            return frames;
        }
    };
}

const OVERLAY_CSS = `
#ma-rec-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; pointer-events: none;
  left: -40px; top: -40px; transform: translate(-3px, -2px); }
#ma-rec-cursor svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
.ma-rec-ripple { position: fixed; z-index: 2147483646; width: 36px; height: 36px; margin: -18px 0 0 -18px;
  border-radius: 50%; border: 3px solid #B78CFF; pointer-events: none; animation: ma-rec-ripple .5s ease-out forwards; }
@keyframes ma-rec-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
#ma-rec-caption { position: fixed; z-index: 2147483645; left: 50%; bottom: 36px; transform: translateX(-50%);
  max-width: 80%; padding: 14px 26px; border-radius: 12px; background: rgba(20, 12, 34, .92);
  color: #fff; font: 600 26px/1.3 'Segoe UI', system-ui, sans-serif; text-align: center;
  box-shadow: 0 8px 30px rgba(0,0,0,.45); border: 1px solid rgba(183,140,255,.45);
  opacity: 0; transition: opacity .35s ease; pointer-events: none; }
#ma-rec-caption.on { opacity: 1; }
`;

/** Inject the overlay once per page load (it survives SPA navigation). */
async function installOverlay(page) {
    await page.addInitScript(css => {
        const add = () => {
            if (document.getElementById('ma-rec-cursor')) return;
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
            const cursor = document.createElement('div');
            cursor.id = 'ma-rec-cursor';
            cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.3 19.2 L10.3 12.7 L16.5 12.7 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
            document.body.appendChild(cursor);
            const caption = document.createElement('div');
            caption.id = 'ma-rec-caption';
            document.body.appendChild(caption);
            document.addEventListener('mousemove', e => {
                cursor.style.left = e.clientX + 'px';
                cursor.style.top = e.clientY + 'px';
            }, true);
            document.addEventListener('mousedown', e => {
                const ripple = document.createElement('div');
                ripple.className = 'ma-rec-ripple';
                ripple.style.left = e.clientX + 'px';
                ripple.style.top = e.clientY + 'px';
                document.body.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
            }, true);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
        else add();
    }, OVERLAY_CSS);
}

/** Director: the small vocabulary scenes are written in. */
function director(page) {
    let mouse = { x: 800, y: 500 };

    async function moveTo(x, y, ms = 550) {
        const steps = Math.max(8, Math.round(ms / 16));
        await page.mouse.move(x, y, { steps });
        mouse = { x, y };
    }

    async function centerOf(locator) {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (!box) throw new Error(`Not visible: ${locator}`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    return {
        page,
        cast: null, // set by record.js once the screencast runs
        wait: ms => page.waitForTimeout(ms),
        /** Run `fn` off the timeline: the wait it covers is cut from the video. */
        async cut(fn) {
            this.cast.pause();
            try { return await fn(); } finally { await page.waitForTimeout(300); this.cast.resume(); }
        },
        async caption(text, holdMs = 0) {
            await page.evaluate(t => {
                const el = document.getElementById('ma-rec-caption');
                if (!t) { el.classList.remove('on'); return; }
                el.textContent = t;
                el.classList.add('on');
            }, text || '');
            if (holdMs) await page.waitForTimeout(holdMs);
        },
        async hover(locator, ms) {
            const { x, y } = await centerOf(locator);
            await moveTo(x, y, ms);
        },
        async click(locator, { pauseAfter = 450 } = {}) {
            const { x, y } = await centerOf(locator);
            await moveTo(x, y);
            await page.waitForTimeout(120);
            await page.mouse.down();
            await page.mouse.up();
            await page.waitForTimeout(pauseAfter);
        },
        async type(locator, text, { delay = 18 } = {}) {
            await this.click(locator, { pauseAfter: 150 });
            await locator.fill('');
            await locator.pressSequentially(text, { delay });
        },
        async scroll(locator, dy, ms = 700) {
            const { x, y } = await centerOf(locator);
            await moveTo(x, y, 300);
            const steps = Math.max(6, Math.round(ms / 30));
            for (let i = 0; i < steps; i++) {
                await page.mouse.wheel(0, dy / steps);
                await page.waitForTimeout(ms / steps);
            }
        },
        get mouse() { return mouse; }
    };
}

module.exports = { startScreencast, installOverlay, director };
