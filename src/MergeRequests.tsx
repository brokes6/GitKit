import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowRight, Check, CheckCircle2, ChevronLeft, Clock3, ExternalLink, GitMerge, GitPullRequest, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { CommitFile, ThemeColors } from "./App";
import { tf, translateNativeMessage, tx } from "./i18n";
import type { MrDetail, MrDiffVersion, MrDiscussion, MrMergeOptions, MrMergeResult, MrSnapshot, MrSummary } from "./mergeRequestTypes";
import { mrErrorMessage, mrVersionChanged, reviewVersion, sameMrRefs } from "./mergeRequestHelpers";
import "./styles/mergeRequests.css";

export type MergeRequestTab = "overview" | "changes" | "discussion";
type ListFilter = "all" | "reviewer" | "assignee" | "author";
export type MergeRequestCloseReason = "escape" | "outside" | "button";

function themeStyle(theme: ThemeColors): CSSProperties {
  return {
    "--gkm-bg": theme.bgPanel, "--gkm-surface": theme.dialogBg, "--gkm-border": theme.border,
    "--gkm-text": theme.text, "--gkm-secondary": theme.textSec, "--gkm-muted": theme.textMuted,
    "--gkm-faint": theme.textFaint, "--gkm-accent": theme.accent, "--gkm-accent-bg": theme.accentBg,
    "--gkm-accent-fg": theme.accentFg, "--gkm-green": theme.green, "--gkm-green-bg": theme.greenBg,
    "--gkm-red": theme.red, "--gkm-red-bg": theme.redBg, "--gkm-amber": theme.amber,
    "--gkm-hover": theme.rowHover, "--gkm-selected": theme.rowSelected,
    "--gkm-input": theme.inputBg, "--gkm-input-border": theme.inputBorder, "--gkm-shadow": theme.shadowEl,
  } as CSSProperties;
}

