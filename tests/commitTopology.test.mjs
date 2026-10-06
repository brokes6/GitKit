import test from "node:test";
import assert from "node:assert/strict";
import { computeGraph, branchColor, attributeBranches, filterHistoryByHiddenBranches } from "../src/git.ts";
import { buildCommitTopology, TOPOLOGY_LANE_STEP, TOPOLOGY_PADDING } from "../src/commitTopologyLayout.ts";

const commit = (fullHash, parents = [], extra = {}) => ({
  fullHash, hash: fullHash.slice(0, 8), parents, message: fullHash,
  date: "2026-09-01T00:00:00Z", tags: [], branchLabel: "main",
  author: { name: "Test", email: "test@example.com", initials: "T", color: "#000" },
  files: [], lane: 0, stats: { additions: 0, deletions: 0, files: 0 }, ...extra,
});
const layout = (commits) => buildCommitTopology(commits, computeGraph(commits));

test("lays out every merge parent before its child and preserves branch colors", () => {
  const commits = [
    commit("merge", ["main-tip", "topic-tip", "third-tip"]),
    commit("topic-tip", ["base"], { branchLabel: "topic" }),
    commit("third-tip", ["base"], { branchLabel: "third" }),
    commit("main-tip", ["base"]),
    commit("base"),
  ];
  const graph = layout(commits);
  const mergeEdges = graph.edges.filter((edge) => edge.child.commit.fullHash === "merge");
  assert.equal(mergeEdges.length, 3);
  assert.deepEqual(mergeEdges.map((edge) => edge.parentIndex), [0, 1, 2]);
  for (const edge of graph.edges) assert.ok(edge.parent.x < edge.child.x);
  assert.equal(graph.nodes.find((node) => node.commit.fullHash === "topic-tip").color, branchColor("topic"));
  assert.equal(graph.omittedParentCount, 0);
  assert.deepEqual(layout(commits), graph);
  assert.equal(graph.nodes[0].commit, commits[0]);
});

test("aligns parallel histories while separating disconnected nodes that reuse a lane", () => {
  const commits = [commit("main-new", ["main-old"]), commit("topic-new", ["topic-old"]),
    commit("main-old"), commit("topic-old"), commit("disconnected")];
  const rows = commits.map((_, index) => ({ dotLane: index === 1 || index === 3 ? 1 : 0 }));
  const graph = buildCommitTopology(commits, rows);
  const byHash = new Map(graph.nodes.map((node) => [node.commit.fullHash, node]));
  assert.ok(byHash.get("main-old").x > byHash.get("disconnected").x);
  assert.ok(byHash.get("main-new").x > byHash.get("main-old").x);
  assert.ok(byHash.get("topic-new").x > byHash.get("topic-old").x);
  assert.equal(byHash.get("topic-old").x, byHash.get("disconnected").x);
  assert.equal(new Set(graph.nodes.map((node) => `${node.x}:${node.y}`)).size, commits.length);
});

test("omits truncated, reversed, and self parents without inventing branch connections", () => {
  const commits = [commit("first", ["not-loaded"]), commit("second", ["first", "second", "base"]), commit("base")];
  const graph = layout(commits);
  assert.equal(graph.omittedParentCount, 3);
  assert.deepEqual(graph.edges.map((edge) => [edge.parent.commit.fullHash, edge.child.commit.fullHash]), [["base", "second"]]);
  assert.equal(graph.edges[0].parentIndex, 2);
});

test("hidden branch and focused history never recreate missing branch lanes", () => {
  const commits = [commit("merge", ["main-tip", "topic-tip"]), commit("topic-tip", ["base"], { tags: ["topic"] }),
    commit("main-tip", ["base"]), commit("base")];
  attributeBranches(commits, [{ name: "main", head: "merge", current: true }, { name: "topic", head: "topic-tip" }]);
  const hidden = layout(filterHistoryByHiddenBranches(commits, ["topic"]));
  assert.deepEqual(hidden.nodes.map((node) => node.commit.fullHash), ["merge", "main-tip", "base"]);
  assert.equal(hidden.omittedParentCount, 1);
  assert.equal(hidden.laneCount, 1);
  const focused = layout(commits.filter((entry) => ["topic-tip", "base"].includes(entry.fullHash)));
  assert.equal(focused.edges.length, 1);
  assert.equal(focused.edges[0].child.commit.fullHash, "topic-tip");
});

test("stash nodes connect only to their real base and retain their detail identity", () => {
  const stash = commit("stash", ["base", "index", "untracked"], { isStash: true, stashIndex: 2, stashBranch: "main" });
  const graph = layout([stash, commit("index"), commit("untracked"), commit("base")]);
  assert.deepEqual(graph.edges.map((edge) => edge.parent.commit.fullHash), ["base"]);
  assert.equal(graph.omittedParentCount, 0);
  assert.equal(graph.nodes[0].commit.stashIndex, 2);
  const truncated = layout([{ ...stash, parents: ["outside", "index", "untracked"] }]);
  assert.equal(truncated.omittedParentCount, 1);
  assert.deepEqual(truncated.edges, []);
});

test("full hashes keep distinct commits with shared short hashes or identical patches", () => {
  const graph = layout([commit("12345678-new", ["12345678-old"], { patchId: "same" }), commit("12345678-old", [], { patchId: "same" })]);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].parent.commit.fullHash, "12345678-old");
});

test("reserves ref badge room and canvas bounds without mutating input metadata", () => {
  const commits = [commit("tip", ["base"], { tags: ["HEAD", "main", "origin/main", "v1", "v2"] }), commit("base")];
  const before = structuredClone(commits);
  const graph = layout(commits);
  assert.equal(graph.laneSpacing, TOPOLOGY_LANE_STEP + 40);
  for (const node of graph.nodes) {
    assert.ok(node.x >= TOPOLOGY_PADDING && node.x <= graph.width - TOPOLOGY_PADDING);
    assert.ok(node.y >= TOPOLOGY_PADDING && node.y <= graph.height - TOPOLOGY_PADDING);
  }
  assert.deepEqual(commits, before);
  const empty = layout([]);
  assert.equal(empty.laneCount, 0);
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  assert.equal(empty.omittedParentCount, 0);
});
