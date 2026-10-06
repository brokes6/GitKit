import test from "node:test";
import assert from "node:assert/strict";
import {
  overviewState, overviewMatchesFilter, overviewFilterCounts, overviewAttentionCount,
  overviewTarget, selectOverviewProjects, overviewEntryForScan, applyOverviewToProjects,
  projectReadTargets, projectRemoteRowsKey,
} from "../src/projectOverview.ts";
import { createOverviewScanner } from "../src/overviewScanner.ts";

const summary = (changes = {}) => ({
  initialized: true, hasHead: true, currentBranch: "main", detached: false, hasRemotes: true,
  upstream: "origin/main", upstreamRemote: true, upstreamMissing: false, ahead: 0, behind: 0,
  changedFiles: 0, stagedFiles: 0, unstagedFiles: 0, conflictFiles: 0,
  operation: null, behindBranches: [], checkedAt: 1000, ...changes,
});
const entry = (changes = {}, extra = {}) => ({ summary: summary(changes), error: null, checking: false, remoteError: null, ...extra });
const project = (id, name = id, path = `/repos/${id}`) => ({ id, name, path });
const badgeProject = (id, extra = {}) => ({ ...project(id), initialized: true, branch: "main", changes: 0, ...extra });
const badgeEntry = (id, changes = {}, extra = {}) => entry(changes, { readRevision: 0, readPath: `/repos/${id}`, ...extra });

const readContext = (extra = {}) => ({
  paths: ["/repos/a", "/repos/b"], running: true, full: false, activePath: "/repos/a", revision: 1,
  remoteRows: [], ...extra,
});
const remoteRow = (path, extra = {}) => ({ path, currentBranch: "main", dirty: false, behind: [], error: null, ...extra });

test("lightweight status summaries update the same sidebar badges without full overview fields", () => {
  const projects = [badgeProject("a", { changes: 9 })];
  const status = { summary: { initialized: true, currentBranch: "feature/status", changedFiles: 0, checkedAt: 3000 },
    error: null, checking: false, remoteError: null, readPath: "/repos/a", readRevision: 2 };
  const next = applyOverviewToProjects(projects, { a: status }, "", new Map([["/repos/a", 2]]));
  assert.equal(next[0].changes, 0);
  assert.equal(next[0].branch, "feature/status");
  assert.equal("hasHead" in status.summary, false);
});

test("initial activation and foreground resume reconcile every path regardless of cached age", () => {
  const current = readContext();
  assert.deepEqual(projectReadTargets(null, current), current.paths);
  assert.deepEqual(projectReadTargets(readContext({ running: false }), current), current.paths);
  assert.deepEqual(projectReadTargets(current, readContext({ running: false })), []);
});

test("a new native focus assertion reconciles all paths even when foreground stayed true", () => {
  const previous = readContext({ foregroundRevision: 4 });
  const reasserted = readContext({ foregroundRevision: 5 });
  assert.deepEqual(projectReadTargets(previous, reasserted), reasserted.paths);
  assert.deepEqual(projectReadTargets(reasserted, { ...reasserted }), []);
  assert.deepEqual(projectReadTargets(readContext(), readContext({ foregroundRevision: 0 })), []);
});

test("focus revisions received in background do not read until foreground resumes", () => {
  const previous = readContext({ running: false, foregroundRevision: 4 });
  const stillBackground = readContext({ running: false, foregroundRevision: 5 });
  assert.deepEqual(projectReadTargets(previous, stillBackground), []);
  const resumed = readContext({ foregroundRevision: 5 });
  assert.deepEqual(projectReadTargets(stillBackground, resumed), resumed.paths);
});

test("reordering or relabeling projects does not reread repositories; adding a path reads only that path", () => {
  const previous = readContext();
  assert.deepEqual(projectReadTargets(previous, readContext({ paths: [...previous.paths].reverse() })), []);
  assert.deepEqual(projectReadTargets(previous, readContext({ paths: ["/repos/b", "/repos/a", "/repos/new"] })), ["/repos/new"]);
  assert.deepEqual(projectReadTargets(previous, readContext({ paths: ["/repos/b"] })), []);
});

