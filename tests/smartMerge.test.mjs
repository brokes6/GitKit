import test from "node:test";
import assert from "node:assert/strict";
import { buildSmartMergeCommits } from "../src/smartMerge.ts";

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
