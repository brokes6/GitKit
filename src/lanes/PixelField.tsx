import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createCanvas2dRenderer } from "./pixelField2d";
import { createWebGLRenderer } from "./pixelFieldGL";
import { RIPPLE_LIFE, TIME_WRAP, parseColor } from "./pixelFieldShared";
import type { FieldRenderer, FieldTheme, Ripple } from "./pixelFieldShared";

// A slow, dithered pixel field behind the lanes. Brightness comes from two
// drifting layers of value noise, quantised with a 4×4 Bayer matrix so it reads
// as discrete pixels rather than a gradient. Cards are opaque, so it only shows
// in the gutters and empty lanes.
//
// Cheap by design: drawn by a WebGL fragment shader (Canvas2D fallback), ~20 fps,
// woken by a timer rather than a 60 Hz rAF poll, paused when the window is hidden,
// paused when unfocused or offscreen, and a still frame for reduced motion.

export interface PixelFieldHandle {
  /** Send a ripple from a point given in CSS pixels relative to the field. */
  ripple: (x: number, y: number) => void;
}

const FPS_ACTIVE = 20;


export const PixelField = forwardRef<PixelFieldHandle, { className?: string }>(function PixelField({ className }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kick = useRef<(x: number, y: number) => void>(() => {});

  useImperativeHandle(ref, () => ({
    ripple: (x, y) => kick.current(x, y),
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let available = true;
    const contextChanged = (ready: boolean) => { available = ready; dirty = true; refresh(); };
    const renderer: FieldRenderer | null = createWebGLRenderer(canvas, contextChanged) ?? createCanvas2dRenderer(canvas);
    if (!renderer) return;
    canvas.dataset.renderer = renderer.kind;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0, height = 0;
    let raf = 0, timer = 0, due = 0, focused = document.hasFocus();
    let visible = typeof IntersectionObserver === "undefined";
    let dirty = true;
    const ripples: Ripple[] = [];
    const theme: FieldTheme = { css: "#888", r: 0.53, g: 0.53, b: 0.53, a: 1, alpha: 0.12 };
    const t0 = performance.now();

    const readTheme = () => {
      const style = getComputedStyle(canvas);
      const css = style.getPropertyValue("--lk-pixel").trim();
      const rgba = css ? parseColor(css) : null;
      if (rgba) { [theme.r, theme.g, theme.b, theme.a] = rgba; theme.css = css; }
      theme.alpha = parseFloat(style.getPropertyValue("--lk-pixel-alpha")) || theme.alpha;
    };

    const canDraw = () => available && visible && !document.hidden && width > 0 && height > 0;
    const animate = () => focused && !reduced.matches;
    const frame = (now: number) => {
      raf = 0;
      if (!canDraw()) return;
      while (ripples.length && now - ripples[0].start >= RIPPLE_LIFE * 1000) ripples.shift();
      const t = reduced.matches ? 0 : ((now - t0) / 1000) % TIME_WRAP;
      renderer.draw(t, now, ripples, theme);
      dirty = false;
      if (animate()) {
        const interval = 1000 / FPS_ACTIVE;
        due = Math.max(due + interval, now + interval / 2);
        timer = window.setTimeout(() => {
          timer = 0;
          raf = requestAnimationFrame(frame);
        }, Math.max(0, due - performance.now() - 8));
      }
    };
    const refresh = () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      timer = raf = 0;
      due = performance.now();
      if (canDraw() && (animate() || dirty)) raf = requestAnimationFrame(frame);
    };
    kick.current = (x, y) => {
      if (!animate() || !canDraw()) return;
      if (ripples.length === 4) ripples.shift();
      ripples.push({ x, y, start: performance.now() });
      if (!raf) refresh();
    };

    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      if (width === box.width && height === box.height) return;
      width = box.width; height = box.height;
      renderer.resize(width, height, 1);
      dirty = true;
      refresh();
    });
    ro.observe(canvas);
    const io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      refresh();
    });
    io?.observe(canvas);
    readTheme();
    const mo = new MutationObserver(() => { readTheme(); dirty = true; refresh(); });
    const root = canvas.closest(".lk-root");
    if (root) mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const onFocus = () => { focused = true; refresh(); };
    const onBlur = () => { focused = false; dirty ||= ripples.length > 0; ripples.length = 0; refresh(); };
    const onVisibility = () => { focused = document.hasFocus(); refresh(); };
    const onMotion = () => { ripples.length = 0; dirty = true; refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotion);
    refresh();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      kick.current = () => {};
      ro.disconnect(); io?.disconnect(); mo.disconnect();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotion);
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
});
