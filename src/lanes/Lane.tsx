import { memo, useCallback } from "react";
import type { CSSProperties } from "react";
import { Check, ChevronRight, CornerDownRight, GitMerge, FilePenLine, GitBranchPlus, GitPullRequest, GitPullRequestArrow, Undo2 } from "lucide-react";
import { branchColor } from "../git";
import { getLanguage, tf, tx } from "../i18n";
import { parseMerge, shortDate } from "./commitLabel";
import { LaneCapsule } from "./LaneCapsule";
import type { LaneFlowStep, LaneView } from "./laneLayout";
import type { LaneCommit } from "./stackModel";
import type { LaneHandlers, LaneProps, LaneRequest, LaneWorkingFile, Slot } from "./types";
import { relTime } from "./util";
import "./lane-request.css";

export function StageMessage({ title, detail, action }: { title: string; detail?: string; action?: { label: string; onClick: () => void } }) {
  return <div className="lk-message">
    <strong>{title}</strong>
    {detail && <p>{detail}</p>}
    {action && <button type="button" className="lk-button" onClick={action.onClick}>{action.label}</button>}
  </div>;
}

export function EmptyLane({ first, trunk, onCreate }: { first: boolean; trunk: string; onCreate: () => void }) {
  return <div className="lk-empty-lane">
    {first && <>
      <GitBranchPlus size={22} aria-hidden="true" />
      <p>{tf("从 {0} 开一条新分支", trunk)}<br />{tx("它会出现在最左边")}</p>
      <button type="button" className="lk-button" onClick={onCreate}>{tx("新建分支")}</button>
    </>}
  </div>;
}

export const Lane = memo(function Lane({ model, view, slot, index, focused, current, working, changes, request, createRequestLabel, requestDrag, handlers }: LaneProps) {
  const key = slot.key;
  const pick = useCallback((branch: string) => handlers.onPick(key, branch), [handlers, key]);
  const style = { "--lk-branch": branchColor(view.id) } as CSSProperties;

  return <section className="lk-lane" data-lane-id={view.id} aria-label={view.id}>
    <div className="lk-lane-top" onPointerDown={(e) => handlers.onDragStart(e, slot.key)}
      onContextMenu={(e) => handlers.onContextMenu(e, { kind: "branch", branch: view.id, slotKey: slot.key })}
      title={tx("拖动以调整区域顺序")}>
      <LaneCapsule model={model} branch={view.id} role={view.role} index={index}
        laneIndex={handlers.laneIndex} current={current} onPick={pick} />
    </div>
    <div className="lk-deck">
      <article className="lk-card" data-lane-card={view.id} data-branch={view.id}
        data-focused={focused || undefined} style={style}
        onPointerEnter={() => handlers.onHover(view.id)} onPointerLeave={() => handlers.onHover(null)}>
        <CardHeader view={view} slotKey={slot.key} current={current} request={request}
          sequential={model.longLived.length >= 2} requestDrag={requestDrag}
          createRequestLabel={createRequestLabel} handlers={handlers} />
        <div className="lk-card-body" data-lane-scroll={view.id}>
          {working.length > 0 &&
            <WorkingArea working={working} changes={changes} onOpen={handlers.onOpenChanges} />}
          {view.rows.length > 0
            ? <CommitList commits={view.rows} hidden={view.hidden} branch={view.id} onOpen={handlers.onOpenCommit}
              onMenu={handlers.onContextMenu} />
            : <div className="lk-card-empty">{view.merged
              ? tf("内容和 {0} 一致，没有未合并的提交", model.trunk)
              : view.empty
              ? tf("和 {0} 没有差异，可能已合并或刚创建", model.trunk)
              : tx("还没有自己的提交")}</div>}
          {!view.isTrunk && view.fork && <ForkMarker branch={view.id} fork={view.fork} trunk={model.trunk} longLived={view.longLived} />}
        </div>
      </article>
    </div>
  </section>;
});

