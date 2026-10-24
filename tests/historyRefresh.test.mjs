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
    React, useTheme: () => ({}), tx: value => value, Skeleton: () => null,
    branchColor, createBranchColors, realData: state.data, hiddenBranchesRef: { current: [] },
    path: "/repo", lastLoadedPath: { current: "/repo" },
    pendingViewReset: { current: false }, pendingJumpLatest: { current: false },
    commitDiffRequestRef: { current: 0 }, activePathRef: { current: "/repo" },
    realCache: { current: new Map() }, workingCache: { current: new Map() },
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

test("the refresh skeleton retains the mounted viewport and blocks hidden interactions", () => {
  const { context } = harness();
  const viewport = React.createElement("div", { key: "viewport" });
  const loading = context.HistoryRefreshBoundary({ refreshing: true, children: viewport });
  const [content, overlay] = React.Children.toArray(loading.props.children);
  assert.equal(content.props.children, viewport);
  assert.equal(content.props.style.visibility, "hidden");
  assert.equal(content.props["aria-hidden"], true);
  const element = {};
  content.ref(element);
  assert.equal(element.inert, true);
  assert.equal(overlay.props.children.type, context.CommitHistorySkeleton);
  const ready = context.HistoryRefreshBoundary({ refreshing: false, children: viewport });
  const [visible, removedOverlay] = React.Children.toArray(ready.props.children);
  assert.equal(visible.props.children, viewport);
  visible.ref(element);
  assert.equal(element.inert, false);
  assert.equal(visible.props.style.visibility, undefined);
  assert.equal(removedOverlay, undefined);
});
