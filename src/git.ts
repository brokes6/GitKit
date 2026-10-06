// GitKit — frontend Git API. Wraps the Rust `invoke` commands and maps their
// output into the shapes the existing UI components already consume.

import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { translateNativeMessage } from "./i18n.ts";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Branch,
  Author,
  Commit,
  CommitFile,
  GraphRowInfo,
  Remote,
} from "./App";
import { mapWorkingStatus } from "./workingStatus.ts";
import type { WorkingFile, StagingStatus, WorkingStatusSnapshot } from "./workingStatus";
import type { ProjectOverviewSummary, ProjectStatusSummary } from "./projectOverview";
import type { ProjectActivitySummary } from "./projectActivity";

export function loadProjectOverview(path: string): Promise<ProjectOverviewSummary> {
  return invoke<ProjectOverviewSummary>("git_project_overview", { path });
}

export function loadProjectStatusSummary(path: string): Promise<ProjectStatusSummary> {
  return invoke<ProjectStatusSummary>("git_project_status_summary", { path });
}

export function configureProjectWatch(paths: string[], foreground: boolean, revision: number): Promise<{ failedPaths: string[]; revision: number }> {
  return invoke("project_watch_configure", { paths, foreground, revision });
}

export function loadProjectActivity(path: string, fromTimestamp: number, toTimestamp: number, authorEmails: readonly string[]): Promise<ProjectActivitySummary> {
  return invoke<ProjectActivitySummary>("git_project_activity", { path, fromTimestamp, toTimestamp, authorEmails });
}

/** Keep native errors local to the active UI language without changing payloads. */
export async function invoke<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args, options);
  } catch (error) {
    throw typeof error === "string" ? translateNativeMessage(error) : error;
  }
}

// ── Rust-facing types ──────────────────────────────────────────────────────
export interface RepoInfo {
  path: string;
  name: string;
  current_branch: string;
  initialized: boolean;
  has_head: boolean;
}
export interface WorkingTreeChanged {
  path: string;
  paths: string[];
  full: boolean;
}
interface RCommit {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  date: string;
  committer_date: string;
  patch_id: string | null;
  refs: string[];
  subject: string;
  body: string;
  is_stash: boolean;
  stash_index: number | null;
  stash_branch: string | null;
}
interface RBranch {
  name: string;
  short_hash: string;
  head_hash: string;
  upstream: string | null;
  current: boolean;
  ahead: number;
  behind: number;
  is_remote: boolean;
  worktree: string | null;
}
interface RFileStat {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────
// Branch / lane / author palette. Warm-biased and muted to sit inside the Claude
// terracotta theme: cool hues (blue/teal/plum) are grayed so they read as part of
// the same earthy family instead of clashing neon. Mid lightness → legible on both
// the dark and the cream backgrounds. Kept in sync with LANE_COLORS in App.tsx.
// Branch identity palette — one fixed colour per branch, SHARED by the label
// capsule, the graph lane line, and the sidebar dot (all resolve through
// branchColor). Chosen for high hue separation so branches are told apart at a
// glance and a lane can be traced by colour; each hue reads the same as a 2px
// line, a thin outline, and a dot on both dark and light backgrounds.
// Kept in sync with LANE_COLORS in App.tsx.
const PALETTE = [
  "#5E78C7", // blue
  "#B78338", // amber
  "#4F8A6B", // green
  "#B95D58", // red
  "#7D70AE", // purple
  "#4E8989", // teal
  "#B66C4C", // orange
  "#A56380", // pink
];

export function authorColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export function authorInitials(name: string): string {
  const s = name.trim();
  return s ? s.charAt(0).toUpperCase() : "?";
}
// "HEAD -> main", "tag: v1.0", "origin/main" → ["HEAD","main"] / ["v1.0"] / ["origin/main"]
function cleanRefs(refs: string[]): string[] {
  const out: string[] = [];
  for (const r of refs) {
    if (!r) continue;
    // Stash refs are rendered as a dedicated node, not a branch/tag pill.
    if (r === "refs/stash" || r.startsWith("stash@")) continue;
    if (r.includes("->")) r.split("->").forEach((x) => out.push(x.trim()));
    else if (r.startsWith("tag: ")) out.push(r.slice(5).trim());
    else out.push(r);
  }
  return out;
}

const NEUTRAL = "#8A857C";

/** Stable colour for a branch name — shared by the sidebar dots and the graph. */
export function branchColor(name: string): string {
  if (!name) return NEUTRAL;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// ── graph layout: assign lanes from parent topology (commits are topo-ordered,
//    newest first, so every child is processed before its parents). Each drawn
//    element is coloured by the branch it belongs to (via commit.branchLabel). ──
export function computeGraph(commits: Commit[]): GraphRowInfo[] {
  const byHash = new Map(commits.map((c) => [c.fullHash, c]));
  const indexByHash = new Map(commits.map((c, index) => [c.fullHash, index]));
  const colorOf = (hash: string | null | undefined): string =>
    hash ? branchColor(byHash.get(hash)?.branchLabel ?? "") : NEUTRAL;

  const lanes: (string | null)[] = []; // lanes[i] = commit hash that lane i currently heads toward
  const rows: GraphRowInfo[] = [];
  const freeLane = (): number => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (let commitIndex = 0; commitIndex < commits.length; commitIndex++) {
    const c = commits[commitIndex];
    // A downward graph can only connect to parents that are still ahead in the
    // displayed order. Ignore truncated parents and defensively drop a reversed
    // edge instead of leaving a lane open forever at the bottom of the list.
    const parents = c.parents.filter((parent) => {
      const parentIndex = indexByHash.get(parent);
      return parentIndex !== undefined && parentIndex > commitIndex;
    });
    const expecting: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.fullHash) expecting.push(i);
    });