const CardHeader = memo(function CardHeader({ view, slotKey, current, request, createRequestLabel, sequential, requestDrag, handlers }: {
  view: LaneView; slotKey: Slot["key"]; current?: string; handlers: LaneHandlers;
  request?: LaneRequest; createRequestLabel?: string; sequential: boolean; requestDrag?: LaneProps["requestDrag"];
}) {
  const { id, branch, isTrunk, role, rows, hidden } = view;
  const isCurrent = current === id;
  const roleLabel = role === "parent" && current ? tf("{0} 的基础分支", current)
    : role === "recent" ? tx("最近修改")
    : role === "pinned" ? tx("已固定")
    : role === "named" && !isTrunk ? tx("默认展示") : null;
  const lastCommit = rows[0];
  const mergedAt = view.merged ? view.flow.find((s) => s.merge && view.fork && s.into === view.fork.base)?.merge : undefined;
  const checkoutLabel = tx("切换到此分支");
  const createLabel = tf("基于 {0} 新建分支", id);

  return <header className="lk-card-head" onClick={() => handlers.onFocus(slotKey, id)}
    onContextMenu={(e) => handlers.onContextMenu(e, { kind: "branch", branch: id, slotKey })}>
    <div className="lk-card-title">
      <button type="button" className="lk-card-branch" data-drag={requestDrag}
        title={requestDrag === "ready" ? `${id}\n${tx("拖到其他分支上，创建合并请求")}`
          : requestDrag === "unpushed" ? `${id}\n${tx("推送后可拖到其他分支上创建合并请求")}` : id}
        onPointerDown={requestDrag ? (e) => handlers.onRequestDragStart(e, id) : undefined}>
        <span className="lk-dot" aria-hidden="true" />
        <span className="lk-card-name">{id}</span>
      </button>
      <div className="lk-card-actions">
        {!isCurrent && <button type="button" className="lk-icon-button" title={checkoutLabel} aria-label={checkoutLabel}
          onClick={(e) => { e.stopPropagation(); handlers.onCheckout(id); }}><Undo2 size={14} aria-hidden="true" /></button>}
        <button type="button" className="lk-chip-button" title={createLabel} aria-label={createLabel}
          onClick={(e) => { e.stopPropagation(); handlers.onCreateFrom(slotKey, id); }}>
          <GitBranchPlus size={13} aria-hidden="true" />{tx("新建分支")}
        </button>
        {!request && createRequestLabel &&
          <button type="button" className="lk-icon-button lk-request-create"
            title={createRequestLabel} aria-label={createRequestLabel}
            onClick={(e) => { e.stopPropagation(); handlers.onCreateRequest(id); }}>
            <GitPullRequestArrow size={14} aria-hidden="true" />
          </button>}
      </div>
    </div>
    <div className="lk-card-sub">
      {isCurrent && <span className="lk-tag lk-tag-current">{tx("当前")}</span>}
      {isTrunk && <span className="lk-tag">{tx("主干")}</span>}
      {view.longLived && !isTrunk && <span className="lk-tag" title={tx("会合入其他分支的长期分支，例如测试、预发环境")}>{tx("长期分支")}</span>}
      {view.merged && <span className="lk-tag lk-tag-ok" title={tf("最新提交已合并到 {0}", view.fork?.base ?? "")}>{tx("已合并")}</span>}
      {!branch.upstream && !isTrunk && <span className="lk-tag">{tx("未推送")}</span>}
      {branch.ahead > 0 && <span className="lk-tag">↑{branch.ahead}</span>}
      {branch.behind > 0 && <span className="lk-tag lk-tag-warn">↓{branch.behind}</span>}
      {request && <RequestChip request={request} branch={id} onOpen={handlers.onOpenRequest} />}
      {roleLabel && <span className="lk-card-role" title={roleLabel}>{roleLabel}</span>}
    </div>
    {view.flow.length > 0 && <MergeFlow lane={id} steps={view.flow} sequential={sequential} handlers={handlers} />}
    <div className="lk-card-meta">
      <span>{tf("{0} 个提交", rows.length + hidden)}</span>
      {mergedAt
        ? <time dateTime={mergedAt.date}>{tf("{0}合并到 {1}", relTime(mergedAt.date), mergedAt.into)}</time>
        : lastCommit && <time dateTime={lastCommit.date}>{relTime(lastCommit.date)}</time>}
    </div>
  </header>;
});

