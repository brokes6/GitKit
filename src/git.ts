// GitKit — frontend Git API. Wraps the Rust `invoke` commands and maps their
// output into the shapes the existing UI components already consume.

import { invoke, Channel } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  Branch,
  Commit,
  CommitFile,
  GraphRowInfo,
  Remote,
  WorkingFile,
} from "./App";

// ── Rust-facing types ──────────────────────────────────────────────────────
export interface RepoInfo {
  path: string;
  name: string;
  current_branch: string;
}
interface RCommit {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  date: string;
  refs: string[];
  subject: string;
  body: string;
  is_stash: boolean;
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
interface RStatus {
  path: string;
  index_status: string;
  work_status: string;
  staged: boolean;
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
// line, a thin outline, and a dot on both the dark and cream backgrounds.
// Kept in sync with LANE_COLORS in App.tsx.
const PALETTE = [
  "#3E86D6", // blue
  "#D6912E", // amber
  "#3DA063", // green
  "#D14E43", // red
  "#9464C9", // purple
  "#2FA098", // teal
  "#D46036", // orange
  "#CB5F8F", // pink
];

function authorColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initials(name: string): string {
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

  for (const c of commits) {
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

    if (c.parents.length === 0) {
      lanes[dotLane] = null;
    } else {
      const fp = c.parents[0];
      const existing = lanes.findIndex((h, i) => h === fp && i !== dotLane);
      if (existing !== -1) {
        bottomBranches.push({ fromLane: dotLane, toLane: existing });
        bottom.push(colorOf(fp));
        lanes[dotLane] = null;
      } else {
        lanes[dotLane] = fp;
        hasBottomLine = true;
      }
      for (let k = 1; k < c.parents.length; k++) {
        const p = c.parents[k];
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
      isMerge: c.parents.length > 1,
      colors: { dot: dotColor, line: dotColor, pass, top, bottom },
    });
  }
  return rows;
}

// ── public API ───────────────────────────────────────────────────────────────

/** Native folder picker. Returns the chosen path, or null if cancelled. */
export async function pickRepoFolder(): Promise<string | null> {
  const sel = await openDialog({
    directory: true,
    multiple: false,
    title: "选择一个 Git 仓库文件夹",
  });
  return typeof sel === "string" ? sel : null;
}

export async function openRepo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("open_repo", { path });
}

/** Start watching a repo's working tree; the backend emits `working-tree-changed`
 *  (payload = the repo path) on any file change outside `.git/`. Idempotent. */
export async function startWatch(path: string): Promise<void> {
  await invoke("start_watch", { path });
}

/** Stop watching a repo's working tree. */
export async function stopWatch(path: string): Promise<void> {
  await invoke("stop_watch", { path });
}

/** Native folder picker for the destination a repo will be cloned INTO (the
 *  parent directory). Returns the chosen path, or null if cancelled. */
export async function pickCloneParent(): Promise<string | null> {
  const sel = await openDialog({
    directory: true,
    multiple: false,
    title: "选择克隆到的文件夹",
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

export async function loadBranches(path: string): Promise<Branch[]> {
  const raw = await invoke<RBranch[]>("git_branches", { path });
  return raw
    .filter((b) => !b.is_remote)
    .map((b) => ({
      name: b.name,
      remote: b.upstream ?? undefined,
      ahead: b.ahead,
      behind: b.behind,
      current: b.current,
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
  const order = [...branches].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));

  // primary label — first branch to reach a commit claims it
  const claimed = new Set<string>();
  for (const b of order) {
    let h = b.head;
    while (h && byHash.has(h) && !claimed.has(h)) {
      claimed.add(h);
      const c = byHash.get(h)!;
      c.branchLabel = b.name;
      h = c.parents[0];
    }
  }

  // full membership — every branch's complete first-parent backbone
  for (const c of commits) c.branchLabels = [];
  for (const b of order) {
    let h = b.head;
    const seen = new Set<string>();
    while (h && byHash.has(h) && !seen.has(h)) {
      seen.add(h);
      const c = byHash.get(h)!;
      if (!c.branchLabels!.includes(b.name)) c.branchLabels!.push(b.name);
      h = c.parents[0];
    }
  }
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
    author: {
      name: c.author_name,
      email: c.author_email,
      initials: initials(c.author_name),
      color: authorColor(c.author_email),
    },
    date: c.date,
    lane: 0,
    tags: cleanRefs(c.refs),
    parents: c.parents,
    stats: { additions: 0, deletions: 0, files: 0 },
    files: [],
  }));
}

export async function loadStatus(path: string): Promise<WorkingFile[]> {
  const raw = await invoke<RStatus[]>("git_status", { path });
  const map = (l: string): WorkingFile["status"] =>
    l === "A" ? "added" : l === "D" ? "deleted" : l === "?" ? "untracked" : "modified";
  return raw.map((s) => ({
    path: s.path,
    status: map(s.staged ? s.index_status : s.work_status),
    staged: s.staged,
  }));
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

export async function stashPush(path: string, message = ""): Promise<void> {
  await invoke("git_stash_push", { path, message });
}

export interface MergePreview { conflict: boolean; files: string[] }
/** Preview whether merging `source` into `target` conflicts (no working-tree changes). */
export async function mergePreview(path: string, source: string, target: string): Promise<MergePreview> {
  return await invoke<MergePreview>("git_merge_preview", { path, source, target });
}

export interface StashEntry { index: number; message: string; date: string }
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
  /** "clean" — applied cleanly; "resolved" — conflicts resolved via Kaleidoscope
   *  and continued; "conflict" — left mid-cherry-pick with unresolved files. */
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
  path: string, message: string, files: string[],
  name?: string, email?: string,
): Promise<void> {
  await invoke("git_commit", { path, message, files, name: name ?? null, email: email ?? null });
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

/** Cancel a running fetch/pull by op id. Safe to call after it has finished. */
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

/** A repository created on GitHub, with the URLs needed to wire it up locally. */
export interface GithubRepo { cloneUrl: string; htmlUrl: string; fullName: string }

/** Create a repo under the token's GitHub account. `instanceUrl` is "" for public github.com. */
export async function githubCreateRepo(
  instanceUrl: string, token: string, name: string, isPrivate: boolean, description: string,
): Promise<GithubRepo> {
  const r = await invoke<{ clone_url: string; html_url: string; full_name: string }>("github_create_repo",
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

/** Test a GitHub / GitHub Enterprise connection; resolves to "name (@login)" or throws. */
export async function githubTest(url: string, token: string): Promise<string> {
  return invoke<string>("github_test", { url, token });
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

export interface FilePreview {
  kind: "text" | "binary" | "too_large" | "empty" | "missing";
  diff: string; lines: number; truncated: boolean; size: number;
}
/** Preview an untracked/new file's content as an all-additions diff. */
export async function filePreview(path: string, file: string): Promise<FilePreview> {
  return invoke<FilePreview>("file_preview", { path, file });
}

export async function workingFileDiff(path: string, file: string, staged: boolean): Promise<string> {
  const d = await invoke<string>("working_file_diff", { path, file, staged });
  return stripDiffHeader(d);
}

// ── polish & release (section E) ────────────────────────────────────────────

/** Toggle the macOS frosted-glass window material at runtime. No-op elsewhere. */
export async function setVibrancy(enabled: boolean): Promise<void> {
  await invoke("set_vibrancy", { enabled });
}

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