    let dotLane: number;
    let hasTopLine: boolean;
    const topMerges: { fromLane: number; toLane: number }[] = [];
    const top: string[] = [];

    if (expecting.length === 0) {
      dotLane = freeLane();
      hasTopLine = false;
    } else {
      dotLane = expecting[0];
      hasTopLine = true;
      for (let k = 1; k < expecting.length; k++) {
        topMerges.push({ fromLane: expecting[k], toLane: dotLane });
        top.push(colorOf(c.fullHash));
        lanes[expecting[k]] = null;
      }
    }

    const mergedIn = new Set(expecting.slice(1));
    const passthrough: number[] = [];
    const pass: Record<number, string> = {};
    lanes.forEach((h, i) => {
      if (i === dotLane || h === null || mergedIn.has(i)) return;
      passthrough.push(i);
      pass[i] = colorOf(h);
    });

    const bottomBranches: { fromLane: number; toLane: number }[] = [];
    const bottom: string[] = [];
    let hasBottomLine = false;

    if (parents.length === 0) {
      lanes[dotLane] = null;
    } else {
      const fp = parents[0];
      const existing = lanes.findIndex((h, i) => h === fp && i !== dotLane);
      if (existing !== -1) {
        bottomBranches.push({ fromLane: dotLane, toLane: existing });
        bottom.push(colorOf(fp));
        lanes[dotLane] = null;
      } else {
        lanes[dotLane] = fp;
        hasBottomLine = true;
      }
      for (let k = 1; k < parents.length; k++) {
        const p = parents[k];
        let ex = lanes.findIndex((h) => h === p);
        if (ex === -1) {
          ex = freeLane();
          lanes[ex] = p;
        }
        bottomBranches.push({ fromLane: dotLane, toLane: ex });
        bottom.push(colorOf(p));
      }
    }

    const dotColor = colorOf(c.fullHash);
    rows.push({
      passthrough,
      dotLane,
      hasTopLine,
      hasBottomLine,
      topMerges,
      bottomBranches,
      isMerge: parents.length > 1,
      colors: { dot: dotColor, line: dotColor, pass, top, bottom },
    });
  }
  return rows;
}

// ── public API ───────────────────────────────────────────────────────────────

/** Native folder picker. Returns the chosen path, or null if cancelled. */
export async function pickRepoFolder(title = "选择一个 Git 仓库文件夹"): Promise<string | null> {
  const sel = await openDialog({
    directory: true,
    multiple: false,
    title,
  });
  return typeof sel === "string" ? sel : null;
}

export async function openRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("open_repo", { path });
}

/** Initialize only after the user agrees in the project dialog. */
export async function initRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("git_init", { path });
}

/** Reveal a file in Finder / Explorer, or open the repository folder when no
 *  file is selected. Missing historical files fall back to an existing parent. */
export async function revealInFileManager(path: string, file?: string): Promise<void> {
  await invoke("reveal_in_file_manager", { path, file: file ?? null });
}

/** Open origin (or the first web-compatible remote) in the system browser. */
export async function openRepositoryRemote(path: string): Promise<string> {
  return invoke<string>("open_repository_remote", { path });
}

/** Start watching a repo's working tree; the backend emits `working-tree-changed`
 *  (payload = the repo path) for worktree edits and status-relevant Git metadata.
 *  Idempotent. */
export async function startWatch(path: string): Promise<void> {
  await invoke("start_watch", { path });
}

/** Stop watching a repo's working tree. */
export async function stopWatch(path: string): Promise<void> {
  await invoke("stop_watch", { path });
}

/** Native folder picker for the destination a repo will be cloned INTO (the
 *  parent directory). Returns the chosen path, or null if cancelled. */
export async function pickCloneParent(title = "选择克隆到的文件夹"): Promise<string | null> {
  const sel = await openDialog({
    directory: true,
    multiple: false,
    title,
  });
  return typeof sel === "string" ? sel : null;
}

/** The folder name a clone URL would produce — last path segment, ".git" stripped.
 *  Handles "https://host/g/repo.git" and "git@host:g/repo.git". Falls back to "repo". */
export function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  const name = last.replace(/\.git$/i, "").trim();
  return name || "repo";
}

