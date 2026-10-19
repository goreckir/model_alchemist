/**
 * Render a captured take into the three deliverables:
 *   master.mp4         1600×1000, 30 fps, the raw take (privacy-gated)
 *   titled.mp4         the take with the opening card cross-faded in front
 *   <name>.gif         1200 px wide for README / Reddit (ffmpeg palette)
 *   <name>-linkedin.mp4  1080×1080 square: title band above, video at the bottom edge
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const tools = require('./tools');

function run(cmd, args) {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Variable-rate screencast frames → constant 30 fps H.264 master. */
function renderMaster(frames, outDir, { width, height }) {
    const list = path.join(outDir, 'frames.txt');
    const lines = [];
    for (let i = 0; i < frames.length - 1; i++) {
        const duration = Math.max(1 / 60, frames[i + 1].t - frames[i].t);
        lines.push(`file '${frames[i].file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`, `duration ${duration.toFixed(4)}`);
    }
    // The concat demuxer ignores the duration of the last entry; repeat it.
    lines.push(`file '${frames[frames.length - 2].file.replace(/\\/g, '/')}'`);
    fs.writeFileSync(list, lines.join('\n'));

    const master = path.join(outDir, 'master.mp4');
    run(tools.ffmpeg(), ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-vf', `scale=${width}:${height}:flags=lanczos,fps=30,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-movflags', '+faststart', master]);
    return master;
}

/**
 * GIF with ffmpeg's two-pass palette (palettegen + paletteuse). Steps frame rate
 * and palette size down until the file fits the size budget.
 */
function renderGif(master, outDir, name, { width = 1200, maxBytes = 5 * 1024 * 1024 } = {}) {
    const gif = path.join(outDir, `${name}.gif`);
    const attempts = [{ fps: 15, colors: 256 }, { fps: 12, colors: 192 }, { fps: 10, colors: 128 }, { fps: 8, colors: 96 }];
    let last;
    for (const { fps, colors } of attempts) {
        const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];` +
            `[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
        run(tools.ffmpeg(), ['-y', '-loglevel', 'error', '-i', master, '-filter_complex', filter, gif]);
        last = { gif, size: fs.statSync(gif).size, fps, colors };
        if (last.size <= maxBytes) return last;
    }
    return { ...last, oversize: true };
}

/**
 * Prepend the opening card (assets/title-card.png) to a master: the card holds,
 * then cross-fades into the take. The master itself stays the raw, privacy-gated
 * take; GIF and LinkedIn cuts are made from the titled copy.
 */
function addIntro(master, cardPng, outDir, { width = 1600, height = 1000, hold = 2.5, fade = 0.5 } = {}) {
    const out = path.join(outDir, 'titled.mp4');
    run(tools.ffmpeg(), ['-y', '-loglevel', 'error',
        '-loop', '1', '-t', String(hold + fade), '-i', cardPng, '-i', master,
        '-filter_complex',
        `[0:v]scale=${width}:${height}:flags=lanczos,fps=30,format=yuv420p,setsar=1[c];` +
        `[1:v]fps=30,format=yuv420p,setsar=1[m];` +
        `[c][m]xfade=transition=fade:duration=${fade}:offset=${hold},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-movflags', '+faststart', out]);
    return out;
}

/** LinkedIn cut: the pre-rendered frame PNG (its size is the canvas) with the video overlaid at videoTop. */
function renderLinkedIn(master, framePng, outDir, name, { videoTop = 338 } = {}) {
    const out = path.join(outDir, `${name}-linkedin.mp4`);
    run(tools.ffmpeg(), ['-y', '-loglevel', 'error', '-loop', '1', '-i', framePng, '-i', master,
        '-filter_complex', `[1:v]scale=1080:-2:flags=lanczos[v];[0:v][v]overlay=0:${videoTop}:shortest=1,format=yuv420p`,
        '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out]);
    return out;
}

module.exports = { renderMaster, addIntro, renderGif, renderLinkedIn };
