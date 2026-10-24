import test from "node:test";
import assert from "node:assert/strict";
import { branchColor, createBranchColors } from "../src/branchColors.ts";
import { attributeBranches, computeGraph, filterHistoryByHiddenBranches } from "../src/git.ts";
import { buildCommitTopology } from "../src/commitTopologyLayout.ts";

const names = ["master", "test", "feature/rpc-proxy-fallback", "pre"];
const branches = names.map(name => ({ name, remote: `origin/${name}`, current: name === "master" }));
const rgb = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
const distance = (a, b) => Math.hypot(...rgb(a).map((channel, index) => channel - rgb(b)[index]));
const luminance = color => rgb(color).map(channel => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

test("the reported colliding branch names receive visibly separated colors", () => {
  const palette = createBranchColors(branches, undefined, names);
  const colors = names.map(name => branchColor(name, palette));
  assert.equal(new Set(colors).size, names.length);
  for (let a = 0; a < colors.length; a++) {
    for (let b = a + 1; b < colors.length; b++) assert.ok(distance(colors[a], colors[b]) >= 60);
  }
});

test("generated colors extend beyond eight swatches and retain hex alpha compatibility", () => {
  const source = Array.from({ length: 256 }, (_, index) => ({ name: `feature/branch-${index}` }));
  const palette = createBranchColors(source);
  assert.equal(new Set(palette.values()).size, source.length);
  for (const color of palette.values()) {
    assert.match(color, /^#[0-9a-f]{6}$/);
    assert.match(`${color}66`, /^#[0-9a-f]{8}$/);
  }
});

test("initial assignments are deterministic regardless of branch enumeration or current checkout", () => {
  const first = createBranchColors(branches);
  const reordered = createBranchColors([...branches].reverse().map(branch => ({ ...branch, current: branch.name === "test" })));
  for (const name of names) assert.equal(reordered.get(name), first.get(name));
  assert.equal(branchColor("feature/中文 🚀"), branchColor("feature/中文 🚀"));
  assert.equal(branchColor(""), "#8A857C");
});

test("refreshes, changed visibility and newly created branches retain existing assignments", () => {
  const previous = createBranchColors(branches, undefined, ["master", "test"]);
  const before = [...previous];
  const next = createBranchColors([...branches, { name: "feature/new" }], previous, ["feature/new", "pre"]);
  for (const name of names) assert.equal(next.get(name), previous.get(name));
  assert.deepEqual([...previous], before);
  assert.ok(!new Set(names.map(name => previous.get(name))).has(next.get("feature/new")));
});

test("configured tracking aliases share a color while other remotes remain distinct", () => {
  const source = [{ name: "local-name", remote: "origin/topic" },
    { name: "origin/topic", isRemote: true }, { name: "upstream/topic", isRemote: true }];
  const palette = createBranchColors(source);
  assert.equal(palette.get("local-name"), palette.get("origin/topic"));
  assert.notEqual(palette.get("local-name"), palette.get("upstream/topic"));
});

test("the current local branch owns its upstream alias when multiple locals track it", () => {
  const source = [{ name: "a", remote: "origin/topic" }, { name: "b", remote: "origin/topic", current: true },
    { name: "origin/topic", isRemote: true }];
  const palette = createBranchColors(source);
  assert.equal(palette.get("origin/topic"), palette.get("b"));
  assert.notEqual(palette.get("a"), palette.get("b"));
});

test("shared upstream colors follow the same local ownership order as history attribution", () => {
  const source = [{ name: "b", remote: "origin/topic" }, { name: "a", remote: "origin/topic" },
    { name: "origin/topic", isRemote: true, head: "upstream-tip" }];
  const commits = [{ fullHash: "upstream-tip", parents: [] }];
  attributeBranches(commits, source);
  const colors = createBranchColors(source);
  assert.equal(colors.get("origin/topic"), colors.get(commits[0].branchLabel));
});

test("repository snapshots are independent and prioritize visible branches before hidden ones", () => {
  const hidden = Array.from({ length: 32 }, (_, index) => ({ name: `archived/${index}` }));
  const palette = createBranchColors([...hidden, ...branches], undefined, names);
  const visibleOnly = createBranchColors(branches, undefined, names);
  for (const name of names) assert.equal(palette.get(name), visibleOnly.get(name));
  createBranchColors([{ name: "unrelated-repository" }]);
  for (const name of names) assert.equal(palette.get(name), visibleOnly.get(name));
});

test("generated graph colors have sufficient icon contrast on existing light and dark surfaces", () => {
  const palette = createBranchColors(Array.from({ length: 64 }, (_, index) => ({ name: `feature/contrast-${index}` })));
  for (const color of palette.values()) {
    for (const surface of ["#FBFAF6", "#FBFCFE", "#201F1D", "#17181B"]) {
      assert.ok(contrast(color, surface) >= 3, `${color} must remain visible on ${surface}`);
    }
  }
});

test("the same snapshot colors graph nodes, merge edges, tracking aliases and filtered topology", () => {
  const source = [
    { name: "master", head: "master-tip", current: true, remote: "origin/master" },
    { name: "test", head: "test-tip", remote: "origin/test" },
    { name: "feature/rpc-proxy-fallback", head: "feature-tip", remote: "origin/feature/rpc-proxy-fallback" },
  ];
  const commits = [
    { fullHash: "master-tip", parents: ["base", "feature-tip"] },
    { fullHash: "test-tip", parents: ["base", "feature-tip"] },
    { fullHash: "feature-tip", parents: ["base"] },
    { fullHash: "base", parents: [] },
  ];
  const colors = createBranchColors(source);
  attributeBranches(commits, source);
  const graph = computeGraph(commits, colors);
  assert.equal(new Set(graph.slice(0, 3).map(row => row.colors.dot)).size, 3);
  commits.forEach((commit, index) => assert.equal(graph[index].colors.dot, colors.get(commit.branchLabel)));
  const filtered = filterHistoryByHiddenBranches(commits, ["test"]);
  const topology = buildCommitTopology(filtered, computeGraph(filtered, colors));
  for (const node of topology.nodes) assert.equal(node.color, colors.get(node.commit.branchLabel));
  for (const edge of topology.edges) assert.equal(edge.color, colors.get(edge.parent.commit.branchLabel));
});
