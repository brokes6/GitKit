import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowDown, ArrowUp, Check, CheckCheck, ChevronRight, CircleAlert, CloudDownload,
  FilePenLine, FolderGit2, FolderOpen, GitBranch, GitMerge, GitPullRequestArrow,
  LoaderCircle, Plus, RefreshCw, Search, X,
} from "lucide-react";
import type { Project, ThemeColors } from "./App";
import { ToolbarText } from "./ToolbarText";
import { Skeleton } from "./Skeleton";
import { WorkspaceActivity } from "./WorkspaceActivity";
import type { useProjectActivity } from "./useProjectActivity";
import { getCurrentLanguage, tf, tx } from "./i18n";
import {
  OVERVIEW_FILTERS, overviewFilterCounts, overviewState, overviewTarget, selectOverviewProjects,
} from "./projectOverview";
import type { OverviewEntry, OverviewFilter, OverviewState, OverviewTarget, ProjectOverviewSummary } from "./projectOverview";

interface ProjectOverviewProps {
  theme: ThemeColors;
  projects: Project[];
  entries: Record<string, OverviewEntry>;
  refreshing: boolean;
  remoteBusy: boolean;
  remoteCheckedAt: number | null;
  remoteProgress: string | null;
  activity: ReturnType<typeof useProjectActivity>;
  onOpen: (project: Project, target: OverviewTarget) => void;
  onAdd: () => void;
  onClone: () => void;
}

export function WorkbenchActionBar({ theme, total, attention, reading, refreshing, remoteBusy, remoteDisabled,
  onRefresh, onCheckRemote, onAdd }: {
  theme: ThemeColors; total: number; attention: number; reading: boolean; refreshing: boolean;
  remoteBusy: boolean; remoteDisabled: boolean; onRefresh: () => void; onCheckRemote: () => void; onAdd: () => void;
}) {
  const summary = reading ? tf("正在读取 {0} 个仓库", total) : tf("{0} 个仓库 · {1} 个需关注", total, attention);
  return <div className="gk-workbench-toolbar" style={{
    "--gko-text": theme.text, "--gko-secondary": theme.textSec, "--gko-border": theme.border,
    "--gko-accent": theme.accentFg, "--gko-accent-bg": theme.accentBg,
    "--gko-hover": theme.rowHover,
    "--gk-action-accent": theme.accentFg, "--gk-action-active-bg": theme.accentBg,
  } as CSSProperties}>
    <h1 className="gk-workbench-title"><ToolbarText>{tx("工作台")}</ToolbarText></h1>
    <span className="gk-workbench-summary" title={summary} aria-busy={reading}>
      {reading ? <><Skeleton width={145} height={11} /><span className="sr-only">{summary}</span></> : summary}
    </span>
    <div className="gk-workbench-actions" role="group" aria-label={tx("工作台操作")}>
      <button className="gk-overview-button gk-shell-button gk-git-action" onClick={onRefresh} disabled={refreshing || !total}
        data-running={refreshing || undefined} aria-busy={refreshing || undefined}
        title={tx("刷新所有项目的本地状态和提交活动")} aria-label={tx("刷新状态")}>
        <RefreshCw size={14} className={refreshing ? "gk-overview-spin" : undefined} aria-hidden="true" />
        <span className="gk-workbench-action-label"><ToolbarText order={1}>{refreshing ? tx("正在刷新") : tx("刷新状态")}</ToolbarText></span>
      </button>
      <button className="gk-overview-button gk-overview-primary gk-git-action" onClick={onCheckRemote} disabled={remoteBusy || remoteDisabled || !total}
        data-running={remoteBusy || undefined} aria-busy={remoteBusy || undefined}
        title={tx("检查所有项目的远程更新，不受列表筛选影响")} aria-label={tx("检查远程更新")}>
        {remoteBusy ? <LoaderCircle size={14} className="gk-overview-spin" aria-hidden="true" /> : <CloudDownload size={14} aria-hidden="true" />}
        <span className="gk-workbench-action-label"><ToolbarText order={2}>{remoteBusy ? tx("正在检查远程") : tx("检查远程更新")}</ToolbarText></span>
      </button>
      <button className="gk-overview-button gk-overview-add gk-shell-button" onClick={onAdd}
        title={tx("添加仓库")} aria-label={tx("添加仓库")}><Plus size={15} aria-hidden="true" /></button>
    </div>
  </div>;
}