test("local reload targets only the current repository while a repository switch alone does not rescan", () => {
  const previous = readContext();
  assert.deepEqual(projectReadTargets(previous, readContext({ revision: 2, activePath: "/repos/b" })), ["/repos/b"]);
  assert.deepEqual(projectReadTargets(previous, readContext({ activePath: "/repos/b" })), []);
  assert.deepEqual(projectReadTargets(previous, readContext({ revision: 2, activePath: "/outside" })), []);
});

test("entering the workbench requests full overviews; leaving it reuses the just-read status", () => {
  const light = readContext();
  const full = readContext({ full: true });
  assert.deepEqual(projectReadTargets(light, full), light.paths);
  assert.deepEqual(projectReadTargets(full, light), []);
});

test("remote results invalidate only changed repository rows and ignore result bookkeeping", () => {
  const a = remoteRow("/repos/a");
  const b = remoteRow("/repos/b");
  const previous = readContext({ remoteRows: [a, b] });
  assert.deepEqual(projectReadTargets(previous, readContext({ remoteRows: [b, { ...a, id: "new", name: "renamed" }] })), []);
  assert.deepEqual(projectReadTargets(previous, readContext({ remoteRows: [a, { ...b, dirty: true }] })), ["/repos/b"]);
  assert.deepEqual(projectReadTargets(previous, readContext({ remoteRows: [a] })), ["/repos/b"]);
  assert.deepEqual(projectReadTargets(previous, readContext({ remoteRows: [a, b, remoteRow("/outside", { error: "failed" })] })), []);
  assert.equal(projectRemoteRowsKey([a, b]), projectRemoteRowsKey([b, a]));
});

test("changed remote branches and errors refresh their own path and coalesce with a local reload", () => {
  const previous = readContext({ remoteRows: [remoteRow("/repos/a"), remoteRow("/repos/b")] });
  const current = readContext({ revision: 2, remoteRows: [
    remoteRow("/repos/a", { currentBranch: "feature" }),
    remoteRow("/repos/b", { error: "network" }),
  ] });
  assert.deepEqual(projectReadTargets(previous, current), ["/repos/a", "/repos/b"]);
});

test("ready overview entries update sidebar counts while another project is still checking", () => {
  const projects = [badgeProject("ready"), badgeProject("pending", { changes: 2 })];
  const next = applyOverviewToProjects(projects, {
    ready: badgeEntry("ready", { changedFiles: 4 }),
    pending: badgeEntry("pending", { changedFiles: 0 }, { checking: true }),
  }, "", new Map());
  assert.equal(next[0].changes, 4);
  assert.equal(next[1], projects[1]);
  assert.equal(projects[0].changes, 0);
});

test("old generation cache is pending on the invalidation render and cannot overwrite badges", () => {
  const projects = [badgeProject("cached", { changes: 6 })];
  const cached = badgeEntry("cached", { changedFiles: 1 });
  const invalidated = overviewEntryForScan(cached, "old-scan", "new-scan", true);
  assert.equal(invalidated.checking, true);
  assert.equal(invalidated.summary, cached.summary);
  assert.equal(cached.checking, false);
  assert.equal(applyOverviewToProjects(projects, { cached: invalidated }, "", new Map()), projects);
  const published = overviewEntryForScan(cached, "new-scan", "new-scan", true);
  assert.equal(published, cached);
  assert.equal(applyOverviewToProjects(projects, { cached: published }, "", new Map())[0].changes, 1);
});

test("reactivation makes retained cache pending even when the requested scan key is reused", () => {
  const retained = badgeEntry("retained", { changedFiles: 5 }, { checking: true });
  const inactive = overviewEntryForScan(retained, null, "scan", false);
  assert.equal(inactive.checking, false);
  const active = overviewEntryForScan(inactive, null, "scan", true);
  assert.equal(active.checking, true);
  assert.equal(active.summary, retained.summary);
});

test("the active repository keeps its live branch and count instead of a delayed overview", () => {
  const projects = [badgeProject("active", { branch: "feature/live", changes: 8 }), badgeProject("other")];
  const next = applyOverviewToProjects(projects, {
    active: badgeEntry("active", { initialized: false, currentBranch: "old", changedFiles: 1 }),
    other: badgeEntry("other", { changedFiles: 3 }),
  }, projects[0].path, new Map());
  assert.equal(next[0], projects[0]);
  assert.equal(next[1].changes, 3);
});

