import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { Check, Crosshair, GitBranch, GitMerge, Layers, Maximize2, Minus, Plus } from "lucide-react";
import { tf, tx } from "./i18n";
import type { Commit, GraphRowInfo, ThemeColors } from "./App";
import { buildCommitTopology } from "./commitTopologyLayout";
import type { CommitTopologyNode as TopologyNode } from "./commitTopologyLayout";
import "./styles/commitTopology.css";

interface Props {
  commits: Commit[];
  graph: GraphRowInfo[];
  theme: ThemeColors;
  selectedHash: string | null;
  hoverBranch: string | null;
  onSelect: (commit: Commit) => void;
  onContextMenu: (event: MouseEvent, commit: Commit) => void;
}

const MAX_ZOOM = 1.6;
const MIN_ZOOM = 0.01;

const TopologyCommit = memo(function TopologyCommit({ node, selected, highlight, compact, zoom, onSelect, onContextMenu }: {
  node: TopologyNode; selected: boolean; highlight: boolean; compact: boolean; zoom: number;
  onSelect: Props["onSelect"]; onContextMenu: Props["onContextMenu"];
}) {
  const { commit, x, y, color } = node;
  const isHead = commit.tags?.includes("HEAD") === true;
  const refs = (commit.tags ?? []).filter(ref => !ref.endsWith("/HEAD"));
  const merge = !commit.isStash && commit.parents.length > 1;
  return <button type="button" className="gk-topology-node" data-selected={selected} data-head={isHead}
    data-highlight={highlight} data-merge={merge} data-stash={!!commit.isStash} data-compact={compact}
    data-commit-hash={commit.fullHash} aria-pressed={selected}
    aria-label={tf("查看提交 {0}：{1}", commit.hash, commit.message)}
    title={`${commit.message}\n${commit.author.name} · ${commit.hash}\n${refs.join(" · ")}`}
    style={{ left: (x - 72) * zoom, top: (y - 14) * zoom,
      transform: `scale(${zoom})`, transformOrigin: "top left", "--gk-node-color": color } as CSSProperties}
    onClick={() => onSelect(commit)} onContextMenu={event => onContextMenu(event, commit)}>
    {!compact && refs.length > 0 && <span className="gk-topology-refs">
      {refs.slice(0, 3).map(ref => <span className="gk-topology-ref" data-head={ref === "HEAD"} key={ref}>
        {ref !== "HEAD" && <GitBranch size={10} aria-hidden="true" />}<span>{ref}</span>
      </span>)}
      {refs.length > 3 && <span className="gk-topology-more">+{refs.length - 3}</span>}
    </span>}
    <span className="gk-topology-dot">{merge && <span />}</span>
    {!compact && <span className="gk-topology-label">
      {selected && <Check className="gk-topology-selected-mark" size={12} strokeWidth={2.5} aria-hidden="true" />}
      <span className="gk-topology-hash">{commit.hash}</span>
      <span className="gk-topology-subject">{commit.message}</span>
    </span>}
  </button>;
});

