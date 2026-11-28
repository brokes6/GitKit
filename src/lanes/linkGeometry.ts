export interface LinkPoint {
  x: number;
  y: number;
}

export interface LinkRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LinkAnchor extends LinkPoint {
  clipped: "up" | "down" | null;
}

export function centerX(rect: LinkRect): number {
  return (rect.left + rect.right) / 2;
}

export function rowAnchor(x: number, row: LinkRect, viewport?: LinkRect): LinkAnchor {
  const y = (row.top + row.bottom) / 2;
  if (!viewport) return { x, y, clipped: null };

  const above = row.top < viewport.top;
  const below = row.bottom > viewport.bottom;
  // When both ends are clipped, use the edge nearest the row's centre.
  if (above && (!below || y <= (viewport.top + viewport.bottom) / 2)) {
    return { x, y: viewport.top, clipped: "up" };
  }
  if (below) return { x, y: viewport.bottom, clipped: "down" };
  return { x, y, clipped: null };
}

export function facingEdges(from: LinkRect, to: LinkRect): [number, number] {
  return centerX(from) <= centerX(to) ? [from.right, to.left] : [from.left, to.right];
}

export function dockPoint(source: LinkRect, dock: LinkRect): LinkPoint {
  return { x: Math.max(dock.left, Math.min(centerX(source), dock.right)), y: dock.top };
}

export function linkPath(from: LinkPoint, to: LinkPoint, dock = false): string {
  if (dock) {
    const dy = (to.y - from.y) * 0.55;
    return `M ${from.x} ${from.y} C ${from.x} ${from.y + dy} ${to.x} ${to.y - dy} ${to.x} ${to.y}`;
  }
  const dx = (to.x - from.x) * 0.55;
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`;
}