test("a warm repository live revision rejects an overview completed after a newer watcher update", () => {
  const revisions = new Map([["/repos/warm", 4]]);
  const readRevision = revisions.get("/repos/warm");
  const projects = [badgeProject("warm", { branch: "live", changes: 7 })];
  // A read's end timestamp can be newer although its status was read before the live update.
  revisions.set("/repos/warm", 5);
  const delayed = badgeEntry("warm", { currentBranch: "old", changedFiles: 1, checkedAt: 99999 }, { readRevision });
  assert.equal(applyOverviewToProjects(projects, { warm: delayed }, "", revisions), projects);
  const fresh = badgeEntry("warm", { currentBranch: "live", changedFiles: 2 }, { readRevision: 5 });
  assert.equal(applyOverviewToProjects(projects, { warm: fresh }, "", revisions)[0].changes, 2);
});

test("failed, missing and unstamped summaries preserve the last known project state", () => {
  const projects = [badgeProject("known", { changes: 9, branch: "remembered" })];
  const values = [
    badgeEntry("known", { changedFiles: 0 }, { error: "cannot read repository" }),
    badgeEntry("known", {}, { summary: null }),
    badgeEntry("known", { changedFiles: 0 }, { readRevision: undefined }),
    badgeEntry("known", { changedFiles: 0 }, { readPath: undefined }),
  ];
  for (const value of values) assert.equal(applyOverviewToProjects(projects, { known: value }, "", new Map()), projects);
});

test("an authoritative zero clears a badge and summary fields preserve unrelated project data", () => {
  const projects = [badgeProject("clean", { changes: 4, branch: "old", initialized: false, color: "coral", pinned: true }), badgeProject("unrelated")];
  const next = applyOverviewToProjects(projects, { clean: badgeEntry("clean", { changedFiles: 0, currentBranch: "main" }) }, "", new Map());
  assert.notEqual(next, projects);
  assert.deepEqual(next[0], { ...projects[0], changes: 0, branch: "main", initialized: true });
  assert.equal(next[0].color, "coral");
  assert.equal(next[0].pinned, true);
  assert.equal(next[1], projects[1]);
});

test("unchanged overview updates preserve both the array and every project identity", () => {
  const projects = [badgeProject("same"), badgeProject("unrelated")];
  const next = applyOverviewToProjects(projects, { same: badgeEntry("same") }, "", new Map());
  assert.equal(next, projects);
  assert.equal(next[0], projects[0]);
  assert.equal(next[1], projects[1]);
});

test("a remote check error does not invalidate a successful local file count", () => {
  const projects = [badgeProject("local")];
  const next = applyOverviewToProjects(projects, { local: badgeEntry("local", { changedFiles: 2 }, { remoteError: "token expired" }) }, "", new Map());
  assert.equal(next[0].changes, 2);
});

test("replacing a project path cannot apply a queued summary with the same project id", () => {
  const oldEntry = badgeEntry("reused", { currentBranch: "old", changedFiles: 12 });
  const projects = [badgeProject("reused", { path: "/repos/replacement", branch: "new", changes: 3 })];
  assert.equal(applyOverviewToProjects(projects, { reused: oldEntry }, "", new Map()), projects);
  const currentEntry = badgeEntry("reused", { currentBranch: "new", changedFiles: 1 }, { readPath: projects[0].path });
  assert.equal(applyOverviewToProjects(projects, { reused: currentEntry }, "", new Map())[0].changes, 1);
});

test("tracking a local branch does not create a pending remote push", () => {
  const local = entry({ upstream: "main", upstreamRemote: false, hasRemotes: false, ahead: 2 });
  assert.equal(overviewState(local), "local-ahead");
  assert.equal(overviewMatchesFilter(local, "ahead"), false);
  assert.equal(overviewTarget(local), "history");
});

