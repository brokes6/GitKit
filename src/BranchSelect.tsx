import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AriaAttributes, CSSProperties, KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import type { ThemeColors } from "./App";
import { tx } from "./i18n";

interface BranchSelectProps extends Pick<AriaAttributes, "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid"> {
  theme: ThemeColors;
  value: string;
  options: readonly string[];
  preferredOptions?: readonly string[];
  onChange: (branch: string) => void;
  labelFor?: (branch: string) => string;
  placeholder?: string;
  buttonRef?: RefObject<HTMLButtonElement>;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}

export function BranchSelect({ theme, value, options, preferredOptions, onChange, labelFor, placeholder = "—",
  buttonRef, autoFocus, disabled, invalid, ...aria }: BranchSelectProps) {
  const ownRef = useRef<HTMLButtonElement>(null);
  const trigger = buttonRef ?? ownRef;
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>("");
  const [showOtherOptions, setShowOtherOptions] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const typed = useRef({ prefix: "", time: 0 });
  const unavailable = disabled || options.length === 0;
  const expanded = open && !unavailable;
  const preferred = preferredOptions?.filter(name => options.includes(name)) ?? options;
  const otherOptions = preferredOptions ? options.filter(name => !preferredOptions.includes(name)) : [];
  const collapsedRows: readonly (string | null)[] = otherOptions.length > 0 ? [...preferred, null] : preferred;
  const rows = expanded && showOtherOptions ? [...preferred, ...otherOptions] : collapsedRows;
  const rowCount = rows.length;
  const activeIndex = Math.max(0, rows.indexOf(highlight));
  const label = (name: string) => name ? labelFor?.(name) ?? name : placeholder;
  const rowLabel = (name: string | null) => name === null ? tx("其他分支") : label(name);

  useLayoutEffect(() => {
    if (!expanded) { setPosition(null); return; }
    const button = trigger.current;
    if (!button) return;
    const place = () => {
      const rect = button.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const flip = below < Math.min(268, rowCount * 35 + 10) && above > below;
      setPosition({ left: rect.left, width: rect.width, maxHeight: Math.max(0, Math.min(268, flip ? above : below)),
        ...(flip ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(button);
    const dialog = button.closest('[role="dialog"]');
    if (dialog) observer.observe(dialog);
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && list.current?.contains(event.target))) place();
    };
    window.addEventListener("resize", place);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [expanded, rowCount, trigger]);

  useLayoutEffect(() => {
    const menu = list.current;
    const option = menu?.children[activeIndex];
    if (!expanded || !position || !menu || !option) return;
    const row = option.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    if (row.top < bounds.top) menu.scrollTop += row.top - bounds.top - 4;
    else if (row.bottom > bounds.bottom) menu.scrollTop += row.bottom - bounds.bottom + 4;
  }, [expanded, activeIndex, position]);

  useEffect(() => {
    if (unavailable) setOpen(false);
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      const node = event.target;
      if (node instanceof Node && !trigger.current?.contains(node) && !list.current?.contains(node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [expanded, unavailable, trigger]);

  function show() {
    typed.current = { prefix: "", time: 0 };
    setHighlight(value);
    setShowOtherOptions(false);
    setOpen(true);
  }
  function choose(name: string) {
    setOpen(false);
    if (name !== value) onChange(name);
  }
  function activate(name: string | null) {
    if (name !== null) {
      choose(name);
      return;
    }
    setShowOtherOptions(true);
    setHighlight(otherOptions[0]);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const { key } = event;
    if (key === "Tab") { setOpen(false); return; }
    if (key === "Escape" && expanded) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (expanded) activate(rows[activeIndex]); else show();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      if (!expanded) show();
      if (key === "Home") setHighlight(rows[0]);
      else if (key === "End") setHighlight(rows[rowCount - 1]);
      else if (expanded) setHighlight(rows[Math.max(0, Math.min(rowCount - 1, activeIndex + (key === "ArrowDown" ? 1 : -1)))]);
      return;
    }
    if (key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
    const now = Date.now();
    const char = key.toLocaleLowerCase();
    const previous = now - typed.current.time < 650 ? typed.current.prefix : "";
    const prefix = previous === char ? char : previous + char;
    typed.current = { prefix, time: now };
    const searchRows = expanded ? rows : preferred;
    const start = expanded ? activeIndex : searchRows.indexOf(value);
    for (let step = 0; step < searchRows.length; step++) {
      const name = searchRows[(Math.max(0, start) + step + (prefix.length === 1 ? 1 : 0)) % searchRows.length];
      if (name === null || !label(name).toLocaleLowerCase().startsWith(prefix)) continue;
      event.preventDefault();
      if (expanded) setHighlight(name); else choose(name);
      break;
    }
  }

  const colors = { "--branch-ring": theme.accentFg, "--branch-hover": theme.rowHover,
    "--branch-selected": theme.accentBg, "--branch-muted": theme.textMuted } as CSSProperties;
  return <>
    <button {...aria} type="button" role="combobox" ref={trigger} autoFocus={autoFocus} disabled={unavailable}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded ? listId + "-" + activeIndex : undefined}
      title={label(value)} className="gk-branch-select"
      style={{ ...colors, color: theme.text, background: theme.inputBg, borderColor: invalid ? theme.red : theme.inputBorder }}
      onClick={() => { trigger.current?.focus({ preventScroll: true }); if (expanded) setOpen(false); else show(); }}
      onBlur={() => setOpen(false)} onKeyDown={keyDown}>
      <span>{label(value)}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {expanded && position && createPortal(
      <div id={listId} role="listbox" ref={list} aria-label={aria["aria-label"]} aria-labelledby={aria["aria-labelledby"]}
        className="gk-branch-options" style={{ ...colors, ...position, color: theme.text, background: theme.dialogBg,
          borderColor: theme.inputBorder, boxShadow: theme.shadowEl }}>
        {rows.map((name, index) => <div key={name === null ? "more" : `branch:${name}`} id={listId + "-" + index} role="option" aria-selected={name === value}
          data-active={index === activeIndex || undefined} title={rowLabel(name)} className="gk-branch-option"
          onPointerMove={event => { if (event.pointerType === "mouse" && index !== activeIndex) setHighlight(name); }}
          onMouseDown={event => event.preventDefault()} onClick={() => activate(name)}>
          <span>{rowLabel(name)}</span>
          {name === null && <ChevronDown size={15} aria-hidden="true" style={{ color: theme.textMuted }} />}
          {name === value && <Check size={15} aria-hidden="true" />}
        </div>)}
      </div>, document.body)}
  </>;
}
