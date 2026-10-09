import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type ReactElement } from "react";

const DialogPresenceContext = createContext({ closing: false });

export function useDialogPresence() {
  return useContext(DialogPresenceContext);
}

/** Keep a conditionally rendered dialog mounted only long enough to play its exit. */
export function DialogPresence({ children, onExited }: { children: ReactElement | null; onExited?: () => void }) {
  const [snapshot, setSnapshot] = useState({ previous: children, retained: children, generation: 0 });
  const openRef = useRef(!!children);
  const exitedRef = useRef(false);
  const onExitedRef = useRef(onExited);
  openRef.current = !!children;
  onExitedRef.current = onExited;

  // Keep the exiting session, but initialize a fresh one on every logical open.
  if (children !== snapshot.previous) {
    setSnapshot({ previous: children, retained: children ?? snapshot.retained,
      generation: snapshot.generation + (children && !snapshot.previous ? 1 : 0) });
  }
  const closing = !children && !!snapshot.retained;
  const finish = useCallback(() => {
    if (openRef.current) return;
    exitedRef.current = true;
    setSnapshot(current => ({ ...current, retained: null }));
  }, []);

  useEffect(() => {
    if (!closing) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timer = window.setTimeout(finish, preference.matches ? 0 : 200);
    const reduceMotion = () => { if (preference.matches) finish(); };
    preference.addEventListener("change", reduceMotion);
    return () => {
      window.clearTimeout(timer);
      preference.removeEventListener("change", reduceMotion);
    };
  }, [closing, finish]);

  useEffect(() => {
    if (children) exitedRef.current = false;
    else if (!snapshot.retained && exitedRef.current) {
      exitedRef.current = false;
      onExitedRef.current?.();
    }
  }, [children, snapshot.retained]);

  if (!children && !snapshot.retained) return null;
  return <DialogPresenceContext.Provider value={{ closing }}>
    <div style={{ display: "contents" }} aria-hidden={closing || undefined}
      ref={element => { if (element) element.inert = closing; }}
      onAnimationEnd={event => {
        if (closing && event.animationName === "gk-modal-out" && (event.target as HTMLElement).getAttribute("role") === "dialog") finish();
      }}>
      <Fragment key={snapshot.generation}>{children ?? snapshot.retained}</Fragment>
    </div>
  </DialogPresenceContext.Provider>;
}