function dateLabel(value: string | number | null): string {
  if (value === null) return tx("尚未同步");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return tx("时间未知");
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function statusLabel(status: string | null): string {
  const labels: Record<string, string> = {
    success: "已通过", failed: "失败", canceled: "已取消", running: "运行中", pending: "等待中",
    preparing: "准备中", created: "等待中", skipped: "已跳过", manual: "等待手动操作", scheduled: "已排期",
  };
  return status ? tx(labels[status] || "状态未知") : tx("暂无流水线");
}

function roleLabel(role: string): string {
  return tx(({ reviewer: "我审核", assignee: "指派给我", author: "我发起" } as Record<string, string>)[role] || "相关");
}

function Banner({ children, tone = "warning", action }: { children: ReactNode; tone?: "warning" | "error" | "info"; action?: ReactNode }) {
  return <div className={`gkm-banner gkm-banner-${tone}`} role={tone === "error" ? "alert" : "status"}><AlertCircle size={15} aria-hidden="true" /><div>{children}</div>{action}</div>;
}

function EmptyState({ title, children, action, busy = false }: { title: string; children?: ReactNode; action?: ReactNode; busy?: boolean }) {
  return <div className="gkm-empty">{busy ? <LoaderCircle className="gkm-spin" size={24} aria-hidden="true" /> : <GitPullRequest size={25} aria-hidden="true" />}<h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

export interface MergeRequestEntryProps {
  theme: ThemeColors;
  snapshot: MrSnapshot | null;
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement>;
  onToggle: () => void;
}

export function MergeRequestEntry({ theme, snapshot, open, anchorRef, onToggle }: MergeRequestEntryProps) {
  if (!snapshot?.total) return null;
  const count = snapshot?.newCount || 0;
  const title = snapshot?.lastCheckedAt === null || !snapshot ? tx("合并请求") : tf("{0} 条相关请求 · {1} 条新请求 · 上次同步 {2}", snapshot.total, count, dateLabel(snapshot.lastCheckedAt));
  return <button ref={anchorRef} type="button" className={`gkm-entry${count ? " gkm-entry-unread" : ""}`} style={themeStyle(theme)} aria-haspopup="dialog" aria-expanded={open} aria-controls="gkm-mr-popover" onClick={onToggle} title={title}>
    <GitPullRequest size={13} aria-hidden="true" /><span>{count > 0 ? tf("{0} 条新合并请求", count) : tf("{0} 条合并请求", snapshot.total)}</span>{count > 0 && <span className="gkm-entry-dot" aria-hidden="true" />}
  </button>;
}

export interface MergeRequestPopoverProps {
  theme: ThemeColors;
  snapshot: MrSnapshot | null;
  configured: boolean;
  error?: string | null;
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement>;
  onClose: (reason: MergeRequestCloseReason) => void;
  onSelect: (mrId: number) => void;
  onRefresh: () => void | Promise<void>;
  onConfigure?: () => void;
}

export function MergeRequestPopover({ theme, snapshot, configured, error, open, anchorRef, onClose, onSelect, onRefresh, onConfigure }: MergeRequestPopoverProps) {
  const [filter, setFilter] = useState<ListFilter>("all");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<Record<ListFilter, number>>({ all: 0, reviewer: 0, assignee: 0, author: 0 });
  const contextRef = useRef<string | null>(snapshot?.contextKey ?? null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const items = snapshot?.items || [];
  const visible = filter === "all" ? items : items.filter(item => item.roles.includes(filter));
  const failure = error || refreshError || snapshot?.error?.message || null;
  const authError = snapshot?.error?.kind === "unauthorized" || snapshot?.error?.kind === "invalid_config";
  const hasCache = snapshot?.lastCheckedAt !== null && snapshot?.lastCheckedAt !== undefined;
  const busy = refreshing || snapshot?.refreshing || (configured && !hasCache && !failure);

  useLayoutEffect(() => {
    const context = snapshot?.contextKey ?? null;
    if (contextRef.current !== context) {
      contextRef.current = context;
      scrollPositions.current = { all: 0, reviewer: 0, assignee: 0, author: 0 };
      setFilter("all");
      setRefreshError(null);
    }
  }, [snapshot?.contextKey]);

  useLayoutEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = scrollPositions.current[filter];
  }, [open, filter]);

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const position = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchor = anchorRef.current;
        const popover = popoverRef.current;
        if (!anchor || !popover) return;
        const viewport = window.visualViewport;
        const offsetLeft = viewport?.offsetLeft || 0;
        const offsetTop = viewport?.offsetTop || 0;
        const width = viewport?.width || window.innerWidth;
        const rect = anchor.getBoundingClientRect();
        const popupWidth = Math.min(380, Math.max(0, width - 16));
        const height = Math.min(600, Math.max(0, rect.top - offsetTop - 16));
        popover.style.width = `${popupWidth}px`;
        popover.style.height = `${height}px`;
        popover.style.left = `${Math.max(offsetLeft + 8, Math.min(rect.left, offsetLeft + width - popupWidth - 8))}px`;
        popover.style.top = `${rect.top - height - 8}px`;
      });
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchorRef.current) observer.observe(anchorRef.current);
    observer.observe(document.documentElement);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, anchorRef, snapshot?.newCount]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (popoverRef.current && path.includes(popoverRef.current)) return;
      if (anchorRef.current && path.includes(anchorRef.current)) return;
      closeRef.current("outside");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current("escape");
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [open, anchorRef]);

  async function refresh() {
    if (busy) return;
    setRefreshing(true);
    setRefreshError(null);
    const context = contextRef.current;
    try { await onRefresh(); } catch (cause) {
      if (context === contextRef.current) setRefreshError(mrErrorMessage(cause));
    } finally { setRefreshing(false); }
  }

  if (!open) return null;
  const filters: Array<[ListFilter, string]> = [["all", "全部"], ["reviewer", "我审核"], ["assignee", "指派给我"], ["author", "我发起"]];
  const configure = onConfigure && <button className="gkm-button gkm-button-primary" type="button" onClick={onConfigure}><KeyRound size={14} aria-hidden="true" />{tx("连接 GitLab 账号")}</button>;
  return createPortal(<div ref={popoverRef} id="gkm-mr-popover" className="gkm-popover" style={themeStyle(theme)} role="dialog" aria-modal={false} aria-labelledby="gkm-list-title">
    <header className="gkm-list-head"><div><h2 id="gkm-list-title">{tx("合并请求")}</h2><p title={snapshot?.instanceUrl ?? undefined}>{tx("所有项目")}{snapshot?.user && ` · @${snapshot.user.username}`}</p></div><button className="gkm-icon-button" type="button" aria-label={tx("刷新合并请求")} title={tx("刷新合并请求")} onClick={refresh} disabled={!configured || busy}><RefreshCw size={15} className={busy ? "gkm-spin" : undefined} aria-hidden="true" /></button><button className="gkm-icon-button" type="button" aria-label={tx("关闭合并请求")} onClick={() => { onClose("button"); anchorRef.current?.focus(); }}><X size={16} aria-hidden="true" /></button></header>
    {configured && hasCache && <div className="gkm-list-count"><span>{tf("{0} 条相关请求", snapshot?.total || 0)}</span>{!!snapshot?.newCount && <strong>{tf("{0} 条新请求", snapshot.newCount)}</strong>}</div>}
    {configured && <div className="gkm-filters" aria-label={tx("按我的角色筛选")}>{filters.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? "is-selected" : ""} onClick={() => setFilter(value)}>{tx(label)}{hasCache && <span>{value === "all" ? items.length : items.filter(item => item.roles.includes(value)).length}</span>}</button>)}</div>}
    <div className="gkm-list-body" ref={listRef} onScroll={event => { scrollPositions.current[filter] = event.currentTarget.scrollTop; }}>
      {!configured ? <EmptyState title={tx("连接账号，查看相关请求")}>{tx("连接 GitLab 账号，同步所有项目中由你审核、指派给你和你发起的合并请求。")}{configure}</EmptyState> : <>
        {failure && <Banner tone="error" action={authError && onConfigure ? <button className="gkm-text-button" type="button" onClick={onConfigure}>{tx("更新凭据")}</button> : undefined}>{translateNativeMessage(failure)}{hasCache && <small>{tx("正在显示上次同步的结果。")}</small>}</Banner>}
        {snapshot?.stale && !failure && <Banner>{tx("缓存可能已过期，刷新后确认最新状态。")}</Banner>}
        {snapshot?.persistenceError && <Banner>{tx("已读记录保存失败，下次启动可能再次显示新提醒。")}</Banner>}
        {!hasCache && busy ? <EmptyState title={tx("正在同步合并请求")} busy>{tx("首次同步会建立基线，已有请求不会全部标为新。")}</EmptyState> : !hasCache && failure ? <EmptyState title={tx("暂时无法同步")}>{tx("连接恢复后可以重试。")}{configure}</EmptyState> : visible.length === 0 ? <EmptyState title={filter === "all" ? tx("没有相关的开放请求") : tx("这个角色下暂无请求")}>{filter === "all" ? tx("新请求会在这里出现。") : tx("可以切换到全部，查看其他相关请求。")}</EmptyState> : visible.map(item => <MergeRequestRow key={item.id} item={item} unread={!!snapshot?.unseenIds.includes(item.id)} onSelect={onSelect} />)}
      </>}
    </div>
    <footer className="gkm-list-foot"><span>{busy ? tx("正在同步…") : hasCache ? tf("上次同步 {0}", dateLabel(snapshot!.lastCheckedAt)) : tx("同步所有项目的相关请求")}</span><span>{tx("打开列表不会清除新提醒")}</span></footer>
  </div>, document.body);
}

