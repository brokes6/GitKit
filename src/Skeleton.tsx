import type { CSSProperties } from "react";
import "./styles/skeleton.css";

interface SkeletonProps {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  color?: string;
  circle?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({ width, height, color, circle, className = "", style }: SkeletonProps) {
  return <span aria-hidden="true" className={`gk-skeleton ${className}`}
    style={{ width, height, background: color, borderRadius: circle ? "50%" : undefined, ...style }} />;
}

const CODE_WIDTHS = [72, 54, 81, 64, 76, 58, 69, 47];

export function CodeSkeleton({ label, color, rowCount = 8 }: { label: string; color?: string; rowCount?: number }) {
  return <div className="gk-code-skeleton" role="status" aria-label={label} aria-busy="true">
    {Array.from({ length: rowCount }, (_, index) => <div className="gk-code-skeleton-row" key={index} aria-hidden="true">
      <Skeleton width={20} height={10} color={color} />
      <Skeleton width={`${CODE_WIDTHS[index % CODE_WIDTHS.length]}%`} height={10} color={color} style={{ maxWidth: 520 }} />
    </div>)}
  </div>;
}
