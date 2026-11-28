import test from "node:test";
import assert from "node:assert/strict";
import { buildStackModel } from "../src/lanes/stackModel.ts";
import { buildLaneViews, laneLinks, selectLaneIds } from "../src/lanes/laneLayout.ts";

const c = (hash, parents = [], minutesAgo = 0) => ({
  hash, short: hash, message: hash, author: "T", initials: "T", color: "#000",
  date: new Date(Date.UTC(2026, 8, 1) - minutesAgo * 60000).toISOString(), parents,
});
const b = (name, head, extra = {}) => ({ name, head, current: false, ahead: 0, behind: 0, ...extra });

// main: m1 ← m2 ← m3
// feat (from m2): f1 ← f2;  ui (stacked on feat): u1;  fix (from m3): x1;  old (from m1): o1; docs (merged, at m3)
const commits = [
  c("u1", ["f2"], 1), c("x1", ["m3"], 5), c("f2", ["f1"], 10), c("f1", ["m2"], 20),
  c("m3", ["m2"], 30), c("o1", ["m1"], 90), c("m2", ["m1"], 100), c("m1", [], 200),
];
const branches = [
  b("main", "m3"), b("feat", "f2"), b("ui", "u1", { current: true }), b("fix", "x1"), b("old", "o1"), b("docs", "m3"),
];
const model = buildStackModel(branches, commits);

test("lanes: current, its parent, then the two most recent others", () => {
  const picks = selectLaneIds(model, { count: 4, current: "ui" });
  assert.deepEqual(picks, [
    { id: "ui", role: "current" }, { id: "feat", role: "parent" },
    { id: "fix", role: "recent" }, { id: "main", role: "recent" },
  ]);
});

test("a trunk-based current branch gets the trunk as its parent lane", () => {
  const picks = selectLaneIds(model, { count: 4, current: "fix" });
  assert.deepEqual(picks.slice(0, 2), [{ id: "fix", role: "current" }, { id: "main", role: "parent" }]);
  assert.deepEqual(picks.slice(2).map((p) => p.id), ["ui", "feat"]);
});

test("on the trunk, the other three lanes are the most recent branches; ones sitting on a trunk commit go last", () => {
  const picks = selectLaneIds(model, { count: 4, current: "main" });
  assert.deepEqual(picks.map((p) => p.id), ["main", "ui", "fix", "feat"]);
  assert.ok(!picks.some((p) => p.id === "docs"));
});

test("pins override roles at their position; touched branches count as recent", () => {
  const pinned = selectLaneIds(model, { count: 4, current: "ui", pins: { 2: "old" } });
  assert.deepEqual(pinned.map((p) => p.id), ["ui", "feat", "old", "fix"]);
  assert.equal(pinned[2].role, "pinned");
  const touched = selectLaneIds(model, { count: 4, current: "ui", touched: { docs: Date.UTC(2027, 0, 1) } });
  assert.equal(touched[2].id, "docs");
});

test("fork links point at the base lane, fall back to the dock, and merges link rows", () => {
  const views = buildLaneViews(model, selectLaneIds(model, { count: 4, current: "ui" }));
  const links = laneLinks(views, model);
  assert.deepEqual(links.find((l) => l.id === "fork:ui").to, { lane: "feat", hash: "f2" });
  assert.deepEqual(links.find((l) => l.id === "fork:feat").to, { lane: "main", hash: "m2" });
  assert.deepEqual(links.find((l) => l.id === "fork:fix").to, { lane: "main", hash: "m3" });

  // Without the trunk on screen, trunk-based forks drop to the dock.
  const noTrunk = buildLaneViews(model, [{ id: "ui", role: "current" }, { id: "feat", role: "parent" }, { id: "fix", role: "recent" }]);
  assert.deepEqual(laneLinks(noTrunk, model).find((l) => l.id === "fork:fix").to, { dock: true });

  // A feature branch that merged the trunk in: its merge commit links to the trunk row.
  const merged = buildStackModel(
    [b("main", "m3"), b("topic", "fm")],
    [c("fm", ["t1", "m3"], 0), c("t1", ["m1"], 3), c("m3", ["m2"], 30), c("m2", ["m1"], 100), c("m1", [], 200)],
  );
  const mergeViews = buildLaneViews(merged, [{ id: "topic", role: "current" }, { id: "main", role: "parent" }]);
  const merge = laneLinks(mergeViews, merged).find((l) => l.kind === "merge");
  assert.deepEqual(merge && [merge.from, merge.to], [{ lane: "topic", hash: "fm" }, { lane: "main", hash: "m3" }]);
});

