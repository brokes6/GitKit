import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createCanvas2dRenderer } from "./pixelField2d";
import { useBackgroundSettings, type BackgroundSettings } from "./backgroundSettings";
import { createDropletRenderer } from "./lightDroplets";
import { createGradientBars } from "./gradientBars";
import { createWaveRenderer } from "./pixelWaves";
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


interface PixelFieldProps {
  className?: string;
  pattern: "dots" | "waves" | "bars" | "droplets";
  barWidth: number;
  barSpeed: number;
  strength: number;
  animated: boolean;
}

export const PixelField = forwardRef<PixelFieldHandle, PixelFieldProps>(function PixelField({ className, pattern, strength, animated, barWidth, barSpeed }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const kick = useRef<(x: number, y: number) => void>(() => {});

  const options = useRef({ width: barWidth, strength, speed: barSpeed });
  const motion = useRef(animated);
  const redraw = useRef<() => void>(() => {});
  useEffect(() => { motion.current = animated; redraw.current(); }, [animated]);

  useEffect(() => {
    options.current = { width: barWidth, strength, speed: barSpeed };
    if (pattern === "bars") redraw.current();
  }, [barWidth, barSpeed, strength, pattern]);

  useImperativeHandle(ref, () => ({
    ripple: (x, y) => kick.current(x, y),
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let available = true;
    const contextChanged = (ready: boolean) => { available = ready; dirty = true; refresh(); };
    const renderer: FieldRenderer | null = pattern === "bars" ? createGradientBars(canvas, () => options.current)
      : pattern === "droplets" ? createDropletRenderer(canvas)
      : pattern === "waves" ? createWaveRenderer(canvas)
      : createWebGLRenderer(canvas, contextChanged) ?? createCanvas2dRenderer(canvas);
    if (!renderer) return;
    canvas.dataset.renderer = renderer.kind;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0, height = 0;
    let raf = 0, timer = 0, due = 0, focused = document.hasFocus();
    let visible = typeof IntersectionObserver === "undefined";
    let dirty = true;
    const ripples: Ripple[] = [];
    const theme: FieldTheme = { css: "#888", r: 0.53, g: 0.53, b: 0.53, a: 1, alpha: 0.12 };
    let elapsed = 0, lastFrame = 0;

    const readTheme = () => {
      const style = getComputedStyle(canvas);
      if (pattern === "bars") theme.barColor = style.getPropertyValue("--lk-bar-color").trim();
      const css = style.getPropertyValue(pattern === "bars" ? "--lk-bar-glow" : pattern === "droplets" ? "--lk-accent" : pattern === "waves" ? "--lk-wave" : "--lk-pixel").trim();
      const rgba = css ? parseColor(css) : null;
      if (rgba) { [theme.r, theme.g, theme.b, theme.a] = rgba; theme.css = css; }
      theme.alpha = (parseFloat(style.getPropertyValue("--lk-pixel-alpha")) || 0.24) * 1.8;
    };

    const canDraw = () => available && visible && !document.hidden && width > 0 && height > 0;
    const animate = () => focused && motion.current && !reduced.matches;
    const frame = (now: number) => {
      raf = 0;
      if (!canDraw()) return;
      while (ripples.length && now - ripples[0].start >= RIPPLE_LIFE * 1000) ripples.shift();
      if (animate() && lastFrame) elapsed += Math.min(0.2, (now - lastFrame) / 1000) * (pattern === "bars" ? options.current.speed : 1);
      lastFrame = now;
      const t = reduced.matches ? 0 : elapsed % TIME_WRAP;
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
      lastFrame = 0;
      due = performance.now();
      if (canDraw() && (animate() || dirty)) raf = requestAnimationFrame(frame);
    };
    redraw.current = () => { dirty = true; ripples.length = 0; refresh(); };
    kick.current = (x, y) => {
      if (pattern !== "dots") return;
      if (!animate() || !canDraw()) return;
      if (ripples.length === 4) ripples.shift();
      ripples.push({ x, y, start: performance.now() });
      if (!raf) refresh();
    };

    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      if (width === box.width && height === box.height) return;
      width = box.width; height = box.height;
      renderer.resize(width, height, pattern === "bars" || pattern === "droplets" ? Math.min(2, window.devicePixelRatio || 1) : 1);
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
    const root = canvas.closest(".lk-root, .gk-background-preview");
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
      redraw.current = () => {};
      kick.current = () => {};
      ro.disconnect(); io?.disconnect(); mo.disconnect();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotion);
      renderer.dispose();
    };
  }, [pattern]);

  return <canvas key={pattern} ref={canvasRef} className={className} aria-hidden="true"
    style={pattern === "bars" ? { background: "var(--lk-bar-base)" } : { opacity: strength / 180 }} />;
});


export const WorkspaceBackground = forwardRef<PixelFieldHandle, { preview?: BackgroundSettings }>(function WorkspaceBackground({ preview }, ref) {
  const saved = useBackgroundSettings();
  const bg = preview ?? saved;
  return bg.style === "plain" ? null : <PixelField ref={ref} className="lk-pixels"
    pattern={bg.style} strength={bg[bg.style]} animated={bg.animated} barWidth={bg.barWidth} barSpeed={bg.barSpeed} />;
});