const FILTER_LABELS: Record<OverviewFilter, string> = {
  attention: "需关注", conflicts: "冲突", changes: "更改", ahead: "待推送", behind: "有更新", error: "异常", all: "全部",
};
const FILTER_ORDER: OverviewFilter[] = ["attention", "all", ...OVERVIEW_FILTERS.filter((value) => value !== "attention" && value !== "all")];
const GROUP_LABELS = { priority: "优先处理", work: "更改与同步", other: "其他仓库" };
type OverviewGroup = keyof typeof GROUP_LABELS;
const STATE_GROUPS: Record<OverviewState, OverviewGroup> = {
  conflict: "priority", operation: "priority", diverged: "priority", error: "priority",
  detached: "priority", "missing-upstream": "priority",
  changes: "work", ahead: "work", "local-ahead": "work", behind: "work",
  uninitialized: "other", unborn: "other", untracked: "other", local: "other", clean: "other", unknown: "other",
};
const STATE_ICONS = {
  conflict: GitMerge, operation: GitMerge, diverged: GitPullRequestArrow, changes: FilePenLine,
  ahead: ArrowUp, "local-ahead": ArrowUp, behind: ArrowDown, error: CircleAlert, uninitialized: FolderOpen,
  unborn: FolderGit2, detached: GitBranch, "missing-upstream": CircleAlert,
  untracked: GitBranch, local: FolderGit2, clean: Check, unknown: LoaderCircle,
};
const STATE_TONES: Record<OverviewState, string> = {
  conflict: "danger", operation: "warning", diverged: "warning", changes: "neutral", ahead: "accent", behind: "accent",
  error: "danger", "local-ahead": "neutral", uninitialized: "neutral", unborn: "neutral", detached: "warning", "missing-upstream": "warning",
  untracked: "neutral", local: "neutral", clean: "neutral", unknown: "neutral",
};

function operationLabel(operation: ProjectOverviewSummary["operation"]): string {
  switch (operation) {
    case "merge": return tx("合并");
    case "rebase": return tx("变基");
    case "cherry-pick": return tx("Cherry-pick");
    case "revert": return tx("还原");
    default: return tx("操作");
  }
}

const OnboardingDotField = memo(function OnboardingDotField() {
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const dots = Array.from(field.querySelectorAll<HTMLElement>(".gk-onboarding-dot-highlight"));
    let columns = 1, rows = 1;
    const relocate = (dot: HTMLElement) => {
      dot.style.setProperty("--gk-dot-column", String(Math.floor(Math.random() * columns)));
      dot.style.setProperty("--gk-dot-row", String(Math.floor(Math.random() * rows)));
    };
    const resize = () => {
      columns = Math.max(1, Math.ceil((field.clientWidth - 12) / 24));
      rows = Math.max(1, Math.ceil((field.clientHeight - 12) / 24));
      dots.forEach(relocate);
    };
    const nextPoint = (event: AnimationEvent) => {
      if (event.target instanceof HTMLElement && event.target.classList.contains("gk-onboarding-dot-highlight")) relocate(event.target);
    };
    const updateVisibility = () => { field.dataset.paused = String(document.hidden); };
    const observer = new ResizeObserver(resize);
    observer.observe(field);
    resize();
    updateVisibility();
    field.addEventListener("animationiteration", nextPoint);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer.disconnect();
      field.removeEventListener("animationiteration", nextPoint);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  return <div ref={fieldRef} className="gk-onboarding-dot-field" aria-hidden="true">
    {Array.from({ length: 6 }, (_, index) => <span key={index} className="gk-onboarding-dot-highlight"
      style={{ animationDuration: `${5.4 + index * 0.7}s`, animationDelay: `${-index * 1.1}s` }} />)}
  </div>;
});