/** One streamed progress update from a running clone. `percent` is null on lines
 *  that carry no percentage (kept in sync with Rust's CloneProgress). */
export interface CloneProgress {
  phase: string;
  percent: number | null;
  raw: string;
}

/** Clone `url` into a new subfolder of `dest`, streaming progress via `onProgress`.
 *  Resolves to the cloned repository's absolute path. `token` (optional)
 *  authenticates HTTPS; SSH uses the user's keys. */
export async function cloneRepo(
  url: string,
  dest: string,
  token: string | undefined,
  onProgress: (p: CloneProgress) => void,
): Promise<string> {
  const channel = new Channel<CloneProgress>();
  channel.onmessage = onProgress;
  return invoke<string>("git_clone", { url, dest, token: token ?? null, onProgress: channel });
}

export async function loadBranches(path: string, includeRemote = false): Promise<Branch[]> {
  const raw = await invoke<RBranch[]>("git_branches", { path });
  return raw
    .filter((b) => (!b.is_remote || includeRemote) && !b.name.endsWith("/HEAD"))
    .map((b) => ({
      name: b.name,
      remote: b.upstream ?? undefined,
      ahead: b.ahead,
      behind: b.behind,
      current: b.current,
      isRemote: b.is_remote,
      color: branchColor(b.name),
      head: b.head_hash,
      worktree: b.worktree ?? undefined,
    }));
}

// Attribute commits to branches by walking each branch tip's first-parent chain
// (current branch first). Two outputs:
//  • `branchLabel`  — the single owning branch, partitioned so lanes get one
//    stable colour (a commit is claimed by the highest-priority branch first).
//  • `branchLabels` — every branch whose first-parent backbone contains the
//    commit. A commit can sit on several branches at once; this drives the
//    multi-branch row footer and the "只看分支" (focus) filter, so focusing a
//    branch shows its whole backbone even when another branch claimed the colour.
export function attributeBranches(commits: Commit[], branches: Branch[]): void {
  const byHash = new Map(commits.map((c) => [c.fullHash, c]));
  const order = branches.filter((b) => !b.isRemote || !b.name.endsWith("/HEAD"))
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(!!a.isRemote) - Number(!!b.isRemote));
  // Use the configured upstream, not a matching leaf name: separate remotes
  // may have unrelated branches with the same name. Tracking aliases share an
  // identity so hiding a local branch also hides its upstream-only continuation.
  const trackingNames = new Map<string, string>();
  for (const b of order) {
    if (!b.isRemote && b.remote && !trackingNames.has(b.remote)) trackingNames.set(b.remote, b.name);
  }
  const labelFor = (b: Branch) => b.isRemote ? trackingNames.get(b.name) ?? b.name : b.name;
  for (const c of commits) {
    c.branchLabel = undefined;
    c.branchLabels = [];
  }

  // primary label — first branch to reach a commit claims it
  const claimed = new Set<string>();
  for (const b of order) {
    let h = b.head;
    while (h && byHash.has(h) && !claimed.has(h)) {
      claimed.add(h);
      const c = byHash.get(h)!;
      c.branchLabel = labelFor(b);
      h = c.parents[0];
    }
  }

  // full membership — every branch's complete first-parent backbone
  for (const b of order) {
    const name = labelFor(b);
    let h = b.head;
    const seen = new Set<string>();
    while (h && byHash.has(h) && !seen.has(h)) {
      seen.add(h);
      const c = byHash.get(h)!;
      if (!c.branchLabels!.includes(name)) c.branchLabels!.push(name);
      h = c.parents[0];
    }
  }
}

/**
 * Scope the all-branches timeline to the branches the user has left visible.
 *
 * Branch membership follows the first-parent backbones populated by
 * `attributeBranches`. Once branch filtering is active, commits that belong to
 * no displayed backbone are intentionally omitted as well: those are usually
 * merge-side commits from deleted or otherwise hidden topic branches, and
 * retaining them would recreate their graph lanes and gutter width.
 */
export function filterHistoryByHiddenBranches(commits: Commit[], hiddenBranchNames: string[]): Commit[] {
  if (hiddenBranchNames.length === 0) return commits;
  const hidden = new Set(hiddenBranchNames);
  const visible: Commit[] = [];

  for (const commit of commits) {
    if (commit.isStash) {
      visible.push(commit);
      continue;
    }
    const memberships = commit.branchLabels?.length
      ? commit.branchLabels
      : commit.branchLabel
        ? [commit.branchLabel]
        : [];
    const visibleMemberships = memberships.filter((name) => !hidden.has(name));
    if (visibleMemberships.length === 0) continue;

    const branchLabel = commit.branchLabel && !hidden.has(commit.branchLabel)
      ? commit.branchLabel
      : visibleMemberships[0];
    const tags = commit.tags?.filter((tag) => !hidden.has(tag));
    visible.push({ ...commit, branchLabel, branchLabels: visibleMemberships, tags });
  }
  return visible;
}

