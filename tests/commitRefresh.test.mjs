import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const app = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration;
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === "doCommit") declaration = node;
  ts.forEachChild(node, visit);
};
visit(app);
assert.ok(declaration);
const source = ts.transpileModule(`const ${declaration.getText(app)}; globalThis.doCommit = doCommit;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

const branch = { name: "main", head: "committed-head", current: true, color: "blue", remote: "origin/main", ahead: 1, behind: 0 };
const files = [{ path: "file.txt", staged: true, revision: "reviewed-index" }];
function harness(commit = async () => branch, data = {}) {
  const state = { view: { path: "/repo", hasHead: true, branches: [{ ...branch, head: "old-head", ahead: 0 }], ...data },
    reloads: [], successes: [], statusReads: [] };
  const context = {
    identities: [{}], activeProject: { path: "/repo" }, activePathRef: { current: "/repo" },
    currentBranch: "main", gitBusy: null, busyLabel: null,
    workingOperationRef: { current: false }, workingMutationEpoch: { current: new Map() },
    realCache: { current: new Map([["/repo", state.view]]) },
    openIdentitySettings() {}, openRepo: async () => ({ current_branch: "main" }), gitCommit: commit,
    setBusyLabel(value) { context.busyLabel = value; },
    setRealData(update) { state.view = update(state.view); },
    setCurrentBranch(value) { context.currentBranch = value; },
    setReloadTick() { state.reloads.push(state.view); },
    scheduleWorkingStatusRef: { current: path => state.statusReads.push(path) },
    workingFileCount: rows => new Set(rows.map(row => row.path)).size,
    tx: value => value, tf: value => value, toast: { success: value => state.successes.push(value) },
  };
  runInNewContext(source, context);
  return { state, context, run: () => context.doCommit("message", files, null) };
}

test("commit updates the push count on success before the full history refresh", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { state, context, run } = harness(() => pending);
  const task = run();
  assert.equal(state.view.branches[0].ahead, 0);
  assert.equal(state.reloads.length, 0);
  resolve(branch);
  await task;
  assert.equal(state.view.branches[0].ahead, 1);
  assert.equal(state.view.branches[0].head, "committed-head");
  assert.equal(state.reloads[0].branches[0].ahead, 1);
  assert.equal(context.busyLabel, null);
  assert.equal(context.workingOperationRef.current, false);
});

test("commit uses the returned ahead and behind counts instead of incrementing stale UI state", async () => {
  const { state, run } = harness(async () => ({ ...branch, ahead: 4, behind: 2 }));
  await run();
  assert.equal(state.view.branches[0].ahead, 4);
  assert.equal(state.view.branches[0].behind, 2);
});

test("the first commit immediately creates its local branch state", async () => {
  const { state, run } = harness(async () => ({ ...branch, remote: undefined, ahead: 0 }), { hasHead: false, branches: [] });
  await run();
  assert.equal(state.view.hasHead, true);
  assert.equal(state.view.branches[0].name, "main");
  assert.equal(state.view.branches[0].ahead, 0);
});

test("a late commit result never replaces another repository's branch state", async () => {
  let resolve, started;
  const pending = new Promise(done => { resolve = done; });
  const entered = new Promise(done => { started = done; });
  const { state, context, run } = harness(() => { started(); return pending; });
  const task = run();
  await entered;
  const other = { path: "/other", branches: [{ ...branch, name: "other", ahead: 7 }] };
  state.view = other;
  context.activePathRef.current = "/other";
  context.currentBranch = "other";
  resolve(branch);
  await task;
  assert.equal(state.view, other);
  assert.equal(context.currentBranch, "other");
});

test("a failed commit leaves counts unchanged and remains rejected", async () => {
  const { state, context, run } = harness(async () => { throw new Error("hook rejected commit"); });
  await assert.rejects(run(), /hook rejected commit/);
  assert.equal(state.view.branches[0].ahead, 0);
  assert.equal(state.reloads.length, 0);
  assert.equal(state.successes.length, 0);
  assert.equal(context.workingOperationRef.current, false);
});

test("an unavailable post-commit snapshot still completes and refreshes the repository", async () => {
  const { state, run } = harness(async () => null);
  await run();
  assert.equal(state.successes.length, 1);
  assert.equal(state.reloads.length, 1);
  assert.equal(state.view.branches[0].ahead, 0);
});