function stateTitle(state: OverviewState, entry: OverviewEntry | undefined): string {
  const summary = entry?.summary;
  switch (state) {
    case "conflict": return tf("{0} 个文件存在冲突", summary?.conflictFiles ?? 0);
    case "operation": return summary?.operation === "cherry-pick"
      ? tx("Cherry-pick 尚未完成") : tf("{0}尚未完成", operationLabel(summary?.operation ?? null));
    case "diverged": return tx("当前分支与上游已分叉");
    case "changes": return tf("{0} 个文件有更改", summary?.changedFiles ?? 0);
    case "ahead": return tf("{0} 个提交待推送", summary?.ahead ?? 0);
    case "local-ahead": return tf("领先本地上游 {0} 个提交", summary?.ahead ?? 0);
    case "behind": return (summary?.behind ?? 0) > 0
      ? tf("上游有 {0} 个新提交", summary?.behind ?? 0)
      : tf("{0} 个其他分支有更新", summary?.behindBranches.length ?? 0);
    case "error": return entry?.error ? tx("本地状态读取失败") : tx("远程检查失败");
    case "uninitialized": return tx("尚未初始化 Git");
    case "unborn": return tx("尚无提交记录");
    case "detached": return tx("当前处于分离 HEAD 状态");
    case "missing-upstream": return tx("上游分支已不存在");
    case "untracked": return tx("工作区干净 · 未设置上游");
    case "local": return tx("工作区干净 · 本地仓库");
    case "clean": return tx("工作区干净");
    case "unknown": return entry?.checking ? tx("正在读取状态") : tx("状态待确认");
  }
}

function actionLabel(state: OverviewState): string {
  switch (state) {
    case "conflict": return tx("处理冲突");
    case "operation": return tx("继续处理");
    case "changes": return tx("查看更改");
    case "ahead": case "local-ahead": return tx("查看提交");
    case "diverged": case "behind": return tx("查看更新");
    case "error": return tx("查看原因");
    default: return tx("进入项目");
  }
}

