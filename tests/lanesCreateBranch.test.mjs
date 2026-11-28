import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const workspace = ts.createSourceFile("LanesWorkspace.tsx",
  readFileSync(new URL("../src/lanes/LanesWorkspace.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submit;
function findSubmit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(workspace) === "submitCreate") submit = node.initializer;
  ts.forEachChild(node, findSubmit);
}
findSubmit(workspace);
const source = ts.transpileModule(`globalThis.submit = ${submit.getText(workspace)}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;

function harness() {
  const writes = [], updates = [];
  const pending = Promise.withResolvers();
  const create = { base: "topic" };
  const context = {
    path: "/repo-a", create, openForm: create, model: { trunk: "main" }, createRequest: { current: null },
    props: { onCreateBranch: () => pending.promise },
    saveBase: (...args) => { writes.push(args); return {}; },
    setBases: () => updates.push("bases"), setTouched: () => updates.push("recent"),
    setCreate: update => { context.openForm = update(context.openForm); },
    setBusy: busy => updates.push(busy), tf: x => x,
    toast: { success: () => updates.push("success"), error: () => updates.push("error") },
  };
  runInNewContext(source, context);
  return { context, writes, updates, pending };
}

test("a late creation persists the original repository base without touching a newer request", async () => {
  const { context, writes, updates, pending } = harness();
  const finish = context.submit("new", "topic");
  const next = Symbol();
  context.createRequest.current = next;
  context.openForm = { base: "other" };
  pending.resolve();
  await finish;
  assert.deepEqual(writes, [["/repo-a", "new", "topic"]]);
  assert.deepEqual(updates, [true]);
  assert.equal(context.createRequest.current, next);
  assert.equal(context.openForm.base, "other");
});

test("finishing a creation leaves a form reopened in the same repository intact", async () => {
  const { context, updates, pending } = harness();
  const finish = context.submit("new", "topic");
  context.openForm = { base: "reopened" };
  pending.resolve();
  await finish;
  assert.deepEqual(updates, [true, "bases", "recent", "success", false]);
  assert.equal(context.openForm.base, "reopened");
});
