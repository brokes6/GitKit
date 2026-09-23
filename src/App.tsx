import { tf, tx, getLanguage, getCurrentLanguage, setCurrentLanguage, languageProgress } from "./i18n";
import type { Language } from "./i18n";
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useDeferredValue, startTransition, useTransition, createContext, useContext, memo } from "react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { GITLAB_CAPABILITIES, tokenCapability, tokenExpiry } from "./gitlabToken";
import type { GitlabTokenInfo } from "./gitlabToken";
import { GITHUB_CAPABILITIES, GITHUB_TOKEN_KINDS, githubCapability, githubTokenExpiry, validGithubUrl } from "./githubToken";
import type { GithubTokenInfo } from "./githubToken";
import { DAILY_CHECK_DEFAULT, nextCheckLabel, shouldPresentCheck, validCheckTime } from "./dailyCheck";
import type { DailyCheck, CheckProgress, CheckSnapshot, CheckResult } from "./dailyCheck";
import {
  GitBranch, GitMerge, GitPullRequest, Upload, Download, RefreshCw,
  Layers, ChevronRight, ChevronDown, Copy, Check, GitCommit, FileText,
  Moon, Sun, Monitor, Plus, Minus, X, FolderOpen, ArrowRight,
  Pin, EyeOff, Eye, Folder, AlertTriangle, Cloud, GitBranchPlus, ChevronLeft, LayoutGrid,
  Settings, UserPlus, Trash2, Star, Users, Github, Laptop, Sparkles, Languages, RotateCcw, TerminalSquare,
  Tag as TagIcon, Square, DownloadCloud, Pencil, FolderGit2, Search, PanelLeft, MoreHorizontal,
  CircleDot, ArrowDown, ArrowUp, ExternalLink,
} from "lucide-react";
import {
  pickRepoFolder, openRepo, loadBranches, loadRemotes, loadHistory,
  loadStatus, loadStatusPaths, loadCommitFiles, commitFileDiff, workingFileDiff, filePreview,
  attributeBranches, filterHistoryByHiddenBranches, historyBranchContext, computeGraph, hasChanges, checkoutBranch, stashPush, stashList, stashApply, stashDrop, stashFiles, stashFileDiff, cherryPick, cherryPickPreflight,
  createBranch, deleteBranch, renameBranch, removeWorktree, checkoutSync, commit as gitCommit, fetchAll, pull, push, gitlabTest, gitlabTokenInfo, githubTokenInfo,
  createPullRequest, branchColor, checkForUpdate, getAppVersion, discardFile, discardAll,
  checkDeps, mergePreview, loadTags, createTag, pushTag, githubCreateRepo, gitRemoteAdd,
  cloneRepo, pickCloneParent, repoNameFromUrl, startWatch, stopWatch,
  cancelGitOp, isCancelled, syncLocal, revealInFileManager, openRepositoryRemote,
  authorColor, authorInitials,
} from "./git";
import type { DepInfo, Tag, RepoInfo, CloneProgress, GitProgress, BehindBranch, WorkingTreeChanged } from "./git";
import { buildSmartMergeCommits, commitBranchName, commitHistoryDate, orderedEquivalentCommits } from "./smartMerge";

// ─── theme ────────────────────────────────────────────────────────────────────

interface ThemeColors {
  bg: string;
  bgPanel: string;
  glass: string;
  glassBorder: string;
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
  additions: number; deletions: number; diff?: string; diffError?: boolean;
}
export interface Commit {
  hash: string; fullHash: string; message: string; body?: string;
  author: Author; date: string; committerDate?: string; patchId?: string;
  lane: number; tags?: string[]; parents: string[];
  stats: { additions: number; deletions: number; files: number };
  files: CommitFile[];
  branchLabel?: string;       // primary branch (drives lane colour)
  branchLabels?: string[];    // every branch whose first-parent backbone reaches here
  isStash?: boolean;          // stash tip — rendered as a single collapsed node
  stashIndex?: number;        // reflog position used by apply/drop/detail actions
  stashBranch?: string;       // branch recorded in the stash reflog subject
  // Smart-merge presentation only. The commits remain independent Git objects;
  // this list lets one logical row disclose every matching branch/hash.
  equivalentCommits?: Commit[];
}
// `worktree` — absolute path of the linked worktree holding this branch, when
// one does. Such a branch can't be checked out or deleted until it's released.
export interface Branch { name: string; remote?: string; isRemote?: boolean; ahead: number; behind: number; current: boolean; color: string; head?: string; worktree?: string }
export interface Stash { index: number; message: string; branch: string; date: string }
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
  staged: boolean; diff?: string; diffError?: boolean;
  // Set for untracked previews rendered by reading the file directly.
  previewKind?: "text" | "binary" | "too_large" | "empty" | "missing";
  previewTruncated?: boolean; previewSize?: number;
}
type GitOperationKind = "fetch" | "pull" | "push";
interface OperationContext {
  project: string;
  path: string;
  branch: string;
  target?: string;
}
type OperationOutcome = "running" | "success" | "error" | "cancelled";
interface OperationDisplay {
  kind: GitOperationKind | "other";
  title: string;
  context: OperationContext;
  progress: GitProgress | null;
  outcome: OperationOutcome;
  phase?: string;
}
export interface Project {
  id: string; name: string; branch: string; color: string; changes: number; path: string;
}


