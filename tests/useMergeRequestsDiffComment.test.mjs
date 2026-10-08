import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as helpers from '../src/mergeRequestHelpers.ts';

const refs = {baseSha:'base',startSha:'start',headSha:'source'};
const position = {oldPath:'old.ts',newPath:'new.ts',oldLine:10,newLine:11};
const version = {id:4,refs,files:[{...position,diff:'@@ -10 +11 @@\n context',tooLarge:false,collapsed:false}]};
const detail = {summary:{id:501,projectId:10,iid:1,sha:'source',targetBranch:'main'},
  diffRefs:refs,diffVersions:[version],blockingDiscussionsResolved:true};
const created = {id:'discussion-1',individualNote:false,notes:[{id:1,body:'Review this line',
  position:{...position,...refs,positionType:'text'}}]};
const snapshot = {revision:1,epoch:1,total:2,selectedDetail:null};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
};
const source = ts.transpileModule(readFileSync(new URL('../src/useMergeRequests.ts', import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;

// Exercise the real hook's request generations with deterministic React state/effect scheduling.
function harness(handler = () => undefined) {
  const slots = [], effectDeps = [], cleanups = [], effects = [], calls = [];
  let cursor = 0, accountEpoch = 1, listener;
  let props = {url:'https://gitlab.example',token:'test-token',credentialRevision:1};
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index],value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= {current:initial};
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((value,i) => value !== slots[index].deps[i])) slots[index] = {callback,deps};
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!effectDeps[index] || deps.some((value,i) => value !== effectDeps[index][i])) {
        effectDeps[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = effect(); });
      }
    },
  };
  const invoke = async (command,args) => {
    calls.push({command,args});
    const handled = handler(command,args);
    if (handled !== undefined) return handled;
    if (command === 'mr_configure') return {...snapshot,epoch:accountEpoch};
    if (command === 'mr_snapshot' || command === 'mr_refresh') return {...snapshot,epoch:accountEpoch};
    if (command === 'mr_detail') return args.mrId === detail.summary.id ? detail
      : {...detail,summary:{...detail.summary,id:args.mrId,projectId:11}};
    if (command === 'mr_diffs') return version;
    if (command === 'mr_discussions') return [];
    if (command === 'mr_visibility') return;
    throw new Error(`Unexpected command: ${command}`);
  };
  const exports = {};
  runInNewContext(source, {exports,require(specifier) {
    if (specifier === 'react') return react;
    if (specifier === '@tauri-apps/api/core') return {isTauri:() => true};
    if (specifier === '@tauri-apps/api/event') return {listen:async (_,callback) => {listener=callback;return () => {};}};
    if (specifier === './git') return {invoke};
    if (specifier === './mergeRequestHelpers') return helpers;
    if (specifier === './i18n') return {tx:value => value};
    throw new Error(`Unexpected import: ${specifier}`);
  },navigator:{onLine:true},window:{addEventListener() {},removeEventListener() {}}});
  const render = () => {
    cursor = 0;
    const result = exports.useMergeRequests(props);
    while (effects.length) effects.shift()();
    return result;
  };
  const settle = async () => {
    for (let i=0;i<8;i++) await Promise.resolve();
    return render();
  };
  return {
    calls,render,settle,
    async ready() {
      render();
      let hook = await settle();
      await hook.select(detail.summary.id);
      hook = render();
      hook.onTabChange('changes');
      return settle();
    },
    emit(latest) { listener({payload:{...snapshot,revision:2,selectedDetail:latest}}); return render(); },
    async switchAccount() { accountEpoch++; props={...props,credentialRevision:props.credentialRevision+1};render();return settle(); },
  };
}

test('line comment uses the displayed diff version and refreshes authoritative merge state', async () => {
  const testHook = harness((command,args) => {
    if (command === 'mr_create_diff_comment') return {state:'created',message:'Created',discussion:created};
    if (command === 'mr_detail' && args.force) return {...detail,blockingDiscussionsResolved:false};
    if (command === 'mr_discussions') return [created];
  });
  const hook = await testHook.ready();
  const result = await hook.createDiffComment(position,'Review this line');
  assert.equal(result.state,'created');
  const write = testHook.calls.find(call => call.command === 'mr_create_diff_comment');
  assert.deepEqual(JSON.parse(JSON.stringify(write.args)), {mrId:501,epoch:1,reviewedVersionId:4,reviewedRefs:refs,
    expectedTargetBranch:'main',body:'Review this line',position});
  const refreshed = await testHook.settle();
  assert.equal(refreshed.latest.blockingDiscussionsResolved,false);
  assert.equal(refreshed.detail.blockingDiscussionsResolved,true,'the reviewed source remains pinned');
  assert.deepEqual(refreshed.discussions,[created]);
});

test('an older discussion read cannot erase a confirmed line comment', async () => {
  const oldRead = deferred(), newRead = deferred();
  let reads = 0;
  const testHook = harness(command => {
    if (command === 'mr_discussions') return ++reads === 1 ? oldRead.promise : newRead.promise;
    if (command === 'mr_create_diff_comment') return {state:'created',message:'Created',discussion:created};
  });
  const hook = await testHook.ready();
  await hook.createDiffComment(position,'Review this line');
  assert.equal(testHook.render().discussions[0].id,created.id);
  oldRead.resolve([]);
  assert.equal((await testHook.settle()).discussions[0].id,created.id);
  newRead.resolve([created]);
  assert.equal((await testHook.settle()).discussionsLoaded,true);
});