function timestamp(value: number): string {
  const language = getCurrentLanguage() === "en" ? "en-US" : "zh-CN";
  const date = new Date(value);
  const today = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(language, today
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function SummaryDetails({ summary, state }: { summary: ProjectOverviewSummary | null; state: OverviewState }) {
  if (!summary) return null;
  const facts: string[] = [];
  if (summary.operation && state === "conflict") facts.push(summary.operation === "cherry-pick"
    ? tx("Cherry-pick 进行中") : tf("{0}进行中", operationLabel(summary.operation)));
  if (summary.changedFiles > 0) {
    if (summary.stagedFiles > 0) facts.push(tf("已暂存 {0}", summary.stagedFiles));
    if (summary.unstagedFiles > 0) facts.push(tf("未暂存 {0}", summary.unstagedFiles));
  }
  if (state === "operation") facts.push(tx("检查更改后完成操作"));
  if (summary.upstream && (state === "ahead" || state === "local-ahead" || state === "behind" || state === "diverged")) facts.push(summary.upstream);
  if ((summary.ahead ?? 0) > 0 && state !== "ahead" && state !== "local-ahead") facts.push(tf("领先 {0} 个提交", summary.ahead));
  if ((summary.behind ?? 0) > 0 && state !== "behind") facts.push(tf("落后 {0} 个提交", summary.behind));
  if (state === "clean") facts.push(tx("当前分支与本地上游记录一致"));
  if (state === "untracked") facts.push(tx("可在项目中设置跟踪分支"));
  if (state === "local") facts.push(tx("未配置远程仓库"));
  if (state === "unborn") facts.push(tx("创建首次提交后可查看历史"));
  if (state === "uninitialized") facts.push(tx("打开项目后可初始化仓库"));
  if (state === "detached") facts.push(tx("创建或切换分支以继续工作"));
  if (state === "missing-upstream") facts.push(summary.upstream ?? tx("请重新设置跟踪分支"));
  if (!facts.length) return null;
  return <div className="gk-overview-facts" title={facts.join(" · ")}>{facts.join(" · ")}</div>;
}

const OverviewRow = memo(function OverviewRow({ project, entry, showLocation, onOpen }: {
  project: Project; entry: OverviewEntry | undefined; showLocation: boolean; onOpen: ProjectOverviewProps["onOpen"];
  language: string;
}) {
  const summary = entry?.summary ?? null;
  const loading = !summary && !!entry?.checking && !entry.error && !entry.remoteError;
  const state = overviewState(entry);
  const Icon = STATE_ICONS[state];
  const otherBranches = summary?.behindBranches.filter((branch) => !branch.current && branch.name !== summary.currentBranch) ?? [];
  const errors = [...new Set([entry?.error, entry?.remoteError].filter((value): value is string => !!value))];
  const target = overviewTarget(entry);
  const label = actionLabel(state);
  const parentFolder = project.path.replace(/[\\/]+$/, "").split(/[\\/]/).slice(-2, -1)[0];
  return (
    <li className="gk-overview-row" data-tone={STATE_TONES[state]} aria-busy={loading}>
      <div className="gk-overview-project">
        <div className="gk-overview-project-icon" style={{ color: project.color }}><FolderGit2 size={17} aria-hidden="true" /></div>
        <div className="gk-overview-identity">
          <button className="gk-overview-project-name" title={project.path} onClick={() => onOpen(project, "repository")}
            aria-label={tf("进入项目：{0}", project.name)}>{project.name}</button>
          <div className="gk-overview-branch" title={summary?.currentBranch ?? ""}>
            <GitBranch size={11} aria-hidden="true" />
            {loading ? <Skeleton width={72} height={8} />
              : <span>{summary?.currentBranch || (summary?.detached ? tx("分离 HEAD") : tx("分支待确认"))}</span>}
            {showLocation && parentFolder && <span className="gk-overview-location" title={project.path}>{parentFolder}</span>}
          </div>
        </div>
      </div>
      <div className="gk-overview-condition">
        {loading ? <><Skeleton width={108} height={18} /><span className="sr-only">{tx("正在读取状态")}</span></>
          : <div className="gk-overview-state" data-tone={STATE_TONES[state]}>
          <Icon size={14} aria-hidden="true" className={state === "unknown" && entry?.checking ? "gk-overview-spin" : undefined} />
          <span>{stateTitle(state, entry)}</span>
          {entry?.checking && summary && <span className="gk-overview-checking">{tx("更新中")}</span>}
        </div>}
        {loading ? <div className="gk-overview-facts"><Skeleton width={160} height={8} /></div>
          : !entry?.error && <SummaryDetails summary={summary} state={state} />}
        {entry?.error && summary && <div className="gk-overview-facts">{tf("上次读取于 {0}，当前状态未确认", timestamp(summary.checkedAt))}</div>}
        {errors.length > 0 && <details className="gk-overview-errors">
          <summary><CircleAlert size={11} aria-hidden="true" /><span>{entry?.error ? tx("查看读取错误") : tx("远程检查失败")}</span></summary>
          <div>{errors.map((error) => <p key={error}>{error}</p>)}</div>
        </details>}
        {!entry?.error && otherBranches.length > 0 && <details className="gk-overview-other-branches">
          <summary>{tf("另有 {0} 个分支有更新", otherBranches.length)}</summary>
          <div className="gk-overview-branch-list">{otherBranches.map((branch) => <button key={branch.name}
            onClick={() => onOpen(project, "updates")} title={branch.upstream}>
            <GitBranch size={11} aria-hidden="true" /><span>{branch.name}</span>
            <span>{tf("落后 {0}", branch.behind)}{branch.ahead > 0 ? tf(" · 领先 {0}", branch.ahead) : ""}</span>
            <ChevronRight size={11} aria-hidden="true" />
          </button>)}</div>
        </details>}
      </div>
      <button className="gk-overview-row-action" onClick={() => onOpen(project, target)}
        aria-label={tf("{0}：{1}", project.name, label)}>{label}<ChevronRight size={13} aria-hidden="true" /></button>
    </li>
  );
});

export function ProjectOverview({ theme, projects, entries, refreshing, remoteBusy, remoteCheckedAt, remoteProgress,
  activity, onOpen, onAdd, onClone }: ProjectOverviewProps) {
  const [filter, setFilter] = useState<OverviewFilter>("attention");
  const [query, setQuery] = useState("");
  const counts = overviewFilterCounts(projects, entries);
  const shown = selectOverviewProjects(projects, entries, filter, query);
  const names = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const project of projects) {
    if (names.has(project.name)) duplicateNames.add(project.name);
    names.add(project.name);
  }
  const groups = (Object.keys(GROUP_LABELS) as OverviewGroup[]).map((id) => ({
    id, projects: shown.filter((project) => {
      const entry = entries[project.id];
      const group = entry?.error || entry?.remoteError ? "priority" : STATE_GROUPS[overviewState(entry)];
      return group === id;
    }),
  })).filter((group) => group.projects.length > 0);
  const snapshots = projects.map((project) => entries[project.id]?.error ? null : entries[project.id]?.summary?.checkedAt).filter((value): value is number => !!value);
  const localCheckedAt = snapshots.length ? Math.min(...snapshots) : null;
  const pendingProjects = projects.filter((project) => {
    const entry = entries[project.id];
    return entry?.checking && !entry.summary && !entry.error && !entry.remoteError;
  });
  const loading = pendingProjects.length > 0;
  const emptyHealthy = filter === "attention" && !query.trim() && !loading && counts.attention === 0;
  const style = {
    background: theme.bgPanel, color: theme.text, border: `0.5px solid ${theme.border}`,
    "--gko-text": theme.text, "--gko-secondary": theme.textSec, "--gko-muted": theme.textMuted,
    "--gko-border": theme.border, "--gko-hover": theme.rowHover, "--gko-input": theme.inputBg,
    "--gko-input-border": theme.inputBorder, "--gko-accent": theme.accentFg, "--gko-accent-bg": theme.accentBg,
    "--gko-panel": theme.bgPanel, "--gko-surface": theme.bg, "--gko-accent2": theme.accent2Fg,
    "--gko-danger": theme.isDark ? theme.red : `color-mix(in srgb, ${theme.red} 88%, ${theme.text})`,
    "--gko-warning": theme.isDark ? theme.amber : `color-mix(in srgb, ${theme.amber} 75%, ${theme.text})`,
    "--gk-shell-hover": theme.rowHover,
  } as CSSProperties;
  return (
    <main className="gk-workspace-card gk-overview" data-theme={theme.isDark ? "dark" : "light"} style={style} aria-label={tx("工作台")}>
      <div className="gk-overview-body">
      {projects.length > 0 && <>
          <div className="gk-overview-freshness" role="status" aria-live="polite">
            <span>{refreshing ? tx("本地状态正在更新") : localCheckedAt ? tf("本地读取于 {0}", timestamp(localCheckedAt)) : tx("本地状态尚未读取")}</span>
            <span>{remoteBusy ? remoteProgress || tx("远程检查进行中")
              : remoteCheckedAt ? tf("最近一次远程检查 {0}", timestamp(remoteCheckedAt)) : tx("尚无远程检查记录")}</span>
          </div>
        <WorkspaceActivity projects={projects} activity={activity} onOpen={onOpen} />
        <div className="gk-overview-filterbar">
          <div className="gk-overview-filters" role="group" aria-label={tx("事项筛选")}>
            {FILTER_ORDER.map((value) => <button key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}
              className={`gk-overview-filter${value === "attention" || value === "all" ? " gk-overview-scope" : ""}${value === "conflicts" ? " gk-overview-filter-divider" : ""}`}>
              <span>{tx(FILTER_LABELS[value])}</span><span className="gk-overview-filter-count">
                {loading && value !== "all" ? <Skeleton width={12} height={9} /> : counts[value]}
              </span></button>)}
          </div>
          <div className="gk-overview-search">
            <Search size={13} aria-hidden="true" />
            <input id="overview-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
              placeholder={tx("搜索项目或分支")} aria-label={tx("搜索项目或分支")} />
            {query && <button onClick={() => setQuery("")} title={tx("清空搜索")} aria-label={tx("清空搜索")}><X size={12} aria-hidden="true" /></button>}
          </div>
        </div>
      </>}
      <div className={`gk-overview-content${projects.length === 0 ? " is-onboarding" : ""}`} aria-busy={refreshing}>
        {projects.length === 0 ? <div className="gk-overview-empty gk-overview-onboarding">
          <OnboardingDotField />
          <div className="gk-onboarding-art" aria-hidden="true">
            <svg viewBox="0 0 240 148" fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path className="gk-onboarding-folder" d="M82 46H105L114 56H155A8 8 0 0 1 163 64V112A8 8 0 0 1 155 120H82A8 8 0 0 1 74 112V54A8 8 0 0 1 82 46Z" />
              <path className="gk-onboarding-link" d="M104 104V74M104 94C104 85 139 96 139 76V72" />
              <circle className="gk-onboarding-point" cx="104" cy="104" r="4" />
              <circle className="gk-onboarding-point" cx="104" cy="70" r="4" />
              <circle className="gk-onboarding-point" cx="139" cy="68" r="4" />
            </svg>
          </div>
          <h2>{tx("从一个仓库开始")}</h2><p>{tx("添加项目后，在这里查看更改、未完成操作和远程更新。")}</p>
          <div className="gk-overview-actions"><button className="gk-overview-button gk-overview-primary" onClick={onAdd}><Plus size={14} aria-hidden="true" />{tx("添加仓库")}</button>
            <button className="gk-overview-button gk-shell-button" onClick={onClone}><CloudDownload size={14} aria-hidden="true" />{tx("克隆仓库")}</button></div>
        </div> : shown.length > 0 ? groups.map((group) => <section className="gk-overview-section" key={group.id} aria-labelledby={`overview-group-${group.id}`}>
          <div className="gk-overview-section-heading"><h2 id={`overview-group-${group.id}`}>{tx(GROUP_LABELS[group.id])}</h2>
            <span>{group.projects.length}</span></div>
          <ul className="gk-overview-list">{group.projects.map((project) => <OverviewRow key={project.id} project={project}
            entry={entries[project.id]} showLocation={duplicateNames.has(project.name)} onOpen={onOpen} language={getCurrentLanguage()} />)}</ul>
        </section>)
          : loading ? <div className="gk-overview-section" role="status" aria-label={tx("正在读取状态")}>
            <div className="gk-overview-section-heading"><Skeleton width={74} height={10} /></div>
            <ul className="gk-overview-list">{pendingProjects.map((project) => <OverviewRow key={project.id} project={project}
              entry={entries[project.id]} showLocation={duplicateNames.has(project.name)} onOpen={onOpen} language={getCurrentLanguage()} />)}</ul>
          </div> : <div className="gk-overview-empty">
            {emptyHealthy ? <CheckCheck size={24} strokeWidth={1.5} aria-hidden="true" /> : <Search size={24} strokeWidth={1.5} aria-hidden="true" />}
            <h2>{emptyHealthy ? tx("当前没有待处理事项") : query.trim() ? tx("没有找到匹配的项目") : tx("这个筛选下没有项目")}</h2>
            <p>{emptyHealthy ? tx("可查看全部项目，或检查远程是否有新更新。") : query.trim() ? tx("试试项目名称、路径或当前分支。") : tx("选择其他筛选查看项目状态。")}</p>
            <button className="gk-overview-button gk-shell-button" onClick={() => { setFilter("all"); setQuery(""); }}>{tx("查看全部项目")}<ChevronRight size={13} aria-hidden="true" /></button>
          </div>}
      </div>
      </div>
      {projects.length > 0 && <footer className="gk-overview-footer">
        <span>{loading && !shown.length ? <Skeleton width={110} height={9} />
          : tf("显示 {0} / {1} 个仓库", shown.length, projects.length)}</span>
        <span>{tx("提交比较基于本地上游记录")}</span>
      </footer>}
    </main>
  );
}
