import test from "node:test";
import assert from "node:assert/strict";
import { loadStatus, loadWorkingStatus, stageFiles, unstageFiles, workingFileDiff, commit } from "../src/git.ts";

const previousWindow = globalThis.window;
test.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
const mock = (invoke) => { globalThis.window = { __TAURI_INTERNALS__: { invoke } }; };
const state = { revision: "reviewed-index", entries: [
  { path: "a.txt", original_path: null, index_status: "M", work_status: "M", staged: true },
] };

test("index invalidation carries an authoritative result even for a clean requested path", async () => {
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_staging_status", { path: "/repo", paths: ["clean.txt"] }]);
    return { entries: [], revision: "new-index", full: true };
  });
  assert.deepEqual(await loadWorkingStatus("/repo", ["clean.txt"]), { files: [], revision: "new-index", full: true });
});

test("real status and mutation responses retain both sources and the commit revision", async () => {
  const expected = [
    ["git_staging_status", { path: "/repo", paths: null }],
    ["git_stage_files", { path: "/repo", files: ["a.txt"] }],
    ["git_unstage_files", { path: "/repo", files: ["a.txt"] }],
  ];
  mock(async (command, args) => {
    assert.deepEqual([command, args], expected.shift());
    return state;
  });
  for (const read of [() => loadStatus("/repo"), () => stageFiles("/repo", ["a.txt"]), () => unstageFiles("/repo", ["a.txt"])]) {
    const rows = await read();
    assert.deepEqual(rows.map((row) => row.staged), [true, false]);
    assert.ok(rows.every((row) => row.revision === state.revision));
  }
  assert.equal(expected.length, 0);
});

test("diff requests specify their index side and preserve literal rename paths", async () => {
  const requests = [];
  mock(async (command, args) => { requests.push([command, args]); return "@@ -1 +1 @@\n-old\n+new\n"; });
  await workingFileDiff("/repo", "新 [a].txt", true, "旧 [a].txt");
  await workingFileDiff("/repo", "新 [a].txt", false);
  assert.deepEqual(requests, [
    ["working_file_diff", { path: "/repo", file: "新 [a].txt", staged: true, originalPath: "旧 [a].txt" }],
    ["working_file_diff", { path: "/repo", file: "新 [a].txt", staged: false, originalPath: null }],
  ]);
});

test("commit sends only the reviewed revision and chosen identity without staging paths", async () => {
  mock(async (command, args) => {
    assert.equal(command, "git_commit");
    assert.deepEqual(args, { path: "/repo", message: "snapshot", expectedRevision: "reviewed-index", name: "Author", email: "author@example.invalid" });
  });
  await commit("/repo", "snapshot", "reviewed-index", "Author", "author@example.invalid");
});

test("a rejected commit stays rejected so the composer retains its draft", async () => {
  mock(async () => { throw "hook rejected commit"; });
  await assert.rejects(commit("/repo", "keep this draft", "reviewed-index"), (error) => error === "hook rejected commit");
});
