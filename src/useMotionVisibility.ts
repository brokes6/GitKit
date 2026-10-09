import { useEffect } from "react";
import type { RefObject } from "react";

/** Pause CSS loading loops when their surface cannot be seen. */
export function useMotionVisibility(ref: RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!enabled) {
      element.dataset.motionPaused = "true";
      return;
    }
    let inView = false;
    const update = () => { element.dataset.motionPaused = String(document.hidden || !inView); };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [ref, enabled]);
}
