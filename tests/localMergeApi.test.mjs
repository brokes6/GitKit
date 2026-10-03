import test from "node:test";
import assert from "node:assert/strict";
import {
  localMergePreview, mergeLocal, loadRepoOperation, continueMerge, abortMerge, mergeTool,
  mergePreview, continueCherryPick, abortCherryPick, cherryPick,
} from "../src/git.ts";

const previousWindow = globalThis.window;
test.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
const mock = (invoke) => { globalThis.window = { __TAURI_INTERNALS__: { invoke } }; };
const preview = {
  branch: "main", head: "reviewed-destination", source: "feature/登录", sourceHead: "reviewed-source",
  kind: "merge", conflicts: ["新 [a].txt"], files: ["新 [a].txt", "clean.txt"],
};
const operation = {
  kind: "merge", branch: "main", head: "reviewed-destination", conflicts: ["新 [a].txt"],
  stagedFiles: ["clean.txt"], unstagedFiles: ["新 [a].txt"],
  message: "Merge branch 'feature/登录'", revision: "reviewed-operation",
  canContinue: false, canAbort: true,
};

test("local preview retains the compared commits, paths and merge kind", async () => {
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_local_merge_preview", { path: "/repo", source: "feature/登录" }]);
    return preview;
  });
  assert.deepEqual(await localMergePreview("/repo", "feature/登录"), preview);
});

test("merge uses the exact preview commits and chosen project identity", async () => {
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_local_merge", {
      path: "/repo", source: "feature/登录", expectedBranch: "main",
      expectedHead: "reviewed-destination", expectedSourceHead: "reviewed-source",
      name: "Author", email: "author@example.invalid",
    }]);
    return { status: "conflict", operation };
  });
  assert.deepEqual(await mergeLocal("/repo", preview, "Author", "author@example.invalid"), {
    status: "conflict", operation,
  });
});

test("up-to-date merge and idle repository retain their null operation", async () => {
  const expected = [
    ["git_local_merge", {
      path: "/repo", source: "feature/登录", expectedBranch: "main",
      expectedHead: "reviewed-destination", expectedSourceHead: "reviewed-source", name: null, email: null,
    }],
    ["git_operation_state", { path: "/repo" }],
  ];
  mock(async (command, args) => {
    assert.deepEqual([command, args], expected.shift());
    return command === "git_local_merge" ? { status: "up-to-date", operation: null } : null;
  });
  assert.deepEqual(await mergeLocal("/repo", preview), { status: "up-to-date", operation: null });
  assert.equal(await loadRepoOperation("/repo"), null);
  assert.equal(expected.length, 0);
});

test("operation state retains externally started operations and capabilities", async () => {
  const external = { ...operation, kind: "rebase", message: "", canContinue: false, canAbort: false };
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_operation_state", { path: "/repo" }]);
    return external;
  });
  assert.deepEqual(await loadRepoOperation("/repo"), external);
});

test("continue, abort and conflict-tool actions all send the reviewed operation revision", async () => {
  const expected = [
    ["git_merge_continue", {
      path: "/repo", expectedRevision: "reviewed-operation", message: "Keep the reviewed merge message",
      name: "Author", email: "author@example.invalid",
    }],
    ["git_merge_continue", {
      path: "/repo", expectedRevision: "reviewed-operation", message: "Use Git identity", name: null, email: null,
    }],
    ["git_merge_abort", { path: "/repo", expectedRevision: "reviewed-operation" }],
    ["git_merge_tool", { path: "/repo", expectedRevision: "reviewed-operation" }],
  ];
  mock(async (command, args) => { assert.deepEqual([command, args], expected.shift()); });
  await continueMerge("/repo", operation.revision, "Keep the reviewed merge message", "Author", "author@example.invalid");
  await continueMerge("/repo", operation.revision, "Use Git identity");
  await abortMerge("/repo", operation.revision);
  await mergeTool("/repo", operation.revision);
  assert.equal(expected.length, 0);
});

test("stale previews and hook failures remain rejected for the UI to refresh or retry", async () => {
  const rejected = [
    [() => localMergePreview("/repo", preview.source), "working tree changed"],
    [() => mergeLocal("/repo", preview), "source commit changed"],
    [() => continueMerge("/repo", operation.revision, operation.message), "commit hook rejected merge"],
    [() => abortMerge("/repo", operation.revision), "operation revision changed"],
    [() => mergeTool("/repo", operation.revision), "conflict tool unavailable"],
  ];
  for (const [action, failure] of rejected) {
    mock(async () => { throw failure; });
    await assert.rejects(action(), (error) => error === failure);
  }
});

test("cherry-pick continuation sends the reviewed revision and committer without rewriting the message", async () => {
  const nextConflict = { ...operation, kind: "cherry-pick", head: "first-pick-committed", revision: "next-pick" };
  const expected = [
    ["git_cherry_pick_continue", {
      path: "/repo", expectedRevision: "reviewed-operation", name: "Committer", email: "committer@example.invalid",
    }],
    ["git_cherry_pick_continue", {
      path: "/repo", expectedRevision: "next-pick", name: null, email: null,
    }],
  ];
  mock(async (command, args) => {
    assert.deepEqual([command, args], expected.shift());
    return args.expectedRevision === "reviewed-operation" ? nextConflict : null;
  });
  assert.deepEqual(await continueCherryPick("/repo", operation.revision, "Committer", "committer@example.invalid"), nextConflict);
  assert.equal(await continueCherryPick("/repo", nextConflict.revision), null);
  assert.equal(expected.length, 0);
});

test("cherry-pick abort uses its own command and the reviewed operation", async () => {
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_cherry_pick_abort", { path: "/repo", expectedRevision: "reviewed-operation" }]);
  });
  await abortCherryPick("/repo", operation.revision);
});

test("resolved cherry-pick results remain paused rather than reporting a completed pick", async () => {
  const resolved = { status: "resolved", conflicts: [] };
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_cherry_pick", {
      path: "/repo", hash: "source-pick", target: "main", useKaleidoscope: true,
    }]);
    return resolved;
  });
  assert.deepEqual(await cherryPick("/repo", "source-pick", "main", true), resolved);
});

test("cherry-pick stale, empty and hook failures remain rejected", async () => {
  const rejected = [
    [() => continueCherryPick("/repo", operation.revision), "operation revision changed"],
    [() => continueCherryPick("/repo", operation.revision), "empty pick requires an explicit choice"],
    [() => continueCherryPick("/repo", operation.revision), "commit hook rejected pick"],
    [() => abortCherryPick("/repo", operation.revision), "cannot restore the sequence"],
  ];
  for (const [action, failure] of rejected) {
    mock(async () => { throw failure; });
    await assert.rejects(action(), (error) => error === failure);
  }
});

test("pull-request conflict preview keeps its existing source and target API", async () => {
  mock(async (command, args) => {
    assert.deepEqual([command, args], ["git_merge_preview", { path: "/repo", source: "feature/登录", target: "main" }]);
    return { conflict: true, files: ["新 [a].txt"] };
  });
  assert.deepEqual(await mergePreview("/repo", "feature/登录", "main"), { conflict: true, files: ["新 [a].txt"] });
});
