import { useLayoutEffect, useRef } from "react";

const DURATION = 220;
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Keep toolbar controls continuous across text changes without animating layout. */
export function useToolbarLayoutMotion(layoutKey: string) {
  const rootRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<HTMLElement, number>());
  const animations = useRef(new Map<HTMLElement, Animation>());
  const bounds = useRef({ width: 0, metadataWidth: 0 });

  const measure = () => {
    const root = rootRef.current;
    if (!root) return null;
    const origin = root.getBoundingClientRect();
    const metadata = root.querySelector<HTMLElement>(".gk-toolbar-metadata");
    const clip = metadata && animations.current.has(metadata) ? getComputedStyle(metadata).clipPath : "none";
    const clipRight = Number.parseFloat(clip.match(/^inset\([^ ]+\s+([^ )]+)/)?.[1] ?? "0");
    const items = Array.from(root.querySelectorAll<HTMLElement>("[data-gk-toolbar-move]"), (node) => {
      const transform = animations.current.has(node) ? getComputedStyle(node).transform : "none";
      const offset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
      return { node, offset, left: node.getBoundingClientRect().left - origin.left - offset };
    });
    return { items, width: origin.width, metadata, clipRight, metadataWidth: metadata?.getBoundingClientRect().width ?? 0 };
  };
  const stop = () => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current.clear();
  };
  const remember = (measurement: NonNullable<ReturnType<typeof measure>>) => {
    positions.current = new Map(measurement.items.map(({ node, left }) => [node, left]));
    bounds.current = { width: measurement.width, metadataWidth: measurement.metadataWidth };
  };
  const animate = (node: HTMLElement, keyframes: Keyframe[]) => {
    animations.current.get(node)?.cancel();
    const animation = node.animate(keyframes, { duration: DURATION, easing: EASING });
    animations.current.set(node, animation);
    animation.onfinish = () => {
      if (animations.current.get(node) === animation) animations.current.delete(node);
    };
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reset = () => {
      stop();
      const measurement = measure();
      if (measurement) remember(measurement);
    };
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new ResizeObserver(reset);
    observer.observe(root);
    window.addEventListener("resize", reset);
    document.addEventListener("visibilitychange", reset);
    preference.addEventListener("change", reset);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", reset);
      preference.removeEventListener("change", reset);
      stop();
      positions.current.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const measurement = measure();
    if (!measurement) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resized = Math.abs(measurement.width - bounds.current.width) > 0.5;
    if (reduced || resized || document.hidden || typeof rootRef.current?.animate !== "function") {
      stop();
    } else {
      // Read all positions before writing animations. Active transforms preserve
      // the visual position when another project is selected mid-transition.
      for (const { node, left, offset } of measurement.items) {
        const previous = positions.current.get(node);
        if (previous !== undefined && Math.abs(previous - left) > 0.5) {
          animate(node, [{ transform: `translateX(${previous - left + offset}px)` }, { transform: "translateX(0)" }]);
        }
      }
      const growth = measurement.metadataWidth - bounds.current.metadataWidth;
      if (measurement.metadata && Math.abs(growth) > 0.5) {
        // Clip only this small text region while it grows, so longer metadata
        // cannot overlap controls that are still moving out of its previous slot.
        animate(measurement.metadata, [
          { clipPath: `inset(-8px ${Math.max(0, growth + measurement.clipRight)}px -8px 0)` },
          { clipPath: "inset(-8px 0 -8px 0)" },
        ]);
      }
    }
    remember(measurement);
  }, [layoutKey]);

  return rootRef;
}