test("trunk lane rows reach the deepest fork on screen", () => {
  const views = buildLaneViews(model, [{ id: "main", role: "parent" }, { id: "old", role: "recent" }]);
  assert.ok(views[0].rows.some((r) => r.hash === "m1"));
});

test("a merged branch lists its commits and flow steps, and each visible merge commit links to its row", () => {
  const cc = (hash, parents = [], date = "2026-09-01T00:00:00Z") => ({
    hash, short: hash, message: hash, author: "T", initials: "T", color: "#000", date, parents,
  });
  const commits = [
    cc("M2", ["m1", "f1"], "2026-09-01T03:00:00Z"),
    cc("T3", ["T2", "h1"]), cc("T2", ["T1", "g1"]), cc("T1", ["t1", "f1"], "2026-09-01T01:00:00Z"), cc("t1", ["m1"]),
    cc("f1", ["m1"]), cc("g1", ["m1"]), cc("h1", ["m1"]), cc("m1"),
  ];
  const br = (name, head) => ({ name, head, current: name === "master", ahead: 0, behind: 0 });
  const model = buildStackModel([br("master", "M2"), br("test", "T3"), br("f", "f1")], commits);
  const views = buildLaneViews(model, [{ id: "master", role: "current" }, { id: "f", role: "recent" }, { id: "test", role: "recent" }]);
  const f = views.find((v) => v.id === "f");
  assert.equal(f.merged, true);
  assert.deepEqual(f.flow.map((s) => [s.into, s.merge?.hash ?? null]), [["test", "T1"], ["master", "M2"]]);
  assert.deepEqual(views.find((v) => v.id === "test").flow, []);
  assert.deepEqual(f.rows.map((r) => r.hash), ["f1"]);
  const mergeLinks = laneLinks(views, model).filter((l) => l.kind === "merge" && l.to.lane === "f");
  assert.deepEqual(mergeLinks.map((l) => [l.from, l.to]).sort((a, b) => a[0].lane.localeCompare(b[0].lane)), [
    [{ lane: "master", hash: "M2" }, { lane: "f", hash: "f1" }],
    [{ lane: "test", hash: "T1" }, { lane: "f", hash: "f1" }],
  ]);
  // Its recency counts the latest merge: a freshly merged branch beats an old unmerged one.
  const withOld = buildStackModel([br("master", "M2"), br("test", "T3"), br("f", "f1"), br("old", "o1")],
    [...commits, cc("o1", ["m1"], "2026-08-01T00:00:00Z")]);
  assert.deepEqual(selectLaneIds(withOld, { count: 3, current: "master" }).map((p) => p.id), ["master", "f", "test"]);
});

test("lane rules from settings: named lists skip missing branches, trunk rule, merged filter", () => {
  const rules = [
    { kind: "current" },
    { kind: "named", names: ["nope", "old"] },
    { kind: "named", names: ["missing"] },
    { kind: "trunk" },
  ];
  const picks = selectLaneIds(model, { count: 4, current: "ui", rules });
  assert.deepEqual(picks, [
    { id: "ui", role: "current" }, { id: "old", role: "named" },
    { id: "fix", role: "recent" }, { id: "main", role: "named" },
  ]);
  // The current branch keeps its rule's lane even when it isn't the first rule.
  const moved = selectLaneIds(model, { count: 3, current: "ui", rules: [{ kind: "trunk" }, { kind: "recent" }, { kind: "current" }] });
  assert.deepEqual(moved.map((p) => p.id), ["main", "fix", "ui"]);
});

test("recent lanes can leave out merged branches", () => {
  const cc = (hash, parents = [], date = "2026-09-01T00:00:00Z") => ({
    hash, short: hash, message: hash, author: "T", initials: "T", color: "#000", date, parents,
  });
  const commits = [cc("M2", ["m1", "f1"], "2026-09-02T00:00:00Z"), cc("f1", ["m1"], "2026-09-01T12:00:00Z"),
    cc("o1", ["m1"], "2026-08-01T00:00:00Z"), cc("m1", [], "2026-07-01T00:00:00Z")];
  const br = (name, head) => ({ name, head, current: name === "master", ahead: 0, behind: 0 });
  const m = buildStackModel([br("master", "M2"), br("f", "f1"), br("old", "o1")], commits);
  assert.deepEqual(selectLaneIds(m, { count: 2, current: "master" }).map((p) => p.id), ["master", "f"]);
  assert.deepEqual(selectLaneIds(m, { count: 2, current: "master", includeMerged: false }).map((p) => p.id), ["master", "old"]);
});