// Context for date-interleaved history. This describes first-parent ancestry,
// not a ref pointing at this commit; real tip badges and smart-merge footers
// already provide their own branch context.
export function historyBranchContext(commit: Commit, previous?: Commit): string | undefined {
  const name = commit.branchLabel;
  if (!name || commit.isStash || (commit.equivalentCommits?.length ?? 0) > 1) return undefined;
  if (commit.tags?.includes(name)) return undefined;
  if (previous && !previous.isStash && (previous.equivalentCommits?.length ?? 0) <= 1
    && previous.branchLabel === name) return undefined;
  return name;
}

interface RRemote { name: string; url: string }

export async function loadRemotes(path: string): Promise<Remote[]> {
  const [remotes, branches] = await Promise.all([
    invoke<RRemote[]>("git_remotes", { path }),
    invoke<RBranch[]>("git_branches", { path }),
  ]);
  const byRemote = new Map<string, string[]>();
  for (const b of branches) {
    if (!b.is_remote || b.name.endsWith("/HEAD")) continue;
    const slash = b.name.indexOf("/");
    if (slash < 0) continue;
    const rem = b.name.slice(0, slash);
    if (!byRemote.has(rem)) byRemote.set(rem, []);
    byRemote.get(rem)!.push(b.name.slice(slash + 1));
  }
  return remotes.map((r) => ({ name: r.name, url: r.url, branches: byRemote.get(r.name) ?? [] }));
}

export async function loadHistory(path: string): Promise<Commit[]> {
  const raw = await invoke<RCommit[]>("git_log", { path, limit: 400 });
  return raw.map((c) => ({
    hash: c.short_hash,
    fullHash: c.hash,
    // Strip git's auto "On <branch>: " / "WIP on <branch>: " prefix so a stash
    // reads as just its message, matching the collapsed single-node display.
    message: c.is_stash ? c.subject.replace(/^(WIP on|On) [^:]+: /, "") : c.subject,
    body: c.body ? c.body : undefined,
    isStash: c.is_stash,
    stashIndex: c.stash_index ?? undefined,
    stashBranch: c.stash_branch ?? undefined,
    author: {
      name: c.author_name,
      email: c.author_email,
      initials: authorInitials(c.author_name),
      color: authorColor(c.author_email),
    },
    date: c.date,
    committerDate: c.committer_date,
    patchId: c.patch_id ?? undefined,
    lane: 0,
    tags: cleanRefs(c.refs),
    parents: c.parents,
    stats: { additions: 0, deletions: 0, files: 0 },
    files: [],
  }));
}

export async function loadStatus(path: string): Promise<WorkingFile[]> {
  return (await loadWorkingStatus(path)).files;
}

export async function loadWorkingStatus(path: string, paths: string[] | null = null): Promise<WorkingStatusSnapshot> {
  const snapshot = await invoke<StagingStatus>("git_staging_status", { path, paths });
  return { files: mapWorkingStatus(snapshot), revision: snapshot.revision, full: snapshot.full ?? !paths?.length };
}

/** Status only for paths collected from one native watcher burst. */
export async function loadStatusPaths(path: string, paths: string[]): Promise<WorkingFile[]> {
  return (await loadWorkingStatus(path, paths)).files;
}

export async function stageFiles(path: string, files: string[]): Promise<WorkingFile[]> {
  return mapWorkingStatus(await invoke<StagingStatus>("git_stage_files", { path, files }));
}

export async function unstageFiles(path: string, files: string[]): Promise<WorkingFile[]> {
  return mapWorkingStatus(await invoke<StagingStatus>("git_unstage_files", { path, files }));
}

export async function loadCommitFiles(path: string, hash: string): Promise<CommitFile[]> {
  const raw = await invoke<RFileStat[]>("commit_files", { path, hash });
  return raw.map((f) => ({
    path: f.path,
    status:
      f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "R" ? "renamed" : "modified",
    additions: f.additions,
    deletions: f.deletions,
  }));
}