function MergeRequestRow({ item, unread, onSelect }: { item: MrSummary; unread: boolean; onSelect: (mrId: number) => void }) {
  const status = item.draft ? tx("草稿") : item.detailedMergeStatus === "mergeable" ? tx("可以合并")
    : item.detailedMergeStatus === "not_approved" ? tx("等待审批") : item.detailedMergeStatus === "conflict" ? tx("存在冲突")
    : item.pipelineStatus && item.pipelineStatus !== "success" ? statusLabel(item.pipelineStatus) : tx("等待合并检查");
  const ready = !item.draft && item.detailedMergeStatus === "mergeable";
  const failed = item.detailedMergeStatus === "conflict" || item.pipelineStatus === "failed";
  return <button className="gkm-row" type="button" title={`${item.projectPathWithNamespace} !${item.iid} · ${item.title}`} onClick={() => onSelect(item.id)} aria-label={tf("打开 {0} !{1}：{2}{3}", item.projectPathWithNamespace, item.iid, item.title, unread ? tx("，新请求") : "")}>
    <span className="gkm-row-top"><GitPullRequest size={14} aria-hidden="true" /><span className="gkm-row-title">{item.title}</span>{item.draft && <span className="gkm-tag">{tx("草稿")}</span>}{unread && <span className="gkm-entry-dot" aria-label={tx("新")} />}<span className="gkm-iid">!{item.iid}</span></span>
    <span className="gkm-row-project" title={item.projectPathWithNamespace}>{item.projectPathWithNamespace}</span>
    <span className="gkm-row-branch" title={`${item.sourceBranch} → ${item.targetBranch}`}><span>{item.sourceBranch}</span><ArrowRight size={11} aria-hidden="true" /><span>{item.targetBranch}</span></span>
    <span className="gkm-row-meta"><span className="gkm-row-identity"><span className="gkm-row-roles">{item.roles.map(roleLabel).join(" · ")}</span><span title={`${item.author.name || item.author.username} · ${dateLabel(item.updatedAt)}`}>{item.author.name || item.author.username} · {dateLabel(item.updatedAt)}</span></span><span className={`gkm-pipeline gkm-pipeline-${ready ? "success" : failed ? "failed" : "none"}`}>{ready ? <CheckCircle2 size={12} aria-hidden="true" /> : failed ? <AlertCircle size={12} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}<span>{status}</span></span></span>
  </button>;
}