test("one repository can match multiple filters without duplicating the attention count", () => {
  const projects = [project("merge"), project("mixed"), project("clean")];
  const entries = {
    merge: entry({ operation: "merge", conflictFiles: 2, changedFiles: 2, unstagedFiles: 2 }),
    mixed: entry({ changedFiles: 5, stagedFiles: 2, unstagedFiles: 4, ahead: 2 }),
    clean: entry(),
  };
  assert.deepEqual(overviewFilterCounts(projects, entries), {
    attention: 2, conflicts: 1, changes: 2, ahead: 1, behind: 0, error: 0, all: 3,
  });
  assert.equal(overviewAttentionCount(projects, entries), 2);
  assert.equal(overviewState(entries.merge), "conflict");
  assert.equal(overviewTarget(entries.merge), "conflicts");
  assert.equal(overviewTarget(entries.mixed), "changes");
});

test("resolved conflicts still leave an unfinished operation in attention", () => {
  const merge = entry({ operation: "merge", conflictFiles: 0, changedFiles: 1, stagedFiles: 1 });
  assert.equal(overviewState(merge), "operation");
  assert.equal(overviewMatchesFilter(merge, "attention"), true);
  assert.equal(overviewMatchesFilter(merge, "conflicts"), false);
  assert.equal(overviewTarget(merge), "changes");
});

test("divergence is one condition and both ahead and behind filters remain accurate", () => {
  const diverged = entry({ ahead: 3, behind: 5 });
  assert.equal(overviewState(diverged), "diverged");
  assert.equal(overviewTarget(diverged), "updates");
  assert.equal(overviewMatchesFilter(diverged, "ahead"), true);
  assert.equal(overviewMatchesFilter(diverged, "behind"), true);
});

test("unknown and configuration states never become clean tracking state", () => {
  assert.equal(overviewState(), "unknown");
  assert.equal(overviewMatchesFilter(undefined, "attention"), true);
  assert.equal(overviewState(entry({ initialized: false, hasHead: false })), "uninitialized");
  assert.equal(overviewState(entry({ hasHead: false })), "unborn");
  assert.equal(overviewState(entry({ detached: true, upstream: null, ahead: null, behind: null })), "detached");
  assert.equal(overviewState(entry({ hasRemotes: false, upstream: null, ahead: null, behind: null })), "local");
  assert.equal(overviewState(entry({ upstream: null, ahead: null, behind: null })), "untracked");
  const missing = entry({ upstreamMissing: true, ahead: null, behind: null });
  assert.equal(overviewState(missing), "missing-upstream");
  assert.equal(overviewMatchesFilter(missing, "error"), true);
});

test("unread repositories remain visible during scanning without counting as confirmed attention", () => {
  const projects = [project("pending"), project("known")];
  const entries = { pending: { summary: null, error: null, checking: true, remoteError: null }, known: entry({ changedFiles: 1 }) };
  assert.equal(overviewAttentionCount(projects, entries), 1);
  assert.equal(overviewFilterCounts(projects, entries).attention, 1);
  assert.equal(selectOverviewProjects(projects, entries, "attention", "").length, 2);
});

test("a failed local refresh retains its old snapshot only as context", () => {
  const stale = entry({ changedFiles: 5, ahead: 2, behind: 1 }, { error: "Repository was removed" });
  assert.equal(overviewState(stale), "error");
  assert.equal(overviewTarget(stale), "repository");
  assert.equal(overviewMatchesFilter(stale, "attention"), true);
  assert.equal(overviewMatchesFilter(stale, "error"), true);
  for (const filter of ["changes", "conflicts", "ahead", "behind"]) assert.equal(overviewMatchesFilter(stale, filter), false);
});

test("remote errors coexist with valid local changes and are visible in error filter", () => {
  const value = entry({ changedFiles: 1 }, { remoteError: "Authentication failed" });
  assert.equal(overviewState(value), "changes");
  assert.equal(overviewMatchesFilter(value, "error"), true);
  assert.equal(overviewTarget(value), "changes");
  assert.equal(overviewTarget(entry({}, { remoteError: "Authentication failed" })), "updates");
});

test("other branches with updates are actionable without adding their commits to current branch", () => {
  const other = entry({ behindBranches: [{ name: "release", upstream: "origin/release", behind: 4, ahead: 0, current: false }] });
  assert.equal(overviewState(other), "behind");
  assert.equal(overviewMatchesFilter(other, "behind"), true);
  assert.equal(other.summary.behind, 0);
});

