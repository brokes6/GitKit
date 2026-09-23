import type { BehindBranch } from "./git";

export interface DailyCheck { enabled: boolean; time: string; skipWeekends: boolean; lastRun: number }
export interface CheckProgress { current: number; total: number; project: string; paused: boolean }
export interface CheckResult {
  id: number; completedAt: number; manual: boolean; viewed: boolean; total: number;
  rows: Array<{ id: string; name: string; path: string; behind: BehindBranch[]; dirty: boolean; currentBranch: string; error: string | null }>;
}
export interface CheckSnapshot {
  revision: number; config: DailyCheck; progress: CheckProgress | null;
  result: CheckResult | null; persistenceError: string | null;
}
export const DAILY_CHECK_DEFAULT: DailyCheck = { enabled: false, time: "09:30", skipWeekends: false, lastRun: 0 };
export function validCheckTime(time: unknown): time is string {
  return typeof time === "string" && /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(time);
}
export function nextCheckLabel(cfg: DailyCheck, now = new Date(), language: "zh-CN" | "en" = "zh-CN"): string | null {
  if (!cfg.enabled) return null;
  const [hours, minutes] = cfg.time.split(":").map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  const completedToday = cfg.lastRun > 0 && new Date(cfg.lastRun).toDateString() === now.toDateString();
  const skipped = (date: Date) => cfg.skipWeekends && (date.getDay() === 0 || date.getDay() === 6);
  if (!completedToday && !skipped(now)) {
    if (now.getTime() >= next.getTime()) return language === "en"
      ? "No check yet today. It will resume in the background."
      : "今天尚未检查，将在后台补查";
    return language === "en" ? `Today ${cfg.time}` : `今天 ${cfg.time}`;
  }
  next.setDate(next.getDate() + 1);
  while (skipped(next)) next.setDate(next.getDate() + 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const label = next.toDateString() === tomorrow.toDateString()
    ? (language === "en" ? "Tomorrow" : "明天")
    : language === "en"
      ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(next)
      : `${next.getMonth() + 1}月${next.getDate()}日`;
  return `${label} ${cfg.time}`;
}
export function shouldPresentCheck(result: CheckResult | null, focused: boolean, now = new Date()): boolean {
  return !!result && !result.viewed && focused && new Date(result.completedAt).toDateString() === now.toDateString();
}
