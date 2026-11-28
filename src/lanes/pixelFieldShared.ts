// Shared look + plumbing for the lanes pixel field (see PixelField.tsx).
// Both renderers (WebGL and the Canvas2D fallback) draw exactly this field.

export const CELL = 7;           // grid pitch in CSS px
export const DOT = 4;            // lit square size in CSS px
export const DOT_OFFSET = (CELL - DOT) / 2;
export const LEVELS = 4;         // brightness steps after dithering
export const RIPPLE_SPEED = 520; // ring radius growth, CSS px/s
export const RIPPLE_BAND = 46;   // ring thickness, CSS px
export const RIPPLE_LIFE = 2.6;  // seconds until a ripple has faded out
export const RIPPLE_GAIN = 1.1;
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
/** All drift speeds are multiples of 0.01 lattice/s and the GPU lattice repeats
 *  every 256 cells, so wrapping time at 256 / 0.01 s is seamless. */
export const TIME_WRAP = 25600;

/** Integer lattice hash in [0, 1]. */
export function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export interface Ripple { x: number; y: number; start: number }

export interface FieldTheme {
  /** The raw CSS colour (used as-is by Canvas2D). */
  css: string;
  /** Parsed colour, 0–1 channels; `a` is the colour's own alpha. */
  r: number; g: number; b: number; a: number;
  /** `--lk-pixel-alpha`: alpha of the brightest level. */
  alpha: number;
}

export interface FieldRenderer {
  readonly kind: "webgl" | "2d";
  /** Size in CSS px; the renderer sizes the backing store to `dpr`. */
  resize(width: number, height: number, dpr: number): void;
  /** `t` is field time in seconds, `now` the performance.now() timestamp. */
  draw(t: number, now: number, ripples: readonly Ripple[], theme: FieldTheme): void;
  dispose(): void;
}

let probe: CanvasRenderingContext2D | null | undefined;
/** Resolve any CSS colour (hex, rgb(), hsl(), color-mix()…) to 0–1 RGBA via a
 *  1×1 canvas. Returns null if the string isn't a colour. Called only on theme reads. */
export function parseColor(css: string): [number, number, number, number] | null {
  if (probe === undefined) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    probe = c.getContext("2d", { willReadFrequently: true });
  }
  if (!probe) return null;
  const sentinel = "#010203";
  probe.fillStyle = sentinel;
  probe.fillStyle = css;
  if (probe.fillStyle === sentinel && css.trim().toLowerCase() !== sentinel) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}