interface RFileHistoryEntry {
  hash: string; parents: string[];
  author_name: string; author_email: string; author_date: string;
  committer_name: string; committer_email: string; committer_date: string;
  subject: string; body: string; file: string; old_file: string | null;
  status: string; additions: number; deletions: number; binary: boolean;
}
export interface FileHistoryEntry {
  hash: string; fullHash: string; parents: string[];
  author: Author; date: string; committer: Author; committerDate: string;
  message: string; body: string; file: CommitFile; oldPath: string | null; binary: boolean;
}
export interface FileHistoryPage {
  revision: string; file: string; entries: FileHistoryEntry[]; nextOffset: number | null;
}
function traceAuthor(name: string, email: string): Author {
  return { name, email, initials: authorInitials(name), color: authorColor(email) };
}
function mapFileHistoryEntry(raw: RFileHistoryEntry): FileHistoryEntry {
  return {
    hash: raw.hash.slice(0,8), fullHash: raw.hash, parents: raw.parents,
    author: traceAuthor(raw.author_name,raw.author_email), date: raw.author_date,
    committer: traceAuthor(raw.committer_name,raw.committer_email), committerDate: raw.committer_date,
    message: raw.subject, body: raw.body, oldPath: raw.old_file, binary: raw.binary,
    file: { path: raw.file, status: raw.status === "A" ? "added" : raw.status === "D" ? "deleted" : raw.status === "R" ? "renamed" : "modified",
      additions: raw.additions, deletions: raw.deletions },
  };
}
export async function loadFileHistory(path: string, anchor: string, file: string, branch: string | null = null, offset = 0): Promise<FileHistoryPage> {
  const raw = await invoke<{ revision: string; file: string; entries: RFileHistoryEntry[]; next_offset: number | null }>("file_history", { path, anchor, file, branch, offset });
  return { revision: raw.revision, file: raw.file, entries: raw.entries.map(mapFileHistoryEntry), nextOffset: raw.next_offset };
}
export interface FileTraceDiff { commit: FileHistoryEntry; diff: string; parent: string | null }
export async function loadFileTraceDiff(path: string, hash: string, file: string, parentIndex = 0): Promise<FileTraceDiff> {
  const raw = await invoke<{ commit: RFileHistoryEntry; diff: string; parent: string | null }>("file_trace_diff", { path, hash, file, parentIndex });
  return { commit: mapFileHistoryEntry(raw.commit), diff: stripDiffHeader(raw.diff), parent: raw.parent };
}
export interface FileBlameLine {
  hash: string; file: string; line: number; original_line: number;
  author_name: string; author_email: string; author_date: string; summary: string; content: string;
}
export interface FileBlame { kind: FileContent["kind"]; lines: FileBlameLine[]; truncated: boolean }
export async function loadFileBlame(path: string, hash: string, file: string): Promise<FileBlame> {
  return invoke<FileBlame>("file_blame", { path, hash, file });
}

export interface DepInfo { name: string; found: boolean; version: string; path: string }

/** Probe the CLI dependencies GitKit relies on (git, git-lfs) on the app's PATH. */
export async function checkDeps(): Promise<DepInfo[]> {
  return invoke<DepInfo[]>("check_deps");
}

/** Discard working-tree changes to one file (revert tracked / delete untracked). */
export async function discardFile(path: string, file: string): Promise<void> {
  await invoke("git_discard_file", { path, file });
}

/** Discard ALL working-tree changes (reset --hard + clean -fd). Destructive. */
export async function discardAll(path: string): Promise<void> {
  await invoke("git_discard_all", { path });
}

export async function hasChanges(path: string): Promise<boolean> {
  return invoke<boolean>("git_has_changes", { path });
}

export async function checkoutBranch(path: string, branch: string): Promise<void> {
  await invoke("git_checkout", { path, branch });
}

export async function stashPush(path: string, message = "", name?: string, email?: string): Promise<void> {
  await invoke("git_stash_push", { path, message, name, email });
}

export interface MergePreview { conflict: boolean; files: string[] }
/** Preview whether merging `source` into `target` conflicts (no working-tree changes). */
export async function mergePreview(path: string, source: string, target: string): Promise<MergePreview> {
  return await invoke<MergePreview>("git_merge_preview", { path, source, target });
}

export interface LocalMergePreview {
  branch: string;
  head: string;
  source: string;
  sourceHead: string;
  kind: "up-to-date" | "fast-forward" | "merge";
  conflicts: string[];
  files: string[];
}

export interface RepositoryOperation {
  kind: "merge" | "cherry-pick" | "revert" | "rebase";
  branch: string;
  head: string;
  conflicts: string[];
  stagedFiles: string[];
  unstagedFiles: string[];
  message: string;
  /** Revision of the paused operation, index, and working tree reviewed by the UI. */
  revision: string;
  canContinue: boolean;
  /** An unsupported paused mode may require a terminal decision. */
  continueBlockedReason?: string | null;
  canAbort: boolean;
}

export interface LocalMergeResult {
  status: "up-to-date" | "merged" | "conflict";
  operation: RepositoryOperation | null;
}

/** Preview merging a branch into the current branch, requiring a clean repository. */
export async function localMergePreview(path: string, source: string): Promise<LocalMergePreview> {
  return invoke<LocalMergePreview>("git_local_merge_preview", { path, source });
}

/** Apply the exact source and destination commits reviewed in the merge preview. */
export async function mergeLocal(
  path: string, preview: LocalMergePreview, name?: string, email?: string,
): Promise<LocalMergeResult> {
  return invoke<LocalMergeResult>("git_local_merge", {
    path, source: preview.source, expectedBranch: preview.branch,
    expectedHead: preview.head, expectedSourceHead: preview.sourceHead,
    name: name ?? null, email: email ?? null,
  });
}

/** Read Git's operation metadata, including operations started outside GitKit. */
export async function loadRepoOperation(path: string): Promise<RepositoryOperation | null> {
  return invoke<RepositoryOperation | null>("git_operation_state", { path });
}

