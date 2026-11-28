import { memo, useId, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { LaneLink, LaneLinkEnd } from "./laneLayout";
import { centerX, dockPoint, linkPath, rowAnchor, type LinkAnchor, type LinkRect } from "./linkGeometry";
import "./links.css";

const SVG_NS = "http://www.w3.org/2000/svg";
const lanesFor = (link: LaneLink) => [link.from, link.to].map((end) => "lane" in end ? end.lane : "dock").join(" ");
// A merge commit can appear in multiple lanes with the same link id.
const keyFor = (link: LaneLink) => JSON.stringify([link.id, lanesFor(link)]);

function drawEnd(marker: Element, anchor: LinkAnchor) {
  marker.setAttribute("transform", `translate(${anchor.x} ${anchor.y})`);
  marker.setAttribute("data-clipped", anchor.clipped ?? "");
}

export const LinkOverlay = memo(function LinkOverlay({ links, hostRef, version }: {
  links: LaneLink[];
  hostRef: RefObject<HTMLElement>;
  version: unknown;
}): JSX.Element {
  const maskId = `lk-links-${useId().replace(/:/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const maskRef = useRef<SVGMaskElement>(null);
  const whiteRef = useRef<SVGRectElement>(null);
  const cardsRef = useRef<SVGGElement>(null);
  const groupsRef = useRef(new Map<string, SVGGElement>());
  const endsRef = useRef(new Map<string, SVGGElement>());
  const linksRef = useRef(links);
  const scheduleRef = useRef<() => void>();

  // Lines live under the fade mask; their end markers sit in an unmasked layer
  // so both ends stay crisp on top of the commit dots they connect.
  const [groups, ends] = useMemo(() => {
    const register = (map: Map<string, SVGGElement>, key: string) => (node: SVGGElement | null) => {
      if (node) map.set(key, node); else map.delete(key);
    };
    return [
      links.map((link) => {
        const key = keyFor(link);
        return <g key={key} ref={register(groupsRef.current, key)} className="lk-link" data-kind={link.kind}
          data-lanes={lanesFor(link)} visibility="hidden">
          <path className="lk-link-line" />
        </g>;
      }),
      links.map((link) => {
        const key = keyFor(link);
        return <g key={key} ref={register(endsRef.current, key)} className="lk-link lk-link-ends" data-kind={link.kind}
          data-lanes={lanesFor(link)} visibility="hidden">
          {[0, 1].map((end) => (
            <g key={end} className="lk-link-end">
              <circle r="3" />
              <path className="lk-link-chevron" d="M -3 2 L 0 -2 L 3 2" />
            </g>
          ))}
        </g>;
      }),
    ];
  }, [links]);

  useLayoutEffect(() => {
    // When the host and the overlay mount in the same commit, the host's ref is
    // attached after this effect runs; the overlay's own parent is the host then.
    const host = hostRef.current ?? svgRef.current?.parentElement ?? null;
    const mask = maskRef.current;
    const white = whiteRef.current;
    const cardMask = cardsRef.current;
    if (!host || !mask || !white || !cardMask) return;

    let frame: number | null = null;
    let quietUntil = 0;
    const motions = new Map<Element, Map<string, number>>();
    const observed = new Set<Element>();

    function schedule() {
      if (frame === null) frame = requestAnimationFrame(measure);
    }

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(host);

    function measure(now: number) {
      frame = null;
      const origin = host!.getBoundingClientRect();
      const rectFor = (element: Element, viewport = false): LinkRect => {
        const rect = element.getBoundingClientRect();
        // Scroll metrics are in layout pixels; dragging can also scale the lane.
        const scaleY = viewport && element instanceof HTMLElement && element.offsetHeight
          ? rect.height / element.offsetHeight
          : 1;
        const top = rect.top - origin.top + (viewport ? element.clientTop * scaleY : 0);
        return {
          left: rect.left - origin.left, right: rect.right - origin.left, top,
          bottom: viewport ? top + element.clientHeight * scaleY : rect.bottom - origin.top,
        };
      };

      const scrolls = new Map<string, { element: Element; rect?: LinkRect }>();
      const nextObserved = new Set<Element>();
      for (const element of host!.querySelectorAll("[data-lane-scroll]")) {
        scrolls.set(element.getAttribute("data-lane-scroll")!, { element });
        nextObserved.add(element);
        if (!observed.has(element)) resizeObserver.observe(element);
      }
      for (const element of observed) {
        if (!nextObserved.has(element)) resizeObserver.unobserve(element);
      }
      observed.clear();
      for (const element of nextObserved) observed.add(element);

      const cards = Array.from(host!.querySelectorAll("[data-lane-card]"), (element) => {
        const style = getComputedStyle(element);
        return {
          lane: element.getAttribute("data-lane-card")!,
          rect: rectFor(element),
          radius: style.borderTopLeftRadius,
          color: style.getPropertyValue("--lk-branch").trim() || "var(--lk-muted)",
        };
      });
      const cardFor = new Map(cards.map((card) => [card.lane, card]));
      const activeLinks = linksRef.current;
      const needsDock = activeLinks.some((link) => "dock" in link.to);
      const dockElement = needsDock ? document.querySelector(".lk-dock") : null;
      const dock = dockElement ? rectFor(dockElement) : null;
      const rows = new Map<string, { rect: LinkRect; viewport?: LinkRect; dotX: number } | null>();

      function findRow(end: Exclude<LaneLinkEnd, { dock: true }>) {
        const key = JSON.stringify(end);
        if (!rows.has(key)) {
          const scroll = scrolls.get(end.lane);
          const row = "hash" in end
            ? scroll?.element.querySelector(`[data-commit-hash="${CSS.escape(end.hash)}"]`)
            : "step" in end
              ? host!.querySelector(`[data-lane-card="${CSS.escape(end.lane)}"] [data-flow-step="${CSS.escape(end.step)}"]`)
              : host!.querySelector(`[data-fork-anchor="${CSS.escape(end.lane)}"]`);
          let viewport: LinkRect | undefined;
          if (row && scroll?.element.contains(row)) {
            scroll.rect ??= rectFor(scroll.element, true);
            viewport = scroll.rect;
          }
          // Anchor on the row's dot: the commit rail, or the fork marker's icon.
          const dot = row?.querySelector("[data-link-dot], .lk-rail i, .lk-rail, svg");
          const dotRect = dot ? rectFor(dot) : null;
          rows.set(key, row ? { rect: rectFor(row), viewport, dotX: dotRect ? centerX(dotRect) : rectFor(row).left + 18 } : null);
        }
        return rows.get(key);
      }

      // Complete layout reads before writing SVG attributes.
      const geometry = activeLinks.map((link) => {
        const group = groupsRef.current.get(keyFor(link));
        const endGroup = endsRef.current.get(keyFor(link));
        if (!group || !endGroup || !("lane" in link.from)) return null;
        const source = cardFor.get(link.from.lane);
        const row = findRow(link.from);
        if (!source || !row) return { group, endGroup };
        if ("dock" in link.to) {
          if (!dock) return { group, endGroup };
          const from = rowAnchor(row.dotX, row.rect, row.viewport);
          const to = { ...dockPoint(source.rect, dock), clipped: null };
          return { group, endGroup, from, to, path: linkPath(from, to, true), color: source.color };
        }
        const target = cardFor.get(link.to.lane);
        const targetRow = findRow(link.to);
        if (!target || !targetRow) return { group, endGroup };
        const from = rowAnchor(row.dotX, row.rect, row.viewport);
        const to = rowAnchor(targetRow.dotX, targetRow.rect, targetRow.viewport);
        return { group, endGroup, from, to, path: linkPath(from, to), color: source.color };
      });

      // Keep the white region wide enough for the dock and transformed cards.
      const left = Math.min(0, dock?.left ?? 0, ...cards.map(({ rect }) => rect.left)) - 8;
      const top = Math.min(0, ...cards.map(({ rect }) => rect.top)) - 8;
      const right = Math.max(origin.width, dock?.right ?? 0, ...cards.map(({ rect }) => rect.right)) + 8;
      const bottom = Math.max(origin.height, dock?.top ?? 0, ...cards.map(({ rect }) => rect.bottom)) + 8;
      for (const element of [mask!, white!]) {
        element.setAttribute("x", String(left));
        element.setAttribute("y", String(top));
        element.setAttribute("width", String(right - left));
        element.setAttribute("height", String(bottom - top));
      }

      for (let index = 0; index < cards.length; index++) {
        const { rect, radius } = cards[index];
        const shape = cardMask!.children[index] ?? cardMask!.appendChild(document.createElementNS(SVG_NS, "rect"));
        const [rx, ry = rx] = radius.split(" ");
        shape.setAttribute("x", String(rect.left));
        shape.setAttribute("y", String(rect.top));
        shape.setAttribute("width", String(rect.right - rect.left));
        shape.setAttribute("height", String(rect.bottom - rect.top));
        shape.setAttribute("rx", rx);
        shape.setAttribute("ry", ry);
      }
      while (cardMask!.children.length > cards.length) cardMask!.lastElementChild?.remove();

      for (const entry of geometry) {
        if (!entry) continue;
        const { group, endGroup, from, to, path, color } = entry;
        if (!from || !to) {
          group.setAttribute("visibility", "hidden");
          endGroup.setAttribute("visibility", "hidden");
          continue;
        }
        group.style.setProperty("--lk-link-color", color);
        endGroup.style.setProperty("--lk-link-color", color);
        group.children[0].setAttribute("d", path);
        drawEnd(endGroup.children[0], from);
        drawEnd(endGroup.children[1], to);
        group.setAttribute("visibility", "visible");
        endGroup.setAttribute("visibility", "visible");
      }

      for (const element of motions.keys()) {
        if (!host!.contains(element)) motions.delete(element);
      }
      if (motions.size || now < quietUntil || host!.querySelector("[data-dragging]")) schedule();
    }

    function onMotion(event: Event) {
      const target = event.target;
      if (!(target instanceof Element) || mask!.ownerSVGElement?.contains(target)) return;
      const motion = event as TransitionEvent | AnimationEvent;
      const isTransition = "propertyName" in motion;
      const name = isTransition ? motion.propertyName : motion.animationName;
      const key = `${isTransition ? "transition" : "animation"}:${motion.pseudoElement}:${name}`;
      const counts = motions.get(target);
      if (event.type === "transitionrun" || event.type === "animationstart") {
        const active = counts ?? new Map<string, number>();
        active.set(key, (active.get(key) ?? 0) + 1);
        motions.set(target, active);
      } else if (counts) {
        const count = counts.get(key) ?? 0;
        if (count > 1) counts.set(key, count - 1);
        else counts.delete(key);
        if (!counts.size) motions.delete(target);
      }
      quietUntil = performance.now() + 100;
      schedule();
    }

    const motionEvents = [
      "transitionrun", "transitionend", "transitioncancel",
      "animationstart", "animationend", "animationcancel",
    ];
    const dragObserver = new MutationObserver(schedule);
    dragObserver.observe(host, { subtree: true, attributes: true, attributeFilter: ["data-dragging"] });
    for (const event of motionEvents) host.addEventListener(event, onMotion, true);
    host.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    scheduleRef.current = schedule;
    schedule();

    return () => {
      scheduleRef.current = undefined;
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      dragObserver.disconnect();
      for (const event of motionEvents) host.removeEventListener(event, onMotion, true);
      host.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [hostRef]);

  useLayoutEffect(() => {
    linksRef.current = links;
    scheduleRef.current?.();
  }, [links, version]);

  return (
    <svg ref={svgRef} className="lk-link-overlay" aria-hidden="true" focusable="false">
      <defs>
        <mask ref={maskRef} id={maskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">
          <rect ref={whiteRef} fill="white" />
          <g ref={cardsRef} fill="#404040" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>{groups}</g>
      <g>{ends}</g>
    </svg>
  );
});
