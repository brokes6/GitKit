// Each column uses the same two soft crests, shifted vertically by the wave.
// Cache their opacity profile; animation only moves the columns under the grid.
import type { FieldRenderer } from "./pixelFieldShared";

export function createWaveRenderer(canvas: HTMLCanvasElement): FieldRenderer | null {
  const ctx = canvas.getContext("2d");
  const strip = document.createElement("canvas");
  const brush = strip.getContext("2d");
  const tile = document.createElement("canvas");
  tile.width = 1;
  tile.height = 4;
  tile.getContext("2d")?.fillRect(0, 1, 1, 2.25);
  const mask = ctx?.createPattern(tile, "repeat");
  if (!ctx || !brush || !mask) return null;
  let width = 0, height = 0, color = "";
  return {
    kind: "2d",
    resize(w, h, dpr) {
      width = Math.ceil(w);
      height = Math.ceil(h);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      strip.width = 1;
      strip.height = 2 * height;
      color = "";
    },
    draw(time, _now, _ripples, theme) {
      if (!width || !height) return;
      if (color !== theme.css) {
        color = theme.css;
        brush.clearRect(0, 0, 1, strip.height);
        brush.fillStyle = color;
        for (let y = 0; y < strip.height; y++) {
          const d = y / height - 1;
          const band = Math.exp(-d * d / 0.0034) + 0.52 * Math.exp(-((d - 0.27) ** 2) / 0.006);
          brush.globalAlpha = (0.018 + 0.29 * Math.min(1, band)) * 1.8;
          brush.fillRect(0, y, 1, 1);
        }
      }
      ctx.clearRect(0, 0, width, height);
      for (let x = 1; x < width; x += 4) {
        const nx = x / width;
        const crest = 0.52 + 0.22 * Math.sin(nx * 7.5 - time * 0.22) + 0.095 * Math.sin(nx * 13 + time * 0.12);
        ctx.drawImage(strip, x, (crest - 1) * height, 2.25, strip.height);
      }
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = mask;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() {},
  };
}
