import test from 'node:test';
import assert from 'node:assert/strict';
import { sameMrRefs, reviewVersion, mrVersionChanged, mrCommitFiles, mrViewerActions } from '../src/mergeRequestHelpers.ts';

const refs = {baseSha:'base',startSha:'start',headSha:'source'};
const detail = {summary:{id:501,projectId:10,iid:1,sha:'source',targetBranch:'main'},diffRefs:refs,diffVersions:[{id:2,refs:{...refs,baseSha:'other'}},{id:1,refs}]};
test('review identity includes all refs and diff version, even when source SHA did not change', () => {
  assert.equal(reviewVersion(detail)?.id, 1);
  assert.equal(sameMrRefs(refs, {...refs,startSha:'changed'}), false);
  assert.equal(mrVersionChanged(detail, {...detail,diffVersions:[{id:3,refs}]}), true);
  assert.equal(mrVersionChanged(detail, {...detail,diffRefs:{...refs,baseSha:'changed'}}), true);
  assert.equal(mrVersionChanged(detail, {...detail,summary:{...detail.summary,targetBranch:'release'}}), true);
  assert.equal(mrVersionChanged(detail, structuredClone(detail)), false);
});

test('matching local MR numbers in different projects never share a review identity', () => {
  const otherProject = {...detail,summary:{...detail.summary,id:502,projectId:11}};
  assert.equal(otherProject.summary.iid, detail.summary.iid);
  assert.equal(mrVersionChanged(detail, otherProject), true);
  assert.equal(mrVersionChanged(detail, {...detail,summary:{...detail.summary,id:502}}), true);
  assert.equal(mrVersionChanged(detail, {...detail,summary:{...detail.summary,projectId:11}}), true);
});

test('MR actions require authenticated identity, latest reviewer role and server eligibility', () => {
  const viewer = {id:1,name:'Blake',username:'blake'};
  const request = {summary:{state:'opened',author:viewer,roles:['author','reviewer']},
    approvals:{approvedBy:[]},canClose:true,canApprove:true};
  assert.deepEqual(mrViewerActions(request, viewer), {showCancel:true,canCancel:true,showApprove:false,canApprove:false,approved:false});
  assert.deepEqual(mrViewerActions(request, null), {showCancel:false,canCancel:false,showApprove:false,canApprove:false,approved:false});
  const review = {...request,summary:{...request.summary,author:{...viewer,id:2},roles:['reviewer']}};
  assert.equal(mrViewerActions(review, viewer).canApprove, true);
  assert.equal(mrViewerActions({...review,canApprove:false}, viewer).showApprove, true);
  assert.equal(mrViewerActions({...review,canApprove:false}, viewer).canApprove, false);
  assert.equal(mrViewerActions({...review,summary:{...review.summary,roles:['assignee']}}, viewer).showApprove, false);
  assert.equal(mrViewerActions({...review,approvals:{approvedBy:[viewer]}}, viewer).canApprove, false);
  assert.equal(mrViewerActions({...review,approvals:{approvedBy:[viewer]}}, viewer).approved, true);
  assert.equal(mrViewerActions({...review,summary:{...review.summary,state:'closed'}}, viewer).showApprove, false);
  assert.equal(mrViewerActions({...request,summary:{...request.summary,state:'merged'}}, viewer).showCancel, false);
  assert.equal(mrViewerActions({...request,canClose:false}, viewer).canCancel, false);
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
