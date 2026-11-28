import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { branchColor } from "../git";
import { treeRows } from "./stackModel";
import type { StackModel } from "./stackModel";
import { tf, tx } from "../i18n";

// ─── branch tree ────────────────────────────────────────────────────────────

const BRANCH_PAGE_SIZE = 80;

export function BranchTree({ model, laneIndex, highlight = [], current, onPick, title, trunkInfo }: {
  model: StackModel; laneIndex: (branch: string) => number; highlight?: string[]; current?: string;
  onPick: (b: string) => void; title: string; trunkInfo?: ReactNode;
}) {
  const rows = useMemo(() => treeRows(model), [model]);
  const [limit, setLimit] = useState(BRANCH_PAGE_SIZE);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const filter = query.trim().toLowerCase();
    return filter ? rows.filter(row => row.name.toLowerCase().includes(filter)) : rows;
  }, [query, rows]);
  return <div className="lk-tree" role="group" aria-label={title}>
    <div className="lk-tree-title">{title}</div>
    <div className="lk-tree-row lk-tree-trunk" aria-disabled="true">
      <GitBranch size={13} aria-hidden="true" /><span>{model.trunk}</span>{trunkInfo}
      {current === model.trunk && <span className="lk-tag lk-tag-current">{tx("当前")}</span>}<em>{tx("主干")}</em>
    </div>
    {rows.length > BRANCH_PAGE_SIZE && <input className="lk-input" type="search" value={query}
      aria-label={tx("搜索分支")} placeholder={tf("搜索 {0} 条分支", rows.length)}
      onChange={e => { setQuery(e.target.value); setLimit(BRANCH_PAGE_SIZE); }} />}
    <div className="lk-tree-scroll">
      {visible.slice(0, limit).map(({ name, depth }) => {
        const node = model.nodes.get(name)!;
        const at = laneIndex(name);
        return <button key={name} type="button" className="lk-tree-row"
          data-active={highlight.includes(name) || undefined} data-empty={node.empty || undefined}
          style={{ "--lk-depth": depth, "--lk-branch": branchColor(name) } as CSSProperties} onClick={() => onPick(name)}>
          <span className="lk-tree-indent" aria-hidden="true" />
          <span className="lk-dot" aria-hidden="true" />
          <span className="lk-tree-name">{name}</span>
          {current === name && <span className="lk-tag lk-tag-current">{tx("当前")}</span>}
          <span className="lk-tree-count">{node.commits.length}</span>
          {at >= 0 && <span className="lk-tree-slot" title={tf("显示在第 {0} 个区域", at + 1)}>{at + 1}</span>}
        </button>;
      })}
      {visible.length > limit && <button type="button" className="lk-menu-row"
        onClick={() => setLimit(n => n + BRANCH_PAGE_SIZE)}>{tx("显示更多分支")}</button>}
      {!visible.length && <div className="lk-tree-none">{rows.length ? tx("没有匹配的分支") : tx("还没有其他本地分支")}</div>}
    </div>
  </div>;
}
