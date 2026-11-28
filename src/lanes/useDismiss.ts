import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Close on outside pointer-down or Escape. `ignore` skips matching toggles.
 *
 * Dismissal never consumes the press: the outside element still receives its
 * click (one click closes this menu *and* activates what was clicked), and it
 * never moves focus.
 */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement>, onClose: () => void, ignore?: string) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Element;
      if (ref.current?.contains(target) || (ignore && target.closest?.(ignore))) return;
      onClose();
    };
    // An inner menu that handles Esc calls preventDefault; only the innermost closes.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) onClose(); };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); };
  }, [open, ref, onClose, ignore]);
}