export interface MergeRequestDetailProps {
  theme: ThemeColors;
  detail: MrDetail | null;
  latest: MrDetail | null;
  snapshot: MrSnapshot | null;
  loading: boolean;
  error: string | null;
  files: CommitFile[];
  diffVersion: MrDiffVersion | null;
  diffLoading: boolean;
  diffError: string | null;
  discussions: MrDiscussion[];
  discussionsLoading: boolean;
  discussionsError: string | null;
  onRefresh: () => Promise<void>;
  onReviewLatest: () => Promise<void>;
  onMerge: (options: MrMergeOptions) => Promise<MrMergeResult>;
  onOpenExternal: () => void;
  onBackList: () => void;
  onBackWorkspace: () => void;
  onTabChange: (tab: MergeRequestTab) => void;
  renderDiff: (files: CommitFile[], selected: CommitFile | null, onSelect: (file: CommitFile | null) => void, sourceKey: string) => ReactNode;
}

function failureKind(cause: unknown): string | null {
  if (typeof cause === "object" && cause && "kind" in cause && typeof cause.kind === "string") return cause.kind;
  if (typeof cause === "string") {
    try { return failureKind(JSON.parse(cause)); } catch { return null; }
  }
  return null;
}

function CheckRow({ label, children, good, unknown }: { label: string; children: ReactNode; good?: boolean; unknown?: boolean }) {
  return <div className={`gkm-check${good ? " is-good" : unknown ? " is-unknown" : " is-blocked"}`}>{good ? <CheckCircle2 size={15} aria-hidden="true" /> : unknown ? <Clock3 size={15} aria-hidden="true" /> : <AlertCircle size={15} aria-hidden="true" />}<div><span>{label}</span><strong>{children}</strong></div></div>;
}

