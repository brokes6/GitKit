import { useLayoutEffect, useState } from "react";

// Open dialogs, oldest first. Only the last one traps Tab and answers Escape, so a
// dialog opened over another (e.g. a confirm inside Settings) behaves as a stack.
const stack: HTMLElement[] = [];

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
    !element.hasAttribute("disabled") && element.tabIndex >= 0
    && !(element instanceof HTMLInputElement && element.type === "hidden")
    && element.getClientRects().length > 0);
}

/** True when `dialog` is the innermost open dialog registered with {@link useDialogFocus}. */
export function isTopDialog(dialog: HTMLElement | null): boolean {
  return !!dialog && stack[stack.length - 1] === dialog;
}

/**
 * Modal focus behaviour shared by dialogs: move focus inside on open (unless a
 * child such as an autofocused input already took it), keep Tab within the
 * topmost dialog, and hand focus back to the opener when it closes.
 * Pass `active=false` while the exit animation plays.
 */
export function useDialogFocus(ref: { readonly current: HTMLElement | null }, active = true) {
  // Read during the first render: an autoFocus child steals focus at commit.
  const [opener] = useState(() => {
    const element = document.activeElement;
    return element instanceof HTMLElement && element !== document.body ? element : null;
  });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    stack.push(dialog);
    if (!dialog.contains(document.activeElement)) {
      if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
      dialog.style.outline = "none";
      dialog.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTopDialog(dialog)) return;
      const items = focusableIn(dialog);
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const current = document.activeElement;
      if (!dialog.contains(current) || current === dialog) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const index = stack.lastIndexOf(dialog);
      if (index >= 0) stack.splice(index, 1);
      const focused = document.activeElement;
      // Only restore when focus was lost with the dialog, never steal it from
      // wherever the user has already moved, or from another open dialog.
      const lost = !focused || focused === document.body || dialog.contains(focused);
      const below = stack[stack.length - 1];
      // Back to the opener, unless it sits outside a dialog that is still open.
      if (lost && opener?.isConnected && (!below || below.contains(opener))) opener.focus({ preventScroll: true });
    };
  }, [active, ref, opener]);
}