export function CommitTopology({ commits, graph, theme, selectedHash, hoverBranch, onSelect, onContextMenu }: Props) {
  const layout = useMemo(() => buildCommitTopology(commits, graph), [commits, graph]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const previousSelectionRef = useRef(selectedHash);
  const scrollRef = useRef({ left: 0, top: 0 });
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const zoomRef = useRef(1);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const initializedRef = useRef(false);
  const dragRef = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const head = layout.nodes.find(node => node.commit.tags?.includes("HEAD"));
  const selectedNode = layout.nodes.find(node => node.commit.fullHash === selectedHash);
  const initialNode = head ?? layout.nodes[0];
  const mergeCount = commits.filter(commit => !commit.isStash && commit.parents.length > 1).length;
  const minimumZoom = viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(MIN_ZOOM, viewportSize.width / layout.width, viewportSize.height / layout.height)
    : MIN_ZOOM;
  const zoomLabel = zoom < MIN_ZOOM ? `${(zoom * 100).toPrecision(2)}%` : `${Math.round(zoom * 100)}%`;
  const stageLeft = Math.max(0, (viewportSize.width - layout.width * zoom) / 2);
  const stageTop = Math.max(0, (viewportSize.height - layout.height * zoom) / 2);
  const offsetAt = (scale: number) => ({
    x: Math.max(0, ((viewportRef.current?.clientWidth ?? 0) - layout.width * scale) / 2),
    y: Math.max(0, ((viewportRef.current?.clientHeight ?? 0) - layout.height * scale) / 2),
  });
  // Keep the SVG itself viewport-sized. A single transformed, history-wide SVG
  // can exceed WebKit's paint bounds and disappear when a long graph is fitted.
  const syncSvgViewport = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    scrollRef.current = { left: viewport.scrollLeft, top: viewport.scrollTop };
    svgRef.current?.setAttribute("viewBox", `${viewport.scrollLeft} ${viewport.scrollTop} ${viewport.clientWidth} ${viewport.clientHeight}`);
  };

  const locate = (node: TopologyNode | undefined) => {
    const viewport = viewportRef.current;
    if (!viewport || !node) return;
    const offset = offsetAt(zoomRef.current);
    viewport.scrollLeft = offset.x + node.x * zoomRef.current - viewport.clientWidth / 2;
    viewport.scrollTop = offset.y + node.y * zoomRef.current - viewport.clientHeight / 2;
  };

  const changeZoom = (next: number, center?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
    const offset = offsetAt(zoomRef.current);
    anchorRef.current = center ?? {
      x: (viewport.scrollLeft + viewport.clientWidth / 2 - offset.x) / zoomRef.current,
      y: (viewport.scrollTop + viewport.clientHeight / 2 - offset.y) / zoomRef.current,
    };
    const lowerBound = Math.min(MIN_ZOOM, viewport.clientWidth / layout.width, viewport.clientHeight / layout.height);
    const value = Math.min(MAX_ZOOM, Math.max(lowerBound, next));
    zoomRef.current = value;
    setZoom(value);
    // A fit/locate action may keep the same scale and still need to move.
    if (value === zoom) {
      const nextOffset = offsetAt(value);
      viewport.scrollLeft = nextOffset.x + anchorRef.current.x * value - viewport.clientWidth / 2;
      viewport.scrollTop = nextOffset.y + anchorRef.current.y * value - viewport.clientHeight / 2;
      anchorRef.current = null;
    }
  };

  const fit = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    changeZoom(Math.min(1, viewport.clientWidth / layout.width, viewport.clientHeight / layout.height),
      { x: layout.width / 2, y: layout.height / 2 });
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const width = viewport.clientWidth, height = viewport.clientHeight;
      setViewportSize(current => current.width === width && current.height === height
        ? current : { width, height });
    };
    // Scope changes remount the canvas. Measure before its first paint so nodes
    // are centered and SVG edges are visible without waiting for the observer.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [layout.nodes.length === 0]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
    const anchor = anchorRef.current;
    if (anchor) {
      const offset = offsetAt(zoom);
      viewport.scrollLeft = offset.x + anchor.x * zoom - viewport.clientWidth / 2;
      viewport.scrollTop = offset.y + anchor.y * zoom - viewport.clientHeight / 2;
      anchorRef.current = null;
    } else if (!initializedRef.current && initialNode) {
      initializedRef.current = true;
      locate(initialNode);
    }
    syncSvgViewport();
  }, [zoom, layout, initialNode, viewportSize]);

  useLayoutEffect(() => {
    // Restoring a selection on mount is static. Only a new selected hash plays;
    // zoom, hover, resize and scrolling never restart the relationship feedback.
    if (previousSelectionRef.current === selectedHash) return;
    previousSelectionRef.current = selectedHash;
    if (!selectedHash || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const svg = svgRef.current;
    if (!svg) return;
    const animations: Animation[] = [];
    svg.querySelectorAll<SVGPathElement>(".gk-topology-edge-flow").forEach(path => {
      const forward = path.dataset.direction === "forward";
      animations.push(path.animate([
        { strokeDashoffset: forward ? "18" : "-100", opacity: 0 },
        { strokeDashoffset: "-41", opacity: 0.9, offset: 0.5 },
        { strokeDashoffset: forward ? "-100" : "18", opacity: 0 },
      ], { duration: 560, delay: 40, easing: "cubic-bezier(0.22, 0.68, 0.24, 1)" }));
    });
    const ring = svg.querySelector(".gk-topology-node-pulse");
    if (ring) animations.push(ring.animate([{ opacity: 0 }, { opacity: 0.7 }, { opacity: 0 }],
      { duration: 400, easing: "ease-out" }));
    return () => animations.forEach(animation => animation.cancel());
  }, [selectedHash]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const viewport = event.currentTarget;
    suppressClickRef.current = false;
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    if ((event.buttons & 1) === 0) { endDrag(event); return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      suppressClickRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.dragging = "true";
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = drag.left - dx;
    event.currentTarget.scrollTop = drag.top - dy;
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return <div className="gk-topology" style={{
    "--gk-topology-text": theme.text, "--gk-topology-secondary": theme.textSec,
    "--gk-topology-muted": theme.textMuted, "--gk-topology-surface": theme.bgPanel,
    "--gk-topology-border": theme.border, "--gk-topology-hover": theme.rowHover,
    "--gk-topology-accent": theme.accent, "--gk-topology-accent-bg": theme.accentBg,
    "--gk-topology-accent-fg": theme.accentFg, "--gk-topology-input": theme.inputBg,
  } as CSSProperties}>
    <div className="gk-topology-toolbar">
      <span className="gk-topology-summary"><GitMerge size={13} aria-hidden="true" />{tf("{0} 个合并提交", mergeCount)}</span>
      <span className="gk-topology-toolbar-spacer" />
      <button type="button" onClick={() => { changeZoom(1, head ? { x: head.x, y: head.y } : undefined); }}
        disabled={!head} title={head ? tx("定位 HEAD") : tx("HEAD 不在当前范围")}><Crosshair size={13} aria-hidden="true" /><span>HEAD</span></button>
      <button type="button" onClick={fit} title={tx("适应视图")} aria-label={tx("适应视图")}><Maximize2 size={13} aria-hidden="true" /></button>
      <span className="gk-topology-toolbar-divider" />
      <button type="button" onClick={() => changeZoom(zoomRef.current / 1.25)} disabled={zoom <= minimumZoom}
        title={tx("缩小拓扑图")} aria-label={tx("缩小拓扑图")}><Minus size={13} aria-hidden="true" /></button>
      <output className="gk-topology-zoom" aria-label={tx("缩放比例")}>{zoomLabel}</output>
      <button type="button" onClick={() => changeZoom(zoomRef.current * 1.25)} disabled={zoom >= MAX_ZOOM}
        title={tx("放大拓扑图")} aria-label={tx("放大拓扑图")}><Plus size={13} aria-hidden="true" /></button>
    </div>
    {layout.nodes.length === 0 ? <div className="gk-topology-empty"><GitBranch size={24} aria-hidden="true" />
      <span>{tx("当前范围没有提交")}</span></div> : <div ref={viewportRef} className="gk-topology-viewport" tabIndex={0}
      role="region" aria-label={tx("提交拓扑图，拖动或使用方向键移动，点击节点查看详情")}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag}
      onScroll={syncSvgViewport}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onClickCapture={event => {
        if (suppressClickRef.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const distances: Record<string, [number, number]> = { ArrowLeft: [-100, 0], ArrowRight: [100, 0], ArrowUp: [0, -100], ArrowDown: [0, 100] };
        const distance = distances[event.key];
        if (distance) { event.preventDefault(); event.currentTarget.scrollBy(...distance); }
        if (event.key === "Home") { event.preventDefault(); locate(initialNode); }
        if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(zoomRef.current * 1.25); }
        if (event.key === "-") { event.preventDefault(); changeZoom(zoomRef.current / 1.25); }
      }}>
      <div className="gk-topology-scroll-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <svg ref={svgRef} className="gk-topology-lines" width={viewportSize.width} height={viewportSize.height}
            viewBox={`${scrollRef.current.left} ${scrollRef.current.top} ${viewportSize.width || 1} ${viewportSize.height || 1}`}
            aria-hidden="true">
            {Array.from({ length: layout.laneCount }, (_, lane) => <line key={lane}
              x1={stageLeft + 32 * zoom} x2={stageLeft + (layout.width - 32) * zoom}
              y1={stageTop + (104 + lane * layout.laneSpacing) * zoom} y2={stageTop + (104 + lane * layout.laneSpacing) * zoom}
              stroke={theme.border} strokeWidth={1} />)}
            {layout.edges.map(edge => {
              const px = stageLeft + edge.parent.x * zoom, py = stageTop + edge.parent.y * zoom;
              const cx = stageLeft + edge.child.x * zoom, cy = stageTop + edge.child.y * zoom;
              const bend = Math.min(84 * zoom, (cx - px) / 2);
              const d = `M ${px} ${py} C ${px + bend} ${py}, ${cx - bend} ${cy}, ${cx} ${cy}`;
              const related = selectedHash === edge.parent.commit.fullHash || selectedHash === edge.child.commit.fullHash;
              return <g key={`${edge.child.commit.fullHash}:${edge.parent.commit.fullHash}`}>
                <path d={d} stroke={edge.color} strokeWidth={2} fill="none" strokeLinecap="round"
                  strokeDasharray={edge.child.commit.isStash ? "5 5" : undefined} />
                {related && <path className="gk-topology-edge-flow" d={d} pathLength={100}
                  data-direction={selectedHash === edge.parent.commit.fullHash ? "forward" : "reverse"}
                  style={{ "--gk-edge-color": edge.color } as CSSProperties}
                  stroke={edge.color} strokeWidth={4} fill="none" strokeLinecap="round"
                  strokeDasharray={edge.child.commit.isStash ? "3 3 3 3 3 109" : "18 100"} />}
              </g>;
            })}
            {zoom < 0.55 && layout.nodes.map(node => <circle key={node.commit.fullHash}
              cx={stageLeft + node.x * zoom} cy={stageTop + node.y * zoom}
              r={Math.max(2.8, 8 * zoom)} fill={node.commit.tags?.includes("HEAD") ? node.color : theme.bgPanel}
              stroke={node.color} strokeWidth={1.5} />)}
            {zoom < 0.55 && selectedNode && <g>
              <circle cx={stageLeft + selectedNode.x * zoom} cy={stageTop + selectedNode.y * zoom}
                r={Math.max(2.8, 8 * zoom) + 4} fill={theme.bgPanel} stroke={theme.accentFg} strokeWidth={2} />
              <circle cx={stageLeft + selectedNode.x * zoom} cy={stageTop + selectedNode.y * zoom}
                r={Math.max(2.8, 8 * zoom)} fill={selectedNode.commit.tags?.includes("HEAD") ? selectedNode.color : theme.bgPanel}
                stroke={selectedNode.color} strokeWidth={1.5} />
            </g>}
            {selectedNode && (selectedNode.commit.isStash && zoom >= 0.55 ? <rect
              className="gk-topology-node-pulse" x={stageLeft + (selectedNode.x - 15) * zoom}
              y={stageTop + (selectedNode.y - 15) * zoom} width={30 * zoom} height={30 * zoom}
              rx={6 * zoom} fill="none" stroke={selectedNode.color} strokeWidth={2.5}
            /> : <circle className="gk-topology-node-pulse"
              cx={stageLeft + selectedNode.x * zoom} cy={stageTop + selectedNode.y * zoom}
              r={zoom < 0.55 ? Math.max(2.8, 8 * zoom) + 6 : 15 * zoom}
              fill="none" stroke={selectedNode.color} strokeWidth={2.5} />)}
          </svg>
        <div className="gk-topology-stage" style={{ left: stageLeft, top: stageTop,
          width: layout.width * zoom, height: layout.height * zoom }}>
          {layout.nodes.map(node => <TopologyCommit key={node.commit.fullHash} node={node}
            selected={selectedHash === node.commit.fullHash}
            highlight={!!hoverBranch && (node.commit.branchLabels ?? [node.commit.branchLabel]).includes(hoverBranch)}
            compact={zoom < 0.55} zoom={zoom} onSelect={onSelect} onContextMenu={onContextMenu} />)}
        </div>
      </div>
    </div>}
    <div className="gk-topology-footer">
      <span>{tx("拖动平移 · 点击节点查看详情")}</span>
      <span className="gk-topology-boundary">{layout.omittedParentCount > 0 ? tx("仅连接当前范围内的提交") : tx("较早 → 较新")}</span>
      {commits.some(commit => commit.isStash) && <span className="gk-topology-stash-key"><Layers size={11} aria-hidden="true" />{tx("虚线为储藏")}</span>}
    </div>
  </div>;
}
