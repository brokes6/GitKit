import test from "node:test";
import assert from "node:assert/strict";
import { buildStackModel, treeRows, stackFor } from "../src/lanes/stackModel.ts";
import { createDemoRepo } from "../src/lanes/demoRepo.ts";

const c = (hash, parents = []) => ({
  hash, short: hash, message: hash, author: "T", initials: "T", color: "#000",
  date: "2026-09-01T00:00:00Z", parents,
});
const b = (name, head, extra = {}) => ({ name, head, current: false, ahead: 0, behind: 0, ...extra });

// main: m1 ← m2 ; a: m1 ← a1 ← a2 ; b (stacked on a): a2 ← b1
const commits = [c("b1", ["a2"]), c("a2", ["a1"]), c("a1", ["m1"]), c("m2", ["m1"]), c("m1")];

test("infers stacks from first-parent ancestry", () => {
  const model = buildStackModel([b("main", "m2"), b("a", "a2"), b("b", "b1")], commits);
  assert.equal(model.trunk, "main");
  assert.equal(model.nodes.get("a").parent, "main");
  assert.equal(model.nodes.get("b").parent, "a");
  assert.deepEqual(model.nodes.get("a").commits.map((x) => x.hash), ["a2", "a1"]);
  assert.deepEqual(model.nodes.get("b").commits.map((x) => x.hash), ["b1"]);
  assert.equal(model.nodes.get("a").behindBase, 1);
  assert.deepEqual(model.stacks.map((s) => s.chain), [["a", "b"]]);
  assert.deepEqual(treeRows(model), [{ name: "a", depth: 1 }, { name: "b", depth: 2 }]);
});

test("a fresh branch on another branch's tip stacks via explicit base", () => {
  const branches = [b("main", "m2"), b("a", "a2"), b("z-new", "a2")];
  const inferred = buildStackModel(branches, commits);
  assert.equal(inferred.nodes.get("z-new").parent, "a");
  assert.deepEqual(inferred.nodes.get("z-new").commits, []);
  assert.deepEqual(inferred.nodes.get("a").commits.map((x) => x.hash), ["a2", "a1"]);

  const explicit = buildStackModel([b("main", "m2"), b("a", "a2"), b("0-new", "a2")], commits, { "0-new": "a" });
  assert.equal(explicit.nodes.get("0-new").parent, "a");
  assert.equal(explicit.nodes.get("a").parent, "main");
  assert.deepEqual(explicit.nodes.get("a").commits.map((x) => x.hash), ["a2", "a1"]);
  assert.equal(stackFor(explicit, "a").id, "0-new");
});

test("stale explicit metadata cannot create a cycle", () => {
  const model = buildStackModel([b("main", "m2"), b("a", "a2"), b("b", "b1")], commits, { a: "b" });
  const seen = new Set();
  let p = "a";
  while (p !== "main") { assert.ok(!seen.has(p)); seen.add(p); p = model.nodes.get(p).parent; }
});

test("demo repo yields stacked and flat branches", () => {
  const demo = createDemoRepo();
  const model = buildStackModel(demo.branches, demo.commits);
  assert.equal(model.nodes.get("auth/oauth-ui").parent, "auth/oauth");
  assert.equal(model.nodes.get("auth/oauth").parent, "auth/tokens");
  assert.equal(model.nodes.get("feat/lanes-dock").parent, "feat/lanes");
  assert.equal(model.nodes.get("fix/scroll").parent, "main");
  assert.equal(model.stacks[0].id, "feat/lanes-dock");
});

// Environment flow: f is cut from master, merged into test, pre, then master.
//   master: m1 ← M3(m1, f1)          test: t1(m1) ← t2 ← T1(t2, f1) ← T2(T1, g1)
//   pre:    p1(m1) ← p2 ← P1(p2, f1) ← P2(P1, h1) ← P3(P2, k1)
//   g: m1 ← g1 (only in test)        h, k: merged into pre (deleted branches)
const envCommits = [
  c("M3", ["m1", "f1"]),
  c("T3", ["T2", "h1"]), c("T2", ["T1", "g1"]), c("T1", ["t2", "f1"]), c("t2", ["t1"]), c("t1", ["m1"]),
  c("P3", ["P2", "k1"]), c("P2", ["P1", "h1"]), c("P1", ["p2", "f1"]), c("p2", ["p1"]), c("p1", ["m1"]),
  c("f1", ["m1"]), c("g1", ["m1"]), c("h1", ["m1"]), c("k1", ["m1"]), c("j1", ["m1"]), c("m1"),
].map((x, i, all) => ({ ...x, date: new Date(Date.UTC(2026, 8, 1, all.length - i)).toISOString() }));
// Merge dates follow the flow: test first, then pre, then master.
envCommits.find((x) => x.hash === "T1").date = "2026-09-01T01:00:00Z";
envCommits.find((x) => x.hash === "P1").date = "2026-09-01T02:00:00Z";
envCommits.find((x) => x.hash === "M3").date = "2026-09-01T03:00:00Z";

test("records merges and orders long-lived branches like an environment flow", () => {
  const model = buildStackModel([
    b("master", "M3"), b("test", "T3"), b("pre", "P3"), b("feature/f", "f1"), b("feature/g", "g1"), b("feature/j", "j1"),
  ], envCommits);
  assert.deepEqual(model.longLived, ["test", "pre", "master"]);
  const f = model.nodes.get("feature/f");
  assert.equal(f.empty, true);
  assert.equal(f.merged, true);
  assert.equal(f.forkHash, "m1", "a merged branch forks where it left the trunk, not at its own tip");
  assert.deepEqual(f.commits.map((x) => x.hash), ["f1"], "a merged branch still lists the commits it brought in");
  assert.deepEqual(model.merges.get("feature/f").map((m) => [m.into, m.hash, m.stale]),
    [["test", "T1", false], ["pre", "P1", false], ["master", "M3", false]]);
  assert.deepEqual(model.merges.get("feature/g").map((m) => m.into), ["test"]);
  assert.equal(model.nodes.get("feature/g").merged, false);
  assert.equal(model.merges.get("feature/j"), undefined);
});

test("a user-chosen trunk and long-lived order override detection", () => {
  const branches = [b("master", "M3"), b("test", "T3"), b("pre", "P3"), b("feature/f", "f1")];
  const model = buildStackModel(branches, envCommits, {}, { trunk: "pre", longLived: ["test", "gone"] });
  assert.equal(model.trunk, "pre");
  assert.deepEqual(model.longLived, ["test", "pre"]);
  assert.equal(buildStackModel(branches, envCommits, {}, { trunk: "missing" }).trunk, "master");
});

test("a merge fetched on the remote target appears before the local target advances", () => {
  for (const target of ["main", "test"]) {
    const refs = [b(target, "base", { upstream: "origin/" + target, behind: 1 }),
      b("origin/" + target, "merge", { isRemote: true }), b("topic", "feature")];
    if (target !== "main") refs.unshift(b("main", "base"));
    const model = buildStackModel(refs, [c("merge", ["base", "feature"]), c("feature", ["base"]), c("base")]);
    assert.equal(model.merges.get("topic")[0].into, target);
    assert.equal(model.nodes.has("origin/" + target), false);
    assert.equal(refs.find(branch => branch.name === target).head, "base");
  }
});
