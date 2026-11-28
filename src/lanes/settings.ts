import { useSyncExternalStore } from "react";

// User settings for the lanes workspace (Settings → 分支区域).
// Global preferences live in one JSON blob; the trunk choice is per project.

/** What a lane shows by default. A rule that finds nothing falls back to "recent". */
export type SlotRule =
  | { kind: "current" }                  // the checked-out branch (+ uncommitted work)
  | { kind: "parent" }                   // its base branch
  | { kind: "trunk" }                    // the trunk
  | { kind: "recent" }                   // the most recently changed branch not shown yet
  | { kind: "named"; names: string[] };  // the first of these that exists and isn't shown yet

export interface LaneSettings {
  /** One rule per lane, left to right. */
  slots: SlotRule[];
  /** 1-based lane a branch picked from the dock's branch tree goes to; 0 = the last lane. */
  openAt: number;
  /** At most this many lanes, even on a wide window. */
  maxLanes: number;
  /** Merged branches compete for "recent" lanes too. */
  recentIncludesMerged: boolean;
  /** Long-lived branches in promotion order (e.g. test, pre, master); empty = detect from history. */
  envOrder: string[];
  showLinks: boolean;
  pixels: boolean; // Legacy fallback until an appearance preference is saved.
}

export const MAX_LANES = 4;

export const DEFAULT_LANE_SETTINGS: LaneSettings = {
  slots: [{ kind: "current" }, { kind: "parent" }, { kind: "recent" }, { kind: "recent" }],
  openAt: 0,
  maxLanes: MAX_LANES,
  recentIncludesMerged: true,
  envOrder: [],
  showLinks: true,
  pixels: true,
};

const SETTINGS_KEY = "gitkit.lanes.settings";
const TRUNK_KEY = "gitkit.lanes.trunk";

const listeners = new Set<() => void>();
let cache: { raw: string | null; settings: LaneSettings } | null = null;
let trunkCache: { raw: string | null; map: Record<string, string> } | null = null;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function emit() { for (const fn of listeners) fn(); }

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === SETTINGS_KEY || e.key === TRUNK_KEY) fn(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(fn); window.removeEventListener("storage", onStorage); };
}

/** Parse untrusted stored JSON into complete, valid settings. */
export function normalizeLaneSettings(value: unknown): LaneSettings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof LaneSettings, unknown>>;
  const d = DEFAULT_LANE_SETTINGS;
  const names = (x: unknown) => Array.isArray(x)
    ? [...new Set(x.filter((n): n is string => typeof n === "string").map((n) => n.trim()).filter(Boolean))] : [];
  const rule = (x: unknown, fallback: SlotRule): SlotRule => {
    const r = (x && typeof x === "object" ? x : {}) as { kind?: unknown; names?: unknown };
    switch (r.kind) {
      case "current": case "parent": case "trunk": case "recent": return { kind: r.kind };
      case "named": return { kind: "named", names: names(r.names) };
      default: return fallback;
    }
  };
  const slots = Array.from({ length: MAX_LANES }, (_, i) => rule(Array.isArray(v.slots) ? v.slots[i] : undefined, d.slots[i]));
  const int = (x: unknown, min: number, max: number, fallback: number) =>
    typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : fallback;
  const bool = (x: unknown, fallback: boolean) => typeof x === "boolean" ? x : fallback;
  return {
    slots,
    openAt: int(v.openAt, 0, MAX_LANES, d.openAt),
    maxLanes: int(v.maxLanes, 1, MAX_LANES, d.maxLanes),
    recentIncludesMerged: bool(v.recentIncludesMerged, d.recentIncludesMerged),
    envOrder: names(v.envOrder),
    showLinks: bool(v.showLinks, d.showLinks),
    pixels: bool(v.pixels, d.pixels),
  };
}

export function getLaneSettings(): LaneSettings {
  const raw = read(SETTINGS_KEY);
  if (cache?.raw !== raw || !cache) {
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    cache = { raw, settings: normalizeLaneSettings(parsed) };
  }
  return cache.settings;
}

export function setLaneSettings(next: LaneSettings | ((prev: LaneSettings) => LaneSettings)) {
  const value = normalizeLaneSettings(typeof next === "function" ? next(getLaneSettings()) : next);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  emit();
}

export function useLaneSettings(): LaneSettings {
  return useSyncExternalStore(subscribe, getLaneSettings, getLaneSettings);
}

function trunkMap(): Record<string, string> {
  const raw = read(TRUNK_KEY);
  if (trunkCache?.raw !== raw || !trunkCache) {
    let map: Record<string, string> = {};
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object") {
        map = Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]));
      }
    } catch { map = {}; }
    trunkCache = { raw, map };
  }
  return trunkCache.map;
}

/** The trunk chosen for a project, or "" to detect it (main / master / trunk / develop). */
export function getLaneTrunk(path: string): string {
  return path ? trunkMap()[path] ?? "" : "";
}

export function setLaneTrunk(path: string, branch: string) {
  if (!path) return;
  const map = { ...trunkMap() };
  if (branch) map[path] = branch; else delete map[path];
  try { localStorage.setItem(TRUNK_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  emit();
}

export function useLaneTrunk(path: string): string {
  return useSyncExternalStore(subscribe, () => getLaneTrunk(path), () => getLaneTrunk(path));
}

/** "test, pre dev" → ["test", "pre", "dev"]. */
export function parseBranchList(text: string): string[] {
  return [...new Set(text.split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean))];
}