test('failed refreshes preserve the successful comment and permit a later discussion reload', async () => {
  const testHook = harness((command,args) => {
    if (command === 'mr_create_diff_comment') return {state:'created',message:'Created',discussion:created};
    if (command === 'mr_detail' && args.force) return Promise.reject(new Error('Refresh unavailable'));
    if (command === 'mr_discussions') return Promise.reject(new Error('Discussions unavailable'));
  });
  const hook = await testHook.ready();
  assert.equal((await hook.createDiffComment(position,'Review this line')).state,'created');
  const refreshed = await testHook.settle();
  assert.equal(refreshed.discussions[0].id,created.id);
  assert.equal(refreshed.discussionsLoaded,false);
  assert.equal(refreshed.discussionsLoading,false);
  assert.equal(testHook.calls.filter(call => call.command === 'mr_create_diff_comment').length,1);
  const readsBefore = testHook.calls.filter(call => call.command === 'mr_discussions').length;
  refreshed.onTabChange('discussion');
  await testHook.settle();
  assert.equal(testHook.calls.filter(call => call.command === 'mr_discussions').length,readsBefore+1);
});

test('stale review targets and unsupported anchors never send a line comment', async () => {
  const testHook = harness();
  const hook = await testHook.ready();
  for (const anchor of [{...position,oldLine:null,newLine:null},{...position,newLine:0},{...position,newPath:'another.ts'}])
    await assert.rejects(hook.createDiffComment(anchor,'Review this line'));
  const stale = testHook.emit({...detail,summary:{...detail.summary,targetBranch:'release'}});
  await assert.rejects(stale.createDiffComment(position,'Review this line'));
  assert.equal(testHook.calls.filter(call => call.command === 'mr_create_diff_comment').length,0);
});

test('account or MR switches during a comment return uncertainty without applying the old discussion', async () => {
  for (const switchAccount of [true,false]) {
    const write = deferred();
    const testHook = harness(command => command === 'mr_create_diff_comment' ? write.promise : undefined);
    const hook = await testHook.ready();
    const pending = hook.createDiffComment(position,'Review this line');
    if (switchAccount) await testHook.switchAccount();
    else await hook.select(502); // Resolve before the next render to cover React batching.
    write.resolve({state:'created',message:'Created',discussion:created});
    assert.equal((await pending).state,'uncertain');
    assert.equal((await testHook.settle()).discussions.length,0);
    assert.equal(testHook.calls.filter(call => call.command === 'mr_detail' && call.args.force).length,0);
  }
});

test('one in-flight write blocks duplicate sends and uncertain results are returned without replay', async () => {
  const write = deferred();
  const testHook = harness(command => command === 'mr_create_diff_comment' ? write.promise : undefined);
  const hook = await testHook.ready();
  const pending = hook.createDiffComment(position,'Review this line');
  await assert.rejects(hook.createDiffComment(position,'Review this line'));
  write.resolve({state:'uncertain',message:'Check in GitLab',discussion:null});
  assert.equal((await pending).state,'uncertain');
  await testHook.settle();
  assert.equal(testHook.calls.filter(call => call.command === 'mr_create_diff_comment').length,1);
});

test('a rereview started during a comment finishes loading and reloads line discussions', async () => {
  const write = deferred(), review = deferred();
  const nextRefs = {...refs,headSha:'next-source'};
  const nextVersion = {...version,id:5,refs:nextRefs};
  const nextDetail = {...detail,summary:{...detail.summary,sha:'next-source'},diffRefs:nextRefs,
    diffVersions:[nextVersion],blockingDiscussionsResolved:false};
  let detailReads = 0;
  const testHook = harness((command,args) => {
    if (command === 'mr_create_diff_comment') return write.promise;
    if (command === 'mr_detail' && args.force) return ++detailReads === 1 ? review.promise : nextDetail;
    if (command === 'mr_diffs' && args.versionId === 5) return nextVersion;
    if (command === 'mr_discussions') return [created];
  });
  const hook = await testHook.ready();
  const pending = hook.createDiffComment(position,'Review this line');
  const rereview = hook.reviewLatest();
  assert.equal(testHook.render().loading,true);
  write.resolve({state:'created',message:'Created',discussion:created});
  assert.equal((await pending).state,'created');
  review.resolve(nextDetail);
  await rereview;
  const refreshed = await testHook.settle();
  assert.equal(refreshed.loading,false);
  assert.equal(refreshed.diffVersion.id,5);
  assert.equal(refreshed.discussionsLoaded,true);
  assert.equal(refreshed.discussions[0].id,created.id);
});

test('detail refresh reloads remote line discussions while preserving the displayed diff', async () => {
  let reads = 0;
  const testHook = harness((command,args) => {
    if (command === 'mr_discussions') return ++reads === 1 ? [] : [created];
    if (command === 'mr_detail' && args.force) return {...detail,blockingDiscussionsResolved:false};
  });
  const hook = await testHook.ready();
  const reviewedDetail = hook.detail, displayedDiff = hook.diffVersion;
  assert.equal(hook.discussionsLoaded,true);
  assert.equal(hook.discussions.length,0);
  await hook.refresh();
  const refreshed = await testHook.settle();
  assert.deepEqual(refreshed.discussions,[created]);
  assert.equal(refreshed.discussionsLoaded,true);
  assert.equal(refreshed.latest.blockingDiscussionsResolved,false);
  assert.equal(refreshed.detail,reviewedDetail,'refresh does not adopt a new reviewed source');
  assert.equal(refreshed.diffVersion,displayedDiff,'the inline editor retains its displayed version');
  assert.equal(testHook.calls.filter(call => call.command === 'mr_diffs').length,1);
  const discussionReads = testHook.calls.filter(call => call.command === 'mr_discussions');
  assert.deepEqual(discussionReads.map(call => call.args.force),[false,true]);
  assert.deepEqual(JSON.parse(JSON.stringify(discussionReads[1].args)),{mrId:501,epoch:1,force:true});
});
