import test from "node:test";
import assert from "node:assert/strict";
import {
  activityAuthorEmails, activityDateKey, activityEntryForScope, activityIntensity, activityKeyboardIndex, aggregateProjectActivity,
  createActivityCache, createActivityWindow,
} from "../src/projectActivity.ts";
import { createOverviewScanner } from "../src/overviewScanner.ts";
import { loadProjectActivity } from "../src/git.ts";

const project = (id, path = `/repos/${id}`) => ({ id, path });
const commit = (oid, date) => ({ oid, committedAt: Math.floor(date.getTime() / 1000) });
const summary = (commits = []) => ({ commits, checkedAt: 1234 });
const entry = (commits = [], extra = {}) => ({ summary: summary(commits), error: null, checking: false, ...extra });
const window = createActivityWindow(new Date(2026, 9, 5, 12));
const authorEmails = ["own@example.com"];
const identityScope = (identities) => JSON.stringify(activityAuthorEmails(identities));
const turn = () => new Promise((resolve) => setImmediate(resolve));
function inTimezone(zone, run) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return run(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test("configured identity emails normalize whitespace, ASCII case, duplicates, and empty values", () => {
  assert.deepEqual(activityAuthorEmails([
    { email: "  ZED@Example.com\t" }, { email: "own@example.com" }, { email: " OWN@EXAMPLE.COM " },
    { email: "" }, { email: " \n\t " }, { email: "ÖWN@EXAMPLE.COM" },
  ]), ["own@example.com", "zed@example.com", "Öwn@example.com"]);
  assert.deepEqual(activityAuthorEmails([]), []);
});

test("activity scope includes every configured identity and ignores default selection, names, and order", () => {
  const identities = [
    { id: "personal", name: "Personal", email: "own@example.com", isDefault: true },
    { id: "work", name: "Work", email: "work@example.com", isDefault: false },
    { id: "legacy", name: "Old name", email: "legacy@example.com", isDefault: false },
  ];
  assert.deepEqual(activityAuthorEmails(identities), ["legacy@example.com", "own@example.com", "work@example.com"]);
  const renamedAndReordered = identities.toReversed().map((identity) => ({
    ...identity, name: `${identity.name} renamed`, isDefault: identity.id === "work",
  }));
  assert.equal(identityScope(renamedAndReordered), identityScope(identities));
});

test("adding or removing a configured email changes activity scope", () => {
  const identities = [{ email: "own@example.com" }, { email: "work@example.com" }];
  assert.notEqual(identityScope(identities.slice(0, 1)), identityScope(identities));
  assert.notEqual(identityScope([...identities, { email: "legacy@example.com" }]), identityScope(identities));
  assert.notEqual(identityScope([]), identityScope(identities));
});

test("an activity snapshot contributes only to its current repository and identity scope", () => {
  const snapshot = entry([commit("owned", new Date(2026, 9, 4, 12))]);
  const scopeKey = identityScope([{ email: "own@example.com" }]);
  const stored = { path: "/repos/a", scopeKey, value: snapshot };
  assert.equal(activityEntryForScope(stored, "/repos/a", scopeKey), snapshot);
  assert.equal(activityEntryForScope(stored, "/repos/moved", scopeKey), null);
  assert.equal(activityEntryForScope(undefined, "/repos/a", scopeKey), null);
  const changedScope = identityScope([{ email: "work@example.com" }]);
  const current = activityEntryForScope(stored, "/repos/a", changedScope);
  assert.equal(current, null);
  assert.equal(aggregateProjectActivity([project("a")], { a: current ?? entry() }, window).totalCommits, 0);
});

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
  const first = cache.read("/repo", { key: "first", window, authorEmails });
  const duplicate = cache.read("/repo", { key: "first", window, authorEmails });
  assert.equal(first, duplicate);
  await turn();
  release();
  await first;
  await cache.read("/repo", { key: "first", window, authorEmails });
  assert.equal(count, 1);
  const next = cache.read("/repo", { key: "new-revision", window, authorEmails });
  await turn();
  release();
  await next;
  assert.equal(count, 2);
});

test("errors remain explicit in cache and can be retried with a fresh generation", async () => {
  let calls = 0;
  const cache = createActivityCache(async () => { if (++calls === 1) throw new Error("Unavailable"); return summary(); });
  await assert.rejects(cache.read("/repo", { key: "first", window, authorEmails }), /Unavailable/);
  assert.equal(cache.get("/repo", "first").error, "Unavailable");
  await assert.rejects(cache.read("/repo", { key: "first", window, authorEmails }), /Unavailable/);
  assert.equal(calls, 1);
  assert.deepEqual(await cache.read("/repo", { key: "retry", window, authorEmails }), summary());
  assert.equal(cache.get("/repo", "retry").error, null);
});

