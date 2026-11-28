// Canvas2D fallback for the pixel field, used only when WebGL is unavailable.
// It evaluates the noise per cell on the main thread, so it is far costlier
// than the WebGL path; the look is identical.
import {
  BAYER, CELL, DOT, DOT_OFFSET, LEVELS, RIPPLE_BAND, RIPPLE_GAIN, RIPPLE_LIFE, RIPPLE_SPEED, hash,
} from "./pixelFieldShared";
import type { FieldRenderer, FieldTheme, Ripple } from "./pixelFieldShared";

function noise(lattice: Float64Array, x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = lattice[(yi & 255) * 256 + (xi & 255)], b = lattice[(yi & 255) * 256 + ((xi + 1) & 255)];
  const c = lattice[((yi + 1) & 255) * 256 + (xi & 255)], d = lattice[((yi + 1) & 255) * 256 + ((xi + 1) & 255)];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function createCanvas2dRenderer(canvas: HTMLCanvasElement): FieldRenderer | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let cols = 0, rows = 0;
  let previous = new Uint8Array(0);
  let lastColor = "", lastAlpha = -1;
  const lattice = Float64Array.from({ length: 256 * 256 }, (_, i) => hash(i & 255, i >> 8));

  return {
    kind: "2d",
    resize(w, h, dpr) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL);
      rows = Math.ceil(h / CELL);
      previous = new Uint8Array(rows * cols);
    },
    draw(t: number, now: number, ripples: readonly Ripple[], theme: FieldTheme) {
      const repaint = theme.css !== lastColor || theme.alpha !== lastAlpha;
      lastColor = theme.css;
      lastAlpha = theme.alpha;
      ctx.fillStyle = theme.css;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          // Two layers drifting in different directions give a slow, organic flow.
          let v = noise(lattice, x * 0.045 + t * 0.05, y * 0.06 - t * 0.02) * 0.65
            + noise(lattice, x * 0.11 - t * 0.07, y * 0.12 + t * 0.04) * 0.35;
          v = (v - 0.42) * 1.9;
          for (const r of ripples) {
            const age = (now - r.start) / 1000;
            const band = (Math.hypot(x * CELL - r.x, y * CELL - r.y) - age * RIPPLE_SPEED) / RIPPLE_BAND;
            v += Math.exp(-band * band) * (1 - age / RIPPLE_LIFE) * RIPPLE_GAIN;
          }
          const level = Math.max(0, Math.min(LEVELS, Math.floor(v * (LEVELS - 1) + BAYER[(y & 3) * 4 + (x & 3)])));
          const i = y * cols + x;
          if (previous[i] === level && !repaint) continue;
          const left = x * CELL + DOT_OFFSET, top = y * CELL + DOT_OFFSET;
          // Clear the whole cell, including the antialiased half-pixel edges.
          if (previous[i]) ctx.clearRect(x * CELL, y * CELL, CELL, CELL);
          previous[i] = level;
          if (level) {
            ctx.globalAlpha = theme.alpha * level / LEVELS;
            ctx.fillRect(left, top, DOT, DOT);
          }
        }
      }
      ctx.globalAlpha = 1;
    },
    dispose() {},
  };
}