export async function continueMerge(
  path: string, expectedRevision: string, message: string, name?: string, email?: string,
): Promise<void> {
  await invoke("git_merge_continue", {
    path, expectedRevision, message, name: name ?? null, email: email ?? null,
  });
}

export async function abortMerge(path: string, expectedRevision: string): Promise<void> {
  await invoke("git_merge_abort", { path, expectedRevision });
}

/** Continue the reviewed cherry-pick, retaining the source message and author.
 * A remaining operation means the sequence has paused again. */
export async function continueCherryPick(
  path: string, expectedRevision: string, name?: string, email?: string,
): Promise<RepositoryOperation | null> {
  return invoke<RepositoryOperation | null>("git_cherry_pick_continue", {
    path, expectedRevision, name: name ?? null, email: email ?? null,
  });
}

export async function abortCherryPick(path: string, expectedRevision: string): Promise<void> {
  await invoke("git_cherry_pick_abort", { path, expectedRevision });
}

/** Resolve paused merge/cherry-pick conflicts without automatically committing. */
export async function mergeTool(path: string, expectedRevision: string): Promise<void> {
  await invoke("git_merge_tool", { path, expectedRevision });
}

export interface StashEntry { index: number; message: string; branch: string; date: string }
export async function stashList(path: string): Promise<StashEntry[]> {
  return await invoke("git_stash_list", { path });
}
export async function stashApply(path: string, index: number): Promise<void> {
  await invoke("git_stash_apply", { path, index });
}
export async function stashDrop(path: string, index: number): Promise<void> {
  await invoke("git_stash_drop", { path, index });
}
export async function stashFiles(path: string, index: number): Promise<CommitFile[]> {
  const raw = await invoke<RFileStat[]>("git_stash_files", { path, index });
  return raw.map((f) => ({
    path: f.path,
    status:
      f.status === "A" ? "added" : f.status === "D" ? "deleted" : f.status === "R" ? "renamed" : "modified",
    additions: f.additions,
    deletions: f.deletions,
  }));
}
export async function stashFileDiff(path: string, index: number, file: string): Promise<string> {
  const d = await invoke<string>("git_stash_file_diff", { path, index, file });
  return stripDiffHeader(d);
}

export interface CherryPickResult {
  /** "clean" — committed; "resolved" — Kaleidoscope resolved conflicts but the
   *  cherry-pick awaits review; "conflict" — unresolved files remain. */
  status: "clean" | "conflict" | "resolved";
  conflicts: string[];
}

/** Predict cherry-pick conflicts without touching the working tree. Returns the
 *  paths that would conflict (empty ⇒ applies cleanly). */
export async function cherryPickPreflight(path: string, hash: string, target?: string): Promise<string[]> {
  return invoke<string[]>("git_cherry_pick_preflight", { path, hash, target: target ?? null });
}

export async function cherryPick(
  path: string, hash: string, target?: string, useKaleidoscope = false,
): Promise<CherryPickResult> {
  return invoke<CherryPickResult>("git_cherry_pick", { path, hash, target: target ?? null, useKaleidoscope });
}

/** Create a merge/pull request; resolves to the created request's web URL (also opened in the browser). */
export async function createPullRequest(args: {
  provider: "gitlab" | "github"; instanceUrl: string; remoteUrl: string; token: string;
  source: string; target: string; title: string; description: string;
}): Promise<string> {
  return invoke<string>("create_pull_request", {
    provider: args.provider, instanceUrl: args.instanceUrl, remoteUrl: args.remoteUrl,
    token: args.token, source: args.source, target: args.target,
    title: args.title, description: args.description,
  });
}

/** Open a provider's token settings without forwarding the configured token. */
export function openProviderTokenSettings(provider: "gitlab" | "github", url: string, tokenKind?: string): Promise<string> {
  return invoke<string>("open_provider_token_settings", { provider, url, tokenKind: tokenKind ?? null });
}

export async function createBranch(
  path: string, name: string, base: string, checkout = true,
): Promise<void> {
  await invoke("git_create_branch", { path, name, base, checkout });
}

/** Delete a local branch. `force` (-D) drops unmerged commits; the default (-d)
 *  refuses when the branch isn't fully merged. Cannot delete the current branch. */
export async function deleteBranch(path: string, name: string, force = false): Promise<void> {
  await invoke("git_delete_branch", { path, name, force });
}

/** Remove a linked worktree (git worktree remove --force). Destructive: any
 *  uncommitted work inside that worktree is lost. Frees the branch it holds. */
export async function removeWorktree(path: string, worktree: string): Promise<void> {
  await invoke("git_remove_worktree", { path, worktree });
}

/** Rename a local branch (git branch -m). Works on the current branch too. */
export async function renameBranch(path: string, from: string, to: string): Promise<void> {
  await invoke("git_rename_branch", { path, from, to });
}

/** Check out `branch` and fast-forward it to `hash` (sync local up to a remote commit). */
export async function checkoutSync(path: string, branch: string, hash: string): Promise<void> {
  await invoke("git_checkout_sync", { path, branch, hash });
}

