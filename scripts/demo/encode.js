'use strict';
// Encode the frames scripts/demo/run.js recorded into MP4s and a GIF.
//   node scripts/demo/encode.js <outDir> <path to ffmpeg>
// Writes calendar-flip.mp4 (whole strip), calendar-flip-panel.mp4 and
// calendar-flip-panel.gif (the Calendar panel only). Frames are timestamped,
// so playback runs at real speed whatever rate they were captured at.
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const outDir = path.resolve(process.argv[2] || 'docs/media');
const ffmpeg = process.argv[3] || 'ffmpeg';
const dir = path.join(outDir, 'frames');
const { times, crop } = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'));

// concat demuxer list: each frame held until the next one arrived.
const list = times.map((t, i) => {
  const dur = ((times[i + 1] ?? t + 33) - t) / 1000;
  return `file '${String(i).padStart(5, '0')}.jpg'\nduration ${dur.toFixed(4)}`;
});
list.push(`file '${String(times.length - 1).padStart(5, '0')}.jpg'`); // concat quirk: last frame listed twice
fs.writeFileSync(path.join(dir, 'list.txt'), list.join('\n'));

const run = (...args) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), ...args], { stdio: 'inherit' });
const even = (n) => Math.floor(n / 2) * 2;
const c = { x: Math.round(crop.x * crop.dpr), y: Math.round(crop.y * crop.dpr), w: even(crop.width * crop.dpr), h: even(crop.height * crop.dpr) };
const cropF = `crop=${c.w}:${c.h}:${c.x}:${c.y}`;
const h264 = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

run('-vf', 'fps=30', ...h264, path.join(outDir, 'calendar-flip.mp4'));
run('-vf', `fps=30,${cropF}`, ...h264, path.join(outDir, 'calendar-flip-panel.mp4'));
run('-vf', `fps=25,${cropF},scale=420:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', path.join(outDir, 'calendar-flip-panel.gif'));
for (const f of ['calendar-flip.mp4', 'calendar-flip-panel.mp4', 'calendar-flip-panel.gif']) {
  console.log(f, `${(fs.statSync(path.join(outDir, f)).size / 1e6).toFixed(2)} MB`);
}
