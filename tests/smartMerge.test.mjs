import test from "node:test";
import assert from "node:assert/strict";
import { buildSmartMergeCommits, commitHistoryDate } from "../src/smartMerge.ts";

const author = { name: "Blake", email: "blake@example.com", initials: "B", color: "#000" };
const commit = ({ hash, message, patchId, branch, parent, time, tags = [] }) => ({
  hash: hash.slice(0, 7),
  fullHash: hash,
  message,
  author,
  date: time,
  committerDate: time,
  patchId,
  lane: 0,
  tags,
  parents: parent ? [parent] : [],
  stats: { additions: 0, deletions: 0, files: 0 },
  files: [],
  branchLabel: branch,
  branchLabels: branch ? [branch] : [],
});

test("collapses parallel cherry-pick chains and remaps their parents", () => {
  const base = commit({ hash: "base000", message: "base", patchId: "base-patch", branch: "master", time: "2026-08-01T00:00:00Z" });
  const masterA = commit({ hash: "masterA", message: "change A", patchId: "patch-a", branch: "master", parent: base.fullHash, time: "2026-08-02T00:00:00Z" });
  const testA = commit({ hash: "testAAA", message: "change A", patchId: "patch-a", branch: "test", parent: base.fullHash, time: "2026-08-02T00:01:00Z" });
  const masterB = commit({ hash: "masterB", message: "change B", patchId: "patch-b", branch: "master", parent: masterA.fullHash, time: "2026-08-03T00:00:00Z", tags: ["HEAD", "master"] });
  const testB = commit({ hash: "testBBB", message: "change B", patchId: "patch-b", branch: "test", parent: testA.fullHash, time: "2026-08-03T00:01:00Z", tags: ["test"] });

  const result = buildSmartMergeCommits([testB, testA, masterB, masterA, base], "master");

  assert.equal(result.mergedGroups, 2);
  assert.equal(result.hiddenCommits, 2);
  assert.deepEqual(result.commits.map((c) => c.fullHash), [masterB.fullHash, masterA.fullHash, base.fullHash]);
  assert.deepEqual(result.commits[0].parents, [masterA.fullHash]);
  assert.deepEqual(result.commits[1].parents, [base.fullHash]);
  assert.deepEqual(result.commits[0].tags, ["HEAD", "master", "test"]);
  assert.deepEqual(result.commits[0].equivalentCommits?.map((c) => c.fullHash), [masterB.fullHash, testB.fullHash]);
});

test("does not merge matching messages when patch ids differ", () => {
  const master = commit({ hash: "master1", message: "same title", patchId: "patch-a", branch: "master", time: "2026-08-01T00:00:00Z" });
  const testCommit = commit({ hash: "test001", message: "same title", patchId: "patch-b", branch: "test", time: "2026-08-01T00:01:00Z" });
  const result = buildSmartMergeCommits([testCommit, master], "master");
  assert.equal(result.mergedGroups, 0);
  assert.equal(result.commits.length, 2);
});

test("does not merge repeated patches on the same branch", () => {
  const first = commit({ hash: "master1", message: "reapply", patchId: "patch-a", branch: "master", time: "2026-08-01T00:00:00Z" });
  const second = commit({ hash: "master2", message: "reapply", patchId: "patch-a", branch: "master", parent: first.fullHash, time: "2026-08-02T00:00:00Z" });
  const result = buildSmartMergeCommits([second, first], "master");
  assert.equal(result.mergedGroups, 0);
  assert.equal(result.commits.length, 2);
});

test("dates a merged group by its latest committer time without changing its representative", () => {
  const original = commit({ hash: "original", message: "change", patchId: "patch", branch: "master", time: "2026-08-01T00:00:00Z" });
  const picked = { ...commit({ hash: "picked01", message: "change", patchId: "patch", branch: "test", time: "2026-08-01T00:00:00Z" }), committerDate: "2026-09-04T00:00:00Z" };
  const between = commit({ hash: "between1", message: "other", branch: "feature", time: "2026-08-20T00:00:00Z" });
  const result = buildSmartMergeCommits([between, picked, original], "master");
  assert.deepEqual(result.commits.map((c) => c.fullHash), [original.fullHash, between.fullHash]);
  assert.equal(commitHistoryDate(result.commits[0]), picked.committerDate);
  assert.equal(result.commits[0].committerDate, original.committerDate);
  assert.equal(result.commits[0].date, original.date);
});

test("keeps a child above a collapsed parent even when the parent's latest copy is newer", () => {
  const original = commit({ hash: "original", message: "change", patchId: "patch", branch: "master", time: "2026-08-01T00:00:00Z" });
  const picked = commit({ hash: "picked01", message: "change", patchId: "patch", branch: "test", time: "2026-09-04T00:00:00Z" });
  const child = commit({ hash: "child001", message: "descendant", branch: "master", parent: original.fullHash, time: "2026-08-20T00:00:00Z" });
  const result = buildSmartMergeCommits([picked, child, original], "test");
  assert.deepEqual(result.commits.map((c) => c.fullHash), [child.fullHash, picked.fullHash]);
  assert.deepEqual(result.commits[0].parents, [picked.fullHash]);
  assert.deepEqual(child.parents, [original.fullHash]);
});

test("preserves stable ties and ignores parent hashes outside the loaded window", () => {
  const time = "2026-09-04T00:00:00Z";
  const first = commit({ hash: "first001", message: "change", patchId: "patch", branch: "master", parent: "not-loaded", time });
  const copy = commit({ hash: "copy0001", message: "change", patchId: "patch", branch: "test", parent: "not-loaded", time });
  const other = commit({ hash: "other001", message: "other", branch: "feature", time });
  const result = buildSmartMergeCommits([other, copy, first], "master");
  assert.deepEqual(result.commits.map((c) => c.fullHash), [other.fullHash, first.fullHash]);
  assert.deepEqual(result.commits[1].parents, ["not-loaded"]);
});

test("falls back to real commits when reversed cherry-pick chains would create a cycle", () => {
  const time = "2026-09-04T00:00:00Z";
  const masterA = commit({ hash: "masterA", message: "A", patchId: "a", branch: "master", time });
  const masterB = commit({ hash: "masterB", message: "B", patchId: "b", branch: "master", parent: masterA.fullHash, time });
  const testB = commit({ hash: "testBBB", message: "B", patchId: "b", branch: "test", time });
  const testA = commit({ hash: "testAAA", message: "A", patchId: "a", branch: "test", parent: testB.fullHash, time });
  const commits = [masterB, testA, masterA, testB];
  const result = buildSmartMergeCommits(commits, "master");
  assert.equal(result.commits, commits);
  assert.equal(result.mergedGroups, 0);
  assert.equal(result.hiddenCommits, 0);
});
