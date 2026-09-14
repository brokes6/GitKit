import test from "node:test";
import assert from "node:assert/strict";
import { attributeBranches, filterHistoryByHiddenBranches, historyBranchContext, computeGraph, branchColor } from "../src/git.ts";
import { buildSmartMergeCommits } from "../src/smartMerge.ts";

const commit = (hash, parents = [], tags = []) => ({
  fullHash: hash, hash, parents, tags, message: hash, date: "2026-09-01T00:00:00Z",
  author: { name: "Test", email: "test@example.com" }, files: [], lane: 0,
  stats: { additions: 0, deletions: 0, files: 0 },
});
const branch = (name, head, extra = {}) => ({ name, head, current: false, ...extra });

test("attributes remote-only first-parent history without following merge second parents", () => {
  const commits = [commit("framework-tip", ["upgrade", "seo"]), commit("seo", ["base"], ["seo"]),
    commit("upgrade", ["base"]), commit("base")];
  attributeBranches(commits, [branch("origin/framework", "framework-tip", { isRemote: true }),
    branch("seo", "seo", { current: true })]);
  assert.equal(commits[2].branchLabel, "origin/framework");
  assert.deepEqual(commits[1].branchLabels, ["seo"]);
  assert.equal(commits[3].branchLabel, "seo");
  assert.deepEqual(commits[3].branchLabels, ["seo", "origin/framework"]);
  assert.equal(computeGraph(commits)[2].colors.dot, branchColor("origin/framework"));
  assert.equal(historyBranchContext(commits[2], commits[1]), "origin/framework");
});

test("deduplicates configured upstream identities, including different local names and ahead remote tips", () => {
  const commits = [commit("remote-tip", ["local-tip"]), commit("local-tip")];
  attributeBranches(commits, [branch("origin/feature", "remote-tip", { isRemote: true }),
    branch("my-feature", "local-tip", { current: true, remote: "origin/feature" })]);
  for (const c of commits) {
    assert.equal(c.branchLabel, "my-feature");
    assert.deepEqual(c.branchLabels, ["my-feature"]);
  }
  // A repeated patch along local/upstream history remains a single branch.
  const repeated = commits.map(c => ({ ...c, patchId: "same", message: "same" }));
  assert.equal(buildSmartMergeCommits(repeated, "my-feature").mergedGroups, 0);
});

test("does not conflate similarly named branches from different remotes", () => {
  const commits = [commit("local"), commit("other")];
  attributeBranches(commits, [branch("feature", "local", { remote: "origin/feature" }),
    branch("upstream/feature", "other", { isRemote: true })]);
  assert.equal(commits[1].branchLabel, "upstream/feature");
});

test("clears stale attribution, ignores symbolic HEAD, and stops at unloaded parents", () => {
  const commits = [commit("tip", ["unloaded"])];
  attributeBranches(commits, [branch("old", "tip")]);
  attributeBranches(commits, [branch("origin/HEAD", "tip", { isRemote: true })]);
  assert.equal(commits[0].branchLabel, undefined);
  assert.deepEqual(commits[0].branchLabels, []);
  attributeBranches(commits, [branch("origin/new", "tip", { isRemote: true })]);
  assert.equal(commits[0].branchLabel, "origin/new");
});

test("hidden branches remove their lanes and unassigned merge-side commits while new branches stay visible", () => {
  const commits = [
    commit("new-tip", ["base"], ["new-work"]),
    commit("master-tip", ["base", "deleted-side"], ["HEAD", "master"]),
    commit("hidden-tip", ["base"], ["feature/hidden"]),
    { ...commit("stash-tip", ["base"]), isStash: true },
    commit("deleted-side", ["base"]),
    commit("base"),
  ];
  attributeBranches(commits, [
    branch("master", "master-tip", { current: true }),
    branch("feature/hidden", "hidden-tip"),
    branch("new-work", "new-tip"),
  ]);

  const visible = filterHistoryByHiddenBranches(commits, ["feature/hidden"]);

  assert.deepEqual(visible.map((item) => item.fullHash), ["new-tip", "master-tip", "stash-tip", "base"]);
  assert.equal(visible.some((item) => item.tags?.includes("feature/hidden")), false);
  assert.equal(visible.find((item) => item.fullHash === "base")?.branchLabels?.includes("feature/hidden"), false);
});

test("labels branch transitions in displayed order without duplicating consecutive rows or tip refs", () => {
  const a = { ...commit("a"), branchLabel: "seo" };
  const b = { ...commit("b"), branchLabel: "origin/framework" };
  const c = { ...commit("c"), branchLabel: "origin/framework" };
  assert.equal(historyBranchContext(a), "seo");
  assert.equal(historyBranchContext(b, a), "origin/framework");
  assert.equal(historyBranchContext(c, b), undefined);
  assert.equal(historyBranchContext(a, c), "seo");
  assert.equal(historyBranchContext({ ...b, tags: ["origin/framework"] }, a), undefined);
  assert.equal(historyBranchContext({ ...b, tags: ["v1.0"] }, a), "origin/framework");
});

test("smart-merge and stash rows break context without getting a misleading single-branch label", () => {
  const a = { ...commit("a"), branchLabel: "seo" };
  const b = { ...commit("b"), branchLabel: "origin/framework" };
  const merged = { ...a, equivalentCommits: [a, b] };
  assert.equal(historyBranchContext(merged), undefined);
  assert.equal(historyBranchContext(a, merged), "seo");
  assert.equal(historyBranchContext({ ...a, isStash: true }), undefined);
  assert.equal(historyBranchContext(a, { ...a, isStash: true }), "seo");
  assert.equal(historyBranchContext(commit("unknown"), a), undefined);
});
