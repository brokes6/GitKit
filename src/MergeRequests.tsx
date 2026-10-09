import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowRight, Check, CheckCircle2, ChevronLeft, Clock3, Download, ExternalLink, GitMerge, GitPullRequest, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { CommitFile, ThemeColors } from "./App";
import { tf, translateNativeMessage, tx } from "./i18n";
import type { MrActionResult, MrCommitMessages, MrDetail, MrDiffVersion, MrDiscussion, MrDownloadedDiff, MrMergeOptions, MrMergeResult, MrSnapshot, MrSummary } from "./mergeRequestTypes";
import { mrErrorMessage, mrVersionChanged, mrViewerActions, reviewVersion, sameMrRefs } from "./mergeRequestHelpers";
import { CodeSkeleton, Skeleton } from "./Skeleton";
import { MergeRequestDownload } from "./MergeRequestDownload";
import { MergeRequestParticipants } from "./MergeRequestParticipants";
import { DialogPresence } from "./DialogPresence";
import type { MrParticipantCandidates, MrParticipantKind, MrParticipantsResult } from "./mergeRequestTypes";
import type { MrLineCommentActions } from "./MergeRequestDiffComment";
import type { MrDiffCommentPosition, MrDiffCommentResult } from "./mergeRequestTypes";
import { mrDiscussionDiffPosition, mrDiscussionDiffTarget } from "./mrDiffCommentHelpers";
import { MergeRequestAvatar } from "./MergeRequestAvatar";
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

function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="gkm-empty"><GitPullRequest size={25} aria-hidden="true" /><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

function MergeRequestListSkeleton() {
  return <div role="status" aria-label={tx("正在同步合并请求")} aria-busy="true">
    {[0, 1, 2, 3].map(index => <div className="gkm-row" key={index} aria-hidden="true">
      <div className="gkm-row-top"><Skeleton width={14} height={14} /><Skeleton width={`${76 - index * 7}%`} height={13} /></div>
      <div className="gkm-skeleton-lines"><Skeleton width="57%" /><Skeleton width="81%" /><div className="gkm-skeleton-inline"><Skeleton width="42%" /><Skeleton width="25%" /></div></div>
    </div>)}
  </div>;
}

function MergeRequestDetailSkeleton() {
  return <div className="gkm-detail-skeleton" role="status" aria-label={tx("正在加载合并请求")} aria-busy="true">
    <header className="gkm-detail-head" aria-hidden="true">
      <div className="gkm-detail-kicker"><Skeleton width={15} height={15} /><Skeleton width="24%" /><Skeleton width={32} /><Skeleton width={38} /></div>
      <div className="gkm-skeleton-title"><Skeleton width="68%" height={24} /></div>
      <div className="gkm-detail-branches"><Skeleton width="28%" height={22} /><Skeleton width={13} /><Skeleton width="12%" height={22} /><Skeleton width="18%" /></div>
    </header>
    <div className="gkm-tabs gkm-skeleton-tabs" aria-hidden="true">{[0, 1, 2].map(index => <Skeleton key={index} width={36} height={12} />)}</div>
    <div className="gkm-detail-panels" aria-hidden="true"><div className="gkm-panel gkm-overview">
      <div className="gkm-description"><Skeleton width={45} height={12} /><div className="gkm-skeleton-lines gkm-skeleton-description">{[94, 86, 97, 63].map(width => <Skeleton key={width} width={`${width}%`} />)}</div>
        <div className="gkm-author"><Skeleton width={27} height={27} circle /><div className="gkm-skeleton-lines"><Skeleton width={90} /><Skeleton width={130} height={9} /></div></div>
        <div className="gkm-reviewed"><Skeleton width={70} /><Skeleton width={82} /></div>
      </div>
      <aside className="gkm-checks"><Skeleton width={58} height={12} />{[0, 1, 2, 3].map(index => <div className="gkm-check" key={index}><Skeleton width={15} height={15} circle /><div className="gkm-skeleton-lines"><Skeleton width={55} height={9} /><Skeleton width={135} /></div></div>)}</aside>
    </div></div>
    <footer className="gkm-detail-foot" aria-hidden="true"><Skeleton width="30%" /><Skeleton width={85} height={32} /></footer>
  </div>;
}

function MergeRequestChangesSkeleton() {
  return <div className="gkm-changes-skeleton" role="status" aria-label={tx("正在加载差异")} aria-busy="true">
    <aside className="gkm-skeleton-files" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map(index => <div className="gkm-skeleton-file" key={index}>
      <Skeleton width={10} height={12} /><div className="gkm-skeleton-lines"><Skeleton width={`${70 - index % 3 * 12}%`} height={12} /><Skeleton width="90%" /></div>
    </div>)}</aside>
    <div className="gkm-skeleton-code"><div className="gkm-skeleton-code-head" aria-hidden="true"><Skeleton width={12} height={12} /><Skeleton width="48%" height={12} /></div>
      <div className="gkm-skeleton-code-stats" aria-hidden="true"><Skeleton width={26} /><Skeleton width={20} /></div>
      <div aria-hidden="true"><CodeSkeleton label={tx("正在加载差异")} rowCount={16} /></div>
    </div>
  </div>;
}

function MergeRequestDiscussionSkeleton() {
  return <div role="status" aria-label={tx("正在加载讨论")} aria-busy="true">{[0, 1, 2].map(index => <article className="gkm-thread" key={index} aria-hidden="true"><div className="gkm-note">
    <Skeleton width={27} height={27} circle /><div><div className="gkm-note-meta"><Skeleton width={75} /><Skeleton width={105} height={9} /></div><div className="gkm-skeleton-lines"><Skeleton width={`${85 - index * 8}%`} /><Skeleton width={`${62 + index * 6}%`} /></div></div>
  </div></article>)}</div>;
}

