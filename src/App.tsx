import { useState, useEffect, useRef, useMemo, useDeferredValue, startTransition, useTransition, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  GitBranch, GitMerge, GitPullRequest, Upload, Download, RefreshCw,
  Layers, ChevronRight, Copy, Check, GitCommit, FileText,
  Moon, Sun, Monitor, Plus, Minus, X, FolderOpen, ArrowRight,
  Pin, EyeOff, Eye, Folder, AlertTriangle, Cloud, GitBranchPlus, ChevronLeft, LayoutGrid,
  Settings, UserPlus, Trash2, Star, Users, Github, Laptop, Sparkles, RotateCcw, TerminalSquare,
  Tag as TagIcon, Square, DownloadCloud, Pencil, FolderGit2, Search,
} from "lucide-react";
import {
  pickRepoFolder, openRepo, loadBranches, loadRemotes, loadHistory,
  loadStatus, loadCommitFiles, commitFileDiff, workingFileDiff, filePreview,
  attributeBranches, computeGraph, hasChanges, checkoutBranch, stashPush, stashList, stashApply, stashDrop, stashFiles, stashFileDiff, cherryPick, cherryPickPreflight,
  createBranch, deleteBranch, renameBranch, removeWorktree, checkoutSync, commit as gitCommit, fetchAll, pull, push, gitlabTest, githubTest,
  createPullRequest, branchColor, setVibrancy, checkForUpdate, getAppVersion, discardFile, discardAll,
  checkDeps, mergePreview, loadTags, createTag, pushTag, githubCreateRepo, gitRemoteAdd,
  cloneRepo, pickCloneParent, repoNameFromUrl, startWatch, stopWatch,
  cancelGitOp, isCancelled, checkUpdates, syncLocal,
} from "./git";
import type { DepInfo, Tag, RepoInfo, CloneProgress, GitProgress, BehindBranch } from "./git";

// ─── theme ────────────────────────────────────────────────────────────────────

interface ThemeColors {
  bg: string;
  bgPanel: string;
  glass: string;
  glassBorder: string;
  glassBg: string;       // translucent bg when vibrancy is on
  glassBgPanel: string;  // translucent bgPanel when vibrancy is on
  sidebarBg: string;     // left branch/tree panel (blurred translucent surface)
  diffBg: string;        // diff / file-preview surface
  diffHeaderBg: string;  // diff sticky header (translucent diffBg)
  dialogBg: string;      // elevated surface: dialogs, popovers, detail panel
  windowBg: string;
  shadowWindow: string;
  shadowEl: string;
  border: string;
  text: string;
  textSec: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentBg: string;
  accentFg: string;
  accent2: string;     // secondary brand hue (info / links / secondary emphasis)
  accent2Bg: string;
  accent2Fg: string;
  accent3: string;     // tertiary brand hue (highlights / secondary CTAs)
  accent3Bg: string;
  accent3Fg: string;
  green: string;
  greenBg: string;
  red: string;
  redBg: string;
  amber: string;
  rowHover: string;
  rowSelected: string;
  rowSelectedAccent: string;
  rowCurrent: string;      // current-branch row highlight (neutral, not accent)
  rowCurrentHover: string;
  scrim: string;           // veil behind the sliding detail panel
  inputBg: string;
  inputBorder: string;
  isDark: boolean;
}

const DARK: ThemeColors = {
  bg: "#262523",
  bgPanel: "#201F1D",
  glass: "rgba(38,37,35,0.82)",
  glassBorder: "rgba(255,255,255,0.09)",
  glassBg: "rgba(38,37,35,0.86)",
  glassBgPanel: "rgba(32,31,29,0.92)",
  sidebarBg: "rgba(30,29,27,0.9)",
  diffBg: "#1B1A18",
  diffHeaderBg: "rgba(27,26,24,0.9)",
  dialogBg: "rgba(33,31,29,0.99)",
  windowBg: "#171614",
  shadowWindow:
    "0 0 0 0.5px rgba(255,255,255,0.06), 0 40px 100px rgba(0,0,0,0.8), 0 8px 28px rgba(0,0,0,0.5)",
  shadowEl: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.28)",
  border: "rgba(255,255,255,0.09)",
  text: "#ECE9E2",
  textSec: "#B4AEA3",
  textMuted: "#8B847A",
  textFaint: "#635D54",
  accent: "#D2795B",
  accentBg: "rgba(210,121,91,0.15)",
  accentFg: "#E9AB8D",
  accent2: "#CDA05E",
  accent2Bg: "rgba(205,160,94,0.15)",
  accent2Fg: "#E0C088",
  accent3: "#7E9C6A",
  accent3Bg: "rgba(126,156,106,0.15)",
  accent3Fg: "#A8C596",
  green: "#67B98C",
  greenBg: "rgba(103,185,140,0.10)",
  red: "#E07A5F",
  redBg: "rgba(224,122,95,0.10)",
  amber: "#E0A94E",
  rowHover: "rgba(255,255,255,0.05)",
  rowSelected: "rgba(210,121,91,0.15)",
  rowSelectedAccent: "#D2795B",
  rowCurrent: "rgba(255,255,255,0.08)",
  rowCurrentHover: "rgba(255,255,255,0.11)",
  scrim: "rgba(0,0,0,0.4)",
  inputBg: "rgba(255,255,255,0.06)",
  inputBorder: "rgba(255,255,255,0.12)",
  isDark: true,
};

const LIGHT: ThemeColors = {
  bg: "#F4F2EC",
  bgPanel: "#FBFAF6",
  glass: "rgba(244,242,236,0.82)",
  glassBorder: "rgba(255,255,255,0.7)",
  glassBg: "rgba(244,242,236,0.80)",
  glassBgPanel: "rgba(251,250,246,0.90)",
  sidebarBg: "rgba(238,236,229,0.9)",
  diffBg: "#FAF9F4",
  diffHeaderBg: "rgba(250,249,244,0.9)",
  dialogBg: "#FFFFFF",
  windowBg: "#B8B2A5",
  shadowWindow:
    "0 0 0 0.5px rgba(0,0,0,0.1), 0 40px 100px rgba(60,50,40,0.22), 0 8px 28px rgba(60,50,40,0.09)",
  shadowEl: "0 2px 8px rgba(60,50,40,0.09), 0 1px 2px rgba(60,50,40,0.05)",
  border: "rgba(40,35,30,0.10)",
  text: "#262523",
  textSec: "#54504A",
  textMuted: "#7C766C",
  textFaint: "#A8A198",
  accent: "#C15F3C",
  accentBg: "rgba(193,95,60,0.10)",
  accentFg: "#9E4A2C",
  accent2: "#B0781E",
  accent2Bg: "rgba(176,120,30,0.10)",
  accent2Fg: "#8A5E14",
  accent3: "#5E8A4E",
  accent3Bg: "rgba(94,138,78,0.10)",
  accent3Fg: "#456B38",
  green: "#4E8A5F",
  greenBg: "rgba(78,138,95,0.10)",
  red: "#C0533F",
  redBg: "rgba(192,83,63,0.09)",
  amber: "#B0781E",
  rowHover: "rgba(40,35,30,0.045)",
  rowSelected: "rgba(193,95,60,0.10)",
  rowSelectedAccent: "#C15F3C",
  rowCurrent: "rgba(40,35,30,0.07)",
  rowCurrentHover: "rgba(40,35,30,0.10)",
  scrim: "rgba(240,238,231,0.5)",
  inputBg: "rgba(40,35,30,0.045)",
  inputBorder: "rgba(40,35,30,0.13)",
  isDark: false,
};

// ── "晴空蓝" palette family ─────────────────────────────────────────────────
// Seeds: Primary #5C7CFA → accent, Secondary #74C0FC → accent2, Tertiary
// #CA6E00 → accent3, Neutral #1A1B1E → dark surfaces. Cool neutrals throughout
// (vs. the warm terracotta family above). Accents are deepened on the light
// variant for text contrast on near-white, and brightened on the dark variant.
const BLUE_DARK: ThemeColors = {
  bg: "#1E1F23",
  bgPanel: "#17181B",
  glass: "rgba(30,31,35,0.82)",
  glassBorder: "rgba(255,255,255,0.09)",
  glassBg: "rgba(30,31,35,0.86)",
  glassBgPanel: "rgba(23,24,27,0.92)",
  sidebarBg: "rgba(26,27,31,0.9)",
  diffBg: "#141519",
  diffHeaderBg: "rgba(20,21,25,0.9)",
  dialogBg: "rgba(28,29,34,0.99)",
  windowBg: "#0F1013",
  shadowWindow:
    "0 0 0 0.5px rgba(255,255,255,0.06), 0 40px 100px rgba(0,0,0,0.8), 0 8px 28px rgba(0,0,0,0.5)",
  shadowEl: "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.28)",
  border: "rgba(255,255,255,0.09)",
  text: "#E6E7EB",
  textSec: "#A9ABB3",
  textMuted: "#7C7F88",
  textFaint: "#54565E",
  accent: "#5C7CFA",
  accentBg: "rgba(92,124,250,0.15)",
  accentFg: "#A9B9FD",
  accent2: "#74C0FC",
  accent2Bg: "rgba(116,192,252,0.15)",
  accent2Fg: "#A7D6FE",
  accent3: "#E08A1E",
  accent3Bg: "rgba(224,138,30,0.15)",
  accent3Fg: "#F0B056",
  green: "#67B98C",
  greenBg: "rgba(103,185,140,0.10)",
  red: "#EF6D6D",
  redBg: "rgba(239,109,109,0.10)",
  amber: "#E0A94E",
  rowHover: "rgba(255,255,255,0.05)",
  rowSelected: "rgba(92,124,250,0.15)",
  rowSelectedAccent: "#5C7CFA",
  rowCurrent: "rgba(255,255,255,0.08)",
  rowCurrentHover: "rgba(255,255,255,0.11)",
  scrim: "rgba(0,0,0,0.4)",
  inputBg: "rgba(255,255,255,0.06)",
  inputBorder: "rgba(255,255,255,0.12)",
  isDark: true,
};

const BLUE_LIGHT: ThemeColors = {
  bg: "#F3F5F9",
  bgPanel: "#FBFCFE",
  glass: "rgba(243,245,249,0.82)",
  glassBorder: "rgba(30,40,60,0.12)",
  glassBg: "rgba(243,245,249,0.80)",
  glassBgPanel: "rgba(251,252,254,0.90)",
  sidebarBg: "rgba(232,236,242,0.9)",
  diffBg: "#F6F8FC",
  diffHeaderBg: "rgba(246,248,252,0.9)",
  dialogBg: "#FFFFFF",
  windowBg: "#AFB6C4",
  shadowWindow:
    "0 0 0 0.5px rgba(0,0,0,0.1), 0 40px 100px rgba(40,50,70,0.22), 0 8px 28px rgba(40,50,70,0.09)",
  shadowEl: "0 2px 8px rgba(40,50,70,0.09), 0 1px 2px rgba(40,50,70,0.05)",
  border: "rgba(30,35,50,0.10)",
  text: "#1A1B1E",
  textSec: "#4A4D57",
  textMuted: "#71757F",
  textFaint: "#A2A6B0",
  accent: "#4263EB",
  accentBg: "rgba(66,99,235,0.10)",
  accentFg: "#3452D4",
  accent2: "#2B8AE0",
  accent2Bg: "rgba(43,138,224,0.10)",
  accent2Fg: "#1E72C4",
  accent3: "#CA6E00",
  accent3Bg: "rgba(202,110,0,0.10)",
  accent3Fg: "#9E5600",
  green: "#4E8A5F",
  greenBg: "rgba(78,138,95,0.10)",
  red: "#CE4A4A",
  redBg: "rgba(206,74,74,0.09)",
  amber: "#B0781E",
  rowHover: "rgba(30,35,50,0.045)",
  rowSelected: "rgba(66,99,235,0.10)",
  rowSelectedAccent: "#4263EB",
  rowCurrent: "rgba(30,40,60,0.07)",
  rowCurrentHover: "rgba(30,40,60,0.10)",
  scrim: "rgba(236,239,244,0.5)",
  inputBg: "rgba(30,35,50,0.045)",
  inputBorder: "rgba(30,35,50,0.13)",
  isDark: false,
};

// ── palette factory ─────────────────────────────────────────────────────────
// Derives a full ThemeColors from a compact seed (surfaces + text ramp + three
// brand hues). Shared constants (shadows, overlays, semantic green/red/amber)
// are filled in here so a new family needs only its distinctive colours. The
// hand-tuned "warm"/"blue" families above stay explicit; new families use this.
const hexRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (hex: string, a: number): string => `rgba(${hexRgb(hex).join(",")},${a})`;

// A "half" describes one mode (light or dark) of a family via seed colours.
interface Half {
  bg: string; bgPanel: string; windowBg: string;
  sidebar: string; diff: string; dialog: string; // dialog: dark hex, or "#FFFFFF" on light
  text: string; textSec: string; textMuted: string; textFaint: string;
  accent: string; accentFg: string;
  accent2: string; accent2Fg: string;
  accent3: string; accent3Fg: string;
}
function buildHalf(h: Half, dark: boolean): ThemeColors {
  const ink = dark ? "255,255,255" : hexRgb(h.text).join(",");
  const line = (a: number) => `rgba(${ink},${a})`;
  const bgA = dark ? 0.15 : 0.10;
  return {
    bg: h.bg, bgPanel: h.bgPanel, windowBg: h.windowBg,
    glass: rgba(h.bg, 0.82),
    glassBorder: dark ? "rgba(255,255,255,0.09)" : line(0.12),
    glassBg: rgba(h.bg, dark ? 0.86 : 0.80),
    glassBgPanel: rgba(h.bgPanel, dark ? 0.92 : 0.90),
    sidebarBg: rgba(h.sidebar, 0.9),
    diffBg: h.diff,
    diffHeaderBg: rgba(h.diff, 0.9),
    dialogBg: dark ? rgba(h.dialog, 0.99) : h.dialog,
    shadowWindow: dark
      ? "0 0 0 0.5px rgba(255,255,255,0.06), 0 40px 100px rgba(0,0,0,0.8), 0 8px 28px rgba(0,0,0,0.5)"
      : "0 0 0 0.5px rgba(0,0,0,0.1), 0 40px 100px rgba(30,35,45,0.22), 0 8px 28px rgba(30,35,45,0.09)",
    shadowEl: dark
      ? "0 2px 12px rgba(0,0,0,0.4), 0 1px 3px rgba(0,0,0,0.28)"
      : "0 2px 8px rgba(30,35,45,0.09), 0 1px 2px rgba(30,35,45,0.05)",
    border: line(dark ? 0.09 : 0.10),
    text: h.text, textSec: h.textSec, textMuted: h.textMuted, textFaint: h.textFaint,
    accent: h.accent, accentBg: rgba(h.accent, bgA), accentFg: h.accentFg,
    accent2: h.accent2, accent2Bg: rgba(h.accent2, bgA), accent2Fg: h.accent2Fg,
    accent3: h.accent3, accent3Bg: rgba(h.accent3, bgA), accent3Fg: h.accent3Fg,
    green: dark ? "#67B98C" : "#4E8A5F", greenBg: dark ? "rgba(103,185,140,0.10)" : "rgba(78,138,95,0.10)",
    red: dark ? "#EF6D6D" : "#CE4A4A", redBg: dark ? "rgba(239,109,109,0.10)" : "rgba(206,74,74,0.09)",
    amber: dark ? "#E0A94E" : "#B0781E",
    rowHover: line(dark ? 0.05 : 0.045),
    rowSelected: rgba(h.accent, bgA), rowSelectedAccent: h.accent,
    rowCurrent: line(dark ? 0.08 : 0.07), rowCurrentHover: line(dark ? 0.11 : 0.10),
    scrim: dark ? "rgba(0,0,0,0.4)" : rgba(h.bg, 0.6),
    inputBg: line(dark ? 0.06 : 0.045), inputBorder: line(dark ? 0.12 : 0.13),
    isDark: dark,
  };
}
function buildPalette(id: PaletteId, label: string, dark: Half, light: Half): Palette {
  return { id, label, light: buildHalf(light, false), dark: buildHalf(dark, true) };
}

// 森野绿 — emerald / forest green
const GREEN = buildPalette("green", "森野绿",
  { bg: "#181B19", bgPanel: "#121412", windowBg: "#0C0E0C",
    sidebar: "#141614", diff: "#101210", dialog: "#22251F",
    text: "#E4E9E3", textSec: "#A7B0A6", textMuted: "#7B857A", textFaint: "#535B52",
    accent: "#3FB27F", accentFg: "#83D9AE", accent2: "#2DB8A8", accent2Fg: "#7ED9CD", accent3: "#E0A44E", accent3Fg: "#F0C583" },
  { bg: "#F1F5F1", bgPanel: "#FBFDFA", windowBg: "#AEBBAE",
    sidebar: "#E7EDE6", diff: "#F5F9F4", dialog: "#FFFFFF",
    text: "#18201A", textSec: "#495049", textMuted: "#6F776E", textFaint: "#A0A89F",
    accent: "#1F9D63", accentFg: "#177349", accent2: "#1E93C4", accent2Fg: "#156F96", accent3: "#CA8A00", accent3Fg: "#9E6A00" });

// 暮光紫 — violet / dracula
const VIOLET = buildPalette("violet", "暮光紫",
  { bg: "#1E1B26", bgPanel: "#17141F", windowBg: "#100E17",
    sidebar: "#1A1723", diff: "#141119", dialog: "#26222F",
    text: "#E8E4F0", textSec: "#AEA8BE", textMuted: "#807A90", textFaint: "#575267",
    accent: "#A98BFF", accentFg: "#C9B6FF", accent2: "#FF79C6", accent2Fg: "#FFB0DE", accent3: "#59C9E8", accent3Fg: "#9BE0F2" },
  { bg: "#F5F2FB", bgPanel: "#FCFBFE", windowBg: "#B7B0C6",
    sidebar: "#EDE8F5", diff: "#F8F5FC", dialog: "#FFFFFF",
    text: "#211C2B", textSec: "#4E475C", textMuted: "#746D82", textFaint: "#A49DB2",
    accent: "#7C4DFF", accentFg: "#5B2FD6", accent2: "#D6459A", accent2Fg: "#A82F76", accent3: "#2196C4", accent3Fg: "#166F94" });

// 玫瑰 — rose / rosé pine
const ROSE = buildPalette("rose", "玫瑰",
  { bg: "#221A1E", bgPanel: "#1B1418", windowBg: "#130E11",
    sidebar: "#1E1619", diff: "#171114", dialog: "#2A2126",
    text: "#F0E4E9", textSec: "#BEA8B1", textMuted: "#8F7A83", textFaint: "#63525A",
    accent: "#EB6F92", accentFg: "#F4A6BD", accent2: "#C4A7E7", accent2Fg: "#DBC7F2", accent3: "#F6C177", accent3Fg: "#FAD6A0" },
  { bg: "#FBF2F4", bgPanel: "#FEFBFC", windowBg: "#C6B0B6",
    sidebar: "#F5E8EC", diff: "#FDF5F7", dialog: "#FFFFFF",
    text: "#2B1C22", textSec: "#5C4750", textMuted: "#836D75", textFaint: "#B39DA4",
    accent: "#C4457A", accentFg: "#98305C", accent2: "#907AA9", accent2Fg: "#6E5A85", accent3: "#B57A1E", accent3Fg: "#8A5C12" });

// 石墨 — graphite / minimalist neutral
const GRAPHITE = buildPalette("graphite", "石墨",
  { bg: "#1B1C1E", bgPanel: "#151618", windowBg: "#0D0E0F",
    sidebar: "#18191B", diff: "#111213", dialog: "#232426",
    text: "#ECEEF2", textSec: "#B8BCC4", textMuted: "#8D919A", textFaint: "#666A72",
    accent: "#4563D3", accentFg: "#AFC0FF", accent2: "#4563D3", accent2Fg: "#AFC0FF", accent3: "#4563D3", accent3Fg: "#AFC0FF" },
  { bg: "#F4F5F7", bgPanel: "#FCFCFD", windowBg: "#B4B6BA",
    sidebar: "#EFF1F4", diff: "#F7F8FA", dialog: "#FFFFFF",
    text: "#181A1F", textSec: "#444851", textMuted: "#6B707A", textFaint: "#9297A1",
    accent: "#4567F2", accentFg: "#2F50D5", accent2: "#4567F2", accent2Fg: "#2F50D5", accent3: "#4567F2", accent3Fg: "#2F50D5" });

// Theme families: each supplies a light + dark variant. `themeMode`
// (dark/light/system) still decides which variant renders; the family only
// swaps the colour set. Add new families here — the settings picker enumerates
// PALETTE_ORDER automatically.
const PALETTE_ORDER = ["warm", "blue", "green", "violet", "rose", "graphite"] as const;
type PaletteId = typeof PALETTE_ORDER[number];
interface Palette { id: PaletteId; label: string; light: ThemeColors; dark: ThemeColors }
const PALETTES: Record<PaletteId, Palette> = {
  warm: { id: "warm", label: "暖陶土", light: LIGHT, dark: DARK },
  blue: { id: "blue", label: "晴空蓝", light: BLUE_LIGHT, dark: BLUE_DARK },
  green: GREEN, violet: VIOLET, rose: ROSE, graphite: GRAPHITE,
};

// When window vibrancy (frosted glass) is on, the two base surfaces go
// translucent so the native blur shows through; every other colour is already
// an rgba tint layered on top and needs no change. Off → the solid originals.
// Kept close to opaque on purpose: the panels carry dense text and must read
// correctly, so glass shows only as a faint frost (and more so in the
// translucent title-bar). Too much transparency over the vibrancy material +
// desktop washes the dark theme out to grey.
function glassify(base: ThemeColors, on: boolean): ThemeColors {
  if (!on) return base;
  return { ...base, bg: base.glassBg, bgPanel: base.glassBgPanel };
}

const ThemeCtx = createContext<ThemeColors>(DARK);
const useTheme = () => useContext(ThemeCtx);
type ThemeMode = "dark" | "light" | "system";

// ─── constants ────────────────────────────────────────────────────────────────

const ROW_H = 56;
// Graph "trough": all rows share ONE column width + ONE lane step (so vertical lane
// lines stay aligned). The width tracks the view's busiest row, clamped to
// [GRAPH_W_MIN, GRAPH_W_MAX] — sparse views hug the text, busy views compress the step
// down to LANE_STEP_MIN rather than pushing the message column right.
const GRAPH_LEFT = 14;      // x of lane 0
const LANE_STEP = 20;       // full (uncompressed) lane spacing
const LANE_STEP_MIN = 11;   // floor before the trough widens (extreme histories only)
const LANE_RIGHT = 12;      // gap between the last lane and the message column
const GRAPH_W_MIN = 44;     // sparse views: message column hugs the few lanes (little indent)
const GRAPH_W_MAX = 100;    // busy views: cap here — lanes compress instead of pushing text right
const laneXAt = (lane: number, step: number) => GRAPH_LEFT + lane * step;
// Fallback lane colours — mirror git.ts PALETTE (keep in sync).
const LANE_COLORS = ["#5E78C7", "#B78338", "#4F8A6B", "#B95D58", "#7D70AE", "#4E8989", "#B66C4C", "#A56380"];
const R = 10; // unified border-radius base
const getLC = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

// ─── types ────────────────────────────────────────────────────────────────────

export interface Author { name: string; email: string; initials: string; color: string }
export interface CommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number; deletions: number; diff?: string;
}
export interface Commit {
  hash: string; fullHash: string; message: string; body?: string;
  author: Author; date: string; lane: number; tags?: string[]; parents: string[];
  stats: { additions: number; deletions: number; files: number };
  files: CommitFile[];
  branchLabel?: string;       // primary branch (drives lane colour)
  branchLabels?: string[];    // every branch whose first-parent backbone reaches here
  isStash?: boolean;          // stash tip — rendered as a single collapsed node
}
// `worktree` — absolute path of the linked worktree holding this branch, when
// one does. Such a branch can't be checked out or deleted until it's released.
export interface Branch { name: string; remote?: string; ahead: number; behind: number; current: boolean; color: string; head?: string; worktree?: string }
export interface Stash { index: number; message: string; date: string }
export interface Remote { name: string; url: string; branches: string[] }
export interface GraphRowInfo {
  passthrough: number[]; dotLane: number; hasTopLine: boolean; hasBottomLine: boolean;
  topMerges: { fromLane: number; toLane: number }[];
  bottomBranches: { fromLane: number; toLane: number }[];
  isMerge: boolean;
  colors?: {
    dot: string; line: string;
    pass: Record<number, string>;
    top: string[];
    bottom: string[];
  };
}
export interface WorkingFile {
  path: string; status: "modified" | "added" | "deleted" | "untracked";
  staged: boolean; diff?: string;
  // Set for untracked previews rendered by reading the file directly.
  previewKind?: "text" | "binary" | "too_large" | "empty" | "missing";
  previewTruncated?: boolean; previewSize?: number;
}
export interface Project {
  id: string; name: string; branch: string; color: string; changes: number; path: string;
}


// ─── helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return "刚刚";
  const min = Math.floor(diff / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (min < 60) return `${min} 分钟前`;
  if (h  < 24)  return `${h} 小时前`;
  if (d  < 7)   return `${d} 天前`;
  return new Date(dateStr).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

function Avatar({ author, size = 28 }: { author: Author; size?: number }) {
  return (
    <div className="rounded-full flex items-center justify-center flex-shrink-0 font-bold"
      style={{
        width: size, height: size,
        background: author.color + "20",
        border: `1.5px solid ${author.color}44`,
        color: author.color,
        fontSize: Math.floor(size * 0.36),
        boxShadow: `0 0 0 2px ${author.color}14`,
      }}>
      {author.initials}
    </div>
  );
}

// ─── GraphRowSVG ──────────────────────────────────────────────────────────────

function GraphRowSVG({ info, height = ROW_H, width = GRAPH_W_MAX, step = LANE_STEP, dim = false, stash = false }: {
  info: GraphRowInfo; height?: number; width?: number; step?: number; dim?: boolean; stash?: boolean;
}) {
  const t = useTheme();
  const h = height;
  const mid = h / 2;
  const co = info.colors;
  const lx = (lane: number) => laneXAt(lane, step);
  const passColor = (lane: number) => co?.pass[lane] ?? getLC(lane);
  const lineColor = co?.line ?? getLC(info.dotLane);
  const dotColor = co?.dot ?? getLC(info.dotLane);
  const op = dim ? 0.28 : 0.85;
  return (
    <svg width={width} height={h} style={{ overflow: "visible", flexShrink: 0, display: "block" }}>
      {info.passthrough.map((lane) => (
        <line key={lane} x1={lx(lane)} y1={0} x2={lx(lane)} y2={h}
          stroke={passColor(lane)} strokeWidth={2} opacity={op} />
      ))}
      {info.hasTopLine && (
        <line x1={lx(info.dotLane)} y1={0} x2={lx(info.dotLane)} y2={mid}
          stroke={lineColor} strokeWidth={2} opacity={op} />
      )}
      {info.hasBottomLine && (
        <line x1={lx(info.dotLane)} y1={mid} x2={lx(info.dotLane)} y2={h}
          stroke={lineColor} strokeWidth={2} opacity={op} />
      )}
      {info.topMerges.map(({ fromLane, toLane }, i) => (
        <path key={i}
          d={`M ${lx(fromLane)} 0 C ${lx(fromLane)} ${mid * 0.75}, ${lx(toLane)} ${mid * 0.25}, ${lx(toLane)} ${mid}`}
          stroke={co?.top[i] ?? getLC(fromLane)} strokeWidth={2} fill="none" opacity={op} />
      ))}
      {info.bottomBranches.map(({ fromLane, toLane }, i) => (
        <path key={i}
          d={`M ${lx(fromLane)} ${mid} C ${lx(fromLane)} ${mid+(h-mid)*0.65}, ${lx(toLane)} ${h*0.55}, ${lx(toLane)} ${h}`}
          stroke={co?.bottom[i] ?? getLC(toLane)} strokeWidth={2} fill="none" opacity={op} />
      ))}
      {/* halo so the node reads above the lane lines */}
      <circle cx={lx(info.dotLane)} cy={mid} r={7.5} fill={t.bg} />
      {stash ? (() => {
        // Stash node — an accent-filled chip with a stacked-layers glyph, matching
        // the sidebar's Layers icon. Colour + square shape make it pop out from the
        // neutral round commit dots and merge rings.
        const cx = lx(info.dotLane), S = 15, half = S / 2, o = dim ? 0.45 : 1;
        return (
          <g>
            <rect x={cx - half - 1.5} y={mid - half - 1.5} width={S + 3} height={S + 3} rx={5.5} fill={t.bg} />
            <rect x={cx - half} y={mid - half} width={S} height={S} rx={4} fill={t.accent} opacity={o} />
            <g stroke={t.bg} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" opacity={o}>
              <path d={`M ${cx} ${mid - 4.2} L ${cx + 4.2} ${mid - 1.5} L ${cx} ${mid + 1.2} L ${cx - 4.2} ${mid - 1.5} Z`} fill={t.bg} />
              <path d={`M ${cx - 4.2} ${mid + 1.6} L ${cx} ${mid + 4.3} L ${cx + 4.2} ${mid + 1.6}`} fill="none" />
            </g>
          </g>
        );
      })() : info.isMerge ? (
        <>
          <circle cx={lx(info.dotLane)} cy={mid} r={6.5} fill={t.bg} stroke={dotColor} strokeWidth={2} opacity={dim ? 0.4 : 1} />
          <circle cx={lx(info.dotLane)} cy={mid} r={2.6} fill={dotColor} opacity={dim ? 0.4 : 1} />
        </>
      ) : (
        <circle cx={lx(info.dotLane)} cy={mid} r={5} fill={dotColor} opacity={dim ? 0.4 : 1} />
      )}
    </svg>
  );
}

// ─── glass helper ─────────────────────────────────────────────────────────────

function glassStyle(t: ThemeColors, extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    background: t.glass,
    backdropFilter: "blur(18px) saturate(135%)",
    WebkitBackdropFilter: "blur(18px) saturate(135%)",
    borderBottom: `0.5px solid ${t.glassBorder}`,
    ...extra,
  };
}

// ─── TitleBar ─────────────────────────────────────────────────────────────────

const THEME_CYCLE: ThemeMode[] = ["dark", "light", "system"];
const THEME_META: Record<ThemeMode, { Icon: typeof Moon; label: string }> = {
  dark:   { Icon: Moon,    label: "暗色" },
  light:  { Icon: Sun,     label: "亮色" },
  system: { Icon: Monitor, label: "跟随系统" },
};

// Windows has no native overlay title bar, so we render our own controls there.
// macOS keeps its native traffic lights (Overlay title bar) and skips these.
const IS_WINDOWS = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
const WINDOW_CONTROL_WIDTH = 44;
const WINDOW_CONTROLS_WIDTH = WINDOW_CONTROL_WIDTH * 3;
const TITLEBAR_DRAG_STRIP_HEIGHT = 8;

// Minimize / maximize / close for the borderless Windows window.
function WindowControls() {
  const t = useTheme();
  const win = getCurrentWindow();
  const hover = (bg: string, fg: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = bg; e.currentTarget.style.color = fg; },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; },
  });
  const cls = "flex items-center justify-center flex-shrink-0 cursor-pointer transition-colors duration-100";
  return (
    <div className="flex items-stretch self-stretch flex-shrink-0" style={{ marginRight: -16, marginLeft: 6 }}>
      <button title="最小化" aria-label="最小化窗口" onClick={() => { void win.minimize(); }} className={cls}
        style={{ width: WINDOW_CONTROL_WIDTH, color: t.textMuted }} {...hover(t.inputBg, t.text)}>
        <Minus size={15} />
      </button>
      <button title="最大化 / 还原" aria-label="最大化或还原窗口" onClick={() => { void win.toggleMaximize(); }} className={cls}
        style={{ width: WINDOW_CONTROL_WIDTH, color: t.textMuted }} {...hover(t.inputBg, t.text)}>
        <Square size={11} />
      </button>
      <button title="关闭" aria-label="关闭窗口" onClick={() => { void win.close(); }} className={cls}
        style={{ width: WINDOW_CONTROL_WIDTH, color: t.textMuted }} {...hover("#e81123", "#fff")}>
        <X size={16} />
      </button>
    </div>
  );
}

