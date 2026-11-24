import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import ts from "typescript";

function timeline(scrollTop = 0, reduced = false) {
  const code = readFileSync(new URL("../src/HistoryInsertion.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  const context = { exports: {}, require: () => React, CSS: { escape: value => value },
    window: { matchMedia: () => ({ matches: reduced }) } };
  runInNewContext(output, context);
  const view = { scrollTop, clientHeight: 180, getBoundingClientRect: () => ({ top: 0 }) };
  const props = hashes => ({ scope: "repo", viewport: { current: view }, commits: hashes.map(fullHash => ({ fullHash })) });
  const previous = props(["a", "b", "c"]);
  const motion = [];
  const animate = frames => { motion.push(frames); return { cancel() {} }; };
  const list = { animate, querySelector(selector) {
    const hash = selector.match(/="(.*?)"/)?.[1];
    return hash ? this.children.find(child => child.dataset?.commitHash === hash) : this.children[1];
  } };
  const layout = hashes => { list.children = [{}, ...hashes.map((hash, i) => ({
    dataset: { commitHash: hash }, offsetTop: i * 70, animate, getBoundingClientRect: () => ({
      top: i * 70 - view.scrollTop, bottom: (i + 1) * 70 - view.scrollTop,
    }),
  }))]; };
  layout(["a", "b", "c"]);
  const instance = new context.exports.HistoryInsertion(previous);
  instance.root.current = { querySelector: () => list };
  const update = (hashes, scope = "repo") => {
    instance.props = { ...props(hashes), scope };
    const anchor = instance.getSnapshotBeforeUpdate(previous);
    layout(hashes);
    instance.componentDidUpdate(previous, {}, anchor);
  };
  return { view, update, motion };
}

test("two new commits displace the existing rows by their combined height", () => {
  const { update, motion, view } = timeline();
  update(["x", "y", "a", "b", "c"]);
  assert.equal(motion[0][0].transform, "translateY(-140px)");
  assert.equal(motion.length, 3);
  assert.equal(view.scrollTop, 0);
});

test("reading an older row preserves its viewport offset, including with reduced motion", () => {
  for (const reduced of [true, false]) {
    const { update, motion, view } = timeline(85, reduced);
    update(["x", "a", "b", "c"]);
    assert.equal(view.scrollTop, 155);
    assert.equal(motion.length, 0);
  }
});

test("pagination, a reordered existing commit, scope switches and reduced motion do not animate", () => {
  for (const [hashes, scope, reduced] of [
    [["a", "b", "c", "older"], "repo", false], [["b", "a", "c"], "repo", false],
    [["x", "a", "b"], "other", false], [["x", "a", "b"], "repo", true],
  ]) {
    const { update, motion } = timeline(0, reduced);
    update(hashes, scope);
    assert.equal(motion.length, 0);
  }
});