function DiscussionThread({ discussion, refs, onNavigate, onOpenExternal }: {
  discussion: MrDiscussion; refs: MrDiffVersion["refs"] | null;
  onNavigate: (discussion: MrDiscussion) => void; onOpenExternal: () => void;
}) {
  const position = mrDiscussionDiffPosition(discussion, refs);
  const anchor = position || discussion.notes.find(note => !note.system && note.position?.positionType === "text"
    && (note.position.newLine || note.position.oldLine))?.position;
  const path = anchor && (anchor.newLine !== null ? anchor.newPath : anchor.oldPath);
  const line = anchor?.newLine ?? anchor?.oldLine;
  const navigate = () => position ? onNavigate(discussion) : onOpenExternal();
  return <article className={`gkm-thread${discussion.notes.every(note => note.system) ? " is-system" : ""}`}>
    {path && line && <div className="gkm-thread-location"><button type="button" className="gkm-text-button"
      title={position ? tf("跳转到 {0} 的第 {1} 行", path, line) : tx("在 GitLab 中查看")}
      onClick={navigate}><span>{path}</span><span className="gkm-thread-line">{tf("第 {0} 行", line)}</span>
      {position ? <ArrowRight size={12} aria-hidden="true" /> : <ExternalLink size={12} aria-hidden="true" />}</button></div>}
    {discussion.notes.map(note => <div key={note.id} className={`gkm-note${note.system ? " is-system" : ""}${position && !note.system ? " is-linked" : ""}`}
      role={position && !note.system ? "link" : undefined} tabIndex={position && !note.system ? 0 : undefined}
      onClick={position && !note.system ? () => { if (window.getSelection()?.isCollapsed !== false) navigate(); } : undefined}
      onKeyDown={position && !note.system ? event => { if (event.key === "Enter") { event.preventDefault(); navigate(); } } : undefined}>
      <MergeRequestAvatar user={note.author} size={24} />
      <div><div className="gkm-note-meta"><strong>{note.author.name || note.author.username}</strong><time dateTime={note.createdAt}>{dateLabel(note.createdAt)}</time>
        {note.resolvable && <span className={note.resolved ? "gkm-resolved" : "gkm-unresolved"}>{note.resolved ? <Check size={11} aria-hidden="true" /> : <Clock3 size={11} aria-hidden="true" />}{tx(note.resolved ? "已解决" : "未解决")}</span>}
        {note.system && <span>{tx("系统消息")}</span>}
      </div><div className="gkm-prose">{note.body}</div></div>
    </div>)}
  </article>;
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
  const [present, setPresent] = useState(open);
  const openRef = useRef(open);
  openRef.current = open;
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
    if (open) setPresent(true);
    if (popoverRef.current) popoverRef.current.inert = !open;
  }, [open, present]);

  useEffect(() => {
    if (open || !present) return;
    // Keep the portal for its exit, including entry-toggle and row selection.
    // Reopening cancels this fallback and restores interaction immediately.
    const timer = window.setTimeout(() => {
      if (!openRef.current) setPresent(false);
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);
    return () => window.clearTimeout(timer);
  }, [open, present]);

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
    const place = () => {
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
    };
    const position = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    // Establish the anchor before the entrance's first paint.
    place();
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

  if (!open && !present) return null;
  const filters: Array<[ListFilter, string]> = [["all", "全部"], ["reviewer", "我审核"], ["assignee", "指派给我"], ["author", "我发起"]];
  const configure = onConfigure && <button className="gkm-button gkm-button-primary" type="button" onClick={onConfigure}><KeyRound size={14} aria-hidden="true" />{tx("连接 GitLab 账号")}</button>;
  return createPortal(<div ref={popoverRef} id="gkm-mr-popover" className={`gkm-popover ${open ? "gk-modal-in" : "gk-modal-out"}`}
    style={{ ...themeStyle(theme), pointerEvents: open ? undefined : "none" }} role="dialog" aria-modal={false} aria-hidden={!open || undefined} aria-labelledby="gkm-list-title"
    onAnimationEnd={event => {
      if (!openRef.current && event.currentTarget === event.target && event.animationName === "gk-modal-out") setPresent(false);
    }}>
    <header className="gkm-list-head"><div><h2 id="gkm-list-title">{tx("合并请求")}</h2><p title={snapshot?.instanceUrl ?? undefined}>{tx("所有项目")}{snapshot?.user && ` · @${snapshot.user.username}`}</p></div><button className="gkm-icon-button" type="button" aria-label={tx("刷新合并请求")} title={tx("刷新合并请求")} onClick={refresh} disabled={!configured || busy}><RefreshCw size={15} className={busy ? "gkm-spin" : undefined} aria-hidden="true" /></button><button className="gkm-icon-button" type="button" aria-label={tx("关闭合并请求")} onClick={() => { onClose("button"); anchorRef.current?.focus(); }}><X size={16} aria-hidden="true" /></button></header>
    {configured && hasCache && <div className="gkm-list-count"><span>{tf("{0} 条相关请求", snapshot?.total || 0)}</span>{!!snapshot?.newCount && <strong>{tf("{0} 条新请求", snapshot.newCount)}</strong>}</div>}
    {configured && <div className="gkm-filters" aria-label={tx("按我的角色筛选")}>{filters.map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} className={filter === value ? "is-selected" : ""} onClick={() => setFilter(value)}>{tx(label)}{hasCache && <span>{value === "all" ? items.length : items.filter(item => item.roles.includes(value)).length}</span>}</button>)}</div>}
    <div className="gkm-list-body" ref={listRef} onScroll={event => { scrollPositions.current[filter] = event.currentTarget.scrollTop; }}>
      {!configured ? <EmptyState title={tx("连接账号，查看相关请求")}>{tx("连接 GitLab 账号，同步所有项目中由你审核、指派给你和你发起的合并请求。")}{configure}</EmptyState> : <>
        {failure && <Banner tone="error" action={authError && onConfigure ? <button className="gkm-text-button" type="button" onClick={onConfigure}>{tx("更新凭据")}</button> : undefined}>{translateNativeMessage(failure)}{hasCache && <small>{tx("正在显示上次同步的结果。")}</small>}</Banner>}
        {snapshot?.stale && !failure && <Banner>{tx("缓存可能已过期，刷新后确认最新状态。")}</Banner>}
        {snapshot?.persistenceError && <Banner>{tx("已读记录保存失败，下次启动可能再次显示新提醒。")}</Banner>}
        {!hasCache && busy ? <MergeRequestListSkeleton /> : !hasCache && failure ? <EmptyState title={tx("暂时无法同步")}>{tx("连接恢复后可以重试。")}{configure}</EmptyState> : visible.length === 0 ? <EmptyState title={filter === "all" ? tx("没有相关的开放请求") : tx("这个角色下暂无请求")}>{filter === "all" ? tx("新请求会在这里出现。") : tx("可以切换到全部，查看其他相关请求。")}</EmptyState> : visible.map(item => <MergeRequestRow key={item.id} item={item} unread={!!snapshot?.unseenIds.includes(item.id)} onSelect={onSelect} />)}
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
  onDownloadDiff: (review: MrDetail) => Promise<MrDownloadedDiff | null>;
  onMerge: (options: MrMergeOptions) => Promise<MrMergeResult>;
  onCommitMessages: () => Promise<MrCommitMessages>;
  onCancel: () => Promise<MrActionResult>;
  onApprove: (reviewedSha: string) => Promise<MrActionResult>;
  onParticipantCandidates?: (query: string, page: number) => Promise<MrParticipantCandidates>;
  onUpdateParticipants?: (kind: MrParticipantKind, userIds: number[], expectedUserIds: number[]) => Promise<MrParticipantsResult>;
  onOpenExternal: () => void;
  onBackList: () => void;
  onBackWorkspace: () => void;
  onTabChange: (tab: MergeRequestTab) => void;
  onCreateDiffComment?: (position: MrDiffCommentPosition, body: string) => Promise<MrDiffCommentResult>;
  renderDiff: (files: CommitFile[], selected: CommitFile | null, onSelect: (file: CommitFile | null) => void, sourceKey: string, lineComments?: MrLineCommentActions) => ReactNode;
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

function MergeRequestTabIndicator({ tab }: { tab: MergeRequestTab }) {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<(animate: boolean) => void>(() => {});

  useLayoutEffect(() => {
    const indicator = indicatorRef.current;
    const tablist = indicator?.parentElement;
    if (!indicator || !tablist) return;
    let previous: string | null = null;
    const measure = (animate: boolean) => {
      const selected = tablist.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      if (!selected) return;
      const bounds = selected.getBoundingClientRect();
      const left = bounds.left - tablist.getBoundingClientRect().left;
      const transform = `translateX(${left}px) scaleX(${bounds.width})`;
      if (transform === previous) return;
      indicator.dataset.motion = String(animate && previous !== null);
      indicator.style.transform = transform;
      indicator.style.opacity = "1";
      previous = transform;
    };
    measureRef.current = measure;
    // Mount and geometry changes snap into place; only tab selection travels.
    measure(false);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(tablist);
    tablist.querySelectorAll('[role="tab"]').forEach(button => observer.observe(button));
    return () => { observer.disconnect(); measureRef.current = () => {}; };
  }, []);

  useLayoutEffect(() => { measureRef.current(true); }, [tab]);
  return <span ref={indicatorRef} className="gkm-tab-indicator" aria-hidden="true" />;
}

export function MergeRequestDetail(props: MergeRequestDetailProps) {
  const { theme, detail, latest, snapshot, loading, error, files, diffVersion, diffLoading, diffError, discussions, discussionsLoading, discussionsError, onRefresh, onReviewLatest, onMerge, onCancel, onApprove, onOpenExternal, onBackList, onBackWorkspace, onTabChange, renderDiff } = props;
  const [tab, setTab] = useState<MergeRequestTab>("overview");
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null | undefined>(undefined);
  const [pendingDiscussion, setPendingDiscussion] = useState<MrDiscussion | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const changesRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"detail" | "confirm" | "cancel" | "result">("detail");
  const [squash, setSquash] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [editMessages, setEditMessages] = useState(false);
  const [mergeMessage, setMergeMessage] = useState("");
  const [squashMessage, setSquashMessage] = useState("");
  const [messageDefaults, setMessageDefaults] = useState<MrCommitMessages | null>(null);
  const [messageDefaultsKey, setMessageDefaultsKey] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesRetry, setMessagesRetry] = useState(0);
  const [messageEditorHeight, setMessageEditorHeight] = useState(0);
  const messageEditorRef = useRef<HTMLDivElement>(null);
  const messagesEditedRef = useRef({ merge: false, squash: false });
  const commitMessagesRef = useRef(props.onCommitMessages);
  commitMessagesRef.current = props.onCommitMessages;
  const [actionResult, setActionResult] = useState<MrActionResult | null>(null);
  const [pendingAction, setPendingAction] = useState<"cancel" | "approve" | null>(null);
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
  const messagesReviewKey = `${summary?.id}:${diffVersion?.id ?? (detail ? reviewVersion(detail)?.id : "")}:${reviewedRefs?.baseSha || ""}:${reviewedRefs?.startSha || ""}:${reviewedSha}:${summary?.targetBranch || ""}`;
  const commentFile = diffVersion?.files.find(file => (file.deletedFile ? file.oldPath : file.newPath) === selectedFile?.path);
  const commentDisabledReason = versionChanged ? tx("合并请求版本已变化，请先查看最新改动。")
    : loading || diffLoading ? tx("正在读取差异…")
    : snapshot?.error || snapshot?.stale ? tx("连接或缓存状态异常，请刷新后再评论。") : undefined;
  const lineComments = useMemo<MrLineCommentActions | undefined>(() => commentFile && diffVersion && props.onCreateDiffComment ? {
    oldPath: commentFile.oldPath, newPath: commentFile.newPath, refs: diffVersion.refs, discussions,
    disabledReason: commentDisabledReason, onSubmit: props.onCreateDiffComment, onOpenExternal,
  } : undefined, [commentFile, diffVersion, discussions, commentDisabledReason, props.onCreateDiffComment, onOpenExternal]);
  const diff = useMemo(() => renderDiff(files, selectedFile, file => setSelectedPath(file?.path ?? null), sourceKey, lineComments), [renderDiff, files, selectedFile, sourceKey, lineComments]);
  useLayoutEffect(() => {
    if (!pendingDiscussion || tab !== "changes" || diffLoading) return;
    if (diffError) { setPendingDiscussion(null); return; }
    if (!diffVersion) return;
    const target = mrDiscussionDiffTarget(pendingDiscussion, diffVersion.refs, diffVersion.files);
    const unavailable = () => {
      setNavigationError(tx("该评论对应的代码行未包含在当前差异中，请在 GitLab 中查看。"));
      setPendingDiscussion(null);
    };
    if (!target || !files.some(file => file.path === target.path)) { unavailable(); return; }
    if (selectedFile?.path !== target.path) { setSelectedPath(target.path); return; }
    const { oldLine, newLine } = target.position;
    const selector = `.gk-code-row${oldLine === null ? ":not([data-diff-old-line])" : `[data-diff-old-line="${oldLine}"]`}${newLine === null ? ":not([data-diff-new-line])" : `[data-diff-new-line="${newLine}"]`}`;
    const row = changesRef.current?.querySelector<HTMLElement>(selector);
    if (!row) { unavailable(); return; }
    const hadTabIndex = row.hasAttribute("tabindex");
    if (!hadTabIndex) row.tabIndex = -1;
    row.dataset.discussionTarget = "true";
    row.scrollIntoView({ block: "center", inline: "nearest" });
    row.focus({ preventScroll: true });
    row.addEventListener("blur", () => {
      delete row.dataset.discussionTarget;
      if (!hadTabIndex) row.removeAttribute("tabindex");
    }, { once: true });
    setPendingDiscussion(null);
  }, [pendingDiscussion, tab, diffLoading, diffError, diffVersion, files, selectedFile]);
  const remoteState = actionResult?.state === "closed" && !actionResult.detail ? "closed" : authoritative?.summary.state;
  const alreadyMerged = remoteState === "merged";
  const viewerActions = mrViewerActions(authoritative, snapshot?.user);
  const alreadyApproved = viewerActions.approved || actionResult?.state === "approved" && !actionResult.detail;
  const connectionBlocked = !!error || !!snapshot?.error || !!snapshot?.stale;
  const actionBlocked = connectionBlocked || loading || reviewing || refreshing || needsRecheck || submitting || !!result || actionResult?.state === "uncertain";
  const approvalBlocked = !detail || actionBlocked || alreadyApproved || !viewerActions.canApprove || !reviewedSha || !reviewedRefs || !reviewVersion(detail) || versionChanged || diffLoading;
  const cancelBlocked = actionBlocked || !viewerActions.canCancel;
  const mergeBlocked = !detail || !authoritative?.canMerge || !reviewedSha || !reviewedRefs || !reviewVersion(detail) || versionChanged || actionBlocked || diffLoading || summary?.draft || remoteState !== "opened";
  const downloadUnavailable = versionChanged ? tx("合并请求版本已变化，请先查看最新改动。")
    : connectionBlocked ? tx("连接或缓存状态异常，请刷新后再下载。")
    : loading || reviewing || refreshing ? tx("正在加载合并请求")
    : !detail || !reviewVersion(detail) ? tx("差异版本尚未就绪。") : null;
  const messagesReady = messageDefaultsKey === messagesReviewKey && messageDefaults?.mrId === summary?.id && messageDefaults?.sha === reviewedSha && messageDefaults?.targetBranch === summary?.targetBranch;
  const mergeSubmitBlocked = mergeBlocked || editMessages && (!messagesReady || messagesLoading || !!messagesError);
  const policy = authoritative?.squashPolicy || "default_off";
  const effectiveSquash = policy === "always" ? true : policy === "never" ? false : squash;
  const deleteRequired = !!authoritative?.deleteSourceRequired;
  const deleteAllowed = authoritative?.deleteSourceAllowed === true || deleteRequired;
  const effectiveDelete = deleteRequired || deleteAllowed && deleteSource;

  useLayoutEffect(() => {
    const content = messageEditorRef.current;
    if (!content) return;
    const measure = () => setMessageEditorHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [summary?.id, view, remoteState]);

  useEffect(() => {
    if (!detail) return;
    setSquash(detail.squash);
    setDeleteSource(detail.deleteSourceDefault);
    setMergeMessage(detail.mergeCommitMessage || "");
    setSquashMessage(detail.squashCommitMessage || "");
    messagesEditedRef.current = { merge: false, squash: false };
    setMessageDefaults(null);
    setMessageDefaultsKey(null);
  }, [detail?.summary.id]);

  useEffect(() => {
    if (!editMessages || messagesReady) { setMessagesLoading(false); return; }
    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(null);
    void commitMessagesRef.current().then(defaults => {
      if (cancelled) return;
      setMessageDefaults(defaults);
      setMessageDefaultsKey(messagesReviewKey);
      if (!messagesEditedRef.current.merge) setMergeMessage(defaults.mergeCommitMessage);
      if (!messagesEditedRef.current.squash) setSquashMessage(defaults.squashCommitMessage);
    }).catch(cause => {
      if (!cancelled) setMessagesError(mrErrorMessage(cause));
    }).finally(() => { if (!cancelled) setMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [editMessages, messagesReviewKey, messagesReady, messagesRetry]);

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
  useEffect(() => {
    if (view === "cancel" && cancelBlocked && !submitting) setView("detail");
  }, [view, cancelBlocked, submitting]);

  function changeTab(value: MergeRequestTab) {
    if (value !== "changes") { setPendingDiscussion(null); setNavigationError(null); }
    setTab(value);
    onTabChange(value);
  }

  function navigateDiscussion(discussion: MrDiscussion) {
    setNavigationError(null);
    setPendingDiscussion(discussion);
    changeTab("changes");
  }

  async function refresh() {
    if (refreshing || submitting) return;
    setRefreshing(true);
    setNotice(null);
    try {
      await onRefresh();
      if (aliveRef.current) { setNeedsRecheck(false); setActionResult(null); }
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
    if (mergeSubmitBlocked || !authoritative) return;
    setView("confirm");
    setNotice(null);
  }

  async function submitAction(action: "cancel" | "approve") {
    if (submitRef.current || (action === "cancel" ? cancelBlocked : approvalBlocked)) return;
    submitRef.current = true;
    setSubmitting(true);
    setPendingAction(action);
    setNotice(null);
    setActionResult(null);
    try {
      const next = await (action === "cancel" ? onCancel() : onApprove(reviewedSha));
      if (aliveRef.current) {
        setActionResult(next);
        setNeedsRecheck(next.state === "uncertain" || !next.detail);
        setView("detail");
      }
    } catch (cause) {
      if (aliveRef.current) {
        setNotice(mrErrorMessage(cause));
        setNeedsRecheck(true);
        setView("detail");
      }
    } finally {
      submitRef.current = false;
      if (aliveRef.current) { setSubmitting(false); setPendingAction(null); }
    }
  }

  async function merge() {
    if (submitRef.current || mergeSubmitBlocked) return;
    submitRef.current = true;
    setSubmitting(true);
    setNotice(null);
    try {
      const next = await onMerge({ reviewedSha, squash: effectiveSquash, deleteSource: effectiveDelete,
        mergeCommitMessage: editMessages && messagesEditedRef.current.merge && mergeMessage.trim() ? mergeMessage : undefined,
        squashCommitMessage: editMessages && effectiveSquash && messagesEditedRef.current.squash && squashMessage.trim() ? squashMessage : undefined });
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

  const backButtons = <><button className="gkm-text-button" type="button" onClick={onBackList} disabled={submitting}><ChevronLeft size={14} aria-hidden="true" />{tx("返回列表")}</button><div className="gkm-head-actions"><button className="gkm-button gkm-download-entry" type="button" onClick={() => setDownloadOpen(true)} disabled={!detail || submitting || loading || reviewing || refreshing} aria-haspopup="dialog"><Download size={14} aria-hidden="true" />{tx("下载差异")}</button><button className="gkm-icon-button" type="button" title={tx("在 GitLab 中打开")} aria-label={tx("在 GitLab 中打开")} onClick={onOpenExternal} disabled={!detail}><ExternalLink size={15} aria-hidden="true" /></button><button className="gkm-text-button" type="button" onClick={onBackWorkspace} disabled={submitting}>{tx("返回工作区")}</button></div></>;
  if (!detail) return <section className="gkm-detail" style={themeStyle(theme)} aria-label={tx("合并请求详情")}><div className="gkm-detail-nav">{backButtons}</div>{error ? <><Banner tone="error">{translateNativeMessage(error)}</Banner><EmptyState title={tx("无法加载合并请求")} action={<button className="gkm-button" type="button" onClick={refresh} disabled={refreshing}>{tx("重试")}</button>} /></> : loading ? <MergeRequestDetailSkeleton /> : <EmptyState title={tx("选择一条合并请求")} />}</section>;
  const blockedExplanation = versionChanged ? tx("合并请求版本已变化，请先查看最新改动。") : connectionBlocked ? tx("连接或缓存状态异常，请刷新后再合并。") : needsRecheck ? tx(actionResult && actionResult.state !== "uncertain" ? "请刷新最新状态后继续操作。" : "上次操作失败，请刷新状态后重试。") : !reviewedRefs || !reviewedSha || !reviewVersion(detail) ? tx("差异版本尚未就绪。") : authoritative?.blockedReasons[0] ? translateNativeMessage(authoritative.blockedReasons[0]) : summary!.draft ? tx("草稿暂时无法合并。") : remoteState === "closed" ? tx("这条请求已关闭。") : tx("由 GitLab 校验项目规则与权限");
  const tabs: Array<[MergeRequestTab, string]> = [["overview", "概览"], ["changes", "改动"], ["discussion", "讨论"]];
  const successful = alreadyMerged || result?.state === "merged";
  const controlsDisabled = actionBlocked || versionChanged || remoteState !== "opened";
  const mergeControls = <div className="gkm-merge-controls">
    <div className="gkm-merge-options" role="group" aria-label={tx("合并选项")}>
      <label title={tx(deleteRequired ? "项目要求删除源分支" : !deleteAllowed ? "没有删除源分支的权限" : "合并后删除源分支")}><input type="checkbox" checked={effectiveDelete} disabled={controlsDisabled || deleteRequired || !deleteAllowed} onChange={event => setDeleteSource(event.target.checked)} /><span>{tx("删除源分支")}</span></label>
      <label title={tx(policy === "always" ? "项目要求压缩提交" : policy === "never" ? "项目禁止压缩提交" : "将本次改动整理为一个提交")}><input type="checkbox" checked={effectiveSquash} disabled={controlsDisabled || policy === "always" || policy === "never"} onChange={event => setSquash(event.target.checked)} /><span>{tx("压缩提交")}</span></label>
      <label><input type="checkbox" checked={editMessages} disabled={controlsDisabled} aria-controls="gkm-commit-messages" aria-expanded={editMessages} onChange={event => setEditMessages(event.target.checked)} /><span>{tx("编辑提交消息")}</span></label>
    </div>
    <div id="gkm-commit-messages" className="gkm-commit-editor" data-open={editMessages} style={{ height: editMessages ? messageEditorHeight : 0 }} aria-hidden={!editMessages} ref={element => { if (element) element.inert = !editMessages; }}>
      <div ref={messageEditorRef} className="gkm-commit-editor-content">
      {messagesLoading && <div className="gkm-sha-check" role="status"><LoaderCircle className="gkm-spin" size={13} aria-hidden="true" />{tx("正在读取默认提交消息…")}</div>}
      {messagesError && <Banner tone="error" action={<button className="gkm-text-button" type="button" onClick={() => setMessagesRetry(value => value + 1)}>{tx("重试")}</button>}>{translateNativeMessage(messagesError)}</Banner>}
      <div className="gkm-commit-messages" aria-busy={messagesLoading}>
        <label><span>{tx("合并提交消息")}</span><textarea rows={4} value={mergeMessage} disabled={!editMessages || controlsDisabled || !messagesReady || messagesLoading || !!messagesError} placeholder={tx("留空则使用 GitLab 默认消息")} onChange={event => { messagesEditedRef.current.merge = true; setMergeMessage(event.target.value); }} /></label>
        {effectiveSquash && <label><span>{tx("压缩提交消息")}</span><textarea rows={4} value={squashMessage} disabled={!editMessages || controlsDisabled || !messagesReady || messagesLoading || !!messagesError} placeholder={tx("留空则使用 GitLab 默认消息")} onChange={event => { messagesEditedRef.current.squash = true; setSquashMessage(event.target.value); }} /></label>}
      </div>
      </div>
    </div>
  </div>;
  return <section className="gkm-detail" style={themeStyle(theme)} aria-labelledby="gkm-detail-title">
    <div className="gkm-detail-nav">{backButtons}</div>
    <header className="gkm-detail-head"><div className="gkm-detail-kicker"><GitPullRequest size={15} aria-hidden="true" /><span className="gkm-detail-project" title={summary!.projectPathWithNamespace}>{summary!.projectPathWithNamespace}</span><span>!{summary!.iid}</span><span className="gkm-tag">{tx(alreadyMerged ? "已合并" : remoteState === "closed" ? "已关闭" : summary!.draft ? "草稿" : "开放")}</span>{summary!.roles.map(role => <span className="gkm-role" key={role}>{roleLabel(role)}</span>)}</div><h2 ref={titleRef} tabIndex={-1} id="gkm-detail-title">{summary!.title}</h2><div className="gkm-detail-branches"><code title={summary!.sourceBranch}>{summary!.sourceBranch}</code><ArrowRight size={13} aria-hidden="true" /><code title={summary!.targetBranch}>{summary!.targetBranch}</code><span>{tf("由 {0} 发起", summary!.author.name || summary!.author.username)}</span></div></header>
    {error && <Banner tone="error">{translateNativeMessage(error)}</Banner>}
    {snapshot?.error && !error && <Banner tone="error">{translateNativeMessage(snapshot.error.message)}</Banner>}
    {snapshot?.stale && !snapshot.error && <Banner>{tx("缓存可能已过期，刷新后确认最新状态。")}</Banner>}
    {notice && <Banner tone="error">{translateNativeMessage(notice)}</Banner>}
    {actionResult && <Banner tone={actionResult.state === "uncertain" ? "warning" : "info"} action={actionResult.state === "uncertain" || !actionResult.detail ? <button className="gkm-text-button" type="button" onClick={refresh} disabled={refreshing}>{tx("刷新状态")}</button> : undefined}>{translateNativeMessage(actionResult.message)}</Banner>}
    {versionChanged && !successful && <Banner action={<button className="gkm-text-button" type="button" onClick={reviewLatest} disabled={reviewing || submitting}>{reviewing && <LoaderCircle className="gkm-spin" size={13} />}{tx("查看最新改动")}</button>}>{tx("合并请求有变化，当前差异仍保留你正在查看的版本。")}</Banner>}
    {view === "cancel" ? <>
      <div className="gkm-confirm"><div className="gkm-confirm-icon"><X size={24} aria-hidden="true" /></div><h3>{tf("取消合并请求 !{0}？", summary!.iid)}</h3><p>{tx("这条请求将在 GitLab 中关闭，源分支和提交会保留。")}</p><dl className="gkm-confirm-summary"><div><dt>{tx("项目")}</dt><dd>{summary!.projectPathWithNamespace}</dd></div><div><dt>{tx("源分支")}</dt><dd>{summary!.sourceBranch}</dd></div><div><dt>{tx("目标分支")}</dt><dd>{summary!.targetBranch}</dd></div></dl></div>
      <footer className="gkm-detail-foot"><span>{tx("以 GitLab 实际状态为准")}</span><div className="gkm-foot-actions"><button className="gkm-button" type="button" onClick={() => setView("detail")} disabled={submitting}>{tx("返回详情")}</button><button className="gkm-button gkm-button-danger" type="button" onClick={() => void submitAction("cancel")} disabled={cancelBlocked}>{submitting ? <LoaderCircle className="gkm-spin" size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />}{tx(submitting ? "正在取消…" : "确认取消")}</button></div></footer>
    </> : view === "confirm" ? <>
      <div className="gkm-confirm"><div className="gkm-confirm-icon"><GitMerge size={24} aria-hidden="true" /></div><h3>{tf("将 !{0} 合并到 {1}", summary!.iid, summary!.targetBranch)}</h3><p>{tx("提交后，GitLab 将按项目规则执行合并。")}</p><dl className="gkm-confirm-summary"><div><dt>{tx("项目")}</dt><dd>{summary!.projectPathWithNamespace}</dd></div><div><dt>{tx("源分支")}</dt><dd>{summary!.sourceBranch}</dd></div><div><dt>{tx("目标分支")}</dt><dd>{summary!.targetBranch}</dd></div><div><dt>{tx("当前查看的版本")}</dt><dd><code title={reviewedSha}>{reviewedSha.slice(0, 12)}</code></dd></div></dl>
        {mergeControls}<div className="gkm-sha-check"><ShieldCheck size={15} aria-hidden="true" />{tx("合并时再次核对源版本与权限")}</div>
      </div><footer className="gkm-detail-foot"><span>{tx("不会自动更新本地仓库")}</span><div className="gkm-foot-actions"><button className="gkm-button" type="button" onClick={() => setView("detail")} disabled={submitting}>{tx("返回详情")}</button><button className="gkm-button gkm-button-primary" type="button" onClick={merge} disabled={mergeSubmitBlocked}>{submitting ? <LoaderCircle className="gkm-spin" size={14} /> : <GitMerge size={14} />}{tx(submitting ? "正在提交…" : "确认合并")}</button></div></footer>
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
      }}>{tabs.map(([value, label]) => <button type="button" role="tab" key={value} id={`gkm-tab-${value}`} aria-controls={`gkm-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => changeTab(value)}>{tx(label)}{value === "changes" && files.length > 0 && <span>{files.length}</span>}</button>)}<button className="gkm-icon-button gkm-tabs-refresh" type="button" onClick={refresh} disabled={refreshing || loading} title={tx("刷新状态")} aria-label={tx("刷新状态")}><RefreshCw size={14} className={refreshing || loading ? "gkm-spin" : undefined} aria-hidden="true" /></button><MergeRequestTabIndicator tab={tab} /></div>
      <div className="gkm-detail-panels">
        <div className="gkm-panel gkm-overview" id="gkm-panel-overview" role="tabpanel" aria-labelledby="gkm-tab-overview" hidden={tab !== "overview"}><div className="gkm-description"><h3>{tx("说明")}</h3>{detail.description ? <div className="gkm-prose">{detail.description}</div> : <p className="gkm-muted">{tx("这条请求没有填写说明。")}</p>}<div className="gkm-author"><MergeRequestAvatar user={summary!.author} /><div>{summary!.author.name || summary!.author.username}<small>{tf("最后更新 {0}", dateLabel(summary!.updatedAt))}</small></div></div><div className="gkm-reviewed">{tx("当前查看的版本")}<code title={reviewedSha}>{reviewedSha ? reviewedSha.slice(0, 12) : tx("尚未就绪")}</code></div></div>
          <aside className="gkm-checks">
            {authoritative && props.onParticipantCandidates && props.onUpdateParticipants && <MergeRequestParticipants theme={theme} style={themeStyle(theme)} detail={authoritative} viewer={snapshot?.user || null}
              disabled={actionBlocked} onCandidates={props.onParticipantCandidates} onUpdate={props.onUpdateParticipants}
              onRefresh={async () => { await onRefresh(); setNeedsRecheck(false); setActionResult(null); setNotice(null); }}
              onBusyChange={setSubmitting} onNeedsRecheck={() => setNeedsRecheck(true)} />}
            <h3>{tx("合并条件")}</h3><CheckRow label={tx("流水线")} good={authoritative?.pipelineStatus === "success"} unknown={!authoritative?.pipelineStatus || ["running", "pending", "preparing", "created", "scheduled"].includes(authoritative.pipelineStatus)}>{statusLabel(authoritative?.pipelineStatus || null)}</CheckRow><CheckRow label={tx("审批")} good={authoritative?.approvals.approved === true || authoritative?.approvals.approvalsRequired === 0} unknown={!authoritative?.approvals.readable || authoritative.approvals.approved === null}>{!authoritative?.approvals.readable ? tx("审批信息不可读") : authoritative.approvals.approvalsLeft && authoritative.approvals.approvalsLeft > 0 ? tf("还需 {0} 次审批", authoritative.approvals.approvalsLeft) : authoritative.approvals.approved === true ? tx("已通过") : authoritative.approvals.approvalsRequired === 0 ? tx("无需审批") : tx("等待审批")}</CheckRow><CheckRow label={tx("讨论")} good={authoritative?.blockingDiscussionsResolved === true} unknown={authoritative?.blockingDiscussionsResolved === null}>{authoritative?.blockingDiscussionsResolved === true ? tx("阻塞讨论已解决") : authoritative?.blockingDiscussionsResolved === false ? tx("仍有未解决的讨论") : tx("讨论状态未知")}</CheckRow><CheckRow label={tx("合并权限与规则")} good={authoritative?.canMerge === true && remoteState === "opened"} unknown={!authoritative?.summary.detailedMergeStatus}>{authoritative?.canMerge && remoteState === "opened" ? tx("GitLab 允许合并") : tx("暂时无法合并")}</CheckRow>{authoritative?.blockedReasons.length ? <ul className="gkm-blocked-reasons">{authoritative.blockedReasons.map((reason, index) => <li key={index}>{translateNativeMessage(reason)}</li>)}</ul> : null}<p className="gkm-check-note">{tx("权限、审批、CI 和冲突均以 GitLab 为准。")}</p></aside>
        </div>
        <div ref={changesRef} className="gkm-panel gkm-changes" id="gkm-panel-changes" role="tabpanel" aria-labelledby="gkm-tab-changes" hidden={tab !== "changes"}>{navigationError && <Banner action={<button className="gkm-text-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中查看")}</button>}>{navigationError}</Banner>}{diffError && <Banner tone="error" action={<button type="button" className="gkm-text-button" onClick={() => onTabChange("changes")}>{tx("重试")}</button>}>{translateNativeMessage(diffError)}</Banner>}{diffVersion?.truncated && <Banner action={<button className="gkm-text-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中查看")}</button>}>{tx("GitLab 未返回完整差异，请在网页中继续查看。")}</Banner>}{diffLoading && files.length === 0 ? <MergeRequestChangesSkeleton /> : files.length ? <div className="gkm-diff">{diff}</div> : !diffError && <EmptyState title={tx("没有可显示的文件差异")} action={<button className="gkm-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中查看")}</button>} />}</div>
        <div className="gkm-panel gkm-discussions" id="gkm-panel-discussion" role="tabpanel" aria-labelledby="gkm-tab-discussion" hidden={tab !== "discussion"}>
          <div className="gkm-discussion-list">
            {discussionsError && <Banner tone="error" action={<button className="gkm-text-button" type="button" onClick={() => onTabChange("discussion")}>{tx("重试")}</button>}>{translateNativeMessage(discussionsError)}</Banner>}
            {discussionsLoading && discussions.length === 0 ? <MergeRequestDiscussionSkeleton /> : discussions.length ? discussions.map(discussion => <DiscussionThread key={discussion.id}
              discussion={discussion} refs={reviewedRefs} onNavigate={navigateDiscussion} onOpenExternal={onOpenExternal} />) : !discussionsError && <EmptyState title={tx("暂无讨论")} />}
          </div>
          <footer className="gkm-discussion-note"><span>{tx("回复和解决讨论请在 GitLab 中操作。")}</span><button className="gkm-text-button" type="button" onClick={onOpenExternal}>{tx("在 GitLab 中打开")}<ExternalLink size={12} aria-hidden="true" /></button></footer>
        </div>
      </div>
      <footer className="gkm-detail-foot gkm-detail-foot-main">{remoteState === "opened" && mergeControls}<div className="gkm-foot-row"><span className="gkm-foot-hint">{mergeBlocked ? <AlertCircle size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}{blockedExplanation}</span><div className="gkm-foot-actions">
        {remoteState === "opened" && viewerActions.showCancel && <button type="button" className="gkm-button" onClick={() => { if (!cancelBlocked) { setNotice(null); setView("cancel"); } }} disabled={cancelBlocked} title={tx("取消合并请求")}>{tx("取消")}</button>}
        {remoteState === "opened" && viewerActions.showApprove && <button type="button" className="gkm-button" onClick={() => void submitAction("approve")} disabled={approvalBlocked} title={alreadyApproved ? tx("你已批准这条请求") : !authoritative?.canApprove ? tx("GitLab 暂不允许当前账号批准，请刷新状态或在 GitLab 中查看。") : versionChanged ? tx("合并请求版本已变化，请先查看最新改动。") : tx("批准当前查看的版本")}>{pendingAction === "approve" ? <LoaderCircle className="gkm-spin" size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{tx(pendingAction === "approve" ? "正在批准…" : alreadyApproved ? "已批准" : "批准")}</button>}
        <button type="button" className="gkm-button gkm-button-primary" onClick={beginMerge} disabled={mergeSubmitBlocked}><GitMerge size={14} aria-hidden="true" />{tx("合并请求")}</button>
      </div></div></footer>
    </>}
    <DialogPresence>{downloadOpen ? <MergeRequestDownload theme={theme} style={themeStyle(theme)} detail={detail} unavailable={downloadUnavailable} onDownload={props.onDownloadDiff} onClose={() => setDownloadOpen(false)} /> : null}</DialogPresence>
  </section>;
}
