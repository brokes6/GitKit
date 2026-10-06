import { useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { ChevronRight, CircleAlert, FolderGit2, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { Project } from "./App";
import { getCurrentLanguage, tf, tx } from "./i18n";
import { activityIntensity, activityKeyboardIndex, aggregateProjectActivity } from "./projectActivity";
import type { ActivityDay } from "./projectActivity";
import type { useProjectActivity } from "./useProjectActivity";

interface WorkspaceActivityProps {
  projects: Project[];
  activity: ReturnType<typeof useProjectActivity>;
  onOpen: (project: Project, target: "history") => void;
}

export function WorkspaceActivity({ projects, activity, onOpen }: WorkspaceActivityProps) {
  const { entries, window, hasIdentities } = activity;
  const refreshing = hasIdentities && (activity.refreshing || projects.some((project) => entries[project.id]?.checking));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Retain the last day's content while its detail panel closes.
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [keyboardKey, setKeyboardKey] = useState<string | null>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  // Project labels and branch updates do not change the set of commits.
  const cohortKey = JSON.stringify(projects.map(({ id }) => ({ id })));
  const data = useMemo(() => aggregateProjectActivity(JSON.parse(cohortKey), entries, window), [cohortKey, entries, window]);
  const locale = getCurrentLanguage() === "en" ? "en-US" : "zh-CN";
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }), [locale]);
  const monthFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const failed = projects.filter((project) => entries[project.id]?.error != null);
  const loadedCount = projects.filter((project) => entries[project.id]?.summary && entries[project.id].error === null).length;
  const checkedAt = projects.reduce<number | null>((oldest, project) => {
    const entry = entries[project.id];
    const value = entry?.error === null ? entry.summary?.checkedAt : undefined;
    return value ? Math.min(oldest ?? value, value) : oldest;
  }, null);
  const incomplete = hasIdentities && (refreshing || failed.length > 0 || loadedCount < projects.length);
  const available = !hasIdentities || loadedCount > 0;
  const loading = refreshing && !available;
  const selectedDay = data.days.find((day) => day.key === selectedKey);
  const detailDay = selectedDay ?? data.days.find((day) => day.key === detailKey);
  const previewDay = data.days.find((day) => day.key === (hoveredKey ?? focusedKey ?? selectedKey));
  const tabKey = data.days.some((day) => day.key === keyboardKey) ? keyboardKey : data.days[data.days.length - 1]?.key;
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const detailProjects = detailDay?.projects.flatMap((value) => {
    const project = projectsById.get(value.id);
    return project ? [{ project, count: value.count }] : [];
  }) ?? [];
  const sharedCommits = detailProjects.reduce((total, value) => total + value.count, 0) > (detailDay?.count ?? 0);
  const describeDay = (day: ActivityDay) => !available
    ? tf("{0}：提交活动尚未读取", dateFormatter.format(day.date))
    : incomplete
      ? tf("{0}：已读取 {1} 个提交，统计尚不完整", dateFormatter.format(day.date), numberFormatter.format(day.count))
      : tf("{0}：{1} 个提交", dateFormatter.format(day.date), numberFormatter.format(day.count));
  const navigateDay = (event: KeyboardEvent<HTMLButtonElement>, day: ActivityDay) => {
    const index = data.days.findIndex((value) => value.key === day.key);
    const next = activityKeyboardIndex(index, event.key, data.days.length);
    if (next === null) return;
    event.preventDefault();
    const target = data.days[next];
    setKeyboardKey(target.key);
    dayButtons.current.get(target.key)?.focus();
  };
  const closeDetail = () => {
    if (selectedKey) dayButtons.current.get(selectedKey)?.focus();
    setSelectedKey(null);
  };
  const months = data.weeks.map((week, index) => {
    const day = week.find((value) => value?.date.getDate() === 1) ?? (index === 0 ? week.find((value) => value !== null) : null);
    return { label: day ? monthFormatter.format(day.date) : "", index };
  }).filter((month) => month.label);

  if (!projects.length) return null;
  return <section className="gk-activity" aria-labelledby="workspace-activity-heading" aria-busy={refreshing}>
    <div className="gk-activity-heading">
      <div><h2 id="workspace-activity-heading">{tx("工作区提交活动")}</h2><span>{tx("最近 12 个月")}</span></div>
      <div className="gk-activity-totals">
        <strong>{available ? tf("{0} 个提交", numberFormatter.format(data.totalCommits)) : "—"}</strong>
        {available && <span>{tf("{0} 个活跃日", numberFormatter.format(data.activeDays))}</span>}
        {incomplete && !loading && <span>{tf("已读取 {0} / {1} 个项目", loadedCount, projects.length)}</span>}
        {refreshing && <span className="gk-activity-progress"><LoaderCircle size={12} className="gk-overview-spin" aria-hidden="true" />{tx("更新中")}</span>}
      </div>
    </div>
    <div className="gk-activity-scope"><span>{tx("所有项目 · 仅设置中的提交者身份 · 按提交者日期 · 包含未推送提交")}</span>
      {checkedAt && <span>{tf("活动读取于 {0}", new Intl.DateTimeFormat(locale, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(checkedAt))}</span>}
    </div>
    <div className="gk-activity-calendar-scroll" onMouseLeave={() => setHoveredKey(null)}>
      <div className="gk-activity-calendar" style={{ "--gka-weeks": data.weeks.length } as CSSProperties}>
        <div className="gk-activity-months" aria-hidden="true">{months.map(({ label, index }) =>
          <span key={index} style={{ gridColumn: index + 1 }}>{label}</span>)}</div>
        <div className="gk-activity-weekdays" aria-hidden="true"><span>{tx("一")}</span><span>{tx("三")}</span><span>{tx("五")}</span></div>
        <p className="sr-only" id="workspace-activity-help">{tx("使用方向键选择日期，按 Enter 查看当天项目。Home 和 End 跳至首日与末日。")}</p>
        <div className="gk-activity-grid" role="group" aria-label={tx("每日提交活动")} aria-describedby="workspace-activity-help">
          {data.weeks.map((week, index) => <div className="gk-activity-week" key={index}>{week.map((day, weekday) => day
            ? <button key={day.key} ref={(node) => { if (node) dayButtons.current.set(day.key, node); else dayButtons.current.delete(day.key); }}
              className="gk-activity-day" data-level={available ? activityIntensity(day.count, data.peakCount) : 0}
              data-unavailable={!available || undefined} data-selected={selectedDay?.key === day.key || undefined}
              tabIndex={tabKey === day.key ? 0 : -1} title={describeDay(day)} aria-label={describeDay(day)} aria-pressed={selectedDay?.key === day.key}
              aria-controls="workspace-activity-detail" aria-expanded={selectedDay?.key === day.key}
              onMouseEnter={() => setHoveredKey(day.key)} onFocus={() => { setFocusedKey(day.key); setKeyboardKey(day.key); }}
              onBlur={() => setFocusedKey(null)} onKeyDown={(event) => navigateDay(event, day)}
              onClick={() => { setDetailKey(day.key); setSelectedKey((previous) => previous === day.key ? null : day.key); }} />
            : <span className="gk-activity-day gk-activity-pad" key={weekday} aria-hidden="true" />)}</div>)}
        </div>
      </div>
    </div>
    <div className="gk-activity-caption">
      <span className="gk-activity-day-caption">{previewDay ? describeDay(previewDay) : tx("同一提交在多个项目中只计一次")}</span>
      <span className="gk-activity-legend" aria-label={tx("颜色表示提交数量")}><span>{tx("少")}</span>
        {[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} aria-hidden="true" />)}<span>{tx("多")}</span></span>
    </div>
    {(loading || failed.length > 0 || (!refreshing && available && data.totalCommits === 0)) && <div className="gk-activity-status" role="status">
      {loading ? <span>{tf("正在读取 {0} 个项目的提交活动", projects.length)}</span>
        : failed.length > 0 ? <><CircleAlert size={13} aria-hidden="true" /><span>{tf("{0} 个项目读取失败，统计尚不完整", failed.length)}</span></>
          : <span>{hasIdentities ? tx("最近 12 个月没有匹配已配置身份的提交") : tx("请先在设置中配置提交者身份")}</span>}
      {failed.length > 0 && <button className="gk-activity-retry" disabled={refreshing} onClick={activity.refresh}>
        <RefreshCw size={12} aria-hidden="true" />{tx("重新读取")}</button>}
    </div>}
    {failed.length > 0 && <details className="gk-activity-errors"><summary>{tx("查看活动读取错误")}</summary>
      <ul>{failed.map((project) => <li key={project.id}><strong>{project.name}</strong><span>{entries[project.id].error}</span>
        {entries[project.id].summary && <small>{tf("上次读取于 {0}，未计入当前统计", new Date(entries[project.id].summary!.checkedAt).toLocaleString(locale))}</small>}</li>)}</ul></details>}
    <div id="workspace-activity-detail" className="gk-activity-detail-shell" data-open={!!selectedDay} aria-hidden={!selectedDay}>
      <div className="gk-activity-detail-clip">
        {detailDay && <div className="gk-activity-detail">
          <div className="gk-activity-detail-heading"><h3>{describeDay(detailDay)}</h3>
            <button disabled={!selectedDay} onClick={closeDetail} aria-label={tx("关闭当天活动")} title={tx("关闭当天活动")}><X size={13} aria-hidden="true" /></button></div>
          {detailProjects.length > 0 ? <ul>{detailProjects.map(({ project, count }) => <li key={project.id}>
            <button disabled={!selectedDay} onClick={() => onOpen(project, "history")} title={project.path} aria-label={tf("查看 {0} 的提交历史", project.name)}>
              <FolderGit2 size={14} style={{ color: project.color }} aria-hidden="true" /><span>{project.name}</span>
              <span>{tf("{0} 个提交", numberFormatter.format(count))}</span><ChevronRight size={13} aria-hidden="true" />
            </button></li>)}</ul>
            : <p>{incomplete ? tx("已读取的项目中没有当天提交，统计尚不完整") : tx("当天没有提交")}</p>}
          {sharedCommits && <p className="gk-activity-shared-note">{tx("各项目可能包含相同提交，项目提交数不能相加。")}</p>}
        </div>}
      </div>
    </div>
  </section>;
}