function TitleBar({ projects, activeId, themeMode, onThemeCycle, onSelectProject, onCloseProject, onOpenNew, onCloneNew, onOpenSettings }: {
  projects: Project[]; activeId: string; themeMode: ThemeMode;
  onThemeCycle: () => void; onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void; onOpenNew: () => void; onCloneNew: () => void; onOpenSettings: () => void;
}) {
  const t = useTheme();
  const { Icon, label } = THEME_META[themeMode];
  const iconButton = "flex items-center justify-center w-8 h-8 flex-shrink-0 cursor-pointer transition-colors duration-150";
  return (
    <div data-tauri-drag-region className="relative h-12 flex items-stretch flex-shrink-0 select-none"
      style={{ ...glassStyle(t), paddingLeft: IS_WINDOWS ? 8 : 92, zIndex: 50 }}>
      {/* Stays visually transparent while keeping a drag target above full tab rows. */}
      <div data-tauri-drag-region aria-hidden="true" className="absolute top-0"
        style={{
          left: IS_WINDOWS ? 0 : 92,
          right: IS_WINDOWS ? WINDOW_CONTROLS_WIDTH : 0,
          height: TITLEBAR_DRAG_STRIP_HEIGHT,
          zIndex: 1,
        }} />
      <ProjectTabBar projects={projects} activeId={activeId} embedded
        onSelect={onSelectProject} onClose={onCloseProject} onAdd={onOpenNew} onClone={onCloneNew} />
      <div className="flex items-center gap-0.5 px-2 flex-shrink-0"
        style={{ borderLeft: `0.5px solid ${t.glassBorder}` }}>
        <button onClick={onThemeCycle} className={iconButton}
          title={`主题：${label}`} aria-label={`切换主题，当前${label}`}
          style={{ color: t.textMuted, borderRadius: R - 3 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
          <Icon size={14} aria-hidden="true" />
        </button>
        <button onClick={onOpenSettings} className={iconButton}
          title="设置" aria-label="打开设置"
          style={{ color: t.textMuted, borderRadius: R - 3 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
          <Settings size={14} aria-hidden="true" />
        </button>
      </div>
      {IS_WINDOWS && <WindowControls />}
    </div>
  );
}

// ─── ProjectTab ───────────────────────────────────────────────────────────────

function ProjectTab({ project, isActive, isLast, onSelect, onClose }: {
  project: Project; isActive: boolean; isLast: boolean; onSelect: () => void; onClose?: () => void;
}) {
  const t = useTheme();
  const [hovered, setHovered] = useState(false);
  return (
    <div role="tab" aria-selected={isActive} tabIndex={isActive ? 0 : -1}
      className="relative flex items-center gap-2 px-3.5 cursor-pointer flex-shrink-0 select-none"
      data-tab-active={isActive || undefined}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: "100%",
        minWidth: 142, maxWidth: 196,
        background: isActive
          ? (t.isDark ? "rgba(255,255,255,0.055)" : t.bgPanel)
          : hovered ? t.rowHover : "transparent",
        borderRight: isLast ? "none" : `0.5px solid ${t.glassBorder}`,
        transition: "background 0.12s",
      }}>
      {/* Active indicator */}
      {isActive && (
        <div className="absolute bottom-0 left-3.5 right-3.5"
          style={{ height: 2, background: t.accent, borderRadius: "2px 2px 0 0" }} />
      )}
      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: project.color, opacity: isActive ? 0.85 : 0.32,
          transition: "opacity 0.15s" }} />
      <div className="flex flex-col min-w-0 flex-1 text-left gap-px">
        <span className="text-[13px] leading-tight truncate"
          style={{ color: isActive ? t.text : t.textSec, fontWeight: isActive ? 600 : 450 }}>
          {project.name}
        </span>
        <span className="text-[11px] font-mono leading-tight truncate tabular-nums"
          style={{ color: isActive ? t.textMuted : t.textFaint }}>
          {project.branch}
        </span>
      </div>
      {/* The changes badge stays in the layout at all times so the tab width never
          shifts on hover; it just fades out to reveal the close button, which is
          absolutely positioned (out of flow) and overlays the same slot. */}
      {project.changes > 0 && (
        <span className="flex-shrink-0 text-[11px] font-bold px-1.5 py-px transition-opacity duration-100"
          style={{ background: project.color + "20", color: project.color,
            border: `1px solid ${project.color}44`, borderRadius: 20,
            opacity: hovered && onClose ? 0 : 1 }}>
          {project.changes}
        </span>
      )}
      {hovered && onClose && (
        <button onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="absolute flex items-center justify-center w-5 h-5 transition-colors"
          aria-label={`关闭项目 ${project.name}`} title={`关闭 ${project.name}`}
          style={{ right: 12, top: "50%", transform: "translateY(-50%)",
            color: t.textMuted, borderRadius: 6, background: "transparent" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.redBg; e.currentTarget.style.color = t.red; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
          <X size={9} />
        </button>
      )}
    </div>
  );
}

// ─── ProjectTabBar ────────────────────────────────────────────────────────────

function ProjectTabBar({ projects, activeId, onSelect, onClose, onAdd, onClone, embedded = false }: {
  projects: Project[]; activeId: string;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onAdd: () => void; onClone: () => void;
  embedded?: boolean;
}) {
  const t = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [addMenuPos, setAddMenuPos] = useState<{ left: number; top: number } | null>(null);
  const lastId = projects[projects.length - 1]?.id;
  // Keep the active tab in view when it changes. If it's the last one, scroll
  // all the way to the end so the trailing "+" button is revealed too.
  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    if (activeId && activeId === lastId) {
      c.scrollTo({ left: c.scrollWidth, behavior: "smooth" });
    } else {
      c.querySelector<HTMLElement>("[data-tab-active]")
        ?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
    }
  }, [activeId, lastId, projects.length]);

  useEffect(() => {
    if (!addMenuPos) return;
    addMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = () => setAddMenuPos(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        addButtonRef.current?.focus();
      }
    };
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [addMenuPos]);

  const toggleAddMenu = () => {
    if (addMenuPos) { setAddMenuPos(null); return; }
    const rect = addButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 196;
    setAddMenuPos({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      top: rect.bottom + 6,
    });
  };
  const chooseAddAction = (action: () => void) => {
    setAddMenuPos(null);
    action();
  };

  return (
    <>
      <div ref={scrollRef} data-tauri-drag-region role="tablist" aria-label="打开的项目"
        className="flex items-stretch flex-1 min-w-0 select-none"
        style={{ ...(embedded ? { background: "transparent" } : glassStyle(t)),
          height: embedded ? 48 : 42, overflowX: "auto", scrollbarWidth: "none" }}>
        <div style={{ width: "0.5px", background: t.glassBorder, flexShrink: 0 }} />
        {projects.map((proj, i) => (
          <ProjectTab key={proj.id} project={proj} isActive={proj.id === activeId}
            isLast={i === projects.length - 1}
            onSelect={() => onSelect(proj.id)}
            onClose={projects.length > 1 ? () => onClose(proj.id) : undefined} />
        ))}
        <button ref={addButtonRef} onClick={toggleAddMenu}
          className="flex items-center justify-center px-3.5 flex-shrink-0 transition-colors duration-100"
          style={{ color: addMenuPos ? t.accent : t.textFaint,
            background: addMenuPos ? t.accentBg : "transparent",
            borderLeft: `0.5px solid ${t.glassBorder}` }}
          onMouseEnter={(e) => { e.currentTarget.style.color = t.textSec; e.currentTarget.style.background = addMenuPos ? t.accentBg : t.rowHover; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = addMenuPos ? t.accent : t.textFaint; e.currentTarget.style.background = addMenuPos ? t.accentBg : "transparent"; }}
          title="添加仓库" aria-label="添加仓库" aria-haspopup="menu" aria-expanded={!!addMenuPos}>
          <Plus size={14} aria-hidden="true" />
        </button>
        <div data-tauri-drag-region className="flex-1" />
      </div>

      {addMenuPos && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 80 }} onMouseDown={() => setAddMenuPos(null)} />
          <div ref={addMenuRef} role="menu" aria-label="添加仓库"
            className="fixed p-1.5 gk-modal-in"
            style={{ left: addMenuPos.left, top: addMenuPos.top, zIndex: 81, width: 196,
              background: t.dialogBg, border: `0.5px solid ${t.glassBorder}`,
              borderRadius: R, boxShadow: t.shadowWindow }}>
            <button role="menuitem" onClick={() => chooseAddAction(onAdd)}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 text-left text-xs font-medium cursor-pointer"
              style={{ color: t.text, borderRadius: R - 3 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <FolderOpen size={14} aria-hidden="true" style={{ color: t.accent }} />
              打开本地仓库
            </button>
            <button role="menuitem" onClick={() => chooseAddAction(onClone)}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 text-left text-xs font-medium cursor-pointer"
              style={{ color: t.text, borderRadius: R - 3 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <Cloud size={14} aria-hidden="true" style={{ color: t.accent2 }} />
              克隆远程仓库
            </button>
          </div>
        </>, document.body,
      )}
    </>
  );
}

// ─── ActionBar ────────────────────────────────────────────────────────────────

function ActionBar({ onCreateBranch, onFetch, onPull, onPush, onCreateTag, onCherryPick, onStash, onCreatePR, pushCount = 0, busy }: {
  onCreateBranch?: () => void;
  onFetch?: () => void; onPull?: () => void; onPush?: () => void;
  onCreateTag?: () => void;
  onCherryPick?: () => void; onStash?: () => void; onCreatePR?: () => void;
  pushCount?: number; busy?: null | "fetch" | "pull" | "push";
}) {
  const t = useTheme();
  // Hovering 推送 for >1s reveals a secondary menu (创建 Tag 并推送).
  const [pushMenu, setPushMenu] = useState(false);
  const pushTimer = useRef<number | null>(null);
  const openPushTimer = () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(() => setPushMenu(true), 1000);
  };
  const closePushMenu = () => {
    if (pushTimer.current) { clearTimeout(pushTimer.current); pushTimer.current = null; }
    setPushMenu(false);
  };
  const actions = [
    { label: "获取",       icon: RefreshCw,      accent: false, badge: 0,         separated: false },
    { label: "拉取",       icon: Download,       accent: false, badge: 0,         separated: false },
    { label: "推送",       icon: Upload,         accent: false, badge: pushCount, separated: false },
    { label: "新建分支",   icon: GitBranchPlus,  accent: false, badge: 0,         separated: true },
    { label: "合并",       icon: GitMerge,       accent: false, badge: 0,         separated: false },
    { label: "遴选",       icon: GitCommit,      accent: false, badge: 0,         separated: false },
    { label: "储藏",       icon: Layers,         accent: false, badge: 0,         separated: false },
    { label: "创建合并请求", icon: GitPullRequest, accent: true, badge: 0,         separated: true },
  ] as const;

  const handleClick = (label: string) => {
    if (label === "获取") { onFetch?.(); return; }
    if (label === "拉取") { onPull?.(); return; }
    if (label === "推送") { onPush?.(); return; }
    if (label === "新建分支") { onCreateBranch?.(); return; }
    if (label === "遴选") { onCherryPick?.(); return; }
    if (label === "储藏") { onStash?.(); return; }
    if (label === "创建合并请求") { onCreatePR?.(); return; }
    const msgs: Record<string, string> = {
      "合并": "请选择要合并到 main 的分支",
    };
    toast(msgs[label]);
  };

  const busyLabel = busy === "fetch" ? "获取" : busy === "pull" ? "拉取" : busy === "push" ? "推送" : null;

  return (
    <div className="h-[42px] flex items-center px-3 gap-0.5 flex-shrink-0 select-none"
      aria-label="仓库操作" style={{ background: t.bgPanel, borderBottom: `0.5px solid ${t.border}`,
        position: "relative", zIndex: 30 }}>
      {actions.map((a) => {
        const btn = (
          <button key={a.label} onClick={() => handleClick(a.label)}
            disabled={busyLabel === a.label}
            aria-busy={busyLabel === a.label || undefined}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-[color,background-color,opacity,transform] duration-150 cursor-pointer active:scale-[0.98]"
            style={{ color: a.accent ? "#fff" : t.textSec, borderRadius: R - 3,
              marginLeft: a.separated ? 8 : 0,
              borderLeft: a.separated && !a.accent ? `0.5px solid ${t.border}` : "none",
              paddingLeft: a.separated && !a.accent ? 14 : 10,
              background: a.accent ? t.accent : "transparent",
              boxShadow: a.accent ? (t.isDark ? "inset 0 1px 0 rgba(255,255,255,0.14)" : "inset 0 1px 0 rgba(255,255,255,0.24)") : "none" }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = a.accent ? t.accent : t.inputBg;
              e.currentTarget.style.color = a.accent ? "#fff" : t.text;
              if (a.accent) e.currentTarget.style.opacity = "0.88";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = a.accent ? t.accent : "transparent";
              e.currentTarget.style.color = a.accent ? "#fff" : t.textSec;
              e.currentTarget.style.opacity = "1";
            }}>
            <a.icon size={13} strokeWidth={1.8} aria-hidden="true" className={busyLabel === a.label ? "animate-spin" : undefined} />
            <span>{a.label}</span>
            {a.badge > 0 && (
              <span className="flex items-center justify-center rounded-full text-[11px] font-bold ml-0.5"
                style={{ minWidth: 16, height: 16, padding: "0 4px", background: t.accent, color: "#fff" }}>
                {a.badge}
              </span>
            )}
          </button>
        );
        // 推送 gets a hover-revealed secondary menu for tag-and-push.
        if (a.label === "推送" && onCreateTag) {
          return (
            <div key={a.label} className="relative"
              onMouseEnter={openPushTimer} onMouseLeave={closePushMenu}>
              {btn}
              {pushMenu && (
                // paddingTop bridges the 4px gap so moving button→menu never
                // leaves the hover area (the gap is a descendant, not open space).
                <div className="absolute left-0 top-full" style={{ paddingTop: 4, zIndex: 80 }}>
                  <div className="py-1 gk-modal-in"
                    style={{ minWidth: 168, background: t.dialogBg, border: `0.5px solid ${t.glassBorder}`,
                      borderRadius: R, boxShadow: t.shadowWindow }}>
                    <button onClick={() => { closePushMenu(); onCreateTag(); }}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium text-left cursor-pointer"
                      style={{ color: t.textMuted }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.text; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
                      <TagIcon size={12} /> 创建 Tag 并推送
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        }
        return btn;
      })}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function SidebarSection({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  const t = useTheme();
  return (
    <button onClick={onToggle}
      className="flex items-center gap-1.5 w-full px-3 py-2.5 text-left transition-colors duration-150 cursor-pointer"
      style={{ color: t.textFaint, borderRadius: R - 2 }}
      onMouseEnter={(e) => (e.currentTarget.style.color = t.textMuted)}
      onMouseLeave={(e) => (e.currentTarget.style.color = t.textFaint)}>
      <ChevronRight size={10} className="flex-shrink-0 transition-transform duration-200"
        style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }} />
      <span className="text-[10px] font-semibold tracking-[0.06em]">{label}</span>
    </button>
  );
}

function Sidebar({ branches, remotes, stashes, currentBranch, focusBranch, hidden, setHidden,
  pinned, setPinned, collapsed, setCollapsed,
  onFocus, onShowAll, onHoverBranch, onCheckout, onBranchContext, onSyncRemote, onRemoteContext, onStashClick, onStashApply, onStashDrop, onStashContext, selectedStashIndex }: {
  branches: Branch[]; remotes: Remote[]; stashes: Stash[];
  currentBranch: string; focusBranch: string | null;
  hidden: string[]; setHidden: React.Dispatch<React.SetStateAction<string[]>>;
  pinned: string[]; setPinned: React.Dispatch<React.SetStateAction<string[]>>;
  collapsed: string[]; setCollapsed: React.Dispatch<React.SetStateAction<string[]>>;
  onFocus: (name: string) => void; onShowAll: () => void;
  onHoverBranch: (name: string | null) => void;
  onCheckout?: (name: string) => void;
  onBranchContext?: (e: React.MouseEvent, b: Branch) => void;
  onSyncRemote?: (remoteName: string, leaf: string) => void;
  onRemoteContext?: (e: React.MouseEvent, remoteName: string, leaf: string) => void;
  onStashClick?: (s: Stash) => void;
  onStashApply?: (index: number) => void; onStashDrop?: (index: number) => void;
  onStashContext?: (e: React.MouseEvent, s: Stash) => void;
  selectedStashIndex?: number | null;
}) {
  const t = useTheme();
  const [branchesOpen, setBranchesOpen] = useState(true);
  const [stashesOpen,  setStashesOpen]  = useState(true);
  const [remotesOpen,  setRemotesOpen]  = useState(false);
  const [openRemotes,  setOpenRemotes]  = useState<string[]>([]);
  // Remote folders default to COLLAPSED, so this tracks the ones expanded (empty
  // ⇒ all collapsed) — the inverse of `collapsed`, which local folders use.
  const [openRemoteFolders, setOpenRemoteFolders] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);

  const togglePin  = (n: string) => setPinned((p) => p.includes(n) ? p.filter((x) => x !== n) : [...p, n]);
  const toggleHide = (n: string) => setHidden((p) => p.includes(n) ? p.filter((x) => x !== n) : [...p, n]);
  const toggleRemote = (n: string) => setOpenRemotes((p) => p.includes(n) ? p.filter((x) => x !== n) : [...p, n]);
  const toggleFolder = (f: string) => setCollapsed((p) => p.includes(f) ? p.filter((x) => x !== f) : [...p, f]);
  const toggleRemoteFolder = (k: string) => setOpenRemoteFolders((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]);

  const itemStyle = (active: boolean): React.CSSProperties => ({
    borderRadius: R - 2,
    margin: "2px 7px",
    background: active ? t.rowSelected : "transparent",
    boxShadow: active ? `inset 2px 0 0 ${t.accent}` : "none",
    transition: "background 0.12s, box-shadow 0.12s",
  });

  // The current (checked-out) branch is marked with a deepened neutral pill
  // instead of a tick — a filled row reads as "you are here" far more clearly.
  const currentBg      = t.rowCurrent;
  const currentBgHover = t.rowCurrentHover;

  const renderBranch = (b: Branch, leaf?: string, indent?: boolean) => {
    const active = focusBranch === b.name;   // single-branch focus view
    // Background priority: focus tint (coral) > current-branch pill (neutral).
    const baseBg = active ? t.rowSelected : b.current ? currentBg : "transparent";
    return (
      <div key={b.name} role="button" tabIndex={0} onClick={() => onFocus(b.name)} onDoubleClick={() => onCheckout?.(b.name)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocus(b.name); } }}
        onContextMenu={(e) => onBranchContext?.(e, b)}
        className="group flex items-center gap-2 pr-2 cursor-pointer"
        style={{ ...itemStyle(active), background: baseBg, paddingLeft: indent ? 26 : 12, height: 32 }}
        title={b.worktree
          ? `${b.name}\n已被工作树占用：${b.worktree}\n无法直接切换或删除`
          : `单击只看此分支 · 双击切换到 ${b.name}`}
        onMouseEnter={(e) => { onHoverBranch(b.name); if (!active) e.currentTarget.style.background = b.current ? currentBgHover : t.rowHover; }}
        onMouseLeave={(e) => { onHoverBranch(null); if (!active) e.currentTarget.style.background = baseBg; }}>
        <div className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: b.color, opacity: b.current ? 0.9 : 0.42 }} />
        <span className="text-xs flex-1 truncate"
          style={{ color: active ? t.accentFg : b.current ? t.text : t.textSec, fontWeight: b.current ? 600 : 400 }}>
          {leaf ?? b.name}
        </span>
        {/* held by a linked worktree → neither checkout nor delete can proceed */}
        {b.worktree && (
          <FolderGit2 size={11} className="flex-shrink-0" style={{ color: t.textFaint }} />
        )}
        {/* hover: pin / hide */}
        <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
          <button onClick={(e) => { e.stopPropagation(); togglePin(b.name); }} className="p-0.5"
            title={pinned.includes(b.name) ? "取消置顶" : "置顶"}
            style={{ color: pinned.includes(b.name) ? t.accent : t.textMuted }}>
            <Pin size={11} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); toggleHide(b.name); }} className="p-0.5"
            title="隐藏分支" style={{ color: t.textMuted }}>
            <EyeOff size={11} />
          </button>
        </div>
        {/* default: ahead/behind counters (current branch no longer needs a tick) */}
        <div className="flex group-hover:hidden items-center gap-1 flex-shrink-0">
          {b.ahead  > 0 && <span className="text-[11px]" style={{ color: t.green + "cc" }}>↑{b.ahead}</span>}
          {b.behind > 0 && <span className="text-[11px]" style={{ color: t.amber + "cc" }}>↓{b.behind}</span>}
        </div>
      </div>
    );
  };

  // One remote-branch leaf (远程 → origin → …). `label` is what's shown (the last
  // path segment inside a folder, or the whole leaf at the root); `leaf` is the
  // full branch name under the remote used for actions. `pad` sets the indent so
  // folder children sit deeper than roots.
  const renderRemoteLeaf = (remoteName: string, leaf: string, label: string, pad: number) => {
    const hasLocal = branches.some((b) => b.name === leaf);
    const isCurrent = leaf === currentBranch;
    return (
      <div key={`${remoteName}/${leaf}`}
        onDoubleClick={() => onSyncRemote?.(remoteName, leaf)}
        onContextMenu={(e) => onRemoteContext?.(e, remoteName, leaf)}
        className="flex items-center gap-2 pr-2 py-1 cursor-pointer select-none"
        style={{ paddingLeft: pad, borderRadius: R - 2, margin: "0 8px 0 0",
          background: isCurrent ? t.rowCurrent : "transparent", transition: "background 0.12s" }}
        title={hasLocal ? `双击切换到本地分支 ${leaf}` : `双击将 ${remoteName}/${leaf} 同步到本地并检出`}
        onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = t.rowHover; }}
        onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}>
        <GitBranch size={10} className="flex-shrink-0" style={{ color: isCurrent ? t.accent : t.textFaint }} />
        <span className="text-[11px] truncate flex-1" style={{ color: isCurrent ? t.accentFg : t.textMuted }}>{label}</span>
        {hasLocal
          ? <Laptop size={10} className="flex-shrink-0" style={{ color: t.textFaint }} />
          : <Download size={10} className="flex-shrink-0" style={{ color: t.textFaint }} />}
      </div>
    );
  };

  const visible = branches.filter((b) => !hidden.includes(b.name));
  const pinnedBranches = visible.filter((b) => pinned.includes(b.name));
  const rest = visible.filter((b) => !pinned.includes(b.name));
  const roots = rest.filter((b) => !b.name.includes("/"));
  const folderMap = new Map<string, Branch[]>();
  rest.filter((b) => b.name.includes("/")).forEach((b) => {
    const f = b.name.slice(0, b.name.indexOf("/"));
    if (!folderMap.has(f)) folderMap.set(f, []);
    folderMap.get(f)!.push(b);
  });
  const hiddenBranches = branches.filter((b) => hidden.includes(b.name));

  return (
    <div className="w-[212px] flex-shrink-0 flex flex-col overflow-y-auto select-none"
      style={{ background: t.sidebarBg,
        backdropFilter: "blur(12px) saturate(110%)",
        WebkitBackdropFilter: "blur(12px) saturate(110%)",
        borderRight: `0.5px solid ${t.glassBorder}` }}>

      <div className="pt-2.5">
        {/* Global "all branches" view toggle — active when no branch is focused */}
        <button onClick={onShowAll}
          className="flex items-center gap-2 mx-[7px] mb-1 px-2.5 cursor-pointer"
          style={{ height: 32, borderRadius: R - 2,
            background: focusBranch === null ? t.accentBg : "transparent",
            color: focusBranch === null ? t.accentFg : t.textSec,
            boxShadow: focusBranch === null ? `inset 2px 0 0 ${t.accent}` : "none" }}
          onMouseEnter={(e) => { if (focusBranch !== null) e.currentTarget.style.background = t.rowHover; }}
          onMouseLeave={(e) => { if (focusBranch !== null) e.currentTarget.style.background = "transparent"; }}>
          <LayoutGrid size={13} className="flex-shrink-0"
            style={{ color: focusBranch === null ? t.accent : t.textMuted }} />
          <span className="text-xs font-medium flex-1 text-left truncate">全部视图</span>
          {focusBranch === null && <Check size={12} strokeWidth={2.2} style={{ color: t.accent }} />}
        </button>
        <SidebarSection label="分支" open={branchesOpen} onToggle={() => setBranchesOpen(!branchesOpen)} />
        {branchesOpen && (
          <div className="pb-2">
            {pinnedBranches.length > 0 && (
              <>
                <div className="flex items-center gap-1 px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: t.textFaint }}>
                  <Pin size={9} /> 置顶
                </div>
                {pinnedBranches.map((b) => renderBranch(b))}
                <div style={{ height: "0.5px", background: t.border, margin: "4px 10px" }} />
              </>
            )}

            {roots.map((b) => renderBranch(b))}

            {Array.from(folderMap.keys()).sort().map((folder) => {
              const list = folderMap.get(folder)!;
              const isCol = collapsed.includes(folder);
              return (
                <div key={folder}>
                  <div onClick={() => toggleFolder(folder)}
                    className="group w-full flex items-center gap-1.5 px-3 cursor-pointer"
                    style={{ color: t.textSec, height: 30 }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = t.text)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = t.textSec)}>
                    <ChevronRight size={11} className="flex-shrink-0 transition-transform duration-200"
                      style={{ transform: isCol ? "rotate(0deg)" : "rotate(90deg)" }} />
                    <Folder size={12} className="flex-shrink-0" style={{ color: t.textMuted }} />
                    <span className="text-xs font-medium flex-1 truncate text-left">{folder}</span>
                    <button onClick={(e) => { e.stopPropagation(); setHidden((prev) => Array.from(new Set([...prev, ...list.map((b) => b.name)]))); }}
                      className="hidden group-hover:flex p-0.5 flex-shrink-0" title="隐藏整个文件夹"
                      style={{ color: t.textMuted }}>
                      <EyeOff size={11} />
                    </button>
                    <span className="text-[11px] flex-shrink-0 group-hover:hidden" style={{ color: t.textFaint }}>{list.length}</span>
                  </div>
                  {!isCol && list.map((b) => renderBranch(b, b.name.slice(folder.length + 1), true))}
                </div>
              );
            })}

            {hiddenBranches.length > 0 && (
              <>
                <button onClick={() => setShowHidden((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 mt-1 cursor-pointer"
                  style={{ color: t.textFaint }}>
                  <EyeOff size={10} className="flex-shrink-0" />
                  <span className="text-[11px] flex-1 text-left">已隐藏 ({hiddenBranches.length})</span>
                  <ChevronRight size={10} className="flex-shrink-0 transition-transform duration-200"
                    style={{ transform: showHidden ? "rotate(90deg)" : "rotate(0deg)" }} />
                </button>
                {showHidden && hiddenBranches.map((b) => (
                  <div key={b.name} className="group flex items-center gap-2 pr-2 py-1.5"
                    style={{ ...itemStyle(false), paddingLeft: 26, opacity: 0.65 }}>
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color, opacity: 0.4 }} />
                    <span className="text-xs flex-1 truncate" style={{ color: t.textMuted }}>{b.name}</span>
                    <button onClick={() => toggleHide(b.name)} className="p-0.5" title="取消隐藏"
                      style={{ color: t.textMuted }}>
                      <Eye size={11} />
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div className="pt-1" style={{ borderTop: `0.5px solid ${t.border}` }}>
        <SidebarSection label="远程" open={remotesOpen} onToggle={() => setRemotesOpen(!remotesOpen)} />
        {remotesOpen && (
          <div className="pb-2">
            {remotes.length === 0 && (
              <div className="px-4 py-1.5 text-[11px]" style={{ color: t.textFaint }}>无远程</div>
            )}
            {remotes.map((r) => {
              const open = openRemotes.includes(r.name);
              return (
                <div key={r.name}>
                  <div onClick={() => toggleRemote(r.name)}
                    className="flex items-center gap-1.5 px-3 cursor-pointer"
                    style={{ color: t.textSec, height: 30 }}
                    title={r.url}
                    onMouseEnter={(e) => (e.currentTarget.style.color = t.text)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = t.textSec)}>
                    <ChevronRight size={11} className="flex-shrink-0 transition-transform duration-200"
                      style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }} />
                    <Cloud size={12} className="flex-shrink-0" style={{ color: t.textMuted }} />
                    <span className="text-xs font-medium flex-1 truncate text-left">{r.name}</span>
                    <span className="text-[11px] flex-shrink-0" style={{ color: t.textFaint }}>{r.branches.length}</span>
                  </div>
                  {open && (() => {
                    // Group this remote's branches into folders by the first path
                    // segment (feat/master → "feat"), same as the local tree. Folder
                    // collapse state is namespaced by remote ("origin/feat") so it's
                    // independent of a same-named local folder.
                    const rootLeaves = r.branches.filter((leaf) => !leaf.includes("/"));
                    const folders = new Map<string, string[]>();
                    r.branches.filter((leaf) => leaf.includes("/")).forEach((leaf) => {
                      const f = leaf.slice(0, leaf.indexOf("/"));
                      if (!folders.has(f)) folders.set(f, []);
                      folders.get(f)!.push(leaf);
                    });
                    return (
                      <>
                        {rootLeaves.map((leaf) => renderRemoteLeaf(r.name, leaf, leaf, 40))}
                        {Array.from(folders.keys()).sort().map((folder) => {
                          const key = `${r.name}/${folder}`;
                          const isCol = !openRemoteFolders.includes(key); // default collapsed
                          const list = folders.get(folder)!;
                          return (
                            <div key={key}>
                              <div onClick={() => toggleRemoteFolder(key)}
                                className="flex items-center gap-1.5 px-3 cursor-pointer"
                                style={{ color: t.textSec, height: 28, paddingLeft: 40 }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = t.text)}
                                onMouseLeave={(e) => (e.currentTarget.style.color = t.textSec)}>
                                <ChevronRight size={11} className="flex-shrink-0 transition-transform duration-200"
                                  style={{ transform: isCol ? "rotate(0deg)" : "rotate(90deg)" }} />
                                <Folder size={12} className="flex-shrink-0" style={{ color: t.textMuted }} />
                                <span className="text-[11px] font-medium flex-1 truncate text-left">{folder}</span>
                                <span className="text-[11px] flex-shrink-0" style={{ color: t.textFaint }}>{list.length}</span>
                              </div>
                              {!isCol && list.map((leaf) => renderRemoteLeaf(r.name, leaf, leaf.slice(folder.length + 1), 56))}
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="pt-1" style={{ borderTop: `0.5px solid ${t.border}` }}>
        <SidebarSection label="储藏" open={stashesOpen} onToggle={() => setStashesOpen(!stashesOpen)} />
        {stashesOpen && (
          <div className="pb-2">
            {stashes.length === 0 && (
              <div className="px-3 py-1.5 text-[11px]" style={{ color: t.textFaint, margin: "0 8px" }}>
                暂无储藏
              </div>
            )}
            {stashes.map((s) => {
              const sel = selectedStashIndex === s.index;
              return (
              <div key={s.index} className="group flex items-center gap-2 px-3 py-1.5 cursor-pointer"
                style={itemStyle(sel)}
                onClick={() => onStashClick?.(s)}
                onContextMenu={(e) => onStashContext?.(e, s)}
                onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = t.rowHover; }}
                onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = "transparent"; }}>
                <Layers size={10} className="flex-shrink-0" style={{ color: sel ? t.accent : t.textFaint }} />
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[12px] font-mono flex-shrink-0" style={{ color: t.textMuted }}>
                      {"stash@{" + s.index + "}"}
                    </span>
                    {s.date && <span className="text-[10px] truncate" style={{ color: t.textFaint }}>· {s.date}</span>}
                  </div>
                  <span className="text-[12px] truncate" style={{ color: t.textFaint }}>{s.message}</span>
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button title="应用到工作区" onClick={(e) => { e.stopPropagation(); onStashApply?.(s.index); }}
                    className="p-1 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 4 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.accent; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
                    <RotateCcw size={12} />
                  </button>
                  <button title="删除储藏" onClick={(e) => { e.stopPropagation(); onStashDrop?.(s.index); }}
                    className="p-1 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 4 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = t.redBg; e.currentTarget.style.color = t.red; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ); })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── CommitRow ────────────────────────────────────────────────────────────────

// If a tag is a remote ref (`origin/foo`), return its branch part (`foo`); else null.
function remoteRefName(tag: string, remoteNames: string[]): string | null {
  for (const r of remoteNames) if (tag.startsWith(r + "/")) return tag.slice(r.length + 1);
  return null;
}

// Ref pills with a local/remote status:
//  head — the checked-out HEAD;  both — local branch synced with its remote here;
//  local — local branch only (not on remote at this commit);  remote — remote-only;
//  tag — a version tag.
type RefKind = "head" | "local" | "remote" | "both" | "tag";
function refBadges(tags: string[], remoteNames: string[]): { name: string; kind: RefKind }[] {
  let head = false;
  const localNames: string[] = [];
  const remoteSimple = new Map<string, boolean>();
  for (const tag of tags) {
    if (tag === "HEAD") { head = true; continue; }
    if (tag.endsWith("/HEAD")) continue;
    const rem = remoteRefName(tag, remoteNames);
    if (rem !== null) remoteSimple.set(rem, true);
    else localNames.push(tag);
  }
  const out: { name: string; kind: RefKind }[] = [];
  if (head) out.push({ name: "HEAD", kind: "head" });
  for (const name of localNames) {
    if (/^v\d/.test(name)) { out.push({ name, kind: "tag" }); continue; }
    if (remoteSimple.has(name)) { out.push({ name, kind: "both" }); remoteSimple.delete(name); }
    else out.push({ name, kind: "local" });
  }
  for (const name of remoteSimple.keys()) out.push({ name, kind: "remote" });
  return out;
}

// Inline branch/HEAD/tag capsules, shown once on a commit's tip row right beside
// the message. Their surfaces stay neutral; the small source icons retain the
// graph colour so refs remain traceable without turning the row into a colour wall.
// Long names truncate; hovering expands to the full name (see RefPill).
function InlineRefs({ tags, remoteNames, onDblClick }: {
  tags: string[]; remoteNames: string[]; onDblClick?: (name: string) => void;
}) {
  const t = useTheme();
  const badges = refBadges(tags, remoteNames);
  if (badges.length === 0) return null;
  return (
    <div className="flex items-center gap-1 overflow-hidden" style={{ flexWrap: "nowrap" }}>
      {badges.map((b) =>
        b.kind === "head" ? (
          <span key="HEAD" className="px-1.5 py-0.5 text-[10px] font-mono font-semibold flex-shrink-0"
            style={{ background: t.accentBg, color: t.accentFg, border: `0.5px solid ${t.accent}55`, borderRadius: R - 4 }}>
            HEAD
          </span>
        ) : (
          <RefPill key={b.name} b={b} onDblClick={onDblClick} />
        ),
      )}
    </div>
  );
}

// One inline branch/tag capsule. Truncated to maxWidth; on hover it shows the full
// name as an opaque overlay. The overlay is portalled to <body> at fixed coords so
// it escapes the row's paint containment (content-visibility) and the ref line's
// overflow-hidden — an in-row absolute overlay would be clipped. It's pointer-events:
// none so hovering it doesn't steal the pointer from the wrapper (no flicker); the
// wrapper keeps the hover + the double-click-to-checkout target.
function RefPill({ b, onDblClick }: {
  b: { kind: string; name: string }; onDblClick?: (name: string) => void;
}) {
  const t = useTheme();
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const c = b.kind === "tag" ? t.amber : branchColor(b.name);
  const hasLocal = b.kind === "local" || b.kind === "both";
  const hasRemote = b.kind === "remote" || b.kind === "both";
  const tip = b.kind === "both" ? "本地 + 远端(已同步)" : b.kind === "local" ? "仅本地(未推送)"
    : b.kind === "remote" ? "仅远端" : "标签";
  const cls = "flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono font-semibold";
  const icons = (
    <>
      {hasLocal && <Laptop size={11} strokeWidth={2} className="flex-shrink-0" style={{ color: c }} />}
      {hasRemote && <Cloud size={11} strokeWidth={2} className="flex-shrink-0" style={{ color: c }} />}
    </>
  );
  return (
    <span ref={ref} className="relative inline-flex min-w-0 cursor-pointer" style={{ maxWidth: 176 }}
      title={`${b.name} - ${tip}\n双击检出并同步`}
      onMouseEnter={() => { const r = ref.current?.getBoundingClientRect(); if (r) setPos({ left: r.left, top: r.top }); }}
      onMouseLeave={() => setPos(null)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); onDblClick?.(b.name); }}>
      {/* Collapsed pill — hidden (but keeps its width) while the overlay shows. */}
      <span className={`${cls} w-full min-w-0`}
        style={{ background: t.inputBg, color: b.kind === "tag" ? t.amber : t.textSec,
          border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 4,
          visibility: pos ? "hidden" : "visible" }}>
        {icons}<span className="truncate min-w-0">{b.name}</span>
      </span>
      {pos && createPortal(
        <span className={`${cls} whitespace-nowrap`}
          style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 100, pointerEvents: "none",
            background: t.dialogBg, color: b.kind === "tag" ? t.amber : t.text,
            border: `0.5px solid ${c}66`, borderRadius: R - 4, boxShadow: t.shadowEl }}>
          {icons}<span>{b.name}</span>
        </span>,
        document.body,
      )}
    </span>
  );
}


function CommitRow({ commit, graphInfo, selected, highlight = false, graphW = GRAPH_W_MAX, laneStep = LANE_STEP, remoteNames = [], onBranchDblClick, onClick, onContextMenu }: {
  commit: Commit; graphInfo: GraphRowInfo; selected: boolean; highlight?: boolean; graphW?: number; laneStep?: number;
  remoteNames?: string[]; onBranchDblClick?: (name: string) => void; onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useTheme();
  const [hovered, setHovered] = useState(false);
  const laneColor = graphInfo.colors?.dot ?? getLC(graphInfo.dotLane);
  const isMerge = commit.parents.length > 1;
  // Refs (branch tips / HEAD / tags) only ever sit on their tip commit, so they
  // render inline once — no separate gutter column, no per-commit backbone list.
  const hasRefs = refBadges(commit.tags ?? [], remoteNames).length > 0;
  // Deterministic height (all content is single-line) → no per-row measurement,
  // which lets us use content-visibility for smooth scrolling on long histories.
  // Merges no longer take their own row — the glyph sits inline on the message line.
  const parts: number[] = [];
  if (hasRefs) parts.push(20);   // inline ref-capsule line (tip commits only)
  parts.push(22, 20);            // message + meta
  const rowH = 20 + parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * 6;
  return (
    <div onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative cursor-pointer"
      style={{ height: rowH, borderBottom: `0.5px solid ${t.border}`,
        contentVisibility: "auto", containIntrinsicSize: `0 ${rowH}px` }}>
      {/* Inset selection overlay keeps the graph topology readable. */}
      <div className="absolute pointer-events-none"
        style={{
          top: 2, bottom: 2, left: 5, right: 5,
          borderRadius: R - 3,
          background: selected ? t.accentBg : highlight ? laneColor + "16" : hovered ? t.rowHover : "transparent",
          transition: "background 0.1s",
          boxShadow: highlight && !selected ? `inset 0 0 0 0.5px ${laneColor}44` : "none",
        }} />
      <div className="relative flex items-start">
        {/* Graph sits flush-left — the topology lanes carry the branch colours. */}
        <div style={{ width: graphW, flexShrink: 0 }}>
          <GraphRowSVG info={graphInfo} height={rowH} width={graphW} step={laneStep} stash={commit.isStash} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center py-2.5 pr-3 gap-1.5">
          {/* Branch/HEAD/tag capsules — coloured to match their lane, shown once on
              the tip commit, right next to the message. */}
          <InlineRefs tags={commit.tags ?? []} remoteNames={remoteNames} onDblClick={onBranchDblClick} />
          {/* Merge: a small lane-coloured glyph inline on the message line — the
              coloured graph lines now carry the "who merged into whom", so no badge row. */}
          <div className="flex items-center gap-1.5 min-w-0">
            {isMerge && (
              <GitMerge size={13} className="flex-shrink-0" style={{ color: laneColor }}
                aria-label="合并提交" />
            )}
            <span className="text-sm leading-snug truncate"
              style={{ color: t.text, fontWeight: selected ? 600 : 500 }}>
              {commit.message}
            </span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <Avatar author={commit.author} size={16} />
            <span className="text-[12px] truncate" style={{ color: t.textMuted }}>{commit.author.name}</span>
            <span className="text-[11px] font-mono flex-shrink-0" style={{ color: t.textFaint }}>{commit.hash}</span>
            <span className="text-[11px] ml-auto flex-shrink-0" style={{ color: t.textFaint }}>
              {formatRelativeTime(commit.date)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Diff rendering ─────────────────────────────────────────────────────────────

type DiffRowData = {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  oldNo: number | null; newNo: number | null; text: string;
};

// Parse unified-diff lines into rows carrying old/new line numbers, taken from
// each `@@ -a,b +c,d @@` hunk header. Line numbers start at 1 so a header-less
// diff (an untracked file's synthetic all-additions preview) numbers correctly.
function parseDiffRows(lines: string[]): DiffRowData[] {
  let oldNo = 1, newNo = 1;
  const rows: DiffRowData[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
    } else if (line.startsWith("\\")) {           // "\ No newline at end of file"
      rows.push({ kind: "meta", oldNo: null, newNo: null, text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "ctx", oldNo, newNo, text });
      oldNo++; newNo++;
    }
  }
  return rows;
}

// One diff row: [line #] [sign] [code]. A single line-number gutter (the new
// number, or the old number for a deleted line) keeps things compact and
// perfectly aligned. The gutter and the +/− sign are `user-select: none`, so
// selecting/copying a diff yields clean source with no numbers or leading signs.
// `min-w-full` keeps the row background spanning the full horizontal scroll width.
function DiffRow({ row, gutterW }: { row: DiffRowData; gutterW: number }) {
  const t = useTheme();
  const s = row.kind === "add"  ? { bg: t.greenBg,  color: t.green,  side: t.green + "55" }
          : row.kind === "del"  ? { bg: t.redBg,    color: t.red,    side: t.red   + "55" }
          : row.kind === "hunk" ? { bg: t.accentBg, color: t.accent, side: "transparent" }
          :                       { bg: "transparent", color: t.textMuted, side: "transparent" };
  const lineNo = row.kind === "del" ? row.oldNo : row.newNo;
  const gutterStyle: React.CSSProperties = {
    width: gutterW, minWidth: gutterW, boxSizing: "border-box",
    paddingLeft: 12, paddingRight: 10, textAlign: "right",
    color: t.textFaint, userSelect: "none", WebkitUserSelect: "none",
  };
  const signStyle: React.CSSProperties = { color: s.color, userSelect: "none", WebkitUserSelect: "none" };
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
  return (
    <div className="flex font-mono text-[11px] leading-relaxed min-w-full" style={{ background: s.bg }}>
      <div className="flex-shrink-0" style={gutterStyle}>{lineNo ?? ""}</div>
      <div className="w-1 flex-shrink-0" style={{ background: s.side }} />
      {row.kind === "hunk" || row.kind === "meta" ? (
        <span className="px-2 whitespace-pre select-none" style={signStyle}>{row.text || " "}</span>
      ) : (
        <>
          {/* Fixed-width sign column so a blank (context) sign holds the same
              width as +/− and the code columns stay aligned across all rows. */}
          <span className="flex-shrink-0 select-none text-center" style={{ ...signStyle, width: 20 }}>{sign}</span>
          <span className="whitespace-pre pr-4" style={{ color: s.color }}>{row.text || " "}</span>
        </>
      )}
    </div>
  );
}

// Parse + render a set of diff lines with a line-number gutter sized to the
// widest number. Emitted inside the caller's scroll wrapper.
function DiffRows({ lines }: { lines: string[] }) {
  const rows = parseDiffRows(lines);
  const maxNo = rows.reduce((m, r) => Math.max(m, r.oldNo ?? 0, r.newNo ?? 0), 0);
  const gutterW = Math.max(String(maxNo).length, 2) * 9 + 22;
  return <>{rows.map((r, i) => <DiffRow key={i} row={r} gutterW={gutterW} />)}</>;
}

// ─── CommitDetail ─────────────────────────────────────────────────────────────

// Shared body for commit- and stash-detail panes: a file list on the left and
// the selected file's diff on the right. The header above it differs per caller.
function FileDiffView({ files, selectedFile, onFileSelect, emptyHint = "无文件更改" }: {
  files: CommitFile[]; selectedFile: CommitFile | null;
  onFileSelect: (f: CommitFile | null) => void; emptyHint?: string;
}) {
  const t = useTheme();
  const fss = (s: CommitFile["status"]) => ({
    added:    { label: "A", color: t.green },
    modified: { label: "M", color: t.amber },
    deleted:  { label: "D", color: t.red },
    renamed:  { label: "R", color: "#60a5fa" },
  })[s];
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* File list */}
      <div className="w-[225px] flex-shrink-0 overflow-y-auto"
        style={{ borderRight: `0.5px solid ${t.border}` }}>
        <div className="py-2">
          {files.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <GitMerge size={22} className="mx-auto mb-2 opacity-20" style={{ color: t.textMuted }} />
              <p className="text-xs" style={{ color: t.textFaint }}>{emptyHint}</p>
            </div>
          ) : files.map((file) => {
            const st = fss(file.status);
            const isSel = selectedFile?.path === file.path;
            const parts = file.path.split("/"), name = parts.pop()!;
            return (
              <button key={file.path} onClick={() => onFileSelect(isSel ? null : file)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer transition-colors"
                style={{ margin: "1px 6px", width: "calc(100% - 12px)",
                  background: isSel ? t.rowSelected : "transparent", borderRadius: R - 2 }}
                onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = t.rowHover; }}
                onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}>
                <span className="text-[12px] font-mono font-bold w-3 text-center flex-shrink-0" style={{ color: st.color }}>{st.label}</span>
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-xs truncate" style={{ color: isSel ? t.accentFg : t.textSec }}>{name}</span>
                  {parts.length > 0 && <span className="text-[12px] truncate" style={{ color: t.textFaint }}>{parts.join("/")}</span>}
                </div>
                <div className="flex gap-1 flex-shrink-0 font-mono text-[11px]">
                  {file.additions > 0 && <span style={{ color: t.green + "88" }}>+{file.additions}</span>}
                  {file.deletions > 0 && <span style={{ color: t.red   + "88" }}>−{file.deletions}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Diff */}
      <div className="flex-1 overflow-auto" style={{ background: t.diffBg }}>
        {selectedFile ? (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-2.5"
              style={{ backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
                background: t.diffHeaderBg,
                borderBottom: `0.5px solid ${t.border}` }}>
              <span className="font-mono font-bold text-[12px]" style={{ color: fss(selectedFile.status).color }}>
                {fss(selectedFile.status).label}
              </span>
              <span className="font-mono text-xs" style={{ color: t.textSec }}>{selectedFile.path}</span>
              <div className="ml-auto flex gap-3 font-mono text-[12px]">
                <span style={{ color: t.green + "99" }}>+{selectedFile.additions}</span>
                <span style={{ color: t.red   + "99" }}>−{selectedFile.deletions}</span>
              </div>
            </div>
            {selectedFile.diff ? (() => {
              const lines = selectedFile.diff.split("\n");
              const shown = lines.length > DIFF_RENDER_CAP ? lines.slice(0, DIFF_RENDER_CAP) : lines;
              return (
                <div className="py-2 w-max min-w-full">
                  <DiffRows lines={shown} />
                  {lines.length > DIFF_RENDER_CAP && (
                    <div className="px-4 py-3 text-[11px] text-center" style={{ color: t.textFaint }}>
                      差异较长,仅显示前 {DIFF_RENDER_CAP} 行
                    </div>
                  )}
                </div>
              );
            })() : <div className="flex items-center justify-center h-24 text-xs" style={{ color: t.textFaint }}>无差异预览</div>}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: t.textFaint }}>
            <FileText size={28} opacity={0.25} />
            <span className="text-xs">点击文件查看差异</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CommitDetail({ commit, selectedFile, onFileSelect, onCherryPick, onCheckout, checkoutBranch }: {
  commit: Commit; selectedFile: CommitFile | null; onFileSelect: (f: CommitFile | null) => void;
  onCherryPick?: () => void; onCheckout?: () => void; checkoutBranch?: string | null;
}) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const copyHash = () => {
    navigator.clipboard.writeText(commit.fullHash).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: t.bgPanel }}>
      <div className="flex-shrink-0 p-5" style={{ borderBottom: `0.5px solid ${t.border}` }}>
        <div className="flex items-start gap-3 mb-4">
          <Avatar author={commit.author} size={44} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold" style={{ color: t.text }}>{commit.author.name}</div>
            <div className="text-xs mt-0.5" style={{ color: t.textMuted }}>{commit.author.email}</div>
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-xs" style={{ color: t.textMuted }}>{formatRelativeTime(commit.date)}</div>
            <div className="text-[12px] mt-0.5" style={{ color: t.textFaint }}>{formatFullDate(commit.date)}</div>
          </div>
        </div>
        <div className="text-sm font-semibold leading-snug mb-2" style={{ color: t.text }}>{commit.message}</div>
        {commit.body && (
          <div className="text-xs leading-relaxed mb-3 whitespace-pre-wrap" style={{ color: t.textMuted }}>
            {commit.body}
          </div>
        )}
        <div className="flex items-center gap-3 mt-3">
          <button onClick={copyHash}
            className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2,
              border: `0.5px solid ${t.inputBorder}` }}
            onMouseEnter={(e) => (e.currentTarget.style.background = t.rowHover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = t.inputBg)}>
            {copied ? <Check size={10} style={{ color: t.green }} /> : <Copy size={10} />}
            <span className="font-mono text-[11px]">{commit.hash}</span>
          </button>
          {onCherryPick && (
            <button onClick={onCherryPick}
              className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
              style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2,
                border: `0.5px solid ${t.inputBorder}` }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.accentBg; e.currentTarget.style.color = t.accent; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
              title="遴选(cherry-pick)到当前分支">
              <GitCommit size={11} />
              <span className="text-[11px] font-medium">遴选</span>
            </button>
          )}
          {onCheckout && checkoutBranch && (
            <button onClick={onCheckout}
              className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
              style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2,
                border: `0.5px solid ${t.inputBorder}` }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.accentBg; e.currentTarget.style.color = t.accent; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
              title={`检出 ${checkoutBranch} 并同步到此提交`}>
              <Download size={11} />
              <span className="text-[11px] font-medium">检出 {checkoutBranch}</span>
            </button>
          )}
          <div className="flex items-center gap-3 ml-auto text-xs font-mono">
            <span style={{ color: t.green + "aa" }}>+{commit.stats.additions}</span>
            <span style={{ color: t.red + "aa" }}>−{commit.stats.deletions}</span>
            <span style={{ color: t.textFaint }}>{commit.stats.files} 个文件</span>
          </div>
        </div>
      </div>

      <FileDiffView files={commit.files} selectedFile={selectedFile}
        onFileSelect={onFileSelect} emptyHint="合并提交，无直接更改" />
    </div>
  );
}

// Stash-detail pane: a stash-specific header (label / message / date + apply &
// drop actions) over the shared file+diff body.
function StashDetail({ stash, files, selectedFile, onFileSelect, onApply, onDrop }: {
  stash: Stash; files: CommitFile[]; selectedFile: CommitFile | null;
  onFileSelect: (f: CommitFile | null) => void; onApply: () => void; onDrop: () => void;
}) {
  const t = useTheme();
  const adds = files.reduce((s, f) => s + f.additions, 0);
  const dels = files.reduce((s, f) => s + f.deletions, 0);
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: t.bgPanel }}>
      <div className="flex-shrink-0 p-5" style={{ borderBottom: `0.5px solid ${t.border}` }}>
        <div className="flex items-start gap-3 mb-3">
          <div className="flex items-center justify-center rounded-full flex-shrink-0"
            style={{ width: 40, height: 40, background: t.accentBg }}>
            <Layers size={18} style={{ color: t.accent }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold font-mono" style={{ color: t.text }}>{"stash@{" + stash.index + "}"}</div>
            {stash.date && <div className="text-xs mt-0.5" style={{ color: t.textMuted }}>{stash.date}</div>}
          </div>
        </div>
        <div className="text-sm font-semibold leading-snug mb-3" style={{ color: t.text }}>{stash.message}</div>
        <div className="flex items-center gap-3">
          <button onClick={onApply}
            className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = t.accentBg; e.currentTarget.style.color = t.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
            title="应用到工作区(保留此储藏)">
            <RotateCcw size={11} /> <span className="text-[11px] font-medium">应用</span>
          </button>
          <button onClick={onDrop}
            className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = t.redBg; e.currentTarget.style.color = t.red; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
            title="删除此储藏">
            <Trash2 size={11} /> <span className="text-[11px] font-medium">删除</span>
          </button>
          <div className="flex items-center gap-3 ml-auto text-xs font-mono">
            <span style={{ color: t.green + "aa" }}>+{adds}</span>
            <span style={{ color: t.red + "aa" }}>−{dels}</span>
            <span style={{ color: t.textFaint }}>{files.length} 个文件</span>
          </div>
        </div>
      </div>
      <FileDiffView files={files} selectedFile={selectedFile} onFileSelect={onFileSelect}
        emptyHint="此储藏没有已跟踪文件的改动" />
    </div>
  );
}

// ─── WorkingFileRow ───────────────────────────────────────────────────────────

function WorkingFileRow({ file, selected, onSelect, onStage, onUnstage, onDiscard }: {
  file: WorkingFile; selected: boolean; onSelect: () => void;
  onStage?: () => void; onUnstage?: () => void; onDiscard?: () => void;
}) {
  const t = useTheme();
  const [hovered, setHovered] = useState(false);
  const statusColor = { modified: t.amber, added: t.green, deleted: t.red, untracked: t.textMuted }[file.status];
  const statusLabel = { modified: "M", added: "A", deleted: "D", untracked: "?" }[file.status];
  const parts = file.path.split("/"), name = parts.pop()!;
  return (
    <div className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
      style={{ margin: "1px 6px", width: "calc(100% - 12px)",
        background: selected ? t.rowSelected : hovered ? t.rowHover : "transparent",
        borderRadius: R - 2 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}>
      <span className="text-[12px] font-mono font-bold w-3 text-center flex-shrink-0" style={{ color: statusColor }}>
        {statusLabel}
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-xs truncate" style={{ color: selected ? t.accentFg : t.textSec }}>{name}</span>
        {parts.length > 0 && <span className="text-[12px] truncate" style={{ color: t.textFaint }}>{parts.join("/")}</span>}
      </div>
      {hovered && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {onDiscard && (
            <button onClick={(e) => { e.stopPropagation(); onDiscard(); }}
              className="flex items-center justify-center w-5 h-5 transition-colors"
              title={file.status === "untracked" ? "删除此未跟踪文件" : "丢弃此文件的更改"}
              style={{ background: t.inputBg, color: t.textMuted, borderRadius: 6 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.red + "25"; e.currentTarget.style.color = t.red; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}>
              <RotateCcw size={10} />
            </button>
          )}
          {onStage && (
            <button onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="flex items-center justify-center w-5 h-5 transition-colors"
              style={{ background: t.greenBg, color: t.green, borderRadius: 6 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.green + "30")}
              onMouseLeave={(e) => (e.currentTarget.style.background = t.greenBg)}>
              <Plus size={10} />
            </button>
          )}
          {onUnstage && (
            <button onClick={(e) => { e.stopPropagation(); onUnstage(); }}
              className="flex items-center justify-center w-5 h-5 transition-colors"
              style={{ background: t.redBg, color: t.red, borderRadius: 6 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.red + "25")}
              onMouseLeave={(e) => (e.currentTarget.style.background = t.redBg)}>
              <Minus size={10} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ChangesPanel ─────────────────────────────────────────────────────────────

function ChangesPanel({ files, selectedFile, onFileSelect, currentBranch, onFilesChange,
  identities, defaultIdentityId, projectKey, onCommit, onDiscard, onDiscardAll }: {
  files: WorkingFile[]; selectedFile: WorkingFile | null;
  onFileSelect: (f: WorkingFile | null) => void;
  currentBranch: string; onFilesChange: (files: WorkingFile[]) => void;
  identities: Identity[]; defaultIdentityId: string; projectKey: string;
  onCommit: (message: string, files: string[], identity: Identity | null) => Promise<void>;
  onDiscard: (file: string) => void; onDiscardAll: () => void;
}) {
  const t = useTheme();
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  // Committer: a remembered per-project choice wins; otherwise the default
  // identity. Selecting one persists it for this project.
  const resolveIdentity = (): string => {
    const remembered = loadProjectIdentity(projectKey);
    if (remembered !== null && (remembered === "" || identities.some((i) => i.id === remembered))) {
      return remembered;
    }
    return defaultIdentityId && identities.some((i) => i.id === defaultIdentityId)
      ? defaultIdentityId : (identities[0]?.id ?? "");
  };
  const [identityId, setIdentityId] = useState<string>(resolveIdentity);
  // Reload the remembered choice when the project changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setIdentityId(resolveIdentity()); }, [projectKey]);
  // Fall back if the selected identity is deleted.
  useEffect(() => {
    if (identityId !== "" && !identities.some((i) => i.id === identityId)) setIdentityId(resolveIdentity());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities]);
  const chooseIdentity = (id: string) => { setIdentityId(id); saveProjectIdentity(projectKey, id); };
  const identity = identities.find((i) => i.id === identityId) ?? null;

  const staged   = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);
  const stageFile   = (path: string) => onFilesChange(files.map((f) => f.path === path ? { ...f, staged: true  } : f));
  const unstageFile = (path: string) => onFilesChange(files.map((f) => f.path === path ? { ...f, staged: false } : f));
  const stageAll   = () => onFilesChange(files.map((f) => ({ ...f, staged: true  })));
  const unstageAll = () => onFilesChange(files.map((f) => ({ ...f, staged: false })));
  const handleCommit = async () => {
    if (!commitMsg.trim() || staged.length === 0 || committing) return;
    setCommitting(true);
    try {
      await onCommit(commitMsg.trim(), staged.map((f) => f.path), identity);
      setCommitMsg(""); onFileSelect(null);
    } catch (e) {
      toast.error(`提交失败：${e}`);
    } finally {
      setCommitting(false);
    }
  };
  const SectionHdr = ({ label, count, action, onAction, onReset }: {
    label: string; count: number; action: string; onAction: () => void; onReset?: () => void;
  }) => (
    <div className="flex items-center justify-between px-4 py-2.5 gap-2"
      style={{ borderBottom: `0.5px solid ${t.border}` }}>
      <span className="text-[12px] font-semibold flex-1 min-w-0 truncate" style={{ color: t.textMuted }}>
        {label} <span style={{ color: t.textFaint }}>({count})</span>
      </span>
      {onReset && (
        <button onClick={onReset}
          className="text-[12px] px-2 py-0.5 transition-colors cursor-pointer flex-shrink-0"
          title="丢弃工作区的所有更改（reset --hard + clean）"
          style={{ color: t.red, background: t.redBg, borderRadius: R - 4,
            border: `0.5px solid ${t.red}33` }}
          onMouseEnter={(e) => (e.currentTarget.style.background = t.red + "22")}
          onMouseLeave={(e) => (e.currentTarget.style.background = t.redBg)}>
          全部重置
        </button>
      )}
      {count > 0 && (
        <button onClick={onAction}
          className="text-[12px] px-2 py-0.5 transition-colors cursor-pointer flex-shrink-0"
          style={{ color: t.textMuted, background: t.inputBg, borderRadius: R - 4,
            border: `0.5px solid ${t.inputBorder}` }}
          onMouseEnter={(e) => (e.currentTarget.style.color = t.text)}
          onMouseLeave={(e) => (e.currentTarget.style.color = t.textMuted)}>
          {action}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex-shrink-0 flex flex-col overflow-hidden"
      style={{ background: t.bgPanel, width: 340, borderRight: `0.5px solid ${t.border}` }}>
      <div className="flex-shrink-0" style={{ maxHeight: "42%", minHeight: 80, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <SectionHdr label="已暂存" count={staged.length} action="全部取消" onAction={unstageAll} />
        <div className="overflow-y-auto flex-1 py-1">
          {staged.length === 0
            ? <div className="px-4 py-3 text-[12px]" style={{ color: t.textFaint }}>暂无已暂存的文件</div>
            : staged.map((f) => (
              <WorkingFileRow key={f.path} file={f}
                selected={selectedFile?.path === f.path}
                onSelect={() => onFileSelect(selectedFile?.path === f.path ? null : f)}
                onUnstage={() => unstageFile(f.path)}
                onDiscard={() => onDiscard(f.path)} />
            ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden" style={{ borderTop: `0.5px solid ${t.border}` }}>
        <SectionHdr label="未暂存" count={unstaged.length} action="全部暂存" onAction={stageAll}
          onReset={files.length > 0 ? onDiscardAll : undefined} />
        <div className="overflow-y-auto flex-1 py-1">
          {unstaged.length === 0
            ? <div className="px-4 py-3 text-[12px]" style={{ color: t.textFaint }}>所有文件已暂存</div>
            : unstaged.map((f) => (
              <WorkingFileRow key={f.path} file={f}
                selected={selectedFile?.path === f.path}
                onSelect={() => onFileSelect(selectedFile?.path === f.path ? null : f)}
                onStage={() => stageFile(f.path)}
                onDiscard={() => onDiscard(f.path)} />
            ))}
        </div>
      </div>

      {/* Commit area */}
      <div className="flex-shrink-0 p-3" style={{ borderTop: `0.5px solid ${t.border}` }}>
        <textarea value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="提交信息（必填）" rows={3}
          className="w-full resize-none text-xs p-2.5 outline-none transition-all"
          style={{ background: t.inputBg, color: t.text, fontFamily: "inherit",
            borderRadius: R,
            border: `1px solid ${commitMsg.trim() ? t.accent + "66" : t.inputBorder}`,
            boxShadow: commitMsg.trim() ? `0 0 0 3px ${t.accent}18` : "none",
            transition: "border-color 0.15s, box-shadow 0.15s" }}
          onFocus={(e) => { e.currentTarget.style.borderColor = t.accent + "88"; e.currentTarget.style.boxShadow = `0 0 0 3px ${t.accent}20`; }}
          onBlur={(e)  => { e.currentTarget.style.borderColor = commitMsg.trim() ? t.accent + "66" : t.inputBorder; e.currentTarget.style.boxShadow = "none"; }} />

        {/* Committer — defaults to the default identity */}
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] flex-shrink-0" style={{ color: t.textMuted }}>提交者</span>
          {identities.length === 0 ? (
            <span className="text-[11px] truncate" style={{ color: t.textFaint }}>使用仓库默认（在设置中可添加身份）</span>
          ) : (
            <select value={identityId} onChange={(e) => chooseIdentity(e.target.value)}
              title="该选择会记住到当前项目"
              className="flex-1 min-w-0 text-[11px] px-2 py-1.5 outline-none cursor-pointer"
              style={{ background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 }}>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>{i.name} · {i.email}</option>
              ))}
              <option value="">仓库默认身份</option>
            </select>
          )}
        </div>

        <button {...press(handleCommit)} disabled={!commitMsg.trim() || staged.length === 0 || committing}
          className="w-full mt-2 py-2 text-xs font-semibold transition-all duration-150 cursor-pointer"
          style={{
            background: !commitMsg.trim() || staged.length === 0 || committing ? t.inputBg : t.accent,
            color:      !commitMsg.trim() || staged.length === 0 || committing ? t.textFaint : "#fff",
            borderRadius: R, border: `0.5px solid ${t.inputBorder}`,
            boxShadow: commitMsg.trim() && staged.length > 0 && !committing ? `0 4px 16px ${t.accent}44` : "none",
            cursor: !commitMsg.trim() || staged.length === 0 || committing ? "not-allowed" : "pointer",
          }}
          onMouseEnter={(e) => { if (commitMsg.trim() && staged.length > 0 && !committing) e.currentTarget.style.opacity = "0.88"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}>
          <span className="flex items-center justify-center gap-1.5">
            <GitCommit size={11} className={committing ? "animate-spin" : undefined} />
            {committing ? "提交中…" : `提交到 ${currentBranch}`}
            {staged.length > 0 && !committing && (
              <span className="ml-1 px-1.5 py-px rounded-full text-[11px]"
                style={{ background: "rgba(255,255,255,0.2)" }}>
                {staged.length}
              </span>
            )}
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── WorkingFileDiff ──────────────────────────────────────────────────────────

// Human-readable byte size.
function formatBytes(n = 0): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Render at most this many diff lines — keeps a huge file/diff from freezing
// the UI. Both the untracked preview (capped in Rust) and normal diffs use it.
const DIFF_RENDER_CAP = 2000;

function WorkingFileDiff({ file }: { file: WorkingFile }) {
  const t = useTheme();
  const statusColor = { modified: t.amber, added: t.green, deleted: t.red, untracked: t.textMuted }[file.status];
  const statusLabel = { modified: "已修改", added: "新文件", deleted: "已删除", untracked: "未追踪" }[file.status];

  const notice =
    file.previewKind === "binary"    ? "二进制文件,无法预览"
    : file.previewKind === "too_large" ? `文件过大（${formatBytes(file.previewSize)}）,已跳过预览`
    : file.previewKind === "empty"     ? "空文件"
    : file.previewKind === "missing"   ? "文件已不存在"
    : null;

  const allLines = file.diff ? file.diff.split("\n") : [];
  const shown = allLines.length > DIFF_RENDER_CAP ? allLines.slice(0, DIFF_RENDER_CAP) : allLines;
  const capped = file.previewTruncated || allLines.length > DIFF_RENDER_CAP;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: t.bgPanel }}>
      <div className="flex-shrink-0 flex items-center gap-3 px-5 py-3"
        style={{ borderBottom: `0.5px solid ${t.border}` }}>
        <span className="text-xs font-semibold" style={{ color: statusColor }}>{statusLabel}</span>
        <span className="font-mono text-xs flex-1 truncate" style={{ color: t.textSec }}>{file.path}</span>
        {file.status === "untracked" && file.previewKind === "text" && (
          <span className="text-[11px] flex-shrink-0" style={{ color: t.green }}>全部为新增</span>
        )}
      </div>
      <div className="flex-1 overflow-auto" style={{ background: t.diffBg }}>
        {notice ? (
          <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: t.textFaint }}>
            <FileText size={28} opacity={0.25} />
            <span className="text-xs">{notice}</span>
          </div>
        ) : file.diff ? (
          <div className="py-2 w-max min-w-full">
            <DiffRows lines={shown} />
            {capped && (
              <div className="px-4 py-3 text-[11px] text-center" style={{ color: t.textFaint }}>
                内容较长,仅显示前 {DIFF_RENDER_CAP} 行{file.previewTruncated && ` · 共 ${file.previewSize ? formatBytes(file.previewSize) : "?"}`}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: t.textFaint }}>
            <FileText size={28} opacity={0.25} />
            <span className="text-xs">无差异预览</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

// First file worth previewing: skip binary/no-diff entries (0 add + 0 del),
// falling back to the very first file if none look "readable".
function firstReadableFile(files: CommitFile[]): CommitFile | null {
  return files.find((f) => f.additions + f.deletions > 0) ?? files[0] ?? null;
}

// Same set of working files (by path + status)? Used to skip no-op status polls.
function sameWorking(a: WorkingFile[], b: WorkingFile[]): boolean {
  if (a.length !== b.length) return false;
  const bm = new Map(b.map((f) => [f.path, f.status]));
  return a.every((f) => bm.get(f.path) === f.status);
}

// Per-repo UI state (hidden/pinned branches, collapsed folders) persisted in
// localStorage so it survives restarts and is remembered per project.
type UiPrefs = { hidden: string[]; pinned: string[]; collapsed: string[] };
const EMPTY_PREFS: UiPrefs = { hidden: [], pinned: [], collapsed: [] };
function loadUiPrefs(key: string): UiPrefs {
  try {
    const raw = localStorage.getItem(`gitkit.ui.${key}`);
    if (!raw) return EMPTY_PREFS;
    const p = JSON.parse(raw);
    return {
      hidden: Array.isArray(p.hidden) ? p.hidden : [],
      pinned: Array.isArray(p.pinned) ? p.pinned : [],
      collapsed: Array.isArray(p.collapsed) ? p.collapsed : [],
    };
  } catch { return EMPTY_PREFS; }
}
function saveUiPrefs(key: string, p: UiPrefs): void {
  try { localStorage.setItem(`gitkit.ui.${key}`, JSON.stringify(p)); } catch { /* ignore */ }
}

// Opened projects + last-active project persisted across launches.
function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem("gitkit.projects");
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && typeof p.path === "string" && typeof p.id === "string")
      .map((p) => ({
        id: p.id, path: p.path,
        name: typeof p.name === "string" ? p.name : p.path,
        branch: typeof p.branch === "string" ? p.branch : "",
        color: typeof p.color === "string" ? p.color : "#6b6bff",
        changes: 0,
      }));
  } catch { return []; }
}
function saveProjects(projs: Project[]): void {
  try {
    localStorage.setItem("gitkit.projects",
      JSON.stringify(projs.map((p) => ({ id: p.id, path: p.path, name: p.name, branch: p.branch, color: p.color }))));
  } catch { /* ignore */ }
}
function loadActiveProjectId(): string {
  const projs = loadProjects();
  const stored = localStorage.getItem("gitkit.activeProjectId") ?? "";
  return projs.some((p) => p.id === stored) ? stored : (projs[0]?.id ?? "");
}
function loadThemeMode(): ThemeMode {
  const s = localStorage.getItem("gitkit.themeMode");
  return s === "light" || s === "dark" || s === "system" ? s : "dark";
}

function loadPaletteId(): PaletteId {
  const s = localStorage.getItem("gitkit.palette");
  return (PALETTE_ORDER as readonly string[]).includes(s ?? "") ? (s as PaletteId) : "graphite";
}

// ── Scheduled daily update check ────────────────────────────────────────────
// Once a day at `time`, every open project is fetched and the ones with new
// upstream commits are reported in a dialog that can pull them in one go.
// `lastRun` is the epoch ms of the last completed run, and a run is due when
// today's scheduled instant has passed while the last run predates it. That one
// rule covers everything: a day missed with the app closed fires shortly after
// the next launch, and moving the time later in the day still fires today.
interface DailyCheck { enabled: boolean; time: string; lastRun: number }
interface CheckProgress { current: number; total: number; project: string }
const DAILY_CHECK_DEFAULT: DailyCheck = { enabled: false, time: "09:30", lastRun: 0 };
function loadDailyCheck(): DailyCheck {
  try {
    const c = JSON.parse(localStorage.getItem("gitkit.dailyCheck") ?? "{}");
    return {
      enabled: !!c.enabled,
      time: typeof c.time === "string" && /^\d{1,2}:\d{2}$/.test(c.time) ? c.time : DAILY_CHECK_DEFAULT.time,
      lastRun: typeof c.lastRun === "number" ? c.lastRun : 0,
    };
  } catch { return DAILY_CHECK_DEFAULT; }
}
function saveDailyCheck(c: DailyCheck): void {
  try { localStorage.setItem("gitkit.dailyCheck", JSON.stringify(c)); } catch { /* ignore */ }
}
/** Today's "HH:MM" as an epoch ms in local time. */
function scheduledAt(time: string, now: Date = new Date()): number {
  const [h, m] = time.split(":").map((n) => parseInt(n, 10));
  const d = new Date(now);
  d.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 30, 0, 0);
  return d.getTime();
}

// Committer identities (name/email profiles), persisted across launches. Applied
// to commits later via `git -c user.name=… -c user.email=…` (no global config change).
interface Identity { id: string; name: string; email: string }
function loadIdentities(): Identity[] {
  try {
    const arr = JSON.parse(localStorage.getItem("gitkit.identities") ?? "[]");
    if (!Array.isArray(arr)) return [];
    return arr.filter((i) => i && typeof i.name === "string" && typeof i.email === "string")
      .map((i) => ({ id: String(i.id ?? i.email), name: i.name, email: i.email }));
  } catch { return []; }
}
function saveIdentities(list: Identity[]): void {
  try { localStorage.setItem("gitkit.identities", JSON.stringify(list)); } catch { /* ignore */ }
}
function loadDefaultIdentityId(): string {
  return localStorage.getItem("gitkit.defaultIdentityId") ?? "";
}

// Per-project preference maps (repo path → value), stored one JSON object per
// storage key. Bad / missing JSON degrades to an empty map.
function loadPrefMap(storeKey: string): Record<string, string> {
  try {
    const m = JSON.parse(localStorage.getItem(storeKey) ?? "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m as Record<string, string> : {};
  } catch { return {}; }
}
function setPrefMapEntry(storeKey: string, key: string, value: string): void {
  if (!key) return;
  const m = loadPrefMap(storeKey);
  m[key] = value;
  try { localStorage.setItem(storeKey, JSON.stringify(m)); } catch { /* ignore */ }
}
function deletePrefMapEntry(storeKey: string, key: string): void {
  const m = loadPrefMap(storeKey);
  delete m[key];
  try { localStorage.setItem(storeKey, JSON.stringify(m)); } catch { /* ignore */ }
}

const IDENTITY_PREFS = "gitkit.projectIdentities";
const ACCOUNT_PREFS  = "gitkit.projectGithubAccounts";

// Remembered committer per repo path. Returns null when the project has no
// remembered choice (→ fall back to the default identity); "" means the user
// explicitly picked the repo/global git config for this project.
function loadProjectIdentity(key: string): string | null {
  const v = loadPrefMap(IDENTITY_PREFS)[key];
  return typeof v === "string" ? v : null;
}
function saveProjectIdentity(key: string, id: string): void {
  setPrefMapEntry(IDENTITY_PREFS, key, id);
}

// Remembered GitHub account per repo path — set from the "记住本项目的选择"
// checkbox in the account picker, so a project with several matching accounts
// stops asking. Cleared from 设置 › 项目配置.
function loadProjectAccountId(key: string): string {
  const v = loadPrefMap(ACCOUNT_PREFS)[key];
  return typeof v === "string" ? v : "";
}
function saveProjectAccountId(key: string, id: string): void {
  setPrefMapEntry(ACCOUNT_PREFS, key, id);
}

// Remote host connection (instance URL + personal access token), for GitLab / GitHub.
interface RemoteConn { url: string; token: string }
function loadConn(key: string): RemoteConn {
  try {
    const c = JSON.parse(localStorage.getItem(key) ?? "{}");
    return { url: typeof c.url === "string" ? c.url : "", token: typeof c.token === "string" ? c.token : "" };
  } catch { return { url: "", token: "" }; }
}
function saveConn(key: string, c: RemoteConn): void {
  try { localStorage.setItem(key, JSON.stringify(c)); } catch { /* ignore */ }
}
const loadGitlab = () => loadConn("gitkit.gitlab");

// Host of a remote URL (https or scp-style git@host:path); "" for none.
function hostOf(url: string): string {
  try { if (/^https?:\/\//.test(url)) return new URL(url).host; } catch { /* fall through */ }
  const m = url.match(/^[^@]+@([^:/]+)/);
  return m ? m[1] : "";
}

// GitHub supports multiple accounts (label + optional GHE url + token), so one
// user can push different projects under different identities. Public accounts
// leave `url` blank; GitHub Enterprise accounts set it to the instance root.
interface GithubAccount { id: string; label: string; url: string; token: string }
function loadGithubAccounts(): GithubAccount[] {
  try {
    const raw = localStorage.getItem("gitkit.github.accounts");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .filter((a) => a && typeof a.token === "string" && a.token)
          .map((a, i) => ({
            id: String(a.id ?? `gh-${i}`),
            label: typeof a.label === "string" ? a.label : "",
            url: typeof a.url === "string" ? a.url : "",
            token: a.token as string,
          }));
      }
    }
  } catch { /* ignore */ }
  // Migrate the legacy single-connection config into one account.
  const legacy = loadConn("gitkit.github");
  if (legacy.token) return [{ id: "gh-legacy", label: legacy.url ? hostOf(legacy.url) : "github.com", url: legacy.url, token: legacy.token }];
  return [];
}
function saveGithubAccounts(list: GithubAccount[]): void {
  try { localStorage.setItem("gitkit.github.accounts", JSON.stringify(list)); } catch { /* ignore */ }
}
// GitHub accounts whose configured host matches the remote: a blank-url account
// serves public github.com; a GHE account serves only its own host.
function githubCandidates(remoteUrl: string): GithubAccount[] {
  const accts = loadGithubAccounts();
  const host = hostOf(remoteUrl);
  if (!host) return accts;
  const isPublic = host === "github.com" || host.endsWith(".github.com");
  return accts.filter((a) => (a.url ? host === hostOf(a.url) : isPublic));
}

// Pick the token whose configured host matches the remote (GitHub public is
// special-cased); falls back to whichever single token is configured. This is
// the non-interactive fallback; `resolveRemoteToken` handles the multi-account
// prompt before delegating here.
function pickRemoteToken(remoteUrl: string): string | undefined {
  const cands = githubCandidates(remoteUrl);
  if (cands.length) return cands[0].token;
  const gl = loadGitlab();
  const host = hostOf(remoteUrl);
  if (host && gl.url && host === hostOf(gl.url) && gl.token) return gl.token;
  return gl.token || loadGithubAccounts()[0]?.token || undefined;
}

// ─── Modal shell (shared style for all dialogs) ──────────────────────────────

// WKWebView (macOS) eats the first *click* when a text field is focused — the
// mousedown just blurs the field and no `click` is dispatched. So dialog controls
// act on `mousedown` (which always fires) instead, making them one-click reliable.
const press = (fn: () => void) => ({
  onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); fn(); },
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  },
});

type DlgIcon = typeof GitPullRequest;

function Modal({ title, Icon, onClose, width = 480, children, footer }: {
  title: string; Icon: DlgIcon; onClose: () => void; width?: number;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  const t = useTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 200 }}>
      <div className="absolute inset-0 gk-overlay-in" style={{ background: "rgba(0,0,0,0.45)" }} {...press(onClose)} />
      <div role="dialog" aria-modal="true" aria-label={title}
        className="relative flex flex-col gk-modal-in" style={{ width, maxHeight: "85vh",
        background: t.dialogBg,
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R + 2, boxShadow: t.shadowWindow, overflow: "hidden" }}>
        <div className="flex-shrink-0 flex items-center gap-2.5 px-5 py-3.5" style={{ borderBottom: `0.5px solid ${t.border}` }}>
          <div className="flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 30, height: 30, background: t.accentBg }}>
            <Icon size={15} style={{ color: t.accent }} />
          </div>
          <span className="text-sm font-semibold flex-1" style={{ color: t.text }}>{title}</span>
          <button {...press(onClose)}
            aria-label={`关闭${title}`} title="关闭"
            className="flex items-center justify-center w-7 h-7 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 3 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = t.inputBg)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 flex flex-col gap-4">{children}</div>
        {footer && (
          <div className="flex-shrink-0 flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `0.5px solid ${t.border}` }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium" style={{ color: t.textMuted }}>{label}</span>
      {children}
    </label>
  );
}

// Destructive-action confirmation (discard file / reset all). Red confirm button.
function ConfirmDialog({ title, message, confirmLabel, busy, onCancel, onConfirm }: {
  title: string; message: string; confirmLabel: string; busy?: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  const t = useTheme();
  return (
    <Modal title={title} Icon={AlertTriangle} onClose={onCancel} width={440}
      footer={
        <>
          <button {...press(onCancel)}
            className="px-3.5 py-2 text-xs font-medium cursor-pointer"
            style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>取消</button>
          <button {...(busy ? {} : press(onConfirm))} disabled={busy}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold"
            style={{ background: t.red, color: "#fff", borderRadius: R - 2,
              cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.7 : 1 }}>
            {busy && <RefreshCw size={12} className="animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }>
      <div className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: t.textSec }}>{message}</div>
    </Modal>
  );
}

function ModalFooter({ onCancel, onConfirm, confirmLabel, disabled, busy, danger }: {
  onCancel: () => void; onConfirm: () => void; confirmLabel: string; disabled?: boolean; busy?: boolean; danger?: boolean;
}) {
  const t = useTheme();
  const dis = !!disabled || !!busy;
  return (
    <>
      <button {...press(onCancel)}
        className="px-3.5 py-2 text-xs font-medium cursor-pointer"
        style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>取消</button>
      <button {...(dis ? {} : press(onConfirm))} disabled={dis}
        className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold"
        style={{ background: dis ? t.inputBg : danger ? t.red : t.accent, color: dis ? t.textFaint : "#fff",
          borderRadius: R - 2, cursor: dis ? "not-allowed" : "pointer" }}>
        {busy && <RefreshCw size={12} className="animate-spin" />}
        {confirmLabel}
      </button>
    </>
  );
}

// Shared field control styling.
const dlgCtl = (t: ThemeColors, err = false): React.CSSProperties =>
  ({ background: t.inputBg, color: t.text, border: `0.5px solid ${err ? t.red + "88" : t.inputBorder}`, borderRadius: R - 2 });

// ─── CreateRepoDialog (bootstrap a GitHub remote for a local-only repo) ──────

function CreateRepoDialog({ accounts, defaultName, busy, onCancel, onConfirm }: {
  accounts: GithubAccount[]; defaultName: string; busy: boolean;
  onCancel: () => void;
  onConfirm: (account: GithubAccount, name: string, isPrivate: boolean, description: string) => void;
}) {
  const t = useTheme();
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [name, setName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState("");
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const nameOk = /^[A-Za-z0-9._-]+$/.test(name.trim());
  const canSubmit = !!account && nameOk && !busy;
  const host = account && account.url ? hostOf(account.url) : "github.com";

  const visBtn = (val: boolean, label: string, desc: string) => {
    const active = isPrivate === val;
    return (
      <button {...press(() => setIsPrivate(val))}
        className="flex-1 flex flex-col gap-0.5 px-3 py-2 text-left cursor-pointer"
        style={{ borderRadius: R - 2, border: `0.5px solid ${active ? t.accent : t.inputBorder}`,
          background: active ? t.accentBg : "transparent" }}>
        <span className="text-xs font-medium" style={{ color: active ? t.accentFg : t.text }}>{label}</span>
        <span className="text-[10px]" style={{ color: t.textFaint }}>{desc}</span>
      </button>
    );
  };

  return (
    <Modal title="创建 GitHub 仓库并推送" Icon={Github} onClose={busy ? () => {} : onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel}
        onConfirm={() => { if (canSubmit && account) onConfirm(account, name.trim(), isPrivate, description.trim()); }}
        confirmLabel="创建并推送" disabled={!canSubmit} busy={busy} />}>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        该仓库还没有远程地址。将在 {host} 上创建一个新仓库,设为 origin 并推送当前分支。
      </span>
      {accounts.length > 1 && (
        <Field label="GitHub 账号">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
            className="text-xs px-2.5 py-2 outline-none" style={dlgCtl(t)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {(a.label || (a.url ? hostOf(a.url) : "github.com"))} · ••••{a.token.slice(-4)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="仓库名称">
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
          placeholder="my-repo" className="text-xs px-2.5 py-2 outline-none font-mono"
          style={dlgCtl(t, name.length > 0 && !nameOk)} />
      </Field>
      <Field label="可见性">
        <div className="flex items-center gap-2">
          {visBtn(true, "私有", "仅自己与协作者可见")}
          {visBtn(false, "公开", "任何人可见")}
        </div>
      </Field>
      <Field label="描述（可选）">
        <input value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明这个仓库" className="text-xs px-2.5 py-2 outline-none"
          style={dlgCtl(t)} />
      </Field>
    </Modal>
  );
}

// ─── AccountPickerDialog (which GitHub identity to use for this remote op) ──
// Shown when a remote matches 2+ configured accounts. Ticking 记住 stores the
// choice for this repo path, so later actions skip the prompt.

function AccountPickerDialog({ action, accounts, canRemember, onPick, onCancel }: {
  action: string; accounts: GithubAccount[]; canRemember: boolean;
  onPick: (account: GithubAccount, remember: boolean) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [remember, setRemember] = useState(false);

  return (
    <Modal title={`选择 GitHub 账号 · ${action}`} Icon={Github} onClose={onCancel} width={440}>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        该远程匹配到多个 GitHub 账号,选择本次{action}使用的身份。
      </span>
      <div className="flex flex-col gap-1.5">
        {accounts.map((a) => {
          const host = a.url ? hostOf(a.url) : "github.com";
          return (
            <button key={a.id} {...press(() => onPick(a, remember))}
              className="flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer transition-colors"
              style={{ borderRadius: R - 2, border: `0.5px solid ${t.border}`, background: "transparent" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.rowHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <div className="flex items-center justify-center rounded-full flex-shrink-0"
                style={{ width: 26, height: 26, background: t.accentBg }}>
                <Github size={13} style={{ color: t.accent }} />
              </div>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-xs font-medium truncate" style={{ color: t.text }}>{a.label || host}</span>
                <span className="text-[11px] font-mono truncate" style={{ color: t.textMuted }}>{host} · ••••{a.token.slice(-4)}</span>
              </div>
              <ArrowRight size={14} className="flex-shrink-0" style={{ color: t.textFaint }} />
            </button>
          );
        })}
      </div>
      {canRemember && (
        <button {...press(() => setRemember((v) => !v))}
          className="flex items-start gap-2 px-1 py-0.5 text-left cursor-pointer">
          <div className="flex items-center justify-center flex-shrink-0" style={{
            width: 14, height: 14, marginTop: 1, borderRadius: 4,
            background: remember ? t.accent : "transparent",
            border: `0.5px solid ${remember ? t.accent : t.inputBorder}` }}>
            {remember && <Check size={10} strokeWidth={3} style={{ color: t.isDark ? "#0d0d0d" : "#fff" }} />}
          </div>
          <span className="text-[11px]" style={{ color: remember ? t.text : t.textMuted }}>
            记住本项目的选择,以后不再询问
            <span className="block" style={{ color: t.textFaint }}>可在设置 › 项目配置中查看或删除</span>
          </span>
        </button>
      )}
    </Modal>
  );
}

// ─── CloneDialog (clone a remote repo over http(s)/ssh into a local folder) ──

function CloneDialog({ onClose, onDone }: {
  onClose: () => void;
  onDone: (path: string) => void;
}) {
  const t = useTheme();
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<CloneProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const trimmedUrl = url.trim();
  const isHttp = /^https?:\/\//i.test(trimmedUrl);
  // Accept https://, git@host:…, ssh://, git://, or any path ending in .git.
  const looksValid =
    /^(https?|ssh|git):\/\//i.test(trimmedUrl) ||
    /^[\w.-]+@[\w.-]+:/.test(trimmedUrl) ||
    /\.git$/i.test(trimmedUrl);
  const name = trimmedUrl ? repoNameFromUrl(trimmedUrl) : "";
  const canSubmit = !!trimmedUrl && looksValid && !!dest && !busy;

  const pickDest = async () => {
    if (busy) return;
    const folder = await pickCloneParent();
    if (folder) setDest(folder);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    setProg({ phase: "准备克隆", percent: null, raw: "" });
    // For HTTPS, use the token typed here, else fall back to a configured account.
    const tok = isHttp ? (token.trim() || pickRemoteToken(trimmedUrl)) : undefined;
    try {
      const path = await cloneRepo(trimmedUrl, dest, tok, (p) => setProg(p));
      toast.success(`已克隆仓库：${name}`, { description: path });
      onDone(path); // parent opens it as a project & closes the dialog
    } catch (e) {
      setErr(String(e));
      setBusy(false);
      setProg(null);
    }
  };

  const cancelFooter = (
    <>
      <button {...(busy ? {} : press(onClose))} disabled={busy}
        className="px-3.5 py-2 text-xs font-medium"
        style={{ color: busy ? t.textFaint : t.textMuted, borderRadius: R - 2,
          border: `0.5px solid ${t.inputBorder}`, cursor: busy ? "not-allowed" : "pointer" }}>取消</button>
      <button {...(canSubmit ? press(submit) : {})} disabled={!canSubmit}
        className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold"
        style={{ background: canSubmit ? t.accent : t.inputBg, color: canSubmit ? "#fff" : t.textFaint,
          borderRadius: R - 2, cursor: canSubmit ? "pointer" : "not-allowed" }}>
        {busy ? <RefreshCw size={12} className="animate-spin" /> : <Cloud size={12} />}
        {busy ? "克隆中…" : "克隆"}
      </button>
    </>
  );

  return (
    <Modal title="克隆仓库" Icon={Cloud} onClose={busy ? () => {} : onClose} width={480} footer={cancelFooter}>
      <Field label="仓库地址（HTTP 或 SSH）">
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="https://github.com/user/repo.git 或 git@github.com:user/repo.git"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full"
          style={dlgCtl(t, trimmedUrl.length > 0 && !looksValid)} />
        {trimmedUrl.length > 0 && !looksValid && (
          <span className="text-[11px]" style={{ color: t.red }}>无法识别的地址，请粘贴完整的 HTTP 或 SSH 克隆地址</span>
        )}
      </Field>

      <Field label="克隆到">
        <button {...(busy ? {} : press(pickDest))} disabled={busy}
          className="flex items-center gap-2 px-2.5 py-2 text-xs text-left w-full"
          style={{ ...dlgCtl(t), cursor: busy ? "not-allowed" : "pointer" }}>
          <FolderOpen size={13} style={{ color: t.textMuted, flexShrink: 0 }} />
          <span className="truncate" style={{ color: dest ? t.text : t.textFaint }}>
            {dest || "选择一个文件夹…"}
          </span>
        </button>
        {dest && name && (
          <span className="text-[11px] font-mono truncate" style={{ color: t.textFaint }}>
            将克隆到：{dest}/{name}
          </span>
        )}
      </Field>

      {isHttp && (
        <Field label="访问令牌（可选，私有仓库需要）">
          <input value={token} onChange={(e) => setToken(e.target.value)} disabled={busy}
            type="password" placeholder="留空则使用已配置的账号令牌"
            className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t)} />
        </Field>
      )}

      {prog && (
        <div className="flex flex-col gap-2 pt-1">
          <div className="flex items-center justify-between text-[11px]">
            <span style={{ color: t.textSec }}>{prog.phase}</span>
            <span className="font-mono" style={{ color: t.textMuted }}>
              {prog.percent != null ? `${prog.percent}%` : ""}
            </span>
          </div>
          <div className="w-full overflow-hidden" style={{ height: 6, background: t.inputBg, borderRadius: 999 }}>
            <div className={prog.percent == null ? "animate-pulse" : undefined}
              style={{ height: "100%", width: prog.percent != null ? `${prog.percent}%` : "100%",
                background: t.accent, borderRadius: 999, transition: "width 0.2s ease",
                opacity: prog.percent != null ? 1 : 0.45 }} />
          </div>
          {prog.raw && (
            <span className="text-[10px] font-mono truncate" style={{ color: t.textFaint }}>{prog.raw}</span>
          )}
        </div>
      )}

      {err && !busy && (
        <div className="flex items-start gap-1.5 text-[11px]" style={{ color: t.red }}>
          <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
          <span className="min-w-0 break-words">{err}</span>
        </div>
      )}
    </Modal>
  );
}

// ─── CreateBranchDialog ─────────────────────────────────────────────────────

// How to treat uncommitted changes when creating (and switching to) a branch.
type DirtyMode = "carry" | "stash" | "discard";

function CreateBranchDialog({ branches, defaultBase, dirty, onCancel, onConfirm }: {
  branches: Branch[]; defaultBase: string; dirty: boolean;
  onCancel: () => void; onConfirm: (name: string, base: string, mode: DirtyMode) => void;
}) {
  const t = useTheme();
  const [name, setName] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [mode, setMode] = useState<DirtyMode>("carry");
  const trimmed = name.trim();
  const exists = branches.some((b) => b.name === trimmed);
  const valid = trimmed.length > 0 && !exists && !/\s/.test(trimmed);
  const submit = () => { if (valid) onConfirm(trimmed, base, dirty ? mode : "carry"); };

  const MODES: { key: DirtyMode; Icon: React.ElementType; label: string; desc: string; danger?: boolean }[] = [
    { key: "carry",   Icon: ArrowRight, label: "带到新分支", desc: "把未提交更改一起带到新分支（默认）" },
    { key: "stash",   Icon: Layers,     label: "储藏改动",   desc: "先储藏（git stash），新分支保持干净，可稍后恢复" },
    { key: "discard", Icon: Trash2,     label: "放弃改动",   desc: "丢弃所有未提交更改，不可撤销", danger: true },
  ];

  return (
    <Modal title="新建分支" Icon={GitBranchPlus} onClose={onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit}
        confirmLabel={dirty && mode === "stash" ? "储藏并创建" : dirty && mode === "discard" ? "放弃并创建" : "创建并切换"}
        disabled={!valid} danger={dirty && mode === "discard"} />}>
      <Field label="基于分支">
        <select value={base} onChange={(e) => setBase(e.target.value)}
          className="text-xs px-2.5 py-2 cursor-pointer outline-none w-full" style={dlgCtl(t)}>
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
      </Field>
      <Field label="分支名称">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="feature/new-thing"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t, exists)} />
        {exists && <span className="text-[11px]" style={{ color: t.red }}>分支 {trimmed} 已存在</span>}
      </Field>

      {dirty && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: t.amber }}>
            <AlertTriangle size={12} className="flex-shrink-0" />
            <span>当前有未提交的更改，选择如何处理：</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {MODES.map((m) => {
              const active = mode === m.key;
              const tint = m.danger ? t.red : t.accent;
              return (
                <button key={m.key} {...press(() => setMode(m.key))}
                  className="flex items-start gap-2.5 px-3 py-2 text-left cursor-pointer transition-colors"
                  style={{ borderRadius: R - 2,
                    border: `0.5px solid ${active ? tint : t.inputBorder}`,
                    background: active ? tint + "14" : "transparent" }}>
                  <m.Icon size={14} className="flex-shrink-0 mt-0.5" style={{ color: active ? tint : t.textMuted }} />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs font-medium" style={{ color: active ? (m.danger ? t.red : t.text) : t.textSec }}>{m.label}</span>
                    <span className="text-[10px] leading-snug" style={{ color: t.textFaint }}>{m.desc}</span>
                  </div>
                  {active && <Check size={13} className="flex-shrink-0 mt-0.5" style={{ color: tint }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── RenameBranchDialog ─────────────────────────────────────────────────────
// Rename a local branch — for fixing a wrongly-named branch created by mistake.

function RenameBranchDialog({ branch, branches, onCancel, onConfirm }: {
  branch: Branch; branches: Branch[];
  onCancel: () => void; onConfirm: (newName: string) => void;
}) {
  const t = useTheme();
  const [name, setName] = useState(branch.name);
  const trimmed = name.trim();
  const exists = trimmed !== branch.name && branches.some((b) => b.name === trimmed);
  const valid = trimmed.length > 0 && trimmed !== branch.name && !exists && !/\s/.test(trimmed);
  const submit = () => { if (valid) onConfirm(trimmed); };

  return (
    <Modal title={`重命名分支 ${branch.name}`} Icon={Pencil} onClose={onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel="重命名" disabled={!valid} />}>
      <Field label="新分支名称">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="feature/right-name"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t, exists)} />
        {exists && <span className="text-[11px]" style={{ color: t.red }}>分支 {trimmed} 已存在</span>}
      </Field>
    </Modal>
  );
}

// ─── StashDialog ─────────────────────────────────────────────────────────────
// Optional title for a stash; empty falls back to the backend default.

function StashDialog({ busy, onCancel, onConfirm }: {
  busy?: boolean; onCancel: () => void; onConfirm: (message: string) => void;
}) {
  const t = useTheme();
  const [message, setMessage] = useState("");
  const submit = () => onConfirm(message.trim());

  return (
    <Modal title="储藏更改" Icon={Layers} onClose={onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel="储藏" busy={busy} />}>
      <Field label="储藏标题（可选）">
        <input autoFocus value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="GitKit stash（默认）"
          className="text-xs px-2.5 py-2 outline-none w-full" style={dlgCtl(t)} />
      </Field>
      <span className="text-[11px]" style={{ color: t.textFaint }}>不填则使用默认标题。已跟踪与未跟踪的改动都会一起储藏。</span>
    </Modal>
  );
}

// ─── TagDialog ───────────────────────────────────────────────────────────────

// Create a tag on the current branch's HEAD and push it to origin — the
// release flow that drives CI. Shows existing tags for reference.
function TagDialog({ path, currentBranch, busy, onCancel, onConfirm }: {
  path: string; currentBranch: string; busy: boolean;
  onCancel: () => void; onConfirm: (name: string, message: string) => void;
}) {
  const t = useTheme();
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    loadTags(path).then((ts) => { if (alive) setTags(ts); }).catch(() => { if (alive) setTags([]); });
    return () => { alive = false; };
  }, [path]);

  const trimmed = name.trim();
  const exists = (tags ?? []).some((tg) => tg.name === trimmed);
  const valid = trimmed.length > 0 && !exists && !/\s/.test(trimmed) && !busy;
  const submit = () => { if (valid) onConfirm(trimmed, message.trim()); };

  return (
    <Modal title="创建 Tag 并推送" Icon={TagIcon} onClose={onCancel} width={480}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel="创建并推送" disabled={!valid} busy={busy} />}>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium" style={{ color: t.textMuted }}>已有标签</span>
        <div className="flex flex-col max-h-40 overflow-y-auto"
          style={{ border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 2, background: t.inputBg }}>
          {tags === null ? (
            <div className="px-3 py-2 text-[11px]" style={{ color: t.textFaint }}>加载中…</div>
          ) : tags.length === 0 ? (
            <div className="px-3 py-2 text-[11px]" style={{ color: t.textFaint }}>还没有任何标签</div>
          ) : tags.map((tg) => (
            <div key={tg.name} className="flex items-center gap-2 px-3 py-1.5">
              <TagIcon size={11} className="flex-shrink-0" style={{ color: t.accent }} />
              <span className="text-xs font-mono font-medium" style={{ color: t.text }}>{tg.name}</span>
              <span className="text-[11px] font-mono" style={{ color: t.textFaint }}>{tg.target}</span>
              <span className="text-[11px] flex-1 text-right" style={{ color: t.textFaint }}>{tg.date}</span>
            </div>
          ))}
        </div>
      </div>
      <Field label={`新标签名（打在 ${currentBranch || "当前分支"} 的最新提交上）`}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="v0.2.0"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t, exists)} />
        {exists && <span className="text-[11px]" style={{ color: t.red }}>标签 {trimmed} 已存在</span>}
      </Field>
      <Field label="说明（可选，填了即带注释标签）">
        <input value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="Release v0.2.0"
          className="text-xs px-2.5 py-2 outline-none w-full" style={dlgCtl(t)} />
      </Field>
    </Modal>
  );
}

// ─── CherryPickDialog ────────────────────────────────────────────────────────

function CherryPickDialog({ commit, branches, currentBranch, onCancel, onConfirm }: {
  commit: Commit; branches: Branch[]; currentBranch: string;
  onCancel: () => void; onConfirm: (target: string) => void;
}) {
  const t = useTheme();
  const [target, setTarget] = useState(currentBranch || branches[0]?.name || "");
  return (
    <Modal title="遴选 (cherry-pick)" Icon={GitCommit} onClose={onCancel} width={480}
      footer={<ModalFooter onCancel={onCancel} onConfirm={() => onConfirm(target)} confirmLabel="遴选" disabled={!target} />}>
      <Field label="要遴选的提交">
        <div className="flex items-center gap-2.5 px-3 py-2.5" style={dlgCtl(t)}>
          <span className="font-mono text-[11px] flex-shrink-0" style={{ color: t.textFaint }}>{commit.hash}</span>
          <span className="text-xs truncate" style={{ color: t.text }}>{commit.message}</span>
        </div>
      </Field>
      <Field label="遴选到分支">
        <select value={target} onChange={(e) => setTarget(e.target.value)}
          className="text-xs px-2.5 py-2 cursor-pointer outline-none w-full" style={dlgCtl(t)}>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>{b.name}{b.name === currentBranch ? "（当前）" : ""}</option>
          ))}
        </select>
      </Field>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        提交会被复制到所选分支;若不是当前分支,会先自动切换过去。
      </span>
    </Modal>
  );
}

// ─── CherryPickConflictDialog ────────────────────────────────────────────────
// Shown when the preflight predicts the cherry-pick will conflict. Lists the
// conflicting files and lets the user cancel, or continue and (optionally) hand
// the conflicts to Kaleidoscope.

function CherryPickConflictDialog({ commit, target, files, onCancel, onContinue }: {
  commit: Commit; target: string; files: string[];
  onCancel: () => void; onContinue: (useKaleidoscope: boolean) => void;
}) {
  const t = useTheme();
  const [useKal, setUseKal] = useState(false);
  const [kalReady, setKalReady] = useState(false);
  useEffect(() => {
    let alive = true;
    checkDeps()
      .then((deps) => { if (alive) setKalReady(!!deps.find((d) => d.name === "ksdiff")?.found); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  return (
    <Modal title="遴选存在冲突" Icon={AlertTriangle} width={480} onClose={onCancel}
      footer={
        <div className="flex flex-col gap-2.5 w-full">
          <div className="flex items-center justify-end gap-2">
            <button {...press(onCancel)}
              className="px-3.5 py-2 text-xs font-medium cursor-pointer"
              style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>取消</button>
            <button {...press(() => onContinue(useKal && kalReady))}
              className="px-3.5 py-2 text-xs font-semibold cursor-pointer"
              style={{ background: t.accent, color: "#fff", borderRadius: R - 2 }}>继续遴选</button>
          </div>
          <label className="flex items-center gap-2 self-end select-none"
            style={{ cursor: kalReady ? "pointer" : "not-allowed", opacity: kalReady ? 1 : 0.5 }}>
            <input type="checkbox" checked={useKal && kalReady} disabled={!kalReady}
              onChange={(e) => setUseKal(e.target.checked)}
              style={{ accentColor: t.accent, cursor: kalReady ? "pointer" : "not-allowed" }} />
            <span className="text-[11px]" style={{ color: t.textMuted }}>
              使用 Kaleidoscope 处理冲突{kalReady ? "" : "（未检测到，见设置→环境依赖）"}
            </span>
          </label>
        </div>
      }>
      <div className="flex items-start gap-2.5 px-3 py-2.5" style={dlgCtl(t)}>
        <span className="font-mono text-[11px] flex-shrink-0 pt-px" style={{ color: t.textFaint }}>{commit.hash}</span>
        <span className="text-xs truncate" style={{ color: t.text }}>{commit.message}</span>
      </div>
      <span className="text-[11px]" style={{ color: t.textMuted }}>
        将 {commit.hash} 遴选到 <b style={{ color: t.text }}>{target}</b> 会在 {files.length} 个文件产生冲突：
      </span>
      <div className="flex flex-col gap-1 max-h-44 overflow-auto px-3 py-2"
        style={{ background: t.inputBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 }}>
        {files.map((f) => (
          <span key={f} className="text-[11px] font-mono truncate" style={{ color: t.red }}>{f}</span>
        ))}
      </div>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        继续后仓库会进入冲突解决状态。勾选 Kaleidoscope 会自动打开它逐个解决,解决完成后自动完成遴选;否则请解决冲突后执行 git cherry-pick --continue。
      </span>
    </Modal>
  );
}

// ─── CreatePRDialog (merge / pull request) ───────────────────────────────────

function CreatePRDialog({ path, branches, currentBranch, defaultTarget, term, onCancel, onConfirm }: {
  path?: string;
  branches: Branch[]; currentBranch: string; defaultTarget: string;
  term: string; // "合并请求" (GitLab) | "拉取请求" (GitHub)
  onCancel: () => void; onConfirm: (source: string, target: string, title: string, description: string) => Promise<void>;
}) {
  const t = useTheme();
  const [source, setSource] = useState(currentBranch || branches[0]?.name || "");
  const [target, setTarget] = useState(defaultTarget);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const same = source === target;
  const valid = title.trim().length > 0 && !same && !busy;

  // Live merge-conflict preview between source and target (no working-tree changes).
  const [preview, setPreview] = useState<{ state: "idle" | "checking" | "clean" | "conflict" | "error"; files: string[] }>({ state: "idle", files: [] });
  useEffect(() => {
    if (!path || same || !source || !target) { setPreview({ state: "idle", files: [] }); return; }
    let cancelled = false;
    setPreview((p) => ({ state: "checking", files: p.files }));
    const id = setTimeout(async () => {
      try {
        const r = await mergePreview(path, source, target);
        if (!cancelled) setPreview({ state: r.conflict ? "conflict" : "clean", files: r.files });
      } catch {
        if (!cancelled) setPreview({ state: "error", files: [] }); // degrade silently
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(id); };
  }, [path, source, target, same]);
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try { await onConfirm(source, target, title.trim(), desc); }
    finally { setBusy(false); }
  };
  const selectCls = "text-xs px-2.5 py-2 cursor-pointer outline-none w-full";
  return (
    <Modal title={`创建${term}`} Icon={GitPullRequest} onClose={onCancel} width={560}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel={`创建${term}`} disabled={!valid} busy={busy} />}>
      {/* merge route */}
      <div className="flex flex-col gap-2.5 p-3.5"
        style={{ background: t.inputBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 1 }}>
        <div className="flex flex-col gap-1.5">
          {/* labels — a 24px spacer holds the arrow column so labels stay aligned */}
          <div className="flex items-center gap-2.5">
            <span className="flex-1 min-w-0 text-[11px] font-medium" style={{ color: t.textMuted }}>来源分支</span>
            <span className="flex-shrink-0" style={{ width: 24 }} />
            <span className="flex-1 min-w-0 text-[11px] font-medium" style={{ color: t.textMuted }}>目标分支</span>
          </div>
          {/* controls — items-center keeps the arrow centred on the selects at any height */}
          <div className="flex items-center gap-2.5">
            <select value={source} onChange={(e) => setSource(e.target.value)}
              className={`flex-1 min-w-0 ${selectCls}`} style={dlgCtl(t)}>
              {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
            <div className="flex-shrink-0 flex items-center justify-center"
              style={{ width: 24, height: 24, borderRadius: 999, background: t.accentBg, color: t.accent }}>
              <ArrowRight size={13} />
            </div>
            <select value={target} onChange={(e) => setTarget(e.target.value)}
              className={`flex-1 min-w-0 ${selectCls}`} style={dlgCtl(t, same)}>
              {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>
        </div>
        {same && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium"
            style={{ background: t.redBg, color: t.red, borderRadius: R - 3 }}>
            <AlertTriangle size={12} className="flex-shrink-0" /> 来源与目标分支不能相同
          </div>
        )}
        {!same && preview.state === "checking" && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 3 }}>
            <RefreshCw size={12} className="animate-spin flex-shrink-0" /> 正在检测合并冲突…
          </div>
        )}
        {!same && preview.state === "clean" && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium"
            style={{ background: t.greenBg, color: t.green, borderRadius: R - 3 }}>
            <Check size={12} className="flex-shrink-0" /> 无冲突，可干净合并
          </div>
        )}
        {!same && preview.state === "conflict" && (
          <div className="flex flex-col gap-1.5 px-2.5 py-2"
            style={{ background: t.redBg, borderRadius: R - 3 }}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: t.red }}>
              <AlertTriangle size={12} className="flex-shrink-0" />
              检测到合并冲突 · {preview.files.length} 个文件
            </div>
            <div className="flex flex-col gap-0.5" style={{ maxHeight: 128, overflowY: "auto" }}>
              {preview.files.map((f) => (
                <div key={f} className="flex items-center gap-1.5 text-[11px] font-mono" style={{ color: t.red }}>
                  <FileText size={11} className="flex-shrink-0" style={{ opacity: 0.7 }} />
                  <span className="truncate" title={f}>{f}</span>
                </div>
              ))}
            </div>
            <span className="text-[10.5px] leading-relaxed" style={{ color: t.red, opacity: 0.85 }}>
              仍可创建{term}，冲突需在合并时解决。
            </span>
          </div>
        )}
      </div>

      <Field label="标题">
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={`${term}标题`} className="text-xs px-2.5 py-2 outline-none w-full" style={dlgCtl(t)} />
      </Field>
      <Field label="描述（可选）">
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={5}
          placeholder="补充说明…" className="text-xs px-2.5 py-2 outline-none w-full resize-none"
          style={{ ...dlgCtl(t), fontFamily: "inherit" }} />
      </Field>

      <div className="flex items-start gap-2 px-3 py-2.5"
        style={{ background: t.accentBg, borderRadius: R - 2 }}>
        <GitPullRequest size={13} className="flex-shrink-0 mt-0.5" style={{ color: t.accent }} />
        <span className="text-[11px] leading-relaxed" style={{ color: t.accentFg }}>
          来源分支需已推送到远程。创建成功后会自动在浏览器打开。
        </span>
      </div>
    </Modal>
  );
}

// ─── SettingsDialog ─────────────────────────────────────────────────────────

// Second-level pane: manage committer identities.
function IdentitySettings({ identities, setIdentities, defaultId, setDefaultId }: {
  identities: Identity[]; setIdentities: React.Dispatch<React.SetStateAction<Identity[]>>;
  defaultId: string; setDefaultId: (id: string) => void;
}) {
  const t = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const valid = name.trim().length > 0 && /.+@.+\..+/.test(email.trim());
  // The form is only mounted while adding a new identity or editing an existing one.
  const showForm = adding || editingId !== null;

  const reset = () => { setName(""); setEmail(""); setEditingId(null); setAdding(false); };
  const submit = () => {
    if (!valid) return;
    const n = name.trim(), e = email.trim();
    if (editingId) {
      setIdentities((prev) => prev.map((i) => i.id === editingId ? { ...i, name: n, email: e } : i));
    } else {
      const id = "id-" + Date.now();
      setIdentities((prev) => [...prev, { id, name: n, email: e }]);
      if (identities.length === 0) setDefaultId(id);
    }
    reset();
  };
  const startAdd = () => { setEditingId(null); setName(""); setEmail(""); setAdding(true); };
  const startEdit = (i: Identity) => { setAdding(false); setEditingId(i.id); setName(i.name); setEmail(i.email); };
  const remove = (id: string) => {
    setIdentities((prev) => {
      const next = prev.filter((i) => i.id !== id);
      if (id === defaultId) setDefaultId(next[0]?.id ?? "");
      return next;
    });
    if (editingId === id) reset();
  };

  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>提交者身份</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          维护多套 name / email,提交时按所选身份注入,不改动全局 git 配置。
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {identities.length === 0 && (
          <div className="text-[11px] px-1 py-6 text-center" style={{ color: t.textFaint }}>还没有身份,点击「新增身份」添加</div>
        )}
        {identities.map((i) => {
          const isDefault = i.id === defaultId;
          return (
            <div key={i.id} className="group flex items-center gap-2.5 px-2.5 py-2"
              style={{ borderRadius: R - 2, border: `0.5px solid ${isDefault ? t.accent + "66" : t.border}`,
                background: isDefault ? t.accentBg : "transparent" }}>
              <button {...press(() => setDefaultId(i.id))} title={isDefault ? "默认身份" : "设为默认"}
                className="flex-shrink-0 cursor-pointer p-0.5" style={{ color: isDefault ? t.accent : t.textFaint }}>
                <Star size={14} fill={isDefault ? t.accent : "none"} />
              </button>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-xs font-medium truncate" style={{ color: t.text }}>
                  {i.name}{isDefault && <span className="ml-1.5 text-[10px] font-normal" style={{ color: t.accent }}>默认</span>}
                </span>
                <span className="text-[11px] font-mono truncate" style={{ color: t.textMuted }}>{i.email}</span>
              </div>
              <button {...press(() => startEdit(i))}
                className="text-[11px] px-1.5 py-1 cursor-pointer opacity-0 group-hover:opacity-100"
                style={{ color: t.textMuted, borderRadius: R - 4 }}>编辑</button>
              <button {...press(() => remove(i.id))} title="删除"
                className="p-1 cursor-pointer opacity-0 group-hover:opacity-100"
                style={{ color: t.textMuted, borderRadius: R - 4 }}>
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {showForm ? (
        <div className="flex flex-col gap-2 p-3" style={{ background: t.inputBg + "80", borderRadius: R - 1, border: `0.5px solid ${t.border}` }}>
          <span className="text-[11px] font-semibold" style={{ color: t.textMuted }}>
            {editingId ? "编辑身份" : "新增身份"}
          </span>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="名称 (user.name)"
            className="text-xs px-2.5 py-2 outline-none" style={inputStyle} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱 (user.email)"
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            className="text-xs px-2.5 py-2 outline-none font-mono" style={inputStyle} />
          <div className="flex items-center justify-end gap-2">
            <button {...press(reset)} className="px-3 py-1.5 text-xs cursor-pointer"
              style={{ color: t.textMuted, borderRadius: R - 3 }}>取消</button>
            <button {...(valid ? press(submit) : {})} disabled={!valid}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
              style={{ background: valid ? t.accent : t.inputBg, color: valid ? "#fff" : t.textFaint,
                borderRadius: R - 3, opacity: valid ? 1 : 0.7, cursor: valid ? "pointer" : "not-allowed" }}>
              {editingId ? "保存" : "添加"}
            </button>
          </div>
        </div>
      ) : (
        <button {...press(startAdd)}
          className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium cursor-pointer transition-colors"
          style={{ color: t.textSec, borderRadius: R - 2, border: `0.5px dashed ${t.inputBorder}` }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textSec; }}>
          <UserPlus size={13} /> 新增身份
        </button>
      )}
    </div>
  );
}

// Second-level pane: a remote host connection (GitLab / GitHub). Parametrized so
// both providers share one implementation.
function RemoteConnSettings({ storageKey, title, desc, urlPlaceholder, tokenPlaceholder, hint, test }: {
  storageKey: string; title: string; desc: string;
  urlPlaceholder: string; tokenPlaceholder: string; hint: string;
  test: (url: string, token: string) => Promise<string>;
}) {
  const t = useTheme();
  const [saved, setSaved] = useState<RemoteConn>(() => loadConn(storageKey));
  const configured = saved.token.trim().length > 0;
  // Show the integrated card once a connection is saved; when nothing is saved a
  // "新增集成" button is shown instead. The form only appears while editing.
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(saved.url);
  const [token, setToken] = useState(saved.token);
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "err"; msg?: string }>({ kind: "idle" });

  const canSave = token.trim().length > 0;
  const canTest = token.trim().length > 0 && status.kind !== "testing";
  const runTest = async () => {
    if (!canTest) return;
    setStatus({ kind: "testing" });
    try {
      setStatus({ kind: "ok", msg: await test(url.trim(), token.trim()) });
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    }
  };
  const beginEdit = () => { setUrl(saved.url); setToken(saved.token); setStatus({ kind: "idle" }); setShowToken(false); setEditing(true); };
  const cancelEdit = () => { setUrl(saved.url); setToken(saved.token); setStatus({ kind: "idle" }); setShowToken(false); setEditing(false); };
  const saveNow = () => {
    if (!canSave) return;
    const next = { url: url.trim(), token: token.trim() };
    saveConn(storageKey, next);
    setSaved(next);
    setStatus({ kind: "idle" });
    setEditing(false);
  };
  const removeNow = () => {
    saveConn(storageKey, { url: "", token: "" });
    setSaved({ url: "", token: "" });
    setUrl(""); setToken(""); setStatus({ kind: "idle" }); setShowToken(false);
    setEditing(false);
    toast.success("已删除集成");
  };

  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>{title}</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>{desc}</span>
      </div>

      {configured && !editing ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 px-3.5 py-3"
            style={{ borderRadius: R - 2, border: `0.5px solid ${t.accent}44`, background: t.accentBg }}>
            <div className="flex items-center justify-center rounded-full flex-shrink-0"
              style={{ width: 30, height: 30, background: t.isDark ? "rgba(255,255,255,0.08)" : "#fff" }}>
              <Cloud size={15} style={{ color: t.accent }} />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium truncate" style={{ color: t.text }}>
                  {hostOf(saved.url) || saved.url || "已集成"}
                </span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: t.greenBg, color: t.green }}>已集成</span>
              </div>
              <span className="text-[11px] font-mono truncate" style={{ color: t.textMuted }}>
                ••••••••{saved.token.slice(-4)}
              </span>
            </div>
            <button {...press(beginEdit)}
              className="flex items-center gap-1 text-[11px] px-2 py-1 cursor-pointer flex-shrink-0"
              style={{ color: t.textMuted, borderRadius: R - 4 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = t.rowHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <Pencil size={12} /> 修改
            </button>
            <button {...press(removeNow)} title="删除"
              className="p-1 cursor-pointer flex-shrink-0"
              style={{ color: t.textMuted, borderRadius: R - 4 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.redBg; e.currentTarget.style.color = t.red; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
              <Trash2 size={13} />
            </button>
          </div>
          <span className="text-[10px]" style={{ color: t.textFaint }}>暂不支持多个集成,如需切换请修改或删除后重新填写。</span>
        </div>
      ) : editing ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium" style={{ color: t.textMuted }}>实例地址</span>
            <input value={url} onChange={(e) => { setUrl(e.target.value); setStatus({ kind: "idle" }); }}
              placeholder={urlPlaceholder}
              className="text-xs px-2.5 py-2 outline-none font-mono" style={inputStyle} />
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium" style={{ color: t.textMuted }}>访问令牌</span>
            <div className="flex items-center" style={{ ...inputStyle, paddingRight: 4 }}>
              <input value={token} onChange={(e) => { setToken(e.target.value); setStatus({ kind: "idle" }); }}
                type={showToken ? "text" : "password"} placeholder={tokenPlaceholder}
                className="flex-1 text-xs px-2.5 py-2 outline-none font-mono bg-transparent" style={{ color: t.text }} />
              <button {...press(() => setShowToken((v) => !v))} className="p-1.5 cursor-pointer flex-shrink-0"
                style={{ color: t.textMuted }} title={showToken ? "隐藏" : "显示"}>
                {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <span className="text-[10px]" style={{ color: t.textFaint }}>{hint}</span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button {...(canTest ? press(runTest) : {})} disabled={!canTest}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
              style={{ background: t.inputBg, color: canTest ? t.text : t.textFaint,
                border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3, cursor: canTest ? "pointer" : "not-allowed" }}>
              <RefreshCw size={12} className={status.kind === "testing" ? "animate-spin" : undefined} />
              检测连接
            </button>
            {status.kind === "ok" && (
              <span className="flex items-center gap-1.5 text-xs min-w-0" style={{ color: t.green }}>
                <Check size={13} className="flex-shrink-0" />
                <span className="truncate">已连接：{status.msg}</span>
              </span>
            )}
            {status.kind === "err" && (
              <span className="flex items-center gap-1.5 text-xs min-w-0" style={{ color: t.red }}>
                <AlertTriangle size={13} className="flex-shrink-0" />
                <span className="truncate">{status.msg}</span>
              </span>
            )}
            <div className="flex-1" />
            <button {...press(cancelEdit)} className="px-3 py-1.5 text-xs cursor-pointer"
              style={{ color: t.textMuted, borderRadius: R - 3 }}>取消</button>
            <button {...(canSave ? press(saveNow) : {})} disabled={!canSave}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
              style={{ background: canSave ? t.accent : t.inputBg, color: canSave ? "#fff" : t.textFaint,
                borderRadius: R - 3, opacity: canSave ? 1 : 0.7, cursor: canSave ? "pointer" : "not-allowed" }}>
              保存
            </button>
          </div>
        </>
      ) : (
        <button {...press(beginEdit)}
          className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium cursor-pointer transition-colors"
          style={{ color: t.textSec, borderRadius: R - 2, border: `0.5px dashed ${t.inputBorder}` }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textSec; }}>
          <Cloud size={13} /> 新增集成
        </button>
      )}
    </div>
  );
}

// GitHub integration: multiple accounts (label + optional GHE url + token) so one
// person can push different projects under different identities. Push / PR flows
// pick the account matching the remote host; when several match, the app prompts.
// Persisted to localStorage, migrated from the legacy single connection.
function GithubAccountsSettings() {
  const t = useTheme();
  const [accounts, setAccounts] = useState<GithubAccount[]>(loadGithubAccounts);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "err"; msg?: string }>({ kind: "idle" });
  // The form is only mounted while adding a new account or editing an existing one.
  const showForm = adding || editingId !== null;

  useEffect(() => { saveGithubAccounts(accounts); }, [accounts]);

  const valid = token.trim().length > 0;
  const reset = () => { setLabel(""); setUrl(""); setToken(""); setEditingId(null); setAdding(false); setStatus({ kind: "idle" }); setShowToken(false); };
  const submit = () => {
    if (!valid) return;
    const l = label.trim(), u = url.trim(), tk = token.trim();
    if (editingId) {
      setAccounts((prev) => prev.map((a) => a.id === editingId ? { ...a, label: l, url: u, token: tk } : a));
    } else {
      setAccounts((prev) => [...prev, { id: "gh-" + Date.now(), label: l, url: u, token: tk }]);
    }
    reset();
  };
  const startAdd = () => { setEditingId(null); setLabel(""); setUrl(""); setToken(""); setStatus({ kind: "idle" }); setShowToken(false); setAdding(true); };
  const startEdit = (a: GithubAccount) => { setAdding(false); setEditingId(a.id); setLabel(a.label); setUrl(a.url); setToken(a.token); setStatus({ kind: "idle" }); };
  const remove = (id: string) => {
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    // Drop per-project choices pointing at the deleted account, so they can't
    // linger in 项目配置 as dangling entries.
    for (const [path, accId] of Object.entries(loadPrefMap(ACCOUNT_PREFS))) {
      if (accId === id) deletePrefMapEntry(ACCOUNT_PREFS, path);
    }
    if (editingId === id) reset();
  };

  const canTest = token.trim().length > 0 && status.kind !== "testing";
  const runTest = async () => {
    if (!canTest) return;
    setStatus({ kind: "testing" });
    try { setStatus({ kind: "ok", msg: await githubTest(url.trim(), token.trim()) }); }
    catch (e) { setStatus({ kind: "err", msg: String(e) }); }
  };

  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;
  const hostLabel = (a: GithubAccount) => (a.url ? hostOf(a.url) : "github.com");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>GitHub 集成</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          维护多套 GitHub 账号(公有版留空地址,企业版填实例根地址)。推送 / 建 PR 时按远程地址自动匹配;匹配到多个账号会弹窗让你选择,只有一个则直接使用。
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {accounts.length === 0 && (
          <div className="text-[11px] px-1 py-6 text-center" style={{ color: t.textFaint }}>还没有账号,点击「新增账号」添加</div>
        )}
        {accounts.map((a) => (
          <div key={a.id} className="group flex items-center gap-2.5 px-2.5 py-2"
            style={{ borderRadius: R - 2, border: `0.5px solid ${t.border}` }}>
            <div className="flex items-center justify-center rounded-full flex-shrink-0"
              style={{ width: 26, height: 26, background: t.accentBg }}>
              <Github size={13} style={{ color: t.accent }} />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-xs font-medium truncate" style={{ color: t.text }}>{a.label || hostLabel(a)}</span>
              <span className="text-[11px] font-mono truncate" style={{ color: t.textMuted }}>
                {hostLabel(a)} · ••••{a.token.slice(-4)}
              </span>
            </div>
            <button {...press(() => startEdit(a))}
              className="text-[11px] px-1.5 py-1 cursor-pointer opacity-0 group-hover:opacity-100"
              style={{ color: t.textMuted, borderRadius: R - 4 }}>编辑</button>
            <button {...press(() => remove(a.id))} title="删除"
              className="p-1 cursor-pointer opacity-0 group-hover:opacity-100"
              style={{ color: t.textMuted, borderRadius: R - 4 }}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {showForm ? (
        <div className="flex flex-col gap-2 p-3" style={{ background: t.inputBg + "80", borderRadius: R - 1, border: `0.5px solid ${t.border}` }}>
          <span className="text-[11px] font-semibold" style={{ color: t.textMuted }}>{editingId ? "编辑账号" : "新增账号"}</span>
          <input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} placeholder="名称 / 备注(如 work、personal)"
            className="text-xs px-2.5 py-2 outline-none" style={inputStyle} />
          <input value={url} onChange={(e) => { setUrl(e.target.value); setStatus({ kind: "idle" }); }}
            placeholder="实例地址(公有版留空,企业版填 https://ghe.example.com)"
            className="text-xs px-2.5 py-2 outline-none font-mono" style={inputStyle} />
          <div className="flex items-center" style={{ ...inputStyle, paddingRight: 4 }}>
            <input value={token} onChange={(e) => { setToken(e.target.value); setStatus({ kind: "idle" }); }}
              type={showToken ? "text" : "password"} placeholder="访问令牌 ghp_… / github_pat_…"
              className="flex-1 text-xs px-2.5 py-2 outline-none font-mono bg-transparent" style={{ color: t.text }} />
            <button {...press(() => setShowToken((v) => !v))} className="p-1.5 cursor-pointer flex-shrink-0"
              style={{ color: t.textMuted }} title={showToken ? "隐藏" : "显示"}>
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
          <span className="text-[10px]" style={{ color: t.textFaint }}>推送需 repo 权限。令牌存储在本地(后续可迁移到系统钥匙串)。</span>
          <div className="flex items-center gap-3 flex-wrap">
            <button {...(canTest ? press(runTest) : {})} disabled={!canTest}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
              style={{ background: t.inputBg, color: canTest ? t.text : t.textFaint,
                border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3, cursor: canTest ? "pointer" : "not-allowed" }}>
              <RefreshCw size={12} className={status.kind === "testing" ? "animate-spin" : undefined} />
              检测连接
            </button>
            {status.kind === "ok" && (
              <span className="flex items-center gap-1.5 text-xs min-w-0" style={{ color: t.green }}>
                <Check size={13} className="flex-shrink-0" /><span className="truncate">已连接：{status.msg}</span>
              </span>
            )}
            {status.kind === "err" && (
              <span className="flex items-center gap-1.5 text-xs min-w-0" style={{ color: t.red }}>
                <AlertTriangle size={13} className="flex-shrink-0" /><span className="truncate">{status.msg}</span>
              </span>
            )}
            <div className="flex-1" />
            <button {...press(reset)} className="px-3 py-1.5 text-xs cursor-pointer"
              style={{ color: t.textMuted, borderRadius: R - 3 }}>取消</button>
            <button {...(valid ? press(submit) : {})} disabled={!valid}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
              style={{ background: valid ? t.accent : t.inputBg, color: valid ? "#fff" : t.textFaint,
                borderRadius: R - 3, opacity: valid ? 1 : 0.7, cursor: valid ? "pointer" : "not-allowed" }}>
              {editingId ? "保存" : "添加"}
            </button>
          </div>
        </div>
      ) : (
        <button {...press(startAdd)}
          className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium cursor-pointer transition-colors"
          style={{ color: t.textSec, borderRadius: R - 2, border: `0.5px dashed ${t.inputBorder}` }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textSec; }}>
          <UserPlus size={13} /> 新增账号
        </button>
      )}
    </div>
  );
}

// Second-level pane: appearance (frosted-glass window) + in-app update check.
function AppearanceSettings({ vibrancy, setVibrancy, paletteId, setPaletteId, themeMode, setThemeMode }: {
  vibrancy: boolean; setVibrancy: (v: boolean) => void;
  paletteId: PaletteId; setPaletteId: (id: PaletteId) => void;
  themeMode: ThemeMode; setThemeMode: (m: ThemeMode) => void;
}) {
  const t = useTheme();
  // Preview each family in the variant that the current mode resolves to, so the
  // swatches match what selecting it would actually render.
  const previewDark = themeMode === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : themeMode === "dark";
  const MODES: ThemeMode[] = ["light", "dark", "system"];

  return (
    <div className="flex flex-col gap-6">
      {/* Theme palette + mode */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>主题配色</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          选择配色方案与明暗模式。跟随系统时按 macOS 外观自动切换亮/暗。
        </span>
      </div>

      {/* Mode segmented control */}
      <div className="flex gap-1 -mt-3 p-0.5 w-fit"
        style={{ background: t.inputBg, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>
        {MODES.map((m) => {
          const active = themeMode === m;
          const { Icon, label } = THEME_META[m];
          return (
            <button key={m} {...press(() => setThemeMode(m))}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer transition-colors"
              style={{ borderRadius: R - 4,
                background: active ? t.accent : "transparent",
                color: active ? "#fff" : t.textSec }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = t.rowHover; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
              <Icon size={13} /> {label}
            </button>
          );
        })}
      </div>

      {/* Palette family cards */}
      <div className="grid grid-cols-2 gap-2.5 -mt-2">
        {PALETTE_ORDER.map((id) => {
          const pal = PALETTES[id];
          const preview = previewDark ? pal.dark : pal.light;
          const active = paletteId === id;
          return (
            <button key={id} {...press(() => setPaletteId(id))}
              className="flex flex-col gap-2.5 p-3 text-left cursor-pointer transition-all"
              style={{ borderRadius: R - 1,
                background: preview.bg,
                border: `1.5px solid ${active ? t.accent : t.border}`,
                boxShadow: active ? `0 0 0 3px ${t.accentBg}` : "none" }}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold" style={{ color: preview.text }}>{pal.label}</span>
                {active && <Check size={13} style={{ color: preview.accent }} />}
              </div>
              <div className="flex gap-1.5">
                {[preview.accent, preview.accent2, preview.accent3].map((c, i) => (
                  <span key={i} className="flex-1" style={{ height: 20, borderRadius: 5, background: c }} />
                ))}
              </div>
              <span className="text-[10px]" style={{ color: preview.textMuted }}>
                {previewDark ? "暗色预览" : "亮色预览"}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ height: "0.5px", background: t.border }} />

      {/* Vibrancy toggle */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>毛玻璃背景</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          启用 macOS 原生 vibrancy,窗口透出桌面模糊。关闭则使用不透明底色。
        </span>
      </div>
      <button {...press(() => setVibrancy(!vibrancy))}
        className="flex items-center gap-3 -mt-3 cursor-pointer w-fit">
        <span className="relative inline-flex flex-shrink-0 transition-colors"
          style={{ width: 38, height: 22, borderRadius: 11, background: vibrancy ? t.accent : t.inputBorder }}>
          <span className="absolute top-0.5 transition-all"
            style={{ width: 18, height: 18, borderRadius: 9, background: "#fff",
              left: vibrancy ? 18 : 2, boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
        </span>
        <span className="text-xs" style={{ color: t.textSec }}>{vibrancy ? "已开启" : "已关闭"}</span>
      </button>
    </div>
  );
}

// Second-level pane: the scheduled daily check for new upstream commits across
// every open project. The check itself lives in App (it needs the project list
// and the token lookup); this pane only edits the schedule and can trigger a run.
function DailyCheckSettings({ cfg, setCfg, onRunNow, busy, progress, projectCount }: {
  cfg: DailyCheck; setCfg: (c: DailyCheck) => void;
  onRunNow: () => void; busy: boolean; progress: CheckProgress | null; projectCount: number;
}) {
  const t = useTheme();
  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;
  const nextRun = (() => {
    if (busy && progress) return `正在检查 ${progress.current}/${progress.total} · ${progress.project}`;
    if (!cfg.enabled) return null;
    const today = scheduledAt(cfg.time);
    const due = Date.now() >= today && cfg.lastRun < today;
    if (due) return "启动后稍候即会执行(今天的检查还没做)";
    return today > Date.now() ? `今天 ${cfg.time}` : `明天 ${cfg.time}`;
  })();

  return (
    <div className="flex flex-col gap-4 max-w-[620px]">
      <div className="flex flex-col gap-1.5">
        <span className="text-base font-semibold" style={{ color: t.text }}>定时检查更新</span>
        <span className="text-xs leading-relaxed max-w-[62ch]" style={{ color: t.textMuted }}>
          每天自动获取已打开项目的远程分支。发现新提交后显示汇总窗口，并在应用位于后台时提醒你。
        </span>
      </div>

      <div className="flex flex-col overflow-hidden"
        style={{ borderRadius: R, border: `0.5px solid ${t.inputBorder}`, background: t.dialogBg }}>
        <div className="flex items-center gap-4 px-4 py-3.5">
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className="text-[13px] font-semibold" style={{ color: t.text }}>自动检查</span>
            <span className="text-xs" style={{ color: t.textMuted }}>到达设定时间后在后台检查全部项目</span>
          </div>
          <button {...press(() => setCfg({ ...cfg, enabled: !cfg.enabled }))}
            role="switch" aria-checked={cfg.enabled} aria-label="自动检查更新"
            className="relative inline-flex flex-shrink-0 cursor-pointer transition-colors"
            style={{ width: 38, height: 22, borderRadius: 11, background: cfg.enabled ? t.accent : t.inputBorder }}>
            <span className="absolute top-0.5 transition-[left] duration-150"
              style={{ width: 18, height: 18, borderRadius: 9, background: "#fff",
                left: cfg.enabled ? 18 : 2, boxShadow: "0 1px 3px rgba(0,0,0,0.24)" }} />
          </button>
        </div>

        <div className="flex items-center gap-3 px-4 py-3.5"
          style={{ borderTop: `0.5px solid ${t.border}`, opacity: cfg.enabled || busy ? 1 : 0.52 }}>
          <div className="flex items-center justify-center flex-shrink-0"
            style={{ width: 34, height: 34, borderRadius: R - 3, background: t.accentBg }}>
            <RefreshCw size={15} aria-hidden="true" className={busy ? "animate-spin" : undefined}
              style={{ color: t.accent }} />
          </div>
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <span className="text-[13px] font-medium" style={{ color: t.text }}>每天检查时间</span>
            <span className="text-xs truncate" style={{ color: busy ? t.accentFg : t.textMuted }}>
              {nextRun ?? "开启后按设定时间执行"}
            </span>
          </div>
          <label className="sr-only" htmlFor="daily-check-time">每天检查时间</label>
          <input id="daily-check-time" name="dailyCheckTime" type="time" value={cfg.time}
            disabled={!cfg.enabled || busy}
            onChange={(e) => setCfg({ ...cfg, time: e.target.value || DAILY_CHECK_DEFAULT.time })}
            className="text-xs px-2.5 py-2 outline-none font-mono tabular-nums flex-shrink-0"
            style={{ ...inputStyle, cursor: cfg.enabled && !busy ? "text" : "not-allowed" }} />
        </div>
      </div>

      <div className="flex items-center gap-3 min-h-9">
        <span className="text-xs min-w-0 flex-1" style={{ color: t.textMuted }}>
          {projectCount === 0 ? "还没有打开任何项目"
            : cfg.lastRun ? `上次检查：${formatFullDate(new Date(cfg.lastRun).toISOString())} · 共 ${projectCount} 个项目`
            : `将检查顶部已打开的 ${projectCount} 个项目`}
        </span>
        <button {...(busy || projectCount === 0 ? {} : press(onRunNow))} disabled={busy || projectCount === 0}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium flex-shrink-0"
          style={{ background: busy ? t.inputBg : t.accentBg, color: busy ? t.textFaint : t.accentFg,
            border: `0.5px solid ${busy ? t.inputBorder : t.accent + "55"}`, borderRadius: R - 3,
            cursor: busy || projectCount === 0 ? "not-allowed" : "pointer", opacity: projectCount === 0 ? 0.55 : 1 }}>
          <RefreshCw size={12} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
          {busy ? "检查中" : "立即检查"}
        </button>
      </div>

      <div className="flex items-start gap-2.5 px-3 py-2.5 text-xs leading-relaxed"
        style={{ color: t.textMuted, background: t.inputBg, borderRadius: R - 2 }}>
        <Check size={13} className="flex-shrink-0 mt-0.5" style={{ color: t.green }} />
        检查阶段只更新远程跟踪分支。统一拉取仅执行安全快进，分叉分支和有未提交更改的当前分支会保留原状。
      </div>
    </div>
  );
}

// Second-level pane: current version + in-app update check (download / verify /
// install / relaunch), split out from appearance into its own section.
function UpdateSettings() {
  const t = useTheme();
  const [version, setVersion] = useState<string>("");
  useEffect(() => { getAppVersion().then(setVersion).catch(() => {}); }, []);

  type UpState =
    | { kind: "idle" | "checking" | "uptodate" }
    | { kind: "avail"; version: string; notes?: string; install: (p?: (n: number) => void) => Promise<void> }
    | { kind: "downloading"; pct: number }
    | { kind: "err"; msg: string };
  const [up, setUp] = useState<UpState>({ kind: "idle" });
  const busy = up.kind === "checking" || up.kind === "downloading";

  const check = async () => {
    setUp({ kind: "checking" });
    try {
      const u = await checkForUpdate();
      if (!u) { setUp({ kind: "uptodate" }); return; }
      setUp({ kind: "avail", version: u.version, notes: u.notes, install: u.install });
    } catch (e) {
      setUp({ kind: "err", msg: String(e) });
    }
  };
  const install = async () => {
    if (up.kind !== "avail") return;
    const doInstall = up.install;
    setUp({ kind: "downloading", pct: 0 });
    try {
      await doInstall((p) => setUp({ kind: "downloading", pct: p }));
    } catch (e) {
      setUp({ kind: "err", msg: String(e) });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>软件更新</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          从发布服务器检查新版本。更新包经签名校验后下载、安装并重启。
        </span>
      </div>

      {/* Current version card */}
      <div className="flex items-center gap-3 px-3.5 py-3"
        style={{ borderRadius: R - 2, border: `0.5px solid ${t.border}`, background: t.inputBg }}>
        <div className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 40, height: 40, background: t.accentBg }}>
          <GitBranch size={18} style={{ color: t.accent }} />
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs font-semibold" style={{ color: t.text }}>GitKit</span>
          <span className="text-[11px] font-mono" style={{ color: t.textMuted }}>
            当前版本 {version ? `v${version}` : "—"}
          </span>
        </div>
        <button {...(busy ? {} : press(check))} disabled={busy}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium flex-shrink-0"
          style={{ background: t.accent, color: "#fff", borderRadius: R - 3,
            cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
          <RefreshCw size={12} className={up.kind === "checking" ? "animate-spin" : undefined} />
          检查更新
        </button>
      </div>

      {/* Status line */}
      {up.kind === "uptodate" && (
        <div className="flex items-center gap-1.5 text-xs -mt-2" style={{ color: t.green }}>
          <Check size={13} /> 已是最新版本
        </div>
      )}
      {up.kind === "avail" && (
        <div className="flex flex-col gap-2 -mt-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5 text-xs" style={{ color: t.text }}>
              <DownloadCloud size={13} style={{ color: t.accent }} /> 发现新版本 v{up.version}
            </span>
            <button {...press(install)}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium cursor-pointer"
              style={{ background: t.green, color: "#fff", borderRadius: R - 3 }}>
              <Download size={12} /> 下载并安装
            </button>
          </div>
          {up.notes && (
            <div className="text-[11px] whitespace-pre-wrap px-3 py-2"
              style={{ color: t.textMuted, background: t.inputBg, borderRadius: R - 3, maxHeight: 160, overflow: "auto" }}>
              {up.notes}
            </div>
          )}
        </div>
      )}
      {up.kind === "downloading" && (
        <div className="text-xs -mt-2" style={{ color: t.textSec }}>
          下载中 {Math.round(up.pct * 100)}%
        </div>
      )}
      {up.kind === "err" && (
        <div className="flex items-center gap-1.5 text-xs min-w-0 -mt-2" style={{ color: t.red }}>
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span className="truncate">{up.msg}</span>
        </div>
      )}
    </div>
  );
}

// Second-level pane: detect the CLI tools GitKit shells out to (git, git-lfs).
// Many repos configure Git LFS; if git-lfs isn't on the app's PATH, LFS hooks
// fail — this tells the user whether it's found and where.
function DependencySettings() {
  const t = useTheme();
  const [deps, setDeps] = useState<DepInfo[] | null>(null);
  const [checking, setChecking] = useState(false);
  const run = async () => {
    setChecking(true);
    try { setDeps(await checkDeps()); }
    catch (e) { toast.error(`检测失败：${e}`); }
    finally { setChecking(false); }
  };
  useEffect(() => { run(); }, []); // auto-check on open

  const meta: Record<string, { label: string; hint: string }> = {
    git: { label: "Git", hint: "核心依赖。macOS 装 Xcode Command Line Tools 或 Homebrew 即可获得。" },
    "git-lfs": { label: "Git LFS", hint: "许多仓库用它管理大文件。未安装时 checkout/push 的 LFS 钩子会报错。安装：brew install git-lfs && git lfs install" },
    ksdiff: { label: "Kaleidoscope", hint: "可选。遴选/合并冲突时用它图形化解决。安装 Kaleidoscope.app 后，在其菜单执行「Integrations → Install ksdiff」即可。" },
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold" style={{ color: t.text }}>环境依赖</span>
          <span className="text-[11px]" style={{ color: t.textFaint }}>
            检测 GitKit 调用的命令行工具是否在应用可见的 PATH 上。
          </span>
        </div>
        <button {...(checking ? {} : press(run))} disabled={checking}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium flex-shrink-0"
          style={{ background: t.accent, color: "#fff", borderRadius: R - 3,
            cursor: checking ? "not-allowed" : "pointer", opacity: checking ? 0.6 : 1 }}>
          <RefreshCw size={12} className={checking ? "animate-spin" : undefined} /> 重新检测
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {(deps ?? []).map((d) => {
          const m = meta[d.name] ?? { label: d.name, hint: "" };
          return (
            <div key={d.name} className="flex flex-col gap-1.5 px-3 py-2.5"
              style={{ background: t.inputBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 }}>
              <div className="flex items-center gap-2">
                <span className="flex items-center justify-center w-4 h-4 rounded-full flex-shrink-0"
                  style={{ background: d.found ? t.green + "22" : t.red + "22" }}>
                  {d.found ? <Check size={11} style={{ color: t.green }} /> : <X size={11} style={{ color: t.red }} />}
                </span>
                <span className="text-xs font-semibold" style={{ color: t.text }}>{m.label}</span>
                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded"
                  style={{ background: d.found ? t.greenBg : t.redBg, color: d.found ? t.green : t.red }}>
                  {d.found ? "已安装" : "未找到"}
                </span>
                {d.found && d.version && (
                  <span className="text-[11px] font-mono truncate" style={{ color: t.textMuted }}>{d.version}</span>
                )}
              </div>
              {d.found && d.path && (
                <span className="text-[10px] font-mono truncate pl-6" style={{ color: t.textFaint }}>{d.path}</span>
              )}
              {!d.found && m.hint && (
                <span className="text-[10px] pl-6" style={{ color: t.textFaint }}>{m.hint}</span>
              )}
            </div>
          );
        })}
        {deps === null && (
          <div className="text-[11px] px-1 py-4 text-center" style={{ color: t.textFaint }}>检测中…</div>
        )}
      </div>
    </div>
  );
}

// Per-project remembered choices (GitHub account for remote auth, committer
// identity), collected from every pref map into one row per repo path so they
// can be reviewed and cleared. Entries survive removing the project from the
// sidebar, so this is the only place stale ones can be pruned.
function ProjectPrefsSettings({ identities }: { identities: Identity[] }) {
  const t = useTheme();
  const accounts = loadGithubAccounts();
  const projects = loadProjects();

  const collect = () => {
    const accMap = loadPrefMap(ACCOUNT_PREFS);
    const idMap = loadPrefMap(IDENTITY_PREFS);
    const paths = Array.from(new Set([...Object.keys(accMap), ...Object.keys(idMap)])).filter(Boolean);
    return paths.map((path) => ({ path, accountId: accMap[path] ?? "", identityId: idMap[path] }))
      .sort((a, b) => a.path.localeCompare(b.path));
  };
  const [rows, setRows] = useState(collect);

  const clear = (path: string) => {
    deletePrefMapEntry(ACCOUNT_PREFS, path);
    deletePrefMapEntry(IDENTITY_PREFS, path);
    setRows(collect);
  };
  const clearAll = () => {
    for (const r of rows) { deletePrefMapEntry(ACCOUNT_PREFS, r.path); deletePrefMapEntry(IDENTITY_PREFS, r.path); }
    setRows(collect);
  };

  const nameOf = (path: string) =>
    projects.find((p) => p.path === path)?.name || path.split(/[/\\]/).filter(Boolean).pop() || path;
  const accountLabel = (id: string) => {
    if (!id) return null;
    const a = accounts.find((x) => x.id === id);
    if (!a) return "账号已删除";
    return a.label || (a.url ? hostOf(a.url) : "github.com");
  };
  const identityLabel = (id: string | undefined) => {
    if (id === undefined) return null;
    if (id === "") return "仓库 / 全局 Git 配置";
    const i = identities.find((x) => x.id === id);
    return i ? `${i.name} <${i.email}>` : "身份已删除";
  };
  const chip = (label: string, value: string, stale: boolean) => (
    <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] max-w-full"
      style={{ borderRadius: R - 4, background: t.inputBg, color: stale ? t.textFaint : t.textMuted }}>
      <span style={{ color: t.textFaint }}>{label}</span>
      <span className="truncate" style={{ color: stale ? t.amber : t.textSec }}>{value}</span>
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold" style={{ color: t.text }}>已保存的项目配置</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          这里是各个项目记住的选择：推送 / 拉取使用的 GitHub 账号,以及提交时使用的身份。删除后该项目会恢复为每次询问 / 使用默认身份。
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {rows.length === 0 && (
          <div className="text-[11px] px-1 py-6 text-center" style={{ color: t.textFaint }}>
            还没有保存的项目配置。在账号选择弹窗中勾选「记住本项目的选择」即可保存
          </div>
        )}
        {rows.map((r) => {
          const acc = accountLabel(r.accountId);
          const ident = identityLabel(r.identityId);
          return (
            <div key={r.path} className="group flex items-center gap-2.5 px-2.5 py-2"
              style={{ borderRadius: R - 2, border: `0.5px solid ${t.border}` }}>
              <div className="flex items-center justify-center rounded-full flex-shrink-0"
                style={{ width: 26, height: 26, background: t.accentBg }}>
                <FolderGit2 size={13} style={{ color: t.accent }} />
              </div>
              <div className="flex flex-col min-w-0 flex-1 gap-1">
                <span className="text-xs font-medium truncate" style={{ color: t.text }}>{nameOf(r.path)}</span>
                <span className="text-[10px] font-mono truncate" style={{ color: t.textFaint }}>{r.path}</span>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {acc && chip("GitHub", acc, acc === "账号已删除")}
                  {ident && chip("提交者", ident, ident === "身份已删除")}
                </div>
              </div>
              <button {...press(() => clear(r.path))} title="删除该项目的保存配置"
                className="p-1 cursor-pointer opacity-0 group-hover:opacity-100"
                style={{ color: t.textMuted, borderRadius: R - 4 }}>
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {rows.length > 1 && (
        <button {...press(clearAll)}
          className="self-start flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
          style={{ background: t.inputBg, color: t.textMuted, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 }}>
          <Trash2 size={12} />清空全部
        </button>
      )}
    </div>
  );
}

function SettingsDialog({ identities, setIdentities, defaultId, setDefaultId, vibrancy, setVibrancy,
  paletteId, setPaletteId, themeMode, setThemeMode, dailyCheck, setDailyCheck,
  onRunCheckNow, checkBusy, checkProgress, projectCount, onClose }: {
  identities: Identity[]; setIdentities: React.Dispatch<React.SetStateAction<Identity[]>>;
  defaultId: string; setDefaultId: (id: string) => void;
  vibrancy: boolean; setVibrancy: (v: boolean) => void;
  paletteId: PaletteId; setPaletteId: (id: PaletteId) => void;
  themeMode: ThemeMode; setThemeMode: (m: ThemeMode) => void;
  dailyCheck: DailyCheck; setDailyCheck: (c: DailyCheck) => void;
  onRunCheckNow: () => void; checkBusy: boolean; checkProgress: CheckProgress | null; projectCount: number;
  onClose: () => void;
}) {
  const t = useTheme();
  const MENU = [
    { group: "账户", key: "identity",   label: "提交者身份", Icon: Users },
    { group: "账户", key: "gitlab",     label: "GitLab 集成", Icon: Cloud },
    { group: "账户", key: "github",     label: "GitHub 集成", Icon: Github },
    { group: "工作区", key: "projects",   label: "项目配置", Icon: FolderGit2 },
    { group: "工作区", key: "daily",      label: "定时检查", Icon: RefreshCw },
    { group: "偏好", key: "appearance", label: "外观", Icon: Sparkles },
    { group: "系统", key: "update",     label: "软件更新", Icon: DownloadCloud },
    { group: "系统", key: "deps",       label: "环境依赖", Icon: TerminalSquare },
  ] as const;
  const [section, setSection] = useState<(typeof MENU)[number]["key"]>("identity");

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 200 }}>
      <div className="absolute inset-0 gk-overlay-in" style={{ background: "rgba(0,0,0,0.45)" }} {...press(onClose)} />
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title"
        className="relative flex flex-col gk-modal-in" style={{ width: "min(780px, calc(100vw - 48px))",
        height: "min(520px, calc(100vh - 48px))",
        background: t.dialogBg,
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R + 2, boxShadow: t.shadowWindow, overflow: "hidden" }}>
        <div className="flex-shrink-0 flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: `0.5px solid ${t.border}` }}>
          <Settings size={15} style={{ color: t.accent }} />
          <span id="settings-title" className="text-sm font-semibold flex-1" style={{ color: t.text }}>设置</span>
          <button {...press(onClose)}
            aria-label="关闭设置" title="关闭"
            className="flex items-center justify-center w-7 h-7 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 3 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = t.inputBg)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* First-level menu */}
          <nav aria-label="设置分类" className="flex-shrink-0 flex flex-col py-2.5 px-2 overflow-y-auto"
            style={{ width: 174, borderRight: `0.5px solid ${t.border}`, background: t.isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.015)" }}>
            {MENU.map((m, index) => {
              const active = section === m.key;
              return (
                <div key={m.key}>
                  {(index === 0 || MENU[index - 1].group !== m.group) && (
                    <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold" style={{ color: t.textFaint }}>{m.group}</div>
                  )}
                  <button {...press(() => setSection(m.key))} aria-current={active ? "page" : undefined}
                    className="flex items-center gap-2.5 w-full px-2.5 py-1.5 text-left cursor-pointer transition-colors"
                    style={{ borderRadius: R - 3, background: active ? t.accentBg : "transparent",
                      color: active ? t.accentFg : t.textSec }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = t.rowHover; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                    <m.Icon size={14} aria-hidden="true" style={{ color: active ? t.accent : t.textMuted }} />
                    <span className="text-[12px] font-medium">{m.label}</span>
                  </button>
                </div>
              );
            })}
          </nav>

          {/* Second-level content */}
          <div className="flex-1 overflow-y-auto px-6 py-5 overscroll-contain">
            {section === "identity" && (
              <IdentitySettings identities={identities} setIdentities={setIdentities}
                defaultId={defaultId} setDefaultId={setDefaultId} />
            )}
            {section === "gitlab" && (
              <RemoteConnSettings storageKey="gitkit.gitlab" title="自建 GitLab 集成"
                desc="填入自建 GitLab 实例地址与个人访问令牌 (Personal Access Token),用于列项目、创建合并请求、推送认证。"
                urlPlaceholder="https://gitlab.example.com" tokenPlaceholder="glpat-…"
                hint="推送需 write_repository 权限;列项目/建 MR 需 api 权限。令牌存储在本地(后续可迁移到系统钥匙串)。"
                test={gitlabTest} />
            )}
            {section === "github" && <GithubAccountsSettings />}
            {section === "projects" && <ProjectPrefsSettings identities={identities} />}
            {section === "daily" && (
              <DailyCheckSettings cfg={dailyCheck} setCfg={setDailyCheck}
                onRunNow={onRunCheckNow} busy={checkBusy} progress={checkProgress} projectCount={projectCount} />
            )}
            {section === "appearance" && (
              <AppearanceSettings vibrancy={vibrancy} setVibrancy={setVibrancy}
                paletteId={paletteId} setPaletteId={setPaletteId}
                themeMode={themeMode} setThemeMode={setThemeMode} />
            )}
            {section === "update" && <UpdateSettings />}
            {section === "deps" && <DependencySettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Update check results ───────────────────────────────────────────────────
// One open project's outcome from a scheduled (or manual) update check, plus how
// the follow-up pull went for it.
interface UpdateRow {
  id: string; name: string; path: string;
  behind: BehindBranch[]; dirty: boolean; currentBranch: string;
  error?: string;                                   // the check itself failed
  state: "idle" | "pulling" | "done" | "failed";
  detail?: string;                                  // what the pull did / why it didn't
}
/** Branches a plain fast-forward can bring in — diverged ones need a real merge. */
const ffable = (r: UpdateRow) => r.behind.filter((b) => b.ahead === 0 && !(b.current && r.dirty));

function UpdatesDialog({ rows, busy, onPull, onClose }: {
  rows: UpdateRow[]; busy: boolean;
  onPull: (ids: string[]) => void; onClose: () => void;
}) {
  const t = useTheme();
  // Only projects with something a fast-forward can actually apply start ticked.
  const [sel, setSel] = useState<string[]>(() => rows.filter((r) => !r.error && ffable(r).length).map((r) => r.id));
  const toggle = (id: string) => setSel((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  // A project already pulled drops out of the selection — re-running it would be a
  // no-op, and the button going to (0) is what says the batch is finished.
  const selectable = rows.filter((r) => !r.error && r.state !== "done" && ffable(r).length);
  const chosen = sel.filter((id) => selectable.some((r) => r.id === id));
  const finished = rows.some((r) => r.state === "done" || r.state === "failed");
  const total = rows.reduce((n, r) => n + r.behind.reduce((m, b) => m + b.behind, 0), 0);

  return (
    <Modal title="远程有新的提交" Icon={DownloadCloud} onClose={busy ? () => {} : onClose} width={560}
      footer={
        <>
          <button {...(busy ? {} : press(onClose))} disabled={busy}
            className="px-3.5 py-2 text-xs font-medium"
            style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}`,
              cursor: busy ? "not-allowed" : "pointer" }}>
            {finished ? "完成" : "稍后再说"}
          </button>
          <button {...(busy || !chosen.length ? {} : press(() => onPull(chosen)))} disabled={busy || !chosen.length}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold"
            style={{ background: busy || !chosen.length ? t.inputBg : t.accent,
              color: busy || !chosen.length ? t.textFaint : "#fff",
              borderRadius: R - 2, cursor: busy || !chosen.length ? "not-allowed" : "pointer" }}>
            {busy ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
            {busy ? "拉取中…" : `拉取选中 (${chosen.length})`}
          </button>
        </>
      }>
      <div className="text-xs" style={{ color: t.textSec }}>
        {rows.length} 个项目的远程有新提交,共 {total} 个提交。拉取只做快进,不会产生合并提交。
      </div>

      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const can = !r.error && ffable(r).length > 0;
          const checked = can && sel.includes(r.id);
          const diverged = r.behind.filter((b) => b.ahead > 0);
          const dirtyBlocked = r.behind.some((b) => b.current && r.dirty && b.ahead === 0);
          return (
            <div key={r.id} className="flex items-start gap-2.5 px-3 py-2.5"
              style={{ borderRadius: R - 2, border: `0.5px solid ${checked ? t.accent + "66" : t.border}`,
                background: checked ? t.accentBg : "transparent", opacity: can || r.error ? 1 : 0.75 }}>
              <button {...(can && !busy ? press(() => toggle(r.id)) : {})}
                className="flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ width: 15, height: 15, borderRadius: 4,
                  border: `1.5px solid ${checked ? t.accent : t.inputBorder}`,
                  background: checked ? t.accent : "transparent",
                  cursor: can && !busy ? "pointer" : "not-allowed" }}>
                {checked && <Check size={10} strokeWidth={3} style={{ color: "#fff" }} />}
              </button>
              <div className="flex flex-col min-w-0 flex-1 gap-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-semibold truncate" style={{ color: t.text }}>{r.name}</span>
                  {r.state === "pulling" && <RefreshCw size={11} className="animate-spin flex-shrink-0" style={{ color: t.accent }} />}
                  {r.state === "done" && <Check size={12} className="flex-shrink-0" style={{ color: t.green }} />}
                  {r.state === "failed" && <AlertTriangle size={12} className="flex-shrink-0" style={{ color: t.red }} />}
                </div>
                {r.error ? (
                  <span className="text-[11px]" style={{ color: t.red }}>检查失败：{r.error}</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {r.behind.map((b) => (
                      <span key={b.name} className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono"
                        style={{ borderRadius: R - 4, background: t.inputBg, color: t.textSec,
                          border: `0.5px solid ${branchColor(b.name)}44` }}>
                        <GitBranch size={9} style={{ color: branchColor(b.name) }} />
                        {b.name}
                        <span style={{ color: t.accent }}>↓{b.behind}</span>
                        {b.ahead > 0 && <span style={{ color: t.amber }}>↑{b.ahead}</span>}
                      </span>
                    ))}
                  </div>
                )}
                {r.detail && (
                  <span className="text-[11px]" style={{ color: r.state === "failed" ? t.red : t.textMuted }}>{r.detail}</span>
                )}
                {!r.detail && diverged.length > 0 && (
                  <span className="text-[11px]" style={{ color: t.amber }}>
                    {diverged.map((b) => b.name).join("、")} 与远程有分叉,需手动合并
                  </span>
                )}
                {!r.detail && dirtyBlocked && (
                  <span className="text-[11px]" style={{ color: t.amber }}>
                    {r.currentBranch} 有未提交更改,拉取时会跳过
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

type RealData = { path: string; branches: Branch[]; remotes: Remote[]; commits: Commit[]; graph: GraphRowInfo[]; working: WorkingFile[]; stashes: Stash[] };

// ─── ContextMenu ────────────────────────────────────────────────────────────────
// A single right-click menu, positioned at the cursor and clamped to the viewport.
// Only elements with real actions open one; everywhere else the native menu is
// suppressed (see the global contextmenu handler in App), so right-click is inert.
type CtxItem =
  | { sep: true }
  | { sep?: false; label: string; Icon?: React.ElementType; danger?: boolean; onClick: () => void };
interface CtxState { x: number; y: number; items: CtxItem[] }

function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number; items: CtxItem[]; onClose: () => void;
}) {
  const t = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width  > window.innerWidth  - 8) left = window.innerWidth  - r.width  - 8;
    if (top  + r.height > window.innerHeight - 8) top  = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0" style={{ zIndex: 200 }}
        onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} className="fixed" style={{
        top: pos.top, left: pos.left, zIndex: 201, minWidth: 176,
        background: t.dialogBg,
        backdropFilter: "blur(24px) saturate(180%)", WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R, boxShadow: t.shadowWindow, padding: 5,
      }}>
        {items.map((it, i) => it.sep ? (
          <div key={i} style={{ height: "0.5px", background: t.border, margin: "4px 6px" }} />
        ) : (
          <button key={i} onClick={() => { onClose(); it.onClick(); }}
            className="w-full flex items-center gap-2.5 px-2 py-1.5 text-left cursor-pointer"
            style={{ borderRadius: R - 3, color: it.danger ? t.red : t.text }}
            onMouseEnter={(e) => { e.currentTarget.style.background = it.danger ? t.redBg : t.rowHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
            {it.Icon && <it.Icon size={13} className="flex-shrink-0" style={{ color: it.danger ? t.red : t.textMuted }} />}
            <span className="text-[12px] font-medium">{it.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(loadThemeMode);
  const [systemIsDark, setSystemIsDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  useEffect(() => { localStorage.setItem("gitkit.themeMode", themeMode); }, [themeMode]);

  // ── colour palette family (warm / blue …), persisted ──
  const [paletteId, setPaletteId] = useState<PaletteId>(loadPaletteId);
  useEffect(() => { localStorage.setItem("gitkit.palette", paletteId); }, [paletteId]);
  const palette = PALETTES[paletteId] ?? PALETTES.warm;

  const effectiveDark = themeMode === "system" ? systemIsDark : themeMode === "dark";
  const cycleTheme = () => setThemeMode(THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % THEME_CYCLE.length]);

  // ── window vibrancy (frosted glass), persisted; default on ──
  const [vibrancy, setVibrancyState] = useState<boolean>(
    () => localStorage.getItem("gitkit.vibrancy") !== "0"
  );
  useEffect(() => {
    localStorage.setItem("gitkit.vibrancy", vibrancy ? "1" : "0");
    setVibrancy(vibrancy).catch(() => { /* not in Tauri shell */ });
  }, [vibrancy]);

  const theme = glassify(effectiveDark ? palette.dark : palette.light, vibrancy);

  // ── settings + committer identities (persisted) ──
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [identities, setIdentities] = useState<Identity[]>(loadIdentities);
  const [defaultIdentityId, setDefaultIdentityId] = useState<string>(loadDefaultIdentityId);
  useEffect(() => { saveIdentities(identities); }, [identities]);
  useEffect(() => { localStorage.setItem("gitkit.defaultIdentityId", defaultIdentityId); }, [defaultIdentityId]);

  // ── project state (restored from last session) ──
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState<string>(loadActiveProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const isReal = !!activeProject;
  useEffect(() => { saveProjects(projects); }, [projects]);
  useEffect(() => { localStorage.setItem("gitkit.activeProjectId", activeProjectId); }, [activeProjectId]);

  const [selectedCommit, setSelectedCommit]   = useState<Commit | null>(null);
  const [commitQuery, setCommitQuery] = useState("");
  const deferredCommitQuery = useDeferredValue(commitQuery.trim().toLocaleLowerCase());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile]       = useState<CommitFile | null>(null);
  const [viewChanges, setViewChanges]         = useState(false);
  const [currentBranch, setCurrentBranch]     = useState(activeProject?.branch ?? "");
  const [hoverBranch, setHoverBranch]         = useState<string | null>(null);
  const [focusBranch, setFocusBranch]         = useState<string | null>(null);
  const [hiddenBranches, setHiddenBranches]   = useState<string[]>([]);
  const [pinnedBranches, setPinnedBranches]   = useState<string[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<WorkingFile | null>(null);
  // Stash under inspection (with its loaded files) + the file whose diff is shown.
  const [selectedStash, setSelectedStash] = useState<(Stash & { files: CommitFile[] }) | null>(null);
  const [selectedStashFile, setSelectedStashFile] = useState<CommitFile | null>(null);

  useEffect(() => {
    const focusSearch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // Right-click menu. Native (webview) menu is suppressed everywhere except text
  // fields; only elements that call openCtx get an actual menu.
  const [ctxMenu, setCtxMenu] = useState<CtxState | null>(null);
  const openCtx = (e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };
  useEffect(() => {
    const onNative = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [contenteditable='true']")) return; // keep copy/paste
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onNative);
    return () => document.removeEventListener("contextmenu", onNative);
  }, []);

  // ── real-repo data (loaded from the Rust git backend, cached per repo path) ──
  const [realData, setRealData] = useState<RealData | null>(null);
  const [loadError, setLoadError] = useState<{ path: string; msg: string } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [checkoutTarget, setCheckoutTarget] = useState<{ branch: string; dirty: boolean } | null>(null);
  const [cherryTarget, setCherryTarget] = useState<Commit | null>(null);
  const [cherryConflict, setCherryConflict] = useState<{ commit: Commit; target: string; files: string[] } | null>(null);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Branch | null>(null);
  // `worktree` set → the branch is held by a linked worktree; confirming also
  // removes that worktree (destructive) before deleting the branch.
  const [deleteBranchTarget, setDeleteBranchTarget] = useState<{ branch: Branch; force: boolean; worktree?: string } | null>(null);
  const [deleteBranchBusy, setDeleteBranchBusy] = useState(false);
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagBusy, setTagBusy] = useState(false);
  const [stashDialogOpen, setStashDialogOpen] = useState(false);
  const [stashBusy, setStashBusy] = useState(false);
  const [confirmState, setConfirmState] = useState<null | {
    title: string; message: string; confirmLabel: string; onConfirm: () => Promise<void>;
  }>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailClosing, setDetailClosing] = useState(false); // keep mounted for the exit slide
  const openDetail = () => { setDetailClosing(false); setDetailOpen(true); };
  const closeDetail = () => { setDetailOpen(false); setDetailClosing(true); };
  const [gitBusy, setGitBusy] = useState<null | "fetch" | "pull" | "push">(null);
  // Mirror gitBusy in a ref so the working-tree watcher can skip reloads during a
  // git op without re-subscribing the watcher every time gitBusy flips.
  const gitBusyRef = useRef(gitBusy);
  gitBusyRef.current = gitBusy;
  const [busyLabel, setBusyLabel] = useState<string | null>(null); // generic blocking-op overlay
  const [gitProg, setGitProg] = useState<GitProgress | null>(null); // live fetch/pull progress
  const gitOpId = useRef<string | null>(null);                      // id of the running cancellable op
  const [cancelling, setCancelling] = useState(false);              // cancel requested, awaiting unwind
  const realCache = useRef<Map<string, RealData>>(new Map());
  const lastLoadedPath = useRef<string | null>(null);   // to tell a switch from a refresh
  const pendingViewReset = useRef(false);                // branch-changing reloads force a view reset
  const pendingJumpLatest = useRef(false);               // fetch/pull → jump to the newest commit
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  // View switches (focus a branch / 全部视图) can rebuild a large list — mark
  // them non-urgent so the click stays snappy and the old view holds until ready.
  const setFocus = (name: string | null) => startTransition(() => setFocusBranch(name));

  // Project switches rebuild the whole timeline. Applying the new repo's data
  // as a transition keeps the click instant (the skeleton shows via `dataReady`)
  // and lets the heavy list render happen interruptibly instead of freezing the
  // main thread for ~1s. `switching` is true until the new timeline is painted.
  const [switching, startSwitch] = useTransition();

  // Esc closes the detail overlay.
  useEffect(() => {
    if (!detailOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen]);

  // Data belongs to the active project only when its path matches. On a tab
  // switch this flips false on the very first (urgent) render, so the target
  // shows a skeleton immediately while its data loads — the click never blocks.
  const dataReady = !!activeProject && realData?.path === activeProject.path;
  const view = dataReady ? realData : null;
  const errored = !!loadError && loadError.path === activeProject?.path;
  const branches   = view?.branches ?? [];
  const remotes    = view?.remotes ?? [];
  const commits    = view?.commits ?? [];
  const graphRows  = view?.graph ?? [];
  const stashes = view?.stashes ?? [];
  const activeWorking = view?.working ?? [];
  const changesCount = activeWorking.length;
  const remoteNames = remotes.map((r) => r.name);

  // ── persist per-repo UI state (hidden/pinned branches, collapsed folders) ──
  const prefsKey = activeProject?.path ?? "";
  const prefsLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    const p = loadUiPrefs(prefsKey);
    setHiddenBranches(p.hidden);
    setPinnedBranches(p.pinned);
    setCollapsedFolders(p.collapsed);
    prefsLoadedFor.current = prefsKey;
  }, [prefsKey]);
  useEffect(() => {
    // Skip the render where the key just switched but state is still the old
    // project's — the load effect above owns that transition.
    if (prefsLoadedFor.current !== prefsKey) return;
    saveUiPrefs(prefsKey, { hidden: hiddenBranches, pinned: pinnedBranches, collapsed: collapsedFolders });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenBranches, pinnedBranches, collapsedFolders]);

  // Focus mode: show only one branch's commits, with edges trimmed to that set
  // so the graph collapses to a single clean line.
  const focusActive = !!focusBranch && isReal;
  // A commit's branch memberships (full backbone list, falling back to primary).
  const memberOf = (c: Commit): string[] =>
    c.branchLabels?.length ? c.branchLabels : c.branchLabel ? [c.branchLabel] : [];

  // Every local branch's first-parent backbone: branch → (commit hash → depth
  // below that branch's tip). Depth is what tells the two sides of a fork apart —
  // the branch that reaches the shared commit in fewer steps is the one the other
  // was created from.
  const backbones = useMemo(() => {
    const byHash = new Map(commits.map((c) => [c.fullHash, c]));
    const m = new Map<string, Map<string, number>>();
    for (const b of branches) {
      const depth = new Map<string, number>();
      let h: string | undefined = b.head;
      let i = 0;
      while (h && byHash.has(h) && !depth.has(h)) {
        depth.set(h, i++);
        h = byHash.get(h)!.parents[0] as string | undefined;
      }
      m.set(b.name, depth);
    }
    return m;
  }, [commits, branches]);

  // Trunk-ish leaf names outrank topic branches when deciding which side of a
  // fork is the base.
  const TRUNK = new Set(["master", "main", "develop", "dev", "trunk"]);

  // Focused (single-branch) view: walk the branch tip's first-parent chain and
  // keep only the commits UNIQUE to it. We stop at the first commit that also sits
  // on a MORE SENIOR branch's backbone — that's the fork point, and that branch is
  // the "base" this branch was created from. Membership (not tip equality) is what
  // keeps this correct once the base branch moves on: master's tip stops sitting on
  // our chain the moment it gains a commit, and a tip-only test would then run to
  // the bottom of history and blame some unrelated stale branch.
  // Seniority breaks the symmetry — a shared commit alone can't say who forked from
  // whom. A branch is senior if it is a trunk/published branch while we are not, or
  // if it reaches the shared commit in fewer steps than we do AND does not outrank
  // us in the other direction. The rank guard matters: a child branch left sitting
  // on master's old tip reaches that commit in 0 steps, and without it focusing
  // master would truncate right there and claim master came from the child.
  const focusInfo = (() => {
    if (!focusActive || !focusBranch) return null;
    const br = branches.find((b) => b.name === focusBranch);
    if (!br?.head) return { list: [] as Commit[], base: null as string | null };
    const map = new Map<string, Commit>(commits.map((cc) => [cc.fullHash, cc]));
    const rank = (name: string) => {
      const leaf = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
      if (TRUNK.has(leaf)) return 0;
      return branches.find((b) => b.name === name)?.remote ? 1 : 2;
    };
    const myRank = rank(focusBranch);

    const list: Commit[] = [];
    const seen = new Set<string>();
    let h: string | undefined = br.head;
    let base: string | null = null;
    let i = 0;
    while (h && map.has(h) && !seen.has(h)) {
      seen.add(h);
      const senior: { name: string; r: number; d: number }[] = [];
      for (const [name, depth] of backbones) {
        if (name === focusBranch) continue;
        const d = depth.get(h);
        if (d === undefined) continue;
        const r = rank(name);
        if (r < myRank || (d < i && r <= myRank)) senior.push({ name, r, d });
      }
      if (senior.length) {
        // Trunk first, then the branch sitting closest to the fork point.
        senior.sort((a, b2) => a.r - b2.r || a.d - b2.d);
        base = senior[0].name;
        break;
      }
      const c: Commit = map.get(h)!;
      list.push(c);
      h = c.parents[0] as string | undefined;
      i++;
    }
    return { list, base };
  })();

  // Hidden branches drop out of the all-view graph — but a commit shared by a
  // visible branch stays.
  const base = isReal && hiddenBranches.length > 0
    ? commits.filter((c) => { const m = memberOf(c); return m.length === 0 || m.some((n) => !hiddenBranches.includes(n)); })
    : commits;
  const scopedCommits = focusActive ? (focusInfo?.list ?? []) : base;
  const displayCommits = deferredCommitQuery
    ? scopedCommits.filter((c) => [
        c.message, c.body, c.author.name, c.author.email, c.hash, c.fullHash,
        c.branchLabel, ...(c.branchLabels ?? []), ...(c.tags ?? []),
      ].filter(Boolean).join("\n").toLocaleLowerCase().includes(deferredCommitQuery))
    : scopedCommits;
  const displayGraph = (() => {
    if (!deferredCommitQuery && (!isReal || (!focusActive && hiddenBranches.length === 0))) return graphRows;
    const set = new Set(displayCommits.map((c) => c.fullHash));
    return computeGraph(displayCommits.map((c) => ({ ...c, parents: c.parents.filter((p) => set.has(p)) })));
  })();

  // Busiest lane index across the visible graph — drives a SINGLE global lane step
  // so vertical lane lines stay aligned row-to-row.
  const maxLane = displayGraph.reduce((m, r) => {
    if (!r) return m;
    let x = Math.max(m, r.dotLane, ...r.passthrough);
    r.bottomBranches.forEach((b) => (x = Math.max(x, b.toLane, b.fromLane)));
    r.topMerges.forEach((b) => (x = Math.max(x, b.toLane, b.fromLane)));
    return x;
  }, 0);
  // Trough width tracks the actual lane count, clamped to [MIN, MAX]: sparse views
  // hug the text (small indent), busy views cap at MAX with lanes compressing to fit
  // rather than pushing the message column right. Only a genuinely extreme lane count
  // (compression floored at LANE_STEP_MIN) widens past MAX, so lanes never overlap text.
  const fullW = GRAPH_LEFT + maxLane * LANE_STEP + LANE_RIGHT;
  let graphW = Math.min(GRAPH_W_MAX, Math.max(GRAPH_W_MIN, fullW));
  let laneStep = maxLane <= 0 ? LANE_STEP : Math.min(LANE_STEP, (graphW - GRAPH_LEFT - LANE_RIGHT) / maxLane);
  if (maxLane > 0 && laneStep < LANE_STEP_MIN) {
    laneStep = LANE_STEP_MIN;
    graphW = GRAPH_LEFT + maxLane * LANE_STEP_MIN + LANE_RIGHT;
  }

  const selectCommit = async (commit: Commit) => {
    setSelectedStash(null); setSelectedStashFile(null);
    setSelectedCommit(commit);
    setSelectedFile(null);
    if (isReal && activeProject) {
      try {
        const files = await loadCommitFiles(activeProject.path, commit.fullHash);
        const additions = files.reduce((s, f) => s + f.additions, 0);
        const deletions = files.reduce((s, f) => s + f.deletions, 0);
        setSelectedCommit({ ...commit, files, stats: { additions, deletions, files: files.length } });
        // Default to the first readable file's diff so the right pane isn't empty.
        const first = firstReadableFile(files);
        if (first) {
          try {
            const diff = await commitFileDiff(activeProject.path, commit.fullHash, first.path);
            setSelectedFile({ ...first, diff });
          } catch { setSelectedFile(first); }
        }
      } catch { /* keep summary without files */ }
    }
  };

  const selectDetailFile = async (file: CommitFile | null) => {
    setSelectedFile(file);
    if (file && !file.diff && isReal && activeProject && selectedCommit) {
      try {
        const diff = await commitFileDiff(activeProject.path, selectedCommit.fullHash, file.path);
        setSelectedFile({ ...file, diff });
      } catch { /* no diff */ }
    }
  };

  // Open a stash's detail: load its files, then preselect the first with its diff.
  const openStash = async (s: Stash) => {
    if (!activeProject) return;
    setViewChanges(false);
    setSelectedCommit(null); setSelectedFile(null);
    setSelectedStash({ ...s, files: [] });
    setSelectedStashFile(null);
    openDetail();
    try {
      const files = await stashFiles(activeProject.path, s.index);
      setSelectedStash({ ...s, files });
      const first = firstReadableFile(files) ?? files[0] ?? null;
      if (first) {
        try {
          const diff = await stashFileDiff(activeProject.path, s.index, first.path);
          setSelectedStashFile({ ...first, diff });
        } catch { setSelectedStashFile(first); }
      }
    } catch (e) { toast.error(`读取储藏失败：${e}`); }
  };
  const selectStashFile = async (file: CommitFile | null) => {
    setSelectedStashFile(file);
    if (file && !file.diff && activeProject && selectedStash) {
      try {
        const diff = await stashFileDiff(activeProject.path, selectedStash.index, file.path);
        setSelectedStashFile((prev) => prev?.path === file.path ? { ...file, diff } : prev);
      } catch { /* no diff */ }
    }
  };

  const selectWorkingFile = async (file: WorkingFile | null) => {
    setSelectedWorkingFile(file);
    // Load once: skip if a diff or a preview verdict is already attached.
    if (file && file.diff === undefined && file.previewKind === undefined && isReal && activeProject) {
      try {
        if (file.status === "untracked") {
          // git diff shows nothing for untracked files — read the file directly.
          const p = await filePreview(activeProject.path, file.path);
          setSelectedWorkingFile({ ...file, diff: p.diff, previewKind: p.kind,
            previewTruncated: p.truncated, previewSize: p.size });
        } else {
          const diff = await workingFileDiff(activeProject.path, file.path, file.staged);
          setSelectedWorkingFile({ ...file, diff });
        }
      } catch { /* leave without preview */ }
    }
  };

  // Load real data whenever the active project changes. The click itself is
  // always instant: `setActiveProjectId` commits urgently, `dataReady` flips
  // false and the skeleton shows. The new repo's data is then applied inside a
  // transition (`startSwitch`) so rebuilding the whole timeline renders
  // interruptibly instead of freezing the main thread for ~1s — on a cache HIT
  // the data is already in memory (no git), on a MISS git runs off-thread first.
  // We never re-fetch a cached repo on a plain switch; forced refreshes delete
  // the cache entry so they miss and re-fetch (and apply urgently, in place).
  const path = activeProject?.path;
  useEffect(() => {
    if (!path) {
      setSelectedCommit(null); setSelectedFile(null); setSelectedWorkingFile(null);
      setSelectedStash(null); setSelectedStashFile(null);
      return;
    }
    let cancelled = false;
    const alive = () => !cancelled;

    // Select the newest commit (and load its first readable file). With `open`,
    // also surface it in the detail pane and scroll the timeline to the top —
    // used after a fetch/pull to jump to the latest commit.
    const preselect = async (data: RealData, open = false) => {
      if (open) { setViewChanges(false); setDetailClosing(false); setDetailOpen(true); }
      setSelectedFile(null); setSelectedWorkingFile(null);
      const first = data.commits[0] ?? null;
      if (!first) { setSelectedCommit(null); return; }
      if (open) requestAnimationFrame(() => timelineScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
      try {
        const files = await loadCommitFiles(path, first.fullHash);
        const additions = files.reduce((s, f) => s + f.additions, 0);
        const deletions = files.reduce((s, f) => s + f.deletions, 0);
        if (!alive()) return;
        setSelectedCommit({ ...first, files, stats: { additions, deletions, files: files.length } });
        const ff = firstReadableFile(files);
        if (!ff) return;
        try {
          const diff = await commitFileDiff(path, first.fullHash, ff.path);
          if (alive()) setSelectedFile({ ...ff, diff });
        } catch { if (alive()) setSelectedFile(ff); }
      } catch { if (alive()) setSelectedCommit(first); }
    };

    // Default the view to 全部视图 (all branches), detail closed (only on switch /
    // branch change — a plain fetch/pull refresh keeps the user where they are).
    const applyView = (_data: RealData) => {
      setFocusBranch(null);
      setViewChanges(false);
      setSelectedStash(null); setSelectedStashFile(null);
      setDetailOpen(false); setDetailClosing(false);
    };
    const syncBranch = (data: RealData) => {
      const cur = data.branches.find((b) => b.current);
      if (cur) {
        setCurrentBranch(cur.name);
        setProjects((prev) => prev.map((p) => p.path === path ? { ...p, branch: cur.name } : p));
      }
    };

    // Switching projects (or a branch-changing reload) resets the view;
    // a same-repo refresh (fetch/pull/push) preserves selection + detail.
    const isSwitch = lastLoadedPath.current !== path;
    lastLoadedPath.current = path;
    const resetView = isSwitch || pendingViewReset.current;
    pendingViewReset.current = false;
    const jumpLatest = pendingJumpLatest.current;   // after fetch/pull → go to newest commit
    pendingJumpLatest.current = false;

    const cached = realCache.current.get(path);
    if (cached) {
      const apply = () => {
        setRealData(cached);
        syncBranch(cached);
        if (resetView) { applyView(cached); preselect(cached); }
        else if (jumpLatest) preselect(cached, true);
      };
      // Switch → defer the big timeline render (no freeze); refresh → urgent.
      if (isSwitch) startSwitch(apply); else apply();
      return () => { cancelled = true; };  // still guard the async preselect
    }

    if (resetView) {
      setSelectedCommit(null); setSelectedFile(null); setSelectedWorkingFile(null);
      setSelectedStash(null); setSelectedStashFile(null);
      setDetailOpen(false); setDetailClosing(false);
    }
    (async () => {
      try {
        const [branchList, remoteList, commitList, working, stashList_] = await Promise.all([
          loadBranches(path),
          loadRemotes(path),
          loadHistory(path),
          loadStatus(path),
          stashList(path),
        ]);
        if (cancelled) return;
        attributeBranches(commitList, branchList);
        const graph = computeGraph(commitList);
        const data: RealData = { path, branches: branchList, remotes: remoteList, commits: commitList, graph, working, stashes: stashList_ };
        realCache.current.set(path, data);
        if (cancelled) return;
        const apply = () => {
          setRealData(data);
          syncBranch(data);
          if (resetView) { applyView(data); preselect(data); }
          else if (jumpLatest) preselect(data, true);
        };
        if (isSwitch) startSwitch(apply); else apply();
      } catch (e) {
        if (!cancelled) setLoadError({ path, msg: String(e) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadTick]);

  // Watch the working tree for changes made outside the app (edits in an editor).
  // Primary signal is a native filesystem watcher (backend `notify`), which fires
  // within tens of ms of a save — no more waiting for a poll tick. A `git status`
  // reload is coalesced (debounced) so an editor's burst of write events triggers
  // one refresh, and the fresh file list is merged in while preserving the UI's
  // staged selection. A slow interval + a refresh-on-focus stay as a safety net,
  // and also pick up changes the watcher skips on purpose (terminal git add/commit
  // only touch `.git/`, which the watcher filters out to avoid a reload loop).
  useEffect(() => {
    if (!path || !dataReady) return;
    let stopped = false;
    let debounce: number | null = null;

    const reload = async () => {
      if (stopped || gitBusyRef.current) return;
      try {
        const fresh = await loadStatus(path);
        if (stopped) return;
        setRealData((prev) => {
          if (!prev || prev.path !== path || sameWorking(fresh, prev.working)) return prev;
          const prevStaged = new Map(prev.working.map((f) => [f.path, f.staged]));
          const merged = fresh.map((f) => ({ ...f, staged: prevStaged.get(f.path) ?? f.staged }));
          const next = { ...prev, working: merged };
          realCache.current.set(path, next);
          return next;
        });
      } catch { /* ignore transient status errors */ }
    };
    const scheduleReload = () => {
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(reload, 150);
    };

    // Filesystem watcher (near-instant). If it can't start (e.g. running in a
    // browser via `npm run dev`), the interval + focus fallbacks still cover it.
    startWatch(path).catch(() => {});
    let unlisten: (() => void) | null = null;
    listen<string>("working-tree-changed", (e) => {
      if (e.payload === path) scheduleReload();
    }).then((fn) => { if (stopped) fn(); else unlisten = fn; }).catch(() => {});

    // Safety net.
    const id = window.setInterval(reload, 4000);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      stopped = true;
      if (debounce) window.clearTimeout(debounce);
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      if (unlisten) unlisten();
      stopWatch(path).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, dataReady]);

  const doCreateBranch = async (name: string, base: string, mode: DirtyMode = "carry") => {
    if (!activeProject) return;
    setCreateBranchOpen(false);
    const p = activeProject.path;
    try {
      // Handle uncommitted changes first: stash them away, discard them, or (default)
      // let `checkout -b` carry them onto the new branch.
      if (mode === "stash") await stashPush(p, `GitKit: 新建分支 ${name} 前的改动`);
      else if (mode === "discard") await discardAll(p);
      await createBranch(p, name, base, true);
      setCurrentBranch(name);
      setProjects((prev) => prev.map((pr) => pr.id === activeProjectId ? { ...pr, branch: name } : pr));
      if (mode !== "carry") setSelectedWorkingFile(null);
      realCache.current.delete(p);
      pendingViewReset.current = true;   // branch changed → reset to the new branch
      setReloadTick((n) => n + 1);
      toast.success(
        mode === "stash" ? `已储藏改动并创建分支 ${name}`
        : mode === "discard" ? `已放弃改动并创建分支 ${name}`
        : `已创建并切换到分支 ${name}`);
    } catch (e) { toast.error(`创建分支失败：${e}`); }
  };

  // Create a tag on the current HEAD and push it to origin — the release flow
  // that triggers the build CI. Keeps the dialog open if the name is rejected.
  const doCreateAndPushTag = async (name: string, message: string) => {
    if (!activeProject) return;
    const p = activeProject.path;
    const originUrl = remotes.find((r) => r.name === "origin")?.url ?? remotes[0]?.url ?? "";
    const resolved = await resolveRemoteToken(originUrl, "推送标签");
    if (!resolved) return; // account picker cancelled — don't create the tag either
    const token = resolved.token;
    setTagBusy(true);
    const tid = toast.loading(`正在创建并推送标签 ${name}…`);
    try {
      await createTag(p, name, message);
    } catch (e) {
      toast.error(`创建标签失败：${e}`, { id: tid });
      setTagBusy(false);
      return;
    }
    realCache.current.delete(p);
    setReloadTick((n) => n + 1);
    try {
      await pushTag(p, name, token);
      toast.success(`标签 ${name} 已创建并推送`, { id: tid });
    } catch (e) {
      toast.error(`标签 ${name} 已创建，但推送失败：${e}`, { id: tid });
    } finally {
      setTagBusy(false);
      setTagDialogOpen(false);
    }
  };

  // ── stash: save working changes, then apply / drop saved entries ──
  // Open the stash dialog (optional title). Guard here so the button feedback
  // still happens even though the actual stash runs from the dialog.
  const requestStash = () => {
    if (!activeProject || gitBusy) return;
    if (changesCount === 0) { toast("没有可储藏的更改"); return; }
    setStashDialogOpen(true);
  };
  const doStash = async (message = "") => {
    if (!activeProject) return;
    const p = activeProject.path;
    setStashBusy(true);
    const tid = toast.loading("正在储藏…");
    try {
      await stashPush(p, message);   // empty → backend default ("GitKit stash")
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      setStashDialogOpen(false);
      toast.success("已储藏当前更改", { id: tid });
    } catch (e) { toast.error(`储藏失败：${e}`, { id: tid }); }
    finally { setStashBusy(false); }
  };
  const doStashApply = async (index: number) => {
    if (!activeProject) return;
    const p = activeProject.path;
    const tid = toast.loading("正在应用储藏…");
    try {
      await stashApply(p, index);
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      toast.success(`已应用 stash@{${index}}`, { id: tid });
    } catch (e) { toast.error(`应用储藏失败：${e}`, { id: tid }); }
  };
  const doStashDrop = async (index: number) => {
    if (!activeProject) return;
    const p = activeProject.path;
    try {
      await stashDrop(p, index);
      // Indices shift after a drop; if the dropped stash was open, close its detail.
      if (selectedStash?.index === index) {
        setSelectedStash(null); setSelectedStashFile(null); closeDetail();
      }
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      toast.success(`已删除 stash@{${index}}`);
    } catch (e) { toast.error(`删除储藏失败：${e}`); }
  };

  // GitHub multi-account picker. When a remote matches 2+ configured accounts,
  // remote-auth actions (push/pull/fetch/tag/PR) prompt to choose one, unless
  // this project has a remembered choice (ticked in the picker, managed in
  // 设置 › 项目配置). `chooseAccount` returns a promise the modal resolves;
  // `resolveRemoteToken` wraps candidate selection + non-interactive fallback,
  // returning null only when the user cancels the picker.
  const [acctPicker, setAcctPicker] = useState<
    { action: string; accounts: GithubAccount[]; canRemember: boolean;
      resolve: (r: { account: GithubAccount; remember: boolean } | null) => void } | null
  >(null);
  const chooseAccount = (accounts: GithubAccount[], action: string, canRemember: boolean) =>
    new Promise<{ account: GithubAccount; remember: boolean } | null>(
      (resolve) => setAcctPicker({ action, accounts, canRemember, resolve }));
  const resolveRemoteToken = async (
    remoteUrl: string,
    action: string,
  ): Promise<{ token?: string; account?: GithubAccount } | null> => {
    const cands = githubCandidates(remoteUrl);
    if (cands.length >= 2) {
      const key = activeProject?.path ?? "";
      // A remembered account only applies while it still matches this remote.
      const saved = key ? cands.find((a) => a.id === loadProjectAccountId(key)) : undefined;
      if (saved) return { token: saved.token, account: saved };
      const chosen = await chooseAccount(cands, action, !!key);
      if (!chosen) return null; // user cancelled
      if (chosen.remember && key) saveProjectAccountId(key, chosen.account.id);
      return { token: chosen.account.token, account: chosen.account };
    }
    if (cands.length === 1) return { token: cands[0].token, account: cands[0] };
    return { token: pickRemoteToken(remoteUrl) };
  };

  // Bootstrap a GitHub remote for a local-only repo: create the repo under a
  // configured account, wire it as origin, then push the current branch.
  const [createRepoOpen, setCreateRepoOpen] = useState(false);
  const [createRepoBusy, setCreateRepoBusy] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const doCreateRepoAndPush = async (account: GithubAccount, name: string, isPrivate: boolean, description: string) => {
    if (!activeProject) return;
    const p = activeProject.path;
    setCreateRepoBusy(true);
    const tid = toast.loading(`正在创建仓库 ${name}…`);
    try {
      const repo = await githubCreateRepo(account.url, account.token, name, isPrivate, description);
      toast.loading("仓库已创建,正在推送…", { id: tid });
      await gitRemoteAdd(p, "origin", repo.cloneUrl);
      await push(p, account.token);
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      setCreateRepoOpen(false);
      toast.success("仓库已创建并推送", { id: tid, description: repo.htmlUrl });
    } catch (e) {
      // If the remote was added but the push failed (e.g. no commits yet), the
      // repo now has an origin — a later push takes the normal path.
      toast.error(`创建 / 推送失败：${e}`, { id: tid });
    } finally {
      setCreateRepoBusy(false);
    }
  };

  // Fetch / pull / push. Each refreshes the repo afterwards (cache-busting reload).
  const runGitAction = async (kind: "fetch" | "pull" | "push") => {
    if (!activeProject || gitBusy) return;
    const p = activeProject.path;
    const verbs = { fetch: "获取", pull: "拉取", push: "推送" } as const;
    if (remotes.length === 0) {
      // No remote yet: for a push with a GitHub account configured, offer to create
      // the repo on GitHub and wire it up. Fetch/pull can't be bootstrapped this way.
      if (kind === "push" && loadGithubAccounts().length > 0) { setCreateRepoOpen(true); return; }
      toast.error(`没有配置远程仓库,无法${verbs[kind]}。可在设置中添加 GitHub 账号后重试,或先手动 git remote add origin <url>。`);
      return;
    }
    const originUrl = remotes.find((r) => r.name === "origin")?.url ?? remotes[0]?.url ?? "";
    const resolved = await resolveRemoteToken(originUrl, verbs[kind]);
    if (!resolved) return; // account picker cancelled
    const token = resolved.token;
    const opId = crypto.randomUUID();
    gitOpId.current = opId;
    setGitBusy(kind);
    setGitProg(null);
    setCancelling(false);
    const tid = toast.loading(`正在${verbs[kind]}…`);
    try {
      // A fetch also fast-forwards every local branch that is behind its
      // upstream; report what it did (and what it deliberately left alone).
      let detail: string | undefined;
      if (kind === "fetch") {
        const s = await fetchAll(p, token, opId, setGitProg);
        const parts: string[] = [];
        if (s.synced.length) parts.push(`已同步 ${s.synced.length} 个分支：${s.synced.join("、")}`);
        if (s.dirtySkipped) parts.push("当前分支有未提交更改,已跳过");
        if (s.diverged.length) parts.push(`${s.diverged.join("、")} 与远程有分叉,需手动合并`);
        detail = parts.join(" · ") || undefined;
      } else if (kind === "pull") await pull(p, token, opId, setGitProg);
      else await push(p, token);
      realCache.current.delete(p);
      // After a sync, jump to the newest commit (fetch/pull bring in new history).
      if (kind === "fetch" || kind === "pull") pendingJumpLatest.current = true;
      setReloadTick((n) => n + 1);
      toast.success(`${verbs[kind]}完成`, { id: tid, description: detail });
    } catch (e) {
      // A user cancel isn't a failure — dismiss quietly.
      if (isCancelled(e)) toast(`已取消${verbs[kind]}`, { id: tid });
      else toast.error(`${verbs[kind]}失败：${e}`, { id: tid });
    } finally {
      setGitBusy(null);
      setGitProg(null);
      setCancelling(false);
      gitOpId.current = null;
    }
  };

  // Cancel the in-flight fetch/pull. The backend kills the git subprocess, which
  // unwinds runGitAction's await into the isCancelled branch above.
  const cancelGitAction = async () => {
    const id = gitOpId.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try { await cancelGitOp(id); } catch { /* already finished — the op will settle on its own */ }
  };

  // ── scheduled daily update check ──────────────────────────────────────────
  // Once a day, fetch every open project and report which ones gained upstream
  // commits — a morning's worth of remote work in one dialog instead of N manual
  // fetches. The check is read-only (it only moves remote-tracking refs); the
  // pull is the explicit button in that dialog.
  const [dailyCheck, setDailyCheckState] = useState<DailyCheck>(loadDailyCheck);
  const setDailyCheck = (c: DailyCheck) => { setDailyCheckState(c); saveDailyCheck(c); };
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(null);
  const [pullBusy, setPullBusy] = useState(false);
  const [updateRows, setUpdateRows] = useState<UpdateRow[] | null>(null);
  const checkRunning = useRef(false); // guards against overlapping runs

  const runUpdateCheck = async (manual: boolean) => {
    // A running git op owns the repos right now — retry on the next tick.
    if (checkRunning.current || (!manual && gitBusyRef.current)) return;
    const list = projects;
    if (list.length === 0) { if (manual) toast("还没有打开任何项目"); return; }
    checkRunning.current = true;
    setCheckBusy(true);
    const tid = manual ? toast.loading(`正在检查 ${list.length} 个项目…`) : undefined;
    const rows: UpdateRow[] = [];
    // Sequential on purpose: parallel fetches across repos fight over the network
    // and can trigger several credential prompts at once.
    for (let index = 0; index < list.length; index++) {
      const p = list[index];
      setCheckProgress({ current: index + 1, total: list.length, project: p.name });
      try {
        const rems = await loadRemotes(p.path);
        if (rems.length === 0) continue; // local-only repo — nothing to check
        const url = rems.find((r) => r.name === "origin")?.url ?? rems[0].url;
        // Non-interactive token pick: a remembered account wins, else the
        // host-matched fallback. A background check must never open the picker.
        const saved = githubCandidates(url).find((a) => a.id === loadProjectAccountId(p.path));
        const res = await checkUpdates(p.path, saved?.token ?? pickRemoteToken(url));
        if (res.behind.length) {
          rows.push({ id: p.id, name: p.name, path: p.path, behind: res.behind,
            dirty: res.dirty, currentBranch: res.currentBranch, state: "idle" });
        }
      } catch (e) {
        rows.push({ id: p.id, name: p.name, path: p.path, behind: [], dirty: false,
          currentBranch: "", error: String(e), state: "idle" });
      }
    }
    // Remote-tracking refs moved — drop the caches so the timeline shows them.
    for (const p of list) realCache.current.delete(p.path);
    setReloadTick((n) => n + 1);
    checkRunning.current = false;
    setCheckBusy(false);
    setCheckProgress(null);
    // Stamp the run even when nothing was found, so it doesn't repeat all day.
    setDailyCheckState((prev) => { const next = { ...prev, lastRun: Date.now() }; saveDailyCheck(next); return next; });

    const updated = rows.filter((r) => !r.error);
    const failed = rows.length - updated.length;
    if (updated.length === 0) {
      if (manual) {
        if (failed) toast.error(`检查完成,${failed} 个项目检查失败`, { id: tid });
        else toast.success("所有项目都已是最新", { id: tid });
      } else if (failed) {
        toast.error(`定时检查：${failed} 个项目检查失败`);
      }
      return;
    }
    if (tid) toast.dismiss(tid);
    setUpdateRows(rows);
    if (!manual) {
      try {
        const appWindow = getCurrentWindow();
        if (!(await appWindow.isFocused())) {
          await appWindow.requestUserAttention(UserAttentionType.Informational);
        }
      } catch {
        // Browser previews do not expose native window attention APIs.
      }
    }
  };

  // Apply the check's findings: a local fast-forward per project (the commits are
  // already fetched), reporting per project rather than failing the whole batch.
  const doPullUpdates = async (ids: string[]) => {
    if (!updateRows || pullBusy) return;
    setPullBusy(true);
    let touchedActive = false;
    for (const id of ids) {
      const row = updateRows.find((r) => r.id === id);
      if (!row) continue;
      setUpdateRows((prev) => prev?.map((r) => r.id === id ? { ...r, state: "pulling", detail: undefined } : r) ?? null);
      try {
        const s = await syncLocal(row.path);
        const parts: string[] = [];
        if (s.synced.length) parts.push(`已快进 ${s.synced.join("、")}`);
        if (s.dirtySkipped) parts.push("当前分支有未提交更改,已跳过");
        if (s.diverged.length) parts.push(`${s.diverged.join("、")} 与远程有分叉,需手动合并`);
        setUpdateRows((prev) => prev?.map((r) => r.id === id
          ? { ...r, state: s.synced.length ? "done" : "failed", detail: parts.join(" · ") || "没有可快进的分支" }
          : r) ?? null);
        realCache.current.delete(row.path);
        if (row.path === activeProject?.path) touchedActive = true;
      } catch (e) {
        setUpdateRows((prev) => prev?.map((r) => r.id === id ? { ...r, state: "failed", detail: String(e) } : r) ?? null);
      }
    }
    setPullBusy(false);
    if (touchedActive) pendingJumpLatest.current = true;
    setReloadTick((n) => n + 1);
  };

  // Fire the check when today's scheduled instant has passed and the last run
  // predates it. Polled every minute (plus one look shortly after launch), so a
  // day missed with the app closed catches up on the next start, and moving the
  // time later in the day still fires today.
  const runCheckRef = useRef(runUpdateCheck);
  runCheckRef.current = runUpdateCheck;
  useEffect(() => {
    if (!dailyCheck.enabled) return;
    const tick = () => {
      const due = scheduledAt(dailyCheck.time);
      if (Date.now() < due || dailyCheck.lastRun >= due) return;
      void runCheckRef.current(false);
    };
    const first = window.setTimeout(tick, 15000);
    const timer = window.setInterval(tick, 60000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, [dailyCheck.enabled, dailyCheck.time, dailyCheck.lastRun]);

  // Commit staged files with the chosen identity (falls back to repo/global config).
  const doCommit = async (message: string, files: string[], identity: Identity | null) => {
    if (!activeProject) return;
    await gitCommit(activeProject.path, message, files, identity?.name, identity?.email);
    realCache.current.delete(activeProject.path);
    setReloadTick((n) => n + 1);
    toast.success(`已提交 ${files.length} 个文件`);
  };

  // The local branch a commit can be "checked out & synced" to — the local
  // counterpart of a remote ref sitting on it (origin/X → X). Only meaningful for
  // remote-tip commits, which is exactly the "sync remote → local" case.
  const syncTargetOf = (commit: Commit): string | null => {
    for (const tag of commit.tags ?? []) {
      const rem = remoteRefName(tag, remoteNames);
      if (rem && branches.some((b) => b.name === rem)) return rem;
    }
    return null;
  };
  const doCheckoutSync = async (commit: Commit) => {
    if (!activeProject) return;
    const branch = syncTargetOf(commit);
    if (!branch) { toast("此提交没有可同步的本地分支"); return; }
    const tid = toast.loading(`正在检出并同步 ${branch}…`);
    try {
      await checkoutSync(activeProject.path, branch, commit.fullHash);
      setCurrentBranch(branch);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;
      setReloadTick((n) => n + 1);
      toast.success(`已检出 ${branch} 并同步到 ${commit.hash}`, { id: tid });
    } catch (e) { toast.error(`检出失败：${e}`, { id: tid }); }
  };

  // Double-click a branch pill in the all-view:
  //  • local branch behind its remote → check it out and fast-forward to upstream;
  //  • remote-only branch (no local yet) → create a local tracking branch + check out;
  //  • already in sync → nothing.
  const doSyncBranch = async (branchName: string) => {
    if (!activeProject) return;
    const local = branches.find((x) => x.name === branchName);
    if (local && (!local.remote || local.behind <= 0)) { toast(`${branchName} 已与远端同步`); return; }
    const tid = toast.loading(`正在检出并同步 ${branchName}…`);
    try {
      if (local) {
        await checkoutSync(activeProject.path, local.name, local.remote!);
      } else {
        const rem = remotes.find((r) => r.branches.includes(branchName));
        if (!rem) { toast.error(`未找到 ${branchName} 的远程分支`, { id: tid }); return; }
        await createBranch(activeProject.path, branchName, `${rem.name}/${branchName}`, true);
      }
      setCurrentBranch(branchName);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch: branchName } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;
      setReloadTick((n) => n + 1);
      toast.success(`已检出并同步 ${branchName}`, { id: tid });
    } catch (e) { toast.error(`同步失败：${e}`, { id: tid }); }
  };

  const runConfirm = async () => {
    if (!confirmState) return;
    setConfirmBusy(true);
    try { await confirmState.onConfirm(); setConfirmState(null); }
    catch (e) { toast.error(`操作失败：${e}`); }
    finally { setConfirmBusy(false); }
  };

  // Discard one file's working-tree changes (tracked → revert to HEAD; untracked
  // → delete from disk). Confirmed first — it's not undoable.
  const doDiscardFile = (file: string) => {
    if (!activeProject) return;
    const p = activeProject.path;
    const untracked = activeWorking.find((f) => f.path === file)?.status === "untracked";
    setConfirmState({
      title: untracked ? "删除未跟踪文件" : "丢弃更改",
      message: untracked
        ? `将从磁盘删除未跟踪的 ${file}。此操作不可撤销。`
        : `将把 ${file} 恢复到 HEAD 版本,丢弃其所有未提交更改。此操作不可撤销。`,
      confirmLabel: untracked ? "删除" : "丢弃",
      onConfirm: async () => {
        await discardFile(p, file);
        if (selectedWorkingFile?.path === file) setSelectedWorkingFile(null);
        realCache.current.delete(p);
        setReloadTick((n) => n + 1);
        toast.success(untracked ? `已删除 ${file}` : `已丢弃 ${file} 的更改`);
      },
    });
  };

  // Reset the whole working tree: revert tracked files + remove untracked ones.
  const doDiscardAll = () => {
    if (!activeProject) return;
    const p = activeProject.path;
    setConfirmState({
      title: "全部重置",
      message: "将丢弃工作区的所有更改:已跟踪文件恢复到 HEAD,未跟踪文件被删除(reset --hard + clean -fd)。此操作不可撤销。",
      confirmLabel: "全部重置",
      onConfirm: async () => {
        await discardAll(p);
        setSelectedWorkingFile(null);
        realCache.current.delete(p);
        setReloadTick((n) => n + 1);
        toast.success("已重置工作区");
      },
    });
  };

  // The actual switch (from the dialog when dirty, or directly when clean).
  const performCheckout = async (branch: string, stash: boolean) => {
    if (!activeProject) return;
    setCheckoutTarget(null);
    setBusyLabel(`正在切换到 ${branch}…`);
    try {
      if (stash) await stashPush(activeProject.path, `GitKit: 切换到 ${branch} 前的改动`);
      await checkoutBranch(activeProject.path, branch);
      setCurrentBranch(branch);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;   // branch changed → reset to the new branch
      setReloadTick((n) => n + 1);
      toast.success(stash ? `已储藏改动并切换到 ${branch}` : `已切换到 ${branch}`);
    } catch (e) { toast.error(`切换失败：${e}`); }
    finally { setBusyLabel(null); }
  };

  // ── branch checkout (double-click a branch) ──
  // Clean tree → switch straight away (no confirm); dirty → ask (to offer stash).
  const requestCheckout = async (branch: string) => {
    if (!isReal || !activeProject) { toast("仅真实仓库支持切换分支"); return; }
    if (branch === currentBranch) return;
    // git refuses to check out a branch that another worktree already holds.
    const wt = branches.find((b) => b.name === branch)?.worktree;
    if (wt) { toast(`分支 ${branch} 正被工作树占用：${wt}`); return; }
    try {
      const dirty = await hasChanges(activeProject.path);
      if (dirty) setCheckoutTarget({ branch, dirty });
      else performCheckout(branch, false);
    } catch (e) { toast.error(String(e)); }
  };
  const doCheckout = (stash: boolean) => {
    if (checkoutTarget) performCheckout(checkoutTarget.branch, stash);
  };

  // Double-click a remote branch in the sidebar (远程 → origin → main):
  //  • a local branch of that name already exists → just switch to it (reuses the
  //    dirty-tree / stash flow of a normal checkout);
  //  • no local branch yet → create one tracking the remote and check it out.
  const requestSyncRemote = async (remoteName: string, leaf: string) => {
    if (!isReal || !activeProject) { toast("仅真实仓库支持此操作"); return; }
    if (branches.some((b) => b.name === leaf)) { requestCheckout(leaf); return; }
    const tid = toast.loading(`正在将 ${remoteName}/${leaf} 同步到本地…`);
    try {
      await createBranch(activeProject.path, leaf, `${remoteName}/${leaf}`, true);
      setCurrentBranch(leaf);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch: leaf } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;
      setReloadTick((n) => n + 1);
      toast.success(`已创建本地分支 ${leaf} 并检出`, { id: tid });
    } catch (e) { toast.error(`同步失败：${e}`, { id: tid }); }
  };

  // Create a local branch tracking the remote WITHOUT switching to it (the
  // right-click "只建不切" option). Only offered when no local branch exists yet.
  const createLocalFromRemote = async (remoteName: string, leaf: string) => {
    if (!activeProject) return;
    const tid = toast.loading(`正在创建本地分支 ${leaf}…`);
    try {
      await createBranch(activeProject.path, leaf, `${remoteName}/${leaf}`, false);
      realCache.current.delete(activeProject.path);
      setReloadTick((n) => n + 1);
      toast.success(`已创建本地分支 ${leaf}`, { id: tid });
    } catch (e) { toast.error(`创建失败：${e}`, { id: tid }); }
  };

  // ── local-branch rename / delete (sidebar right-click) ──
  // Only local-only branches (no upstream) are renamable/deletable — a branch
  // already synced to a remote is left alone to avoid diverging from origin.
  const doRenameBranch = async (newName: string) => {
    if (!renameTarget || !activeProject) return;
    const b = renameTarget;
    const p = activeProject.path;
    setRenameTarget(null);
    const tid = toast.loading(`正在重命名 ${b.name} → ${newName}…`);
    try {
      await renameBranch(p, b.name, newName);
      if (currentBranch === b.name) {
        setCurrentBranch(newName);
        setProjects((prev) => prev.map((pr) => pr.id === activeProjectId ? { ...pr, branch: newName } : pr));
      }
      if (focusBranch === b.name) setFocus(newName);
      // carry pinned / hidden membership over to the new name
      setPinnedBranches((prev) => prev.map((n) => n === b.name ? newName : n));
      setHiddenBranches((prev) => prev.map((n) => n === b.name ? newName : n));
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      toast.success(`已重命名为 ${newName}`, { id: tid });
    } catch (e) { toast.error(`重命名失败：${e}`, { id: tid }); }
  };

  const requestDeleteBranch = (b: Branch) => {
    if (!isReal || !activeProject) { toast("仅真实仓库支持删除分支"); return; }
    if (b.current) { toast("无法删除当前所在分支,请先切换到其它分支"); return; }
    if (b.remote) { toast("该分支已与远端同步,不可删除"); return; }
    setDeleteBranchTarget({ branch: b, force: false, worktree: b.worktree });
  };
  const runDeleteBranch = async () => {
    if (!deleteBranchTarget || !activeProject) return;
    const { branch: b, force, worktree } = deleteBranchTarget;
    const p = activeProject.path;
    setDeleteBranchBusy(true);
    // Once the worktree is gone the repo has already changed — every later exit
    // path (success or failure) has to refresh and stop re-attempting removal.
    let released = false;
    try {
      // git refuses to delete a branch held by a worktree — even with -D — so
      // release the worktree first. Confirmed in the dialog: this drops any
      // uncommitted work inside it.
      if (worktree) { await removeWorktree(p, worktree); released = true; }
      await deleteBranch(p, b.name, force);
      if (focusBranch === b.name) setFocus(null);
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      setDeleteBranchTarget(null);
      toast.success(`已删除分支 ${b.name}`);
    } catch (e) {
      const msg = String(e);
      if (released) {
        realCache.current.delete(p);
        setReloadTick((n) => n + 1);
      }
      // Branch listing can be stale (a worktree added since the last refresh) —
      // recover from the live error instead of dead-ending on it.
      const wt = released ? undefined : msg.match(/正被工作树占用：(.+)/)?.[1]?.trim();
      // `git branch -d` refuses an unmerged branch → escalate to a force confirm
      // rather than dead-ending, so the user can knowingly drop the commits.
      if (wt) {
        setDeleteBranchTarget({ branch: b, force, worktree: wt });
      } else if (!force && /not fully merged/i.test(msg)) {
        setDeleteBranchTarget({ branch: b, force: true });
      } else {
        if (released) setDeleteBranchTarget(null);
        toast.error(`删除失败：${e}`);
      }
    } finally {
      setDeleteBranchBusy(false);
    }
  };

  const requestCherryPick = (commit: Commit) => setCherryTarget(commit);
  // Cherry-pick entry from the ActionBar: needs a commit open in the detail view.
  const requestCherryPickActive = () => {
    if (detailOpen && !viewChanges && selectedCommit) requestCherryPick(selectedCommit);
    else toast("请先选中要 cherry-pick 的提交");
  };
  // Preflight first: predict conflicts without mutating the repo. Clean → apply
  // straight away; conflict → open the confirm dialog and let the user decide.
  const doCherryPick = async (target: string) => {
    if (!cherryTarget || !activeProject) return;
    const c = cherryTarget;
    setCherryTarget(null);
    try {
      const conflicts = await cherryPickPreflight(activeProject.path, c.fullHash, target);
      if (conflicts.length === 0) { await runCherryPick(c, target, false); return; }
      setCherryConflict({ commit: c, target, files: conflicts });
    } catch (e) { toast.error(`遴选预检失败：${e}`); }
  };
  // Actually run the cherry-pick (optionally routing conflicts to Kaleidoscope)
  // and reflect whatever state it lands in.
  const runCherryPick = async (c: Commit, target: string, useKaleidoscope: boolean) => {
    if (!activeProject) return;
    try {
      const res = await cherryPick(activeProject.path, c.fullHash, target, useKaleidoscope);
      realCache.current.delete(activeProject.path);
      if (target && target !== currentBranch) { setCurrentBranch(target); pendingViewReset.current = true; }
      setReloadTick((n) => n + 1);
      if (res.status === "conflict") {
        toast.warning(`遴选遇到冲突：${res.conflicts.length} 个文件待解决,解决后执行 git cherry-pick --continue`);
      } else {
        toast.success(`已遴选 ${c.hash} 到 ${target}`);
      }
    } catch (e) { toast.error(`遴选失败：${e}`); }
  };

  // Create merge/pull request.
  const [prOpen, setPrOpen] = useState(false);
  const prInfo = (() => {
    const originUrl = remotes.find((r) => r.name === "origin")?.url ?? remotes[0]?.url ?? "";
    const host = hostOf(originUrl);
    // GitHub token/instance is resolved at submit time (may prompt among accounts).
    if (githubCandidates(originUrl).length) return { provider: "github" as const, instanceUrl: "", token: "", remoteUrl: originUrl, term: "拉取请求" };
    const gl = loadGitlab();
    if (gl.token && (!gl.url || host === hostOf(gl.url))) return { provider: "gitlab" as const, instanceUrl: gl.url, token: gl.token, remoteUrl: originUrl, term: "合并请求" };
    return null;
  })();
  const requestCreatePR = () => {
    if (!activeProject) return;
    if (!prInfo) { toast("请先在设置中配置 GitLab 或 GitHub 令牌"); return; }
    setPrOpen(true);
  };
  const doCreatePR = async (source: string, target: string, title: string, description: string) => {
    if (!prInfo) return;
    let instanceUrl = prInfo.instanceUrl;
    let token = prInfo.token;
    // GitHub: pick the account matching origin (prompts when several match).
    if (prInfo.provider === "github") {
      const resolved = await resolveRemoteToken(prInfo.remoteUrl, "创建拉取请求");
      if (!resolved || !resolved.token) return; // cancelled, or no token configured
      token = resolved.token;
      instanceUrl = resolved.account?.url ?? "";
    }
    const tid = toast.loading("正在创建…");
    try {
      const url = await createPullRequest({
        provider: prInfo.provider, instanceUrl, remoteUrl: prInfo.remoteUrl,
        token, source, target, title, description,
      });
      setPrOpen(false);
      toast.success(`已创建${prInfo.term},正在浏览器打开`, { id: tid, description: url });
    } catch (e) {
      toast.error(`创建失败：${e}`, { id: tid });
      throw e; // keep the dialog open so the user can retry
    }
  };

  const handleSelectProject = (id: string) => {
    setActiveProjectId(id);
  };

  const handleCloseProject = (id: string) => {
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      if (id === activeProjectId && remaining.length > 0) {
        const idx = prev.findIndex((p) => p.id === id);
        const next = remaining[Math.min(idx, remaining.length - 1)];
        setActiveProjectId(next.id);
      }
      return remaining;
    });
  };

  // Open a repo at `repoPath` as a project tab (reused by "open" and "clone").
  // Switches to it if already open; otherwise adds a new tab. Returns the info.
  const openRepoAsProject = async (repoPath: string): Promise<RepoInfo> => {
    const info = await openRepo(repoPath);
    const existing = projects.find((p) => p.path === info.path);
    if (existing) { setActiveProjectId(existing.id); return info; }
    const palette = ["#6b6bff", "#34d399", "#f59e0b", "#60a5fa", "#f472b6", "#22d3ee"];
    const id = "real-" + Date.now();
    const proj: Project = {
      id, name: info.name, branch: info.current_branch,
      color: palette[projects.length % palette.length], changes: 0, path: info.path,
    };
    setProjects((prev) => [...prev, proj]);
    setActiveProjectId(id);
    return info;
  };

  const handleOpenNew = async () => {
    try {
      const folder = await pickRepoFolder();
      if (!folder) return;
      const info = await openRepoAsProject(folder);
      toast.success(`已打开仓库：${info.name}`);
    } catch (e) {
      toast.error(`打开失败：${e}`);
    }
  };

  // Called by CloneDialog once the clone lands: open the fresh repo as a project.
  const handleCloneDone = async (clonedPath: string) => {
    setCloneOpen(false);
    try {
      await openRepoAsProject(clonedPath);
    } catch (e) {
      toast.error(`打开克隆的仓库失败：${e}`);
    }
  };

  // Keep the tab's change-count badge in sync.
  useEffect(() => {
    setProjects((prev) =>
      prev.map((p) => p.id === activeProjectId ? { ...p, changes: changesCount } : p)
    );
  }, [changesCount, activeProjectId]);

  return (
    <ThemeCtx.Provider value={theme}>
      {/* Fills the native macOS window */}
      <div className="flex flex-col w-full h-[100dvh] overflow-hidden"
        style={{ background: theme.bg, isolation: "isolate", colorScheme: effectiveDark ? "dark" : "light",
          "--gk-accent": theme.accent } as React.CSSProperties}>

          <Toaster position="bottom-center" theme={effectiveDark ? "dark" : "light"}
            toastOptions={{ style: { background: theme.glass, backdropFilter: "blur(20px)",
              border: `0.5px solid ${theme.glassBorder}`, color: theme.text,
              fontSize: 12, fontFamily: "inherit", borderRadius: R } }} />

          <TitleBar projects={projects} activeId={activeProjectId}
            themeMode={themeMode} onThemeCycle={cycleTheme}
            onSelectProject={handleSelectProject} onCloseProject={handleCloseProject}
            onOpenNew={handleOpenNew} onCloneNew={() => setCloneOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)} />

          <ActionBar onCreateBranch={activeProject ? () => setCreateBranchOpen(true) : undefined}
            onFetch={activeProject ? () => runGitAction("fetch") : undefined}
            onPull={activeProject ? () => runGitAction("pull") : undefined}
            onPush={activeProject ? () => runGitAction("push") : undefined}
            onCreateTag={activeProject ? () => setTagDialogOpen(true) : undefined}
            onCherryPick={activeProject ? requestCherryPickActive : undefined}
            onStash={activeProject ? requestStash : undefined}
            onCreatePR={activeProject ? requestCreatePR : undefined}
            pushCount={branches.find((b) => b.current)?.ahead ?? 0}
            busy={gitBusy} />

          {!activeProject ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4" style={{ background: theme.bg }}>
              <FolderOpen size={40} style={{ color: theme.textFaint, opacity: 0.4 }} />
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-medium" style={{ color: theme.textSec }}>还没有打开任何仓库</span>
                <span className="text-xs" style={{ color: theme.textFaint }}>打开一个 Git 仓库开始</span>
              </div>
              <div className="flex items-center gap-2.5">
                <button onClick={handleOpenNew}
                  className="flex items-center gap-2 px-4 py-2 cursor-pointer"
                  style={{ background: theme.accent, color: "#fff", borderRadius: R, fontSize: 13, fontWeight: 500 }}>
                  <Plus size={14} /> 打开仓库
                </button>
                <button onClick={() => setCloneOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 cursor-pointer"
                  style={{ background: "transparent", color: theme.text, borderRadius: R, fontSize: 13, fontWeight: 500,
                    border: `0.5px solid ${theme.inputBorder}` }}>
                  <Cloud size={14} /> 克隆仓库
                </button>
              </div>
            </div>
          ) : (
          <div className="flex flex-1 overflow-hidden">
            <Sidebar branches={branches} remotes={remotes} stashes={stashes}
              currentBranch={currentBranch} focusBranch={focusBranch}
              hidden={hiddenBranches} setHidden={setHiddenBranches}
              pinned={pinnedBranches} setPinned={setPinnedBranches}
              collapsed={collapsedFolders} setCollapsed={setCollapsedFolders}
              onFocus={(name) => setFocus(name)}
              onShowAll={() => setFocus(null)}
              onHoverBranch={setHoverBranch}
              onCheckout={requestCheckout}
              onBranchContext={(e, b) => {
                const localOnly = !b.remote;   // no upstream → not synced to a remote
                const items: CtxItem[] = [];
                if (localOnly) {
                  items.push({ label: "重命名分支", Icon: Pencil, onClick: () => setRenameTarget(b) });
                  if (!b.current) {
                    // A worktree-held branch is still deletable — the dialog
                    // just adds the worktree removal as an explicit extra step.
                    items.push({
                      label: b.worktree ? "移除工作树并删除分支" : "删除分支",
                      Icon: Trash2, danger: true, onClick: () => requestDeleteBranch(b),
                    });
                  }
                  items.push({ sep: true });
                }
                items.push({ label: "复制分支名", Icon: Copy, onClick: () => { navigator.clipboard.writeText(b.name).catch(() => {}); } });
                openCtx(e, items);
              }}
              onSyncRemote={requestSyncRemote}
              onRemoteContext={(e, remoteName, leaf) => {
                const hasLocal = branches.some((b) => b.name === leaf);
                openCtx(e, [
                  hasLocal
                    ? { label: `切换到本地分支 ${leaf}`, Icon: GitBranch, onClick: () => requestSyncRemote(remoteName, leaf) }
                    : { label: "同步到本地并检出", Icon: Download, onClick: () => requestSyncRemote(remoteName, leaf) },
                  ...(!hasLocal ? [{ label: "仅创建本地分支（不切换）", Icon: GitBranchPlus, onClick: () => createLocalFromRemote(remoteName, leaf) } as CtxItem] : []),
                  { sep: true },
                  { label: "复制分支名", Icon: Copy, onClick: () => { navigator.clipboard.writeText(`${remoteName}/${leaf}`).catch(() => {}); } },
                ]);
              }}
              onStashClick={openStash}
              onStashApply={doStashApply} onStashDrop={doStashDrop}
              onStashContext={(e, s) => openCtx(e, [
                { label: "应用到工作区", Icon: RotateCcw, onClick: () => doStashApply(s.index) },
                { label: "删除储藏", Icon: Trash2, danger: true, onClick: () => doStashDrop(s.index) },
              ])}
              selectedStashIndex={detailOpen && selectedStash ? selectedStash.index : null} />

            {/* Content area: full-width timeline with the detail as a sliding
                overlay on the right — the list never reflows, so opening detail
                animates smoothly and the left ~380px stays visible & clickable. */}
            <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5"
                style={{ borderBottom: `0.5px solid ${theme.border}`, background: theme.bg }}>
                <label className="gk-search-field flex items-center gap-2 flex-1 max-w-[340px] px-2.5 py-1.5"
                  style={{ background: theme.bgPanel, border: `0.5px solid ${theme.inputBorder}`,
                    borderRadius: R - 3, boxShadow: theme.isDark ? "inset 0 1px 0 rgba(255,255,255,0.025)" : "inset 0 1px 0 rgba(255,255,255,0.75)" }}>
                  <Search size={13} aria-hidden="true" style={{ color: theme.textFaint }} />
                  <input ref={searchInputRef} value={commitQuery}
                    onChange={(e) => setCommitQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setCommitQuery(""); e.currentTarget.blur(); } }}
                    aria-label="搜索提交" placeholder="搜索消息、作者、分支或哈希…"
                    autoComplete="off" spellCheck={false}
                    className="gk-search-input min-w-0 flex-1 bg-transparent text-xs outline-none"
                    style={{ color: theme.text }} />
                  {commitQuery && (
                    <button type="button" onClick={() => { setCommitQuery(""); searchInputRef.current?.focus(); }}
                      aria-label="清空搜索" className="flex items-center justify-center w-5 h-5"
                      style={{ color: theme.textMuted, borderRadius: 5 }}>
                      <X size={11} aria-hidden="true" />
                    </button>
                  )}
                </label>
                <span className="ml-auto text-[11px] tabular-nums" style={{ color: theme.textFaint }}>
                  {deferredCommitQuery ? `${displayCommits.length} 条结果` : `${displayCommits.length} 次提交`}
                </span>
              </div>
              {focusActive && (
                <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5"
                  style={{ borderBottom: `0.5px solid ${theme.border}`, background: theme.accentBg }}>
                  <GitBranch size={11} style={{ color: theme.accent }} />
                  <span className="text-[11px] flex-1 truncate" style={{ color: theme.accentFg }}>
                    只看分支 {focusBranch}
                  </span>
                  <button onClick={() => setFocus(null)}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] cursor-pointer"
                    style={{ color: theme.accent, borderRadius: R - 4 }}>
                    <X size={10} /> 全部视图
                  </button>
                </div>
              )}
              <div ref={timelineScrollRef} className="flex-1 overflow-y-auto">
                {/* Uncommitted-changes item — sticky at the top of the timeline so it
                    stays visible while the commit list scrolls under it. The wrapper
                    carries an opaque bg (row states are translucent) to cover the rows
                    passing beneath. */}
                {changesCount > 0 && (() => {
                  const sel = detailOpen && viewChanges;
                  return (
                  <div className="sticky top-0" style={{ zIndex: 20, background: theme.bg }}>
                  {/* A restrained semantic marker keeps working changes visible without
                      competing with the active blue interaction colour. */}
                  <button onClick={() => { setViewChanges(true); setSelectedWorkingFile(null); setSelectedStash(null); setSelectedStashFile(null); openDetail(); }}
                    className="relative w-full flex items-center gap-3 px-4 py-3 cursor-pointer text-left transition-colors"
                    style={{ borderBottom: `0.5px solid ${theme.border}`,
                      background: sel ? theme.accentBg : theme.bgPanel,
                      boxShadow: `inset 2px 0 0 ${sel ? theme.accent : theme.amber}` }}
                    onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = theme.rowHover; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = sel ? theme.accentBg : theme.bgPanel; }}>
                    <div className="flex items-center justify-center flex-shrink-0"
                      style={{ width: 28, height: 28, borderRadius: R - 3, background: theme.amber + "16" }}>
                      <FileText size={14} strokeWidth={1.8} style={{ color: theme.amber }} />
                    </div>
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-sm font-semibold truncate"
                        style={{ color: theme.text }}>未提交的更改</span>
                      <span className="text-[11px]" style={{ color: theme.textMuted }}>提交到 {currentBranch}</span>
                    </div>
                    <span className="flex items-center justify-center text-[11px] font-semibold flex-shrink-0 tabular-nums"
                      style={{ minWidth: 22, height: 20, padding: "0 6px", borderRadius: 6,
                        background: theme.amber + "14", color: theme.amber,
                        border: `0.5px solid ${theme.amber}38` }}>{changesCount}</span>
                  </button>
                  </div>
                  );
                })()}
                {errored ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center" style={{ color: theme.red }}>
                    <span className="text-xs font-medium">读取失败</span>
                    <span className="text-[11px]" style={{ color: theme.textMuted }}>{loadError?.msg}</span>
                  </div>
                ) : (!dataReady || switching) ? (
                  <div className="py-1">
                    {Array.from({ length: 7 }).map((_, i) => (
                      <div key={i} className="flex items-start gap-3 px-4"
                        style={{ height: 74, borderBottom: `0.5px solid ${theme.border}` }}>
                        <div className="rounded-full mt-3.5 animate-pulse flex-shrink-0"
                          style={{ width: 12, height: 12, background: theme.rowHover, animationDelay: `${i * 90}ms` }} />
                        <div className="flex-1 flex flex-col gap-2 py-3.5 min-w-0">
                          <div className="animate-pulse" style={{ height: 12, width: `${68 - i * 6}%`, background: theme.rowHover, borderRadius: 4, animationDelay: `${i * 90}ms` }} />
                          <div className="animate-pulse" style={{ height: 10, width: "42%", background: theme.rowHover, borderRadius: 4, animationDelay: `${i * 90 + 45}ms` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div key={activeProject?.path} className="gk-reveal">
                    {/* A branch sitting exactly on its base has no commits of its
                        own — say so instead of rendering an empty timeline. */}
                    {deferredCommitQuery && displayCommits.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-16 text-center">
                        <Search size={18} style={{ color: theme.textFaint }} />
                        <span className="text-xs font-medium" style={{ color: theme.textSec }}>没有匹配的提交</span>
                        <span className="text-[11px]" style={{ color: theme.textMuted }}>尝试消息、作者、分支名或提交哈希</span>
                      </div>
                    ) : focusActive && displayCommits.length === 0 && (
                      <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-16 text-center">
                        <GitBranch size={18} style={{ color: theme.textFaint }} />
                        <span className="text-xs font-medium" style={{ color: theme.textSec }}>该分支还没有独立提交</span>
                        {focusInfo?.base && (
                          <span className="text-[11px]" style={{ color: theme.textMuted }}>
                            与 {focusInfo.base} 完全一致
                          </span>
                        )}
                      </div>
                    )}
                    {displayCommits.map((commit, i) => (
                      <CommitRow
                        // WKWebView can retain a content-visibility paint cache when
                        // the graph gutter changes width. Remount the row on layout
                        // changes so text and graph geometry paint together.
                        key={`${commit.fullHash}:${graphW}:${laneStep}`}
                        commit={commit}
                        graphInfo={displayGraph[i]}
                        selected={detailOpen && !viewChanges && (commit.isStash
                          ? selectedStash?.index === 0
                          : selectedCommit?.hash === commit.hash)}
                        highlight={hoverBranch != null && memberOf(commit).includes(hoverBranch)}
                        graphW={graphW}
                        laneStep={laneStep}
                        remoteNames={remoteNames}
                        onBranchDblClick={doSyncBranch}
                        onClick={() => {
                          // A stash node opens the stash panel (apply/drop), not commit detail.
                          // Only stash@{0} surfaces in --all, so index 0 is the match.
                          if (commit.isStash) { openStash({ index: 0, message: commit.message, date: commit.date }); return; }
                          setViewChanges(false); selectCommit(commit); openDetail();
                        }}
                        onContextMenu={(e) => openCtx(e, commit.isStash
                          ? [
                              { label: "应用到工作区", Icon: RotateCcw, onClick: () => doStashApply(0) },
                              { label: "删除储藏", Icon: Trash2, danger: true, onClick: () => doStashDrop(0) },
                            ]
                          : [
                              { label: "复制提交哈希", Icon: Copy, onClick: () => { navigator.clipboard.writeText(commit.fullHash).catch(() => {}); } },
                              ...(isReal ? [{ label: "遴选到当前分支", Icon: GitCommit, onClick: () => requestCherryPick(commit) } as CtxItem] : []),
                            ])} />
                    ))}
                  </div>
                )}
                {/* Fork-point footer — where this branch was created from */}
                {dataReady && focusActive && focusInfo?.base && (
                  <button onClick={() => setFocus(focusInfo.base)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-left cursor-pointer"
                    style={{ borderTop: `0.5px solid ${theme.border}` }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = theme.rowHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                    <GitBranch size={12} className="flex-shrink-0" style={{ color: branchColor(focusInfo.base) }} />
                    <span className="text-[12px] flex-1 truncate" style={{ color: theme.textMuted }}>
                      从 <span className="font-medium" style={{ color: branchColor(focusInfo.base) }}>{focusInfo.base}</span> 创建 · 点击查看该分支
                    </span>
                    <ChevronRight size={13} className="flex-shrink-0" style={{ color: theme.textFaint }} />
                  </button>
                )}
              </div>
            </div>

            {/* Detail panel — a sliding overlay covering the right ~3/4; the list
                underneath stays full-width and clickable. Close with 返回 / Esc. */}
            {(detailOpen || detailClosing) && dataReady && (
              <div className={`absolute top-0 bottom-0 right-0 flex flex-col overflow-hidden ${detailOpen ? "gk-panel-in" : "gk-panel-out"}`}
                onAnimationEnd={() => { if (!detailOpen) setDetailClosing(false); }}
                style={{ width: "calc(100% - 380px)", background: theme.bgPanel,
                  // Above the timeline's hover popovers (ref chips use z-index 50),
                  // so an expanded branch-ref overlay never bleeds over the panel.
                  zIndex: 60,
                  borderLeft: `0.5px solid ${theme.border}`,
                  boxShadow: theme.isDark ? "-12px 0 34px rgba(0,0,0,0.32)" : "-12px 0 34px rgba(0,0,0,0.10)" }}>
                <div className="flex-shrink-0 flex items-center gap-1 px-2.5 py-2"
                  style={{ borderBottom: `0.5px solid ${theme.border}`, ...glassStyle(theme) }}>
                  <button {...press(closeDetail)}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium cursor-pointer"
                    style={{ color: theme.textMuted, borderRadius: R - 3 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = theme.inputBg; e.currentTarget.style.color = theme.text; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}>
                    <ChevronLeft size={14} /> 返回
                  </button>
                  <div className="flex-1" />
                  <button {...press(closeDetail)} className="p-1.5 cursor-pointer"
                    style={{ color: theme.textMuted, borderRadius: R - 3 }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = theme.inputBg)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                    <X size={14} />
                  </button>
                </div>
                <div key={viewChanges ? "changes" : selectedStash ? `stash-${selectedStash.index}` : selectedCommit?.hash ?? "empty"}
                  className="flex-1 flex overflow-hidden gk-detail-in">
                  {viewChanges ? (
                    <>
                      <ChangesPanel files={activeWorking} selectedFile={selectedWorkingFile}
                        onFileSelect={selectWorkingFile}
                        currentBranch={currentBranch}
                        identities={identities} defaultIdentityId={defaultIdentityId}
                        projectKey={path ?? ""}
                        onCommit={doCommit}
                        onDiscard={doDiscardFile}
                        onDiscardAll={doDiscardAll}
                        onFilesChange={(f) => {
                          setRealData((prev) => {
                            if (!prev) return prev;
                            const next = { ...prev, working: f };
                            if (path) realCache.current.set(path, next);
                            return next;
                          });
                          setSelectedWorkingFile(null);
                        }} />
                      {selectedWorkingFile ? (
                        <WorkingFileDiff file={selectedWorkingFile} />
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center gap-2"
                          style={{ background: theme.bgPanel, color: theme.textFaint }}>
                          <FileText size={32} opacity={0.18} />
                          <span className="text-xs">选择一个文件查看差异</span>
                        </div>
                      )}
                    </>
                  ) : selectedStash ? (
                    <StashDetail stash={selectedStash} files={selectedStash.files}
                      selectedFile={selectedStashFile} onFileSelect={selectStashFile}
                      onApply={() => doStashApply(selectedStash.index)}
                      onDrop={() => doStashDrop(selectedStash.index)} />
                  ) : selectedCommit ? (
                    <CommitDetail commit={selectedCommit} selectedFile={selectedFile}
                      onFileSelect={selectDetailFile}
                      onCherryPick={isReal ? () => requestCherryPick(selectedCommit) : undefined}
                      checkoutBranch={isReal ? syncTargetOf(selectedCommit) : null}
                      onCheckout={isReal ? () => doCheckoutSync(selectedCommit) : undefined} />
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2"
                      style={{ background: theme.bgPanel, color: theme.textFaint }}>
                      <GitCommit size={30} opacity={0.18} />
                      <span className="text-xs">选择一个提交查看详情</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            </div>
          </div>
          )}
        </div>

        {settingsOpen && (
          <SettingsDialog identities={identities} setIdentities={setIdentities}
            defaultId={defaultIdentityId} setDefaultId={setDefaultIdentityId}
            vibrancy={vibrancy} setVibrancy={setVibrancyState}
            paletteId={paletteId} setPaletteId={setPaletteId}
            themeMode={themeMode} setThemeMode={setThemeMode}
            dailyCheck={dailyCheck} setDailyCheck={setDailyCheck}
            onRunCheckNow={() => void runUpdateCheck(true)}
            checkBusy={checkBusy} checkProgress={checkProgress} projectCount={projects.length}
            onClose={() => setSettingsOpen(false)} />
        )}

        {updateRows && (
          <UpdatesDialog rows={updateRows} busy={pullBusy}
            onPull={doPullUpdates} onClose={() => setUpdateRows(null)} />
        )}

        {createBranchOpen && (
          <CreateBranchDialog branches={branches}
            defaultBase={currentBranch || branches[0]?.name || ""}
            dirty={changesCount > 0}
            onCancel={() => setCreateBranchOpen(false)}
            onConfirm={doCreateBranch} />
        )}

        {renameTarget && (
          <RenameBranchDialog branch={renameTarget} branches={branches}
            onCancel={() => setRenameTarget(null)}
            onConfirm={doRenameBranch} />
        )}

        {stashDialogOpen && (
          <StashDialog busy={stashBusy}
            onCancel={() => { if (!stashBusy) setStashDialogOpen(false); }}
            onConfirm={doStash} />
        )}

        {deleteBranchTarget && (
          <ConfirmDialog
            title={deleteBranchTarget.worktree ? "移除工作树并删除分支"
              : deleteBranchTarget.force ? "强制删除分支" : "删除分支"}
            message={deleteBranchTarget.worktree
              ? `分支 ${deleteBranchTarget.branch.name} 正被工作树占用：\n${deleteBranchTarget.worktree}\n\n继续将先移除该工作树，其中所有未提交的改动会永久丢失；若有程序（如 Claude Code 会话）正在使用它，也会一并中断。之后再删除分支${deleteBranchTarget.force ? "（含未合并的提交）" : ""}。`
              : deleteBranchTarget.force
              ? `分支 ${deleteBranchTarget.branch.name} 有未合并的提交,强制删除会永久丢失这些提交。确定继续?`
              : `将删除本地分支 ${deleteBranchTarget.branch.name}。`}
            confirmLabel={deleteBranchTarget.worktree ? "移除工作树并删除"
              : deleteBranchTarget.force ? "强制删除" : "删除"}
            busy={deleteBranchBusy}
            onCancel={() => { if (!deleteBranchBusy) setDeleteBranchTarget(null); }}
            onConfirm={runDeleteBranch} />
        )}

        {createRepoOpen && activeProject && loadGithubAccounts().length > 0 && (
          <CreateRepoDialog accounts={loadGithubAccounts()} defaultName={activeProject.name}
            busy={createRepoBusy}
            onCancel={() => { if (!createRepoBusy) setCreateRepoOpen(false); }}
            onConfirm={doCreateRepoAndPush} />
        )}

        {cloneOpen && (
          <CloneDialog onClose={() => setCloneOpen(false)} onDone={handleCloneDone} />
        )}

        {tagDialogOpen && activeProject && (
          <TagDialog path={activeProject.path} currentBranch={currentBranch}
            busy={tagBusy}
            onCancel={() => { if (!tagBusy) setTagDialogOpen(false); }}
            onConfirm={doCreateAndPushTag} />
        )}

        {checkoutTarget && (
          <Modal title={`切换到 ${checkoutTarget.branch}`} Icon={GitBranch}
            onClose={() => setCheckoutTarget(null)} width={440}
            footer={
              <>
                <button {...press(() => setCheckoutTarget(null))}
                  className="px-3.5 py-2 text-xs font-medium cursor-pointer"
                  style={{ color: theme.textMuted, borderRadius: R - 2, border: `0.5px solid ${theme.inputBorder}` }}>取消</button>
                {checkoutTarget.dirty && (
                  <button {...press(() => doCheckout(false))}
                    className="px-3.5 py-2 text-xs font-medium cursor-pointer"
                    style={{ color: theme.textSec, borderRadius: R - 2, background: theme.inputBg, border: `0.5px solid ${theme.inputBorder}` }}>仍然切换</button>
                )}
                <button {...press(() => doCheckout(checkoutTarget.dirty))}
                  className="px-3.5 py-2 text-xs font-semibold cursor-pointer"
                  style={{ color: "#fff", borderRadius: R - 2, background: checkoutTarget.dirty ? theme.amber : theme.accent }}>
                  {checkoutTarget.dirty ? "储藏并切换" : "切换"}
                </button>
              </>
            }>
            <div className="flex items-start gap-2.5">
              {checkoutTarget.dirty
                ? <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" style={{ color: theme.amber }} />
                : <GitBranch size={15} className="flex-shrink-0 mt-0.5" style={{ color: theme.accent }} />}
              <span className="text-xs leading-relaxed" style={{ color: theme.textSec }}>
                当前分支 {currentBranch}。{checkoutTarget.dirty
                  ? "有未提交的更改,直接切换可能失败或影响改动,建议先储藏(stash)。"
                  : "工作区干净,可以直接切换分支。"}
              </span>
            </div>
          </Modal>
        )}

        {cherryTarget && (
          <CherryPickDialog commit={cherryTarget} branches={branches} currentBranch={currentBranch}
            onCancel={() => setCherryTarget(null)} onConfirm={doCherryPick} />
        )}

        {cherryConflict && (
          <CherryPickConflictDialog commit={cherryConflict.commit} target={cherryConflict.target} files={cherryConflict.files}
            onCancel={() => setCherryConflict(null)}
            onContinue={(useKaleidoscope) => {
              const info = cherryConflict;
              setCherryConflict(null);
              runCherryPick(info.commit, info.target, useKaleidoscope);
            }} />
        )}

        {prOpen && prInfo && (
          <CreatePRDialog path={activeProject?.path} branches={branches} currentBranch={currentBranch} term={prInfo.term}
            defaultTarget={["main", "master", "dev", "develop"].find((n) => branches.some((b) => b.name === n))
              ?? branches.find((b) => b.name !== currentBranch)?.name ?? currentBranch}
            onCancel={() => setPrOpen(false)} onConfirm={doCreatePR} />
        )}

        {acctPicker && (
          <AccountPickerDialog action={acctPicker.action} accounts={acctPicker.accounts}
            canRemember={acctPicker.canRemember}
            onPick={(a, remember) => { acctPicker.resolve({ account: a, remember }); setAcctPicker(null); }}
            onCancel={() => { acctPicker.resolve(null); setAcctPicker(null); }} />
        )}

        {confirmState && (
          <ConfirmDialog title={confirmState.title} message={confirmState.message}
            confirmLabel={confirmState.confirmLabel} busy={confirmBusy}
            onCancel={() => { if (!confirmBusy) setConfirmState(null); }}
            onConfirm={runConfirm} />
        )}

        {/* Global loading overlay for blocking git ops (blocks interaction, shows progress) */}
        {(gitBusy || busyLabel) && (() => {
          // fetch/pull stream progress and can be cancelled; push + generic ops
          // keep the simple spinner.
          const cancellable = gitBusy === "fetch" || gitBusy === "pull";
          const title = gitBusy === "fetch" ? "正在获取…" : gitBusy === "pull" ? "正在拉取…"
            : gitBusy === "push" ? "正在推送…" : busyLabel;
          const pct = gitProg?.percent;
          return (
            <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 300 }}>
              <div className="absolute inset-0"
                style={{ background: theme.scrim, backdropFilter: "blur(1.5px)" }} />
              {cancellable ? (
                <div className="relative flex flex-col gap-2.5 px-5 py-4"
                  style={{ width: 340, background: theme.dialogBg,
                    border: `0.5px solid ${theme.glassBorder}`, borderRadius: R + 2, boxShadow: theme.shadowWindow }}>
                  <div className="flex items-center gap-2.5">
                    <RefreshCw size={15} className="animate-spin" style={{ color: theme.accent, flexShrink: 0 }} />
                    <span className="text-sm font-medium flex-1" style={{ color: theme.text }}>{title}</span>
                    <span className="text-xs font-mono tabular-nums" style={{ color: theme.textMuted }}>
                      {pct != null ? `${pct}%` : ""}
                    </span>
                  </div>
                  <div className="w-full overflow-hidden" style={{ height: 6, background: theme.inputBg, borderRadius: 999 }}>
                    <div className={pct == null ? "animate-pulse" : undefined}
                      style={{ height: "100%", width: pct != null ? `${pct}%` : "100%",
                        background: theme.accent, borderRadius: 999, transition: "width 0.2s ease",
                        opacity: pct != null ? 1 : 0.45 }} />
                  </div>
                  <div className="flex items-center gap-2 min-h-[16px]">
                    <span className="text-[11px] flex-shrink-0" style={{ color: theme.textSec }}>
                      {cancelling ? "正在取消…" : (gitProg?.phase ?? "正在连接远程…")}
                    </span>
                    {gitProg?.raw && !cancelling && (
                      <span className="text-[10px] font-mono truncate flex-1" style={{ color: theme.textFaint }}>
                        {gitProg.raw}
                      </span>
                    )}
                  </div>
                  <div className="flex justify-end pt-0.5">
                    <button onClick={cancelGitAction} disabled={cancelling}
                      className="px-3 py-1.5 text-xs font-medium"
                      style={{ color: cancelling ? theme.textFaint : theme.textMuted, borderRadius: R - 2,
                        border: `0.5px solid ${theme.inputBorder}`,
                        cursor: cancelling ? "not-allowed" : "pointer" }}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="relative flex items-center gap-3 px-5 py-3.5"
                  style={{ background: theme.dialogBg,
                    border: `0.5px solid ${theme.glassBorder}`, borderRadius: R + 2, boxShadow: theme.shadowWindow }}>
                  <RefreshCw size={16} className="animate-spin" style={{ color: theme.accent }} />
                  <span className="text-sm font-medium" style={{ color: theme.text }}>{title}</span>
                </div>
              )}
            </div>
          );
        })()}

        {ctxMenu && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
        )}
    </ThemeCtx.Provider>
  );
}