// ─── helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return tx("刚刚");
  const min = Math.floor(diff / 60000), h = Math.floor(min / 60), d = Math.floor(h / 24);
  if (min < 60) return tf("{0} 分钟前", min);
  if (h  < 24)  return tf("{0} 小时前", h);
  if (d  < 7)   return tf("{0} 天前", d);
  return new Date(dateStr).toLocaleDateString(getCurrentLanguage(), { month: "short", day: "numeric" });
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(getCurrentLanguage(), {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function fileManagerActionLabel(): string {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent.toLocaleLowerCase();
  if (agent.includes("macintosh") || agent.includes("mac os")) return tx("在访达中打开");
  if (agent.includes("windows")) return tx("在文件资源管理器中打开");
  return tx("在文件管理器中打开");
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

function Avatar({ author, size = 28 }: { author: Pick<Author, "initials" | "color">; size?: number }) {
  const compact = size <= 18;
  return (
    <div className="rounded-full flex items-center justify-center flex-shrink-0 font-semibold"
      style={{
        width: size, height: size,
        backgroundColor: author.color,
        backgroundImage: "linear-gradient(145deg, rgba(0, 0, 0, 0.16) 0%, rgba(0, 0, 0, 0.02) 48%, rgba(255, 255, 255, 0.28) 100%)",
        color: "#fff",
        fontSize: compact ? Math.max(9, Math.floor(size * 0.56)) : Math.floor(size * 0.4),
        lineHeight: 1,
      }}>
      {author.initials}
    </div>
  );
}

// ─── GraphRowSVG ──────────────────────────────────────────────────────────────

const GraphRowSVG = memo(function GraphRowSVG({ info, height = ROW_H, width = GRAPH_W_MAX, step = LANE_STEP, dim = false, stash = false }: {
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
});

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
      <button title={tx("最小化")} aria-label={tx("最小化窗口")} onClick={() => { void win.minimize(); }} className={cls}
        style={{ width: WINDOW_CONTROL_WIDTH, color: t.textMuted }} {...hover(t.inputBg, t.text)}>
        <Minus size={15} />
      </button>
      <button title={tx("最大化 / 还原")} aria-label={tx("最大化或还原窗口")} onClick={() => { void win.toggleMaximize(); }} className={cls}
        style={{ width: WINDOW_CONTROL_WIDTH, color: t.textMuted }} {...hover(t.inputBg, t.text)}>
        <Square size={11} />
      </button>
      <button title={tx("关闭")} aria-label={tx("关闭窗口")} onClick={() => { void win.close(); }} className={cls}
        style={{ width: WINDOW_CONTROL_WIDTH, color: t.textMuted }} {...hover("#e81123", "#fff")}>
        <X size={16} />
      </button>
    </div>
  );
}

function TitleBar({ themeMode, onThemeCycle, onOpenSettings }: {
  themeMode: ThemeMode; onThemeCycle: () => void; onOpenSettings: () => void;
}) {
  const t = useTheme();
  const { Icon, label } = THEME_META[themeMode];
  const iconButton = "flex items-center justify-center w-8 h-8 flex-shrink-0 cursor-pointer transition-colors duration-150";
  return (
    <div data-tauri-drag-region className="relative h-12 flex items-stretch flex-shrink-0 select-none"
      style={{ ...glassStyle(t), paddingLeft: IS_WINDOWS ? 8 : 92, zIndex: 50 }}>
      <div data-tauri-drag-region className="flex flex-1 min-w-0 items-center gap-2.5 px-3">
        <span className="gk-heading pointer-events-none text-sm font-semibold" style={{ color: t.text }}>GitKit</span>
        <span className="pointer-events-none text-xs" style={{ color: t.textMuted }}>Workspace</span>
      </div>
      <div className="flex items-center gap-0.5 px-2 flex-shrink-0"
        style={{ borderLeft: `0.5px solid ${t.glassBorder}` }}>
        <button onClick={onThemeCycle} className={iconButton}
          title={tf("主题：{0}", tx(label))} aria-label={tf("切换主题，当前{0}", tx(label))}
          style={{ color: t.textMuted, borderRadius: R - 3 }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
          <Icon size={14} aria-hidden="true" />
        </button>
        <button onClick={onOpenSettings} className={iconButton}
          title={tx("设置")} aria-label={tx("打开设置")}
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

// ─── Project sidebar ──────────────────────────────────────────────────────────

function GlideList({ children, className = "", style, insetY = 0 }: {
  children: React.ReactNode; className?: string; style?: React.CSSProperties; insetY?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const currentRowRef = useRef<HTMLElement | null>(null);

  const showRow = (row: HTMLElement) => {
    if (currentRowRef.current === row) return;
    const highlight = highlightRef.current;
    if (!highlight) return;
    if (!currentRowRef.current) highlight.style.transition = "none";
    highlight.style.height = `${row.offsetHeight - insetY * 2}px`;
    highlight.style.transform = `translate3d(0, ${row.offsetTop + insetY}px, 0)`;
    highlight.style.opacity = "1";
    currentRowRef.current = row;
    if (listRef.current) listRef.current.dataset.gliding = "true";
    if (highlight.style.transition === "none") {
      requestAnimationFrame(() => { highlight.style.transition = ""; });
    }
  };
  const hide = () => {
    currentRowRef.current = null;
    if (highlightRef.current) highlightRef.current.style.opacity = "0";
    if (listRef.current) listRef.current.dataset.gliding = "false";
  };
  const rowFrom = (target: EventTarget | null) => {
    const row = target instanceof Element ? target.closest<HTMLElement>("[data-glide-row]") : null;
    return row && listRef.current?.contains(row) ? row : null;
  };

  return (
    <div ref={listRef} className={`gk-glide-list relative flex flex-col ${className}`} style={style}
      onPointerOver={(event) => {
        if (event.pointerType !== "touch") {
          const row = rowFrom(event.target);
          if (row) showRow(row);
        }
      }}
      onPointerLeave={hide}
      onFocusCapture={(event) => {
        const row = rowFrom(event.target);
        if (row) showRow(row);
      }}
      onBlurCapture={(event) => {
        if (!listRef.current?.contains(event.relatedTarget as Node | null)) hide();
      }}
      onTransitionEndCapture={(event) => {
        if (event.target === currentRowRef.current && event.propertyName === "grid-template-rows") {
          const row = currentRowRef.current;
          if (row && highlightRef.current) highlightRef.current.style.height = `${row.offsetHeight - insetY * 2}px`;
        }
      }}>
      <div ref={highlightRef} className="gk-glide-highlight" aria-hidden="true" />
      {children}
    </div>
  );
}

function ProjectItem({ project, isActive, onSelect, onClose, onContextMenu }: {
  project: Project; isActive: boolean; onSelect: () => void; onClose?: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const t = useTheme();
  return (
    <div data-glide-row className="gk-project-item relative flex items-center flex-shrink-0" onContextMenu={onContextMenu}
      data-project-active={isActive || undefined}
      style={{ borderRadius: R - 2 }}>
      <button type="button" onClick={onSelect} aria-current={isActive ? "true" : undefined}
        title={`${project.name} · ${project.branch}\n${project.path}`}
        className="flex items-center gap-2 w-full min-w-0 text-left cursor-pointer"
        style={{ padding: "8px 26px 8px 8px", color: isActive ? t.accentFg : t.textSec }}>
        <FolderGit2 size={15} className="flex-shrink-0" aria-hidden="true" />
        <span className="flex flex-col min-w-0 gap-0.5">
          <span className="text-xs leading-tight truncate" style={{ fontWeight: isActive ? 600 : 500,
            color: isActive ? t.text : t.textSec }}>{project.name}</span>
          <span className="text-[11px] leading-tight truncate" style={{ color: isActive ? t.accentFg : t.textMuted }}>
            {project.branch || tx("未检出分支")}
          </span>
        </span>
      </button>
      {project.changes > 0 && (
        <span className="gk-project-count absolute right-2 text-[10px] font-semibold tabular-nums pointer-events-none"
          style={{ color: t.accentFg }}>{project.changes}</span>
      )}
      {onClose && (
        <button type="button" onClick={(event) => {
          const row = event.currentTarget.closest(".gk-project-item");
          const neighbor = row?.nextElementSibling ?? row?.previousElementSibling;
          neighbor?.querySelector<HTMLButtonElement>("button")?.focus();
          onClose();
        }}
          className="gk-project-close absolute right-0.5 flex items-center justify-center w-7 h-7 cursor-pointer"
          aria-label={tf("关闭项目 {0}", project.name)} title={tf("关闭 {0}", project.name)}
          style={{ color: t.textMuted, borderRadius: R - 3 }}>
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ─── Repository navigation ───────────────────────────────────────────────────

function ProjectSidebar({ projects, activeId, open, onSelect, onClose, onContextMenu, onAdd, onClone }: {
  open: boolean; projects: Project[]; activeId: string;
  onSelect: (id: string) => void; onClose: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, project: Project) => void;
  onAdd: () => void; onClone: () => void;
}) {
  const t = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const [addMenuPos, setAddMenuPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) { setAddMenuPos(null); return; }
    scrollRef.current?.querySelector<HTMLElement>("[data-project-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId, projects.length, open]);

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
      <aside id="project-sidebar" aria-label={tx("项目")} className="gk-project-sidebar flex flex-col flex-shrink-0 min-h-0 select-none"
        style={{ background: "transparent",
          "--gk-project-hover": t.rowHover, "--gk-project-selected": t.rowSelected,
          "--gk-project-close-hover": t.inputBg } as React.CSSProperties}>
        <div className="flex items-center justify-between h-10 px-3 flex-shrink-0">
          <span className="text-[11px] font-semibold" style={{ color: t.textMuted }}>{tx("仓库")}</span>
          <button ref={addButtonRef} onClick={toggleAddMenu}
            className="gk-shell-button flex items-center justify-center w-7 h-7 cursor-pointer"
            style={{ color: addMenuPos ? t.accent : t.textMuted, borderRadius: R - 3 }}
            title={tx("添加仓库")} aria-label={tx("添加仓库")} aria-haspopup="menu" aria-expanded={!!addMenuPos}>
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
        <nav ref={scrollRef} aria-label={tx("打开的项目")} className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          <GlideList key={projects.map((project) => project.id).join("\u0000")}
            className="gk-project-list gap-0.5" style={{ "--gk-glide-hover": t.rowHover } as React.CSSProperties}>
            {projects.map((proj) => (
              <ProjectItem key={proj.id} project={proj} isActive={proj.id === activeId}
                onSelect={() => onSelect(proj.id)}
                onContextMenu={(event) => onContextMenu(event, proj)}
                onClose={projects.length > 1 ? () => onClose(proj.id) : undefined} />
            ))}
            {projects.length === 0 && <span className="px-2 py-3 text-xs" style={{ color: t.textMuted }}>{tx("暂无仓库")}</span>}
          </GlideList>
        </nav>
        <div className="px-3 py-2 text-[11px] flex-shrink-0" style={{ color: t.textMuted }}>
          {projects.length} {tx("个仓库")}
        </div>
      </aside>

      {addMenuPos && createPortal(
        <>
          <div className="fixed inset-0" style={{ zIndex: 80 }} onMouseDown={() => setAddMenuPos(null)} />
          <div ref={addMenuRef} role="menu" aria-label={tx("添加仓库")}
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
              {tx("打开本地仓库")}
            </button>
            <button role="menuitem" onClick={() => chooseAddAction(onClone)}
              className="flex items-center gap-2.5 w-full px-2.5 py-2 text-left text-xs font-medium cursor-pointer"
              style={{ color: t.text, borderRadius: R - 3 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
              <Cloud size={14} aria-hidden="true" style={{ color: t.accent2 }} />
              {tx("克隆远程仓库")}
            </button>
          </div>
        </>, document.body,
      )}
    </>
  );
}

// ─── ActionBar ────────────────────────────────────────────────────────────────

function ActionBar({ project, branch, sidebarOpen, onToggleSidebar, onCreateBranch, onFetch, onPull, onPush,
  onCreateTag, onCherryPick, onStash, onCreatePR, pushCount = 0, busy }: {
  project?: Project; branch: string; sidebarOpen: boolean; onToggleSidebar: () => void;
  onCreateBranch?: () => void; onFetch?: () => void; onPull?: () => void; onPush?: () => void;
  onCreateTag?: () => void; onCherryPick?: () => void; onStash?: () => void; onCreatePR?: () => void;
  pushCount?: number; busy?: null | GitOperationKind | "other";
}) {
  const t = useTheme();
  const [morePos, setMorePos] = useState<{ x: number; y: number } | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  const focusMoreMenuOnOpen = useRef(false);
  useEffect(() => {
    if (!morePos) return;
    if (focusMoreMenuOnOpen.current) {
      moreMenu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
    const close = () => setMorePos(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); moreButton.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("resize", close); };
  }, [morePos]);
  const actions = [
    { label: tx("获取"), Icon: RefreshCw, action: onFetch, op: "fetch" },
    { label: tx("拉取"), Icon: Download, action: onPull, op: "pull" },
    { label: tx("推送"), Icon: Upload, action: onPush, op: "push" },
  ] as const;
  const moreActions = [
    { label: tx("遴选"), Icon: GitCommit, action: onCherryPick },
    { label: tx("储藏"), Icon: Layers, action: onStash },
    { label: tx("创建 Tag 并推送"), Icon: TagIcon, action: onCreateTag },
    { label: tx("创建合并请求"), Icon: GitPullRequest, action: onCreatePR },
  ];
  return (
    <div className="gk-action-bar flex items-center gap-1.5 px-3 flex-shrink-0 select-none"
      role="group" aria-label={tx("仓库操作")}
      style={{ background: t.bg, borderBottom: `0.5px solid ${t.border}`, color: t.textSec,
        "--gk-shell-hover": t.rowHover } as React.CSSProperties}>
      <button onClick={onToggleSidebar} aria-label={sidebarOpen ? tx("收起项目栏") : tx("展开项目栏")}
        aria-expanded={sidebarOpen} aria-controls="project-sidebar" title={sidebarOpen ? tx("收起项目栏") : tx("展开项目栏")}
        className="gk-shell-button flex items-center justify-center w-8 h-8 flex-shrink-0 cursor-pointer">
        <PanelLeft size={17} aria-hidden="true" />
      </button>
      <div className="gk-toolbar-project flex items-center min-w-0 gap-2 px-2 mr-1"
        style={{ borderRight: `0.5px solid ${t.border}` }}>
        <span className="gk-toolbar-name text-xs font-semibold truncate" title={project?.path} style={{ color: t.text }}>{project?.name ?? "GitKit"}</span>
        <span className="flex items-center gap-1 min-w-0" style={{ color: t.textMuted }}>
          <GitBranch size={12} className="flex-shrink-0" aria-hidden="true" />
          <span className="gk-toolbar-branch text-[11px] truncate" title={branch}>{project ? branch || tx("未检出分支") : tx("选择仓库")}</span>
        </span>
      </div>
      {actions.map(({ label, Icon, action, op }) => {
        const running = busy === op;
        return (
          <button key={op} onClick={action} disabled={!action || !!busy} aria-busy={running || undefined}
            data-running={running || undefined}
            className="gk-shell-button gk-git-action flex items-center justify-center gap-2 h-8 px-3 text-xs font-medium flex-shrink-0 cursor-pointer"
            style={{ borderRadius: R - 3,
              "--gk-action-accent": t.accentFg,
              "--gk-action-active-bg": t.accentBg } as React.CSSProperties}>
            <Icon size={15} aria-hidden="true" className="gk-git-action-icon" />
            {label}
            {op === "push" && pushCount > 0 && <span className="text-[10px] tabular-nums" style={{ color: t.accentFg }}>{pushCount}</span>}
          </button>
        );
      })}
      <div className="flex-1" />
      <button onClick={onCreateBranch} disabled={!onCreateBranch || !!busy}
        className="gk-shell-button flex items-center gap-2 h-8 px-3 text-xs font-medium flex-shrink-0 cursor-pointer"
        style={{ borderRadius: R - 3 }}>
        <GitBranchPlus size={15} aria-hidden="true" /> {tx("新建分支")}
      </button>
      <button disabled={!project || !!busy} onClick={() => toast(tf("请选择要合并到 {0} 的分支", branch || tx("当前分支")))}
        className="gk-shell-button flex items-center gap-2 h-8 px-3 text-xs font-medium flex-shrink-0 cursor-pointer"
        style={{ borderRadius: R - 3, background: t.accent, color: "#fff" }}>
        <GitMerge size={15} aria-hidden="true" /> {tx("合并")}
      </button>
      <button ref={moreButton} disabled={!project || !!busy} aria-label={tx("更多仓库操作")} title={tx("更多仓库操作")}
        aria-haspopup="menu" aria-expanded={!!morePos}
        onClick={(event) => {
          if (morePos) { setMorePos(null); return; }
          // Keyboard-triggered clicks have detail=0. Preserve first-item focus
          // for keyboard navigation without showing a focus ring on mouse open.
          focusMoreMenuOnOpen.current = event.detail === 0;
          const rect = moreButton.current?.getBoundingClientRect();
          if (rect) setMorePos({ x: Math.max(8, rect.right - 196), y: rect.bottom + 6 });
        }} className="gk-shell-button flex items-center justify-center w-8 h-8 flex-shrink-0 cursor-pointer">
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {morePos && createPortal(<>
        <div className="fixed inset-0" style={{ zIndex: 80 }} onMouseDown={() => setMorePos(null)} />
        <div ref={moreMenu} role="menu" aria-label={tx("更多仓库操作")} className="gk-action-menu fixed p-1.5"
          style={{ left: morePos.x, top: morePos.y, width: 196, zIndex: 81, background: t.dialogBg,
            border: `0.5px solid ${t.border}`, borderRadius: R, boxShadow: t.shadowEl }}>
          {moreActions.map(({ label, Icon, action }) => (
            <button key={label} role="menuitem" disabled={!action} onClick={() => { setMorePos(null); action?.(); }}
              className="gk-shell-button flex items-center gap-2.5 w-full px-2.5 py-2 text-left text-xs cursor-pointer"
              style={{ color: t.text, borderRadius: R - 3, "--gk-shell-hover": t.rowHover } as React.CSSProperties}>
              <Icon size={14} aria-hidden="true" style={{ color: t.textMuted }} />{label}
            </button>
          ))}
        </div>
      </>, document.body)}
    </div>
  );
}

function OperationCapsule({ kind, title, context, progress, outcome, settledPhase, cancelling, closing, onCancel, onEngagementChange }: {
  kind: GitOperationKind | "other";
  title: string;
  context: OperationContext;
  progress: GitProgress | null;
  outcome: OperationOutcome;
  settledPhase?: string;
  cancelling: boolean;
  closing: boolean;
  onCancel: () => void;
  onEngagementChange: (engaged: boolean) => void;
}) {
  const t = useTheme();
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const running = outcome === "running";
  const cancellable = running && (kind === "fetch" || kind === "pull");
  const errorAction = outcome === "error";
  const actionVisible = cancellable || errorAction;
  const pct = progress?.percent;
  const summaryPct = outcome === "success" ? 100 : pct;
  const phase = cancelling
    ? tx("正在取消…")
    : settledPhase ?? progress?.phase
      ?? (kind === "push" ? tx("正在等待远程响应…") : kind === "other" ? tx("正在更新工作区…") : tx("正在连接远程…"));
  const statusColor = outcome === "success" ? t.green : outcome === "error" ? t.red
    : outcome === "cancelled" ? t.textMuted : t.accent;
  const StatusIcon = running ? RefreshCw : outcome === "success" ? Check : outcome === "error" ? AlertTriangle : X;
  const barInset = outcome === "success" ? 0 : pct != null ? 100 - pct : running ? undefined : 0;
  useEffect(() => { setCopyState("idle"); }, [outcome, settledPhase, context.path]);
  const copyErrorForAI = async () => {
    if (!errorAction || copyState === "copying") return;
    setCopyState("copying");
    try {
      const appVersion = await getAppVersion();
      const safeError = phase
        .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@")
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_TOKEN]")
        .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, "$1[REDACTED]");
      const operation = kind === "fetch" ? tx("获取（Fetch）") : kind === "pull" ? tx("拉取（Pull）")
        : kind === "push" ? tx("推送（Push）") : tx("切换分支");
      const report = [
        tx("请分析以下 GitKit 操作错误，并给出可能原因和安全的排查步骤。"),
        "",
        tx("## 环境"),
        tf("- GitKit 版本：{0}", appVersion ? `v${appVersion}` : tx("未知")),
        tf("- 系统环境：{0}", navigator.platform || tx("未知")),
        tf("- 运行环境：{0}", navigator.userAgent || tx("未知")),
        tf("- 语言：{0}", navigator.language || tx("未知")),
        tf("- 时间：{0}", new Date().toISOString()),
        "",
        tx("## 操作与仓库"),
        tf("- 操作：{0}", operation),
        tf("- 项目：{0}", context.project),
        tf("- 仓库路径：{0}", context.path),
        tf("- 当前分支：{0}", context.branch || tx("未检出分支")),
        ...(context.target ? [tf("- 目标分支：{0}", context.target)] : []),
        "",
        tx("## 错误信息"),
        safeError,
      ].join("\n");
      await navigator.clipboard.writeText(report);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  const CopyStatusIcon = copyState === "copied" ? Check : copyState === "failed" ? AlertTriangle : Copy;
  const copyLabel = copyState === "copying" ? tx("正在整理…") : copyState === "copied" ? tx("已复制，可直接粘贴")
    : copyState === "failed" ? tx("复制失败，请重试") : tx("复制错误信息给 AI");
  return (
    <aside className="gk-operation-capsule fixed" tabIndex={0}
      role={outcome === "error" ? "alert" : "status"} aria-live={outcome === "error" ? "assertive" : "polite"}
      data-outcome={outcome}
      data-closing={closing || undefined}
      onMouseEnter={() => onEngagementChange(true)}
      onMouseLeave={(e) => {
        const focused = e.currentTarget.contains(document.activeElement) ? document.activeElement : null;
        if (focused instanceof HTMLElement) focused.blur();
        onEngagementChange(false);
      }}
      onFocus={() => onEngagementChange(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onEngagementChange(false);
      }}
      aria-label={tf("{0}，项目 {1}，分支 {2}", title, context.project, context.branch)}
      style={{ right: 16, bottom: 40, zIndex: 300, background: t.dialogBg,
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R + 6, boxShadow: t.shadowWindow,
        "--gk-operation-accent": statusColor, "--gk-operation-track": t.inputBg } as React.CSSProperties}>
      <div className="gk-operation-summary flex items-center gap-2.5 px-3.5">
        <StatusIcon size={15} className={`${running ? "animate-spin " : ""}flex-shrink-0`} aria-hidden="true" style={{ color: statusColor }} />
        <span className="text-xs font-semibold truncate flex-1" style={{ color: t.text }}>{title}</span>
        {summaryPct != null && (
          <span className="text-[11px] font-mono tabular-nums flex-shrink-0" style={{ color: t.textMuted }}>{summaryPct}%</span>
        )}
        <ChevronDown size={13} className="gk-operation-chevron flex-shrink-0" aria-hidden="true" style={{ color: t.textFaint }} />
      </div>
      <div className="gk-operation-details px-3.5 pb-3.5">
        <div className="grid gap-1.5 pt-1.5 text-[11px]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-9 flex-shrink-0" style={{ color: t.textFaint }}>{tx("项目")}</span>
            <span className="truncate font-medium" style={{ color: t.textSec }} title={context.project}>{context.project}</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-9 flex-shrink-0" style={{ color: t.textFaint }}>{context.target ? tx("目标") : tx("分支")}</span>
            <span className="truncate font-mono" style={{ color: t.textSec }} title={context.target ?? context.branch}>
              {(context.target ?? context.branch) || tx("未检出分支")}
            </span>
          </div>
        </div>
        <div className="gk-operation-progress mt-3 overflow-hidden" aria-hidden="true">
          <div className={running && pct == null ? "gk-operation-indeterminate" : undefined}
            style={{ clipPath: barInset != null ? `inset(0 ${barInset}% 0 0 round 999px)` : undefined }} />
        </div>
        <div className={`flex gap-2 mt-2 min-w-0 ${outcome === "error" ? "items-start" : "items-center"}`}>
          <span className={outcome === "error"
            ? "gk-operation-error text-[11px] leading-relaxed break-words"
            : "text-[11px] flex-shrink-0"}
            style={{ color: outcome === "error" ? t.red : t.textSec }} title={outcome === "error" ? phase : undefined}>
            {phase}
          </span>
          {progress?.raw && !cancelling && running && (
            <span className="text-[10px] font-mono truncate flex-1" style={{ color: t.textFaint }} title={progress.raw}>
              {progress.raw}
            </span>
          )}
        </div>
        <div className="gk-operation-action-slot" data-visible={actionVisible || undefined} aria-hidden={!actionVisible}>
          <div className="overflow-hidden">
            <div className="flex justify-end pt-3">
              {cancellable ? (
                <button onClick={onCancel} disabled={cancelling}
                  className="gk-operation-cancel px-3 py-1.5 text-[11px] font-medium"
                  style={{ color: cancelling ? t.textFaint : t.textMuted, borderRadius: R - 2,
                    border: `0.5px solid ${t.inputBorder}`, cursor: cancelling ? "not-allowed" : "pointer",
                    "--gk-shell-hover": t.rowHover } as React.CSSProperties}>
                  {cancelling ? tx("取消中") : tx("取消")}
                </button>
              ) : errorAction ? (
                <button onClick={copyErrorForAI} disabled={copyState === "copying"}
                  className="gk-operation-copy flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium"
                  style={{ color: copyState === "copied" ? t.green : copyState === "failed" ? t.red : t.textSec,
                    background: copyState === "copied" ? t.greenBg : copyState === "failed" ? t.redBg : "transparent",
                    borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}`,
                    cursor: copyState === "copying" ? "wait" : "pointer", "--gk-shell-hover": t.rowHover } as React.CSSProperties}>
                  <CopyStatusIcon size={12} aria-hidden="true" /> {copyLabel}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function StatusBar({ project, branch, changes, ready, errored, checkProgress, checkResult, onShowCheckResult, onShowChanges, onSearch }: {
  project?: Project; branch?: Branch; changes: number; ready: boolean; errored: boolean;
  checkProgress: CheckProgress | null; checkResult: CheckResult | null; onShowCheckResult: () => void; onShowChanges: () => void; onSearch: () => void;
}) {
  const t = useTheme();
  const remoteName = branch?.remote?.split("/")[0];
  const syncLabel = branch?.remote
    ? (branch.ahead || branch.behind ? tf("{0} 待同步", remoteName) : tf("{0} 已同步", remoteName))
    : tx("未设置上游");
  const syncDescription = tf("{0}（基于最近获取的远程状态）", syncLabel);
  const SyncIcon = !branch?.remote ? Cloud : branch.ahead || branch.behind ? RefreshCw : Check;
  const behind = branch?.behind ?? 0;
  const ahead = branch?.ahead ?? 0;
  const statusSurface = t.isDark ? "#2B2D31" : "#E1E3E7";
  const statusText = t.isDark ? "#D5D7DC" : "#4E535C";
  const statusMuted = t.isDark ? "#A4A8B0" : "#717780";
  const statusPill = t.isDark ? "rgba(255,255,255,0.09)" : "rgba(78,83,92,0.08)";
  const statusHover = t.isDark ? "rgba(255,255,255,0.14)" : "rgba(78,83,92,0.13)";
  const statusDivider = t.isDark ? "rgba(255,255,255,0.16)" : "rgba(78,83,92,0.18)";
  const statusKey = t.isDark ? "rgba(255,255,255,0.11)" : "rgba(78,83,92,0.11)";
  const statusBorder = t.isDark ? "rgba(255,255,255,0.06)" : "rgba(78,83,92,0.07)";
  return (
    <footer className="gk-status-bar grid items-center gap-4 px-2 flex-shrink-0 text-[11px] select-none"
      aria-label={tx("仓库状态")} style={{
        background: statusSurface,
        color: statusText,
        "--gk-status-text": statusText,
        "--gk-status-muted": statusMuted,
        "--gk-status-pill": statusPill,
        "--gk-status-pill-hover": statusHover,
        "--gk-status-divider": statusDivider,
        "--gk-status-key": statusKey,
        "--gk-status-border": statusBorder,
      } as React.CSSProperties}>
      <div className="gk-status-context flex items-center gap-1.5 min-w-0" role={checkProgress ? "status" : undefined}>
        {checkProgress ? (
          <>
            <span className="truncate tabular-nums" title={checkProgress.project}>{checkProgress.paused ? tx("等待休眠恢复后补查") : tf("已检查 {0} / {1} · 正在检查 {2}", checkProgress.current, checkProgress.total, checkProgress.project)}</span>
            <RefreshCw size={12} className="animate-spin flex-shrink-0" aria-hidden="true" />
          </>
        ) : checkResult?.rows.length ? (
          <button onClick={onShowCheckResult} className="gk-status-pill gk-shell-button flex items-center gap-1.5 px-2 min-w-0 cursor-pointer"
            title={tf("检查完成于 {0}，点击查看结果", formatFullDate(new Date(checkResult.completedAt).toISOString()))}>
            <DownloadCloud size={12} className="flex-shrink-0" aria-hidden="true" />
            <span className="truncate">{checkResult.viewed ? tx("查看检查结果") : tx("检查完成 · 待查看")}</span>
          </button>
        ) : (
          <>
            <GitBranch size={12} className="flex-shrink-0" aria-hidden="true" />
            <span className="truncate" title={project ? branch?.name || project.branch : undefined}>
              {project ? branch?.name || project.branch || tx("未检出分支") : tx("未打开仓库")}
            </span>
            {ready && !errored && <span className="flex items-center flex-shrink-0" role="img" aria-label={syncDescription} title={syncDescription}>
              <SyncIcon size={12} aria-hidden="true" />
              <span className="gk-status-sync-copy ml-1.5 whitespace-nowrap">{syncLabel}</span>
            </span>}
          </>
        )}
      </div>
      <div className="flex items-center justify-center min-w-0" role="status">
        {errored ? <span className="gk-status-pill px-3">{tx("仓库加载失败")}</span>
          : project && !ready ? <span className="gk-status-pill px-3">{tx("正在加载仓库…")}</span>
          : ready ?
          <button onClick={onShowChanges} className="gk-status-pill gk-shell-button flex items-center gap-2 px-3 flex-shrink-0 cursor-pointer tabular-nums"
            title={changes ? tx("工作区有修改，点击查看") : tx("工作区干净，点击查看")}
            aria-label={tf("查看工作区，{0} 个变更，待拉取 {1} 个提交，待推送 {2} 个提交", changes, behind, ahead)}>
            <CircleDot size={12} aria-hidden="true" />
            <span className="font-medium">{changes} {tx("个变更")}</span>
            <span className="gk-status-divider" aria-hidden="true" />
            <span className="flex items-center gap-1" title={tf("待拉取 {0} 个提交", behind)}>
              <ArrowDown size={12} aria-hidden="true" />{behind}
            </span>
            <span className="flex items-center gap-1" title={tf("待推送 {0} 个提交", ahead)}>
              <ArrowUp size={12} aria-hidden="true" />{ahead}
            </span>
            <span className="gk-status-divider" aria-hidden="true" />
            <span className="gk-status-state-copy whitespace-nowrap">{changes ? tx("工作区有修改") : tx("工作区干净")}</span>
          </button>
        : <span className="gk-status-pill px-3 truncate">{tx("打开仓库以开始")}</span>}
      </div>
      <button onClick={onSearch} disabled={!project}
        className="gk-status-pill gk-shell-button justify-self-end flex items-center gap-2 pl-2.5 pr-1 flex-shrink-0 cursor-pointer">
        <Search size={12} aria-hidden="true" />
        <span className="whitespace-nowrap">{tx("搜索提交")}</span>
        <kbd className="gk-status-key flex items-center px-1.5 font-[inherit]">{IS_WINDOWS ? "Ctrl F" : "⌘ F"}</kbd>
      </button>
    </footer>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function SidebarSection({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  const t = useTheme();
  return (
    <button onClick={onToggle} aria-expanded={open}
      className="gk-shell-button flex items-center gap-1.5 w-full h-8 px-3 text-left cursor-pointer"
      style={{ color: t.textMuted, "--gk-shell-hover": t.rowHover } as React.CSSProperties}>
      <ChevronRight size={10} className="flex-shrink-0 transition-transform duration-200"
        style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }} />
      <span className="text-[11px] font-medium">{label}</span>
      <span className="ml-auto text-[10px] tabular-nums">{count}</span>
    </button>
  );
}

function SidebarDisclosure({ open, className = "", children }: {
  open: boolean; className?: string; children: React.ReactNode;
}) {
  return open ? <div className={className}>{children}</div> : null;
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
    borderRadius: R - 3,
    margin: "2px 8px",
    background: active ? t.rowSelected : "transparent",
    transition: "background 0.12s",
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
        style={{ ...itemStyle(active), background: baseBg, paddingLeft: indent ? 24 : 10, height: 30 }}
        title={b.worktree
          ? tf("{0}\n已被工作树占用：{1}\n无法直接切换或删除", b.name, b.worktree)
          : tf("单击只看此分支 · 双击切换到 {0}", b.name)}
        onMouseEnter={(e) => { onHoverBranch(b.name); if (!active) e.currentTarget.style.background = b.current ? currentBgHover : t.rowHover; }}
        onMouseLeave={(e) => { onHoverBranch(null); if (!active) e.currentTarget.style.background = baseBg; }}>
        <GitBranch size={12} className="flex-shrink-0" aria-hidden="true"
          style={{ color: active ? t.accent : b.current ? b.color : t.textMuted }} />
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
            title={pinned.includes(b.name) ? tx("取消置顶") : tx("置顶")}
            style={{ color: pinned.includes(b.name) ? t.accent : t.textMuted }}>
            <Pin size={11} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); toggleHide(b.name); }} className="p-0.5"
            title={tx("隐藏分支")} style={{ color: t.textMuted }}>
            <EyeOff size={11} />
          </button>
        </div>
        {/* Checked-out branch and synchronization counts. */}
        <div className="flex group-hover:hidden items-center gap-1 flex-shrink-0">
          {b.current && <span title={tx("当前检出分支")} aria-label={tx("当前检出分支")} className="w-1 h-1 rounded-full" style={{ background: t.textMuted }} />}
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
        className="flex items-center gap-2 pr-2 cursor-pointer select-none"
        style={{ height: 30, paddingLeft: pad, borderRadius: R - 3, margin: "2px 8px",
          background: "transparent", transition: "background 0.12s" }}
        title={hasLocal ? tf("双击切换到本地分支 {0}", leaf) : tf("双击将 {0}/{1} 同步到本地并检出", remoteName, leaf)}
        onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
        <GitBranch size={12} className="flex-shrink-0" style={{ color: isCurrent ? t.accent : t.textFaint }} />
        <span className="text-xs truncate flex-1" style={{ color: isCurrent ? t.accentFg : t.textSec }}>{label}</span>
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
    <div className="gk-branch-sidebar flex-shrink-0 flex flex-col overflow-y-auto select-none"
      style={{ background: "transparent", borderRight: `0.5px solid ${t.border}` }}>

      <div className="pt-2">
        {/* Global "all branches" view toggle — active when no branch is focused */}
        <button onClick={onShowAll}
          className="flex items-center gap-2 mx-2 mb-2 px-2.5 cursor-pointer"
          style={{ height: 30, width: "calc(100% - 16px)", borderRadius: R - 3,
            background: focusBranch === null ? t.accentBg : "transparent",
            color: focusBranch === null ? t.accentFg : t.textSec }}
          onMouseEnter={(e) => { if (focusBranch !== null) e.currentTarget.style.background = t.rowHover; }}
          onMouseLeave={(e) => { if (focusBranch !== null) e.currentTarget.style.background = "transparent"; }}>
          <LayoutGrid size={13} className="flex-shrink-0"
            style={{ color: focusBranch === null ? t.accent : t.textMuted }} />
          <span className="text-xs font-medium flex-1 text-left truncate">{tx("全部视图")}</span>
          {focusBranch === null && <Check size={12} strokeWidth={2.2} style={{ color: t.accent }} />}
        </button>
        <SidebarSection label={tx("本地分支")} count={visible.length} open={branchesOpen} onToggle={() => setBranchesOpen(!branchesOpen)} />
        <SidebarDisclosure open={branchesOpen} className="pb-2">
            {pinnedBranches.length > 0 && (
              <>
                <div className="flex items-center gap-1 px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: t.textFaint }}>
                  <Pin size={9} /> {tx("置顶")}
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
                      className="hidden group-hover:flex p-0.5 flex-shrink-0" title={tx("隐藏整个文件夹")}
                      style={{ color: t.textMuted }}>
                      <EyeOff size={11} />
                    </button>
                    <span className="text-[11px] flex-shrink-0 group-hover:hidden" style={{ color: t.textFaint }}>{list.length}</span>
                  </div>
                  <SidebarDisclosure open={!isCol}>
                    {list.map((b) => renderBranch(b, b.name.slice(folder.length + 1), true))}
                  </SidebarDisclosure>
                </div>
              );
            })}

            {hiddenBranches.length > 0 && (
              <>
                <button onClick={() => setShowHidden((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 mt-1 cursor-pointer"
                  style={{ color: t.textFaint }}>
                  <EyeOff size={10} className="flex-shrink-0" />
                  <span className="text-[11px] flex-1 text-left">{tx("已隐藏 (")}{hiddenBranches.length})</span>
                  <ChevronRight size={10} className="flex-shrink-0 transition-transform duration-200"
                    style={{ transform: showHidden ? "rotate(90deg)" : "rotate(0deg)" }} />
                </button>
                <SidebarDisclosure open={showHidden}>
                  {hiddenBranches.map((b) => (
                    <div key={b.name} className="group flex items-center gap-2 pr-2 py-1.5"
                      style={{ ...itemStyle(false), paddingLeft: 26, opacity: 0.65 }}>
                      <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: b.color, opacity: 0.4 }} />
                      <span className="text-xs flex-1 truncate" style={{ color: t.textMuted }}>{b.name}</span>
                      <button onClick={() => toggleHide(b.name)} className="p-0.5" title={tx("取消隐藏")}
                        style={{ color: t.textMuted }}>
                        <Eye size={11} />
                      </button>
                    </div>
                  ))}
                </SidebarDisclosure>
              </>
            )}
        </SidebarDisclosure>
      </div>

      <div className="pt-2">
        <SidebarSection label={tx("远程仓库")} count={remotes.length} open={remotesOpen} onToggle={() => setRemotesOpen(!remotesOpen)} />
        <SidebarDisclosure open={remotesOpen} className="pb-2">
            {remotes.length === 0 && (
              <div className="px-7 py-1.5 text-[11px]" style={{ color: t.textMuted }}>{tx("无远程")}</div>
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
                  <SidebarDisclosure open={open}>
                    {(() => {
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
                        {rootLeaves.map((leaf) => renderRemoteLeaf(r.name, leaf, leaf, 24))}
                        {Array.from(folders.keys()).sort().map((folder) => {
                          const key = `${r.name}/${folder}`;
                          const isCol = !openRemoteFolders.includes(key); // default collapsed
                          const list = folders.get(folder)!;
                          return (
                            <div key={key}>
                              <div onClick={() => toggleRemoteFolder(key)}
                                className="flex items-center gap-1.5 px-3 cursor-pointer"
                                style={{ color: t.textSec, height: 30, paddingLeft: 32 }}
                                onMouseEnter={(e) => (e.currentTarget.style.color = t.text)}
                                onMouseLeave={(e) => (e.currentTarget.style.color = t.textSec)}>
                                <ChevronRight size={11} className="flex-shrink-0 transition-transform duration-200"
                                  style={{ transform: isCol ? "rotate(0deg)" : "rotate(90deg)" }} />
                                <Folder size={12} className="flex-shrink-0" style={{ color: t.textMuted }} />
                                <span className="text-[11px] font-medium flex-1 truncate text-left">{folder}</span>
                                <span className="text-[11px] flex-shrink-0" style={{ color: t.textFaint }}>{list.length}</span>
                              </div>
                              <SidebarDisclosure open={!isCol}>
                                {list.map((leaf) => renderRemoteLeaf(r.name, leaf, leaf.slice(folder.length + 1), 36))}
                              </SidebarDisclosure>
                            </div>
                          );
                        })}
                      </>
                    );
                    })()}
                  </SidebarDisclosure>
                </div>
              );
            })}
        </SidebarDisclosure>
      </div>

      <div className="pt-2">
        <SidebarSection label={tx("储藏")} count={stashes.length} open={stashesOpen} onToggle={() => setStashesOpen(!stashesOpen)} />
        <SidebarDisclosure open={stashesOpen} className="pb-2">
            {stashes.length === 0 && (
              <div className="px-7 py-1.5 text-[11px]" style={{ color: t.textMuted }}>
                {tx("暂无储藏")}
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
                <div className="flex flex-col gap-0.5 min-w-0 flex-1"
                  title={`${s.message}\nstash@{${s.index}}${s.date ? ` · ${s.date}` : ""}`}>
                  <span className="text-[12px] font-medium truncate" style={{ color: sel ? t.text : t.textSec }}>
                    {s.message || "GitKit stash"}
                  </span>
                  <div className="flex items-center gap-1 min-w-0" style={{ color: t.textFaint }}>
                    <GitBranch size={10} className="flex-shrink-0" aria-hidden="true" />
                    <span className="text-[11px] font-mono truncate">{s.branch || tx("未知分支")}</span>
                  </div>
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button title={tx("应用到工作区")} onClick={(e) => { e.stopPropagation(); onStashApply?.(s.index); }}
                    className="p-1 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 4 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.accent; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
                    <RotateCcw size={12} />
                  </button>
                  <button title={tx("删除储藏")} onClick={(e) => { e.stopPropagation(); onStashDrop?.(s.index); }}
                    className="p-1 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 4 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = t.redBg; e.currentTarget.style.color = t.red; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textMuted; }}>
                    <Trash2 size={12} />
                  </button>
                </div>
                </div>
            ); })}
        </SidebarDisclosure>
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
function refBadges(tags: string[], remoteNames: string[]): { name: string; kind: RefKind; colorName?: string }[] {
  let head = false;
  const localNames: string[] = [];
  const remoteSimple = new Map<string, string>();
  for (const tag of tags) {
    if (tag === "HEAD") { head = true; continue; }
    if (tag.endsWith("/HEAD")) continue;
    const rem = remoteRefName(tag, remoteNames);
    if (rem !== null) remoteSimple.set(rem, tag);
    else localNames.push(tag);
  }
  const out: { name: string; kind: RefKind; colorName?: string }[] = [];
  if (head) out.push({ name: "HEAD", kind: "head" });
  for (const name of localNames) {
    if (/^v\d/.test(name)) { out.push({ name, kind: "tag" }); continue; }
    if (remoteSimple.has(name)) { out.push({ name, kind: "both" }); remoteSimple.delete(name); }
    else out.push({ name, kind: "local" });
  }
  for (const [name, fullName] of remoteSimple) out.push({ name, kind: "remote", colorName: fullName });
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
  b: { kind: string; name: string; colorName?: string }; onDblClick?: (name: string) => void;
}) {
  const t = useTheme();
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!pos) return;
    const dismiss = () => setPos(null);
    // Close before wheel scrolling starts, and also cover scrollbar, keyboard,
    // and programmatic scrolling. Keeping a fixed portal alive while WKWebView's
    // async scroller moves its row causes the pill to lag and then snap back.
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    document.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("wheel", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [pos]);
  const c = b.kind === "tag" ? t.amber : branchColor(b.colorName ?? b.name);
  const hasLocal = b.kind === "local" || b.kind === "both";
  const hasRemote = b.kind === "remote" || b.kind === "both";
  const tip = b.kind === "both" ? tx("本地 + 远端(已同步)") : b.kind === "local" ? tx("仅本地(未推送)")
    : b.kind === "remote" ? tx("仅远端") : tx("标签");
  const cls = "flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-mono font-semibold";
  const icons = (
    <>
      {hasLocal && <Laptop size={11} strokeWidth={2} className="flex-shrink-0" style={{ color: c }} />}
      {hasRemote && <Cloud size={11} strokeWidth={2} className="flex-shrink-0" style={{ color: c }} />}
    </>
  );
  return (
    <span ref={ref} className="relative inline-flex min-w-0 cursor-pointer" style={{ maxWidth: 176 }}
      title={tf("{0} - {1}\n双击检出并同步", b.name, tip)}
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


function CommitRow({ commit, branchContext, graphInfo, selected, highlight = false, graphW = GRAPH_W_MAX, laneStep = LANE_STEP, remoteNames = [], smartExpanded = false, onToggleSmart, onRelatedCommitClick, onBranchDblClick, onClick, onContextMenu }: {
  commit: Commit; graphInfo: GraphRowInfo; selected: boolean; highlight?: boolean; graphW?: number; laneStep?: number;
  branchContext?: string;
  remoteNames?: string[]; smartExpanded?: boolean; onToggleSmart?: () => void;
  onRelatedCommitClick?: (commit: Commit) => void;
  onBranchDblClick?: (name: string) => void; onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const t = useTheme();
  const laneColor = graphInfo.colors?.dot ?? getLC(graphInfo.dotLane);
  const isMerge = commit.parents.length > 1;
  const equivalents = orderedEquivalentCommits(commit);
  const isSmartMerged = equivalents.length > 1;
  const hasRefs = refBadges(commit.tags ?? [], remoteNames).length > 0;
  // Deterministic height (all content is single-line) → no per-row measurement,
  // which lets us use content-visibility for smooth scrolling on long histories.
  // Merges no longer take their own row — the glyph sits inline on the message line.
  const parts: number[] = [];
  if (hasRefs || branchContext) parts.push(20); // refs or a branch transition
  parts.push(22, 20);            // message + meta
  // Keep the compact association and its disclosure in one flex child. The
  // inner grid owns the reveal, so the collapsed row keeps its original height.
  if (isSmartMerged) parts.push(24 + (smartExpanded ? 6 + equivalents.length * 30 : 0));
  const rowH = 20 + parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * 6;
  return (
    <div onClick={onClick}
      data-glide-row
      data-commit-hash={commit.fullHash}
      data-selected={selected ? "true" : "false"}
      data-highlight={highlight ? "true" : "false"}
      onContextMenu={onContextMenu}
      className="gk-smart-row gk-commit-row relative cursor-pointer overflow-hidden"
      style={{ "--gk-smart-row-height": `${rowH}px`, "--gk-row-hover": t.rowHover,
        borderBottom: `0.5px solid ${t.border}`,
        contentVisibility: "auto", containIntrinsicSize: `0 ${rowH}px` } as React.CSSProperties}>
      {/* Inset selection overlay keeps the graph topology readable. */}
      <div className="gk-commit-row-state absolute pointer-events-none"
        style={{
          top: 2, bottom: 2, left: 5, right: 5,
          borderRadius: R - 3,
          background: selected ? t.accentBg : highlight ? laneColor + "16" : undefined,
          transition: "background 0.1s",
          boxShadow: highlight && !selected ? `inset 0 0 0 0.5px ${laneColor}44` : "none",
        }} />
      <div className="relative flex items-start min-h-0 overflow-hidden">
        {/* Graph sits flush-left — the topology lanes carry the branch colours. */}
        <div style={{ width: graphW, flexShrink: 0 }}>
          <GraphRowSVG info={graphInfo} height={rowH} width={graphW} step={laneStep} stash={commit.isStash} />
        </div>
        <div className="flex-1 min-w-0 flex flex-col justify-center py-2.5 pr-3 gap-1.5">
          {(hasRefs || branchContext) && <div className="flex items-center gap-2 min-w-0">
            <InlineRefs tags={commit.tags ?? []} remoteNames={remoteNames} onDblClick={onBranchDblClick} />
            {branchContext && <span className="flex items-center gap-1 min-w-0 text-[11px] font-mono"
              title={tf("{0} · 分支历史（沿第一父提交追溯）", branchContext)}
              aria-label={tf("分支历史：{0}", branchContext)} style={{ color: t.textMuted }}>
              <GitBranch size={11} className="flex-shrink-0" aria-hidden="true" style={{ color: laneColor }} />
              <span className="truncate">{branchContext}</span>
            </span>}
          </div>}
          {/* Merge: a small lane-coloured glyph inline on the message line — the
              coloured graph lines now carry the "who merged into whom", so no badge row. */}
          <div className="flex items-center gap-1.5 min-w-0">
            {isMerge && (
              <GitMerge size={13} className="flex-shrink-0" style={{ color: laneColor }}
                aria-label={tx("合并提交")} />
            )}
            <span className="text-sm leading-snug truncate flex-1 min-w-0"
              style={{ color: t.text, fontWeight: selected ? 600 : 500 }}>
              {commit.message}
            </span>
            {isSmartMerged && (
              <button type="button" aria-expanded={smartExpanded}
                title={tx("展开真实提交")}
                onClick={(e) => { e.stopPropagation(); onToggleSmart?.(); }}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold flex-shrink-0 cursor-pointer"
                style={{ color: t.accent2Fg, background: t.accent2Bg, borderRadius: R - 4 }}>
                <Sparkles size={10} aria-hidden="true" />
                {equivalents.length} {tx("次提交")}
                <ChevronDown size={10} aria-hidden="true"
                  style={{ transform: smartExpanded ? "rotate(180deg)" : "none", transition: "transform 0.18s cubic-bezier(0.16, 1, 0.3, 1)" }} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <Avatar author={commit.author} size={16} />
            <span className="text-[12px] truncate" style={{ color: t.textMuted }}>{commit.author.name}</span>
            <span className="text-[11px] font-mono flex-shrink-0" style={{ color: t.textFaint }}>{commit.hash}</span>
            <span className="text-[11px] ml-auto flex-shrink-0" style={{ color: t.textFaint }}
              title={`${isSmartMerged ? tx("最近一次提交") : tx("提交时间")}：${formatFullDate(commitHistoryDate(commit))}`}>
              {formatRelativeTime(commitHistoryDate(commit))}
            </span>
          </div>
          {isSmartMerged && (
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                {equivalents.slice(0, 3).map((occurrence, index) => (
                  <span key={occurrence.fullHash} className="contents">
                    {index > 0 && <ArrowRight size={10} aria-hidden="true" className="flex-shrink-0" style={{ color: t.textFaint }} />}
                    <button type="button"
                      title={tf("查看 {0} · {1}", commitBranchName(occurrence), occurrence.fullHash)}
                      onClick={(e) => { e.stopPropagation(); onRelatedCommitClick?.(occurrence); }}
                      className="flex items-center gap-1 min-w-0 px-1.5 py-0.5 cursor-pointer"
                      style={{ color: t.textSec, background: t.inputBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 4 }}>
                      <GitBranch size={10} aria-hidden="true" className="flex-shrink-0"
                        style={{ color: branchColor(commitBranchName(occurrence)) }} />
                      <span className="text-[11px] truncate">{commitBranchName(occurrence)}</span>
                      <span className="text-[10px] font-mono flex-shrink-0" style={{ color: t.textFaint }}>{occurrence.hash}</span>
                    </button>
                  </span>
                ))}
                {equivalents.length > 3 && (
                  <span className="text-[10px] flex-shrink-0" style={{ color: t.textMuted }}>+{equivalents.length - 3}</span>
                )}
              </div>
              <div aria-hidden={!smartExpanded}
                className="gk-smart-details"
                data-expanded={smartExpanded ? "true" : "false"}>
                <div className="min-h-0 overflow-hidden pt-1.5">
                  <div style={{ background: t.inputBg, borderRadius: R - 3 }}>
                    {smartExpanded && equivalents.map((occurrence, index) => (
                      <button key={occurrence.fullHash} type="button"
                        tabIndex={smartExpanded ? 0 : -1}
                        onClick={(e) => { e.stopPropagation(); onRelatedCommitClick?.(occurrence); }}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer"
                        style={{ borderTop: index > 0 ? `0.5px solid ${t.border}` : "none" }}>
                        <span className="text-[10px] font-semibold w-7 flex-shrink-0" style={{ color: index === 0 ? t.accent2Fg : t.textMuted }}>
                          {index === 0 ? tx("来源") : tx("遴选")}
                        </span>
                        <GitBranch size={10} aria-hidden="true" className="flex-shrink-0"
                          style={{ color: branchColor(commitBranchName(occurrence)) }} />
                        <span className="text-[11px] truncate" style={{ color: t.textSec }}>{commitBranchName(occurrence)}</span>
                        <span className="text-[10px] font-mono flex-shrink-0" style={{ color: t.textFaint }}>{occurrence.hash}</span>
                        <span className="text-[10px] ml-auto flex-shrink-0" style={{ color: t.textFaint }}>
                          {formatRelativeTime(occurrence.committerDate ?? occurrence.date)}
                        </span>
                        <ChevronRight size={10} aria-hidden="true" className="flex-shrink-0" style={{ color: t.textFaint }} />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Diff rendering ─────────────────────────────────────────────────────────────

type DiffRowData = {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  oldNo: number | null; newNo: number | null; text: string;
  change?: { start: number; end: number };
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

const CODE_KEYWORDS = new Set([
  "import", "from", "export", "default", "async", "function", "const", "let", "var", "await",
  "return", "if", "else", "for", "while", "new", "throw", "try", "catch", "null", "true", "false",
  "undefined", "fn", "pub", "use", "impl", "struct", "enum", "match", "mut", "def", "class",
]);
const CODE_TOKEN = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined|fn|pub|use|impl|struct|enum|match|mut|def|class)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;
const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|rs|py|java|kt|go|swift|c|cc|cpp|h|hpp|css|scss|json|html?|xml|ya?ml|sh|sql|vue|svelte|dart)$/i;

function SyntaxText({ text, filePath, change, changeBg }: {
  text: string; filePath: string; change?: { start: number; end: number }; changeBg?: string;
}) {
  const t = useTheme();
  const segments: { start: number; end: number; color?: string }[] = [];
  if (CODE_EXTENSIONS.test(filePath)) {
    let last = 0;
    for (const match of text.matchAll(CODE_TOKEN)) {
      const index = match.index ?? 0;
      if (index > last) segments.push({ start: last, end: index });
      const token = match[0];
      const color = /^["'`\d]/.test(token) ? t.amber : CODE_KEYWORDS.has(token) ? t.accent : t.text;
      segments.push({ start: index, end: index + token.length, color });
      last = index + token.length;
    }
    if (last < text.length) segments.push({ start: last, end: text.length });
  } else {
    segments.push({ start: 0, end: text.length });
  }
  const nodes: React.ReactNode[] = [];
  for (const segment of segments) {
    const boundaries = [segment.start, segment.end];
    if (change && change.start > segment.start && change.start < segment.end) boundaries.push(change.start);
    if (change && change.end > segment.start && change.end < segment.end) boundaries.push(change.end);
    boundaries.sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i], end = boundaries[i + 1];
      const changed = change && start >= change.start && end <= change.end;
      nodes.push(<span key={start} style={{ color: segment.color,
        background: changed ? changeBg : undefined,
        borderRadius: changed ? 3 : undefined,
        boxDecorationBreak: changed ? "clone" : undefined,
        WebkitBoxDecorationBreak: changed ? "clone" : undefined }}>
        {text.slice(start, end)}
      </span>);
    }
  }
  return <>{nodes}</>;
}

function changedRanges(before: string, after: string) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return [{ start: prefix, end: before.length - suffix }, { start: prefix, end: after.length - suffix }];
}

function markDiffChanges(rows: DiffRowData[]): DiffRowData[] {
  const marked = rows.map((row) => ({ ...row }));
  for (let i = 0; i < marked.length;) {
    if (marked[i].kind !== "del") { i++; continue; }
    const delStart = i;
    while (i < marked.length && marked[i].kind === "del") i++;
    const addStart = i;
    while (i < marked.length && marked[i].kind === "add") i++;
    for (let pair = 0; pair < Math.min(addStart - delStart, i - addStart); pair++) {
      const [before, after] = changedRanges(marked[delStart + pair].text, marked[addStart + pair].text);
      marked[delStart + pair].change = before;
      marked[addStart + pair].change = after;
    }
  }
  return marked;
}

function DiffRow({ row, gutterW, filePath }: { row: DiffRowData; gutterW: number; filePath: string }) {
  const t = useTheme();
  const add = row.kind === "add", del = row.kind === "del";
  const lineNo = del ? row.oldNo : row.newNo;
  const background = add ? t.greenBg : del ? t.redBg : row.kind === "hunk" ? t.accentBg : "transparent";
  return (
    <div className="gk-code-row relative grid min-w-full font-mono text-[12px] leading-[1.65]"
      style={{ gridTemplateColumns: `${gutterW}px minmax(0, 1fr)`, background }}>
      {(add || del) && <span className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: add ? t.green : t.red }} aria-hidden="true" />}
      <span className="select-none text-right pr-2 tabular-nums" aria-hidden="true"
        style={{ color: add ? t.green : del ? t.red : t.textFaint, borderRight: `0.5px solid ${t.border}` }}>
        {lineNo ?? ""}
      </span>
      {row.kind === "hunk" || row.kind === "meta" ? (
        <span className="px-3 whitespace-pre-wrap break-words select-none" style={{ color: row.kind === "hunk" ? t.accent : t.textMuted }}>{row.text || " "}</span>
      ) : (
        <code className="pl-3 pr-4 whitespace-pre-wrap break-words" style={{ color: t.textSec, overflowWrap: "anywhere" }}>
          <SyntaxText text={row.text || " "} filePath={filePath} change={row.change}
            changeBg={add ? t.green + "33" : t.red + "33"} />
        </code>
      )}
    </div>
  );
}

function DiffRows({ lines, filePath }: { lines: string[]; filePath: string }) {
  const rows = useMemo(() => markDiffChanges(parseDiffRows(lines)), [lines]);
  const maxNo = rows.reduce((m, r) => Math.max(m, r.oldNo ?? 0, r.newNo ?? 0), 0);
  const gutterW = Math.max(String(maxNo).length, 2) * 8 + 22;
  return <>{rows.map((r, i) => <DiffRow key={i} row={r} gutterW={gutterW} filePath={filePath} />)}</>;
}

function DiffSkeleton() {
  const t = useTheme();
  return (
    <div role="status" aria-label={tx("正在读取差异…")}>
      {[72, 54, 81, 64, 76, 58, 69, 47].map((width, index) => (
        <div key={index} className="flex items-center gap-3 h-6 px-4" aria-hidden="true">
          <span className="w-5 h-2.5 flex-shrink-0 animate-pulse"
            style={{ background: t.rowHover, borderRadius: 3, animationDelay: String(index * 55) + "ms" }} />
          <span className="h-2.5 animate-pulse"
            style={{ width: String(width) + "%", maxWidth: 520, background: t.rowHover,
              borderRadius: 3, animationDelay: String(index * 55 + 25) + "ms" }} />
        </div>
      ))}
    </div>
  );
}

function CodeDiffSurface({ filePath, diff, additions, deletions, statusLabel, statusColor,
  loading = false, diffError = false, diffNotice, diffTruncated = false, diffExtraNotice }: {
  filePath: string; diff?: string; additions?: number; deletions?: number;
  statusLabel: string; statusColor: string;
  loading?: boolean; diffError?: boolean;
  diffNotice?: string | null; diffTruncated?: boolean; diffExtraNotice?: string;
}) {
  const t = useTheme();
  const diffLines = useMemo(() => {
    if (!diff) return [];
    const lines = diff.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }, [diff]);
  const effectiveDiffNotice = diffError ? tx("无法读取差异")
    : diffNotice || (diff && /^(?:Binary files .+ differ|GIT binary patch)$/m.test(diff)
      ? tx("二进制文件,无法预览") : null);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" style={{ background: t.bgPanel }}>
      <div className="flex-shrink-0 flex items-center gap-2 px-4 h-11"
        style={{ borderBottom: "0.5px solid " + t.border }}>
        <FileText size={15} className="flex-shrink-0" aria-hidden="true" style={{ color: t.textMuted }} />
        <span className="font-mono text-[12px] font-semibold flex-shrink-0" style={{ color: statusColor }}>{statusLabel}</span>
        <span className="font-mono text-[12px] truncate" title={filePath} style={{ color: t.text }}>{filePath}</span>
        <span className="ml-auto flex gap-2 flex-shrink-0 font-mono text-[11px] tabular-nums">
          {additions !== undefined && <span style={{ color: t.green }}>+{additions}</span>}
          {deletions !== undefined && <span style={{ color: t.red }}>−{deletions}</span>}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2" style={{ overscrollBehavior: "none" }}>
        {loading ? <DiffSkeleton />
        : effectiveDiffNotice ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-xs" style={{ color: t.textFaint }}>
            <FileText size={24} opacity={0.3} aria-hidden="true" />{effectiveDiffNotice}
          </div>
        ) : diffLines.length > 0 ? <>
          <DiffRows lines={diffLines.slice(0, DIFF_RENDER_CAP)} filePath={filePath} />
          {(diffTruncated || diffLines.length > DIFF_RENDER_CAP) && (
            <div className="px-4 py-3 text-[11px] text-center" style={{ color: t.textFaint }}>
              {tx("差异较长,仅显示前")} {DIFF_RENDER_CAP} {tx("行")}{diffExtraNotice}
            </div>
          )}
        </> : (
          <div className="h-full flex items-center justify-center text-xs" style={{ color: t.textFaint }}>{tx("无差异预览")}</div>
        )}
      </div>
    </div>
  );
}

// ─── CommitDetail ─────────────────────────────────────────────────────────────

// Shared body for commit- and stash-detail panes: a file list on the left and
// the selected file's diff on the right. The header above it differs per caller.
function FileDiffView({ files, selectedFile, onFileSelect, onRevealFile, repoPath, sourceKey, emptyHint = tx("无文件更改") }: {
  files: CommitFile[]; selectedFile: CommitFile | null;
  onFileSelect: (f: CommitFile | null) => void;
  onRevealFile?: (f: CommitFile) => void;
  repoPath: string; sourceKey: string | number;
  emptyHint?: string;
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
              <div key={file.path}
                className="group relative flex items-center transition-colors"
                style={{ margin: "1px 6px", width: "calc(100% - 12px)",
                  background: isSel ? t.rowSelected : "transparent", borderRadius: R - 2 }}
                onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = t.rowHover; }}
                onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}>
                <button onClick={() => onFileSelect(isSel ? null : file)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left cursor-pointer">
                  <span className="text-[12px] font-mono font-bold w-3 text-center flex-shrink-0" style={{ color: st.color }}>{st.label}</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs truncate" style={{ color: isSel ? t.accentFg : t.textSec }}>{name}</span>
                    {parts.length > 0 && <span className="text-[12px] truncate" style={{ color: t.textFaint }}>{parts.join("/")}</span>}
                  </div>
                  <div className={`flex gap-1 flex-shrink-0 font-mono text-[11px] transition-opacity ${onRevealFile
                    ? isSel ? "opacity-0" : "group-hover:opacity-0 group-focus-within:opacity-0"
                    : ""}`}>
                    {file.additions > 0 && <span style={{ color: t.green + "88" }}>+{file.additions}</span>}
                    {file.deletions > 0 && <span style={{ color: t.red   + "88" }}>−{file.deletions}</span>}
                  </div>
                </button>
                {onRevealFile && (
                  <button onClick={() => onRevealFile(file)}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 cursor-pointer transition-all duration-100 ${isSel
                      ? "opacity-100"
                      : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"}`}
                    style={{ background: t.inputBg, color: t.textMuted, borderRadius: 6,
                      border: `0.5px solid ${t.inputBorder}` }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = t.accentBg; e.currentTarget.style.color = t.accent; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
                    aria-label={`${fileManagerActionLabel()}：${file.path}`}
                    title={`${fileManagerActionLabel()}：${file.path}`}>
                    <FolderOpen size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {selectedFile ? (
        <CodeDiffSurface key={`${repoPath}:${sourceKey}:${selectedFile.path}:${selectedFile.status}`} filePath={selectedFile.path}
          diff={selectedFile.diff} additions={selectedFile.additions} deletions={selectedFile.deletions}
          statusLabel={fss(selectedFile.status).label} statusColor={fss(selectedFile.status).color}
          loading={!!repoPath && selectedFile.diff === undefined && !selectedFile.diffError}
          diffError={selectedFile.diffError} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-2"
          style={{ background: t.diffBg, color: t.textFaint }}>
          <FileText size={28} opacity={0.25} />
          <span className="text-xs">{tx("点击文件查看差异")}</span>
        </div>
      )}
    </div>
  );
}

function CommitDetail({ commit, selectedFile, onFileSelect, onRevealFile, onCherryPick, onCheckout, checkoutBranch, repoPath }: {
  commit: Commit; selectedFile: CommitFile | null; onFileSelect: (f: CommitFile | null) => void;
  onRevealFile?: (f: CommitFile) => void;
  onCherryPick?: () => void; onCheckout?: () => void; checkoutBranch?: string | null;
  repoPath: string;
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
            <div className="text-xs" style={{ color: t.textMuted }}>{formatRelativeTime(commit.committerDate ?? commit.date)}</div>
            <div className="text-[12px] mt-0.5" style={{ color: t.textFaint }} title={tx("提交时间")}>{formatFullDate(commit.committerDate ?? commit.date)}</div>
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
              title={tx("遴选(cherry-pick)到当前分支")}>
              <GitCommit size={11} />
              <span className="text-[11px] font-medium">{tx("遴选")}</span>
            </button>
          )}
          {onCheckout && checkoutBranch && (
            <button onClick={onCheckout}
              className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
              style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2,
                border: `0.5px solid ${t.inputBorder}` }}
              onMouseEnter={(e) => { e.currentTarget.style.background = t.accentBg; e.currentTarget.style.color = t.accent; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
              title={tf("检出 {0} 并同步到此提交", checkoutBranch)}>
              <Download size={11} />
              <span className="text-[11px] font-medium">{tx("检出")} {checkoutBranch}</span>
            </button>
          )}
          <div className="flex items-center gap-3 ml-auto text-xs font-mono">
            <span style={{ color: t.green + "aa" }}>+{commit.stats.additions}</span>
            <span style={{ color: t.red + "aa" }}>−{commit.stats.deletions}</span>
            <span style={{ color: t.textFaint }}>{commit.stats.files} {tx("个文件")}</span>
          </div>
        </div>
      </div>

      <FileDiffView files={commit.files} selectedFile={selectedFile}
        onFileSelect={onFileSelect} onRevealFile={onRevealFile}
        repoPath={repoPath} sourceKey={commit.fullHash}
        emptyHint={tx("合并提交，无直接更改")} />
    </div>
  );
}

// Stash-detail pane: a stash-specific header (label / message / date + apply &
// drop actions) over the shared file+diff body.
function StashDetail({ stash, files, selectedFile, onFileSelect, onApply, onDrop, repoPath }: {
  stash: Stash; files: CommitFile[]; selectedFile: CommitFile | null;
  onFileSelect: (f: CommitFile | null) => void; onApply: () => void; onDrop: () => void;
  repoPath: string;
}) {
  const t = useTheme();
  const adds = files.reduce((s, f) => s + f.additions, 0);
  const dels = files.reduce((s, f) => s + f.deletions, 0);
  const sourceBranch = stash.branch.trim();
  const stashMessage = stash.message.trim();
  const displayMessage = !stashMessage || stashMessage === "GitKit stash" ? tx("工作区改动") : stashMessage;
  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ background: t.bgPanel }}>
      <div className="flex-shrink-0 p-5" style={{ borderBottom: `0.5px solid ${t.border}` }}>
        <div className="flex items-start gap-3 mb-3">
          <div className="flex items-center justify-center rounded-full flex-shrink-0"
            style={{ width: 40, height: 40, background: t.accentBg }}>
            <Layers size={18} style={{ color: t.accent }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold font-mono truncate" style={{ color: t.text }}
              title={sourceBranch || tx("储藏的更改")}>{sourceBranch || tx("储藏的更改")}</div>
            {stash.date && <div className="text-xs mt-0.5" style={{ color: t.textMuted }}>{stash.date}</div>}
          </div>
        </div>
        <div className="text-sm font-semibold leading-snug mb-3" style={{ color: t.text }}>{displayMessage}</div>
        <div className="flex items-center gap-3">
          <button onClick={onApply}
            className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = t.accentBg; e.currentTarget.style.color = t.accent; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
            title={tx("应用到工作区(保留此储藏)")}>
            <RotateCcw size={11} /> <span className="text-[11px] font-medium">{tx("应用")}</span>
          </button>
          <button onClick={onDrop}
            className="flex items-center gap-1.5 px-2.5 py-1.5 transition-colors duration-100 cursor-pointer"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}
            onMouseEnter={(e) => { e.currentTarget.style.background = t.redBg; e.currentTarget.style.color = t.red; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = t.inputBg; e.currentTarget.style.color = t.textMuted; }}
            title={tx("删除此储藏")}>
            <Trash2 size={11} /> <span className="text-[11px] font-medium">{tx("删除")}</span>
          </button>
          <div className="flex items-center gap-3 ml-auto text-xs font-mono">
            <span style={{ color: t.green + "aa" }}>+{adds}</span>
            <span style={{ color: t.red + "aa" }}>−{dels}</span>
            <span style={{ color: t.textFaint }}>{files.length} {tx("个文件")}</span>
          </div>
        </div>
      </div>
      <FileDiffView files={files} selectedFile={selectedFile} onFileSelect={onFileSelect}
        repoPath={repoPath} sourceKey={stash.index}
        emptyHint={tx("此储藏没有已跟踪文件的改动")} />
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
              title={file.status === "untracked" ? tx("删除此未跟踪文件") : tx("丢弃此文件的更改")}
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
  const [commitMsg, setCommitMsg] = useState(() => loadCommitDraft(projectKey));
  const [committing, setCommitting] = useState(false);

  // This panel unmounts when the detail view closes. Persist one exact draft per
  // repository so returning, switching projects, or restarting does not lose it.
  useEffect(() => { setCommitMsg(loadCommitDraft(projectKey)); }, [projectKey]);
  const updateCommitMsg = (message: string) => {
    setCommitMsg(message);
    saveCommitDraft(projectKey, message);
  };

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
      saveCommitDraft(projectKey, "");
      setCommitMsg(""); onFileSelect(null);
    } catch (e) {
      toast.error(tf("提交失败：{0}", e));
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
          title={tx("丢弃工作区的所有更改（reset --hard + clean）")}
          style={{ color: t.red, background: t.redBg, borderRadius: R - 4,
            border: `0.5px solid ${t.red}33` }}
          onMouseEnter={(e) => (e.currentTarget.style.background = t.red + "22")}
          onMouseLeave={(e) => (e.currentTarget.style.background = t.redBg)}>
          {tx("全部重置")}
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
      style={{ background: t.bgPanel, width: "clamp(260px, 23vw, 300px)",
        borderRight: `0.5px solid ${t.border}` }}>
      <div className="flex-shrink-0" style={{ maxHeight: "42%", minHeight: 80, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <SectionHdr label={tx("已暂存")} count={staged.length} action={tx("全部取消")} onAction={unstageAll} />
        <div className="overflow-y-auto flex-1 py-1">
          {staged.length === 0
            ? <div className="px-4 py-3 text-[12px]" style={{ color: t.textFaint }}>{tx("暂无已暂存的文件")}</div>
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
        <SectionHdr label={tx("未暂存")} count={unstaged.length} action={tx("全部暂存")} onAction={stageAll}
          onReset={files.length > 0 ? onDiscardAll : undefined} />
        <div className="overflow-y-auto flex-1 py-1">
          {unstaged.length === 0
            ? <div className="px-4 py-3 text-[12px]" style={{ color: t.textFaint }}>{tx("所有文件已暂存")}</div>
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
        <textarea value={commitMsg} onChange={(e) => updateCommitMsg(e.target.value)}
          placeholder={tx("提交信息（必填）")} rows={3}
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
          <span className="text-[11px] flex-shrink-0" style={{ color: t.textMuted }}>{tx("提交者")}</span>
          {identities.length === 0 ? (
            <span className="text-[11px] truncate" style={{ color: t.textFaint }}>{tx("使用仓库默认（在设置中可添加身份）")}</span>
          ) : (
            <select value={identityId} onChange={(e) => chooseIdentity(e.target.value)}
              title={tx("该选择会记住到当前项目")}
              className="flex-1 min-w-0 text-[11px] px-2 py-1.5 outline-none cursor-pointer"
              style={{ background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 }}>
              {identities.map((i) => (
                <option key={i.id} value={i.id}>{i.name} · {i.email}</option>
              ))}
              <option value="">{tx("仓库默认身份")}</option>
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
            {committing ? tx("提交中…") : tf("提交到 {0}", currentBranch)}
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

function WorkingFileDiff({ file, repoPath }: { file: WorkingFile; repoPath: string }) {
  const t = useTheme();
  const statusColor = { modified: t.amber, added: t.green, deleted: t.red, untracked: t.textMuted }[file.status];
  const statusLabel = { modified: tx("已修改"), added: tx("新文件"), deleted: tx("已删除"), untracked: tx("未追踪") }[file.status];

  const notice =
    file.previewKind === "binary"    ? tx("二进制文件,无法预览")
    : file.previewKind === "too_large" ? tf("文件过大（{0}）,已跳过预览", formatBytes(file.previewSize))
    : file.previewKind === "empty"     ? tx("空文件")
    : file.previewKind === "missing"   ? tx("文件已不存在")
    : null;

  const changeRows = useMemo(() => file.diff ? parseDiffRows(file.diff.split("\n")) : [], [file.diff]);
  const additions = changeRows.filter((row) => row.kind === "add").length;
  const deletions = changeRows.filter((row) => row.kind === "del").length;

  return (
    <CodeDiffSurface key={`${repoPath}:${file.path}:${file.staged}:${file.status}`} filePath={file.path} diff={file.diff}
      additions={file.diff ? additions : undefined} deletions={file.diff ? deletions : undefined}
      statusLabel={statusLabel} statusColor={statusColor}
      loading={!!repoPath && file.diff === undefined && file.previewKind === undefined && !file.diffError}
      diffError={file.diffError}
      diffNotice={notice} diffTruncated={file.previewTruncated}
      diffExtraNotice={file.previewTruncated ? tf(" · 共 {0}", file.previewSize ? formatBytes(file.previewSize) : "?") : undefined} />
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

// First file worth previewing: skip binary/no-diff entries (0 add + 0 del),
// falling back to the very first file if none look "readable".
function firstReadableFile(files: CommitFile[]): CommitFile | null {
  return files.find((f) => f.additions + f.deletions > 0) ?? files[0] ?? null;
}

// Same set of working files (including staging state)? Used to skip no-op refreshes.
function sameWorking(a: WorkingFile[], b: WorkingFile[]): boolean {
  if (a.length !== b.length) return false;
  const bm = new Map(b.map((f) => [f.path, `${f.status}:${f.staged ? 1 : 0}`]));
  return a.every((f) => bm.get(f.path) === `${f.status}:${f.staged ? 1 : 0}`);
}

function mergeWorkingPaths(previous: WorkingFile[], paths: string[], fresh: WorkingFile[]): WorkingFile[] {
  const covers = (file: string, changed: string) => file === changed || file.startsWith(`${changed}/`);
  const merged = new Map(
    previous
      .filter((file) => !paths.some((changed) => covers(file.path, changed)))
      .map((file) => [file.path, file]),
  );
  for (const file of fresh) merged.set(file.path, file);
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const REAL_CACHE_LIMIT = 2;
const WATCHED_REPO_LIMIT = 2;
const WARM_WATCH_TTL_MS = 5 * 60_000;
const STATUS_DEBOUNCE_MS = 80;

/** Keep the expensive history/graph cache bounded. `touch=false` updates a
 * background repo without promoting it ahead of a repo the user actually used. */
function cacheRealData(cache: Map<string, RealData>, path: string, data: RealData, touch = true): void {
  if (touch) cache.delete(path);
  cache.set(path, data);
  while (cache.size > REAL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
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

// Settings are mirrored locally for startup; native state owns completion/results.
function loadDailyCheck(): DailyCheck {
  try {
    const c = JSON.parse(localStorage.getItem("gitkit.dailyCheck") ?? "{}");
    return {
      enabled: !!c.enabled,
      time: validCheckTime(c.time) ? c.time : DAILY_CHECK_DEFAULT.time,
      skipWeekends: c.skipWeekends === true,
      lastRun: typeof c.lastRun === "number" && Number.isFinite(c.lastRun) ? c.lastRun : 0,
    };
  } catch { return DAILY_CHECK_DEFAULT; }
}
function saveDailyCheck(c: DailyCheck): void {
  try { localStorage.setItem("gitkit.dailyCheck", JSON.stringify(c)); } catch { /* ignore */ }
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
  if (storeKey === "gitkit.projectGithubAccounts") window.dispatchEvent(new Event("gitkit-credentials-changed"));
}
function deletePrefMapEntry(storeKey: string, key: string): void {
  const m = loadPrefMap(storeKey);
  delete m[key];
  try { localStorage.setItem(storeKey, JSON.stringify(m)); } catch { /* ignore */ }
  if (storeKey === "gitkit.projectGithubAccounts") window.dispatchEvent(new Event("gitkit-credentials-changed"));
}

const IDENTITY_PREFS = "gitkit.projectIdentities";
const ACCOUNT_PREFS  = "gitkit.projectGithubAccounts";
const COMMIT_DRAFTS  = "gitkit.commitDrafts";

function loadCommitDraft(projectKey: string): string {
  if (!projectKey) return "";
  const draft = loadPrefMap(COMMIT_DRAFTS)[projectKey];
  return typeof draft === "string" ? draft : "";
}
function saveCommitDraft(projectKey: string, message: string): void {
  if (!projectKey) return;
  if (message) setPrefMapEntry(COMMIT_DRAFTS, projectKey, message);
  else deletePrefMapEntry(COMMIT_DRAFTS, projectKey);
}

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
  window.dispatchEvent(new Event("gitkit-credentials-changed"));
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
  window.dispatchEvent(new Event("gitkit-credentials-changed"));
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

function Modal({ title, Icon, onClose, width = 480, children, footer, closing = false, onExited }: {
  title: string; Icon: DlgIcon; onClose: () => void; width?: number;
  children: React.ReactNode; footer?: React.ReactNode; closing?: boolean; onExited?: () => void;
}) {
  const t = useTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 200, pointerEvents: closing ? "none" : undefined }}>
      <div className={`absolute inset-0 ${closing ? "gk-overlay-out" : "gk-overlay-in"}`}
        style={{ background: "rgba(0,0,0,0.45)" }} {...press(onClose)} />
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`relative flex flex-col ${closing ? "gk-modal-out" : "gk-modal-in"}`}
        onAnimationEnd={(event) => {
          if (closing && event.currentTarget === event.target) onExited?.();
        }}
        style={{ width, maxHeight: "85vh",
        background: t.dialogBg,
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R + 2, boxShadow: t.shadowWindow, overflow: "hidden" }}>
        <div className="flex-shrink-0 flex items-center gap-2.5 px-5 py-3.5" style={{ borderBottom: `0.5px solid ${t.border}` }}>
          <div className="flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 30, height: 30, background: t.accentBg }}>
            <Icon size={15} style={{ color: t.accent }} />
          </div>
          <span className="gk-heading text-sm font-semibold flex-1" style={{ color: t.text }}>{title}</span>
          <button {...press(onClose)}
            aria-label={tf("关闭{0}", title)} title={tx("关闭")}
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

function CommitSearchDialog({ commits, ready, errored, onClose, onSelect }: {
  commits: Commit[]; ready: boolean; errored: boolean;
  onClose: () => void; onSelect: (commit: Commit) => void;
}) {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const deferredQuery = useDeferredValue(normalizedQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const closeActionRef = useRef<(() => void) | null>(null);
  const [closing, setClosing] = useState(false);
  const matches = useMemo(() => deferredQuery ? commits.filter((commit) => [
    commit.message, commit.body, commit.author.name, commit.author.email,
    commit.hash, commit.fullHash, commit.branchLabel,
    ...(commit.branchLabels ?? []), ...(commit.tags ?? []),
  ].filter(Boolean).join("\n").toLocaleLowerCase().includes(deferredQuery)) : commits, [commits, deferredQuery]);
  const results = matches.slice(0, 80);
  const searching = normalizedQuery !== deferredQuery;
  const closeWith = (action: () => void) => {
    if (closing || closeActionRef.current) return;
    closeActionRef.current = action;
    setClosing(true);
  };
  const requestClose = () => closeWith(onClose);
  const selectCommit = (commit: Commit) => closeWith(() => onSelect(commit));
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const dialog = inputRef.current?.closest('[role="dialog"]');
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); requestClose(); return; }
      if (event.key !== "Tab" || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", trapFocus);
    return () => { window.removeEventListener("keydown", trapFocus); previous?.focus(); };
  }, []);
  useEffect(() => { resultsRef.current?.scrollTo({ top: 0 }); }, [deferredQuery]);
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 200, pointerEvents: closing ? "none" : undefined }}>
      <div className={`absolute inset-0 ${closing ? "gk-overlay-out" : "gk-overlay-in"}`}
        style={{ background: "rgba(0,0,0,0.45)" }} {...press(requestClose)} />
      <div role="dialog" aria-modal="true" aria-label={tx("搜索提交")}
        className={`gk-search-surface relative flex flex-col min-h-0 overflow-hidden ${closing ? "gk-modal-out" : "gk-modal-in"}`}
        onAnimationEnd={(event) => {
          if (closing && event.currentTarget === event.target) {
            const action = closeActionRef.current;
            closeActionRef.current = null;
            action?.();
          }
        }}
        style={{ width: 620, maxWidth: "calc(100vw - 32px)", maxHeight: "85vh",
          background: t.dialogBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R + 2,
          boxShadow: t.shadowWindow,
          "--gk-search-input-bg": t.inputBg, "--gk-search-input-hover": t.rowHover,
          "--gk-search-clear-hover": t.inputBorder, "--gk-search-muted": t.textMuted,
          "--gk-search-text": t.text } as React.CSSProperties}>
        <div className="gk-search-input-row flex items-center gap-2.5 h-11 flex-shrink-0 px-3"
          style={{ borderBottom: `0.5px solid ${t.inputBorder}` }}>
          <Search size={16} className="flex-shrink-0" aria-hidden="true" style={{ color: t.textMuted }} />
          <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)}
            aria-label={tx("搜索提交")} placeholder={tx("搜索消息、作者、分支或哈希…")} autoComplete="off" spellCheck={false}
            className="gk-search-input min-w-0 flex-1 h-6 bg-transparent text-sm leading-6 outline-none"
            style={{ color: t.text }} onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); resultsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }
              if (event.key === "Enter" && results[0] && !searching && ready && !errored) { event.preventDefault(); selectCommit(results[0]); }
            }} />
          {query && <button type="button" aria-label={tx("清空搜索")}
            {...press(() => { setQuery(""); inputRef.current?.focus(); })}
            className="gk-search-clear flex items-center justify-center w-6 h-6 flex-shrink-0 rounded-full cursor-pointer">
            <X size={13} aria-hidden="true" />
          </button>}
        </div>
        <div ref={resultsRef} className="gk-search-results overflow-y-auto min-h-0 p-1" style={{ height: 320 }}
          aria-label={tx("搜索结果")} aria-busy={searching || !ready} onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            event.preventDefault();
            if (event.key === "ArrowUp" && index <= 0) { inputRef.current?.focus(); return; }
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
            buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus();
          }}>
          {errored || !ready || results.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-4" style={{ color: t.textMuted }}>
              <span className="flex items-center justify-center w-8 h-8 mb-1 rounded-md" style={{ background: t.inputBg }}>
                <Search size={16} aria-hidden="true" />
              </span>
              <span className="text-xs font-medium" style={{ color: t.text }}>
                {errored ? tx("加载失败") : !ready ? tx("正在读取提交…") : deferredQuery ? tx("没有匹配的提交") : tx("这个仓库还没有提交")}
              </span>
              {(errored || (ready && deferredQuery)) && <span className="text-[11px]">
                {errored ? tx("仓库加载失败，请关闭搜索后重试") : tx("换个关键词再试")}
              </span>}
            </div>
          ) : <GlideList key={deferredQuery} className="gap-px" style={{ "--gk-glide-hover": t.rowHover } as React.CSSProperties}>
            {results.map((commit) => (
              <button key={commit.fullHash} data-glide-row type="button" disabled={searching} onClick={() => selectCommit(commit)}
                className="gk-search-result relative flex items-start gap-2.5 w-full px-3 py-3 text-left cursor-pointer"
                style={{ borderRadius: R - 3, color: t.text }}>
                <GitCommit size={15} className="flex-shrink-0 mt-0.5" aria-hidden="true" style={{ color: t.accent }} />
                <span className="flex flex-col gap-1 min-w-0 flex-1">
                  <span className="text-xs font-medium truncate" title={commit.message}>{commit.message}</span>
                  <span className="text-[11px] truncate" style={{ color: t.textMuted }}>{commit.author.name} · {commit.hash} · {commit.branchLabel || tx("提交")}</span>
                </span>
                <span className="text-[11px] flex-shrink-0" title={tf("提交时间：{0}", formatFullDate(commit.committerDate ?? commit.date))} style={{ color: t.textMuted }}>{formatRelativeTime(commit.committerDate ?? commit.date)}</span>
              </button>
            ))}
          </GlideList>}
        </div>
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
            style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>{tx("取消")}</button>
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
        style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>{tx("取消")}</button>
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
    <Modal title={tx("创建 GitHub 仓库并推送")} Icon={Github} onClose={busy ? () => {} : onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel}
        onConfirm={() => { if (canSubmit && account) onConfirm(account, name.trim(), isPrivate, description.trim()); }}
        confirmLabel={tx("创建并推送")} disabled={!canSubmit} busy={busy} />}>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        {tx("该仓库还没有远程地址。将在")} {host} {tx("上创建一个新仓库,设为 origin 并推送当前分支。")}
      </span>
      {accounts.length > 1 && (
        <Field label={tx("GitHub 账号")}>
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
      <Field label={tx("仓库名称")}>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
          placeholder="my-repo" className="text-xs px-2.5 py-2 outline-none font-mono"
          style={dlgCtl(t, name.length > 0 && !nameOk)} />
      </Field>
      <Field label={tx("可见性")}>
        <div className="flex items-center gap-2">
          {visBtn(true, tx("私有"), tx("仅自己与协作者可见"))}
          {visBtn(false, tx("公开"), tx("任何人可见"))}
        </div>
      </Field>
      <Field label={tx("描述（可选）")}>
        <input value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder={tx("一句话说明这个仓库")} className="text-xs px-2.5 py-2 outline-none"
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
    <Modal title={tf("选择 GitHub 账号 · {0}", action)} Icon={Github} onClose={onCancel} width={440}>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        {tx("该远程匹配到多个 GitHub 账号,选择本次")}{action}{tx("使用的身份。")}
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
            {tx("记住本项目的选择,以后不再询问")}
            <span className="block" style={{ color: t.textFaint }}>{tx("可在设置 › 项目配置中查看或删除")}</span>
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
    const folder = await pickCloneParent(tx("选择克隆到的文件夹"));
    if (folder) setDest(folder);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    setProg({ phase: tx("准备克隆"), percent: null, raw: "" });
    // For HTTPS, use the token typed here, else fall back to a configured account.
    const tok = isHttp ? (token.trim() || pickRemoteToken(trimmedUrl)) : undefined;
    try {
      const path = await cloneRepo(trimmedUrl, dest, tok, (p) => setProg(p));
      toast.success(tf("已克隆仓库：{0}", name), { description: path });
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
          border: `0.5px solid ${t.inputBorder}`, cursor: busy ? "not-allowed" : "pointer" }}>{tx("取消")}</button>
      <button {...(canSubmit ? press(submit) : {})} disabled={!canSubmit}
        className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold"
        style={{ background: canSubmit ? t.accent : t.inputBg, color: canSubmit ? "#fff" : t.textFaint,
          borderRadius: R - 2, cursor: canSubmit ? "pointer" : "not-allowed" }}>
        {busy ? <RefreshCw size={12} className="animate-spin" /> : <Cloud size={12} />}
        {busy ? tx("克隆中…") : tx("克隆")}
      </button>
    </>
  );

  return (
    <Modal title={tx("克隆仓库")} Icon={Cloud} onClose={busy ? () => {} : onClose} width={480} footer={cancelFooter}>
      <Field label={tx("仓库地址（HTTP 或 SSH）")}>
        <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={tx("https://github.com/user/repo.git 或 git@github.com:user/repo.git")}
          className="text-xs px-2.5 py-2 outline-none font-mono w-full"
          style={dlgCtl(t, trimmedUrl.length > 0 && !looksValid)} />
        {trimmedUrl.length > 0 && !looksValid && (
          <span className="text-[11px]" style={{ color: t.red }}>{tx("无法识别的地址，请粘贴完整的 HTTP 或 SSH 克隆地址")}</span>
        )}
      </Field>

      <Field label={tx("克隆到")}>
        <button {...(busy ? {} : press(pickDest))} disabled={busy}
          className="flex items-center gap-2 px-2.5 py-2 text-xs text-left w-full"
          style={{ ...dlgCtl(t), cursor: busy ? "not-allowed" : "pointer" }}>
          <FolderOpen size={13} style={{ color: t.textMuted, flexShrink: 0 }} />
          <span className="truncate" style={{ color: dest ? t.text : t.textFaint }}>
            {dest || tx("选择一个文件夹…")}
          </span>
        </button>
        {dest && name && (
          <span className="text-[11px] font-mono truncate" style={{ color: t.textFaint }}>
            {tx("将克隆到：")}{dest}/{name}
          </span>
        )}
      </Field>

      {isHttp && (
        <Field label={tx("访问令牌（可选，私有仓库需要）")}>
          <input value={token} onChange={(e) => setToken(e.target.value)} disabled={busy}
            type="password" placeholder={tx("留空则使用已配置的账号令牌")}
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
    { key: "carry",   Icon: ArrowRight, label: tx("带到新分支"), desc: tx("把未提交更改一起带到新分支（默认）") },
    { key: "stash",   Icon: Layers,     label: tx("储藏改动"),   desc: tx("先储藏（git stash），新分支保持干净，可稍后恢复") },
    { key: "discard", Icon: Trash2,     label: tx("放弃改动"),   desc: tx("丢弃所有未提交更改，不可撤销"), danger: true },
  ];

  return (
    <Modal title={tx("新建分支")} Icon={GitBranchPlus} onClose={onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit}
        confirmLabel={dirty && mode === "stash" ? tx("储藏并创建") : dirty && mode === "discard" ? tx("放弃并创建") : tx("创建并切换")}
        disabled={!valid} danger={dirty && mode === "discard"} />}>
      <Field label={tx("基于分支")}>
        <select value={base} onChange={(e) => setBase(e.target.value)}
          className="text-xs px-2.5 py-2 cursor-pointer outline-none w-full" style={dlgCtl(t)}>
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
      </Field>
      <Field label={tx("分支名称")}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="feature/new-thing"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t, exists)} />
        {exists && <span className="text-[11px]" style={{ color: t.red }}>{tx("分支")} {trimmed} {tx("已存在")}</span>}
      </Field>

      {dirty && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: t.amber }}>
            <AlertTriangle size={12} className="flex-shrink-0" />
            <span>{tx("当前有未提交的更改，选择如何处理：")}</span>
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
    <Modal title={tf("重命名分支 {0}", branch.name)} Icon={Pencil} onClose={onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel={tx("重命名")} disabled={!valid} />}>
      <Field label={tx("新分支名称")}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="feature/right-name"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t, exists)} />
        {exists && <span className="text-[11px]" style={{ color: t.red }}>{tx("分支")} {trimmed} {tx("已存在")}</span>}
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
    <Modal title={tx("储藏更改")} Icon={Layers} onClose={onCancel} width={460}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel={tx("储藏")} busy={busy} />}>
      <Field label={tx("储藏标题（可选）")}>
        <input autoFocus value={message} onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={tx("GitKit stash（默认）")}
          className="text-xs px-2.5 py-2 outline-none w-full" style={dlgCtl(t)} />
      </Field>
      <span className="text-[11px]" style={{ color: t.textFaint }}>{tx("不填则使用默认标题。已跟踪与未跟踪的改动都会一起储藏。")}</span>
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
    <Modal title={tx("创建 Tag 并推送")} Icon={TagIcon} onClose={onCancel} width={480}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel={tx("创建并推送")} disabled={!valid} busy={busy} />}>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium" style={{ color: t.textMuted }}>{tx("已有标签")}</span>
        <div className="flex flex-col max-h-40 overflow-y-auto"
          style={{ border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 2, background: t.inputBg }}>
          {tags === null ? (
            <div className="px-3 py-2 text-[11px]" style={{ color: t.textFaint }}>{tx("加载中…")}</div>
          ) : tags.length === 0 ? (
            <div className="px-3 py-2 text-[11px]" style={{ color: t.textFaint }}>{tx("还没有任何标签")}</div>
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
      <Field label={tf("新标签名（打在 {0} 的最新提交上）", currentBranch || tx("当前分支"))}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder="v0.2.0"
          className="text-xs px-2.5 py-2 outline-none font-mono w-full" style={dlgCtl(t, exists)} />
        {exists && <span className="text-[11px]" style={{ color: t.red }}>{tx("标签")} {trimmed} {tx("已存在")}</span>}
      </Field>
      <Field label={tx("说明（可选，填了即带注释标签）")}>
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
    <Modal title={tx("遴选 (cherry-pick)")} Icon={GitCommit} onClose={onCancel} width={480}
      footer={<ModalFooter onCancel={onCancel} onConfirm={() => onConfirm(target)} confirmLabel={tx("遴选")} disabled={!target} />}>
      <Field label={tx("要遴选的提交")}>
        <div className="flex items-center gap-2.5 px-3 py-2.5" style={dlgCtl(t)}>
          <span className="font-mono text-[11px] flex-shrink-0" style={{ color: t.textFaint }}>{commit.hash}</span>
          <span className="text-xs truncate" style={{ color: t.text }}>{commit.message}</span>
        </div>
      </Field>
      <Field label={tx("遴选到分支")}>
        <select value={target} onChange={(e) => setTarget(e.target.value)}
          className="text-xs px-2.5 py-2 cursor-pointer outline-none w-full" style={dlgCtl(t)}>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>{b.name}{b.name === currentBranch ? tx("（当前）") : ""}</option>
          ))}
        </select>
      </Field>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        {tx("提交会被复制到所选分支;若不是当前分支,会先自动切换过去。")}
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
    <Modal title={tx("遴选存在冲突")} Icon={AlertTriangle} width={480} onClose={onCancel}
      footer={
        <div className="flex flex-col gap-2.5 w-full">
          <div className="flex items-center justify-end gap-2">
            <button {...press(onCancel)}
              className="px-3.5 py-2 text-xs font-medium cursor-pointer"
              style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}` }}>{tx("取消")}</button>
            <button {...press(() => onContinue(useKal && kalReady))}
              className="px-3.5 py-2 text-xs font-semibold cursor-pointer"
              style={{ background: t.accent, color: "#fff", borderRadius: R - 2 }}>{tx("继续遴选")}</button>
          </div>
          <label className="flex items-center gap-2 self-end select-none"
            style={{ cursor: kalReady ? "pointer" : "not-allowed", opacity: kalReady ? 1 : 0.5 }}>
            <input type="checkbox" checked={useKal && kalReady} disabled={!kalReady}
              onChange={(e) => setUseKal(e.target.checked)}
              style={{ accentColor: t.accent, cursor: kalReady ? "pointer" : "not-allowed" }} />
            <span className="text-[11px]" style={{ color: t.textMuted }}>
              {tx("使用 Kaleidoscope 处理冲突")}{kalReady ? "" : tx("（未检测到，见设置→环境依赖）")}
            </span>
          </label>
        </div>
      }>
      <div className="flex items-start gap-2.5 px-3 py-2.5" style={dlgCtl(t)}>
        <span className="font-mono text-[11px] flex-shrink-0 pt-px" style={{ color: t.textFaint }}>{commit.hash}</span>
        <span className="text-xs truncate" style={{ color: t.text }}>{commit.message}</span>
      </div>
      <span className="text-[11px]" style={{ color: t.textMuted }}>
        {tx("将")} {commit.hash} {tx("遴选到")} <b style={{ color: t.text }}>{target}</b> {tx("会在")} {files.length} {tx("个文件产生冲突：")}
      </span>
      <div className="flex flex-col gap-1 max-h-44 overflow-auto px-3 py-2"
        style={{ background: t.inputBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 }}>
        {files.map((f) => (
          <span key={f} className="text-[11px] font-mono truncate" style={{ color: t.red }}>{f}</span>
        ))}
      </div>
      <span className="text-[11px]" style={{ color: t.textFaint }}>
        {tx("继续后仓库会进入冲突解决状态。勾选 Kaleidoscope 会自动打开它逐个解决,解决完成后自动完成遴选;否则请解决冲突后执行 git cherry-pick --continue。")}
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
    <Modal title={tf("创建{0}", term)} Icon={GitPullRequest} onClose={onCancel} width={560}
      footer={<ModalFooter onCancel={onCancel} onConfirm={submit} confirmLabel={tf("创建{0}", term)} disabled={!valid} busy={busy} />}>
      {/* merge route */}
      <div className="flex flex-col gap-2.5 p-3.5"
        style={{ background: t.inputBg, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 1 }}>
        <div className="flex flex-col gap-1.5">
          {/* labels — a 24px spacer holds the arrow column so labels stay aligned */}
          <div className="flex items-center gap-2.5">
            <span className="flex-1 min-w-0 text-[11px] font-medium" style={{ color: t.textMuted }}>{tx("来源分支")}</span>
            <span className="flex-shrink-0" style={{ width: 24 }} />
            <span className="flex-1 min-w-0 text-[11px] font-medium" style={{ color: t.textMuted }}>{tx("目标分支")}</span>
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
            <AlertTriangle size={12} className="flex-shrink-0" /> {tx("来源与目标分支不能相同")}
          </div>
        )}
        {!same && preview.state === "checking" && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium"
            style={{ background: t.inputBg, color: t.textMuted, borderRadius: R - 3 }}>
            <RefreshCw size={12} className="animate-spin flex-shrink-0" /> {tx("正在检测合并冲突…")}
          </div>
        )}
        {!same && preview.state === "clean" && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium"
            style={{ background: t.greenBg, color: t.green, borderRadius: R - 3 }}>
            <Check size={12} className="flex-shrink-0" /> {tx("无冲突，可干净合并")}
          </div>
        )}
        {!same && preview.state === "conflict" && (
          <div className="flex flex-col gap-1.5 px-2.5 py-2"
            style={{ background: t.redBg, borderRadius: R - 3 }}>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: t.red }}>
              <AlertTriangle size={12} className="flex-shrink-0" />
              {tx("检测到合并冲突 ·")} {preview.files.length} {tx("个文件")}
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
              {tx("仍可创建")}{term}{tx("，冲突需在合并时解决。")}
            </span>
          </div>
        )}
      </div>

      <Field label={tx("标题")}>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder={tf("{0}标题", term)} className="text-xs px-2.5 py-2 outline-none w-full" style={dlgCtl(t)} />
      </Field>
      <Field label={tx("描述（可选）")}>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={5}
          placeholder={tx("补充说明…")} className="text-xs px-2.5 py-2 outline-none w-full resize-none"
          style={{ ...dlgCtl(t), fontFamily: "inherit" }} />
      </Field>

      <div className="flex items-start gap-2 px-3 py-2.5"
        style={{ background: t.accentBg, borderRadius: R - 2 }}>
        <GitPullRequest size={13} className="flex-shrink-0 mt-0.5" style={{ color: t.accent }} />
        <span className="text-[11px] leading-relaxed" style={{ color: t.accentFg }}>
          {tx("来源分支需已推送到远程。创建成功后会自动在浏览器打开。")}
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
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{tx("提交者身份")}</span>
          <span className="text-[11px]" style={{ color: t.textFaint }}>
            {tx("维护多套 name / email，提交时按所选身份注入，不改动全局 Git 配置。")}
          </span>
        </div>
        {identities.length > 0 && (
          <span className="flex-shrink-0 px-2 py-0.5 text-[10px] font-medium"
            style={{ color: t.textMuted, background: t.inputBg, borderRadius: R - 4 }}>
            {identities.length} {tx("个身份")}
          </span>
        )}
      </div>

      <div className="overflow-hidden"
        style={{ border: `0.5px solid ${t.border}`, borderRadius: R - 1 }}>
        {identities.length === 0 ? (
          <div className="text-[11px] px-4 py-8 text-center" style={{ color: t.textFaint }}>
            {tx("还没有身份，点击下方「新增身份」添加")}
          </div>
        ) : (
          <div className="overflow-y-auto overscroll-contain"
            style={{ maxHeight: showForm ? 184 : 320, scrollbarGutter: "stable" }}>
            {identities.map((i, index) => {
              const isDefault = i.id === defaultId;
              return (
                <div key={i.id} className="group flex items-center gap-3 px-3 py-2.5"
                  style={{ minHeight: 56, background: isDefault ? t.accentBg : "transparent",
                    borderBottom: index < identities.length - 1 ? `0.5px solid ${t.border}` : undefined }}>
                  <Avatar author={{ initials: authorInitials(i.name), color: authorColor(i.email) }} size={34} />
                  <div className="flex flex-col min-w-0 flex-1 gap-0.5">
                    <span className="text-xs font-medium truncate" style={{ color: t.text }}>
                      {i.name}{isDefault && (
                        <span className="ml-2 text-[10px] font-normal" style={{ color: t.accent }}>{tx("默认")}</span>
                      )}
                    </span>
                    <span className="text-[11px] font-mono truncate" style={{ color: t.textMuted }}>{i.email}</span>
                  </div>
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button {...press(() => setDefaultId(i.id))}
                      aria-label={isDefault ? tf("{0} 是默认身份", i.name) : tf("将 {0} 设为默认身份", i.name)}
                      title={isDefault ? tx("默认身份") : tx("设为默认")}
                      className="gk-shell-button flex items-center justify-center w-7 h-7 cursor-pointer"
                      style={{ color: isDefault ? t.accent : t.textFaint, borderRadius: R - 4,
                        "--gk-shell-hover": t.inputBg } as React.CSSProperties}>
                      <Star size={14} fill={isDefault ? t.accent : "none"} />
                    </button>
                    <button {...press(() => startEdit(i))} aria-label={tf("编辑 {0}", i.name)} title={tx("编辑")}
                      className="gk-shell-button flex items-center justify-center w-7 h-7 cursor-pointer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                      style={{ color: t.textMuted, borderRadius: R - 4,
                        "--gk-shell-hover": t.inputBg } as React.CSSProperties}>
                      <Pencil size={13} />
                    </button>
                    <button {...press(() => remove(i.id))} aria-label={tf("删除 {0}", i.name)} title={tx("删除")}
                      className="gk-shell-button flex items-center justify-center w-7 h-7 cursor-pointer opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                      style={{ color: t.textMuted, borderRadius: R - 4,
                        "--gk-shell-hover": t.inputBg } as React.CSSProperties}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showForm ? (
        <div className="flex flex-col gap-2 p-3" style={{ background: t.inputBg + "80", borderRadius: R - 1, border: `0.5px solid ${t.border}` }}>
          <span className="text-[11px] font-semibold" style={{ color: t.textMuted }}>
            {editingId ? tx("编辑身份") : tx("新增身份")}
          </span>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={tx("名称 (user.name)")}
            className="text-xs px-2.5 py-2 outline-none" style={inputStyle} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tx("邮箱 (user.email)")}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            className="text-xs px-2.5 py-2 outline-none font-mono" style={inputStyle} />
          <div className="flex items-center justify-end gap-2">
            <button {...press(reset)} className="px-3 py-1.5 text-xs cursor-pointer"
              style={{ color: t.textMuted, borderRadius: R - 3 }}>{tx("取消")}</button>
            <button {...(valid ? press(submit) : {})} disabled={!valid}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-pointer"
              style={{ background: valid ? t.accent : t.inputBg, color: valid ? "#fff" : t.textFaint,
                borderRadius: R - 3, opacity: valid ? 1 : 0.7, cursor: valid ? "pointer" : "not-allowed" }}>
              {editingId ? tx("保存") : tx("添加")}
            </button>
          </div>
        </div>
      ) : (
        <button {...press(startAdd)}
          className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium cursor-pointer transition-colors"
          style={{ color: t.textSec, borderRadius: R - 2, border: `0.5px dashed ${t.inputBorder}` }}
          onMouseEnter={(e) => { e.currentTarget.style.background = t.rowHover; e.currentTarget.style.color = t.text; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = t.textSec; }}>
          <UserPlus size={13} /> {tx("新增身份")}
        </button>
      )}
    </div>
  );
}

// GitLab integration settings and live personal access token metadata.
function RemoteConnSettings({ storageKey, title, desc, urlPlaceholder, tokenPlaceholder, hint, test }: {
  storageKey: string; title: string; desc: string;
  urlPlaceholder: string; tokenPlaceholder: string; hint: string;
  test: (url: string, token: string) => Promise<string>;
}) {
  const t = useTheme();
  const [saved, setSaved] = useState<RemoteConn>(() => loadConn(storageKey));
  const configured = saved.token.trim().length > 0;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(saved.url);
  const [token, setToken] = useState(saved.token);
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "err"; msg?: string }>({ kind: "idle" });
  const [info, setInfo] = useState<GitlabTokenInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const testRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setInfo(null); setInfoError(""); setLoading(false);
    if (!configured || editing) return;
    setLoading(true);
    gitlabTokenInfo(saved.url, saved.token).then(
      data => { if (!cancelled) { setInfo(data); setNow(Date.now()); } },
      error => { if (!cancelled) setInfoError(String(error)); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [saved, configured, editing, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { window.clearInterval(timer); testRequest.current++; };
  }, []);

  const validUrl = (() => {
    try {
      const parsed = new URL(url.trim());
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch { return false; }
  })();
  const canSave = validUrl && token.trim().length > 0;
  const canTest = canSave && status.kind !== "testing";
  const resetResult = () => {
    testRequest.current++;
    setStatus({ kind: "idle" }); setInfo(null); setInfoError(""); setLoading(false);
  };
  const runTest = async () => {
    if (!canTest) return;
    const request = ++testRequest.current;
    setStatus({ kind: "testing" }); setInfo(null); setInfoError(""); setLoading(true);
    const [connection, metadata] = await Promise.allSettled([
      test(url.trim(), token.trim()), gitlabTokenInfo(url.trim(), token.trim()),
    ]);
    if (request !== testRequest.current) return;
    setStatus(connection.status === "fulfilled"
      ? { kind: "ok", msg: tf("已连接：{0}", connection.value) }
      : { kind: "err", msg: String(connection.reason) });
    if (metadata.status === "fulfilled") { setInfo(metadata.value); setNow(Date.now()); }
    else setInfoError(String(metadata.reason));
    setLoading(false);
  };
  const beginEdit = () => { resetResult(); setUrl(saved.url); setToken(saved.token); setShowToken(false); setEditing(true); };
  const cancelEdit = () => { resetResult(); setUrl(saved.url); setToken(saved.token); setShowToken(false); setEditing(false); };
  const saveNow = () => {
    if (!canSave) return;
    const next = { url: url.trim().replace(/\/+$/, ""), token: token.trim() };
    saveConn(storageKey, next); setSaved(next); resetResult(); setShowToken(false); setEditing(false);
    toast.success(tx("GitLab 集成已保存"));
  };
  const removeNow = () => {
    saveConn(storageKey, { url: "", token: "" }); setSaved({ url: "", token: "" });
    setUrl(""); setToken(""); resetResult(); setShowToken(false); setEditing(false);
    toast.success(tx("已删除集成"));
  };

  const expiry = tokenExpiry(info, now);
  const inactive = info?.revoked || info?.active === false || expiry.expired;
  const stateLabel = loading ? tx("查询中") : info?.revoked ? tx("已撤销") : expiry.expired ? tx("已过期") : info?.active === false ? tx("不可用") : info?.active ? tx("有效") : tx("待确认");
  const stateColor = inactive ? t.red : info?.active ? t.green : t.textSec;
  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;
  const buttonStyle = { color: t.textSec, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;
  const metadata = (
    <div className="flex flex-col gap-4" aria-busy={loading}>
      <dl className="gk-token-summary grid grid-cols-3 gap-4 py-4" style={{ borderBottom: `0.5px solid ${t.border}` }}>
        {[
          { title: tx("Token 名称"), value: info?.name || (loading ? tx("读取中…") : tx("无法确认")), color: t.text },
          { title: tx("到期时间"), value: loading ? tx("读取中…") : tx(expiry.date), color: t.text },
          { title: tx("剩余有效期"), value: loading ? tx("读取中…") : inactive ? stateLabel : tx(expiry.label), color: inactive ? t.red : expiry.tone === "green" ? t.green : expiry.tone === "amber" ? t.amber : t.textSec },
        ].map(item => <div key={item.title} className="min-w-0 flex flex-col gap-1.5">
          <dt className="text-[11px]" style={{ color: t.textSec }}>{item.title}</dt>
          <dd className="text-xs font-medium break-words tabular-nums" style={{ color: item.color }}>{item.value}</dd>
        </div>)}
      </dl>
      {infoError && <div role="status" className="flex items-start gap-2 text-[11px] leading-relaxed" style={{ color: t.amber }}>
        <AlertTriangle size={14} className="shrink-0 mt-0.5" /><span>{infoError}</span>
      </div>}
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold" style={{ color: t.text }}>{tx("Token 权限")}</h3>
          <span className="text-[10px]" style={{ color: t.textSec }}>{tx("按令牌授权范围判断")}</span>
        </div>
        <div className="gk-token-grid grid grid-cols-3 gap-2">
          {GITLAB_CAPABILITIES.map(capability => {
            const permission = tokenCapability(info, capability, now);
            const granted = permission === "granted";
            const color = granted ? t.green : permission === "inactive" ? t.red : t.textSec;
            const Icon = granted ? Check : permission === "unknown" ? Minus : X;
            return <div key={capability.title} className="min-w-0 p-3 flex flex-col gap-2"
              style={{ border: `0.5px solid ${t.border}`, borderRadius: R - 3, background: t.bgPanel }}>
              <span className="text-[11px] font-medium" style={{ color: t.text }}>{tx(capability.title)}</span>
              <span className="flex items-center gap-1 text-[10px] font-medium" style={{ color }}>
                <Icon size={12} />{loading ? tx("查询中") : granted ? tx("已拥有") : permission === "denied" ? tx("未授权") : permission === "inactive" ? tx("令牌不可用") : tx("无法确认")}
              </span>
              <span className="text-[10px] leading-relaxed" style={{ color: t.textSec }}>{tx(capability.detail)}</span>
            </div>;
          })}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap text-[10px]" style={{ color: t.textSec }}>
          <span>{tx("原始 scopes")}</span>
          {info?.scopes?.length ? info.scopes.map(scope => <code key={scope} className="px-1.5 py-0.5 rounded break-all"
            style={{ color: t.text, background: t.inputBg }}>{scope}</code>) : <span>· {info?.granular ? tx("细粒度授权") : info?.scopes ? tx("无") : tx("无法确认")}</span>}
        </div>
        <p className="text-[10px] leading-relaxed" style={{ color: t.textSec }}>
          {info?.granular ? tx("此 Token 使用细粒度授权，请在 GitLab 中查看具体资源与权限。") : tx("以上为 Token 授权能力，实际操作仍受项目角色、保护分支及实例配置限制。")}
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{title}</span>
        <span className="text-[11px] leading-relaxed" style={{ color: t.textSec }}>{desc}</span>
      </div>
      {configured && !editing ? (
        <>
          <div className="flex flex-wrap items-center gap-3 p-4" style={{ borderRadius: R - 2, border: `0.5px solid ${t.border}`, background: t.bgPanel }}>
            <Cloud size={22} className="shrink-0" style={{ color: t.accent }} />
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold break-all" style={{ color: t.text }}>{hostOf(saved.url) || saved.url}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: stateColor, background: inactive ? t.redBg : info?.active ? t.greenBg : t.inputBg }}>{stateLabel}</span>
              </div>
              <span className="text-[11px] font-mono" style={{ color: t.textSec }}>••••••••{saved.token.length > 4 ? saved.token.slice(-4) : ""}</span>
            </div>
            <button {...press(beginEdit)} className="gk-conn-button flex items-center gap-1.5 px-3 py-2 text-[11px] cursor-pointer"
              style={{ ...buttonStyle, background: t.accentBg, color: t.accentFg, borderColor: `${t.accent}44` }}><Pencil size={12} />{tx("修改集成")}</button>
            <button {...press(removeNow)} title={tx("删除集成")} aria-label={tx("删除 GitLab 集成")}
              className="gk-conn-button p-2 cursor-pointer" style={{ color: t.textSec, borderRadius: R - 3 }}><Trash2 size={14} /></button>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold" style={{ color: t.text }}>{tx("令牌信息")}</h3>
              <button {...press(() => setRefresh(value => value + 1))} disabled={loading}
                className="gk-conn-button flex items-center gap-1.5 px-2 py-1 text-[11px] cursor-pointer disabled:opacity-50"
                style={{ color: t.textSec, borderRadius: R - 3 }}><RefreshCw size={12} className={loading ? "animate-spin" : undefined} />{tx("刷新信息")}</button>
            </div>
            {metadata}
          </div>
          <p className="text-[10px]" style={{ color: t.textSec }}>{tx("暂不支持多个集成，如需切换请修改或删除后重新填写。")}</p>
        </>
      ) : editing ? (
        <form onSubmit={event => { event.preventDefault(); saveNow(); }} className="flex flex-col gap-5 p-5"
          style={{ border: `0.5px solid ${t.border}`, borderRadius: R - 2, background: t.bgPanel }}>
          <div className="flex items-center gap-2" style={{ color: t.text }}><Pencil size={14} style={{ color: t.accent }} />
            <h3 className="text-xs font-semibold">{configured ? tx("修改集成") : tx("新增集成")}</h3>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="gitlab-instance" className="text-[11px] font-medium" style={{ color: t.text }}>{tx("实例地址")}</label>
            <input id="gitlab-instance" value={url} onChange={e => { setUrl(e.target.value); resetResult(); }} autoFocus
              placeholder={urlPlaceholder} autoComplete="url" spellCheck={false} aria-describedby="gitlab-url-hint"
              className="w-full text-xs px-3 py-2.5 outline-none font-mono" style={inputStyle} />
            <span id="gitlab-url-hint" className="text-[10px]" style={{ color: url.trim() && !validUrl ? t.amber : t.textSec }}>
              {url.trim() && !validUrl ? tx("请输入 http:// 或 https:// 开头的完整实例地址") : tx("填写 GitLab 实例根地址，可包含自建实例的子路径。")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="gitlab-token" className="text-[11px] font-medium" style={{ color: t.text }}>{tx("个人访问令牌")}</label>
            <div className="flex items-center pr-1" style={inputStyle}>
              <input id="gitlab-token" value={token} onChange={e => { setToken(e.target.value); resetResult(); }}
                type={showToken ? "text" : "password"} placeholder={tokenPlaceholder} autoComplete="off" spellCheck={false} aria-describedby="gitlab-token-hint"
                className="flex-1 min-w-0 text-xs px-3 py-2.5 outline-none font-mono bg-transparent" style={{ color: t.text }} />
              <button type="button" {...press(() => setShowToken(value => !value))} className="gk-conn-button p-2 cursor-pointer"
                style={{ color: t.textSec }} aria-label={showToken ? tx("隐藏令牌") : tx("显示令牌")} aria-pressed={showToken}>
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <span id="gitlab-token-hint" className="text-[10px] leading-relaxed" style={{ color: t.textSec }}>{hint}</span>
          </div>
          <div className="flex flex-col gap-2" aria-live="polite">
            {status.kind === "ok" || status.kind === "err" ? <span className="flex items-start gap-1.5 text-[11px] leading-relaxed"
              style={{ color: status.kind === "ok" ? t.green : t.red }}>
              {status.kind === "ok" ? <Check size={14} className="shrink-0 mt-0.5" /> : <AlertTriangle size={14} className="shrink-0 mt-0.5" />}{status.msg}
            </span> : <span className="text-[10px]" style={{ color: t.textSec }}>{loading ? tx("正在检测连接并读取令牌信息…") : tx("检测连接可预览当前令牌的有效期和权限。")}</span>}
          </div>
          <div className="flex items-center gap-2 pt-4" style={{ borderTop: `0.5px solid ${t.border}` }}>
            <button type="button" {...press(runTest)} disabled={!canTest} className="gk-conn-button flex items-center gap-1.5 px-3 py-2 text-[11px] cursor-pointer disabled:opacity-40" style={buttonStyle}>
              <RefreshCw size={12} className={status.kind === "testing" ? "animate-spin" : undefined} />{tx("检测连接")}</button>
            <div className="flex-1" />
            <button type="button" {...press(cancelEdit)} className="gk-conn-button px-3 py-2 text-[11px] cursor-pointer" style={{ color: t.textSec, borderRadius: R - 3 }}>{tx("取消")}</button>
            <button type="submit" {...press(saveNow)} disabled={!canSave} className="gk-conn-button px-4 py-2 text-[11px] font-medium cursor-pointer disabled:opacity-40"
              style={{ background: t.accent, color: "#fff", borderRadius: R - 3 }}>{tx("保存集成")}</button>
          </div>
          {(info || infoError) && metadata}
        </form>
      ) : (
        <button {...press(beginEdit)} className="gk-conn-button flex items-center justify-center gap-1.5 py-3 text-xs font-medium cursor-pointer"
          style={{ color: t.textSec, borderRadius: R - 2, border: `0.5px dashed ${t.inputBorder}` }}><Plus size={14} />{tx("新增集成")}</button>
      )}
    </div>
  );
}

// GitHub integration: multiple accounts (label + optional GHE url + token) so one
// person can push different projects under different identities. Push / PR flows
// pick the account matching the remote host; when several match, the app prompts.
// Persisted to localStorage, migrated from the legacy single connection.
function GithubTokenDetails({ info, loading, error, now }: {
  info: GithubTokenInfo | null; loading: boolean; error: string; now: number;
}) {
  const t = useTheme();
  const expiry = githubTokenExpiry(info, now);
  return <div className="flex flex-col gap-3" aria-busy={loading}>
    <dl className="grid grid-cols-3 gap-3 py-3" style={{ borderBottom: `0.5px solid ${t.border}` }}>
      {[
        { title: tx("认证账号"), value: info ? `@${info.login}` : tx("无法确认"), color: t.text },
        { title: tx("到期时间"), value: tx(expiry.date), color: t.text },
        { title: tx("剩余有效期"), value: tx(expiry.label), color: expiry.tone === "red" ? t.red : expiry.tone === "amber" ? t.amber : expiry.tone === "green" ? t.green : t.textSec },
      ].map(item => <div key={item.title} className="min-w-0 flex flex-col gap-1.5">
        <dt className="text-[10px]" style={{ color: t.textSec }}>{item.title}</dt>
        <dd className="text-[11px] font-medium break-words tabular-nums" style={{ color: item.color }}>{loading ? tx("读取中…") : item.value}</dd>
      </div>)}
    </dl>
    {error && <div role="status" className="flex items-start gap-2 text-[11px] leading-relaxed" style={{ color: t.amber }}>
      <AlertTriangle size={14} className="shrink-0 mt-0.5" /><span>{error}</span>
    </div>}
    {info && (info.scopes === null || !info.expires_at) && <p className="text-[10px] leading-relaxed" style={{ color: t.textSec }}>
      {info.scopes === null ? tx("GitHub 未返回此 Token 的完整权限，请在 GitHub 的令牌设置中核对。") : ""}
      {!info.expires_at ? tx("未返回到期时间，可能未设置有效期或实例不支持，无法据此确认永久有效。") : ""}
    </p>}
    <div className="flex items-baseline justify-between gap-2">
      <h4 className="text-xs font-semibold" style={{ color: t.text }}>{tx("Token 权限")}</h4>
      <span className="text-[10px]" style={{ color: t.textSec }}>{tx("按令牌授权范围判断")}</span>
    </div>
    <div className="gk-github-token-grid grid grid-cols-3 gap-2">
      {GITHUB_CAPABILITIES.map(capability => {
        const permission = githubCapability(info, capability.id, now);
        const color = permission === "granted" ? t.green : permission === "public" ? t.amber : permission === "inactive" ? t.red : t.textSec;
        const Icon = permission === "granted" || permission === "public" ? Check : permission === "unknown" ? Minus : X;
        return <div key={capability.id} title={tx(capability.detail)} className="min-w-0 px-3 py-2.5 flex flex-col gap-1.5"
          style={{ border: `0.5px solid ${t.border}`, borderRadius: R - 3, background: t.bgPanel }}>
          <span className="text-[11px] font-medium" style={{ color: t.text }}>{tx(capability.title)}</span>
          <span className="flex items-center gap-1 text-[10px] font-medium" style={{ color }}><Icon size={12} />
            {loading ? tx("查询中") : permission === "granted" ? tx("已拥有") : permission === "public" ? tx("仅公开仓库") : permission === "denied" ? tx("未授权") : permission === "inactive" ? tx("令牌已过期") : tx("无法确认")}
          </span>
        </div>;
      })}
    </div>
    <div className="flex items-center gap-1.5 flex-wrap text-[10px]" style={{ color: t.textSec }}>
      <span>{tx("原始 scopes")}</span>
      {info?.scopes?.length ? info.scopes.map(scope => <code key={scope} className="px-1.5 py-0.5 rounded break-all"
        style={{ color: t.text, background: t.inputBg }}>{scope}</code>) : <span>· {info?.scopes ? tx("无（仅公开信息）") : tx("未提供")}</span>}
    </div>
    <p className="text-[10px] leading-relaxed" style={{ color: t.textSec }}>{tx("实际操作仍受仓库角色、保护分支、组织 SSO 及令牌可访问的仓库范围限制。")}</p>
  </div>;
}

function GithubAccountsSettings() {
  const t = useTheme();
  const [accounts, setAccounts] = useState<GithubAccount[]>(loadGithubAccounts);
  const [selectedId, setSelectedId] = useState(() => accounts[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [draftInfo, setDraftInfo] = useState<GithubTokenInfo | null>(null);
  const [draftError, setDraftError] = useState("");
  const requestId = useRef(0);
  const [now, setNow] = useState(Date.now);
  const [refresh, setRefresh] = useState(0);
  type Inspection = { account: GithubAccount; loading: boolean; info: GithubTokenInfo | null; error: string };
  const [inspections, setInspections] = useState<Record<string, Inspection>>({});
  const showForm = adding || editingId !== null;
  const selected = accounts.find(account => account.id === selectedId) ?? accounts[0];
  const inspectionFor = (account: GithubAccount) => {
    const result = inspections[account.id];
    return result?.account.url === account.url && result.account.token === account.token ? result : undefined;
  };
  const current = selected ? inspectionFor(selected) : undefined;
  const busy = accounts.some(account => !inspectionFor(account) || inspectionFor(account)?.loading);
  const hostLabel = (account: GithubAccount) => account.url ? hostOf(account.url) : "github.com";
  const accountLabel = (account: GithubAccount) => account.label || hostLabel(account);

  useEffect(() => { saveGithubAccounts(accounts); }, [accounts]);
  useEffect(() => {
    let cancelled = false;
    setInspections(Object.fromEntries(accounts.map(account => [account.id, { account, loading: true, info: null, error: "" }])));
    let index = 0;
    // Bound concurrent requests; a slow or invalid account never blocks other results.
    const worker = async () => {
      while (!cancelled && index < accounts.length) {
        const account = accounts[index++];
        let result: Inspection;
        try { result = { account, loading: false, info: await githubTokenInfo(account.url, account.token), error: "" }; }
        catch (error) { result = { account, loading: false, info: null, error: String(error) }; }
        if (!cancelled) { setInspections(previous => ({ ...previous, [account.id]: result })); setNow(Date.now()); }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, accounts.length) }, worker));
    return () => { cancelled = true; };
  }, [accounts, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => { window.clearInterval(timer); requestId.current++; };
  }, []);

  const clearTest = () => { requestId.current++; setTesting(false); setDraftInfo(null); setDraftError(""); };
  const reset = () => { clearTest(); setLabel(""); setUrl(""); setToken(""); setEditingId(null); setAdding(false); setShowToken(false); };
  const valid = token.trim().length > 0 && validGithubUrl(url);
  const submit = () => {
    if (!valid) return;
    const id = editingId ?? `gh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next = { id, label: label.trim(), url: url.trim().replace(/\/+$/, ""), token: token.trim() };
    setAccounts(previous => editingId ? previous.map(account => account.id === editingId ? next : account) : [...previous, next]);
    setSelectedId(id); reset(); toast.success(editingId ? tx("GitHub 账号已保存") : tx("GitHub 账号已添加"));
  };
  const startAdd = () => { reset(); setAdding(true); };
  const startEdit = (account: GithubAccount) => {
    reset(); setSelectedId(account.id); setEditingId(account.id); setLabel(account.label); setUrl(account.url); setToken(account.token);
  };
  const remove = (id: string) => {
    setAccounts(previous => previous.filter(account => account.id !== id));
    for (const [path, accountId] of Object.entries(loadPrefMap(ACCOUNT_PREFS))) {
      if (accountId === id) deletePrefMapEntry(ACCOUNT_PREFS, path);
    }
    toast.success(tx("已删除 GitHub 账号"));
  };
  const runTest = async () => {
    if (!valid || testing) return;
    const request = ++requestId.current;
    setTesting(true); setDraftInfo(null); setDraftError("");
    try {
      const info = await githubTokenInfo(url.trim(), token.trim());
      if (request === requestId.current) { setDraftInfo(info); setNow(Date.now()); }
    } catch (error) { if (request === requestId.current) setDraftError(String(error)); }
    finally { if (request === requestId.current) setTesting(false); }
  };
  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;
  const buttonStyle = { color: t.textSec, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;

  return <div className="flex flex-col gap-4">
    <div className="flex flex-col gap-1.5">
      <h2 className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{tx("GitHub 集成")}</h2>
      <p className="text-[11px] leading-relaxed" style={{ color: t.textSec }}>{tx("按远程地址匹配账号；匹配到多个账号时选择使用，也可在「项目配置」中指定账号。")}</p>
    </div>
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold flex-1" style={{ color: t.text }}>{tx("已集成账号")} <span className="font-normal ml-1" style={{ color: t.textSec }}>{accounts.length}</span></h3>
        {accounts.length > 0 && <button {...press(() => setRefresh(value => value + 1))} disabled={busy || showForm}
          className="gk-conn-button flex items-center gap-1.5 px-2 py-1.5 text-[11px] cursor-pointer disabled:opacity-40"
          style={{ color: t.textSec, borderRadius: R - 3 }}><RefreshCw size={12} className={busy ? "animate-spin" : undefined} />{tx("刷新全部")}</button>}
        <button {...press(startAdd)} disabled={showForm} className="gk-conn-button flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] cursor-pointer disabled:opacity-40"
          style={{ ...buttonStyle, color: t.accentFg, background: t.accentBg, borderColor: `${t.accent}44` }}><UserPlus size={12} />{tx("新增账号")}</button>
      </div>
      {accounts.length === 0 ? <div className="py-8 text-center text-[11px]" style={{ color: t.textSec, border: `0.5px dashed ${t.inputBorder}`, borderRadius: R - 2 }}>{tx("还没有账号，添加 GitHub.com 或 Enterprise 账号开始使用。")}</div> :
        <div className="gk-github-accounts flex flex-col gap-1.5 max-h-[190px] overflow-y-auto overscroll-contain p-0.5 -m-0.5" aria-label={tx("已集成 GitHub 账号")}>
          {accounts.map(account => {
            const result = inspectionFor(account);
            const expiry = githubTokenExpiry(result?.info ?? null, now);
            const active = selected?.id === account.id;
            const loading = !result || result.loading;
            const stateText = loading ? tx("查询中…") : result.error ? tx("连接异常") : expiry.expired ? tx("已过期") : tf("已验证 · {0}", tx(expiry.label));
            const color = result?.error || expiry.expired ? t.red : expiry.tone === "amber" ? t.amber : result?.info ? t.green : t.textSec;
            return <div key={account.id} className="flex items-center gap-1 px-2 py-1.5"
              style={{ border: `0.5px solid ${active ? `${t.accent}66` : t.border}`, borderRadius: R - 2, background: active ? t.accentBg : t.bgPanel }}>
              <button {...press(() => setSelectedId(account.id))} disabled={showForm} aria-pressed={active} aria-controls="github-account-detail"
                aria-label={tf("查看账号 {0}", accountLabel(account))} className="flex items-center gap-2.5 min-w-0 flex-1 text-left px-1 py-1 cursor-pointer disabled:cursor-default"
                style={{ borderRadius: R - 3 }}>
                <Github size={17} className="shrink-0" style={{ color: active ? t.accent : t.textSec }} />
                <span className="min-w-0 flex-1 flex flex-col gap-1">
                  <span className="text-[11px] font-semibold truncate" style={{ color: t.text }}>{accountLabel(account)}{result?.info && <span className="font-normal ml-2" style={{ color: t.textSec }}>@{result.info.login}</span>}</span>
                  <span className="text-[10px] truncate" style={{ color: t.textSec }}>{hostLabel(account)} · <span className="font-mono">••••{account.token.length > 4 ? account.token.slice(-4) : ""}</span></span>
                </span>
                <span className="text-[10px] shrink-0 tabular-nums" style={{ color }}>{stateText}</span>
                <ChevronRight size={12} className="shrink-0" style={{ color: active ? t.accent : t.textSec }} />
              </button>
              <button {...press(() => startEdit(account))} disabled={showForm} aria-label={tf("修改账号 {0}", accountLabel(account))} title={tx("修改账号")}
                className="gk-conn-button p-2 cursor-pointer disabled:opacity-40" style={{ color: t.textSec, borderRadius: R - 3 }}><Pencil size={12} /></button>
              <button {...press(() => remove(account.id))} disabled={showForm} aria-label={tf("删除账号 {0}", accountLabel(account))} title={tx("删除账号")}
                className="gk-conn-button p-2 cursor-pointer disabled:opacity-40" style={{ color: t.textSec, borderRadius: R - 3 }}><Trash2 size={12} /></button>
            </div>;
          })}
        </div>}
    </div>
    {showForm ? <form onSubmit={event => { event.preventDefault(); submit(); }} className="flex flex-col gap-4 p-4"
      style={{ border: `0.5px solid ${t.border}`, borderRadius: R - 2, background: t.bgPanel }}>
      <h3 className="flex items-center gap-2 text-xs font-semibold" style={{ color: t.text }}><Pencil size={14} style={{ color: t.accent }} />{editingId ? tx("修改账号") : tx("新增账号")}</h3>
      <div className="flex flex-col gap-2">
        <label htmlFor="github-label" className="text-[11px] font-medium" style={{ color: t.text }}>{tx("账号备注")} <span style={{ color: t.textSec }}>{tx("（选填）")}</span></label>
        <input id="github-label" value={label} autoFocus onChange={event => setLabel(event.target.value)} placeholder={tx("例如：工作账号、个人账号")}
          className="w-full text-xs px-3 py-2.5 outline-none" style={inputStyle} />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="github-instance" className="text-[11px] font-medium" style={{ color: t.text }}>{tx("实例地址")} <span style={{ color: t.textSec }}>{tx("（GitHub.com 留空）")}</span></label>
        <input id="github-instance" value={url} onChange={event => { setUrl(event.target.value); clearTest(); }}
          placeholder="Enterprise：https://ghe.example.com" autoComplete="url" spellCheck={false} aria-describedby="github-url-hint"
          className="w-full text-xs px-3 py-2.5 outline-none font-mono" style={inputStyle} />
        <span id="github-url-hint" className="text-[10px]" style={{ color: validGithubUrl(url) ? t.textSec : t.amber }}>{validGithubUrl(url) ? tx("企业版填写实例根地址，账号只会匹配对应主机的仓库。") : tx("请输入完整实例根地址；GitHub.com 可直接留空。")}</span>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="github-token" className="text-[11px] font-medium" style={{ color: t.text }}>{tx("个人访问令牌")}</label>
        <div className="flex items-center pr-1" style={inputStyle}>
          <input id="github-token" value={token} onChange={event => { setToken(event.target.value); clearTest(); }}
            type={showToken ? "text" : "password"} placeholder="ghp_… / github_pat_…" autoComplete="off" spellCheck={false} aria-describedby="github-token-hint"
            className="flex-1 min-w-0 text-xs px-3 py-2.5 outline-none font-mono bg-transparent" style={{ color: t.text }} />
          <button type="button" {...press(() => setShowToken(value => !value))} aria-label={showToken ? tx("隐藏令牌") : tx("显示令牌")} aria-pressed={showToken}
            className="gk-conn-button p-2 cursor-pointer" style={{ color: t.textSec }}>{showToken ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </div>
        <span id="github-token-hint" className="text-[10px] leading-relaxed" style={{ color: t.textSec }}>{tx("Classic Token 的私有仓库操作需要 repo；细粒度 Token 需选择仓库并授予 Contents / Pull requests 等对应权限。令牌保存在本机。")}</span>
      </div>
      <div className="text-[11px] leading-relaxed" aria-live="polite" style={{ color: draftInfo ? t.green : t.textSec }}>
        {testing ? tx("正在检测账号并读取 Token 信息…") : draftInfo ? tf("已连接：{0}(@{1})", draftInfo.name ? `${draftInfo.name} ` : "", draftInfo.login) : tx("检测连接可预览当前账号、有效期和权限。")}
      </div>
      {draftError && <p role="alert" className="text-[11px] leading-relaxed" style={{ color: t.red }}>{draftError}</p>}
      <div className="flex items-center gap-2 pt-3" style={{ borderTop: `0.5px solid ${t.border}` }}>
        <button type="button" {...press(runTest)} disabled={!valid || testing} className="gk-conn-button flex items-center gap-1.5 px-3 py-2 text-[11px] cursor-pointer disabled:opacity-40" style={buttonStyle}>
          <RefreshCw size={12} className={testing ? "animate-spin" : undefined} />{tx("检测连接")}</button>
        <div className="flex-1" />
        <button type="button" {...press(reset)} className="gk-conn-button px-3 py-2 text-[11px] cursor-pointer" style={{ color: t.textSec, borderRadius: R - 3 }}>{tx("取消")}</button>
        <button type="submit" {...press(submit)} disabled={!valid} className="gk-conn-button px-4 py-2 text-[11px] font-medium cursor-pointer disabled:opacity-40"
          style={{ background: t.accent, color: "#fff", borderRadius: R - 3 }}>{editingId ? tx("保存账号") : tx("添加账号")}</button>
      </div>
      {draftInfo && <GithubTokenDetails info={draftInfo} loading={false} error="" now={now} />}
    </form> : selected ? <section id="github-account-detail" aria-labelledby="github-detail-title" className="flex flex-col gap-1 pt-3" style={{ borderTop: `0.5px solid ${t.border}` }}>
      <div className="flex items-center justify-between gap-2">
        <h3 id="github-detail-title" className="text-xs font-semibold min-w-0 truncate" style={{ color: t.text }}>{tx("账号详情 ·")} {accountLabel(selected)}</h3>
        {current?.info && <span className="text-[10px] shrink-0 px-1.5 py-0.5 rounded" style={{ background: t.inputBg, color: t.textSec }}>{tx(GITHUB_TOKEN_KINDS[current.info.token_kind])}</span>}
      </div>
      <GithubTokenDetails info={current?.info ?? null} loading={!current || current.loading} error={current?.error ?? ""} now={now} />
    </section> : null}
  </div>;
}

// Second-level pane: theme palette and mode.
function AppearanceSettings({ paletteId, setPaletteId, themeMode, setThemeMode }: {
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
        <span className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{tx("主题配色")}</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          {tx("选择配色方案与明暗模式。跟随系统时按 macOS 外观自动切换亮/暗。")}
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
              <Icon size={13} /> {tx(label)}
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
                <span className="text-xs font-semibold" style={{ color: preview.text }}>{tx(pal.label)}</span>
                {active && <Check size={13} style={{ color: preview.accent }} />}
              </div>
              <div className="flex gap-1.5">
                {[preview.accent, preview.accent2, preview.accent3].map((c, i) => (
                  <span key={i} className="flex-1" style={{ height: 20, borderRadius: 5, background: c }} />
                ))}
              </div>
              <span className="text-[10px]" style={{ color: preview.textMuted }}>
                {previewDark ? tx("暗色预览") : tx("亮色预览")}
              </span>
            </button>
          );
        })}
      </div>

    </div>
  );
}

