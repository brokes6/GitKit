import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Download, Files, FolderGit2, FolderOpen,
  GitBranch, MoreHorizontal, RefreshCw, Settings, Upload,
} from "lucide-react";
import { createProjectReadQueue } from "../projectReadQueue";
import { branchColor } from "../git";
import { BranchPicker } from "./BranchPicker";
import { BranchTree } from "./BranchTree";
import type { LaneBranch, StackModel } from "./stackModel";
import type { CreateRequest, LanesWorkspaceProps } from "./types";
import { useDismiss } from "./useDismiss";
import { useLastValue, usePresence } from "./usePresence";
import { getCurrentLanguage, tf, tx } from "../i18n";

// ─── dock ───────────────────────────────────────────────────────────────────

type DockMenu = "project" | "tree" | "more" | null;

function measureDockSegments(buttons: HTMLButtonElement[]) {
  for (const button of buttons) button.setAttribute("data-measuring", "");
  const widths = buttons.map(button => button.getBoundingClientRect().width);
  buttons.forEach((button, index) => {
    button.removeAttribute("data-measuring");
    const width = widths[index] + "px";
    if (button.parentElement!.style.width !== width) button.parentElement!.style.width = width;
  });
}

export function Dock({ project, projects, model, demo, status, changes, current, laneIndex, onPick, onSelectProject, onOpenProject, onCloneProject,
  readProjectChanges, onOpenChanges, changesOpen, onFetch, onPull, onPush, busy, moreActions, onOpenSettings, inbox,
  create, defaultBase, busyCreate, onOpenCreate, onCloseCreate, onSubmitCreate, existing }: LanesWorkspaceProps & {
  model: StackModel | null; current?: LaneBranch; laneIndex: (branch: string) => number; onPick: (b: string) => void;
  create: CreateRequest | null; defaultBase: string; busyCreate: boolean;
  onOpenCreate: () => void; onCloseCreate: () => void; onSubmitCreate: (name: string, base: string) => void;
  existing: string[];
}) {
  const [menu, setMenu] = useState<DockMenu>(null);
  const ref = useRef<HTMLElement>(null);
  const hasModel = model !== null;
  useLayoutEffect(() => {
    if (!hasModel) setMenu(open => open === "tree" ? null : open);
  }, [hasModel]);
  const close = useCallback(() => setMenu(null), []);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  useDismiss(menu !== null, ref, close, undefined, menuTrigger);
  const toggle = (m: DockMenu, button: HTMLButtonElement) => {
    menuTrigger.current = button;
    setMenu(v => v === m ? null : m);
  };
  const trunk = model?.trunkBranch;
  const ahead = current?.ahead ?? 0, behind = current?.behind ?? 0;
  const unpublished = !!current && !current.upstream;
  const moreRef = useRef<HTMLDivElement>(null);
  const more = usePresence(menu === "more", moreRef);
  // The parent closes the create popover by clearing `create`; keep the last one for its exit.
  const createRef = useRef<HTMLDivElement>(null);
  const createOpen = !!create && !!model;
  const createPresence = usePresence(createOpen, createRef);
  const shownCreate = useLastValue(createOpen ? create : null);
  const shownModel = useLastValue(createOpen ? model : null);
  const inboxLabel = tx("合并请求");
  const inboxStatus = inbox
    ? !inbox.configured
      ? tx("未连接")
      : inbox.failed ? tx("读取失败")
      : inbox.total === null ? tx("加载中…")
      : inbox.total > 0 ? tf("{0} 个待处理", inbox.total) : tx("当前没有待处理事项")
    : undefined;

  const repoLabel = demo ? tx("演示数据") : tx("仓库");
  const repoName = project?.name ?? tx("未打开");
  const changesLabel = status === "error" ? tx("读取失败") : status === "loading" ? tx("加载中…")
    : status === "none" ? "—" : changes ? tf("{0} 个改动", changes) : tx("干净");
  const language = getCurrentLanguage();
  const measuredText = useRef(new WeakMap<HTMLButtonElement, string>());
  useLayoutEffect(() => {
    const buttons = ref.current!.querySelectorAll<HTMLButtonElement>(":scope > .lk-seg-wrap > .lk-seg");
    const changed = Array.from(buttons).filter(button => {
      const text = button.textContent ?? "";
      if (measuredText.current.get(button) === text) return false;
      measuredText.current.set(button, text);
      return true;
    });
    measureDockSegments(changed);
  }, [repoLabel, repoName, current?.name, changesLabel, inboxStatus, inbox?.unread, language]);

  useLayoutEffect(() => {
    const measure = () => measureDockSegments(Array.from(ref.current!.querySelectorAll(":scope > .lk-seg-wrap > .lk-seg")));
    document.fonts.addEventListener("loadingdone", measure);
    return () => document.fonts.removeEventListener("loadingdone", measure);
  }, []);

  return <div className="lk-dock-wrap">
    <nav className="lk-dock" ref={ref} aria-label={tx("主导航")}>
      <Segment open={menu === "project"} onClick={e => toggle("project", e.currentTarget)} label={repoLabel}
        icon={<span className="lk-repo-icon"><FolderGit2 size={15} aria-hidden="true" /></span>}
        value={repoName} className="lk-seg-repo">
        <div className="lk-menu">
          <div className="lk-tree-title">{tx("切换仓库")}</div>
          <ProjectRows projects={projects} activePath={project?.path} activeCount={status === "ready" ? changes : null}
            open={menu === "project"} read={readProjectChanges} select={p => { close(); onSelectProject(p); }} />
          {!projects.length && <div className="lk-tree-none">{demo ? tx("浏览器中只能查看演示数据") : tx("还没有添加项目")}</div>}
          {!demo && <>
            <div className="lk-menu-sep" />
            <button type="button" className="lk-menu-row" onClick={() => { setMenu(null); onOpenProject(); }}>
              <FolderOpen size={14} aria-hidden="true" /><span>{tx("打开其他仓库…")}</span>
            </button>
            {onCloneProject && <button type="button" className="lk-menu-row" onClick={() => { setMenu(null); onCloneProject(); }}>
              <Download size={14} aria-hidden="true" /><span>{tx("克隆仓库…")}</span>
            </button>}
          </>}
        </div>
      </Segment>

      <Segment open={!!model && menu === "tree"} disabled={!model} onClick={e => toggle("tree", e.currentTarget)} label={tx("当前分支")}
        value={<span className="lk-seg-branch" style={current ? { "--lk-branch": branchColor(current.name) } as CSSProperties : undefined}>
          {current && <span className="lk-dot" aria-hidden="true" />}<span>{current?.name ?? "—"}</span></span>}>
        {model && <div className="lk-menu lk-menu-wide">
          <BranchTree model={model} laneIndex={laneIndex} current={current?.name} title={tx("分支树 · 点击显示")}
            onPick={(b) => { setMenu(null); onPick(b); }} trunkInfo={trunk ? <>
              {trunk.behind > 0 && <span className="lk-sync"><ArrowDown size={11} aria-hidden="true" />{trunk.behind}</span>}
              {trunk.ahead > 0 && <span className="lk-sync"><ArrowUp size={11} aria-hidden="true" />{trunk.ahead}</span>}
            </> : null} />
        </div>}
      </Segment>

      <Segment disabled={status !== "ready"} label={tx("工作区")} onClick={() => { setMenu(null); onOpenChanges(); }} open={changesOpen} className="lk-seg-changes-toggle" chevron={<ChevronRight size={13} className="lk-seg-chevron" aria-hidden="true" />}
        value={<span data-dirty={changes > 0 || undefined} className="lk-seg-changes">{changesLabel}</span>} />

      {inbox && <div className="lk-seg-wrap lk-dock-inbox">
        <button type="button" className="lk-seg" ref={(el) => { inbox.anchorRef.current = el; }}
          data-open={inbox.open || undefined} aria-expanded={inbox.open} aria-haspopup="dialog" aria-controls={inbox.open ? "gkm-mr-popover" : undefined}
          aria-label={inbox.unread > 0 ? `${inboxLabel} · ${inboxStatus} · ${tf("{0} 条新请求", inbox.unread)}` : undefined}
          title={inboxStatus} onClick={() => { close(); inbox.onToggle(); }}>
          <span className="lk-seg-text">
            <span className="lk-seg-label">{inboxLabel}</span>
            <span className="lk-seg-value"><span>{inboxStatus}</span></span>
          </span>
          {inbox.unread > 0 && <span className="lk-dock-inbox-badge" aria-hidden="true">
            {inbox.unread}
          </span>}
        </button>
      </div>}

      <div className="lk-dock-tools" role="group" aria-label={tx("同步")}>
        <RoundButton label={tx("获取")} title={tx("获取远程更新，并快进可同步的本地分支")} onClick={busy ? undefined : onFetch} busy={busy === "fetch"} icon={<RefreshCw size={15} aria-hidden="true" />} />
        <RoundButton label={tx("拉取")} onClick={busy ? undefined : onPull} busy={busy === "pull"} badge={behind || undefined}
          icon={<Download size={15} aria-hidden="true" />} />
        <RoundButton label={unpublished ? tx("发布分支") : tx("推送")} onClick={busy ? undefined : onPush} busy={busy === "push"}
          badge={ahead || (unpublished ? "+" : undefined)} icon={<Upload size={15} aria-hidden="true" />} />
        {moreActions.length > 0 && <div className="lk-seg-wrap">
          <RoundButton label={tx("更多操作")} onClick={e => toggle("more", e.currentTarget)} active={menu === "more"}
            icon={<MoreHorizontal size={16} aria-hidden="true" />} />
          {more.mounted && <div className="lk-popover lk-popover-up lk-popover-end" ref={moreRef} {...more.attrs}>
            <div className="lk-menu">
              {moreActions.map((item, i) => item === "sep"
                ? <div key={`sep-${i}`} className="lk-menu-sep" />
                : <button key={item.label} type="button" className="lk-menu-row" data-danger={item.danger || undefined}
                  disabled={item.disabled} onClick={() => { setMenu(null); item.onClick(); }}>
                  {item.icon}<span>{item.label}</span>
                </button>)}
            </div>
          </div>}
        </div>}
        <RoundButton label={tx("设置")} onClick={onOpenSettings} icon={<Settings size={15} aria-hidden="true" />} />
      </div>

      <div className="lk-primary-wrap">
        <button type="button" className="lk-primary" ref={createTrigger} data-lk-create-toggle disabled={!model} aria-expanded={!!create}
          onClick={() => { setMenu(null); if (create) onCloseCreate(); else onOpenCreate(); }}>
          {tx("新建分支")}<ArrowRight size={15} aria-hidden="true" />
        </button>
        {createPresence.mounted && shownCreate && shownModel && <CreatePopover trigger={createTrigger} popRef={createRef} attrs={createPresence.attrs}
          open={createOpen} model={shownModel} initialBase={shownCreate.base || defaultBase} commit={shownCreate.commit} busy={busyCreate}
          existing={existing} onClose={onCloseCreate} onSubmit={onSubmitCreate} />}
      </div>
    </nav>
  </div>;
}

