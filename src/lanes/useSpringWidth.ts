import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

// Spring an element's width whenever a render changes its natural width (a
// label gets longer, an entry appears or disappears). At rest the element keeps
// `width: auto`, so it always settles on its exact content size; during the
// motion the Web Animations API animates an explicit width from where it
// visually is to the new size, with a small overshoot ("弹一下").
//
// Only width animates (no overflow change), so popovers inside aren't clipped.

const SPRING = "linear(0, 0.14 6%, 0.48 15%, 0.87 27%, 1.035 37%, 1.055 44%, 1.035 54%, 1.004 70%, 0.998 82%, 1)";
const DURATION = 520;

export function useSpringWidth(ref: RefObject<HTMLElement>) {
  const last = useRef<number | null>(null);
  const anim = useRef<Animation | null>(null);

  // Runs after every render of the owner: cheap (one layout read when idle).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const running = anim.current;
    // Where it is on screen right now (mid-animation or at rest).
    const visual = el.getBoundingClientRect().width;
    if (running) running.cancel();
    const natural = running ? el.getBoundingClientRect().width : visual;
    const from = last.current;
    last.current = natural;
    if (from === null || Math.abs(natural - (running ? visual : from)) < 1) {
      // No size change: resume an interrupted animation's target silently.
      if (running && Math.abs(natural - visual) >= 1) start(el, visual, natural);
      return;
    }
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    start(el, running ? visual : from, natural);
  });

  function start(el: HTMLElement, from: number, to: number) {
    const a = el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: DURATION, easing: SPRING });
    anim.current = a;
    a.onfinish = a.oncancel = () => { if (anim.current === a) anim.current = null; };
  }
}
