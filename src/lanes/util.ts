import { tf, tx } from "../i18n";

// ─── persistence ────────────────────────────────────────────────────────────

const BASES_KEY = "gitkit.lanes.bases";

export function loadBases(path: string): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(BASES_KEY) ?? "{}")[path] ?? {}; } catch { return {}; }
}
export function saveBase(path: string, branch: string, base: string): Record<string, string> {
  let all: Record<string, Record<string, string>> = {};
  try { all = JSON.parse(localStorage.getItem(BASES_KEY) ?? "{}"); } catch { /* reset */ }
  all[path] = { ...(all[path] ?? {}), [branch]: base };
  localStorage.setItem(BASES_KEY, JSON.stringify(all));
  return all[path];
}

export function relTime(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const min = Math.floor(diff / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (min < 1) return tx("刚刚");
  if (min < 60) return tf("{0} 分钟前", min);
  if (h < 24) return tf("{0} 小时前", h);
  if (d < 30) return tf("{0} 天前", d);
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
