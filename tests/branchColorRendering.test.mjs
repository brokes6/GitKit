import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import ts from "typescript";

const app = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pill = app.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "RefPill");
assert.ok(pill);
const source = ts.transpileModule(pill.getText(app), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const descendants = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(descendants)] : [];

function harness() {
  const palette = new Map([["master", "#aa6611"], ["origin/master", "#aa6611"], ["test", "#1188aa"]]);
  let pos = null, refreshing = false;
  const effects = [];
  let cleanups = [];
  const context = {
    React, R: 10, BranchColorsCtx: {}, HistoryRefreshCtx: {}, useTheme: () => ({ amber: "#b78338" }),
    useContext: ctx => ctx === context.BranchColorsCtx ? palette : refreshing,
    useEffect: effect => effects.push(effect),
    useRef: () => ({ current: { getBoundingClientRect: () => ({ left: 80, top: 120 }) } }),
    useState: () => [pos, value => { pos = value; }], tx: value => value, tf: value => value,
    Laptop: () => null, Cloud: () => null,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    createPortal: children => React.createElement("portal", null, children),
    branchColor: (name, colors) => { assert.equal(colors, palette); return colors.get(name); },
  };
  runInNewContext(source, context);
  return { context, palette, setRefreshing: value => { refreshing = value; }, render(b) {
    const tree = context.RefPill({ b });
    cleanups.forEach(cleanup => cleanup?.());
    cleanups = effects.splice(0).map(effect => effect());
    return descendants(tree);
  } };
}

test("local and remote ref icons use the active repository's shared color snapshot", () => {
  const { context, palette, render } = harness();
  const local = render({ kind: "both", name: "master" });
  const icons = local.filter(node => node.type === context.Laptop || node.type === context.Cloud);
  assert.equal(icons.length, 2);
  icons.forEach(icon => assert.equal(icon.props.style.color, palette.get("master")));
  const remote = render({ kind: "remote", name: "master", colorName: "origin/master" });
  assert.equal(remote.find(node => node.type === context.Cloud).props.style.color, palette.get("master"));
  const other = render({ kind: "local", name: "test" });
  assert.equal(other.find(node => node.type === context.Laptop).props.style.color, palette.get("test"));
});

test("tags retain the existing tag color rather than receiving a branch color", () => {
  const { render } = harness();
  const nodes = render({ kind: "tag", name: "v1.0" });
  assert.ok(nodes.some(node => node.type === "span" && node.props.style?.color === "#b78338"));
});

test("collapsed ref labels inherit visibility from a hidden history or detail layer", () => {
  const { render } = harness();
  const nodes = render({ kind: "both", name: "master" });
  const label = nodes.find(node => node.props.className?.includes("w-full"));
  assert.notEqual(label.props.style.visibility, "visible");
});

test("refreshing immediately removes an open hover portal and prevents it from reappearing", () => {
  const { render, setRefreshing } = harness();
  const branch = { kind: "both", name: "master" };
  render(branch)[0].props.onMouseEnter();
  assert.ok(render(branch).some(node => node.type === "portal"));
  setRefreshing(true);
  const refreshing = render(branch);
  assert.ok(!refreshing.some(node => node.type === "portal"));
  refreshing[0].props.onMouseEnter();
  setRefreshing(false);
  assert.ok(!render(branch).some(node => node.type === "portal"));
  render(branch)[0].props.onMouseEnter();
  assert.ok(render(branch).some(node => node.type === "portal"));
});
