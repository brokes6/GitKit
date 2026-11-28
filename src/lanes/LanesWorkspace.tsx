import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, FileText, GitBranchPlus, GitPullRequestArrow, Undo2 } from "lucide-react";
import { LaneContextMenu } from "./LaneContextMenu";
import { branchColor } from "../git";
import { toast } from "sonner";
import { buildStackModel } from "./stackModel";
import { buildLaneViews, laneLinks, selectLaneIds } from "./laneLayout";
import type { LaneRole, LaneView } from "./laneLayout";
import { Dock } from "./Dock";
import { EmptyLane, Lane, StageMessage } from "./Lane";
import { LinkOverlay } from "./LinkOverlay";
import { WorkspaceBackground } from "./PixelField";
import type { PixelFieldHandle } from "./PixelField";
import type { CreateRequest, LaneHandlers, LaneMenuItem, LaneMenuTarget, LanesWorkspaceProps, Slot } from "./types";
import { loadBases, saveBase } from "./util";
import { MAX_LANES, useLaneSettings, useLaneTrunk } from "./settings";
import { tf, tx } from "../i18n";
import "./lanes.css";
import "./lanes-menus.css";

// The lanes workspace: four lanes, one branch each, chosen by role —
//   1 the checked-out branch (+ its uncommitted work), 2 its parent/base,
//   3–4 the most recently changed other branches —
// with dashed links between related commits across lanes and a compact dock.
// It owns only presentation state (which branch sits where, pins, focus);
// data, git actions, dialogs and the detail drawer come from the host — the
// full app in Tauri, or a demo wrapper in a plain browser.
//
// Module map: laneLayout.ts (lane choice + links), stackModel.ts (base inference),
// Lane.tsx / LaneCapsule.tsx / BranchTree.tsx (lane UI), LinkOverlay.tsx (dashed
// links), Dock.tsx (dock + menus + create popover), PixelField.tsx (background).

export type { LaneBusy, LaneMenuItem, LaneProjectRef, LanesWorkspaceProps } from "./types";

const LANE_MIN = 290;
const MOTION_MS = 460;
const DRAG_THRESHOLD = 5;
const SETTLE_MS = 240;

/** A stable function identity that always calls the latest closure. */
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
}

interface DragState { key: number; from: number; over: number; pitch: number }

