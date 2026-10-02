import test from "node:test";
import assert from "node:assert/strict";
import { loadFileHistory, loadFileTraceDiff, loadFileBlame } from "../src/git.ts";

const hash = "a".repeat(40);
const entry = {
  hash, parents: ["b".repeat(40)], author_name: "Author", author_email: "author@example.invalid",
  author_date: "2020-01-02T03:04:05+08:00", committer_name: "Committer", committer_email: "committer@example.invalid",
  committer_date: "2020-02-03T04:05:06+08:00", subject: "rename", body: "details",
  file: "城市 [1].txt", old_file: "old [1].txt", status: "R", additions: 0, deletions: 0, binary: false,
};
const previousWindow = globalThis.window;
test.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });

test("file history preserves native identities, literal paths and pinned pagination", async () => {
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command,args) => {
    assert.equal(command,"file_history");
    assert.deepEqual(args,{path:"/repo",anchor:hash,file:"城市 [1].txt",branch:null,offset:60});
    return {revision:hash,file:entry.file,entries:[entry],next_offset:120};
  } } };
  const page = await loadFileHistory("/repo",hash,entry.file,null,60);
  assert.equal(page.revision,hash); assert.equal(page.nextOffset,120);
  assert.equal(page.entries[0].author.name,"Author"); assert.equal(page.entries[0].committer.name,"Committer");
  assert.notEqual(page.entries[0].date,page.entries[0].committerDate);
  assert.equal(page.entries[0].oldPath,entry.old_file); assert.equal(page.entries[0].file.status,"renamed");
});

test("trace comparison sends an explicit parent and retains a pure rename diff", async () => {
  const patch = "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n";
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command,args) => {
    assert.equal(command,"file_trace_diff"); assert.equal(args.parentIndex,1);
    return {commit:entry,diff:patch,parent:entry.parents[0]};
  } } };
  const detail = await loadFileTraceDiff("/repo",hash,entry.file,1);
  assert.equal(detail.diff,patch); assert.equal(detail.parent,entry.parents[0]);
});

test("blame keeps the source revision and source path for navigating old filenames", async () => {
  const line = {hash:"b".repeat(40),file:entry.old_file,line:1,original_line:3,author_name:"Author",
    author_email:entry.author_email,author_date:entry.author_date,summary:"source",content:"original"};
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command,args) => {
    assert.equal(command,"file_blame"); assert.deepEqual(args,{path:"/repo",hash,file:entry.file});
    return {kind:"text",lines:[line],truncated:true};
  } } };
  const blame = await loadFileBlame("/repo",hash,entry.file);
  assert.equal(blame.lines[0].file,entry.old_file); assert.equal(blame.lines[0].hash,line.hash);
  assert.equal(blame.truncated,true);
});
