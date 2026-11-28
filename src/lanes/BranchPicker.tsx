import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { branchColor } from "../git";
import { tf, tx } from "../i18n";
import { treeRows } from "./stackModel";
import type { StackModel } from "./stackModel";
import { useDismiss } from "./useDismiss";
import { usePresence } from "./usePresence";

// A custom listbox for choosing a base branch. Options keep the stack tree's
// indentation so the choice shows where the new branch will sit; typing filters.

interface Option { name: string; depth: number; trunk: boolean }

const SEARCH_FROM = 8;
const LIST_MAX = 300;
const LIST_WIDTH = 290;

export function BranchPicker({ model, value, onChange, showValue }: {
  model: StackModel; value: string; onChange: (name: string) => void;
  /** Show the selected branch on the trigger (it isn't one of the quick chips). */
  showValue: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [upward, setUpward] = useState(false);
  const [alignEnd, setAlignEnd] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(open, popRef);
  const listId = useId();

  const options = useMemo<Option[]>(() => [
    { name: model.trunk, depth: 0, trunk: true },
    ...treeRows(model).map((r) => ({ name: r.name, depth: r.depth, trunk: false })),
  ], [model]);
  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  const searchable = options.length >= SEARCH_FROM;

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);
  // Outside press: just close. No refocus, so the pressed element keeps the click.
  const dismiss = useCallback(() => close(false), [close]);
  useDismiss(open, rootRef, dismiss);

  const openList = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setUpward(!!rect && window.innerHeight - rect.bottom < LIST_MAX + 24 && rect.top > window.innerHeight - rect.bottom);
    setAlignEnd(!!rect && rect.left + LIST_WIDTH > window.innerWidth - 12);
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.name === value)));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, searchable]);
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, q]);

  const choose = (name: string) => { onChange(name); close(false); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openList(); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(visible.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(visible.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (visible[active]) choose(visible[active].name); }
    else if (e.key === "Tab") close();
  };

  const activeId = visible[active] ? `${listId}-${active}` : undefined;
  return <div className="lk-picker" ref={rootRef} onKeyDown={onKeyDown}>
    <button ref={triggerRef} type="button" className="lk-base-option lk-picker-trigger" title={showValue ? value : undefined}
      data-active={showValue || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      style={showValue ? { "--lk-branch": branchColor(value) } as CSSProperties : undefined}
      onClick={() => open ? close() : openList()}>
      {showValue && <span className="lk-dot" aria-hidden="true" />}
      <span className="lk-picker-label">{showValue ? value : tx("其他分支")}</span>
      <ChevronDown size={13} aria-hidden="true" className="lk-picker-chevron" />
    </button>

    {presence.mounted && <div className="lk-listbox" ref={popRef} {...presence.attrs}
      data-up={upward || undefined} data-end={alignEnd || undefined}>
      {searchable && <label className="lk-listbox-search">
        <Search size={13} aria-hidden="true" />
        <input ref={searchRef} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          placeholder={tf("搜索 {0} 条分支", options.length)} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" />
      </label>}
      <div ref={listRef} id={listId} className="lk-listbox-scroll" role="listbox" aria-label={tx("选择基础分支")}
        tabIndex={searchable ? -1 : 0} aria-activedescendant={searchable ? undefined : activeId}>
        {visible.map((o, i) => {
          const selected = o.name === value;
          return <div key={o.name} id={`${listId}-${i}`} data-index={i} role="option" aria-selected={selected}
            className="lk-listbox-row" data-active={i === active || undefined} data-trunk={o.trunk || undefined}
            style={{ "--lk-depth": q ? 0 : o.depth, "--lk-branch": branchColor(o.name) } as CSSProperties}
            onPointerMove={() => setActive(i)} onPointerDown={(e) => e.preventDefault()} onClick={() => choose(o.name)}>
            {o.trunk ? <GitBranch size={13} aria-hidden="true" className="lk-listbox-trunk-icon" />
              : <>{!q && <span className="lk-tree-indent" aria-hidden="true" />}<span className="lk-dot" aria-hidden="true" /></>}
            <span className="lk-listbox-name">{highlight(o.name, q)}</span>
            {o.trunk && <em>{tx("主干")}</em>}
            {selected && <Check size={13} aria-hidden="true" className="lk-listbox-check" />}
          </div>;
        })}
        {!visible.length && <div className="lk-tree-none">{tx("没有匹配的分支")}</div>}
      </div>
    </div>}
  </div>;
}

function highlight(name: string, q: string) {
  if (!q) return name;
  const at = name.toLowerCase().indexOf(q);
  if (at < 0) return name;
  return <>{name.slice(0, at)}<mark>{name.slice(at, at + q.length)}</mark>{name.slice(at + q.length)}</>;
}