/** "Merged into test ✓ › pre ✓ › master ○" — where this branch's work has gone. */
function MergeFlow({ lane, steps, sequential, handlers }: {
  lane: string; steps: LaneFlowStep[]; sequential: boolean; handlers: LaneHandlers;
}) {
  return <div className="lk-flow" role="group" aria-label={tx("合入进度")} onClick={(e) => e.stopPropagation()}>
    <span className="lk-flow-label">{tx("合入")}</span>
    {steps.map(({ into, merge }, i) => {
      const state = !merge ? "todo" : merge.stale ? "stale" : "done";
      const title = !merge ? tf("还没合入 {0}", into)
        : merge.stale ? tf("{0} 里是旧版本（{1}），之后的提交还没合入", into, merge.hash.slice(0, 7))
        : tf("已合入 {0} · {1} · {2}", into, merge.hash.slice(0, 7), relTime(merge.date));
      return <span key={into} className="lk-flow-item">
        {i > 0 && (sequential ? <ChevronRight size={11} className="lk-flow-sep" aria-hidden="true" />
          : <span className="lk-flow-sep" aria-hidden="true">·</span>)}
        <button type="button" className="lk-flow-step" data-flow-step={into} data-state={state} title={title} aria-label={title}
          style={{ "--lk-step": branchColor(into) } as CSSProperties}
          onPointerEnter={() => merge && handlers.onHoverCommit(merge.hash)} onPointerLeave={() => handlers.onHoverCommit(null)}
          onClick={() => handlers.onRevealMerge(lane, into, merge?.hash)}>
          <span className="lk-flow-dot" data-link-dot>{state !== "todo" && <Check size={8} strokeWidth={3.5} aria-hidden="true" />}</span>
          <span className="lk-flow-name">{into}</span>
        </button>
      </span>;
    })}
  </div>;
}

function pipelineMark(status: LaneRequest["pipeline"]) {
  switch (status) {
    case "success": return { tone: "ok", label: tx("已通过") };
    case "failed": return { tone: "error", label: tx("失败") };
    case "running": return { tone: "busy", label: tx("运行中") };
    case "pending":
    case "created":
    case "preparing":
    case "waiting_for_resource": return { tone: "busy", label: tx("等待中") };
    case "canceled": return { tone: "muted", label: tx("已取消") };
    case "skipped": return { tone: "muted", label: tx("已跳过") };
    default: return null;
  }
}

function mergeMark(status: LaneRequest["mergeStatus"]) {
  switch (status) {
    case "conflict":
    case "broken_status":
    case "need_rebase": return { tone: "error", label: tx("冲突") };
    case "not_approved":
    case "approvals_syncing": return { tone: "muted", label: tx("等待审批") };
    case "mergeable": return { tone: "ok", label: tx("可以合并") };
    default: return null;
  }
}

function RequestChip({ request, branch, onOpen }: {
  request: LaneRequest; branch: string; onOpen: LaneHandlers["onOpenRequest"];
}) {
  const pipeline = request.provider === "gitlab" ? pipelineMark(request.pipeline) : null;
  const merge = mergeMark(request.mergeStatus);
  const draft = request.draft ? tx("草稿") : null;
  const pipelineLabel = pipeline && tf("流水线：{0}", pipeline.label);
  const label = [draft, request.label, pipelineLabel, merge?.label].filter(Boolean).join(" · ");

  return <button type="button" className="lk-tag lk-request-chip"
    title={`${request.title} → ${request.target}`} aria-label={label}
    onClick={(e) => { e.stopPropagation(); onOpen(branch); }}>
    {draft && <span className="lk-request-muted">{draft}</span>}
    <GitPullRequest size={11} aria-hidden="true" />
    <span>{request.label}</span>
    {pipeline && <span className={`lk-request-pipeline lk-request-${pipeline.tone}`}
      title={pipelineLabel ?? undefined} aria-hidden="true">
      {pipeline.tone === "ok" && <Check size={8} strokeWidth={3} />}
    </span>}
    {merge && <span className={`lk-request-merge lk-request-${merge.tone}`} title={merge.label} aria-hidden="true">
      {merge.tone === "ok" ? <Check size={11} /> : merge.label}
    </span>}
  </button>;
}

const WORKING_LIMIT = 8;
const STATUS_LETTER: Record<LaneWorkingFile["status"], string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "?", conflicted: "!",
};

