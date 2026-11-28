import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LaneMenuItem } from "./types";
import { useDismiss } from "./useDismiss";
import { useLastValue, usePresence } from "./usePresence";

// The lanes' right-click menu: opens at the pointer, flips to stay on screen,
// and plays the same open/close transition as the dock's menus.

const MARGIN = 8;

export function LaneContextMenu({ menu, onClose }: {
  /** `avoid`: a vertical band (the row it's about) the menu opens below — or above — instead of covering. */
  menu: { x: number; y: number; items: LaneMenuItem[]; avoid?: { top: number; bottom: number } } | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const presence = usePresence(!!menu, ref);
  const shown = useLastValue(menu);
  useDismiss(!!menu, ref, onClose);
  const [place, setPlace] = useState<{ left: number; top: number; origin: string }>({ left: 0, top: 0, origin: "top left" });

  // Measure after mount and keep the whole menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const right = menu.x + width + MARGIN > window.innerWidth;
    const downFrom = menu.avoid ? menu.avoid.bottom + 4 : menu.y;
    const upFrom = menu.avoid ? menu.avoid.top - 4 : menu.y;
    const up = downFrom + height + MARGIN > window.innerHeight && upFrom - height >= MARGIN;
    setPlace({
      left: Math.max(MARGIN, right ? menu.x - width : menu.x),
      top: Math.max(MARGIN, up ? upFrom - height : Math.min(downFrom, window.innerHeight - height - MARGIN)),
      origin: `${up ? "bottom" : "top"} ${right ? "right" : "left"}`,
    });
  }, [menu]);

  if (!presence.mounted || !shown) return null;
  return <div ref={ref} className="lk-popover lk-context" role="menu" {...presence.attrs}
    style={{ left: place.left, top: place.top, transformOrigin: place.origin } as CSSProperties}
    onContextMenu={(e) => e.preventDefault()}>
    <div className="lk-menu">
      {shown.items.map((item, i) => item === "sep"
        ? <div key={`sep-${i}`} className="lk-menu-sep" />
        : <button key={`${i}:${item.label}`} type="button" role="menuitem" className="lk-menu-row"
          data-danger={item.danger || undefined} disabled={item.disabled}
          onClick={() => { onClose(); item.onClick(); }}>
          {item.icon}<span>{item.label}</span>
        </button>)}
    </div>
  </div>;
}
