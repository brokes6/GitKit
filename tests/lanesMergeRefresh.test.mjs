import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { requestRepository } from "../src/branchRequest.ts";

const app = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ["syncReviewedMerge", "mergeReviewedRequest"].includes(node.name.getText(app))) {
    declarations.push("const " + node.getText(app) + ";");
  }
  ts.forEachChild(node, visit);
}
visit(app);
const code = ts.transpileModule(declarations.join("\n") + "\nglobalThis.merge = mergeReviewedRequest;",
  {compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;

function harness(state, project = "team/repo") {
  const remote = {name:"origin", url:"git@gitlab.test:team/repo.git"};
  const summary = {id:7, state, projectPathWithNamespace:project, sourceBranch:"topic"};
  const fetched = [], invalidated = [], cleared = [];
  let reloads = 0;
  const context = {
    mr:{merge:async () => ({state, summary})}, mrConnection:{url:"https://gitlab.test", token:""},
    useCallback:fn => fn, path:"/repo", remotes:[remote], prUrl:remote.url, requestRepository,
    refreshedMerges:new Set(), currentRequest:{refresh() {}},
    invoke:async (command, args) => fetched.push([command, args.path, args.remote]),
    refreshLaneRequest:(...args) => cleared.push(args),
    realCache:{current:{delete:p => invalidated.push(p)}}, activePathRef:{current:"/repo"}, setReloadTick:() => reloads++,
  };
  runInNewContext(code, context);
  return {context, fetched, cleared, invalidated, reloads:() => reloads};
}

test("detail merge updates the source badge, then reloads refs once for the reviewed repository", async () => {
  const h = harness("merged");
  await h.context.merge({});
  await h.context.merge({});
  assert.deepEqual(h.fetched, [["git_refresh_remote_branches","/repo","origin"]]);
  assert.deepEqual(h.cleared, [["topic",7]]);
  assert.deepEqual(h.invalidated, ["/repo"]);
  assert.equal(h.reloads(), 1);
});

test("unconfirmed and unrelated merges never apply a repository refresh", async () => {
  for (const h of [harness("pending"), harness("uncertain"), harness("merged", "other/repo")]) {
    await h.context.merge({});
    assert.deepEqual(h.fetched, []);
    assert.deepEqual(h.cleared, []);
  }
  const h = harness("merged");
  h.context.activePathRef.current = "/other";
  await h.context.merge({});
  assert.deepEqual(h.invalidated, ["/repo"]);
  assert.equal(h.reloads(), 0);
});
