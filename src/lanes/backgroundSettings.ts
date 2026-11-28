import { useSyncExternalStore } from "react";
import { getLaneSettings } from "./settings";

export interface BackgroundSettings {
  style: "plain" | "dots" | "waves" | "bars" | "droplets";
  animated: boolean;
  dots: number;
  waves: number;
  droplets: number;
  bars: number;
  barWidth: number;
  barSpeed: 1 | 2;
}

const key = "gitkit.appearance.background";
const listeners = new Set<() => void>();
let cached: { raw: string | null; value: BackgroundSettings } | undefined;

export function normalizeBackground(input: unknown, legacyPixels: boolean): BackgroundSettings {
  const v = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const strength = (n: unknown, fallback: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(180, Math.max(20, Math.round(n))) : fallback;
  return {
    style: v.style === "droplets" || v.style === "bars" || v.style === "waves" || v.style === "dots" || v.style === "plain" ? v.style : legacyPixels ? "dots" : "plain",
    animated: typeof v.animated === "boolean" ? v.animated : true,
    dots: strength(v.dots, 100),
    waves: strength(v.waves, 70),
    droplets: strength(v.droplets, 85),
    bars: typeof v.bars === "number" && Number.isFinite(v.bars) ? Math.min(100, Math.max(15, Math.round(v.bars))) : 65,
    barWidth: typeof v.barWidth === "number" && Number.isFinite(v.barWidth) ? Math.min(26, Math.max(10, Math.round(v.barWidth))) : 18,
    barSpeed: v.barSpeed === 1 ? 1 : 2,
  };
}

function getBackground(): BackgroundSettings {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key); } catch { /* storage unavailable */ }
  if (cached && cached.raw === raw) return cached.value;
  let parsed: unknown;
  try { parsed = raw && JSON.parse(raw); } catch { /* use defaults */ }
  const value = normalizeBackground(parsed, getLaneSettings().pixels);
  cached = { raw, value };
  return value;
}

export function updateBackground(patch: Partial<BackgroundSettings>) {
  const value = { ...getBackground(), ...patch };
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* keep this session's preference */ }
  if (cached) cached.value = value;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) notify(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(notify); window.removeEventListener("storage", onStorage); };
}

export function useBackgroundSettings() {
  return useSyncExternalStore(subscribe, getBackground, getBackground);
}