const WorkingArea = memo(function WorkingArea({ working, changes, onOpen }: {
  working: LaneWorkingFile[]; changes: number; onOpen: LaneHandlers["onOpenChanges"];
}) {
  const more = working.length - WORKING_LIMIT;

  return <section className="lk-working">
    <div className="lk-working-head">
      <FilePenLine size={14} aria-hidden="true" />
      <span>{tf("{0} 个未提交的改动", changes)}</span>
      <button type="button" className="lk-chip-button" onClick={() => onOpen()}>{tx("查看并提交")}</button>
    </div>
    <ul className="lk-working-files">
      {working.slice(0, WORKING_LIMIT).map((file) => {
        const slash = file.path.lastIndexOf("/");
        const name = file.path.slice(slash + 1);
        const directory = file.path.slice(0, slash);
        return <li key={file.path}>
          <button type="button" className="lk-working-file" title={file.path} onClick={() => onOpen(file.path)}>
            <span className="lk-working-status" data-status={file.status}>{STATUS_LETTER[file.status]}</span>
            <span className="lk-working-name">{name}</span>
            {slash >= 0 && <span className="lk-working-directory">{directory}</span>}
            {file.staged && <span className="lk-working-staged" title={tx("已暂存")}>
              <Check size={12} aria-hidden="true" /><span>{tx("已暂存")}</span>
            </span>}
          </button>
        </li>;
      })}
      {more > 0 && <li><button type="button" className="lk-working-file lk-working-more"
        aria-label={tf("还有 {0} 个文件", more)} onClick={() => onOpen()}>+{more}</button></li>}
    </ul>
  </section>;
});

const CommitList = memo(function CommitList({ commits, hidden, branch, onOpen, onMenu }: {
  commits: LaneCommit[]; hidden: number; branch: string; onOpen: LaneHandlers["onOpenCommit"];
  onMenu: LaneHandlers["onContextMenu"];
}) {
  const locale = getLanguage() === "en" ? "en-US" : "zh-CN";
  const now = new Date();
  return <ol className="lk-commits">
    {commits.map((c) => {
      const merge = c.parents.length > 1 ? parseMerge(c.message) : null;
      return <li key={c.hash} data-commit-hash={c.hash} className="lk-commit" title={`${c.short} · ${c.message}`}
        data-merge={merge ? true : undefined}
        role="button" tabIndex={0} onClick={() => onOpen(c.hash)}
        onContextMenu={(e) => onMenu(e, { kind: "commit", hash: c.hash, lane: branch })}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(c.hash); } }}>
        <span className="lk-rail" aria-hidden="true"><i /></span>
        {merge ? <MergeLine source={merge.source} target={merge.target ?? branch} />
          : <span className="lk-commit-msg">{c.message}</span>}
        <time className="lk-commit-date" dateTime={c.date}>{shortDate(c.date, now, locale)}</time>
        <span className="lk-avatar" style={{ background: c.color }} title={c.author}>{c.initials}</span>
      </li>;
    })}
    {hidden > 0 && <li className="lk-commit-more">{tf("还有 {0} 个提交", hidden)}</li>}
  </ol>;
});

/** A merge commit as "source → target", each in its branch colour. */
function MergeLine({ source, target }: { source: string; target: string }) {
  return <span className="lk-commit-msg lk-merge-line" aria-label={tf("合并 {0} 到 {1}", source, target)}>
    <GitMerge size={12} aria-hidden="true" className="lk-merge-icon" />
    <span className="lk-merge-branch lk-merge-source" style={{ "--lk-branch": branchColor(source) } as CSSProperties}>{source}</span>
    <span className="lk-merge-arrow" aria-hidden="true">→</span>
    <span className="lk-merge-branch lk-merge-target" style={{ "--lk-branch": branchColor(target) } as CSSProperties}>{target}</span>
  </span>;
}

const ForkMarker = memo(function ForkMarker({ branch, fork, trunk, longLived }: {
  branch: string; fork: NonNullable<LaneView["fork"]>; trunk: string; longLived: boolean;
}) {
  const { base, hash, behind, explicit } = fork;
  const [before, after] = tx("从 {0} 分出").split("{0}");

  return <div className="lk-fork" data-fork-anchor={branch}>
    <CornerDownRight size={13} aria-hidden="true" />
    <span className="lk-fork-origin" title={tf("从 {0} 分出", base)}>
      {before}<b style={{ color: base === trunk ? undefined : branchColor(base) }}>{base}</b>{after}
    </span>
    {hash && <code title={hash}>{hash.slice(0, 7)}</code>}
    {/* A long-lived branch is never "behind" its base in a way worth flagging. */}
    {behind !== null && !longLived && (behind > 0
      ? <span className="lk-tag lk-tag-warn" title={tf("{0} 在分叉之后又有 {1} 个新提交", base, behind)}>{tf("落后 {0}", behind)}</span>
      : <span className="lk-tag lk-tag-ok">{tx("最新")}</span>)}
    {explicit && <span className="lk-fork-note" title={tx("创建时记录的基础分支")}>{tx("已记录")}</span>}
  </div>;
});
