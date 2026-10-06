import test from 'node:test';
import assert from 'node:assert/strict';
import { gitlabRemote, sameMrRefs, reviewVersion, mrVersionChanged, mrCommitFiles } from '../src/mergeRequestHelpers.ts';

test('only matching GitLab instances are eligible, with origin preferred and SSH ports accepted', () => {
  const remotes = [{name:'other',url:'git@lab.example:team/other.git'}, {name:'origin',url:'ssh://git@lab.example:2222/team/app.git'}];
  assert.equal(gitlabRemote(remotes, 'https://lab.example', 'fixture-token'), remotes[1].url);
  assert.equal(gitlabRemote([{name:'origin',url:'https://other.example/team/app'}], 'https://lab.example', 'fixture-token'), null);
  assert.equal(gitlabRemote([{name:'origin',url:'https://lab.example:8443/team/app'}], 'https://lab.example', 'fixture-token'), null);
  assert.equal(gitlabRemote([{name:'origin',url:'https://lab.example/gitlab/team/app.git'}], 'https://lab.example/gitlab', 'fixture-token'), 'https://lab.example/gitlab/team/app.git');
  assert.equal(gitlabRemote(remotes, 'https://secret@lab.example', 'fixture-token'), null);
  assert.equal(gitlabRemote([{name:'origin',url:'git@github.com:team/app.git'}], '', 'fixture-token'), null);
});

test('merge request eligibility requires a saved nonempty GitLab credential', () => {
  const remotes = [{name:'origin',url:'git@lab.example:team/app.git'}];
  assert.equal(gitlabRemote(remotes, 'https://lab.example', ''), null);
  assert.equal(gitlabRemote(remotes, 'https://lab.example', ' \n\t '), null);
  assert.equal(gitlabRemote(remotes, 'https://lab.example', 'fixture-token'), remotes[0].url);
  assert.equal(gitlabRemote(remotes, 'https://lab.example', ''), null);
});

const refs = {baseSha:'base',startSha:'start',headSha:'source'};
const detail = {summary:{sha:'source',targetBranch:'main'},diffRefs:refs,diffVersions:[{id:2,refs:{...refs,baseSha:'other'}},{id:1,refs}]};
test('review identity includes all refs and diff version, even when source SHA did not change', () => {
  assert.equal(reviewVersion(detail)?.id, 1);
  assert.equal(sameMrRefs(refs, {...refs,startSha:'changed'}), false);
  assert.equal(mrVersionChanged(detail, {...detail,diffVersions:[{id:3,refs}]}), true);
  assert.equal(mrVersionChanged(detail, {...detail,diffRefs:{...refs,baseSha:'changed'}}), true);
  assert.equal(mrVersionChanged(detail, {...detail,summary:{...detail.summary,targetBranch:'release'}}), true);
  assert.equal(mrVersionChanged(detail, structuredClone(detail)), false);
});

test('remote diff adapter keeps rename/delete paths and flags unavailable files', () => {
  const file = {oldPath:'old.ts',newPath:'new.ts',oldMode:'100644',newMode:'100644',newFile:false,deletedFile:false,renamedFile:true,tooLarge:false,collapsed:false,diff:'@@ -1 +1 @@\n-old\n+new\n context'};
  const [renamed,deleted,large] = mrCommitFiles({files:[file,{...file,deletedFile:true,renamedFile:false},{...file,tooLarge:true,diff:''}]});
  assert.equal(renamed.path, 'new.ts'); assert.equal(renamed.status,'renamed');
  assert.equal(renamed.additions,1); assert.equal(renamed.deletions,1);
  assert.equal(deleted.path,'old.ts'); assert.equal(deleted.status,'deleted');
  assert.ok(large.diffNotice); assert.equal(large.diff,'');
  const [operators] = mrCommitFiles({files:[{...file,diff:'--- old.ts\n+++ new.ts\n@@ -1 +1 @@\n---counter;\n+++counter;'}]});
  assert.equal(operators.additions,1); assert.equal(operators.deletions,1);
});
