import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TransitionEvent } from "react";

type HistoryMode = "list" | "topology";
type HistoryPhase = "idle" | "layout" | "fade-out" | "fade-in";

export function useHistoryModeTransition(contextKey: string) {
  const [state, setState] = useState(() => {
    const mode: HistoryMode = localStorage.getItem("gitkit.historyMode") === "topology" ? "topology" : "list";
    return { mode, renderedMode: mode, phase: "idle" as HistoryPhase,
      viewportWidth: null as number | null, revealContext: null as string | null };
  });
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef(state.mode);
  const renderedModeRef = useRef(state.renderedMode);
  const requestRef = useRef(0);
  const phaseRef = useRef<HistoryPhase>(state.phase);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;

  useEffect(() => { localStorage.setItem("gitkit.historyMode", state.mode); }, [state.mode]);

  const settle = useCallback(() => {
    const mode = targetRef.current;
    const request = ++requestRef.current;
    const revealContext = contextRef.current;
    phaseRef.current = "idle";
    setState(current => requestRef.current !== request
      || (current.phase === "idle" && current.renderedMode === mode) ? current : {
      ...current, renderedMode: mode, phase: "idle", viewportWidth: null,
      revealContext: current.renderedMode !== mode ? revealContext : current.revealContext,
    });
  }, []);

  const finishLayout = useCallback(() => {
    if (phaseRef.current !== "layout") return;
    if (targetRef.current === renderedModeRef.current) { settle(); return; }
    const request = requestRef.current;
    phaseRef.current = "fade-out";
    setState(current => requestRef.current !== request ? current : { ...current, phase: "fade-out" });
  }, [settle]);

  const finishFade = useCallback(() => {
    if (phaseRef.current === "fade-in") { settle(); return; }
    if (phaseRef.current !== "fade-out") return;
    const mode = targetRef.current, request = requestRef.current;
    const revealContext = contextRef.current;
    phaseRef.current = "fade-in";
    // Swap only while the persistent viewport is transparent. Incoming content
    // gets the same fade whether it is a list, a topology, or an empty state.
    startTransition(() => setState(current => requestRef.current !== request || current.mode !== mode ? current : {
      ...current, renderedMode: mode, phase: "fade-in", viewportWidth: null, revealContext,
    }));
  }, [settle]);

  const changeMode = useCallback((mode: HistoryMode) => {
    if (mode === targetRef.current) return;
    targetRef.current = mode;
    requestRef.current += 1;
    const width = timelineRef.current?.getBoundingClientRect().width ?? 0;
    const animate = width > 0 && !!workspaceRef.current?.getClientRects().length
      && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderedMode = renderedModeRef.current;
    phaseRef.current = animate ? "layout" : "idle";
    // Retain the outgoing viewport through reversals too: topology must not
    // rerender its SVG and recenter its camera on every sidebar animation frame.
    setState(current => ({ ...current, mode,
      renderedMode: animate ? renderedMode : mode,
      phase: animate ? "layout" : "idle",
      viewportWidth: animate ? current.viewportWidth ?? width : null,
      revealContext: !animate && current.renderedMode !== mode ? contextRef.current : current.revealContext,
    }));
  }, []);

  const onTransitionEnd = useCallback((event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === "grid-template-columns") finishLayout();
  }, [finishLayout]);

  const onContentTransitionEnd = useCallback((event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === "opacity") finishFade();
  }, [finishFade]);

  useLayoutEffect(() => {
    settle();
    setState(current => current.revealContext === null ? current : { ...current, revealContext: null });
  }, [contextKey, settle]);

  useLayoutEffect(() => {
    renderedModeRef.current = state.renderedMode;
    phaseRef.current = state.phase;
  }, [state.renderedMode, state.phase]);

  useLayoutEffect(() => {
    if (timelineRef.current) timelineRef.current.inert = state.phase !== "idle";
  }, [state.phase]);

  useLayoutEffect(() => {
    if (state.phase === "idle") return;
    const workspace = workspaceRef.current;
    const content = timelineRef.current;
    if (!workspace || !content || !workspace.getClientRects().length) { settle(); return; }
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) { settle(); return; }
    const phase = state.phase, request = requestRef.current;
    const next = () => {
      if (requestRef.current !== request || phaseRef.current !== phase) return;
      if (phase === "layout") finishLayout(); else finishFade();
    };
    const duration = parseFloat(getComputedStyle(phase === "layout" ? workspace : content).transitionDuration) * 1000;
    if (!duration) { next(); return; }
    // transitionend owns sequencing; each stage also covers canceled events.
    const timer = window.setTimeout(next, duration + 80);
    const width = workspace.clientWidth, height = workspace.clientHeight;
    const observer = new ResizeObserver(() => {
      if (workspace.clientWidth !== width || workspace.clientHeight !== height) settle();
    });
    observer.observe(workspace);
    const reduceMotion = () => { if (motion.matches) settle(); };
    motion.addEventListener("change", reduceMotion);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      motion.removeEventListener("change", reduceMotion);
    };
  }, [state.mode, state.phase, finishLayout, finishFade, settle]);

  return { ...state, moving: state.phase === "layout", changing: state.phase !== "idle",
    workspaceRef, timelineRef, changeMode, onTransitionEnd, onContentTransitionEnd };
}
