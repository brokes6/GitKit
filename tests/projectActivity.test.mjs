import test from "node:test";
import assert from "node:assert/strict";
import {
  activityDateKey, activityIntensity, activityKeyboardIndex, aggregateProjectActivity,
  createActivityCache, createActivityWindow,
} from "../src/projectActivity.ts";
import { createOverviewScanner } from "../src/overviewScanner.ts";
import { loadProjectActivity } from "../src/git.ts";

const project = (id, path = `/repos/${id}`) => ({ id, path });
const commit = (oid, date) => ({ oid, committedAt: Math.floor(date.getTime() / 1000) });
const summary = (commits = []) => ({ commits, checkedAt: 1234 });
const entry = (commits = [], extra = {}) => ({ summary: summary(commits), error: null, checking: false, ...extra });
const window = createActivityWindow(new Date(2026, 9, 5, 12));
const turn = () => new Promise((resolve) => setImmediate(resolve));
function inTimezone(zone, run) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return run(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test("rolling calendar includes today and has inclusive local start, exclusive next midnight", () => {
  const range = createActivityWindow(new Date(2026, 9, 5, 22));
  assert.equal(activityDateKey(range.start), "2025-10-06");
  assert.equal(activityDateKey(range.end), "2026-10-05");
  const next = new Date(range.toTimestamp * 1000);
  assert.equal(activityDateKey(next), "2026-10-06");
  assert.equal(next.getHours(), 0);
  const data = aggregateProjectActivity([], {}, range);
  assert.equal(data.days.length, 365);
  assert.equal(data.weeks[0].find(Boolean).key, "2025-10-06");
  assert.equal(data.weeks.flat().filter(Boolean).length, 365);
});

test("a leap day starts after the clamped previous anniversary and remains present", () => {
  const range = createActivityWindow(new Date(2024, 1, 29));
  const data = aggregateProjectActivity([], {}, range);
  assert.equal(activityDateKey(range.start), "2023-03-01");
  assert.equal(data.days.length, 366);
  assert.equal(data.days[data.days.length - 1].key, "2024-02-29");
});

test("commit dates use the user's timezone, not UTC day strings", () => {
  inTimezone("America/Los_Angeles", () => {
    const range = createActivityWindow(new Date(2026, 9, 5));
    const data = aggregateProjectActivity([project("a")], { a: entry([commit("one", new Date("2026-10-05T01:30:00Z"))]) }, range);
    assert.equal(data.days.find((day) => day.key === "2026-10-04").count, 1);
    assert.equal(data.days.find((day) => day.key === "2026-10-05").count, 0);
  });
});

test("calendar generation crosses daylight saving without dropping or repeating a day", () => {
  inTimezone("Europe/Berlin", () => {
    const range = createActivityWindow(new Date(2026, 2, 30));
    const data = aggregateProjectActivity([], {}, range);
    assert.equal(new Set(data.days.map((day) => day.key)).size, data.days.length);
    const spring = data.days.find((day) => day.key === "2026-03-29");
    const next = data.days.find((day) => day.key === "2026-03-30");
    assert.equal((next.date.getTime() - spring.date.getTime()) / 3600000, 23);
    assert.equal(data.days.length, 365);
  });
});

test("full OIDs deduplicate globally, while day membership retains all involved projects", () => {
  const day = new Date(2026, 9, 4, 12);
  const one = commit("abcdef01234567890123456789012345678901234", day);
  const two = commit("abcdef09876543210987654321098765432109876", day);
  const data = aggregateProjectActivity([project("a"), project("clone"), project("b")], {
    a: entry([one, one, two]), clone: entry([one]), b: entry([two]),
  }, window);
  const found = data.days.find((value) => value.key === "2026-10-04");
  assert.equal(found.count, 2);
  assert.deepEqual(found.projects, [{ id: "a", count: 2 }, { id: "clone", count: 1 }, { id: "b", count: 1 }]);
  assert.equal(data.totalCommits, 2);
  assert.equal(data.activeDays, 1);
});

test("failed old snapshots cannot silently contribute to current totals", () => {
  const one = commit("known", new Date(2026, 9, 4, 12));
  const data = aggregateProjectActivity([project("a"), project("removed"), project("pending")], {
    a: entry([one]), removed: entry([commit("stale", new Date(2026, 9, 3))], { error: "Repository removed" }),
    pending: { summary: null, error: null, checking: true },
  }, window);
  assert.equal(data.totalCommits, 1);
  assert.equal(data.days.find((day) => day.key === "2026-10-03").count, 0);
});

test("time bounds exclude invalid and future data without truncating a long history", () => {
  const many = Array.from({ length: 950 }, (_, index) => ({ oid: String(index), committedAt: window.fromTimestamp }));
  const data = aggregateProjectActivity([project("a")], { a: entry([
    ...many, { oid: "before", committedAt: window.fromTimestamp - 1 }, { oid: "after", committedAt: window.toTimestamp },
    { oid: "bad-date", committedAt: NaN }, { oid: "", committedAt: window.fromTimestamp },
  ]) }, window);
  assert.equal(data.totalCommits, 950);
  assert.equal(data.days[0].count, 950);
});

test("arrow navigation follows columns and rows and clamps at calendar bounds", () => {
  assert.equal(activityKeyboardIndex(18, "ArrowLeft", 365), 11);
  assert.equal(activityKeyboardIndex(18, "ArrowRight", 365), 25);
  assert.equal(activityKeyboardIndex(18, "ArrowUp", 365), 17);
  assert.equal(activityKeyboardIndex(18, "ArrowDown", 365), 19);
  assert.equal(activityKeyboardIndex(3, "ArrowLeft", 365), 0);
  assert.equal(activityKeyboardIndex(363, "ArrowRight", 365), 364);
  assert.equal(activityKeyboardIndex(18, "Home", 365), 0);
  assert.equal(activityKeyboardIndex(18, "End", 365), 364);
  assert.equal(activityKeyboardIndex(18, "Enter", 365), null);
  assert.equal(activityIntensity(0, 9), 0);
  assert.equal(activityIntensity(9, 9), 4);
  assert.equal(activityIntensity(1, 999), 1);
});

test("session cache reuses matching native reads but revisions trigger new data", async () => {
  let count = 0;
  let release;
  const cache = createActivityCache(async () => { count++; await new Promise((resolve) => { release = resolve; }); return summary(); });
  const first = cache.read("/repo", { key: "first", window });
  const duplicate = cache.read("/repo", { key: "first", window });
  assert.equal(first, duplicate);
  await turn();
  release();
  await first;
  await cache.read("/repo", { key: "first", window });
  assert.equal(count, 1);
  const next = cache.read("/repo", { key: "new-revision", window });
  await turn();
  release();
  await next;
  assert.equal(count, 2);
});

test("errors remain explicit in cache and can be retried with a fresh generation", async () => {
  let calls = 0;
  const cache = createActivityCache(async () => { if (++calls === 1) throw new Error("Unavailable"); return summary(); });
  await assert.rejects(cache.read("/repo", { key: "first", window }), /Unavailable/);
  assert.equal(cache.get("/repo", "first").error, "Unavailable");
  await assert.rejects(cache.read("/repo", { key: "first", window }), /Unavailable/);
  assert.equal(calls, 1);
  assert.deepEqual(await cache.read("/repo", { key: "retry", window }), summary());
  assert.equal(cache.get("/repo", "retry").error, null);
});

test("an obsolete completion cannot overwrite a newer cached generation", async () => {
  const releases = [];
  const cache = createActivityCache(() => new Promise((resolve) => releases.push(resolve)));
  const old = cache.read("/repo", { key: "old", window });
  const next = cache.read("/repo", { key: "next", window });
  await turn();
  releases[1](summary([{ oid: "new", committedAt: window.fromTimestamp }]));
  await next;
  releases[0](summary([{ oid: "old", committedAt: window.fromTimestamp }]));
  await old;
  assert.equal(cache.get("/repo", "next").summary.commits[0].oid, "new");
});

test("removed project paths are not retained by a late successful read", async () => {
  let release;
  const cache = createActivityCache(() => new Promise((resolve) => { release = resolve; }));
  cache.retain(["/repo"]);
  const read = cache.read("/repo", { key: "one", window });
  await turn();
  cache.retain([]);
  release(summary());
  await read;
  assert.equal(cache.get("/repo", "one"), undefined);
});

test("cancelled activity scans cache completed calls and never publish obsolete totals", async () => {
  const releases = [];
  let calls = 0;
  const cache = createActivityCache(() => { calls++; return new Promise((resolve) => releases.push(resolve)); });
  const request = { key: "one", window };
  const scanner = createOverviewScanner((path) => cache.read(path, request));
  const oldPublished = [];
  const old = scanner.start([project("a"), project("b"), project("c"), project("never")], {
    onBatch: (batch) => oldPublished.push(...batch), onComplete: () => {},
  });
  await turn();
  assert.equal(calls, 3);
  old.cancel();
  const current = [];
  const next = scanner.start([project("a"), project("b"), project("c")], {
    onBatch: (batch) => current.push(...batch), onComplete: () => {},
  });
  releases.forEach((resolve) => resolve(summary()));
  assert.equal(await old.done, false);
  assert.equal(await next.done, true);
  assert.equal(calls, 3);
  assert.equal(current.length, 3);
  assert.deepEqual(oldPublished, []);
});

const previousWindow = globalThis.window;
test.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
test("native API wrapper preserves epoch seconds and the complete commit payload", async () => {
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    assert.deepEqual([command, args], ["git_project_activity", { path: "/repo", fromTimestamp: window.fromTimestamp, toTimestamp: window.toTimestamp }]);
    return summary([{ oid: "full-object-id", committedAt: window.fromTimestamp }]);
  } } };
  assert.deepEqual(await loadProjectActivity("/repo", window.fromTimestamp, window.toTimestamp), summary([{ oid: "full-object-id", committedAt: window.fromTimestamp }]));
});