export function LanesWorkspace(props: LanesWorkspaceProps) {
  const { theme, tokens, demo, project, status, branches, commits, changes, working } = props;
  const path = project?.path ?? "";
  const [bases, setBases] = useState<Record<string, string>>(() => loadBases(path));
  useEffect(() => { setBases(loadBases(path)); }, [path]);

  const settings = useLaneSettings();
  const chosenTrunk = useLaneTrunk(path);
  const { envOrder } = settings;
  const model = useMemo(() => status === "ready"
    ? buildStackModel(branches, commits, bases, { trunk: chosenTrunk || undefined, longLived: envOrder })
    : null, [status, branches, commits, bases, chosenTrunk, envOrder]);
  const currentBranch = branches.find((b) => b.current && !b.isRemote);
  const current = currentBranch?.name;

  // Visible lane count follows the stage width (up to four).
  const stageRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(MAX_LANES);
  const count = Math.min(fit, settings.maxLanes);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setFit(Math.max(1, Math.min(MAX_LANES, Math.floor(el.clientWidth / LANE_MIN))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  // ── which branch sits where ──
  // Roles fill the lanes; user pins (capsule pick, dock tree, drag order) win
  // at their position until the checked-out branch changes.
  const [pins, setPins] = useState<Record<number, string>>({});
  const [touched, setTouched] = useState<Record<string, number>>({});
  useEffect(() => { setPins({}); }, [current, path]);
  useEffect(() => { setTouched({}); }, [path]);
  const { slots: slotRules, recentIncludesMerged: includeMerged } = settings;
  // Unchanged lanes keep their previous view object so their memoised lane
  // (and its hundreds of rows) is not re-rendered when only positions change.
  const viewMemo = useRef<{ model: unknown; byId: Map<string, LaneView> }>({ model: null, byId: new Map() });
  const views = useMemo<LaneView[]>(() => {
    if (!model) return [];
    const rules = { rules: slotRules, includeMerged };
    const natural = new Map(selectLaneIds(model, { count, current, touched, ...rules }).map((p) => [p.id, p.role]));
    const picks = selectLaneIds(model, { count, current, pins, touched, ...rules })
      // A pinned branch keeps its natural role label when it has one.
      .map((p) => p.role === "pinned" && natural.has(p.id) ? { id: p.id, role: natural.get(p.id) as LaneRole } : p);
    const memo = viewMemo.current;
    const reuse = memo.model === model;
    const next = buildLaneViews(model, picks).map((v) => {
      const prev = reuse ? memo.byId.get(v.id) : undefined;
      return prev && prev.role === v.role && prev.rows.length === v.rows.length ? prev : v;
    });
    viewMemo.current = { model, byId: new Map(next.map((v) => [v.id, v])) };
    return next;
  }, [model, count, current, pins, touched, slotRules, includeMerged]);
  const links = useMemo(() => model ? laneLinks(views, model) : [], [views, model]);

  // Slots keep a stable key per branch so lanes animate when positions shift;
  // lanes that leave stay mounted (with their last view) while they shrink away.
  const [slots, setSlots] = useState<Slot[]>([]);
  const keySeq = useRef(0);
  const viewCache = useRef(new Map<string, LaneView>());
  for (const v of views) viewCache.current.set(v.id, v);
  useEffect(() => { setSlots([]); }, [path]);
  useEffect(() => {
    setSlots((prev) => {
      const live = prev.filter((s) => !s.exit);
      const ids = views.map((v) => v.id);
      const same = live.length === ids.length && live.every((s, i) => s.branch === ids[i]);
      if (same) return prev.some((s) => s.exit) ? prev : prev;
      const animate = live.length > 0;
      const next: Slot[] = ids.map((id) => {
        const old = live.find((s) => s.branch === id);
        return old ? { key: old.key, branch: id, enter: old.enter } : { key: ++keySeq.current, branch: id, enter: animate };
      });
      const gone = live.filter((s) => !ids.includes(s.branch)).map((s) => ({ ...s, enter: false, exit: animate }));
      return [...next, ...gone.filter((s) => s.exit)];
    });
  }, [views]);
  useEffect(() => {
    if (!slots.some((s) => s.exit || s.enter)) return;
    const t = setTimeout(() => setSlots((prev) => prev.filter((s) => !s.exit).map((s) => s.enter ? { ...s, enter: false } : s)), MOTION_MS + 40);
    return () => clearTimeout(t);
  }, [slots]);
  const shown = slots.filter((s) => !s.exit);

  // Ripple the pixel field where a lane appears (it rises from the dock / trunk).
  const pixelRef = useRef<PixelFieldHandle>(null);
  const rippled = useRef(new Set<number>());
  useEffect(() => {
    const stage = stageRef.current;
    const entering = slots.filter((s) => s.enter && !rippled.current.has(s.key));
    if (!stage || !entering.length) return;
    const raf = requestAnimationFrame(() => {
      const box = stage.closest(".lk-root")!.getBoundingClientRect();
      const laneWidth = stage.clientWidth / count;
      for (const s of entering) {
        rippled.current.add(s.key);
        const el = stage.querySelector<HTMLElement>(`[data-slot-key="${s.key}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        pixelRef.current?.ripple(r.left - box.left + laneWidth / 2, r.bottom - box.top);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [slots, count]);

  const [focus, setFocus] = useState<{ slotKey: number; branch: string } | null>(null);
  const [create, setCreate] = useState<CreateRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const createRequest = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    setCreate(null);
    setFocus(null);
    setBusy(false);
    return () => { createRequest.current = null; };
  }, [path]);

  const laneIndex = useEvent((branch: string) => shown.findIndex((s) => s.branch === branch));
  /** Put `branch` at position `at`; if it is already shown elsewhere, the two swap. */
  const pinAt = useEvent((at: number, branch: string) => {
    const order = shown.map((s) => s.branch);
    if (order[at] === branch) return;
    const next: Record<number, string> = { ...pins, [at]: branch };
    const from = order.indexOf(branch);
    if (from >= 0 && order[at]) next[from] = order[at];
    setPins(next);
  });
  const onPick = useEvent((slotKey: number, branch: string) => {
    const at = shown.findIndex((s) => s.key === slotKey);
    if (at >= 0) pinAt(at, branch);
  });
  const showAnywhere = useEvent((branch: string) => {
    const visible = shown.find((s) => s.branch === branch);
    if (visible) { setFocus({ slotKey: visible.key, branch }); return; }
    // Settings → 分支区域 → 新打开的分支: a 1-based lane, or 0 for the last one.
    const last = Math.max(0, Math.min(count, Math.max(shown.length, 1)) - 1);
    pinAt(settings.openAt > 0 ? Math.min(settings.openAt - 1, last) : last, branch);
  });
  const onFocus = useEvent((slotKey: number, branch: string) => {
    setFocus((f) => f?.slotKey === slotKey && f.branch === branch ? f : { slotKey, branch });
  });

  // Hover linking: the same branch lights up in every lane and its dashed links
  // stand out. A CSS rule written straight into a <style> element — no re-render.
  const hoverStyle = useRef<HTMLStyleElement>(null);
  const hovered = useRef<string | null>(null);
  const onHover = useEvent((branch: string | null) => {
    if (hovered.current === branch || !hoverStyle.current) return;
    hovered.current = branch;
    const sel = branch ? JSON.stringify(branch) : "";
    hoverStyle.current.textContent = branch
      ? `.lk-card[data-branch=${sel}]{border-color:color-mix(in srgb,var(--lk-branch) 22%,var(--lk-border))}`
        + `.lk-link{opacity:.45}.lk-link[data-lanes~=${sel}]{opacity:1}`
      : "";
  });

  // Hovering a "merged into" step marks the merge commit in its lane.
  const commitStyle = useRef<HTMLStyleElement>(null);
  const onHoverCommit = useEvent((hash: string | null) => {
    if (!commitStyle.current) return;
    commitStyle.current.textContent = hash
      ? `.lk-commit[data-commit-hash=${JSON.stringify(hash)}]{background:var(--lk-hover);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--lk-branch) 45%,transparent)}`
      : "";
  });

  // Clicking a step: show that branch beside this lane, then scroll to the merge commit.
  const reveal = useRef<{ lane: string; hash: string } | null>(null);
  const onRevealMerge = useEvent((from: string, into: string, hash?: string) => {
    if (hash) reveal.current = { lane: into, hash };
    if (shown.some((s) => s.branch === into)) { setRevealTick((n) => n + 1); return; }
    const at = shown.findIndex((s) => s.branch === from);
    const cur = shown.findIndex((s) => s.branch === current);
    const free = shown.length < count ? shown.length : -1;
    const order = free >= 0 ? [free] : [at + 1, at - 1, ...shown.map((_, i) => i)];
    const target = order.find((i) => i >= 0 && i < count && i !== at && (i !== cur || free >= 0));
    if (target !== undefined) pinAt(target, into);
  });
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const r = reveal.current;
    if (!r) return;
    const scroll = stageRef.current?.querySelector<HTMLElement>(`[data-lane-scroll=${JSON.stringify(r.lane)}]`);
    if (!scroll) return; // not mounted yet; the next slot change retries
    reveal.current = null;
    const row = scroll.querySelector<HTMLElement>(`[data-commit-hash=${JSON.stringify(r.hash)}]`);
    if (!row) return;
    const top = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    scroll.scrollTo({ top: Math.max(0, top - scroll.clientHeight / 3), behavior: "smooth" });
    row.dataset.flash = "true";
    const t = setTimeout(() => { delete row.dataset.flash; }, 1600);
    return () => clearTimeout(t);
  }, [slots, revealTick]);

  // ── lane reordering: drag a lane by its top bar ──
  const lanesRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const settle = useRef<{ key: number; offset: number } | null>(null);
  const onDragStart = useEvent((event: ReactPointerEvent, slotKey: number) => {
    const container = lanesRef.current;
    if (event.button !== 0 || !container || slots.some((s) => s.enter || s.exit)) return;
    const from = shown.findIndex((s) => s.key === slotKey);
    const els = shown.map((s) => container.querySelector<HTMLElement>(`[data-slot-key="${s.key}"]`));
    const el = els[from];
    if (from < 0 || !el || els.length < 2) return;
    const pitch = els[1]!.getBoundingClientRect().left - els[0]!.getBoundingClientRect().left;
    const n = shown.length, startX = event.clientX, startY = event.clientY;
    let moved = false, dx = 0, over = from;

    const clear = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
    const move = (e: PointerEvent) => {
      const rawDx = e.clientX - startX;
      if (!moved) {
        if (Math.hypot(rawDx, e.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        setDrag({ key: slotKey, from, over, pitch });
      }
      dx = Math.max(-from * pitch - pitch * 0.25, Math.min((n - 1 - from) * pitch + pitch * 0.25, rawDx));
      el.style.transform = `translateX(${dx}px)`;
      const next = Math.max(0, Math.min(n - 1, Math.round(from + dx / pitch)));
      if (next !== over) { over = next; setDrag({ key: slotKey, from, over, pitch }); }
    };
    const finish = (commit: boolean) => {
      clear();
      if (!moved) return;
      // Swallow the click that follows the drag so the capsule menu stays shut.
      const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const target = commit ? over : from;
      settle.current = { key: slotKey, offset: from * pitch + dx - target * pitch };
      if (target !== from) {
        const order = shown.map((s) => s);
        const [moving] = order.splice(from, 1);
        order.splice(target, 0, moving);
        // Reorder now (same commit as dropping the drag state) and pin the new order.
        setSlots(order);
        setPins(Object.fromEntries(order.map((s, i) => [i, s.branch])));
      }
      setDrag(null);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  });
  // After the drop, glide the dragged lane from where it was released into its slot.
  useLayoutEffect(() => {
    const s = settle.current;
    if (!s || drag) return;
    settle.current = null;
    const el = lanesRef.current?.querySelector<HTMLElement>(`[data-slot-key="${s.key}"]`);
    if (!el) return;
    el.style.transform = "";
    if (Math.abs(s.offset) < 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.settling = "true";
    const anim = el.animate([{ transform: `translateX(${s.offset}px)` }, { transform: "translateX(0)" }],
      { duration: SETTLE_MS, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)" });
    anim.onfinish = anim.oncancel = () => { delete el.dataset.settling; };
  }, [drag, slots]);
  const shiftFor = (i: number) => {
    if (!drag || i === drag.from) return 0;
    if (drag.from < drag.over && i > drag.from && i <= drag.over) return -drag.pitch;
    if (drag.from > drag.over && i >= drag.over && i < drag.from) return drag.pitch;
    return 0;
  };

  // ── merge-request drag: drop a pushed branch's name onto another lane ──
  const [requestDrag, setRequestDrag] = useState<{ source: string; target: string | null } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const ghostAt = useRef({ x: 0, y: 0 });
  const placeGhost = () => {
    const g = ghostRef.current;
    if (g) g.style.transform = `translate(${ghostAt.current.x + 14}px, ${ghostAt.current.y + 16}px)`;
  };
  useLayoutEffect(placeGhost, [requestDrag]);
  const onRequestDragStart = useEvent((event: ReactPointerEvent, source: string) => {
    const onDrop = props.onDropRequest;
    if (event.button !== 0 || !onDrop || drag) return;
    const byId = new Map(views.map((v) => [v.id, v]));
    const view = byId.get(source);
    const root = stageRef.current;
    if (!view || !root) return;
    event.preventDefault(); // no text selection while dragging
    const pushed = !!view.branch.upstream;
    const startX = event.clientX, startY = event.clientY;
    let moved = false, target: string | null = null;
    const accepts = (id: string) => id !== source && !!byId.get(id)?.branch.upstream;
    const cards = () => Array.from(root.querySelectorAll<HTMLElement>("[data-lane-card]"));
    const mark = () => {
      for (const card of cards()) {
        const id = card.dataset.laneCard!;
        card.dataset.drop = id === source ? "source" : !accepts(id) ? "no" : id === target ? "over" : "ok";
        if (id === target) card.dataset.dropLabel = `${tx("松开创建合并请求")}\n${source} → ${id}`;
        else delete card.dataset.dropLabel;
      }
    };
    const unmark = () => { for (const card of cards()) { delete card.dataset.drop; delete card.dataset.dropLabel; } };
    const clear = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
    const move = (e: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        if (!pushed) {
          clear();
          toast.info(tf("先推送 {0}，才能拖到其他分支上创建合并请求", source));
          return;
        }
        setRequestDrag({ source, target: null });
      }
      ghostAt.current = { x: e.clientX, y: e.clientY };
      placeGhost();
      const card = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-lane-card]");
      const id = card?.dataset.laneCard ?? null;
      const next = id && accepts(id) ? id : null;
      if (next !== target || !card) {
        target = next;
        mark();
        setRequestDrag({ source, target });
      }
    };
    const finish = (commit: boolean) => {
      clear();
      if (!moved) return;
      const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      unmark();
      setRequestDrag(null);
      if (commit && target) onDrop(source, target);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  });

  // ── right-click menus: commit rows and lane branches ──
  const [menu, setMenu] = useState<{
    x: number; y: number; items: LaneMenuItem[]; target: HTMLElement | null; avoid?: { top: number; bottom: number };
  } | null>(null);
  // Mark what the menu is about (the commit row, or the branch's card) while it's open.
  useEffect(() => {
    const el = menu?.target;
    if (!el) return;
    el.dataset.menuTarget = "true";
    return () => { delete el.dataset.menuTarget; };
  }, [menu]);
  const onContextMenu = useEvent((event: ReactMouseEvent, target: LaneMenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    if (!model) return;
    const items: LaneMenuItem[] = [];
    if (target.kind === "commit") {
      const commit = views.find((v) => v.id === target.lane)?.rows.find((c) => c.hash === target.hash)
        ?? model.trunkCommits.find((c) => c.hash === target.hash);
      items.push({ label: tx("查看提交详情"), icon: <FileText size={14} />, onClick: () => props.onOpenCommit(target.hash) });
      if (commit) items.push({
        label: tx("从这个提交新建分支…"), icon: <GitBranchPlus size={14} />,
        onClick: () => setCreate({ base: target.lane, commit: { hash: commit.hash, short: commit.short, message: commit.message } }),
      });
      const host = props.commitMenu?.(target.hash, target.lane) ?? [];
      if (host.length) items.push("sep", ...host);
    } else {
      const { branch, slotKey } = target;
      const view = views.find((v) => v.id === branch);
      if (branch !== current) items.push({ label: tx("切换到此分支"), icon: <Undo2 size={14} />, onClick: () => props.onCheckout(branch) });
      items.push({ label: tf("基于 {0} 新建分支…", branch), icon: <GitBranchPlus size={14} />, onClick: () => setCreate({ base: branch, slotKey }) });
      if (props.onCreateRequest && view && !view.isTrunk) {
        items.push({ label: props.createRequestLabel ?? tx("创建合并请求"), icon: <GitPullRequestArrow size={14} />,
          onClick: () => props.onCreateRequest?.(branch) });
      }
      const host = props.branchMenu?.(branch) ?? [];
      if (host.length) items.push("sep", ...host);
    }
    const anchor = event.currentTarget as HTMLElement;
    const marked = target.kind === "commit" ? anchor : anchor.closest<HTMLElement>(".lk-lane")?.querySelector<HTMLElement>(".lk-card") ?? null;
    const row = target.kind === "commit" ? anchor.getBoundingClientRect() : null;
    setMenu({ x: event.clientX, y: event.clientY, items, target: marked,
      avoid: row ? { top: row.top, bottom: row.bottom } : undefined });
  });

  const onCreateFrom = useEvent((slotKey: number, branch: string) => setCreate({ base: branch, slotKey }));
  const onCheckout = useEvent((branch: string) => props.onCheckout(branch));
  const onOpenChanges = useEvent((file?: string) => props.onOpenChanges(file));
  const onOpenCommit = useEvent((hash: string) => props.onOpenCommit(hash));
  const onOpenRequest = useEvent((branch: string) => props.onOpenRequest?.(branch));
  const onCreateRequest = useEvent((branch: string) => props.onCreateRequest?.(branch));
  const handlers = useMemo<LaneHandlers>(() => ({
    onPick, onCreateFrom, onCheckout, onOpenChanges, onOpenCommit, onHover, onDragStart, onFocus, laneIndex,
    onOpenRequest, onCreateRequest, onRevealMerge, onHoverCommit, onRequestDragStart, onContextMenu,
  }), [onPick, onCreateFrom, onCheckout, onOpenChanges, onOpenCommit, onHover, onDragStart, onFocus, laneIndex,
    onOpenRequest, onCreateRequest, onRevealMerge, onHoverCommit, onRequestDragStart, onContextMenu]);


  const closeMenu = useCallback(() => setMenu(null), []);

  const submitCreate = async (name: string, base: string) => {
    if (!model || !create || createRequest.current) return;
    const request = Symbol();
    createRequest.current = request;
    const trunk = model.trunk;
    // From a commit, `base` is its hash; the recorded base is the lane it was picked in.
    const from = create.commit?.short ?? base;
    const recorded = create.commit ? create.base : base;
    setBusy(true);
    try {
      await props.onCreateBranch(name, base);
      const updatedBases = recorded !== trunk ? saveBase(path, name, recorded) : null;
      if (createRequest.current !== request) return;
      if (updatedBases) setBases(updatedBases);
      // A fresh branch has no commits yet; mark it recent so it takes a "recent" lane.
      setTouched((t) => ({ ...t, [name]: Date.now() }));
      setCreate(open => open === create ? null : open);
      toast.success(tf("已从 {0} 新建 {1}", from, name));
    } catch (e) {
      if (createRequest.current === request) toast.error(tf("创建失败：{0}", e instanceof Error ? e.message : String(e)));
    } finally {
      if (createRequest.current === request) {
        createRequest.current = null;
        setBusy(false);
      }
    }
  };

  const defaultBase = focus?.branch ?? current ?? model?.trunk ?? "main";
  const linkVersion = `${slots.map((s) => s.branch).join("|")}:${count}:${drag ? "d" : ""}`;

  return (
    <div className="lk-root" data-theme={theme} style={tokens} data-request-drag={requestDrag ? true : undefined}>
      <WorkspaceBackground ref={pixelRef} />
      <style ref={hoverStyle} />
      <style ref={commitStyle} />
      <div className="lk-titlebar" data-tauri-drag-region>
        <span data-tauri-drag-region>{project?.name ?? "GitKit"}</span>
        {props.windowControls}
      </div>

      <main className="lk-stage" aria-busy={status === "loading" || props.refreshing} ref={stageRef}>
        {status === "none" ? <StageMessage title={tx("还没有打开仓库")} action={{ label: tx("打开仓库…"), onClick: props.onOpenProject }} />
          : status === "loading" ? <StageMessage title={tx("正在读取分支…")} />
          : status === "error" ? <StageMessage title={tx("读取仓库失败")} detail={props.error}
            action={props.onInitialize ? { label: tx("初始化 Git 仓库"), onClick: props.onInitialize } : props.onRetry ? { label: tx("重试"), onClick: props.onRetry } : undefined} />
          : model && <>
          <div className="lk-lanes" ref={lanesRef} data-dragging={drag ? true : undefined}>
            {slots.map((slot) => {
              const view = viewCache.current.get(slot.branch);
              if (!view) return null;
              const index = shown.indexOf(slot);
              const shift = shiftFor(index);
              const dragged = drag?.key === slot.key;
              const isCurrent = view.id === current;
              return <div key={slot.key} className="lk-slot" data-slot-key={slot.key} data-enter={slot.enter || undefined}
                data-exit={slot.exit || undefined} data-dragging={dragged || undefined}
                style={dragged ? undefined : { transform: shift ? `translateX(${shift}px)` : undefined }}>
                <Lane model={model} view={view} slot={slot} index={index}
                  focused={focus?.slotKey === slot.key && focus.branch === view.id}
                  current={current} working={isCurrent ? working : EMPTY_WORKING} changes={isCurrent ? changes : 0}
                  request={props.requests?.[view.id]}
                  createRequestLabel={props.onCreateRequest && !view.isTrunk ? props.createRequestLabel : undefined}
                  requestDrag={props.onDropRequest ? view.branch.upstream ? "ready" : "unpushed" : undefined}
                  handlers={handlers} />
              </div>;
            })}
            {Array.from({ length: Math.max(0, count - shown.length) }, (_, i) =>
              <div key={`empty-${i}`} className="lk-slot">
                <EmptyLane first={i === 0} onCreate={() => setCreate({ base: current ?? model.trunk })} trunk={model.trunk} />
              </div>)}
          </div>
          {settings.showLinks && <LinkOverlay links={links} hostRef={stageRef} version={linkVersion} />}
        </>}
      </main>

      {requestDrag && <RequestGhost ref={ghostRef} source={requestDrag.source} target={requestDrag.target}
        existing={requestDrag.target !== null && props.requests?.[requestDrag.source]?.target === requestDrag.target} />}

      <LaneContextMenu menu={menu} onClose={closeMenu} />

      {/* The host's detail panel slides over the lanes, above the dock. */}
      <div className="lk-drawer-host">{props.drawer}</div>

      <Dock {...props} model={model} current={currentBranch} laneIndex={laneIndex} onPick={showAnywhere}
        create={create} defaultBase={defaultBase} busyCreate={busy}
        onOpenCreate={() => setCreate({ base: defaultBase, slotKey: focus?.slotKey })}
        onCloseCreate={() => setCreate(null)} onSubmitCreate={submitCreate}
        existing={branches.filter(b => !b.isRemote).map(b => b.name)} demo={demo} />
    </div>
  );
}

const EMPTY_WORKING: LanesWorkspaceProps["working"] = [];

/** The pill that follows the pointer while a branch is dragged onto another lane. */
const RequestGhost = forwardRef<HTMLDivElement, { source: string; target: string | null; existing: boolean }>(
  function RequestGhost({ source, target, existing }, ref) {
    return <div className="lk-drag-ghost" ref={ref} aria-hidden="true" data-over={target ? true : undefined}>
      <span className="lk-drag-ghost-branch" style={{ "--lk-branch": branchColor(source) } as CSSProperties}>
        <span className="lk-dot" />{source}
      </span>
      <ArrowRight size={13} />
      {target
        ? <span className="lk-drag-ghost-branch" style={{ "--lk-branch": branchColor(target) } as CSSProperties}>
          <span className="lk-dot" />{target}{existing && <em>{tx("已有请求")}</em>}
        </span>
        : <span className="lk-drag-ghost-hint">{tx("拖到要合入的分支上")}</span>}
    </div>;
  });
