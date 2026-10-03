/// <reference lib="es2022.intl" />
import { useLayoutEffect, useRef } from "react";

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** A single, bounded text entrance when the toolbar view mounts. */
export function ToolbarText({ children, order = 0 }: { children: string; order?: number }) {
  const visual = useRef<HTMLSpanElement>(null);
  const initialOrder = useRef(order);
  const characters = segmenter
    ? Array.from(segmenter.segment(children), ({ segment }) => segment) : Array.from(children);

  useLayoutEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches || !visual.current || typeof visual.current.animate !== "function") return;
    const animations = Array.from(visual.current.children, (character, index) => character.animate([
      { transform: "translateY(8px)", opacity: .15, offset: 0 },
      { transform: "translateY(-4px)", opacity: 1, offset: .55 },
      { transform: "translateY(1.5px)", opacity: 1, offset: .78 },
      { transform: "translateY(0)", opacity: 1, offset: 1 },
    ], {
      duration: 340,
      delay: Math.min(initialOrder.current * 12 + index * 14, 96),
      easing: "ease-out",
      fill: "backwards",
    }));
    const stop = () => animations.forEach((animation) => animation.cancel());
    preference.addEventListener("change", stop);
    return () => { preference.removeEventListener("change", stop); stop(); };
    // Text/data updates keep their final position; only a new view starts motion.
  }, []);

  return <span className="gk-toolbar-text">
    <span className="sr-only">{children}</span>
    <span ref={visual} aria-hidden="true">{characters.map((character, index) =>
      <span className="gk-toolbar-glyph" key={index}>{character}</span>)}</span>
  </span>;
}
