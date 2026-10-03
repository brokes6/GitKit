import test from "node:test";
import assert from "node:assert/strict";
import { mapWorkingStatus, workingFileKey, workingFileCount, sameWorking, mergeWorkingPaths, shouldRefreshWorkingFile } from "../src/workingStatus.ts";

const entry = (path, xy, original_path = null) => ({ path, original_path, index_status: xy[0], work_status: xy[1], staged: xy[0] !== " " && xy[0] !== "?" });
const snapshot = (entries, revision = "reviewed-index") => mapWorkingStatus({ entries, revision });

test("unrelated saves retain the selected preview while same-XY content changes still reload", () => {
  const selected = { path: "src/a.ts", originalPath: "src/old.ts" };
  assert.equal(shouldRefreshWorkingFile(selected, ["src/b.ts"]), false);
  assert.equal(shouldRefreshWorkingFile(selected, ["src/a.ts"]), true);
  assert.equal(shouldRefreshWorkingFile(selected, ["src/old.ts"]), true);
  assert.equal(shouldRefreshWorkingFile(selected, ["src"]), true);
  assert.equal(shouldRefreshWorkingFile(selected, ["sr"]), false);
  assert.equal(shouldRefreshWorkingFile(selected, []), false);
  assert.equal(shouldRefreshWorkingFile(selected), true);
});

test("a staged file edited again has two independently selectable previews and counts once", () => {
  const rows = snapshot([entry("src/app.ts", "MM"), entry("notes.txt", "??")]);
  assert.deepEqual(rows.map(({ path, staged, status }) => ({ path, staged, status })), [
    { path: "src/app.ts", staged: true, status: "modified" },
    { path: "src/app.ts", staged: false, status: "modified" },
    { path: "notes.txt", staged: false, status: "untracked" },
  ]);
  assert.notEqual(workingFileKey(rows[0]), workingFileKey(rows[1]));
  assert.equal(workingFileCount(rows), 2);
  assert.ok(rows.slice(0, 2).every((row) => row.hasStaged && row.hasUnstaged));
});

test("added then edited, deleted and externally staged files retain source-specific status", () => {
  const rows = snapshot([entry("new.txt", "AM"), entry("gone.txt", " D"), entry("external.txt", "M ")]);
  assert.deepEqual(rows.map((row) => [row.path, row.staged, row.status]), [
    ["new.txt", true, "added"], ["new.txt", false, "modified"],
    ["gone.txt", false, "deleted"], ["external.txt", true, "modified"],
  ]);
});

test("conflicts require resolution rather than appearing ready for commit", () => {
  for (const xy of ["UU", "AA", "DD", "AU", "UA", "DU", "UD"]) {
    const rows = snapshot([entry("conflict.txt", xy)]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].staged, false);
    assert.equal(rows[0].status, "conflicted");
  }
});

test("incremental refresh keeps both sources, removes clean paths and handles rename sources", () => {
  const previous = snapshot([entry("new.txt", "RM", "old.txt"), entry("keep.txt", "MM"), entry("clean.txt", " M")]);
  const fresh = snapshot([entry("new.txt", "R ", "old.txt")]);
  const merged = mergeWorkingPaths(previous, ["old.txt", "clean.txt"], fresh);
  assert.equal(merged.filter((row) => row.path === "keep.txt").length, 2);
  assert.equal(merged.filter((row) => row.path === "new.txt").length, 1);
  assert.ok(!merged.some((row) => row.path === "clean.txt"));
  assert.equal(merged.find((row) => row.path === "new.txt").originalPath, "old.txt");
});

test("same XY with different index or HEAD revision invalidates cached working status", () => {
  const entries = [entry("a.txt", "MM")];
  assert.equal(sameWorking(snapshot(entries), snapshot(entries)), true);
  assert.equal(sameWorking(snapshot(entries), snapshot(entries, "external-change")), false);
  assert.equal(sameWorking(snapshot(entries), snapshot([entry("a.txt", "M ")])), false);
});

test("a destination-only rename refresh replaces the old deleted row", () => {
  const previous = snapshot([entry("old.txt", " D"), entry("new.txt", "??")]);
  const merged = mergeWorkingPaths(previous, ["new.txt"], snapshot([entry("new.txt", "R ", "old.txt")]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "renamed");
});

test("literal paths do not collide and copies never include unrelated source preview", () => {
  const rows = snapshot([entry("a:\ntrue", "MM"), entry("复制 [x].txt", "C ", "source.txt")]);
  assert.equal(new Set(rows.map(workingFileKey)).size, rows.length);
  assert.equal(rows.at(-1).originalPath, undefined);
});