export async function commit(
  path: string, message: string, expectedRevision: string,
  name?: string, email?: string,
): Promise<void> {
  await invoke("git_commit", { path, message, expectedRevision, name: name ?? null, email: email ?? null });
}

export interface UndoCommitPreview {
  branch: string;
  head: string;
  subject: string;
  initial: boolean;
}

export async function undoCommitPreview(path: string): Promise<UndoCommitPreview> {
  return invoke<UndoCommitPreview>("git_undo_commit_preview", { path });
}

export async function undoLastCommit(path: string, preview: UndoCommitPreview): Promise<void> {
  await invoke("git_undo_last_commit", { path, expectedBranch: preview.branch, expectedHead: preview.head });
}

/**
 * What a fetch synced. Local branches strictly behind their upstream are
 * fast-forwarded; diverged ones are reported instead of touched, and the
 * current branch is skipped while the working tree is dirty.
 */
export interface FetchSummary {
  synced: string[];
  diverged: string[];
  dirtySkipped: boolean;
}

/** One streamed progress update from a running fetch/pull. `percent` is null on
 *  lines that carry no percentage (kept in sync with Rust's GitProgress). */
export interface GitProgress {
  phase: string;
  percent: number | null;
  raw: string;
}

/** Fetch all remotes, streaming progress via `onProgress`. `opId` identifies the
 *  op so it can be cancelled with {@link cancelGitOp}. */
export async function fetchAll(
  path: string,
  token: string | undefined,
  opId: string,
  onProgress: (p: GitProgress) => void,
): Promise<FetchSummary> {
  const channel = new Channel<GitProgress>();
  channel.onmessage = onProgress;
  return await invoke<FetchSummary>("git_fetch", { path, token: token ?? null, opId, onProgress: channel });
}

/** Pull the current branch, streaming progress via `onProgress`. `opId` identifies
 *  the op so it can be cancelled with {@link cancelGitOp}. */
export async function pull(
  path: string,
  token: string | undefined,
  opId: string,
  onProgress: (p: GitProgress) => void,
): Promise<void> {
  const channel = new Channel<GitProgress>();
  channel.onmessage = onProgress;
  await invoke("git_pull", { path, token: token ?? null, opId, onProgress: channel });
}

/** A local branch sitting behind its upstream, as seen by an update check. */
export interface BehindBranch {
  name: string; upstream: string; behind: number;
  /** Local-only commits — non-zero means diverged, so no fast-forward can apply it. */
  ahead: number;
  current: boolean;
}

/** What one repo's update check found. */
export interface UpdateCheck {
  behind: BehindBranch[];
  dirty: boolean;
  currentBranch: string;
}

/** Fetch remote-tracking refs and report which local branches fell behind. Never
 *  moves a local branch — {@link syncLocal} is the explicit apply step. */
export async function checkUpdates(path: string, token?: string): Promise<UpdateCheck> {
  return await invoke<UpdateCheck>("git_check_updates", { path, token: token ?? null });
}

/** Fast-forward local branches onto the upstreams a previous check already fetched. */
export async function syncLocal(path: string): Promise<FetchSummary> {
  return await invoke<FetchSummary>("git_sync_local", { path });
}

/** Cancel the entire fetch/pull by op id; rejects if it is no longer registered. */
export async function cancelGitOp(opId: string): Promise<void> {
  await invoke("git_cancel", { opId });
}

/** True when an error came from the user cancelling the op (vs a real failure). */
export function isCancelled(err: unknown): boolean {
  return String(err).includes("__cancelled__");
}

export async function push(path: string, token?: string): Promise<void> {
  await invoke("git_push", { path, token: token ?? null });
}

export interface ForcePushPreview {
  remote: string;
  remoteUrl: string | null;
  branch: string;
  remoteBranch: string;
  localHead: string;
  remoteHead: string;
  ahead: number;
  behind: number;
  sameTree: boolean;
  remoteCommits: string[];
}

export async function forcePushTarget(path: string): Promise<{ remote: string; branch: string }> {
  return await invoke("git_force_push_target", { path });
}

export async function forcePushPreview(path: string, token?: string): Promise<ForcePushPreview> {
  return await invoke<ForcePushPreview>("git_force_push_preview", { path, token: token ?? null });
}

export async function forcePush(path: string, preview: ForcePushPreview, token?: string): Promise<string> {
  return await invoke<string>("git_force_push", {
    path, token: token ?? null, expectedRemote: preview.remote, expectedBranch: preview.branch,
    expectedRemoteBranch: preview.remoteBranch,
    expectedLocalHead: preview.localHead, expectedRemoteHead: preview.remoteHead,
  });
}

/** A newly created remote repository, with the URLs needed to connect it locally. */
export interface CreatedRepo { cloneUrl: string; htmlUrl: string; fullName: string }

