// Assemble captured PNG frames into an optimized GIF.
//   node scripts/make-gif.mjs <framesDir> <out.gif> [frameDelayMs] [scale]
import * as fs from 'node:fs';
import * as path from 'node:path';
import pkg from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = pkg;
import { PNG } from 'pngjs';

const [dir, out, delayArg, scaleArg] = process.argv.slice(2);
const delay = Number(delayArg) || 100;
const scale = Number(scaleArg) || 1;

const frames = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort();
if (!frames.length) {
  console.error('no frames in', dir);
  process.exit(1);
}

const gif = GIFEncoder();
let palette = null;
for (const name of frames) {
  const png = PNG.sync.read(fs.readFileSync(path.join(dir, name)));
  let rgba = png.data;
  let width = png.width;
  let height = png.height;
  if (scale !== 1) {
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const scaled = new PNG({ width, height });
    // nearest-neighbor downscale
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = Math.min(png.width - 1, Math.floor(x / scale));
        const sy = Math.min(png.height - 1, Math.floor(y / scale));
        const si = (sy * png.width + sx) * 4;
        const di = (y * width + x) * 4;
        scaled.data[di] = rgba[si];
        scaled.data[di + 1] = rgba[si + 1];
        scaled.data[di + 2] = rgba[si + 2];
        scaled.data[di + 3] = rgba[si + 3];
      }
    }
    rgba = scaled.data;
  }
  // Stable palette from the first frame avoids color flicker between frames.
  if (!palette) {
    palette = quantize(rgba, 256);
  }
  const indexed = applyPalette(rgba, palette);
  gif.writeFrame(indexed, width, height, { palette, delay });
}
gif.finish();
fs.writeFileSync(out, gif.bytes());
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`${out}: ${frames.length} frames, ${kb} KB`);
