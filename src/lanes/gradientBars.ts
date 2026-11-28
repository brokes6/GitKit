import type { FieldRenderer } from "./pixelFieldShared";

// Rasterize one vertical highlight and reuse it for every strip on each frame.
export function createGradientBars(canvas: HTMLCanvasElement, options: () => { width: number; strength: number }): FieldRenderer | null {
  const ctx = canvas.getContext("2d");
  const highlight = document.createElement("canvas");
  highlight.width = 1;
  const brush = highlight.getContext("2d");
  if (!ctx || !brush) return null;
  let width = 0, height = 0, lastColor = "";
  const profile = [[0, 0], [.27, .06], [.425, .26], [.484, .53], [.496, .68], [.5, 1],
    [.504, .68], [.516, .53], [.575, .26], [.73, .06], [1, 0]];
  return {
    kind: "2d",
    resize(w, h, dpr) {
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      highlight.height = Math.max(1, Math.ceil(h * 1.52 * dpr));
      lastColor = "";
    },
    draw(time, _now, _ripples, theme) {
      if (lastColor !== theme.css) {
        const gradient = brush.createLinearGradient(0, 0, 0, highlight.height);
        const rgb = [theme.r, theme.g, theme.b].map(channel => Math.round(channel * 255)).join(",");
        for (const [position, alpha] of profile) gradient.addColorStop(position, `rgba(${rgb},${alpha})`);
        brush.clearRect(0, 0, 1, highlight.height);
        brush.fillStyle = gradient;
        brush.fillRect(0, 0, 1, highlight.height);
        lastColor = theme.css;
      }
      const { width: pitch, strength } = options();
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = theme.barColor ?? theme.css;
      for (let x = 0; x < width; x += pitch) {
        const phase = Math.abs((x + pitch / 2) / width - .5) * 4 * Math.PI + time * 2 * Math.PI / 17;
        const light = (1 + Math.cos(phase)) / 2;
        ctx.globalAlpha = (.04 + .36 * light) * strength / 100;
        ctx.fillRect(x, 0, pitch, height);
        ctx.globalAlpha = (.07 + .93 * light * light) * strength / 100;
        ctx.drawImage(highlight, x, height * (.52 + .61 * Math.sin(phase) - .76), pitch, height * 1.52);
      }
      ctx.globalAlpha = 1;
    },
    dispose() {},
  };
}