test("search uses real branch and path; priority sorting remains stable within a condition", () => {
  const projects = [project("a", "Alpha"), project("b", "Beta"), project("c", "Gamma"), project("d", "Delta")];
  const entries = { a: entry(), b: entry({ ahead: 2 }), c: entry({ currentBranch: "feature/Search", changedFiles: 1 }), d: entry({ conflictFiles: 1 }) };
  assert.deepEqual(selectOverviewProjects(projects, entries, "all", "").map((value) => value.id), ["d", "c", "b", "a"]);
  assert.deepEqual(selectOverviewProjects(projects, entries, "all", " SEARCH ").map((value) => value.id), ["c"]);
  assert.deepEqual(selectOverviewProjects(projects, entries, "all", "/repos/b").map((value) => value.id), ["b"]);
  assert.deepEqual(selectOverviewProjects(projects, entries, "changes", "Beta"), []);
});

const turn = () => new Promise((resolve) => setImmediate(resolve));
test("scanner limits concurrent Git reads and isolates an unreadable project", async () => {
  const projects = Array.from({ length: 8 }, (_, index) => project(String(index)));
  let active = 0;
  let peak = 0;
  const releases = [];
  const results = [];
  const scanner = createOverviewScanner(async (path) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active--;
    if (path.endsWith("/3")) throw new Error("unreadable");
    return summary();
  });
  const scan = scanner.start(projects, {
    onBatch: (batch) => results.push(...batch.map(({ project, summary, error }) => ({ id: project.id, summary, error }))),
    onComplete: () => {},
  });
  await turn();
  assert.equal(active, 3);
  while (results.length < projects.length) {
    releases.splice(0).forEach((resolve) => resolve());
    await turn();
  }
  await scan.done;
  assert.equal(peak, 3);
  assert.equal(results.length, 8);
  assert.equal(results.find((value) => value.id === "3").error, "unreadable");
  assert.equal(results.filter((value) => value.summary).length, 7);
});

test("cancelled scans discard pending results and do not read remaining projects", async () => {
  const projects = Array.from({ length: 7 }, (_, index) => project(String(index)));
  let reads = 0;
  let results = 0;
  const releases = [];
  const scanner = createOverviewScanner(async () => {
    reads++;
    await new Promise((resolve) => releases.push(resolve));
    return summary();
  });
  const scan = scanner.start(projects, { onBatch: (batch) => { results += batch.length; }, onComplete: () => {} });
  await turn();
  scan.cancel();
  releases.forEach((resolve) => resolve());
  await scan.done;
  await turn();
  assert.equal(reads, 3);
  assert.equal(results, 0);
});

function controlledReads() {
  const calls = [];
  const activePaths = new Set();
  let active = 0;
  let peak = 0;
  const load = (path) => {
    assert.equal(activePaths.has(path), false, `overlapping reads for ${path}`);
    activePaths.add(path);
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      const finish = (error = null) => {
        if (call.finished) return;
        call.finished = true;
        activePaths.delete(path);
        active--;
        if (error) reject(new Error(error)); else resolve(summary());
      };
      const call = { path, finish, finished: false };
      calls.push(call);
    });
  };
  const drain = async () => {
    for (let round = 0; round < 20; round++) {
      calls.filter((call) => !call.finished).forEach((call) => call.finish());
      await turn();
      if (active === 0) return;
    }
    assert.fail("scan did not drain");
  };
  return { load, calls, drain, get active() { return active; }, get peak() { return peak; } };
}

test("replacement scans share native slots and coalesce repeated refreshes into the latest queue", async () => {
  const reads = controlledReads();
  const scanner = createOverviewScanner(reads.load);
  const projects = Array.from({ length: 6 }, (_, index) => project(String(index)));
  const batches = [];
  const observer = (round) => ({ onBatch: (results) => batches.push({ round, results }), onComplete: () => {} });
  const first = scanner.start(projects, observer(1));
  await turn();
  const second = scanner.start(projects, observer(2));
  await turn();
  const latest = scanner.start(projects, observer(3));
  await turn();
  assert.equal(reads.active, 3);
  assert.equal(reads.calls.length, 3);
  assert.equal(await first.done, false);
  assert.equal(await second.done, false);
  await reads.drain();
  assert.equal(await latest.done, true);
  assert.equal(reads.peak, 3);
  assert.equal(reads.calls.length, 9); // old native calls + one latest full scan
  assert.equal(batches.every((batch) => batch.round === 3), true);
  assert.equal(batches.flatMap((batch) => batch.results).length, projects.length);
});

