import { hash, type FieldRenderer } from "./pixelFieldShared";

export function createDropletRenderer(canvas: HTMLCanvasElement): FieldRenderer | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let width = 0, height = 0, color = "";
  let trail: CanvasGradient;
  let drops: { lane: number; offset: number; speed: number; length: number; alpha: number }[] = [];

  return {
    kind: "2d",
    resize(w, h, dpr) {
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(3, Math.ceil(w * h / 15000));
      drops = Array.from({ length: count }, (_, i) => ({
        lane: (i + hash(i, 1)) / count, offset: hash(i, 2),
        speed: 65 + 48 * hash(i, 3), length: Math.min(w * .36, 105 + 130 * hash(i, 4)),
        alpha: .55 + .45 * hash(i, 5),
      }));
    },
    draw(t, _now, _ripples, theme) {
      if (color !== theme.css || !trail) {
        color = theme.css;
        const rgb = [theme.r, theme.g, theme.b].map(v => Math.round(v * 255)).join(",");
        trail = ctx.createLinearGradient(0, 0, 1, 0);
        trail.addColorStop(0, `rgba(${rgb},0)`);
        trail.addColorStop(.42, `rgba(${rgb},.17)`);
        trail.addColorStop(.77, `rgba(${rgb},.72)`);
        trail.addColorStop(.96, color);
        trail.addColorStop(1, `rgba(${rgb},.28)`);
      }
      ctx.clearRect(0, 0, width, height);
      if (!width || !height) return;
      for (const drop of drops) {
        const length = drop.length;
        const cycle = width + length;
        const head = (drop.offset * cycle + t * drop.speed) % cycle;
        const tail = head - length;
        // Both ends follow y = -0.09x - 0.14x²/w. Its tangent at the
        // tail gives the exact quadratic Bézier control point for this segment.
        const rise = length * (.09 + .14 * (head + tail) / width);
        const midY = -length * (.09 + .28 * tail / width) / 2;
        const travel = height + length * .5 + 8;
        const y = drop.lane * travel - tail * (.09 + .14 * tail / width);
        const tailY = ((y % travel) + travel) % travel - 3;
        ctx.save();
        ctx.translate(tail, tailY);
        ctx.scale(length, 1);
        ctx.globalAlpha = drop.alpha;
        ctx.fillStyle = trail;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(.5, midY - 2.4, 1, -rise);
        ctx.quadraticCurveTo(.5, midY + 2.4, 0, 0);
        ctx.fill();
        ctx.restore();
      }
    },
    dispose() {},
  };
}