function ProjectRows({ projects, activePath, activeCount, open, read, select }: {
  projects: LanesWorkspaceProps["projects"]; activePath?: string; activeCount: number | null;
  open: boolean; read: LanesWorkspaceProps["readProjectChanges"]; select: LanesWorkspaceProps["onSelectProject"];
}) {
  const [counts, setCounts] = useState(new Map<string, number | null>());
  const otherPaths = JSON.stringify(projects.filter(p => p.path !== activePath).map(p => p.path));
  useEffect(() => {
    if (!open || !read) return;
    const queue = createProjectReadQueue(read, {
      onBatch(results) {
        setCounts(previous => {
          const next = new Map(previous);
          for (const { path, value } of results) next.set(path, value);
          return next;
        });
      },
    });
    queue.setPaths(JSON.parse(otherPaths));
    queue.setActive(true);
    return () => queue.dispose();
  }, [open, read, otherPaths]);

  return <div className="lk-tree-scroll">
    {projects.map(p => {
      const active = p.path === activePath;
      const count = active ? activeCount : counts.get(p.path);
      const label = count == null ? tx("未取得文件数") : tf("{0} 个未提交文件", count);
      return <button key={p.id} type="button" className="lk-menu-row"
        data-active={active || undefined} onClick={() => select(p)} aria-label={p.name + " · " + label}>
        <FolderGit2 size={14} aria-hidden="true" /><span>{p.name}</span>
        {active && <Check size={13} className="shrink-0" aria-hidden="true" />}
        {count !== 0 && <small className="lk-project-count" data-dirty={!!count || undefined} title={label}>
          {count != null && <Files size={11} aria-hidden="true" />}
          {count ?? (count === undefined ? "…" : "—")}
        </small>}
      </button>;
    })}
  </div>;
}

