import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** Matches the closing transition in lanes-menus.css, plus a little slack. */
export const LK_MENU_EXIT_MS = 160;

export type PresenceState = "entering" | "open" | "closing";
type Phase = PresenceState | "hidden";

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keep a menu mounted long enough to play its exit transition.
 *
 * The element renders first with `data-state="entering"` (its hidden pose), the style is flushed,
 * and it flips to `"open"` before paint, so CSS transitions animate it in. Closing switches to
 * `"closing"` and unmounts after `ms`. Because it's transition-driven, reopening mid-exit simply
 * reverses from wherever it is. While closing the element is `inert` (unfocusable, no pointer).
 */
export function usePresence(open: boolean, ref: RefObject<HTMLElement>, ms = LK_MENU_EXIT_MS) {
  const [phase, setPhase] = useState<Phase>(open ? "entering" : "hidden");
  // Derive the next phase during render so no frame ever paints a stale state.
  let next = phase;
  if (open && phase === "hidden") next = reducedMotion() ? "open" : "entering";
  else if (open && phase === "closing") next = "open";
  else if (!open && (phase === "open" || phase === "entering")) next = reducedMotion() ? "hidden" : "closing";
  if (next !== phase) setPhase(next);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.inert = next === "closing";
    if (next !== "entering") return;
    el?.getBoundingClientRect(); // commit the hidden pose so the change to "open" transitions
    setPhase("open");
  }, [next, ref]);

  const latestMs = useRef(ms);
  latestMs.current = ms;
  useEffect(() => {
    if (next !== "closing") return;
    const timer = window.setTimeout(() => setPhase((p) => p === "closing" ? "hidden" : p), latestMs.current);
    return () => window.clearTimeout(timer);
  }, [next]);

  const state: PresenceState | null = next === "hidden" ? null : next;
  return {
    mounted: state !== null,
    closing: state === "closing",
    /** Spread onto the animated element. */
    attrs: { "data-state": state ?? undefined, "aria-hidden": state === "closing" || undefined },
  };
}

/** Remember the last non-null value so a closing popup can keep rendering it. */
export function useLastValue<T>(value: T | null | undefined): T | null {
  const last = useRef<T | null>(value ?? null);
  if (value != null) last.current = value;
  return value ?? last.current;
}