test("an obsolete completion cannot overwrite a newer cached generation", async () => {
  const releases = [];
  const cache = createActivityCache(() => new Promise((resolve) => releases.push(resolve)));
  const old = cache.read("/repo", { key: "old", window, authorEmails });
  const next = cache.read("/repo", { key: "next", window, authorEmails });
  await turn();
  releases[1](summary([{ oid: "new", committedAt: window.fromTimestamp }]));
  await next;
  releases[0](summary([{ oid: "old", committedAt: window.fromTimestamp }]));
  await old;
  assert.equal(cache.get("/repo", "next").summary.commits[0].oid, "new");
});

test("identity scope changes request fresh native data and pass the complete configured email list", async () => {
  const calls = [];
  const cache = createActivityCache(async (path, fromTimestamp, toTimestamp, emails) => {
    calls.push({ path, fromTimestamp, toTimestamp, emails });
    return summary([{ oid: emails.join("+"), committedAt: fromTimestamp }]);
  });
  const firstEmails = activityAuthorEmails([{ email: "own@example.com" }]);
  const nextEmails = activityAuthorEmails([{ email: "work@example.com" }, { email: "own@example.com" }]);
  const first = { key: `${window.key}:${JSON.stringify(firstEmails)}`, window, authorEmails: firstEmails };
  const next = { key: `${window.key}:${JSON.stringify(nextEmails)}`, window, authorEmails: nextEmails };
  await cache.read("/repo", first);
  await cache.read("/repo", first);
  const result = await cache.read("/repo", next);
  assert.deepEqual(calls, [
    { path: "/repo", fromTimestamp: window.fromTimestamp, toTimestamp: window.toTimestamp, emails: firstEmails },
    { path: "/repo", fromTimestamp: window.fromTimestamp, toTimestamp: window.toTimestamp, emails: nextEmails },
  ]);
  assert.equal(result.commits[0].oid, "own@example.com+work@example.com");
  assert.equal(cache.get("/repo", first.key), undefined);
  assert.equal(cache.get("/repo", next.key).summary, result);
});

test("a late read for an old identity scope cannot overwrite the new scope's snapshot", async () => {
  const releases = [];
  const cache = createActivityCache((path, fromTimestamp, toTimestamp, emails) => new Promise((resolve) => {
    releases.push({ emails, resolve });
  }));
  const oldEmails = ["own@example.com"];
  const newEmails = ["work@example.com"];
  const oldKey = `${window.key}:${JSON.stringify(oldEmails)}`;
  const newKey = `${window.key}:${JSON.stringify(newEmails)}`;
  const old = cache.read("/repo", { key: oldKey, window, authorEmails: oldEmails });
  const next = cache.read("/repo", { key: newKey, window, authorEmails: newEmails });
  await turn();
  assert.deepEqual(releases.map((read) => read.emails), [oldEmails, newEmails]);
  releases[1].resolve(summary([{ oid: "work-commit", committedAt: window.fromTimestamp }]));
  await next;
  releases[0].resolve(summary([{ oid: "personal-commit", committedAt: window.fromTimestamp }]));
  await old;
  assert.equal(cache.get("/repo", oldKey), undefined);
  assert.equal(cache.get("/repo", newKey).summary.commits[0].oid, "work-commit");
});

test("removed project paths are not retained by a late successful read", async () => {
  let release;
  const cache = createActivityCache(() => new Promise((resolve) => { release = resolve; }));
  cache.retain(["/repo"]);
  const read = cache.read("/repo", { key: "one", window, authorEmails });
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
  const request = { key: "one", window, authorEmails };
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
test("native API wrapper preserves epoch seconds, identity emails, and the complete commit payload", async () => {
  const configuredEmails = ["own@example.com", "work@example.com"];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    assert.deepEqual([command, args], ["git_project_activity", { path: "/repo", fromTimestamp: window.fromTimestamp, toTimestamp: window.toTimestamp, authorEmails: configuredEmails }]);
    return summary([{ oid: "full-object-id", committedAt: window.fromTimestamp }]);
  } } };
  assert.deepEqual(await loadProjectActivity("/repo", window.fromTimestamp, window.toTimestamp, configuredEmails), summary([{ oid: "full-object-id", committedAt: window.fromTimestamp }]));
});