function RoundButton({ label, title, icon, onClick, busy, badge, active }: {
  label: string; title?: string; icon: ReactNode; onClick?: React.MouseEventHandler<HTMLButtonElement>; busy?: boolean; badge?: number | string; active?: boolean;
}) {
  return <button type="button" className="lk-round" title={title ?? label} aria-expanded={active} aria-label={badge ? `${label} (${badge})` : label}
    onClick={onClick} disabled={!onClick || busy} data-busy={busy || undefined} data-active={active || undefined}
    aria-busy={busy || undefined}>
    {busy ? <RefreshCw size={15} aria-hidden="true" className="lk-spin" /> : icon}
    {badge !== undefined && !busy && <span className="lk-round-badge">{badge}</span>}
  </button>;
}

function Segment({ label, value, hint, icon, open, onClick, children, className, chevron, disabled }: {
  label: string; value: ReactNode; hint?: string; icon?: ReactNode; open?: boolean; disabled?: boolean; onClick?: React.MouseEventHandler<HTMLButtonElement>; children?: ReactNode;
  className?: string; chevron?: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(!!open && !!children, popRef);
  const content = <>
    {icon}
    <span className="lk-seg-text">
      <span className="lk-seg-label">{label}{hint && <em> · {hint}</em>}</span>
      <span className="lk-seg-value">{value}</span>
    </span>
    {onClick && (chevron ?? <ChevronDown size={13} className="lk-seg-chevron" aria-hidden="true" />)}
  </>;
  return <div className={className ? `lk-seg-wrap ${className}` : "lk-seg-wrap"}>
    {onClick
      ? <button type="button" className="lk-seg" disabled={disabled} data-open={open || undefined} aria-expanded={children ? open : undefined} onClick={onClick}>{content}</button>
      : <div className="lk-seg">{content}</div>}
    {presence.mounted && <div className="lk-popover lk-popover-up" ref={popRef} {...presence.attrs}>{children}</div>}
  </div>;
}

function CreatePopover({ trigger, popRef, attrs, open, model, initialBase, commit, busy, existing, onClose, onSubmit }: {
  trigger: RefObject<HTMLButtonElement>; popRef: RefObject<HTMLDivElement>; attrs: ReturnType<typeof usePresence>["attrs"]; open: boolean;
  model: StackModel; initialBase: string; commit?: CreateRequest["commit"]; busy: boolean; existing: string[];
  onClose: () => void; onSubmit: (name: string, base: string) => void;
}) {
  const [name, setName] = useState("");
  const [base, setBase] = useState(initialBase);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(open, popRef, onClose, "[data-lk-create-toggle]", trigger);
  // Each logical open (including one that interrupts the exit) starts a fresh form.
  useLayoutEffect(() => { if (open) setName(""); }, [open]);
  // Passive, so it runs after Dock's presence hook has lifted `inert` on a mid-exit reopen.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useLayoutEffect(() => { setBase(initialBase); }, [initialBase, open]);
  const trimmed = name.trim();
  const error = !trimmed ? null
    : /\s/.test(trimmed) ? tx("分支名不能包含空格")
    : existing.includes(trimmed) ? tx("已有同名分支") : null;
  const onTrunk = base === model.trunk;

  return <div className="lk-popover lk-popover-up lk-create" ref={popRef} {...attrs} role="dialog" aria-label={tx("新建分支")}>
    <form onSubmit={(e) => { e.preventDefault(); if (open && trimmed && !error && !busy) onSubmit(trimmed, commit?.hash ?? base); }}>
      <div className="lk-create-title">{tx("新建分支")}</div>
      <input ref={inputRef} className="lk-input" value={name} onChange={(e) => setName(e.target.value)}
        placeholder={tf("例如 {0}", "feat/branch-lanes")} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      <div className="lk-create-label">{tx("基于")}</div>
      {commit ? <div className="lk-create-commit" title={commit.message}>
        <code>{commit.short}</code><span>{commit.message.split("\n", 1)[0]}</span>
      </div> : <div className="lk-base-options">
        <button type="button" className="lk-base-option" title={model.trunk} aria-pressed={onTrunk} data-active={onTrunk || undefined} onClick={() => setBase(model.trunk)}>
          <GitBranch size={13} aria-hidden="true" /><span className="lk-picker-label">{model.trunk}</span>
        </button>
        {initialBase !== model.trunk && <button type="button" className="lk-base-option" title={initialBase} aria-pressed={base === initialBase} data-active={base === initialBase || undefined}
          style={{ "--lk-branch": branchColor(initialBase) } as CSSProperties} onClick={() => setBase(initialBase)}>
          <span className="lk-dot" aria-hidden="true" /><span className="lk-picker-label">{initialBase}</span>
        </button>}
        <BranchPicker model={model} value={base} onChange={setBase} showValue={base !== model.trunk && base !== initialBase} />
      </div>}
      <p className="lk-create-hint">{error ?? (commit
        ? tf("从 {0} 里的这个提交拉出，不会切换当前分支", initialBase)
        : tf("从 {0} 的最新提交拉出，不会切换当前分支", base))}</p>
      <div className="lk-create-actions">
        <button type="button" className="lk-button lk-button-ghost" onClick={onClose}>{tx("取消")}</button>
        <button type="submit" className="lk-button lk-button-solid" disabled={!trimmed || !!error || busy}>
          {busy ? tx("创建中…") : tx("新建分支")}
        </button>
      </div>
    </form>
  </div>;
}