test("deactivation clears queued reads; reactivation retains old slots and rejects discarded projects", async () => {
  const reads = controlledReads();
  const scanner = createOverviewScanner(reads.load);
  const discarded = [];
  const resumedResults = [];
  const first = scanner.start([project("old-1"), project("shared"), project("old-2"), project("never-start")], {
    onBatch: (results) => discarded.push(...results), onComplete: () => discarded.push("complete"),
  });
  await turn();
  first.cancel();
  const resumed = scanner.start([project("new-1"), project("shared"), project("new-2")], {
    onBatch: (results) => resumedResults.push(...results), onComplete: () => {},
  });
  await turn();
  assert.equal(reads.calls.length, 3);
  await reads.drain();
  assert.equal(await first.done, false);
  assert.equal(await resumed.done, true);
  assert.equal(reads.peak, 3);
  assert.deepEqual(discarded, []);
  assert.equal(reads.calls.some((call) => call.path.endsWith("/never-start")), false);
  assert.deepEqual(resumedResults.map((result) => result.project.id).sort(), ["new-1", "new-2", "shared"]);
});

test("a failed obsolete read releases its slot and current failures do not stall later projects", async () => {
  const reads = controlledReads();
  const scanner = createOverviewScanner(reads.load);
  const observer = { onBatch: () => {}, onComplete: () => {} };
  const old = scanner.start([project("old")], observer);
  await turn();
  const results = [];
  const current = scanner.start([project("a"), project("b"), project("c"), project("d")], {
    onBatch: (batch) => results.push(...batch), onComplete: () => {},
  });
  await turn();
  assert.equal(reads.active, 3);
  reads.calls.find((call) => call.path.endsWith("/old")).finish("obsolete failure");
  reads.calls.find((call) => call.path.endsWith("/a")).finish("current failure");
  await turn();
  await reads.drain();
  assert.equal(await old.done, false);
  assert.equal(await current.done, true);
  assert.equal(reads.peak, 3);
  assert.equal(results.length, 4);
  assert.equal(results.find((result) => result.project.id === "a").error, "current failure");
  assert.equal(results.some((result) => result.error === "obsolete failure"), false);
});

test("scan cancellation discards a pending publication timer and stops its queue", async () => {
  const reads = controlledReads();
  const scanner = createOverviewScanner(reads.load, 3, 1000);
  const published = [];
  const scan = scanner.start(Array.from({ length: 8 }, (_, index) => project(String(index))), {
    onBatch: (batch) => published.push(...batch), onComplete: () => published.push("complete"),
  });
  await turn();
  reads.calls[0].finish();
  await turn();
  scan.cancel();
  const started = reads.calls.length;
  await reads.drain();
  assert.equal(await scan.done, false);
  assert.equal(reads.calls.length, started);
  assert.deepEqual(published, []);
  assert.equal(reads.active, 0);
});

test("a fast scan publishes all results together before reporting completion", async () => {
  const batches = [];
  let completed = false;
  const scanner = createOverviewScanner(async () => summary());
  const scan = scanner.start(Array.from({ length: 20 }, (_, index) => project(String(index))), {
    onBatch: (results) => { assert.equal(completed, false); batches.push(results); },
    onComplete: () => { completed = true; },
  });
  assert.equal(await scan.done, true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 20);
  assert.equal(completed, true);
});

test("a long scan publishes a group of ready results while another repository is pending", { timeout: 1000 }, async () => {
  const reads = controlledReads();
  const batches = [];
  let resolveBatch;
  const delivered = new Promise((resolve) => { resolveBatch = resolve; });
  const scanner = createOverviewScanner(reads.load, 3, 0);
  const scan = scanner.start([project("a"), project("b"), project("slow")], {
    onBatch: (results) => { batches.push(results); resolveBatch(); }, onComplete: () => {},
  });
  await turn();
  reads.calls[0].finish(); reads.calls[1].finish();
  await delivered;
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.equal(reads.active, 1);
  scan.cancel();
  await reads.drain();
});