function LanguageSettings({ language, onChange }: { language: Language; onChange: (language: Language) => void }) {
  const t = useTheme();
  const options: { id: Language; label: string; nativeLabel: string }[] = [
    { id: "zh-CN", label: "简体中文", nativeLabel: "Chinese (Simplified)" },
    { id: "en", label: "English", nativeLabel: "英语" },
  ];
  return (
    <section className="flex flex-col gap-4" aria-label={tx("语言")}>
      <div className="flex flex-col gap-1">
        <h2 className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{tx("界面语言")}</h2>
        <p className="text-[11px] leading-relaxed" style={{ color: t.textMuted }}>
          {tx("语言设置会立即生效。进度表示已翻译的静态界面文案比例；尚未翻译的内容仍显示中文。")}
        </p>
      </div>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label={tx("界面语言")}>
        {options.map((option) => {
          const active = language === option.id;
          const progress = languageProgress(option.id);
          return (
            <button key={option.id} type="button" role="radio" aria-checked={active}
              onClick={() => onChange(option.id)}
              className="flex items-center gap-3 w-full px-4 py-3 text-left cursor-pointer transition-colors"
              style={{ border: `1px solid ${active ? t.accent : t.border}`,
                background: active ? t.accentBg : t.inputBg, borderRadius: R }}>
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="text-xs font-semibold" style={{ color: t.text }}>{option.label} ({progress}%)</span>
                <span className="text-[11px]" style={{ color: t.textMuted }}>{option.nativeLabel}</span>
              </span>
              {active && <Check size={15} aria-hidden="true" style={{ color: t.accent }} />}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Second-level pane: the scheduled daily check for new upstream commits across
// every open project. Native code owns the scheduler; this pane edits settings
// or requests an immediate run.
function DailyCheckSettings({ cfg, setCfg, onRunNow, busy, progress, projectCount }: {
  cfg: DailyCheck; setCfg: (c: DailyCheck) => void;
  onRunNow: () => void; busy: boolean; progress: CheckProgress | null; projectCount: number;
}) {
  const t = useTheme();
  const inputStyle = { background: t.inputBg, color: t.text, border: `0.5px solid ${t.inputBorder}`, borderRadius: R - 3 } as const;
  const nextRun = busy && progress
    ? (progress.paused ? tx("休眠已中断检查，恢复后自动补查") : tf("已检查 {0}/{1} · 正在检查 {2}", progress.current, progress.total, progress.project))
    : nextCheckLabel(cfg, new Date(), getLanguage());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="gk-heading text-base font-semibold" style={{ color: t.text }}>{tx("定时检查更新")}</span>
        <span className="text-xs leading-relaxed max-w-[62ch]" style={{ color: t.textMuted }}>
          {tx("按设定时间在后台检查已打开项目。发现更新或检查失败时，前台显示汇总，后台通过 Dock 图标或任务栏提醒。")}
        </span>
      </div>

      <div className="flex flex-col overflow-hidden"
        style={{ borderRadius: R, border: `0.5px solid ${t.inputBorder}`, background: t.dialogBg }}>
        <div className="flex items-center gap-4 px-4 py-3.5">
          <div className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className="text-[13px] font-semibold" style={{ color: t.text }}>{tx("自动检查")}</span>
            <span className="text-xs" style={{ color: t.textMuted }}>{tx("到达设定时间后在后台检查全部项目")}</span>
          </div>
          <button {...press(() => setCfg({ ...cfg, enabled: !cfg.enabled }))}
            role="switch" aria-checked={cfg.enabled} aria-label={tx("自动检查更新")}
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
            <span className="text-[13px] font-medium" style={{ color: t.text }}>{tx("每天检查时间")}</span>
            <span className="text-xs truncate" style={{ color: busy ? t.accentFg : t.textMuted }}>
              {nextRun ?? tx("开启后按设定时间执行")}
            </span>
          </div>
          <label className="sr-only" htmlFor="daily-check-time">{tx("每天检查时间")}</label>
          <input id="daily-check-time" name="dailyCheckTime" type="time" value={cfg.time}
            disabled={!cfg.enabled || busy}
            onChange={(e) => setCfg({ ...cfg, time: e.target.value || DAILY_CHECK_DEFAULT.time })}
            className="text-xs px-2.5 py-2 outline-none font-mono tabular-nums flex-shrink-0"
            style={{ ...inputStyle, cursor: cfg.enabled && !busy ? "text" : "not-allowed" }} />
        </div>
      </div>

      <label className="flex items-center gap-3 px-1 cursor-pointer" style={{ opacity: cfg.enabled ? 1 : 0.52 }}>
        <input type="checkbox" checked={cfg.skipWeekends} disabled={!cfg.enabled || busy}
          onChange={(e) => setCfg({ ...cfg, skipWeekends: e.target.checked })}
          className="w-4 h-4 flex-shrink-0" style={{ accentColor: t.accent }} />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium" style={{ color: t.text }}>{tx("跳过周末")}</span>
          <span className="text-xs" style={{ color: t.textMuted }}>{tx("周六、周日不自动检查，仍可手动检查")}</span>
        </span>
      </label>
      <p className="text-xs leading-relaxed" style={{ color: t.textMuted }}>
        {tx("电脑休眠期间暂停检查，不会唤醒电脑；当天恢复或重新启动软件后补查未完成的任务。当天已完成则不重复检查。")}
      </p>

      <div className="flex items-center gap-3 min-h-9">
        <span className="text-xs min-w-0 flex-1" style={{ color: t.textMuted }}>
          {projectCount === 0 ? tx("还没有打开任何项目")
            : cfg.lastRun ? tf("上次检查：{0} · 共 {1} 个项目", formatFullDate(new Date(cfg.lastRun).toISOString()), projectCount)
            : tf("将检查顶部已打开的 {0} 个项目", projectCount)}
        </span>
        <button {...(busy || projectCount === 0 ? {} : press(onRunNow))} disabled={busy || projectCount === 0}
          className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium flex-shrink-0"
          style={{ background: busy ? t.inputBg : t.accentBg, color: busy ? t.textFaint : t.accentFg,
            border: `0.5px solid ${busy ? t.inputBorder : t.accent + "55"}`, borderRadius: R - 3,
            cursor: busy || projectCount === 0 ? "not-allowed" : "pointer", opacity: projectCount === 0 ? 0.55 : 1 }}>
          <RefreshCw size={12} aria-hidden="true" className={busy ? "animate-spin" : undefined} />
          {busy ? tx("检查中") : tx("立即检查")}
        </button>
      </div>

      <div className="flex items-start gap-2.5 px-3 py-2.5 text-xs leading-relaxed"
        style={{ color: t.textMuted, background: t.inputBg, borderRadius: R - 2 }}>
        <Check size={13} className="flex-shrink-0 mt-0.5" style={{ color: t.green }} />
        {tx("检查阶段只更新远程跟踪分支。统一拉取仅执行安全快进，分叉分支和有未提交更改的当前分支会保留原状。")}
      </div>
    </div>
  );
}

// Second-level pane: current version + in-app update check (download / verify /
// install / relaunch), split out from appearance into its own section.
function UpdateSettings() {
  const t = useTheme();
  const [version, setVersion] = useState<string>("");
  const statusShellRef = useRef<HTMLDivElement>(null);
  const statusContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { getAppVersion().then(setVersion).catch(() => {}); }, []);

  type UpState =
    | { kind: "idle" | "checking" | "uptodate" }
    | { kind: "avail"; version: string; notes?: string; install: (p?: (n: number) => void) => Promise<void> }
    | { kind: "downloading"; version: string; pct: number }
    | { kind: "err"; stage: "check" | "install"; msg: string };
  const [up, setUp] = useState<UpState>({ kind: "idle" });
  const busy = up.kind === "checking" || up.kind === "downloading";
  const downloadPct = up.kind === "downloading"
    ? Math.max(0, Math.min(100, Math.round(up.pct * 100)))
    : null;
  const statusLayoutKey = up.kind === "avail"
    ? `${up.kind}:${up.version}:${up.notes ?? ""}`
    : up.kind === "downloading" ? `${up.kind}:${downloadPct === 100}` : up.kind;

  useLayoutEffect(() => {
    const shell = statusShellRef.current;
    const content = statusContentRef.current;
    if (!shell || !content) return;
    const currentHeight = shell.getBoundingClientRect().height;
    const nextHeight = up.kind === "idle" ? 0 : content.scrollHeight;
    shell.style.height = `${currentHeight}px`;
    const frame = requestAnimationFrame(() => { shell.style.height = `${nextHeight}px`; });
    return () => cancelAnimationFrame(frame);
  }, [statusLayoutKey]);

  const check = async () => {
    setUp({ kind: "checking" });
    try {
      const u = await checkForUpdate();
      if (!u) { setUp({ kind: "uptodate" }); return; }
      setUp({ kind: "avail", version: u.version, notes: u.notes, install: u.install });
    } catch (e) {
      setUp({ kind: "err", stage: "check", msg: String(e) });
    }
  };
  const install = async () => {
    if (up.kind !== "avail") return;
    const doInstall = up.install;
    const nextVersion = up.version;
    setUp({ kind: "downloading", version: nextVersion, pct: 0 });
    try {
      await doInstall((p) => setUp({ kind: "downloading", version: nextVersion, pct: p }));
    } catch (e) {
      setUp({ kind: "err", stage: "install", msg: String(e) });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="gk-heading text-base font-semibold" style={{ color: t.text }}>{tx("软件更新")}</span>
        <span className="text-xs leading-relaxed" style={{ color: t.textMuted }}>
          {tx("从发布服务器检查新版本。更新包经签名校验后下载、安装并重启。")}
        </span>
      </div>

      <section className="gk-update-card overflow-hidden"
        aria-label={tx("GitKit 软件更新")}
        style={{ borderRadius: R, border: `0.5px solid ${t.inputBorder}`, background: t.dialogBg }}>
        <div className="flex items-center gap-3.5 px-4 py-4">
          <div className="flex items-center justify-center flex-shrink-0"
            style={{ width: 44, height: 44, borderRadius: R, background: t.accentBg }}>
            <GitBranch size={20} aria-hidden="true" style={{ color: t.accent }} />
          </div>
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <span className="gk-heading text-sm font-semibold" style={{ color: t.text }}>GitKit</span>
            <span className="text-xs" style={{ color: t.textMuted }}>
              {version ? <>{tx("已安装")} <span className="font-mono tabular-nums">v{version}</span></> : tx("正在读取当前版本…")}
            </span>
          </div>
          <button {...(busy ? {} : press(check))} disabled={busy} aria-busy={up.kind === "checking" || undefined}
            data-running={up.kind === "checking" || undefined}
            className="gk-update-check flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium flex-shrink-0"
            style={{ background: t.accent, color: "#fff", borderRadius: R - 3,
              cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.76 : 1 }}>
            <RefreshCw size={12} aria-hidden="true" className="gk-update-check-icon" />
            {up.kind === "checking" ? tx("检查中…") : up.kind === "idle" ? tx("检查更新") : tx("重新检查")}
          </button>
        </div>

        <div ref={statusShellRef} className="gk-update-state-shell" aria-live="polite"
          aria-hidden={up.kind === "idle"}
          data-open={up.kind !== "idle" || undefined}
          style={{ boxShadow: up.kind === "idle" ? "none" : `inset 0 0.5px ${t.border}`,
            background: up.kind === "uptodate" ? t.greenBg
              : up.kind === "avail" ? t.accentBg
                : up.kind === "err" ? t.redBg : t.inputBg }}>
          <div ref={statusContentRef} className={up.kind === "idle" ? "" : "px-4 py-3.5"}>
            {up.kind !== "idle" && <div key={up.kind} className="gk-update-state">
            {up.kind === "checking" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2.5">
                  <RefreshCw size={14} aria-hidden="true" className="gk-update-check-icon flex-shrink-0"
                    style={{ color: t.accent }} />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-semibold" style={{ color: t.text }}>{tx("正在检查新版本")}</span>
                    <span className="text-[11px]" style={{ color: t.textMuted }}>{tx("正在连接发布服务器…")}</span>
                  </div>
                </div>
                <div className="gk-update-progress" data-indeterminate="true" aria-hidden="true"
                  style={{ "--gk-update-accent": t.accent, "--gk-update-track": t.inputBorder } as React.CSSProperties}>
                  <span />
                </div>
              </div>
            )}

            {up.kind === "uptodate" && (
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0"
                  style={{ background: t.green + "22", color: t.green }}>
                  <Check size={14} aria-hidden="true" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-semibold" style={{ color: t.text }}>{tx("已是最新版本")}</span>
                  <span className="text-[11px]" style={{ color: t.textMuted }}>{tx("当前无需更新，可以继续使用。")}</span>
                </div>
              </div>
            )}

            {up.kind === "avail" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex items-center justify-center w-8 h-8 flex-shrink-0"
                    style={{ borderRadius: R - 3, background: t.accent + "1F", color: t.accent }}>
                    <DownloadCloud size={16} aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span className="text-xs font-semibold" style={{ color: t.text }}>{tx("发现新版本 v")}{up.version}</span>
                    <span className="text-[11px]" style={{ color: t.textMuted }}>
                      {version ? `v${version} → v${up.version}` : tf("准备更新到 v{0}", up.version)}
                    </span>
                  </div>
                  <button {...press(install)}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium cursor-pointer flex-shrink-0"
                    style={{ background: t.accent, color: "#fff", borderRadius: R - 3 }}>
                    <Download size={12} aria-hidden="true" /> {tx("下载并安装")}
                  </button>
                </div>
                {up.notes && (
                  <div className="pt-3" style={{ borderTop: `0.5px solid ${t.border}` }}>
                    <div className="text-[10px] font-semibold mb-1.5" style={{ color: t.textSec }}>{tx("更新内容")}</div>
                    <div className="text-[11px] leading-relaxed whitespace-pre-wrap overflow-auto"
                      style={{ color: t.textMuted, maxHeight: 144 }}>
                      {up.notes}
                    </div>
                  </div>
                )}
              </div>
            )}

            {up.kind === "downloading" && downloadPct != null && (
              <div className="flex flex-col gap-3" role="progressbar" aria-label={tf("正在下载 GitKit v{0}", up.version)}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadPct}>
                <div className="flex items-start gap-2.5">
                  <DownloadCloud size={15} aria-hidden="true" className="flex-shrink-0 mt-0.5" style={{ color: t.accent }} />
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <span className="text-xs font-semibold" style={{ color: t.text }}>
                      {downloadPct >= 100 ? tf("正在验证并安装 v{0}", up.version) : tf("正在下载 v{0}", up.version)}
                    </span>
                    <span className="text-[11px]" style={{ color: t.textMuted }}>
                      {downloadPct >= 100 ? tx("更新包已下载，正在完成安装。") : tx("安装完成后 GitKit 将自动重启。")}
                    </span>
                  </div>
                  <span className="text-xs font-mono font-semibold tabular-nums flex-shrink-0" style={{ color: t.accentFg }}>
                    {downloadPct}%
                  </span>
                </div>
                <div className="gk-update-progress"
                  style={{ "--gk-update-accent": t.accent, "--gk-update-track": t.inputBorder } as React.CSSProperties}>
                  <span style={{ clipPath: `inset(0 ${100 - downloadPct}% 0 0 round 999px)` }} />
                </div>
              </div>
            )}

            {up.kind === "err" && (
              <div className="flex items-start gap-2.5 min-w-0">
                <span className="flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0"
                  style={{ background: t.red + "22", color: t.red }}>
                  <AlertTriangle size={14} aria-hidden="true" />
                </span>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-xs font-semibold" style={{ color: t.text }}>
                    {up.stage === "install" ? tx("更新未完成") : tx("检查更新失败")}
                  </span>
                  <span className="text-[11px] leading-relaxed break-words" style={{ color: t.red }}>{up.msg}</span>
                  <span className="text-[11px]" style={{ color: t.textMuted }}>{tx("请检查网络后重新尝试。")}</span>
                </div>
              </div>
            )}
            </div>}
          </div>
        </div>
      </section>
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
    catch (e) { toast.error(tf("检测失败：{0}", e)); }
    finally { setChecking(false); }
  };
  useEffect(() => { run(); }, []); // auto-check on open

  const meta: Record<string, { label: string; hint: string }> = {
    git: { label: "Git", hint: tx("核心依赖。macOS 装 Xcode Command Line Tools 或 Homebrew 即可获得。") },
    "git-lfs": { label: "Git LFS", hint: tx("许多仓库用它管理大文件。未安装时 checkout/push 的 LFS 钩子会报错。安装：brew install git-lfs && git lfs install") },
    ksdiff: { label: "Kaleidoscope", hint: tx("可选。遴选/合并冲突时用它图形化解决。安装 Kaleidoscope.app 后，在其菜单执行「Integrations → Install ksdiff」即可。") },
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{tx("环境依赖")}</span>
          <span className="text-[11px]" style={{ color: t.textFaint }}>
            {tx("检测 GitKit 调用的命令行工具是否在应用可见的 PATH 上。")}
          </span>
        </div>
        <button {...(checking ? {} : press(run))} disabled={checking}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium flex-shrink-0"
          style={{ background: t.accent, color: "#fff", borderRadius: R - 3,
            cursor: checking ? "not-allowed" : "pointer", opacity: checking ? 0.6 : 1 }}>
          <RefreshCw size={12} className={checking ? "animate-spin" : undefined} /> {tx("重新检测")}
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
                  {d.found ? tx("已安装") : tx("未找到")}
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
          <div className="text-[11px] px-1 py-4 text-center" style={{ color: t.textFaint }}>{tx("检测中…")}</div>
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
    if (!a) return tx("账号已删除");
    return a.label || (a.url ? hostOf(a.url) : "github.com");
  };
  const identityLabel = (id: string | undefined) => {
    if (id === undefined) return null;
    if (id === "") return tx("仓库 / 全局 Git 配置");
    const i = identities.find((x) => x.id === id);
    return i ? `${i.name} <${i.email}>` : tx("身份已删除");
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
        <span className="gk-heading text-sm font-semibold" style={{ color: t.text }}>{tx("已保存的项目配置")}</span>
        <span className="text-[11px]" style={{ color: t.textFaint }}>
          {tx("这里是各个项目记住的选择：推送 / 拉取使用的 GitHub 账号,以及提交时使用的身份。删除后该项目会恢复为每次询问 / 使用默认身份。")}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {rows.length === 0 && (
          <div className="text-[11px] px-1 py-6 text-center" style={{ color: t.textFaint }}>
            {tx("还没有保存的项目配置。在账号选择弹窗中勾选「记住本项目的选择」即可保存")}
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
                  {acc && chip("GitHub", acc, acc === tx("账号已删除"))}
                  {ident && chip(tx("提交者"), ident, ident === tx("身份已删除"))}
                </div>
              </div>
              <button {...press(() => clear(r.path))} title={tx("删除该项目的保存配置")}
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
          <Trash2 size={12} />{tx("清空全部")}
        </button>
      )}
    </div>
  );
}

function SettingsDialog({ identities, setIdentities, defaultId, setDefaultId,
  paletteId, setPaletteId, themeMode, setThemeMode, language, setLanguage, dailyCheck, setDailyCheck,
  onRunCheckNow, checkBusy, checkProgress, projectCount, onClose }: {
  identities: Identity[]; setIdentities: React.Dispatch<React.SetStateAction<Identity[]>>;
  defaultId: string; setDefaultId: (id: string) => void;
  paletteId: PaletteId; setPaletteId: (id: PaletteId) => void;
  themeMode: ThemeMode; setThemeMode: (m: ThemeMode) => void;
  language: Language; setLanguage: (language: Language) => void;
  dailyCheck: DailyCheck; setDailyCheck: (c: DailyCheck) => void;
  onRunCheckNow: () => void; checkBusy: boolean; checkProgress: CheckProgress | null; projectCount: number;
  onClose: () => void;
}) {
  const t = useTheme();
  const MENU = [
    { group: tx("账户"), key: "identity",   label: tx("提交者身份"), Icon: Users },
    { group: tx("账户"), key: "gitlab",     label: tx("GitLab 集成"), Icon: Cloud },
    { group: tx("账户"), key: "github",     label: tx("GitHub 集成"), Icon: Github },
    { group: tx("工作区"), key: "projects",   label: tx("项目配置"), Icon: FolderGit2 },
    { group: tx("工作区"), key: "daily",      label: tx("定时检查"), Icon: RefreshCw },
    { group: tx("偏好"), key: "appearance", label: tx("外观"), Icon: Sparkles },
    { group: tx("偏好"), key: "language", label: tx("语言"), Icon: Languages },
    { group: tx("系统"), key: "update",     label: tx("软件更新"), Icon: DownloadCloud },
    { group: tx("系统"), key: "deps",       label: tx("环境依赖"), Icon: TerminalSquare },
  ] as const;
  const [section, setSection] = useState<(typeof MENU)[number]["key"]>("identity");
  const [closing, setClosing] = useState(false);
  const requestClose = () => setClosing(true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setClosing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, pointerEvents: closing ? "none" : undefined }}>
      <div className={`absolute inset-0 ${closing ? "gk-overlay-out" : "gk-overlay-in"}`}
        style={{ background: "rgba(0,0,0,0.45)" }} {...press(requestClose)} />
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title"
        className={`relative flex flex-col ${closing ? "gk-modal-out" : "gk-modal-in"}`}
        onAnimationEnd={(event) => {
          if (closing && event.currentTarget === event.target) onClose();
        }}
        style={{ width: "min(900px, calc(100vw - 48px))",
        height: "min(720px, calc(100vh - 48px))",
        background: t.dialogBg,
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R + 2, boxShadow: t.shadowWindow, overflow: "hidden" }}>
        <div className="flex-shrink-0 flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: `0.5px solid ${t.border}` }}>
          <Settings size={15} style={{ color: t.accent }} />
          <span id="settings-title" className="gk-heading text-sm font-semibold flex-1" style={{ color: t.text }}>{tx("设置")}</span>
          <button {...press(requestClose)}
            aria-label={tx("关闭设置")} title={tx("关闭")}
            className="flex items-center justify-center w-7 h-7 cursor-pointer" style={{ color: t.textMuted, borderRadius: R - 3 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = t.inputBg)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* First-level menu */}
          <nav aria-label={tx("设置分类")} className="flex-shrink-0 flex flex-col py-2.5 px-2 overflow-y-auto"
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
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 overscroll-contain">
            {section === "identity" && (
              <IdentitySettings identities={identities} setIdentities={setIdentities}
                defaultId={defaultId} setDefaultId={setDefaultId} />
            )}
            {section === "gitlab" && (
              <RemoteConnSettings storageKey="gitkit.gitlab" title={tx("自建 GitLab 集成")}
                desc={tx("填入自建 GitLab 实例地址与个人访问令牌 (Personal Access Token),用于列项目、创建合并请求、推送认证。")}
                urlPlaceholder="https://gitlab.example.com" tokenPlaceholder="glpat-…"
                hint={tx("api 可用于创建 MR 与推送；仅拉取可用 read_repository，仅推送可用 write_repository。令牌保存在本机。")}
                test={gitlabTest} />
            )}
            {section === "github" && <GithubAccountsSettings />}
            {section === "projects" && <ProjectPrefsSettings identities={identities} />}
            {section === "daily" && (
              <DailyCheckSettings cfg={dailyCheck} setCfg={setDailyCheck}
                onRunNow={onRunCheckNow} busy={checkBusy} progress={checkProgress} projectCount={projectCount} />
            )}
            {section === "appearance" && (
              <AppearanceSettings paletteId={paletteId} setPaletteId={setPaletteId}
                themeMode={themeMode} setThemeMode={setThemeMode} />
            )}
            {section === "language" && <LanguageSettings language={language} onChange={setLanguage} />}
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
    <Modal title={rows.some((r) => !r.error) ? tx("远程有新的提交") : tx("部分项目检查失败")} Icon={DownloadCloud} onClose={busy ? () => {} : onClose} width={560}
      footer={
        <>
          <button {...(busy ? {} : press(onClose))} disabled={busy}
            className="px-3.5 py-2 text-xs font-medium"
            style={{ color: t.textMuted, borderRadius: R - 2, border: `0.5px solid ${t.inputBorder}`,
              cursor: busy ? "not-allowed" : "pointer" }}>
            {finished ? tx("完成") : tx("稍后再说")}
          </button>
          <button {...(busy || !chosen.length ? {} : press(() => onPull(chosen)))} disabled={busy || !chosen.length}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold"
            style={{ background: busy || !chosen.length ? t.inputBg : t.accent,
              color: busy || !chosen.length ? t.textFaint : "#fff",
              borderRadius: R - 2, cursor: busy || !chosen.length ? "not-allowed" : "pointer" }}>
            {busy ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
            {busy ? tx("拉取中…") : tf("拉取选中 ({0})", chosen.length)}
          </button>
        </>
      }>
      <div className="text-xs" style={{ color: t.textSec }}>
        {rows.filter((r) => !r.error).length} {tx("个项目有更新，共")} {total} {tx("个提交")}{rows.some((r) => r.error) ? tf("；{0} 个项目检查失败", rows.filter((r) => r.error).length) : ""}{tx("。拉取只做快进，不会产生合并提交。")}
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
                  <span className="text-[11px]" style={{ color: t.red }}>{tx("检查失败：")}{r.error}</span>
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
                    {diverged.map((b) => b.name).join("、")} {tx("与远程有分叉,需手动合并")}
                  </span>
                )}
                {!r.detail && dirtyBlocked && (
                  <span className="text-[11px]" style={{ color: t.amber }}>
                    {r.currentBranch} {tx("有未提交更改,拉取时会跳过")}
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
  const [pos, setPos] = useState({ left: x, top: y, originX: "left", originY: "top" });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x, top = y;
    const opensLeft = left + r.width > window.innerWidth - 8;
    const opensUp = top + r.height > window.innerHeight - 8;
    if (opensLeft) left = window.innerWidth - r.width - 8;
    if (opensUp) top = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top),
      originX: opensLeft ? "right" : "left", originY: opensUp ? "bottom" : "top" });
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
      <div ref={ref} className="gk-context-menu fixed" style={{
        top: pos.top, left: pos.left, zIndex: 201, minWidth: 176,
        transformOrigin: `${pos.originX} ${pos.originY}`,
        "--gk-menu-enter-y": pos.originY === "bottom" ? "5px" : "-5px",
        background: t.dialogBg,
        backdropFilter: "blur(24px) saturate(180%)", WebkitBackdropFilter: "blur(24px) saturate(180%)",
        border: `0.5px solid ${t.glassBorder}`, borderRadius: R, boxShadow: t.shadowWindow, padding: 5,
      } as React.CSSProperties}>
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
  const [language, setLanguageState] = useState<Language>(getLanguage);
  const changeLanguage = (next: Language) => {
    setCurrentLanguage(next);
    setLanguageState(next);
  };
  useEffect(() => { document.documentElement.lang = language; }, [language]);
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

  const theme = effectiveDark ? palette.dark : palette.light;

  // ── settings + committer identities (persisted) ──
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [identities, setIdentities] = useState<Identity[]>(loadIdentities);
  const [defaultIdentityId, setDefaultIdentityId] = useState<string>(loadDefaultIdentityId);
  useEffect(() => { saveIdentities(identities); }, [identities]);
  useEffect(() => { localStorage.setItem("gitkit.defaultIdentityId", defaultIdentityId); }, [defaultIdentityId]);

  // ── project state (restored from last session) ──
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState<string>(loadActiveProjectId);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  const isReal = !!activeProject;
  useEffect(() => { saveProjects(projects); }, [projects]);
  useEffect(() => { localStorage.setItem("gitkit.activeProjectId", activeProjectId); }, [activeProjectId]);

  const [selectedCommit, setSelectedCommit]   = useState<Commit | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [smartMerge, setSmartMerge] = useState(() => localStorage.getItem("gitkit.smartMerge") !== "0");
  const [expandedSmartRows, setExpandedSmartRows] = useState<Set<string>>(() => new Set());
  useEffect(() => { localStorage.setItem("gitkit.smartMerge", smartMerge ? "1" : "0"); }, [smartMerge]);
  const [selectedFile, setSelectedFile]       = useState<CommitFile | null>(null);
  const commitDiffRequestRef = useRef(0);
  const [viewChanges, setViewChanges]         = useState(false);
  const [currentBranch, setCurrentBranch]     = useState(activeProject?.branch ?? "");
  const [hoverBranch, setHoverBranch]         = useState<string | null>(null);
  const [focusBranch, setFocusBranch]         = useState<string | null>(null);
  const [hiddenBranches, setHiddenBranches]   = useState<string[]>([]);
  // Sidebar preferences update immediately; the timeline scope is applied after
  // its skeleton has painted so large graph recalculations never flash stale rows.
  const [timelineHiddenBranches, setTimelineHiddenBranches] = useState<string[]>([]);
  const [branchViewLoading, setBranchViewLoading] = useState(false);
  const [pinnedBranches, setPinnedBranches]   = useState<string[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [selectedWorkingFile, setSelectedWorkingFile] = useState<WorkingFile | null>(null);
  const workingDiffRequestRef = useRef(0);
  // Stash under inspection (with its loaded files) + the file whose diff is shown.
  const [selectedStash, setSelectedStash] = useState<(Stash & { files: CommitFile[] }) | null>(null);
  const [selectedStashFile, setSelectedStashFile] = useState<CommitFile | null>(null);
  const stashDiffRequestRef = useRef(0);

  useEffect(() => {
    const focusSearch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        if (activeProject) setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [activeProject]);

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
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const openDetail = () => { setDetailClosing(false); setDetailOpen(true); };
  const closeDetail = () => { setDetailOpen(false); setDetailClosing(true); };
  const [gitBusy, setGitBusy] = useState<null | "fetch" | "pull" | "push">(null);
  // Mirror gitBusy for background jobs that must avoid overlapping a user Git op.
  const gitBusyRef = useRef(gitBusy);
  gitBusyRef.current = gitBusy;
  const [busyLabel, setBusyLabel] = useState<string | null>(null); // generic long-running operation
  // The operation lock and its visual lifetime are deliberately separate. A
  // result stays readable for at least two seconds, and an engaged capsule waits
  // for the pointer to leave before starting its exit animation.
  const [operationDisplay, setOperationDisplay] = useState<OperationDisplay | null>(null);
  const [operationClosing, setOperationClosing] = useState(false);
  const operationEngagedRef = useRef(false);
  const operationRunningRef = useRef(false);
  const operationOutcomeRef = useRef<OperationOutcome | null>(null);
  const operationErrorInspectedRef = useRef(false);
  const operationSettledAtRef = useRef<number | null>(null);
  const operationDismissTimer = useRef<number | null>(null);
  const gitOpId = useRef<string | null>(null);                      // id of the running cancellable op
  const [cancelling, setCancelling] = useState(false);              // cancel requested, awaiting unwind
  const realCache = useRef<Map<string, RealData>>(new Map());
  // Working-tree state is intentionally separate from the heavy history cache:
  // it can paint as soon as `git status` finishes, without waiting for the graph.
  const [workingSnapshot, setWorkingSnapshot] = useState<{ path: string; files: WorkingFile[] } | null>(null);
  const workingCache = useRef<Map<string, WorkingFile[]>>(new Map());
  const watchedPaths = useRef<string[]>([]); // LRU order: warm repo, active repo
  const warmWatchTimer = useRef<number | null>(null);
  const statusJobs = useRef<Map<string, {
    timer: number | null;
    inFlight: Promise<WorkingFile[]> | null;
    rerun: boolean;
    paths: Set<string>;
    full: boolean;
  }>>(new Map());
  const activePathRef = useRef<string | undefined>(activeProject?.path);
  activePathRef.current = activeProject?.path;
  const lastLoadedPath = useRef<string | null>(null);   // to tell a switch from a refresh
  const pendingViewReset = useRef(false);                // branch-changing reloads force a view reset
  const pendingJumpLatest = useRef(false);               // fetch/pull → jump to the newest commit
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const hiddenBranchesRef = useRef(hiddenBranches);
  hiddenBranchesRef.current = hiddenBranches;
  const focusBranchRef = useRef(focusBranch);
  focusBranchRef.current = focusBranch;
  const branchViewFrames = useRef<number[]>([]);

  useEffect(() => () => {
    if (operationDismissTimer.current != null) window.clearTimeout(operationDismissTimer.current);
  }, []);
  const cancelOperationDismiss = () => {
    if (operationDismissTimer.current != null) window.clearTimeout(operationDismissTimer.current);
    operationDismissTimer.current = null;
    setOperationClosing(false);
  };
  const dismissOperationDisplay = () => {
    if (operationDismissTimer.current != null) window.clearTimeout(operationDismissTimer.current);
    setOperationClosing(true);
    operationDismissTimer.current = window.setTimeout(() => {
      operationDismissTimer.current = null;
      operationSettledAtRef.current = null;
      operationOutcomeRef.current = null;
      operationErrorInspectedRef.current = false;
      setOperationDisplay(null);
      setOperationClosing(false);
    }, 180);
  };
  const scheduleOperationDismiss = (delay?: number) => {
    if (operationDismissTimer.current != null) window.clearTimeout(operationDismissTimer.current);
    const elapsed = operationSettledAtRef.current == null ? 2_000 : Date.now() - operationSettledAtRef.current;
    const remaining = delay ?? Math.max(0, 2_000 - elapsed);
    if (remaining === 0) { dismissOperationDisplay(); return; }
    setOperationClosing(false);
    operationDismissTimer.current = window.setTimeout(() => {
      operationDismissTimer.current = null;
      dismissOperationDisplay();
    }, remaining);
  };
  const beginOperationDisplay = (display: Omit<OperationDisplay, "outcome" | "progress">) => {
    cancelOperationDismiss();
    operationRunningRef.current = true;
    operationOutcomeRef.current = "running";
    operationErrorInspectedRef.current = false;
    operationSettledAtRef.current = null;
    setOperationDisplay({ ...display, outcome: "running", progress: null });
  };
  const updateOperationProgress = (progress: GitProgress) => {
    setOperationDisplay((current) => current ? { ...current, progress } : current);
  };
  const settleOperationDisplay = (outcome: Exclude<OperationOutcome, "running">, title: string, phase: string) => {
    operationRunningRef.current = false;
    operationOutcomeRef.current = outcome;
    operationErrorInspectedRef.current = outcome === "error" && operationEngagedRef.current;
    operationSettledAtRef.current = Date.now();
    setOperationDisplay((current) => current ? { ...current, outcome, title, phase } : current);
    if (outcome !== "error" && !operationEngagedRef.current) scheduleOperationDismiss();
  };
  const setOperationEngaged = (engaged: boolean) => {
    operationEngagedRef.current = engaged;
    if (engaged) {
      cancelOperationDismiss();
      if (!operationRunningRef.current && operationOutcomeRef.current === "error") {
        operationErrorInspectedRef.current = true;
      }
    } else if (!operationRunningRef.current) {
      if (operationOutcomeRef.current !== "error") scheduleOperationDismiss();
      else if (operationErrorInspectedRef.current) scheduleOperationDismiss(2_000);
    }
  };

  // View switches (focus a branch / 全部视图) can rebuild a large list — mark
  // them non-urgent so the click stays snappy and the old view holds until ready.
  const setFocus = (name: string | null) => startTransition(() => setFocusBranch(name));

  // Project switches rebuild the whole timeline. Applying the new repo's data
  // as a transition keeps the click instant (the skeleton shows via `dataReady`)
  // and lets the heavy list render happen interruptibly instead of freezing the
  // main thread for ~1s. `switching` is true until the new timeline is painted.
  const [switching, startSwitch] = useTransition();

  const cancelBranchViewFrames = () => {
    branchViewFrames.current.forEach((frame) => cancelAnimationFrame(frame));
    branchViewFrames.current = [];
  };
  useEffect(() => () => cancelBranchViewFrames(), []);

  const updateHiddenBranches: React.Dispatch<React.SetStateAction<string[]>> = (update) => {
    const previous = hiddenBranchesRef.current;
    const next = typeof update === "function" ? update(previous) : update;
    if (next.length === previous.length && next.every((name, index) => name === previous[index])) return;

    hiddenBranchesRef.current = next;
    setHiddenBranches(next);
    setBranchViewLoading(true);
    cancelBranchViewFrames();
    // Two animation frames guarantee the structure-matched skeleton gets one
    // paint before React starts rebuilding the potentially large graph.
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => {
        branchViewFrames.current = [];
        startSwitch(() => {
          setTimelineHiddenBranches(next);
          if (focusBranchRef.current && next.includes(focusBranchRef.current)) setFocusBranch(null);
          setBranchViewLoading(false);
        });
      });
      branchViewFrames.current = [second];
    });
    branchViewFrames.current = [first];
  };

  // Esc or a pointer press outside the drawer closes the detail overlay.
  useEffect(() => {
    if (!detailOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeDetail(); };
    const onMouseDown = (e: MouseEvent) => {
      if (detailPanelRef.current?.contains(e.target as Node)) return;
      if ((e.target as Element | null)?.closest?.(".gk-operation-capsule")) return;
      e.preventDefault();
      e.stopPropagation();
      closeDetail();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
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
  const activeWorking = workingSnapshot && workingSnapshot.path === activeProject?.path
    ? workingSnapshot.files
    : view?.working ?? [];
  const changesCount = activeWorking.length;
  const remoteNames = useMemo(() => remotes.map((r) => r.name), [remotes]);

  // ── persist per-repo UI state (hidden/pinned branches, collapsed folders) ──
  const prefsKey = activeProject?.path ?? "";
  const prefsLoadedFor = useRef<string | null>(null);
  useEffect(() => { setExpandedSmartRows(new Set()); }, [prefsKey]);
  useEffect(() => {
    const p = loadUiPrefs(prefsKey);
    cancelBranchViewFrames();
    hiddenBranchesRef.current = p.hidden;
    setHiddenBranches(p.hidden);
    setTimelineHiddenBranches(p.hidden);
    setBranchViewLoading(false);
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

  // Hide both a local branch and its configured upstream identity. New branches
  // are visible automatically because names are opt-out rather than opt-in.
  const hiddenTimelineNames = useMemo(() => {
    const names = new Set(timelineHiddenBranches);
    for (const branch of branches) {
      if (names.has(branch.name) && branch.remote) names.add(branch.remote);
    }
    return [...names];
  }, [timelineHiddenBranches, branches]);
  const base = useMemo(() => isReal
    ? filterHistoryByHiddenBranches(commits, hiddenTimelineNames)
    : commits, [isReal, commits, hiddenTimelineNames]);
  const scopedCommits = focusActive ? (focusInfo?.list ?? []) : base;
  const smartMergeResult = useMemo(
    () => focusActive
      ? { commits: scopedCommits, mergedGroups: 0, hiddenCommits: 0 }
      : buildSmartMergeCommits(scopedCommits, currentBranch),
    [focusActive, scopedCommits, currentBranch],
  );
  const smartMergeActive = smartMerge && !focusActive && smartMergeResult.mergedGroups > 0;
  const effectiveScopedCommits = smartMergeActive ? smartMergeResult.commits : scopedCommits;
  const displayCommits = effectiveScopedCommits;
  const displayGraph = useMemo(() => {
    if (!smartMergeActive && (!isReal || (!focusActive && timelineHiddenBranches.length === 0))) return graphRows;
    const set = new Set(displayCommits.map((c) => c.fullHash));
    return computeGraph(displayCommits.map((c) => ({ ...c, parents: c.parents.filter((p) => set.has(p)) })));
  }, [smartMergeActive, isReal, focusActive, timelineHiddenBranches.length, graphRows, displayCommits]);

  // Raw topology can place another branch's whole lane above the current HEAD.
  // When Smart Merge is switched off, anchor the viewport to the checked-out
  // branch so users can inspect the truth without having to hunt for it.
  useEffect(() => {
    if (smartMergeActive || focusActive || !dataReady) return;
    const head = branches.find((branch) => branch.current)?.head;
    if (!head) return;
    const frame = requestAnimationFrame(() => {
      const row = timelineScrollRef.current?.querySelector<HTMLElement>(`[data-commit-hash="${head}"]`);
      row?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [smartMergeActive, focusActive, dataReady, branches]);

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
    const requestId = ++commitDiffRequestRef.current;
    setSelectedStash(null); setSelectedStashFile(null);
    setSelectedCommit(commit);
    setSelectedFile(null);
    if (isReal && activeProject) {
      try {
        const files = await loadCommitFiles(activeProject.path, commit.fullHash);
        if (requestId !== commitDiffRequestRef.current) return;
        const additions = files.reduce((s, f) => s + f.additions, 0);
        const deletions = files.reduce((s, f) => s + f.deletions, 0);
        setSelectedCommit({ ...commit, files, stats: { additions, deletions, files: files.length } });
        // Default to the first readable file's diff so the right pane isn't empty.
        const first = firstReadableFile(files);
        if (first) {
          setSelectedFile(first);
          try {
            const diff = await commitFileDiff(activeProject.path, commit.fullHash, first.path);
            if (requestId === commitDiffRequestRef.current)
              setSelectedFile((current) => current?.path === first.path ? { ...current, diff } : current);
          } catch {
            if (requestId === commitDiffRequestRef.current)
              setSelectedFile((current) => current?.path === first.path ? { ...current, diffError: true } : current);
          }
        }
      } catch { /* keep summary without files */ }
    }
  };

  const openTimelineCommit = (commit: Commit) => {
    setViewChanges(false);
    selectCommit(commit);
    openDetail();
  };

  const revealCommitFile = async (file: CommitFile) => {
    if (!activeProject) return;
    try {
      await revealInFileManager(activeProject.path, file.path);
    } catch (e) {
      toast.error(tf("{0}失败：{1}", fileManagerActionLabel(), e));
    }
  };

  const selectDetailFile = async (file: CommitFile | null) => {
    const requestId = ++commitDiffRequestRef.current;
    setSelectedFile(file ? { ...file, diffError: false } : null);
    if (file && file.diff === undefined && isReal && activeProject && selectedCommit) {
      try {
        const diff = await commitFileDiff(activeProject.path, selectedCommit.fullHash, file.path);
        if (requestId === commitDiffRequestRef.current)
          setSelectedFile((current) => current?.path === file.path ? { ...current, diff } : current);
      } catch {
        if (requestId === commitDiffRequestRef.current)
          setSelectedFile((current) => current?.path === file.path ? { ...current, diffError: true } : current);
      }
    }
  };

  // Open a stash's detail: load its files, then preselect the first with its diff.
  const openStash = async (s: Stash) => {
    if (!activeProject) return;
    const requestId = ++stashDiffRequestRef.current;
    setViewChanges(false);
    setSelectedCommit(null); setSelectedFile(null);
    setSelectedStash({ ...s, files: [] });
    setSelectedStashFile(null);
    openDetail();
    try {
      const files = await stashFiles(activeProject.path, s.index);
      if (requestId !== stashDiffRequestRef.current) return;
      setSelectedStash({ ...s, files });
      const first = firstReadableFile(files) ?? files[0] ?? null;
      if (first) {
        setSelectedStashFile(first);
        try {
          const diff = await stashFileDiff(activeProject.path, s.index, first.path);
          if (requestId === stashDiffRequestRef.current)
            setSelectedStashFile((current) => current?.path === first.path ? { ...current, diff } : current);
        } catch {
          if (requestId === stashDiffRequestRef.current)
            setSelectedStashFile((current) => current?.path === first.path ? { ...current, diffError: true } : current);
        }
      }
    } catch (e) { toast.error(tf("读取储藏失败：{0}", e)); }
  };
  const selectStashFile = async (file: CommitFile | null) => {
    const requestId = ++stashDiffRequestRef.current;
    setSelectedStashFile(file ? { ...file, diffError: false } : null);
    if (file && file.diff === undefined && activeProject && selectedStash) {
      try {
        const diff = await stashFileDiff(activeProject.path, selectedStash.index, file.path);
        if (requestId === stashDiffRequestRef.current)
          setSelectedStashFile((current) => current?.path === file.path ? { ...current, diff } : current);
      } catch {
        if (requestId === stashDiffRequestRef.current)
          setSelectedStashFile((current) => current?.path === file.path ? { ...current, diffError: true } : current);
      }
    }
  };

  const selectWorkingFile = async (file: WorkingFile | null) => {
    const requestId = ++workingDiffRequestRef.current;
    setSelectedWorkingFile(file ? { ...file, diffError: false } : null);
    // Load once: skip if a diff or a preview verdict is already attached.
    if (file && file.diff === undefined && file.previewKind === undefined && isReal && activeProject) {
      try {
        if (file.status === "untracked") {
          // git diff shows nothing for untracked files — read the file directly.
          const p = await filePreview(activeProject.path, file.path);
          setSelectedWorkingFile((current) => requestId === workingDiffRequestRef.current && current?.path === file.path && current.staged === file.staged
            ? { ...current, diff: p.diff, previewKind: p.kind,
              previewTruncated: p.truncated, previewSize: p.size } : current);
        } else {
          const diff = await workingFileDiff(activeProject.path, file.path, file.staged);
          setSelectedWorkingFile((current) => requestId === workingDiffRequestRef.current && current?.path === file.path && current.staged === file.staged
            ? { ...current, diff } : current);
        }
      } catch {
        setSelectedWorkingFile((current) => requestId === workingDiffRequestRef.current && current?.path === file.path && current.staged === file.staged
          ? { ...current, diffError: true } : current);
      }
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

  // ── resource-bounded working-tree monitor ────────────────────────────────
  // Native notifications are the primary signal. We keep at most the active
  // repo plus one warm MRU repo, coalesce bursts, and never run periodic status
  // polls while the app is idle.
  const applyWorkingStatusRef = useRef<(repoPath: string, files: WorkingFile[]) => void>(() => {});
  applyWorkingStatusRef.current = (repoPath, files) => {
    workingCache.current.delete(repoPath);
    workingCache.current.set(repoPath, files);
    while (workingCache.current.size > WATCHED_REPO_LIMIT) {
      const oldest = workingCache.current.keys().next().value as string | undefined;
      if (!oldest) break;
      workingCache.current.delete(oldest);
    }

    if (activePathRef.current === repoPath) setWorkingSnapshot({ path: repoPath, files });
    setProjects((prev) => {
      let changed = false;
      const next = prev.map((project) => {
        if (project.path !== repoPath || project.changes === files.length) return project;
        changed = true;
        return { ...project, changes: files.length };
      });
      return changed ? next : prev;
    });

    const cached = realCache.current.get(repoPath);
    if (cached && !sameWorking(files, cached.working)) {
      cacheRealData(realCache.current, repoPath, { ...cached, working: files }, false);
    }
    setRealData((prev) => {
      if (!prev || prev.path !== repoPath || sameWorking(files, prev.working)) return prev;
      return { ...prev, working: files };
    });
  };

  const requestWorkingStatusRef = useRef<(
    repoPath: string,
    rerunIfBusy?: boolean,
    forceFull?: boolean,
  ) => Promise<WorkingFile[]>>(() => Promise.resolve([]));
  requestWorkingStatusRef.current = (repoPath, rerunIfBusy = false, forceFull = false) => {
    let job = statusJobs.current.get(repoPath);
    if (!job) {
      job = { timer: null, inFlight: null, rerun: false, paths: new Set(), full: false };
      statusJobs.current.set(repoPath, job);
    }
    if (forceFull) {
      job.full = true;
      job.paths.clear();
    }
    if (job.timer !== null) {
      window.clearTimeout(job.timer);
      job.timer = null;
    }
    if (job.inFlight) {
      if (rerunIfBusy || forceFull) job.rerun = true;
      return job.inFlight;
    }

    const changedPaths = job.full ? [] : [...job.paths];
    const full = job.full || changedPaths.length === 0;
    job.full = false;
    job.paths.clear();
    const request = full ? loadStatus(repoPath) : loadStatusPaths(repoPath, changedPaths);
    const task = request
      .then((partial) => {
        const previous = workingCache.current.get(repoPath)
          ?? realCache.current.get(repoPath)?.working
          ?? [];
        const files = full ? partial : mergeWorkingPaths(previous, changedPaths, partial);
        if (watchedPaths.current.includes(repoPath) || activePathRef.current === repoPath) {
          applyWorkingStatusRef.current(repoPath, files);
        }
        return files;
      })
      .finally(() => {
        job!.inFlight = null;
        if (job!.rerun && watchedPaths.current.includes(repoPath)) {
          job!.rerun = false;
          queueMicrotask(() => { void requestWorkingStatusRef.current(repoPath).catch(() => {}); });
        } else if (!watchedPaths.current.includes(repoPath) && activePathRef.current !== repoPath) {
          statusJobs.current.delete(repoPath);
        }
      });
    job.inFlight = task;
    return task;
  };

  const scheduleWorkingStatusRef = useRef<(
    repoPath: string,
    immediate?: boolean,
    paths?: string[],
    full?: boolean,
  ) => void>(() => {});
  scheduleWorkingStatusRef.current = (repoPath, immediate = false, paths = [], full = immediate) => {
    let job = statusJobs.current.get(repoPath);
    if (!job) {
      job = { timer: null, inFlight: null, rerun: false, paths: new Set(), full: false };
      statusJobs.current.set(repoPath, job);
    }
    if (full || paths.length === 0) {
      job.full = true;
      job.paths.clear();
    } else if (!job.full) {
      for (const changed of paths) job.paths.add(changed);
      if (job.paths.size > 256) {
        job.full = true;
        job.paths.clear();
      }
    }
    if (job.timer !== null) window.clearTimeout(job.timer);
    if (immediate) {
      job.timer = null;
      void requestWorkingStatusRef.current(repoPath, false, true).catch(() => {});
    } else {
      job.timer = window.setTimeout(() => {
        job!.timer = null;
        void requestWorkingStatusRef.current(repoPath, true).catch(() => {});
      }, STATUS_DEBOUNCE_MS);
    }
  };

  const dropWatcherRef = useRef<(repoPath: string) => void>(() => {});
  dropWatcherRef.current = (repoPath) => {
    watchedPaths.current = watchedPaths.current.filter((candidate) => candidate !== repoPath);
    const job = statusJobs.current.get(repoPath);
    if (job?.timer !== null && job?.timer !== undefined) window.clearTimeout(job.timer);
    if (job) job.rerun = false;
    if (!job?.inFlight) statusJobs.current.delete(repoPath);
    workingCache.current.delete(repoPath);
    void stopWatch(repoPath).catch(() => {});
  };

  // One app-wide Tauri listener serves both watcher slots. Focus/resume performs
  // one authoritative active-repo reconciliation; there is no idle interval.
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    listen<WorkingTreeChanged>("working-tree-changed", (event) => {
      const change = event.payload;
      if (!stopped && watchedPaths.current.includes(change.path)) {
        scheduleWorkingStatusRef.current(change.path, false, change.paths, change.full);
      }
    }).then((fn) => { if (stopped) fn(); else unlisten = fn; }).catch(() => {});

    const refreshActive = () => {
      const active = activePathRef.current;
      if (active) scheduleWorkingStatusRef.current(active, true);
    };
    const onVisibility = () => { if (document.visibilityState === "visible") refreshActive(); };
    window.addEventListener("focus", refreshActive);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      if (unlisten) unlisten();
      window.removeEventListener("focus", refreshActive);
      document.removeEventListener("visibilitychange", onVisibility);
      if (warmWatchTimer.current !== null) window.clearTimeout(warmWatchTimer.current);
      for (const job of statusJobs.current.values()) {
        if (job.timer !== null) window.clearTimeout(job.timer);
      }
      for (const watched of watchedPaths.current) void stopWatch(watched).catch(() => {});
      watchedPaths.current = [];
      statusJobs.current.clear();
    };
  }, []);

  // Promote the selected repo to the active watcher slot. Starting the watcher
  // before the status read closes the switch race: an edit during the read queues
  // exactly one follow-up reconciliation.
  useEffect(() => {
    if (!path) return;

    const cachedWorking = workingCache.current.get(path) ?? realCache.current.get(path)?.working;
    if (cachedWorking) setWorkingSnapshot({ path, files: cachedWorking });

    const next = watchedPaths.current.filter((candidate) => candidate !== path);
    next.push(path);
    while (next.length > WATCHED_REPO_LIMIT) {
      const evicted = next.shift();
      if (evicted) dropWatcherRef.current(evicted);
    }
    watchedPaths.current = next;
    void startWatch(path)
      .catch(() => {})
      .finally(() => scheduleWorkingStatusRef.current(path, true));

    if (warmWatchTimer.current !== null) window.clearTimeout(warmWatchTimer.current);
    const warm = next.length > 1 ? next[0] : undefined;
    warmWatchTimer.current = warm
      ? window.setTimeout(() => {
          warmWatchTimer.current = null;
          if (activePathRef.current !== warm) dropWatcherRef.current(warm);
        }, WARM_WATCH_TTL_MS)
      : null;
  }, [path]);

  // Closing a project releases its watcher immediately instead of waiting for
  // LRU replacement or the warm-slot timeout.
  const projectPathsKey = projects.map((project) => project.path).join("\0");
  useEffect(() => {
    const openPaths = new Set(projectPathsKey ? projectPathsKey.split("\0") : []);
    for (const watched of [...watchedPaths.current]) {
      if (!openPaths.has(watched)) dropWatcherRef.current(watched);
    }
  }, [projectPathsKey]);

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
      const requestId = ++commitDiffRequestRef.current;
      if (open) { setViewChanges(false); setDetailClosing(false); setDetailOpen(true); }
      setSelectedFile(null); setSelectedWorkingFile(null);
      const first = data.commits[0] ?? null;
      if (!first) { setSelectedCommit(null); return; }
      if (open) requestAnimationFrame(() => timelineScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
      try {
        const files = await loadCommitFiles(path, first.fullHash);
        const additions = files.reduce((s, f) => s + f.additions, 0);
        const deletions = files.reduce((s, f) => s + f.deletions, 0);
        if (!alive() || requestId !== commitDiffRequestRef.current) return;
        setSelectedCommit({ ...first, files, stats: { additions, deletions, files: files.length } });
        const ff = firstReadableFile(files);
        if (!ff) return;
        setSelectedFile(ff);
        try {
          const diff = await commitFileDiff(path, first.fullHash, ff.path);
          if (alive() && requestId === commitDiffRequestRef.current)
            setSelectedFile((current) => current?.path === ff.path ? { ...current, diff } : current);
        } catch {
          if (alive() && requestId === commitDiffRequestRef.current)
            setSelectedFile((current) => current?.path === ff.path ? { ...current, diffError: true } : current);
        }
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
      // A cache hit is a real user access, so promote it in the bounded LRU.
      cacheRealData(realCache.current, path, cached);
      const apply = () => {
        // Status may have refreshed while this transition was queued.
        const latest = realCache.current.get(path) ?? cached;
        setRealData(latest);
        setWorkingSnapshot({ path, files: workingCache.current.get(path) ?? latest.working });
        syncBranch(latest);
        if (resetView) { applyView(latest); preselect(latest); }
        else if (jumpLatest) preselect(latest, true);
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
        const statusPromise = requestWorkingStatusRef.current(path, false, true);
        const [historyBranches, remoteList, commitList, working, stashList_] = await Promise.all([
          loadBranches(path, true),
          loadRemotes(path),
          loadHistory(path),
          statusPromise,
          stashList(path),
        ]);
        if (cancelled) return;
        attributeBranches(commitList, historyBranches);
        const branchList = historyBranches.filter((b) => !b.isRemote);
        const graph = computeGraph(commitList);
        // A watcher event may have produced a newer status while history loaded.
        const latestWorking = workingCache.current.get(path) ?? working;
        const data: RealData = { path, branches: branchList, remotes: remoteList, commits: commitList, graph, working: latestWorking, stashes: stashList_ };
        cacheRealData(realCache.current, path, data);
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
        mode === "stash" ? tf("已储藏改动并创建分支 {0}", name)
        : mode === "discard" ? tf("已放弃改动并创建分支 {0}", name)
        : tf("已创建并切换到分支 {0}", name));
    } catch (e) { toast.error(tf("创建分支失败：{0}", e)); }
  };

  // Create a tag on the current HEAD and push it to origin — the release flow
  // that triggers the build CI. Keeps the dialog open if the name is rejected.
  const doCreateAndPushTag = async (name: string, message: string) => {
    if (!activeProject) return;
    const p = activeProject.path;
    const originUrl = remotes.find((r) => r.name === "origin")?.url ?? remotes[0]?.url ?? "";
    const resolved = await resolveRemoteToken(originUrl, tx("推送标签"));
    if (!resolved) return; // account picker cancelled — don't create the tag either
    const token = resolved.token;
    setTagBusy(true);
    const tid = toast.loading(tf("正在创建并推送标签 {0}…", name));
    try {
      await createTag(p, name, message);
    } catch (e) {
      toast.error(tf("创建标签失败：{0}", e), { id: tid });
      setTagBusy(false);
      return;
    }
    realCache.current.delete(p);
    setReloadTick((n) => n + 1);
    try {
      await pushTag(p, name, token);
      toast.success(tf("标签 {0} 已创建并推送", name), { id: tid });
    } catch (e) {
      toast.error(tf("标签 {0} 已创建，但推送失败：{1}", name, e), { id: tid });
    } finally {
      setTagBusy(false);
      setTagDialogOpen(false);
    }
  };

  // ── stash: save working changes, then apply / drop saved entries ──
  // Open the stash dialog (optional title). Guard here so the button feedback
  // still happens even though the actual stash runs from the dialog.
  const requestStash = () => {
    if (!activeProject || gitBusy || busyLabel) return;
    if (changesCount === 0) { toast(tx("没有可储藏的更改")); return; }
    setStashDialogOpen(true);
  };
  const doStash = async (message = "") => {
    if (!activeProject || gitBusy || busyLabel) return;
    const p = activeProject.path;
    setStashBusy(true);
    const tid = toast.loading(tx("正在储藏…"));
    try {
      await stashPush(p, message);   // empty → backend default ("GitKit stash")
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      setStashDialogOpen(false);
      toast.success(tx("已储藏当前更改"), { id: tid });
    } catch (e) { toast.error(tf("储藏失败：{0}", e), { id: tid }); }
    finally { setStashBusy(false); }
  };
  const doStashApply = async (index: number) => {
    if (!activeProject || gitBusy || busyLabel) return;
    const p = activeProject.path;
    const tid = toast.loading(tx("正在应用储藏…"));
    try {
      await stashApply(p, index);
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      toast.success(tf("已应用 stash@{{0}}", index), { id: tid });
    } catch (e) { toast.error(tf("应用储藏失败：{0}", e), { id: tid }); }
  };
  const doStashDrop = async (index: number) => {
    if (!activeProject || gitBusy || busyLabel) return;
    const p = activeProject.path;
    try {
      await stashDrop(p, index);
      // Indices shift after a drop; if the dropped stash was open, close its detail.
      if (selectedStash?.index === index) {
        setSelectedStash(null); setSelectedStashFile(null); closeDetail();
      }
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      toast.success(tf("已删除 stash@{{0}}", index));
    } catch (e) { toast.error(tf("删除储藏失败：{0}", e)); }
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
    const tid = toast.loading(tf("正在创建仓库 {0}…", name));
    try {
      const repo = await githubCreateRepo(account.url, account.token, name, isPrivate, description);
      toast.loading(tx("仓库已创建,正在推送…"), { id: tid });
      await gitRemoteAdd(p, "origin", repo.cloneUrl);
      await push(p, account.token);
      realCache.current.delete(p);
      setReloadTick((n) => n + 1);
      setCreateRepoOpen(false);
      toast.success(tx("仓库已创建并推送"), { id: tid, description: repo.htmlUrl });
    } catch (e) {
      // If the remote was added but the push failed (e.g. no commits yet), the
      // repo now has an origin — a later push takes the normal path.
      toast.error(tf("创建 / 推送失败：{0}", e), { id: tid });
    } finally {
      setCreateRepoBusy(false);
    }
  };

  // Fetch / pull / push. Each refreshes the repo afterwards (cache-busting reload).
  const runGitAction = async (kind: "fetch" | "pull" | "push") => {
    if (!activeProject || !dataReady || switching || gitBusy || busyLabel) return;
    const p = activeProject.path;
    const verbs = { fetch: tx("获取"), pull: tx("拉取"), push: tx("推送") } as const;
    if (remotes.length === 0) {
      // No remote yet: for a push with a GitHub account configured, offer to create
      // the repo on GitHub and wire it up. Fetch/pull can't be bootstrapped this way.
      if (kind === "push" && loadGithubAccounts().length > 0) { setCreateRepoOpen(true); return; }
      toast.error(tf("没有配置远程仓库,无法{0}。可在设置中添加 GitHub 账号后重试,或先手动 git remote add origin <url>。", verbs[kind]));
      return;
    }
    const originUrl = remotes.find((r) => r.name === "origin")?.url ?? remotes[0]?.url ?? "";
    const resolved = await resolveRemoteToken(originUrl, verbs[kind]);
    if (!resolved) return; // account picker cancelled
    const token = resolved.token;
    const opId = crypto.randomUUID();
    gitOpId.current = opId;
    beginOperationDisplay({
      kind,
      title: tf("{0}中", verbs[kind]),
      context: { project: activeProject.name, path: p, branch: currentBranch },
    });
    setGitBusy(kind);
    setCancelling(false);
    const tid = `git-operation-${opId}`;
    let outcome: Exclude<OperationOutcome, "running"> = "success";
    let outcomeTitle = tf("{0}完成", verbs[kind]);
    let outcomePhase = tx("操作已完成");
    try {
      // A fetch also fast-forwards every local branch that is behind its
      // upstream; report what it did (and what it deliberately left alone).
      let detail: string | undefined;
      if (kind === "fetch") {
        const s = await fetchAll(p, token, opId, updateOperationProgress);
        const parts: string[] = [];
        if (s.synced.length) parts.push(tf("已同步 {0} 个分支：{1}", s.synced.length, s.synced.join("、")));
        if (s.dirtySkipped) parts.push(tx("当前分支有未提交更改,已跳过"));
        if (s.diverged.length) parts.push(tf("{0} 与远程有分叉,需手动合并", s.diverged.join("、")));
        detail = parts.join(" · ") || undefined;
      } else if (kind === "pull") await pull(p, token, opId, updateOperationProgress);
      else await push(p, token);
      // The user may browse another project while this runs. Refresh/jump only
      // when the originating repo is still active; its invalidated cache will
      // reload naturally the next time it is selected otherwise.
      if (activePathRef.current === p) {
        if (kind === "fetch" || kind === "pull") pendingJumpLatest.current = true;
      }
      toast.success(tf("{0}完成", verbs[kind]), { id: tid, description: detail });
    } catch (e) {
      // A user cancel isn't a failure — dismiss quietly.
      if (isCancelled(e)) {
        outcome = "cancelled";
        outcomeTitle = tf("已取消{0}", verbs[kind]);
        outcomePhase = tx("操作已取消");
        toast(outcomeTitle, { id: tid });
      } else {
        outcome = "error";
        outcomeTitle = tf("{0}失败", verbs[kind]);
        outcomePhase = String(e);
      }
    } finally {
      // Cancellation can arrive after some refs have already changed.
      realCache.current.delete(p);
      if (activePathRef.current === p) setReloadTick((n) => n + 1);
      setGitBusy(null);
      setCancelling(false);
      gitOpId.current = null;
      settleOperationDisplay(outcome, outcomeTitle, outcomePhase);
    }
  };

  // Cancel the in-flight fetch/pull. The backend kills its process tree, which
  // unwinds runGitAction's await into the isCancelled branch above.
  const cancelGitAction = async () => {
    const id = gitOpId.current;
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await cancelGitOp(id);
    } catch (e) {
      if (gitOpId.current !== id) return;
      setCancelling(false);
      toast.error(tf("取消失败：{0}", e));
    }
  };

  // Native scheduling keeps progressing while the WebView is suspended. Events
  // are hints; always reconcile with a snapshot on focus/reload to recover gaps.
  const [dailyCheck, setDailyCheckState] = useState<DailyCheck>(loadDailyCheck);
  const setDailyCheck = (c: DailyCheck) => { setDailyCheckState(c); saveDailyCheck(c); };
  const [checkSnapshot, setCheckSnapshot] = useState<CheckSnapshot | null>(null);
  const checkProgress = checkSnapshot?.progress ?? null;
  const checkBusy = checkProgress !== null;
  const [pullBusy, setPullBusy] = useState(false);
  const [updateRows, setUpdateRows] = useState<UpdateRow[] | null>(null);
  const [checkFocused, setCheckFocused] = useState(false);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const checkRevisionRef = useRef(-1);
  const completedCheckRef = useRef(0);
  const presentedCheckRef = useRef(0);
  const checkErrorRef = useRef("");
  const applyCheckSnapshot = useRef((_: CheckSnapshot) => {});
  applyCheckSnapshot.current = (snapshot) => {
    if (snapshot.revision < checkRevisionRef.current) return;
    checkRevisionRef.current = snapshot.revision;
    setCheckSnapshot(snapshot);
    setDailyCheckState((prev) => {
      if (prev.lastRun >= snapshot.config.lastRun) return prev;
      const next = { ...prev, lastRun: snapshot.config.lastRun };
      saveDailyCheck(next);
      return next;
    });
    if (snapshot.result && snapshot.result.id > completedCheckRef.current) {
      completedCheckRef.current = snapshot.result.id;
      realCache.current.clear();
      setReloadTick((n) => n + 1);
    }
    if (snapshot.persistenceError && snapshot.persistenceError !== checkErrorRef.current) {
      checkErrorRef.current = snapshot.persistenceError;
      toast.error(snapshot.persistenceError);
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    let focusRevision = 0;
    const refresh = () => invoke<CheckSnapshot>("daily_check_snapshot").then((snapshot) => {
      if (!disposed) applyCheckSnapshot.current(snapshot);
    }).catch((error) => { if (!disposed) toast.error(tf("读取检查状态失败：{0}", error)); });
    const keep = (unlisten: () => void) => { if (disposed) unlisten(); else unlisteners.push(unlisten); };
    void listen<CheckSnapshot>("daily-check-state", ({ payload }) => {
      if (!disposed) applyCheckSnapshot.current(payload);
    }).then((unlisten) => { keep(unlisten); if (!disposed) void refresh(); })
      .catch((error) => { if (!disposed) toast.error(tf("监听检查状态失败：{0}", error)); });
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      if (disposed) return;
      const revision = ++focusRevision;
      setCheckFocused(false);
      if (payload) void refresh().then(() => { if (!disposed && revision === focusRevision) setCheckFocused(true); });
    }).then(keep).catch((error) => { if (!disposed) toast.error(tf("监听窗口状态失败：{0}", error)); });
    void getCurrentWindow().isFocused().then(async (focused) => {
      if (!focused || disposed || focusRevision !== 0) return;
      await refresh();
      if (!disposed && focusRevision === 0) setCheckFocused(true);
    }).catch((error) => { if (!disposed) toast.error(tf("读取窗口状态失败：{0}", error)); });
    const credentialsChanged = () => setCredentialRevision((n) => n + 1);
    window.addEventListener("gitkit-credentials-changed", credentialsChanged);
    return () => { disposed = true; unlisteners.forEach((unlisten) => unlisten()); window.removeEventListener("gitkit-credentials-changed", credentialsChanged); };
  }, []);
  const checkProjectsKey = JSON.stringify(projects.map(({ id, name, path }) => ({ id, name, path })));
  useEffect(() => {
    if (!isTauri()) return;
    const gl = loadGitlab();
    void invoke<CheckSnapshot>("daily_check_configure", {
      config: dailyCheck,
      projects: JSON.parse(checkProjectsKey),
      credentials: {
        github: loadGithubAccounts().map((a) => ({ id: a.id, host: a.url ? hostOf(a.url).split(":")[0] : "", token: a.token })),
        gitlabHost: hostOf(gl.url).split(":")[0], gitlabToken: gl.token,
        preferences: loadPrefMap(ACCOUNT_PREFS),
      },
    }).then((snapshot) => applyCheckSnapshot.current(snapshot)).catch((error) => toast.error(tf("保存定时检查设置失败：{0}", error)));
  }, [dailyCheck.enabled, dailyCheck.time, dailyCheck.skipWeekends, checkProjectsKey, credentialRevision]);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("daily_check_set_busy", { busy: !!gitBusy || !!busyLabel || pullBusy })
      .catch((error) => toast.error(tf("更新后台检查状态失败：{0}", error)));
  }, [gitBusy, busyLabel, pullBusy]);

  const showCheckResult = (result: CheckResult) => {
    presentedCheckRef.current = result.id;
    if (result.rows.length) {
      setSettingsOpen(false);
      setUpdateRows(result.rows.map((r) => ({ ...r, error: r.error ?? undefined, state: "idle" })));
    } else if (result.manual) toast.success(tx("所有项目都已是最新"));
    void invoke("daily_check_mark_viewed", { id: result.id })
      .catch((error) => toast.error(tf("保存已读状态失败：{0}", error)));
  };
  useEffect(() => {
    const result = checkSnapshot?.result ?? null;
    if (!result || presentedCheckRef.current === result.id || updateRows || pullBusy || gitBusy || busyLabel) return;
    // Re-evaluate after any dialog closes, without stacking automatic dialogs.
    const dialogs = document.querySelectorAll('[role="dialog"]');
    if (dialogs.length && !(dialogs.length === 1 && settingsOpen && result.manual)) return;
    if (shouldPresentCheck(result, checkFocused)) showCheckResult(result);
  });
  const runUpdateCheck = async () => {
    if (gitBusyRef.current || busyLabel || pullBusy) { toast(tx("请等待当前 Git 操作完成")); return; }
    try { await invoke("daily_check_now"); }
    catch (error) { toast.error(String(error)); }
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
        if (s.synced.length) parts.push(tf("已快进 {0}", s.synced.join("、")));
        if (s.dirtySkipped) parts.push(tx("当前分支有未提交更改,已跳过"));
        if (s.diverged.length) parts.push(tf("{0} 与远程有分叉,需手动合并", s.diverged.join("、")));
        setUpdateRows((prev) => prev?.map((r) => r.id === id
          ? { ...r, state: s.synced.length ? "done" : "failed", detail: parts.join(" · ") || tx("没有可快进的分支") }
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

  // Commit staged files with the chosen identity (falls back to repo/global config).
  const doCommit = async (message: string, files: string[], identity: Identity | null) => {
    if (!activeProject || gitBusy || busyLabel) return;
    await gitCommit(activeProject.path, message, files, identity?.name, identity?.email);
    realCache.current.delete(activeProject.path);
    setReloadTick((n) => n + 1);
    toast.success(tf("已提交 {0} 个文件", files.length));
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
    if (!activeProject || gitBusy || busyLabel) return;
    const branch = syncTargetOf(commit);
    if (!branch) { toast(tx("此提交没有可同步的本地分支")); return; }
    const tid = toast.loading(tf("正在检出并同步 {0}…", branch));
    try {
      await checkoutSync(activeProject.path, branch, commit.fullHash);
      setCurrentBranch(branch);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;
      setReloadTick((n) => n + 1);
      toast.success(tf("已检出 {0} 并同步到 {1}", branch, commit.hash), { id: tid });
    } catch (e) { toast.error(tf("检出失败：{0}", e), { id: tid }); }
  };

  // Double-click a branch pill in the all-view:
  //  • local branch behind its remote → check it out and fast-forward to upstream;
  //  • remote-only branch (no local yet) → create a local tracking branch + check out;
  //  • already in sync → nothing.
  const doSyncBranch = async (branchName: string) => {
    if (!activeProject || gitBusy || busyLabel) return;
    const local = branches.find((x) => x.name === branchName);
    if (local && (!local.remote || local.behind <= 0)) { toast(tf("{0} 已与远端同步", branchName)); return; }
    const tid = toast.loading(tf("正在检出并同步 {0}…", branchName));
    try {
      if (local) {
        await checkoutSync(activeProject.path, local.name, local.remote!);
      } else {
        const rem = remotes.find((r) => r.branches.includes(branchName));
        if (!rem) { toast.error(tf("未找到 {0} 的远程分支", branchName), { id: tid }); return; }
        await createBranch(activeProject.path, branchName, `${rem.name}/${branchName}`, true);
      }
      setCurrentBranch(branchName);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch: branchName } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;
      setReloadTick((n) => n + 1);
      toast.success(tf("已检出并同步 {0}", branchName), { id: tid });
    } catch (e) { toast.error(tf("同步失败：{0}", e), { id: tid }); }
  };

  const runConfirm = async () => {
    if (!confirmState) return;
    setConfirmBusy(true);
    try { await confirmState.onConfirm(); setConfirmState(null); }
    catch (e) { toast.error(tf("操作失败：{0}", e)); }
    finally { setConfirmBusy(false); }
  };

  // Discard one file's working-tree changes (tracked → revert to HEAD; untracked
  // → delete from disk). Confirmed first — it's not undoable.
  const doDiscardFile = (file: string) => {
    if (!activeProject) return;
    const p = activeProject.path;
    const untracked = activeWorking.find((f) => f.path === file)?.status === "untracked";
    setConfirmState({
      title: untracked ? tx("删除未跟踪文件") : tx("丢弃更改"),
      message: untracked
        ? tf("将从磁盘删除未跟踪的 {0}。此操作不可撤销。", file)
        : tf("将把 {0} 恢复到 HEAD 版本,丢弃其所有未提交更改。此操作不可撤销。", file),
      confirmLabel: untracked ? tx("删除") : tx("丢弃"),
      onConfirm: async () => {
        await discardFile(p, file);
        if (selectedWorkingFile?.path === file) setSelectedWorkingFile(null);
        realCache.current.delete(p);
        setReloadTick((n) => n + 1);
        toast.success(untracked ? tf("已删除 {0}", file) : tf("已丢弃 {0} 的更改", file));
      },
    });
  };

  // Reset the whole working tree: revert tracked files + remove untracked ones.
  const doDiscardAll = () => {
    if (!activeProject) return;
    const p = activeProject.path;
    setConfirmState({
      title: tx("全部重置"),
      message: tx("将丢弃工作区的所有更改:已跟踪文件恢复到 HEAD,未跟踪文件被删除(reset --hard + clean -fd)。此操作不可撤销。"),
      confirmLabel: tx("全部重置"),
      onConfirm: async () => {
        await discardAll(p);
        setSelectedWorkingFile(null);
        realCache.current.delete(p);
        setReloadTick((n) => n + 1);
        toast.success(tx("已重置工作区"));
      },
    });
  };

  // The actual switch (from the dialog when dirty, or directly when clean).
  const performCheckout = async (branch: string, stash: boolean) => {
    if (!activeProject || gitBusy || busyLabel) return;
    const p = activeProject.path;
    const projectId = activeProject.id;
    setCheckoutTarget(null);
    beginOperationDisplay({
      kind: "other",
      title: tf("正在切换到 {0}…", branch),
      context: { project: activeProject.name, path: p, branch: currentBranch, target: branch },
    });
    setBusyLabel(tf("正在切换到 {0}…", branch));
    let outcome: Exclude<OperationOutcome, "running"> = "success";
    let outcomeTitle = tf("已切换到 {0}", branch);
    let outcomePhase = tx("工作区已更新");
    try {
      if (stash) await stashPush(p, `GitKit: 切换到 ${branch} 前的改动`);
      await checkoutBranch(p, branch);
      setProjects((prev) => prev.map((project) => project.id === projectId ? { ...project, branch } : project));
      realCache.current.delete(p);
      if (activePathRef.current === p) {
        setCurrentBranch(branch);
        pendingViewReset.current = true;   // branch changed → reset to the new branch
        setReloadTick((n) => n + 1);
      }
      toast.success(stash ? tf("已储藏改动并切换到 {0}", branch) : tf("已切换到 {0}", branch));
      if (stash) outcomeTitle = tf("已储藏并切换到 {0}", branch);
    } catch (e) {
      outcome = "error";
      outcomeTitle = tx("切换失败");
      outcomePhase = String(e);
    } finally {
      setBusyLabel(null);
      settleOperationDisplay(outcome, outcomeTitle, outcomePhase);
    }
  };

  // ── branch checkout (double-click a branch) ──
  // Clean tree → switch straight away (no confirm); dirty → ask (to offer stash).
  const requestCheckout = async (branch: string) => {
    if (!isReal || !activeProject) { toast(tx("仅真实仓库支持切换分支")); return; }
    if (gitBusy || busyLabel) return;
    if (branch === currentBranch) return;
    // git refuses to check out a branch that another worktree already holds.
    const wt = branches.find((b) => b.name === branch)?.worktree;
    if (wt) { toast(tf("分支 {0} 正被工作树占用：{1}", branch, wt)); return; }
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
    if (!isReal || !activeProject) { toast(tx("仅真实仓库支持此操作")); return; }
    if (gitBusy || busyLabel) return;
    if (branches.some((b) => b.name === leaf)) { requestCheckout(leaf); return; }
    const tid = toast.loading(tf("正在将 {0}/{1} 同步到本地…", remoteName, leaf));
    try {
      await createBranch(activeProject.path, leaf, `${remoteName}/${leaf}`, true);
      setCurrentBranch(leaf);
      setProjects((prev) => prev.map((p) => p.id === activeProjectId ? { ...p, branch: leaf } : p));
      realCache.current.delete(activeProject.path);
      pendingViewReset.current = true;
      setReloadTick((n) => n + 1);
      toast.success(tf("已创建本地分支 {0} 并检出", leaf), { id: tid });
    } catch (e) { toast.error(tf("同步失败：{0}", e), { id: tid }); }
  };

  // Create a local branch tracking the remote WITHOUT switching to it (the
  // right-click "只建不切" option). Only offered when no local branch exists yet.
  const createLocalFromRemote = async (remoteName: string, leaf: string) => {
    if (!activeProject || gitBusy || busyLabel) return;
    const tid = toast.loading(tf("正在创建本地分支 {0}…", leaf));
    try {
      await createBranch(activeProject.path, leaf, `${remoteName}/${leaf}`, false);
      realCache.current.delete(activeProject.path);
      setReloadTick((n) => n + 1);
      toast.success(tf("已创建本地分支 {0}", leaf), { id: tid });
    } catch (e) { toast.error(tf("创建失败：{0}", e), { id: tid }); }
  };

  // ── local-branch rename / delete (sidebar right-click) ──
  // Only local-only branches (no upstream) are renamable/deletable — a branch
  // already synced to a remote is left alone to avoid diverging from origin.
  const doRenameBranch = async (newName: string) => {
    if (!renameTarget || !activeProject) return;
    const b = renameTarget;
    const p = activeProject.path;
    setRenameTarget(null);
    const tid = toast.loading(tf("正在重命名 {0} → {1}…", b.name, newName));
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
      toast.success(tf("已重命名为 {0}", newName), { id: tid });
    } catch (e) { toast.error(tf("重命名失败：{0}", e), { id: tid }); }
  };

  const requestDeleteBranch = (b: Branch) => {
    if (!isReal || !activeProject) { toast(tx("仅真实仓库支持删除分支")); return; }
    if (b.current) { toast(tx("无法删除当前所在分支,请先切换到其它分支")); return; }
    if (b.remote) { toast(tx("该分支已与远端同步,不可删除")); return; }
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
      toast.success(tf("已删除分支 {0}", b.name));
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
        toast.error(tf("删除失败：{0}", e));
      }
    } finally {
      setDeleteBranchBusy(false);
    }
  };

  const requestCherryPick = (commit: Commit) => setCherryTarget(commit);
  // Cherry-pick entry from the ActionBar: needs a commit open in the detail view.
  const requestCherryPickActive = () => {
    if (detailOpen && !viewChanges && selectedCommit) requestCherryPick(selectedCommit);
    else toast(tx("请先选中要 cherry-pick 的提交"));
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
    } catch (e) { toast.error(tf("遴选预检失败：{0}", e)); }
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
        toast.warning(tf("遴选遇到冲突：{0} 个文件待解决,解决后执行 git cherry-pick --continue", res.conflicts.length));
      } else {
        toast.success(tf("已遴选 {0} 到 {1}", c.hash, target));
      }
    } catch (e) { toast.error(tf("遴选失败：{0}", e)); }
  };

  // Create merge/pull request.
  const [prOpen, setPrOpen] = useState(false);
  const prInfo = (() => {
    const originUrl = remotes.find((r) => r.name === "origin")?.url ?? remotes[0]?.url ?? "";
    const host = hostOf(originUrl);
    // GitHub token/instance is resolved at submit time (may prompt among accounts).
    if (githubCandidates(originUrl).length) return { provider: "github" as const, instanceUrl: "", token: "", remoteUrl: originUrl, term: tx("拉取请求") };
    const gl = loadGitlab();
    if (gl.token && (!gl.url || host === hostOf(gl.url))) return { provider: "gitlab" as const, instanceUrl: gl.url, token: gl.token, remoteUrl: originUrl, term: tx("合并请求") };
    return null;
  })();
  const requestCreatePR = () => {
    if (!activeProject) return;
    if (!prInfo) { toast(tx("请先在设置中配置 GitLab 或 GitHub 令牌")); return; }
    setPrOpen(true);
  };
  const doCreatePR = async (source: string, target: string, title: string, description: string) => {
    if (!prInfo) return;
    let instanceUrl = prInfo.instanceUrl;
    let token = prInfo.token;
    // GitHub: pick the account matching origin (prompts when several match).
    if (prInfo.provider === "github") {
      const resolved = await resolveRemoteToken(prInfo.remoteUrl, tx("创建拉取请求"));
      if (!resolved || !resolved.token) return; // cancelled, or no token configured
      token = resolved.token;
      instanceUrl = resolved.account?.url ?? "";
    }
    const tid = toast.loading(tx("正在创建…"));
    try {
      const url = await createPullRequest({
        provider: prInfo.provider, instanceUrl, remoteUrl: prInfo.remoteUrl,
        token, source, target, title, description,
      });
      setPrOpen(false);
      toast.success(tf("已创建{0},正在浏览器打开", prInfo.term), { id: tid, description: url });
    } catch (e) {
      toast.error(tf("创建失败：{0}", e), { id: tid });
      throw e; // keep the dialog open so the user can retry
    }
  };

  const handleSelectProject = (id: string) => {
    setActiveProjectId(id);
  };

  const handlePinProject = (project: Project) => {
    if (projects[0]?.id === project.id) {
      toast(tf("{0} 已在顶部", project.name));
      return;
    }
    setProjects((prev) => {
      const index = prev.findIndex((item) => item.id === project.id);
      if (index <= 0) return prev;
      return [prev[index], ...prev.slice(0, index), ...prev.slice(index + 1)];
    });
    toast.success(tf("已置顶 {0}", project.name));
  };

  const handleRevealProject = async (project: Project) => {
    try {
      await revealInFileManager(project.path);
    } catch (error) {
      toast.error(tf("无法打开仓库目录：{0}", error));
    }
  };

  const handleCopyProjectName = async (project: Project) => {
    try {
      await navigator.clipboard.writeText(project.name);
      toast.success(tf("已复制项目名称：{0}", project.name));
    } catch (error) {
      toast.error(tf("复制项目名称失败：{0}", error));
    }
  };

  const handleOpenProjectRemote = async (project: Project) => {
    try {
      const url = await openRepositoryRemote(project.path);
      toast.success(tx("已在浏览器中打开远程仓库"), { description: url });
    } catch (error) {
      toast.error(tf("无法打开远程仓库：{0}", error));
    }
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
      const folder = await pickRepoFolder(tx("选择一个 Git 仓库文件夹"));
      if (!folder) return;
      const info = await openRepoAsProject(folder);
      toast.success(tf("已打开仓库：{0}", info.name));
    } catch (e) {
      toast.error(tf("打开失败：{0}", e));
    }
  };

  // Called by CloneDialog once the clone lands: open the fresh repo as a project.
  const handleCloneDone = async (clonedPath: string) => {
    setCloneOpen(false);
    try {
      await openRepoAsProject(clonedPath);
    } catch (e) {
      toast.error(tf("打开克隆的仓库失败：{0}", e));
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

          <TitleBar themeMode={themeMode} onThemeCycle={cycleTheme}
            onOpenSettings={() => setSettingsOpen(true)} />

          <ActionBar project={activeProject} branch={dataReady ? currentBranch : activeProject?.branch ?? ""}
            sidebarOpen={projectSidebarOpen} onToggleSidebar={() => setProjectSidebarOpen((open) => !open)}
            onCreateBranch={activeProject ? () => setCreateBranchOpen(true) : undefined}
            onFetch={activeProject && dataReady && !switching ? () => runGitAction("fetch") : undefined}
            onPull={activeProject && dataReady && !switching ? () => runGitAction("pull") : undefined}
            onPush={activeProject && dataReady && !switching ? () => runGitAction("push") : undefined}
            onCreateTag={activeProject ? () => setTagDialogOpen(true) : undefined}
            onCherryPick={activeProject ? requestCherryPickActive : undefined}
            onStash={activeProject ? requestStash : undefined}
            onCreatePR={activeProject ? requestCreatePR : undefined}
            pushCount={branches.find((b) => b.current)?.ahead ?? 0}
            busy={gitBusy ?? (busyLabel ? "other" : null)} />

          <div className="gk-workspace flex-1 min-h-0 overflow-hidden" data-projects-open={projectSidebarOpen}>
            <div className="gk-project-disclosure min-w-0 min-h-0 overflow-hidden" aria-hidden={!projectSidebarOpen}
              ref={(element) => { if (element) element.inert = !projectSidebarOpen; }}>
              <ProjectSidebar open={projectSidebarOpen} projects={projects} activeId={activeProject?.id ?? ""}
                onSelect={handleSelectProject} onClose={handleCloseProject}
                onContextMenu={(event, project) => openCtx(event, [
                  { label: tx("置顶"), Icon: Pin, onClick: () => handlePinProject(project) },
                  { sep: true },
                  { label: IS_WINDOWS ? tx("在文件资源管理器中打开所在目录") : tx("在访达中打开所在目录"), Icon: FolderOpen,
                    onClick: () => { void handleRevealProject(project); } },
                  { label: tx("复制项目名称"), Icon: Copy, onClick: () => { void handleCopyProjectName(project); } },
                  { sep: true },
                  { label: tx("在 GitHub / GitLab 中打开"), Icon: ExternalLink,
                    onClick: () => { void handleOpenProjectRemote(project); } },
                ])}
                onAdd={handleOpenNew} onClone={() => setCloneOpen(true)} />
            </div>
          {!activeProject ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4" style={{ background: theme.bg }}>
              <FolderOpen size={40} style={{ color: theme.textFaint, opacity: 0.4 }} />
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-medium" style={{ color: theme.textSec }}>{tx("还没有打开任何仓库")}</span>
                <span className="text-xs" style={{ color: theme.textFaint }}>{tx("打开一个 Git 仓库开始")}</span>
              </div>
              <div className="flex items-center gap-2.5">
                <button onClick={handleOpenNew}
                  className="flex items-center gap-2 px-4 py-2 cursor-pointer"
                  style={{ background: theme.accent, color: "#fff", borderRadius: R, fontSize: 13, fontWeight: 500 }}>
                  <Plus size={14} /> {tx("打开仓库")}
                </button>
                <button onClick={() => setCloneOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 cursor-pointer"
                  style={{ background: "transparent", color: theme.text, borderRadius: R, fontSize: 13, fontWeight: 500,
                    border: `0.5px solid ${theme.inputBorder}` }}>
                  <Cloud size={14} /> {tx("克隆仓库")}
                </button>
              </div>
            </div>
          ) : (
          <div className="gk-workspace-card flex flex-1 min-w-0 overflow-hidden"
            style={{ background: theme.bgPanel, boxShadow: theme.shadowEl }}>
            <Sidebar branches={branches} remotes={remotes} stashes={stashes}
              currentBranch={currentBranch} focusBranch={focusBranch}
              hidden={hiddenBranches} setHidden={updateHiddenBranches}
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
                  items.push({ label: tx("重命名分支"), Icon: Pencil, onClick: () => setRenameTarget(b) });
                  if (!b.current) {
                    // A worktree-held branch is still deletable — the dialog
                    // just adds the worktree removal as an explicit extra step.
                    items.push({
                      label: b.worktree ? tx("移除工作树并删除分支") : tx("删除分支"),
                      Icon: Trash2, danger: true, onClick: () => requestDeleteBranch(b),
                    });
                  }
                  items.push({ sep: true });
                }
                items.push({ label: tx("复制分支名"), Icon: Copy, onClick: () => { navigator.clipboard.writeText(b.name).catch(() => {}); } });
                openCtx(e, items);
              }}
              onSyncRemote={requestSyncRemote}
              onRemoteContext={(e, remoteName, leaf) => {
                const hasLocal = branches.some((b) => b.name === leaf);
                openCtx(e, [
                  hasLocal
                    ? { label: tf("切换到本地分支 {0}", leaf), Icon: GitBranch, onClick: () => requestSyncRemote(remoteName, leaf) }
                    : { label: tx("同步到本地并检出"), Icon: Download, onClick: () => requestSyncRemote(remoteName, leaf) },
                  ...(!hasLocal ? [{ label: tx("仅创建本地分支（不切换）"), Icon: GitBranchPlus, onClick: () => createLocalFromRemote(remoteName, leaf) } as CtxItem] : []),
                  { sep: true },
                  { label: tx("复制分支名"), Icon: Copy, onClick: () => { navigator.clipboard.writeText(`${remoteName}/${leaf}`).catch(() => {}); } },
                ]);
              }}
              onStashClick={openStash}
              onStashApply={doStashApply} onStashDrop={doStashDrop}
              onStashContext={(e, s) => openCtx(e, [
                { label: tx("应用到工作区"), Icon: RotateCcw, onClick: () => doStashApply(s.index) },
                { label: tx("删除储藏"), Icon: Trash2, danger: true, onClick: () => doStashDrop(s.index) },
              ])}
              selectedStashIndex={detailOpen && selectedStash ? selectedStash.index : null} />

            {/* Content area: full-width timeline with the detail as a sliding
                overlay on the right — the list never reflows, so opening detail
                animates smoothly and the left ~380px stays visible & clickable. */}
            <div className="relative flex-1 overflow-hidden">
            <div className="absolute inset-0 flex flex-col overflow-hidden">
              <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5"
                style={{ borderBottom: `0.5px solid ${theme.border}`, background: "transparent" }}>
                <span className="text-xs font-medium" style={{ color: theme.textSec }}>{tx("提交历史")}</span>
                {!focusActive && smartMergeResult.mergedGroups > 0 && (
                  <button type="button" aria-pressed={smartMerge}
                    title={tx("仅合并相同变更的展示，不会修改 Git 历史")}
                    onClick={() => startTransition(() => setSmartMerge((on) => !on))}
                    className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold cursor-pointer flex-shrink-0"
                    style={{
                      color: smartMerge ? theme.accent2Fg : theme.textMuted,
                      background: smartMerge ? theme.accent2Bg : theme.inputBg,
                      border: `0.5px solid ${smartMerge ? theme.accent2 + "66" : theme.inputBorder}`,
                      borderRadius: R - 3,
                    }}>
                    <Sparkles size={11} aria-hidden="true" />
                    {tx("智能合并")}
                    <span className="relative inline-flex flex-shrink-0"
                      style={{ width: 25, height: 15, borderRadius: 999,
                        background: smartMerge ? theme.accent2 : theme.textFaint,
                        transition: "background 0.14s" }}>
                      <span className="absolute rounded-full"
                        style={{ width: 11, height: 11, top: 2, left: smartMerge ? 12 : 2,
                          background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                          transition: "left 0.16s cubic-bezier(0.32,0.72,0,1)" }} />
                    </span>
                  </button>
                )}
                <span className="ml-auto text-[11px] tabular-nums" style={{ color: theme.textFaint }}>
                  {smartMergeActive
                      ? tf("{0} 个变更 · {1} 次提交", displayCommits.length, scopedCommits.length)
                      : tf("{0} 次提交", displayCommits.length)}
                </span>
              </div>
              {smartMergeActive && (
                <div className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5"
                  style={{ borderBottom: `0.5px solid ${theme.border}`, background: theme.accent2Bg }}>
                  <Check size={11} aria-hidden="true" style={{ color: theme.accent2 }} />
                  <span className="text-[11px] truncate" style={{ color: theme.accent2Fg }}>
                    {tx("已将")} {smartMergeResult.mergedGroups} {tx("组相同变更合并展示，不会修改 Git 历史")}
                  </span>
                  <button type="button" onClick={() => startTransition(() => setSmartMerge(false))}
                    className="ml-auto text-[11px] cursor-pointer flex-shrink-0"
                    style={{ color: theme.accent2Fg }}>
                    {tx("查看原始提交")}
                  </button>
                </div>
              )}
              {focusActive && (
                <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5"
                  style={{ borderBottom: `0.5px solid ${theme.border}`, background: theme.accentBg }}>
                  <GitBranch size={11} style={{ color: theme.accent }} />
                  <span className="text-[11px] flex-1 truncate" style={{ color: theme.accentFg }}>
                    {tx("只看分支")} {focusBranch}
                  </span>
                  <button onClick={() => setFocus(null)}
                    className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] cursor-pointer"
                    style={{ color: theme.accent, borderRadius: R - 4 }}>
                    <X size={10} /> {tx("全部视图")}
                  </button>
                </div>
              )}
              <div ref={timelineScrollRef} className="flex-1 overflow-y-auto"
                aria-busy={!dataReady || switching || branchViewLoading}
                style={{ overscrollBehaviorY: "none" }}>
                {errored ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center" style={{ color: theme.red }}>
                    <span className="text-xs font-medium">{tx("读取失败")}</span>
                    <span className="text-[11px]" style={{ color: theme.textMuted }}>{loadError?.msg}</span>
                  </div>
                ) : (!dataReady || switching || branchViewLoading) ? (
                  <div className="gk-timeline-skeleton py-1" role="status" aria-label={tx("正在更新提交历史")}>
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
                  <div key={`${activeProject?.path}:${timelineHiddenBranches.join("\u0000")}`} className="gk-reveal">
                    {/* A branch sitting exactly on its base has no commits of its
                        own — say so instead of rendering an empty timeline. */}
                    {focusActive && displayCommits.length === 0 && (
                      <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-16 text-center">
                        <GitBranch size={18} style={{ color: theme.textFaint }} />
                        <span className="text-xs font-medium" style={{ color: theme.textSec }}>{tx("该分支还没有独立提交")}</span>
                        {focusInfo?.base && (
                          <span className="text-[11px]" style={{ color: theme.textMuted }}>
                            {tx("与")} {focusInfo.base} {tx("完全一致")}
                          </span>
                        )}
                      </div>
                    )}
                    <GlideList className="gk-commit-glide" insetY={2}
                      style={{ "--gk-glide-hover": theme.rowHover } as React.CSSProperties}>
                    {displayCommits.map((commit, i) => (
                      <CommitRow
                        // WKWebView can retain a content-visibility paint cache when
                        // the graph gutter changes width. Remount the row on layout
                        // changes so text and graph geometry paint together.
                        key={`${commit.fullHash}:${graphW}:${laneStep}`}
                        commit={commit}
                        branchContext={historyBranchContext(commit, displayCommits[i - 1])}
                        graphInfo={displayGraph[i]}
                        selected={detailOpen && !viewChanges && (commit.isStash
                          ? selectedStash?.index === commit.stashIndex
                          : selectedCommit?.fullHash === commit.fullHash
                            || commit.equivalentCommits?.some((c) => c.fullHash === selectedCommit?.fullHash) === true)}
                        highlight={hoverBranch != null && memberOf(commit).includes(hoverBranch)}
                        graphW={graphW}
                        laneStep={laneStep}
                        remoteNames={remoteNames}
                        smartExpanded={expandedSmartRows.has(commit.patchId ?? commit.fullHash)}
                        onToggleSmart={() => setExpandedSmartRows((previous) => {
                          const key = commit.patchId ?? commit.fullHash;
                          const next = new Set(previous);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        })}
                        onRelatedCommitClick={openTimelineCommit}
                        onBranchDblClick={doSyncBranch}
                        onClick={() => {
                          // A stash node opens the stash panel (apply/drop), not commit detail.
                          if (commit.isStash) {
                            openStash({ index: commit.stashIndex ?? 0, message: commit.message,
                              branch: commit.stashBranch ?? "", date: commit.date });
                            return;
                          }
                          openTimelineCommit(commit);
                        }}
                        onContextMenu={(e) => openCtx(e, commit.isStash
                          ? [
                              { label: tx("应用到工作区"), Icon: RotateCcw, onClick: () => doStashApply(commit.stashIndex ?? 0) },
                              { label: tx("删除储藏"), Icon: Trash2, danger: true, onClick: () => doStashDrop(commit.stashIndex ?? 0) },
                            ]
                          : [
                              { label: tx("复制提交哈希"), Icon: Copy, onClick: () => { navigator.clipboard.writeText(commit.fullHash).catch(() => {}); } },
                              ...(isReal ? [{ label: tx("遴选到当前分支"), Icon: GitCommit, onClick: () => requestCherryPick(commit) } as CtxItem] : []),
                            ])} />
                    ))}
                    </GlideList>
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
                      {tx("从")} <span className="font-medium" style={{ color: branchColor(focusInfo.base) }}>{focusInfo.base}</span> {tx("创建 · 点击查看该分支")}
                    </span>
                    <ChevronRight size={13} className="flex-shrink-0" style={{ color: theme.textFaint }} />
                  </button>
                )}
              </div>
            </div>

            {/* Keep timeline context when space allows; on narrower content
                areas, give the file list and diff the full available width. */}
            {(detailOpen || detailClosing) && dataReady && (
              <div ref={detailPanelRef} className={`absolute top-0 bottom-0 right-0 flex flex-col overflow-hidden ${detailOpen ? "gk-panel-in" : "gk-panel-out"}`}
                onAnimationEnd={() => { if (!detailOpen) setDetailClosing(false); }}
                style={{ width: "min(100%, max(760px, calc(100% - clamp(240px, 18vw, 300px))))", background: theme.bgPanel,
                  // Above the timeline's hover popovers (ref chips use z-index 50),
                  // so an expanded branch-ref overlay never bleeds over the panel.
                  zIndex: 60,
                  borderTopLeftRadius: 14,
                  borderBottomLeftRadius: 14,
                  borderLeft: `0.5px solid ${theme.border}`,
                  boxShadow: theme.isDark ? "-12px 0 34px rgba(0,0,0,0.32)" : "-12px 0 34px rgba(0,0,0,0.10)" }}>
                <div className="flex-shrink-0 flex items-center gap-1 px-2.5 py-2"
                  style={{ borderBottom: `0.5px solid ${theme.border}`, ...glassStyle(theme) }}>
                  <button {...press(closeDetail)}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium cursor-pointer"
                    style={{ color: theme.textMuted, borderRadius: R - 3 }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = theme.inputBg; e.currentTarget.style.color = theme.text; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textMuted; }}>
                    <ChevronLeft size={14} /> {tx("返回")}
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
                          if (path) applyWorkingStatusRef.current(path, f);
                          setSelectedWorkingFile(null);
                        }} />
                      {selectedWorkingFile ? (
                        <WorkingFileDiff file={selectedWorkingFile} repoPath={isReal ? path ?? "" : ""} />
                      ) : (
                        <div className="flex-1 flex flex-col items-center justify-center gap-2"
                          style={{ background: theme.bgPanel, color: theme.textFaint }}>
                          <FileText size={32} opacity={0.18} />
                          <span className="text-xs">{tx("选择一个文件查看差异")}</span>
                        </div>
                      )}
                    </>
                  ) : selectedStash ? (
                    <StashDetail stash={selectedStash} files={selectedStash.files}
                      selectedFile={selectedStashFile} onFileSelect={selectStashFile}
                      repoPath={isReal ? path ?? "" : ""}
                      onApply={() => doStashApply(selectedStash.index)}
                      onDrop={() => doStashDrop(selectedStash.index)} />
                  ) : selectedCommit ? (
                    <CommitDetail commit={selectedCommit} selectedFile={selectedFile}
                      onFileSelect={selectDetailFile}
                      repoPath={isReal ? path ?? "" : ""}
                      onRevealFile={isReal ? revealCommitFile : undefined}
                      onCherryPick={isReal ? () => requestCherryPick(selectedCommit) : undefined}
                      checkoutBranch={isReal ? syncTargetOf(selectedCommit) : null}
                      onCheckout={isReal ? () => doCheckoutSync(selectedCommit) : undefined} />
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center gap-2"
                      style={{ background: theme.bgPanel, color: theme.textFaint }}>
                      <GitCommit size={30} opacity={0.18} />
                      <span className="text-xs">{tx("选择一个提交查看详情")}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
            </div>
          </div>
          )}
          </div>
          <StatusBar project={activeProject} branch={branches.find((b) => b.current)} changes={changesCount}
            ready={dataReady} errored={errored}
            checkProgress={checkProgress} checkResult={checkSnapshot?.result ?? null}
            onShowCheckResult={() => { if (!pullBusy && checkSnapshot?.result) showCheckResult(checkSnapshot.result); }}
            onShowChanges={() => { setViewChanges(true); setSelectedWorkingFile(null); setSelectedStash(null); setSelectedStashFile(null); openDetail(); }}
            onSearch={() => setSearchOpen(true)} />
        </div>

        {searchOpen && activeProject && (
          <CommitSearchDialog key={activeProject.id} commits={commits}
            ready={dataReady} errored={errored} onClose={() => setSearchOpen(false)}
            onSelect={(commit) => {
              setSearchOpen(false);
              if (commit.isStash) {
                void openStash({ index: commit.stashIndex ?? 0, message: commit.message,
                  branch: commit.stashBranch ?? "", date: commit.date });
                return;
              }
              openTimelineCommit(commit);
            }} />
        )}

        {settingsOpen && (
          <SettingsDialog identities={identities} setIdentities={setIdentities}
            defaultId={defaultIdentityId} setDefaultId={setDefaultIdentityId}
            paletteId={paletteId} setPaletteId={setPaletteId}
            themeMode={themeMode} setThemeMode={setThemeMode}
            language={language} setLanguage={changeLanguage}
            dailyCheck={dailyCheck} setDailyCheck={setDailyCheck}
            onRunCheckNow={() => void runUpdateCheck()}
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
            title={deleteBranchTarget.worktree ? tx("移除工作树并删除分支")
              : deleteBranchTarget.force ? tx("强制删除分支") : tx("删除分支")}
            message={deleteBranchTarget.worktree
              ? tf("分支 {0} 正被工作树占用：\n{1}\n\n继续将先移除该工作树，其中所有未提交的改动会永久丢失；若有程序（如 Claude Code 会话）正在使用它，也会一并中断。之后再删除分支{2}。", deleteBranchTarget.branch.name, deleteBranchTarget.worktree, deleteBranchTarget.force ? tx("（含未合并的提交）") : "")
              : deleteBranchTarget.force
              ? tf("分支 {0} 有未合并的提交,强制删除会永久丢失这些提交。确定继续?", deleteBranchTarget.branch.name)
              : tf("将删除本地分支 {0}。", deleteBranchTarget.branch.name)}
            confirmLabel={deleteBranchTarget.worktree ? tx("移除工作树并删除")
              : deleteBranchTarget.force ? tx("强制删除") : tx("删除")}
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
          <Modal title={tf("切换到 {0}", checkoutTarget.branch)} Icon={GitBranch}
            onClose={() => setCheckoutTarget(null)} width={440}
            footer={
              <>
                <button {...press(() => setCheckoutTarget(null))}
                  className="px-3.5 py-2 text-xs font-medium cursor-pointer"
                  style={{ color: theme.textMuted, borderRadius: R - 2, border: `0.5px solid ${theme.inputBorder}` }}>{tx("取消")}</button>
                {checkoutTarget.dirty && (
                  <button {...press(() => doCheckout(false))}
                    className="px-3.5 py-2 text-xs font-medium cursor-pointer"
                    style={{ color: theme.textSec, borderRadius: R - 2, background: theme.inputBg, border: `0.5px solid ${theme.inputBorder}` }}>{tx("仍然切换")}</button>
                )}
                <button {...press(() => doCheckout(checkoutTarget.dirty))}
                  className="px-3.5 py-2 text-xs font-semibold cursor-pointer"
                  style={{ color: "#fff", borderRadius: R - 2, background: checkoutTarget.dirty ? theme.amber : theme.accent }}>
                  {checkoutTarget.dirty ? tx("储藏并切换") : tx("切换")}
                </button>
              </>
            }>
            <div className="flex items-start gap-2.5">
              {checkoutTarget.dirty
                ? <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" style={{ color: theme.amber }} />
                : <GitBranch size={15} className="flex-shrink-0 mt-0.5" style={{ color: theme.accent }} />}
              <span className="text-xs leading-relaxed" style={{ color: theme.textSec }}>
                {tx("当前分支")} {currentBranch}。{checkoutTarget.dirty
                  ? tx("有未提交的更改,直接切换可能失败或影响改动,建议先储藏(stash)。")
                  : tx("工作区干净,可以直接切换分支。")}
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

        {/* Non-blocking operation status: repo browsing stays available while
            mutation controls remain globally locked by gitBusy / busyLabel. */}
        {operationDisplay && (
          <OperationCapsule
            kind={operationDisplay.kind}
            title={operationDisplay.title}
            context={operationDisplay.context}
            progress={operationDisplay.progress}
            outcome={operationDisplay.outcome}
            settledPhase={operationDisplay.phase}
            cancelling={cancelling}
            closing={operationClosing}
            onCancel={cancelGitAction}
            onEngagementChange={setOperationEngaged} />
        )}

        {ctxMenu && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
        )}
    </ThemeCtx.Provider>
  );
}