export function MergeRequestDetail(props: MergeRequestDetailProps) {
  const { theme, detail, latest, snapshot, loading, error, files, diffVersion, diffLoading, diffError, discussions, discussionsLoading, discussionsError, onRefresh, onReviewLatest, onMerge, onOpenExternal, onBackList, onBackWorkspace, onTabChange, renderDiff } = props;
  const [tab, setTab] = useState<MergeRequestTab>("overview");
  const [selectedPath, setSelectedPath] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<"detail" | "confirm" | "result">("detail");
  const [squash, setSquash] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsRecheck, setNeedsRecheck] = useState(false);
  const [result, setResult] = useState<MrMergeResult | null>(null);
  const [animateMergeCompletion, setAnimateMergeCompletion] = useState(false);
  const submitRef = useRef(false);
  const aliveRef = useRef(true);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusedDetailRef = useRef<number | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const summary = detail?.summary;
  const authoritative = latest?.summary.id === summary?.id ? latest : detail;
  const currentSummary = snapshot?.items.find(item => item.iid === summary?.iid && item.projectId === summary?.projectId);
  const reviewedRefs = diffVersion?.refs || detail?.diffRefs || null;
  const reviewedSha = reviewedRefs?.headSha || summary?.sha || "";
  const latestRefs = authoritative?.diffRefs || null;
  const versionChanged = !!detail && (
    !!currentSummary?.sha && currentSummary.sha !== reviewedSha ||
    !!authoritative?.summary.sha && authoritative.summary.sha !== reviewedSha ||
    !!latestRefs && !sameMrRefs(reviewedRefs, latestRefs) ||
    !!currentSummary && currentSummary.targetBranch !== detail.summary.targetBranch ||
    !!authoritative && authoritative.summary.targetBranch !== detail.summary.targetBranch ||
    mrVersionChanged(detail, authoritative) ||
    !!diffVersion && !!authoritative && diffVersion.id !== reviewVersion(authoritative)?.id
  );
  const selectedFile = selectedPath === null ? null : files.find(file => file.path === selectedPath) || files[0] || null;
  const sourceKey = `mr:${summary?.projectId}:${summary?.iid}:${diffVersion?.id ?? "latest"}:${reviewedRefs?.baseSha || ""}:${reviewedRefs?.startSha || ""}:${reviewedSha}`;
  const diff = useMemo(() => renderDiff(files, selectedFile, file => setSelectedPath(file?.path ?? null), sourceKey), [renderDiff, files, selectedFile, sourceKey]);
  const remoteState = authoritative?.summary.state;
  const alreadyMerged = remoteState === "merged";
  const connectionBlocked = !!error || !!snapshot?.error || !!snapshot?.stale;
  const mergeBlocked = !detail || !authoritative?.canMerge || !reviewedSha || !reviewedRefs || !reviewVersion(detail) || versionChanged || connectionBlocked || loading || diffLoading || reviewing || refreshing || needsRecheck || submitting || summary?.draft || remoteState !== "opened" || !!result;
  const policy = authoritative?.squashPolicy || "default_off";
  const effectiveSquash = policy === "always" ? true : policy === "never" ? false : squash;
  const deleteRequired = !!authoritative?.deleteSourceRequired;
  const deleteAllowed = authoritative?.deleteSourceAllowed === true || deleteRequired;
  const effectiveDelete = deleteRequired || deleteAllowed && deleteSource;

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  useEffect(() => {
    if (!animateMergeCompletion) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stopForReducedMotion = () => { if (preference.matches) setAnimateMergeCompletion(false); };
    stopForReducedMotion();
    preference.addEventListener("change", stopForReducedMotion);
    return () => preference.removeEventListener("change", stopForReducedMotion);
  }, [animateMergeCompletion]);
  useEffect(() => {
    if (summary && focusedDetailRef.current !== summary.id) {
      focusedDetailRef.current = summary.id;
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [summary?.id]);
  useEffect(() => {
    if (view === "confirm" && mergeBlocked && !submitting) setView("detail");
  }, [view, mergeBlocked, submitting]);

  function changeTab(value: MergeRequestTab) {
    setTab(value);
    onTabChange(value);
  }

  async function refresh() {
    if (refreshing || submitting) return;
    setRefreshing(true);
    setNotice(null);
    try {
      await onRefresh();
      if (aliveRef.current) setNeedsRecheck(false);
    } catch (cause) {
      if (aliveRef.current) setNotice(mrErrorMessage(cause));
    } finally { if (aliveRef.current) setRefreshing(false); }
  }

  async function reviewLatest() {
    if (reviewing || submitting) return;
    setReviewing(true);
    setNotice(null);
    try {
      await onReviewLatest();
      if (aliveRef.current) { setNeedsRecheck(false); setSelectedPath(undefined); setTab("changes"); }
    } catch (cause) {
      if (aliveRef.current) setNotice(mrErrorMessage(cause));
    } finally { if (aliveRef.current) setReviewing(false); }
  }

  function beginMerge() {
    if (mergeBlocked || !authoritative) return;
    setSquash(authoritative.squash);
    setDeleteSource(authoritative.deleteSourceDefault);
    setView("confirm");
    setNotice(null);
  }

  async function merge() {
    if (submitRef.current || mergeBlocked) return;
    submitRef.current = true;
    setSubmitting(true);
    setNotice(null);
    try {
      const next = await onMerge({ reviewedSha, squash: effectiveSquash, deleteSource: effectiveDelete });
      if (aliveRef.current) {
        // Only this submission's confirmed result celebrates; opening or refreshing an already merged request stays still.
        setAnimateMergeCompletion(next.state === "merged" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
        setResult(next);
        setView("result");
      }
    } catch (cause) {
      if (aliveRef.current) {
        const kind = failureKind(cause);
        const definitive = kind && ["unauthorized", "forbidden", "not_found", "rate_limit", "unsupported", "invalid_config", "blocked", "conflict", "stale"].includes(kind);
        if (definitive) { setNotice(mrErrorMessage(cause)); setNeedsRecheck(true); setView("detail"); }
        else { setResult({ state: "uncertain", message: mrErrorMessage(cause), summary: null }); setView("result"); }
      }
    } finally { submitRef.current = false; if (aliveRef.current) setSubmitting(false); }
  }

  const backButtons = <><button className="gkm-text-button" type="button" onClick={onBackList} disabled={submitting}><ChevronLeft size={14} aria-hidden="true" />{tx("返回列表")}</button><div className="gkm-head-actions"><button className="gkm-icon-button" type="button" title={tx("在 GitLab 中打开")} aria-label={tx("在 GitLab 中打开")} onClick={onOpenExternal} disabled={!detail}><ExternalLink size={15} aria-hidden="true" /></button><button className="gkm-text-button" type="button" onClick={onBackWorkspace} disabled={submitting}>{tx("返回工作区")}</button></div></>;
  if (!detail) return <section className="gkm-detail" style={themeStyle(theme)} aria-label={tx("合并请求详情")}><div className="gkm-detail-nav">{backButtons}</div>{error ? <><Banner tone="error">{translateNativeMessage(error)}</Banner><EmptyState title={tx("无法加载合并请求")} action={<button className="gkm-button" type="button" onClick={refresh} disabled={refreshing}>{tx("重试")}</button>} /></> : <EmptyState title={loading ? tx("正在加载合并请求") : tx("选择一条合并请求")} busy={loading} />}</section>;
  const blockedExplanation = versionChanged ? tx("合并请求版本已变化，请先查看最新改动。") : connectionBlocked ? tx("连接或缓存状态异常，请刷新后再合并。") : needsRecheck ? tx("上次操作失败，请刷新状态后重试。") : !reviewedRefs || !reviewedSha || !reviewVersion(detail) ? tx("差异版本尚未就绪。") : authoritative?.blockedReasons[0] ? translateNativeMessage(authoritative.blockedReasons[0]) : summary!.draft ? tx("草稿暂时无法合并。") : remoteState === "closed" ? tx("这条请求已关闭。") : tx("由 GitLab 校验项目规则与权限");
  const tabs: Array<[MergeRequestTab, string]> = [["overview", "概览"], ["changes", "改动"], ["discussion", "讨论"]];
  const successful = alreadyMerged || result?.state === "merged";
  return <section className="gkm-detail" style={themeStyle(theme)} aria-labelledby="gkm-detail-title">
    <div className="gkm-detail-nav">{backButtons}</div>
    <header className="gkm-detail-head"><div className="gkm-detail-kicker"><GitPullRequest size={15} aria-hidden="true" /><span className="gkm-detail-project" title={summary!.projectPathWithNamespace}>{summary!.projectPathWithNamespace}</span><span>!{summary!.iid}</span><span className="gkm-tag">{tx(alreadyMerged ? "已合并" : remoteState === "closed" ? "已关闭" : summary!.draft ? "草稿" : "开放")}</span>{summary!.roles.map(role => <span className="gkm-role" key={role}>{roleLabel(role)}</span>)}</div><h2 ref={titleRef} tabIndex={-1} id="gkm-detail-title">{summary!.title}</h2><div className="gkm-detail-branches"><code title={summary!.sourceBranch}>{summary!.sourceBranch}</code><ArrowRight size={13} aria-hidden="true" /><code title={summary!.targetBranch}>{summary!.targetBranch}</code><span>{tf("由 {0} 发起", summary!.author.name || summary!.author.username)}</span></div></header>
    {error && <Banner tone="error">{translateNativeMessage(error)}</Banner>}
    {snapshot?.error && !error && <Banner tone="error">{translateNativeMessage(snapshot.error.message)}</Banner>}
    {snapshot?.stale && !snapshot.error && <Banner>{tx("缓存可能已过期，刷新后确认最新状态。")}</Banner>}
    {notice && <Banner tone="error">{translateNativeMessage(notice)}</Banner>}
    {versionChanged && !successful && <Banner action={<button className="gkm-text-button" type="button" onClick={reviewLatest} disabled={reviewing || submitting}>{reviewing && <LoaderCircle className="gkm-spin" size={13} />}{tx("查看最新改动")}</button>}>{tx("合并请求有变化，当前差异仍保留你正在查看的版本。")}</Banner>}
    {view === "confirm" ? <>
      <div className="gkm-confirm"><div className="gkm-confirm-icon"><GitMerge size={24} aria-hidden="true" /></div><h3>{tf("将 !{0} 合并到 {1}", summary!.iid, summary!.targetBranch)}</h3><p>{tx("提交后，GitLab 将按项目规则执行合并。")}</p><dl className="gkm-confirm-summary"><div><dt>{tx("项目")}</dt><dd>{summary!.projectPathWithNamespace}</dd></div><div><dt>{tx("源分支")}</dt><dd>{summary!.sourceBranch}</dd></div><div><dt>{tx("目标分支")}</dt><dd>{summary!.targetBranch}</dd></div><div><dt>{tx("当前查看的版本")}</dt><dd><code title={reviewedSha}>{reviewedSha.slice(0, 12)}</code></dd></div></dl>
        <label className="gkm-option"><input type="checkbox" checked={effectiveSquash} disabled={submitting || policy === "always" || policy === "never"} onChange={event => setSquash(event.target.checked)} /><span>{tx("压缩提交（Squash）")}<small>{tx(policy === "always" ? "项目要求压缩提交" : policy === "never" ? "项目禁止压缩提交" : "将本次改动整理为一个提交")}</small></span></label>
        <label className="gkm-option"><input type="checkbox" checked={effectiveDelete} disabled={submitting || deleteRequired || !deleteAllowed} onChange={event => setDeleteSource(event.target.checked)} /><span>{tx("合并后删除源分支")}<small>{tx(deleteRequired ? "项目要求删除源分支" : !deleteAllowed ? "没有删除源分支的权限" : "只影响远程源分支，本地分支保持原样")}</small></span></label><div className="gkm-sha-check"><ShieldCheck size={15} aria-hidden="true" />{tx("合并时再次核对源版本与权限")}</div>
      </div><footer className="gkm-detail-foot"><span>{tx("不会自动更新本地仓库")}</span><div className="gkm-foot-actions"><button className="gkm-button" type="button" onClick={() => setView("detail")} disabled={submitting}>{tx("返回详情")}</button><button className="gkm-button gkm-button-primary" type="button" onClick={merge} disabled={mergeBlocked}>{submitting ? <LoaderCircle className="gkm-spin" size={14} /> : <GitMerge size={14} />}{tx(submitting ? "正在提交…" : "确认合并")}</button></div></footer>
    </> : view === "result" || alreadyMerged ? <>
      <div className={`gkm-result${successful ? " is-success" : ""}`}>
        {successful ? <div className={`gkm-merge-completion${animateMergeCompletion ? " is-arriving" : ""}`} aria-hidden="true" onAnimationEnd={event => {
          if (event.target === event.currentTarget) setAnimateMergeCompletion(false);
        }}>
          <svg width="112" height="72" viewBox="0 0 112 72" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path className="gkm-merge-branch" d="M12 18H26C40 18 38 36 55 36H65" />
            <path className="gkm-merge-branch" d="M12 54H26C40 54 38 36 55 36H65" />
            <circle className="gkm-merge-node" cx="12" cy="18" r="4" />
            <circle className="gkm-merge-node" cx="12" cy="54" r="4" />
            <path className="gkm-merge-flow" pathLength="100" d="M16 18H26C40 18 38 36 55 36H65" />
            <path className="gkm-merge-flow gkm-merge-flow-second" pathLength="100" d="M16 54H26C40 54 38 36 55 36H65" />
            <circle className="gkm-merge-ring" pathLength="100" cx="83" cy="36" r="18" />
            <path className="gkm-merge-check" pathLength="100" strokeWidth="3" d="M75 36L80 41L91 30" />
          </svg>
        </div> : <Clock3 size={40} aria-hidden="true" />}
        <h3>{tx(successful ? "合并完成" : result?.state === "pending" ? "GitLab 正在处理合并" : "合并结果暂时无法确认")}</h3><p>{successful ? tf("!{0} 已合并到 {1}。", summary!.iid, summary!.targetBranch) : translateNativeMessage(result?.message || "")}</p>{!successful && <p>{tx("请刷新状态或在 GitLab 中确认结果。")}</p>}<div className="gkm-result-local">{tx("本地仓库尚未更新，可以稍后执行 Pull。")}</div></div><footer className="gkm-detail-foot"><span>{tx("以 GitLab 实际状态为准")}</span><div className="gkm-foot-actions">{!successful && <button className="gkm-button" type="button" onClick={refresh} disabled={refreshing}>{refreshing && <LoaderCircle size={14} className="gkm-spin" />}{tx("刷新状态")}</button>}<button className="gkm-button gkm-button-primary" type="button" onClick={onBackList}>{tx("返回合并请求")}</button></div></footer>
    </> : <>
      <div ref={tabsRef} className="gkm-tabs" role="tablist" aria-label={tx("合并请求内容")} onKeyDown={event => {
        const index = tabs.findIndex(([value]) => value === tab);
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); changeTab(tabs[next][0]); tabsRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
      }}>{tabs.map(([value, label]) => <button type="button" role="tab" key={value} id={`gkm-tab-${value}`} aria-controls={`gkm-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => changeTab(value)}>{tx(label)}{value === "changes" && files.length > 0 && <span>{files.length}</span>}</button>)}<button className="gkm-icon-button gkm-tabs-refresh" type="button" onClick={refresh} disabled={refreshing || loading} title={tx("刷新状态")} aria-label={tx("刷新状态")}><RefreshCw size={14} className={refreshing || loading ? "gkm-spin" : undefined} aria-hidden="true" /></button></div>
      <div className="gkm-detail-panels">
        <div className="gkm-panel gkm-overview" id="gkm-panel-overview" role="tabpanel" aria-labelledby="gkm-tab-overview" hidden={tab !== "overview"}><div className="gkm-description"><h3>{tx("说明")}</h3>{detail.description ? <div className="gkm-prose">{detail.description}</div> : <p className="gkm-muted">{tx("这条请求没有填写说明。")}</p>}<div className="gkm-author"><span className="gkm-avatar" aria-hidden="true">{(summary!.author.name || summary!.author.username).slice(0, 1)}</span><div>{summary!.author.name || summary!.author.username}<small>{tf("最后更新 {0}", dateLabel(summary!.updatedAt))}</small></div></div><div className="gkm-reviewed">{tx("当前查看的版本")}<code title={reviewedSha}>{reviewedSha ? reviewedSha.slice(0, 12) : tx("尚未就绪")}</code></div></div>
          <aside className="gkm-checks"><h3>{tx("合并条件")}</h3><CheckRow label={tx("流水线")} good={authoritative?.pipelineStatus === "success"} unknown={!authoritative?.pipelineStatus || ["running", "pending", "preparing", "created", "scheduled"].includes(authoritative.pipelineStatus)}>{statusLabel(authoritative?.pipelineStatus || null)}</CheckRow><CheckRow label={tx("审批")} good={authoritative?.approvals.approved === true || authoritative?.approvals.approvalsRequired === 0} unknown={!authoritative?.approvals.readable || authoritative.approvals.approved === null}>{!authoritative?.approvals.readable ? tx("审批信息不可读") : authoritative.approvals.approvalsLeft && authoritative.approvals.approvalsLeft > 0 ? tf("还需 {0} 次审批", authoritative.approvals.approvalsLeft) : authoritative.approvals.approved === true ? tx("已通过") : authoritative.approvals.approvalsRequired === 0 ? tx("无需审批") : tx("等待审批")}</CheckRow><CheckRow label={tx("讨论")} good={authoritative?.blockingDiscussionsResolved === true} unknown={authoritative?.blockingDiscussionsResolved === null}>{authoritative?.blockingDiscussionsResolved === true ? tx("阻塞讨论已解决") : authoritative?.blockingDiscussionsResolved === false ? tx("仍有未解决的讨论") : tx("讨论状态未知")}</CheckRow><CheckRow label={tx("合并权限与规则")} good={authoritative?.canMerge === true} unknown={!authoritative?.summary.detailedMergeStatus}>{authoritative?.canMerge ? tx("GitLab 允许合并") : tx("暂时无法合并")}</CheckRow>{authoritative?.blockedReasons.length ? <ul className="gkm-blocked-reasons">{authoritative.blockedReasons.map((reason, index) => <li key={index}>{translateNativeMessage(reason)}</li>)}</ul> : null}<p className="gkm-check-note">{tx("权限、审批、CI 和冲突均以 GitLab 为准。")}</p></aside>
        </div>
        <div className="gkm-panel gkm-changes" id="gkm-panel-changes" role="tabpanel" aria-labelledby="gkm-tab-changes" hidden={tab !== "changes"}>{diffError && <Banner tone="error" action={<button type="button" className="gkm-text-button" onClick={() => onTabChange("changes")}>{tx("重试")}</button>}>{translateNativeMessage(diffError)}</Banner>}{diffVersion?.truncated && <Banner action={<button className="gkm-text-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中查看")}</button>}>{tx("GitLab 未返回完整差异，请在网页中继续查看。")}</Banner>}{diffLoading && files.length === 0 ? <EmptyState title={tx("正在加载差异")} busy /> : files.length ? <div className="gkm-diff">{diff}</div> : !diffError && <EmptyState title={tx("没有可显示的文件差异")} action={<button className="gkm-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中查看")}</button>} />}</div>
        <div className="gkm-panel gkm-discussions" id="gkm-panel-discussion" role="tabpanel" aria-labelledby="gkm-tab-discussion" hidden={tab !== "discussion"}>{discussionsError && <Banner tone="error" action={<button className="gkm-text-button" type="button" onClick={() => onTabChange("discussion")}>{tx("重试")}</button>}>{translateNativeMessage(discussionsError)}</Banner>}{discussionsLoading && discussions.length === 0 ? <EmptyState title={tx("正在加载讨论")} busy /> : discussions.length ? discussions.map(discussion => <article className="gkm-thread" key={discussion.id}>{discussion.notes.map(note => <div key={note.id} className={`gkm-note${note.system ? " is-system" : ""}`}><span className="gkm-avatar" aria-hidden="true">{(note.author.name || note.author.username).slice(0, 1)}</span><div><div className="gkm-note-meta"><strong>{note.author.name || note.author.username}</strong><span>{dateLabel(note.createdAt)}</span>{note.resolvable && <span className={note.resolved ? "gkm-resolved" : "gkm-unresolved"}>{note.resolved ? <Check size={11} aria-hidden="true" /> : <Clock3 size={11} aria-hidden="true" />}{tx(note.resolved ? "已解决" : "未解决")}</span>}{note.system && <span>{tx("系统消息")}</span>}</div><div className="gkm-prose">{note.body}</div></div></div>)}</article>) : !discussionsError && <EmptyState title={tx("暂无讨论")} /> }<p className="gkm-discussion-note">{tx("回复和解决讨论请在 GitLab 中操作。")}<button className="gkm-text-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中打开")}<ExternalLink size={12} aria-hidden="true" /></button></p></div>
      </div>
      <footer className="gkm-detail-foot"><span className="gkm-foot-hint">{mergeBlocked ? <AlertCircle size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}{blockedExplanation}</span><button type="button" className="gkm-button gkm-button-primary" onClick={beginMerge} disabled={mergeBlocked}><GitMerge size={14} aria-hidden="true" />{tx("合并请求")}</button></footer>
    </>}
  </section>;
}