/** Create a repo under the token's GitHub account. `instanceUrl` is "" for public github.com. */
export async function githubCreateRepo(
  instanceUrl: string, token: string, name: string, isPrivate: boolean, description: string,
): Promise<CreatedRepo> {
  const r = await invoke<{ clone_url: string; html_url: string; full_name: string }>("github_create_repo",
    { instanceUrl, token, name, private: isPrivate, description });
  return { cloneUrl: r.clone_url, htmlUrl: r.html_url, fullName: r.full_name };
}

/** Create an empty project in the authenticated user's GitLab namespace. */
export async function gitlabCreateRepo(
  instanceUrl: string, token: string, name: string, isPrivate: boolean, description: string,
): Promise<CreatedRepo> {
  const r = await invoke<{ clone_url: string; html_url: string; full_name: string }>("gitlab_create_repo",
    { instanceUrl, token, name, private: isPrivate, description });
  return { cloneUrl: r.clone_url, htmlUrl: r.html_url, fullName: r.full_name };
}

/** Add a remote to a local repo (`git remote add <name> <url>`). */
export async function gitRemoteAdd(path: string, name: string, url: string): Promise<void> {
  await invoke("git_remote_add", { path, name, url });
}

/** A tag: name, the short hash it points at, its date and message subject. */
export interface Tag {
  name: string;
  target: string;
  date: string;
  subject: string;
}

export async function loadTags(path: string): Promise<Tag[]> {
  return await invoke<Tag[]>("git_tags", { path });
}

/** Create a tag on HEAD. Non-empty `message` → annotated tag; empty → lightweight. */
export async function createTag(path: string, name: string, message = ""): Promise<void> {
  await invoke("git_create_tag", { path, name, message });
}

/** Push a single tag to origin. */
export async function pushTag(path: string, name: string, token?: string): Promise<void> {
  await invoke("git_push_tag", { path, name, token: token ?? null });
}

/** Test a self-hosted GitLab connection; resolves to "name (@login)" or throws. */
export async function gitlabTest(url: string, token: string): Promise<string> {
  return invoke<string>("gitlab_test", { url, token });
}

export async function gitlabTokenInfo(url: string, token: string): Promise<import("./gitlabToken").GitlabTokenInfo> {
  return invoke("gitlab_token_info", { url, token });
}

/** Test a GitHub / GitHub Enterprise connection; resolves to "name (@login)" or throws. */
export async function githubTest(url: string, token: string): Promise<string> {
  return invoke<string>("github_test", { url, token });
}

export async function githubTokenInfo(url: string, token: string): Promise<import("./githubToken").GithubTokenInfo> {
  return invoke("github_token_info", { url, token });
}

// Drop the "diff --git / index / --- / +++" preamble; keep from the first hunk.
function stripDiffHeader(d: string): string {
  const idx = d.indexOf("\n@@");
  return idx >= 0 ? d.slice(idx + 1) : d;
}

export async function commitFileDiff(path: string, hash: string, file: string): Promise<string> {
  const d = await invoke<string>("commit_file_diff", { path, hash, file });
  return stripDiffHeader(d);
}

export type FileContentSource =
  | { kind: "commit"; hash: string }
  | { kind: "stash"; index: number }
  | { kind: "working" };
export interface FileContent {
  kind: "text" | "binary" | "too_large" | "empty" | "missing";
  content: string;
  lines: number;
  size: number;
}
export async function gitFileContent(path: string, file: string, source: FileContentSource, before = false): Promise<FileContent> {
  return invoke<FileContent>("git_file_content", {
    path, file,
    hash: source.kind === "commit" ? source.hash : null,
    stashIndex: source.kind === "stash" ? source.index : null,
    before,
  });
}

export interface FilePreview {
  kind: "text" | "binary" | "too_large" | "empty" | "missing";
  diff: string; lines: number; truncated: boolean; size: number;
}
/** Preview an untracked/new file's content as an all-additions diff. */
export async function filePreview(path: string, file: string): Promise<FilePreview> {
  return invoke<FilePreview>("file_preview", { path, file });
}

export async function workingFileDiff(path: string, file: string, staged: boolean, originalPath?: string): Promise<string> {
  const d = await invoke<string>("working_file_diff", { path, file, staged, originalPath: originalPath ?? null });
  return stripDiffHeader(d);
}

// ── polish & release (section E) ────────────────────────────────────────────

export interface UpdateInfo { version: string; currentVersion: string; date?: string; notes?: string }

/**
 * Check the configured updater endpoint for a newer signed release.
 * Returns metadata + an `install()` that downloads, installs and relaunches.
 * Returns null when the app is already up to date (or updater is unavailable,
 * e.g. running `npm run dev` in a browser without the Tauri shell).
 */
export async function checkForUpdate(): Promise<
  (UpdateInfo & { install: (onProgress?: (pct: number) => void) => Promise<void> }) | null
> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    notes: update.body,
    install: async (onProgress) => {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total > 0) onProgress?.(Math.min(1, got / total));
        } else if (e.event === "Finished") onProgress?.(1);
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

/** Current application version (from tauri.conf.json). Empty string outside the Tauri shell. */
export async function getAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "";
  }
}
