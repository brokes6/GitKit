import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import ts from "typescript";
import { branchColor, createBranchColors } from "../src/branchColors.ts";
import { attributeBranches, computeGraph } from "../src/git.ts";

const app = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect;
const visit = node => {
  if (ts.isCallExpression(node) && node.expression.getText(app) === "useEffect"
    && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])
    && node.arguments[1].elements.map(value => value.getText(app)).join(",") === "path,reloadTick") effect = node.arguments[0];
  ts.forEachChild(node, visit);
};
visit(app);
assert.ok(effect);
const components = app.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["CommitHistorySkeleton", "HistoryRefreshBoundary"].includes(node.name?.text));
const source = ts.transpileModule(`${components.map(node => node.getText(app)).join("\n")}
globalThis.readHistory = ${effect.getText(app)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);

function harness(history = async () => [], info = { initialized: true, has_head: true, current_branch: "main" }) {
  const selection = { fullHash: "selected-commit" };
  const state = { loadingPath: null, error: null, data: { path: "/repo", commits: [selection] }, selection, opens: 0 };
  const context = {
    React, HistoryRefreshCtx: React.createContext(false), useTheme: () => ({}), tx: value => value, Skeleton: () => null,
    branchColor, createBranchColors, realData: state.data, hiddenBranchesRef: { current: [] },
    path: "/repo", lastLoadedPath: { current: "/repo" },
    pendingViewReset: { current: false }, smartMergeRef: { current: false },
    commitDiffRequestRef: { current: 0 }, activePathRef: { current: "/repo" },
    realCache: { current: new Map() }, workingCache: { current: new Map() },
    historyLimits: { current: new Map() }, HISTORY_PAGE_SIZE: 400, showOtherRefsRef: { current: false },
    cacheRealData: (cache, path, data) => cache.set(path, data),
    openRepo: async () => { state.opens++; return info; },
    loadHistory: history, loadBranches: async () => [], loadRemotes: async () => [], stashList: async () => [],
    requestWorkingStatusRef: { current: async () => [] }, applyWorkingStatusRef: { current() {} },
    attributeBranches, computeGraph, startSwitch: apply => apply(),
    setHistoryReadPath: value => { state.loadingPath = value; },
    setLoadError: value => { state.error = value; }, setRealData: value => { state.data = value; },
    setSelectedCommit: value => { state.selection = value; },
    setCurrentBranch() {}, setProjects(update) { update([]); }, setWorkingSnapshot() {},
    setSelectedFile() {}, setSelectedWorkingFile() {}, setSelectedStash() {}, setSelectedStashFile() {},
    setFocusBranch() {}, setViewChanges() {}, setDetailOpen() {}, setDetailClosing() {},
  };
  runInNewContext(source, context);
  return { state, context, start(path = "/repo") { context.path = path; return context.readHistory(); } };
}

test("a same-repository refresh loads until history is ready and preserves the selected commit", async () => {
  const read = deferred(), { state, start } = harness(() => read.promise);
  const selection = state.selection;
  start();
  assert.equal(state.loadingPath, "/repo");
  await flush();
  assert.equal(state.loadingPath, "/repo");
  read.resolve([]);
  await flush();
  assert.equal(state.loadingPath, null);
  assert.equal(state.data.path, "/repo");
  assert.equal(state.selection, selection);
});

test("repository loading publishes one shared palette for its branch list and graph", async () => {
  const branches = [{ name: "master", head: "master-tip", current: true },
    { name: "test", head: "test-tip" }, { name: "feature/rpc-proxy-fallback", head: "feature-tip" }];
  const commits = branches.map(branch => ({ fullHash: branch.head, parents: [] }));
  const { state, context, start } = harness(async () => commits);
  context.loadBranches = async () => branches;
  start(); await flush();
  const colors = state.data.branchColors;
  assert.equal(new Set(state.data.branches.map(branch => branch.color)).size, 3);
  state.data.branches.forEach(branch => assert.equal(branch.color, colors.get(branch.name)));
  commits.forEach((commit, index) => assert.equal(state.data.graph[index].colors.dot, colors.get(commit.branchLabel)));
});

test("a failed history refresh ends loading and exposes the error", async () => {
  const read = deferred(), { state, start } = harness(() => read.promise);
  const original = state.data;
  start(); await flush();
  read.reject(new Error("history unavailable"));
  await flush();
  assert.equal(state.loadingPath, null);
  assert.equal(state.error.path, "/repo");
  assert.match(state.error.msg, /history unavailable/);
  assert.equal(state.data, original);
});

test("an older refresh cannot clear loading or replace a newer refresh of the same repository", async () => {
  const older = deferred(), newer = deferred(), reads = [older, newer];
  const { state, start } = harness(() => reads.shift().promise);
  const original = state.data;
  const cancel = start(); await flush();
  cancel(); start(); await flush();
  older.resolve([]); await flush();
  assert.equal(state.loadingPath, "/repo");
  assert.equal(state.data, original);
  newer.resolve([]); await flush();
  assert.equal(state.loadingPath, null);
  assert.notEqual(state.data, original);
});

test("switching projects ignores the completed read and error from the previous project", async () => {
  const older = deferred(), newer = deferred(), reads = [older, newer];
  const { state, start } = harness(() => reads.shift().promise);
  const cancel = start(); await flush();
  cancel(); start("/other"); await flush();
  older.reject(new Error("old project unavailable")); await flush();
  assert.equal(state.loadingPath, "/other");
  assert.equal(state.error, null);
  newer.resolve([]); await flush();
  assert.equal(state.loadingPath, null);
  assert.equal(state.data.path, "/other");
});

test("a cache hit and a project without a Git repository never leave loading active", async () => {
  const cached = harness();
  cached.context.realCache.current.set("/repo", { ...cached.state.data, branches: [] });
  cached.start();
  assert.equal(cached.state.loadingPath, null);
  assert.equal(cached.state.opens, 0);
  const plain = harness(undefined, { initialized: false });
  plain.start(); await flush();
  assert.equal(plain.state.loadingPath, null);
  assert.equal(plain.state.data.initialized, false);
});

test("refresh keeps the same interactive viewport alongside a nonblocking status", () => {
  const { context } = harness();
  const viewport = React.createElement("div", { key: "viewport" });
  for (const refreshing of [true, false]) {
    const boundary = context.HistoryRefreshBoundary({ refreshing, children: viewport });
    const [content, status] = boundary.props.children;
    assert.equal(content.props.children, viewport);
    assert.equal(boundary.props.inert, undefined);
    assert.equal(boundary.props["aria-hidden"], undefined);
    if (refreshing) {
      assert.equal(status.props.role, "status");
      assert.match(status.props.className, /pointer-events-none/);
    } else assert.equal(status, false);
  }
});

test("a reload keeps the history depth the user already scrolled to", async () => {
  const limits = [];
  const { context, start } = harness(async (path, limit) => { limits.push(limit); return []; });
  start();
  await flush();
  context.historyLimits.current.set("/repo", 1200);
  context.realCache.current.clear();
  start();
  await flush();
  assert.deepEqual(limits, [400, 1200]);
});

test("history is read without internal refs unless the user switched them on", async () => {
  const flags = [];
  const { context, start } = harness(async (path, limit, includeOtherRefs) => { flags.push(includeOtherRefs); return []; });
  start(); await flush();
  context.realCache.current.clear();
  context.showOtherRefsRef.current = true;
  start(); await flush();
  assert.deepEqual(flags, [false, true]);
});

test("ref notifications invalidate the right history while file-only events keep it cached", () => {
  let listenerEffect, foregroundEffect;
  const findListener = node => {
    if (ts.isCallExpression(node) && node.expression.getText(app) === "useEffect"
      && node.arguments[0].getText(app).includes('"working-tree-changed"')) listenerEffect = node.arguments[0];
    if (ts.isCallExpression(node) && node.expression.getText(app) === "useEffect"
      && node.arguments[1]?.getText(app) === "[appForeground, appFocusRevision]") foregroundEffect = node.arguments[0];
    ts.forEachChild(node, findListener);
  };
  findListener(app);
  let receive;
  let reloads = 0;
  const statuses = [];
  const cache = new Map([["/repo", {}], ["/warm", {}]]);
  const foreground = { current: true }, pending = { current: null };
  const js = ts.transpileModule(`globalThis.attach = ${listenerEffect.getText(app)}; globalThis.resume = ${foregroundEffect.getText(app)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = { listen: (_, fn) => { receive = fn; return Promise.resolve(() => {}); },
    realCache: { current: cache }, activePathRef: { current: "/repo" }, appForegroundRef: foreground,
    watchedPaths: { current: ["/repo", "/warm"] }, pendingHistoryRefresh: pending, historyListenerFailed: { current: false },
    scheduleWorkingStatusRef: { current: path => statuses.push(path) }, setReloadTick: () => reloads++ };
  runInNewContext(js, context);
  context.attach();
  const emit = (path, history) => receive({ payload: { path, paths: [], full: true, history } });
  emit("/repo", false);
  emit("/warm", true);
  assert.equal(cache.has("/repo"), true);
  assert.equal(cache.has("/warm"), false);
  assert.equal(reloads, 0);
  emit("/repo", true);
  assert.equal(cache.has("/repo"), false);
  assert.equal(reloads, 1);
  foreground.current = false;
  emit("/repo", true);
  assert.equal(reloads, 1);
  assert.equal(pending.current, "/repo");
  assert.deepEqual(statuses, ["/repo", "/warm", "/repo"]);
  Object.assign(context, { appForeground: true, uninitializedRef: { current: false },
    failedHistoryWatches: { current: new Set() } });
  context.resume();
  assert.equal(reloads, 2);
  assert.equal(pending.current, null);
  context.resume();
  assert.equal(reloads, 2);
});
