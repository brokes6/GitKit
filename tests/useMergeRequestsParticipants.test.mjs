import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as helpers from '../src/mergeRequestHelpers.ts';

const author = {id:3,name:'Author',username:'author'};
const assignee = {id:8,name:'Assignee',username:'assignee'};
const reviewer = {id:9,name:'Reviewer',username:'reviewer'};
const nextUser = {id:11,name:'New Member',username:'member'};
const refs = {baseSha:'base',startSha:'start',headSha:'source'};
const version = {id:4,refs,files:[]};
const detail = {summary:{id:501,projectId:10,iid:1,sha:'source',targetBranch:'main',state:'opened',author,
  updatedAt:'2026-10-09T00:00:00Z'},assignees:[assignee],reviewers:[reviewer],canManageParticipants:true,
  diffRefs:refs,diffVersions:[version],blockingDiscussionsResolved:true};
const updated = {...detail,summary:{...detail.summary,updatedAt:'2026-10-09T00:00:01Z'},assignees:[nextUser]};
const candidates = {users:[nextUser],nextPage:2};
const snapshot = {revision:1,epoch:1,total:2,user:author,selectedDetail:null};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise,resolve,reject};
};
const source = ts.transpileModule(readFileSync(new URL('../src/useMergeRequests.ts', import.meta.url),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));

// Run the real hook with deterministic state/effect scheduling and deferred native responses.
function harness(handler = () => undefined) {
  const slots = [], effectDeps = [], cleanups = [], effects = [], calls = [];
  let cursor = 0, accountEpoch = 1, eventRevision = 1, listener;
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
    if (command === 'mr_configure' || command === 'mr_snapshot' || command === 'mr_refresh')
      return {...snapshot,epoch:accountEpoch};
    if (command === 'mr_detail') return args.mrId === detail.summary.id ? detail
      : {...detail,summary:{...detail.summary,id:args.mrId,projectId:11}};
    if (command === 'mr_diffs') return version;
    if (command === 'mr_discussions') return [];
    if (command === 'mr_visibility') return;
    if (command === 'mr_participant_candidates') return candidates;
    if (command === 'mr_update_participants') return {state:'updated',message:'Updated',detail:updated};
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
    emit(latest, extra = {}) {
      listener({payload:{...snapshot,epoch:accountEpoch,revision:++eventRevision,selectedDetail:latest,...extra}});
      return render();
    },
    async switchAccount() {
      accountEpoch++;props={...props,credentialRevision:props.credentialRevision+1};render();return settle();
    },
  };
}

test('candidates use global MR id and native search paging; mutation keeps the displayed review pinned', async () => {
  const testHook = harness();
  const hook = await testHook.ready();
  assert.deepEqual(await hook.participantCandidates('New Member',2),candidates);
  assert.deepEqual(plain(testHook.calls.find(call => call.command === 'mr_participant_candidates').args),
    {mrId:501,epoch:1,query:'New Member',page:2});
  const result = await hook.updateParticipants('assignee',[11],[8]);
  assert.equal(result.state,'updated');
  assert.deepEqual(plain(testHook.calls.find(call => call.command === 'mr_update_participants').args),
    {mrId:501,epoch:1,kind:'assignee',userIds:[11],expectedUserIds:[8]});
  const refreshed = await testHook.settle();
  assert.equal(refreshed.latest,updated);
  assert.equal(refreshed.detail,hook.detail);
  assert.equal(refreshed.diffVersion,hook.diffVersion);
  assert.equal(testHook.calls.filter(call => call.command === 'mr_diffs').length,1);
});

test('reviewer clearing preserves an empty ID array and checks reviewer state independently', async () => {
  const cleared = {...updated,reviewers:[]};
  const testHook = harness(command => command === 'mr_update_participants'
    ? {state:'updated',message:'Updated',detail:cleared} : undefined);
  const hook = await testHook.ready();
  await hook.updateParticipants('reviewer',[],[9]);
  assert.deepEqual(plain(testHook.calls.find(call => call.command === 'mr_update_participants').args),
    {mrId:501,epoch:1,kind:'reviewer',userIds:[],expectedUserIds:[9]});
  assert.equal((await testHook.settle()).latest.reviewers.length,0);
});

test('only the current authoritative author and opened writable detail allow participant operations', async () => {
  for (const latest of [
    {...detail,summary:{...detail.summary,author:reviewer}},
    {...detail,summary:{...detail.summary,state:'closed'}},
    {...detail,canManageParticipants:false},
  ]) {
    const testHook = harness();
    await testHook.ready();
    const hook = testHook.emit(latest);
    await assert.rejects(hook.participantCandidates('',1));
    await assert.rejects(hook.updateParticipants('assignee',[11],[8]));
    assert.equal(testHook.calls.filter(call => call.command.startsWith('mr_participant') || call.command === 'mr_update_participants').length,0);
  }
  const testHook = harness();
  await testHook.ready();
  const hook = testHook.emit(detail,{user:reviewer});
  await assert.rejects(hook.updateParticipants('assignee',[11],[8]));
  assert.equal(testHook.calls.filter(call => call.command === 'mr_update_participants').length,0);
});

test('malformed IDs, wrong fields and changed assignments never send a write', async () => {
  const testHook = harness();
  const hook = await testHook.ready();
  for (const args of [
    ['assignee',[0],[8]],['assignee',[1.5],[8]],['assignee',[11,11],[8]],
    ['assignee',[11],[8,8]],['assignee',[11],[9]],['reviewer',[11],[8]],['unknown',[11],[8]],
  ]) await assert.rejects(hook.updateParticipants(...args));
  await assert.rejects(hook.participantCandidates('',0));
  await assert.rejects(hook.participantCandidates('',1.5));
  const changed = testHook.emit(updated);
  await assert.rejects(changed.updateParticipants('assignee',[8],[8]));
  assert.equal(testHook.calls.filter(call => call.command === 'mr_update_participants').length,0);
});

test('newer search responses win and candidate reads are invalidated by a participant write', async () => {
  const oldRead = deferred(), nextRead = deferred(), writeRead = deferred();
  const testHook = harness((command,args) => command === 'mr_participant_candidates'
    ? (args.page === 2 ? writeRead.promise : args.query === 'old' ? oldRead.promise : nextRead.promise) : undefined);
  const hook = await testHook.ready();
  const old = hook.participantCandidates('old',1);
  const oldRejected = assert.rejects(old,/成员搜索已变化/);
  const next = hook.participantCandidates('next',1);
  nextRead.resolve(candidates);
  assert.deepEqual(await next,candidates);
  oldRead.resolve({users:[reviewer],nextPage:null});
  await oldRejected;
  const pending = hook.participantCandidates('old',2);
  const rejected = assert.rejects(pending,/成员搜索已变化/);
  await hook.updateParticipants('assignee',[11],[8]);
  writeRead.resolve(candidates);
  await rejected;
});

test('a permission change while candidates load prevents returning an editable member list', async () => {
  const read = deferred();
  const testHook = harness(command => command === 'mr_participant_candidates' ? read.promise : undefined);
  const hook = await testHook.ready();
  const pending = hook.participantCandidates('',1);
  const rejected = assert.rejects(pending,/只有创建者/);
  testHook.emit({...detail,canManageParticipants:false});
  read.resolve(candidates);
  await rejected;
});

test('account and MR changes discard candidate reads, including leaving and reopening the same MR', async () => {
  for (const change of ['account','mr','reopen']) {
    const read = deferred();
    const testHook = harness(command => command === 'mr_participant_candidates' ? read.promise : undefined);
    const hook = await testHook.ready();
    const pending = hook.participantCandidates('',1);
    const rejected = assert.rejects(pending,/账号、合并请求/);
    if (change === 'account') await testHook.switchAccount();
    else if (change === 'mr') await hook.select(502);
    else {hook.backWorkspace();await testHook.render().select(501);}
    read.resolve(candidates);
    await rejected;
  }
});

test('one pending mutation blocks both participant kinds and returns uncertainty without automatic replay', async () => {
  const write = deferred();
  const testHook = harness(command => command === 'mr_update_participants' ? write.promise : undefined);
  const hook = await testHook.ready();
  const pending = hook.updateParticipants('assignee',[11],[8]);
  await assert.rejects(hook.updateParticipants('reviewer',[11],[9]),/正在保存/);
  write.resolve({state:'uncertain',message:'Verify the saved members',detail:null});
  assert.equal((await pending).state,'uncertain');
  await testHook.settle();
  assert.equal(testHook.calls.filter(call => call.command === 'mr_update_participants').length,1);
  assert.equal(testHook.calls.filter(call => call.command === 'mr_detail' && call.args.force).length,0);
});

test('uncertain native failures do not replay and definite permission failures stay errors', async () => {
  for (const kind of ['uncertain','forbidden']) {
    const testHook = harness(command => command === 'mr_update_participants'
      ? Promise.reject({kind,message:'Native failure'}) : undefined);
    const hook = await testHook.ready();
    if (kind === 'uncertain') assert.equal((await hook.updateParticipants('assignee',[11],[8])).state,'uncertain');
    else await assert.rejects(hook.updateParticipants('assignee',[11],[8]),error => error.kind === 'forbidden');
    await testHook.settle();
    assert.equal(testHook.calls.filter(call => call.command === 'mr_update_participants').length,1);
  }
});

test('account and MR switches during a write report uncertainty and never apply its detail to the new selection', async () => {
  for (const change of ['account','mr','reopen']) {
    const write = deferred();
    const testHook = harness(command => command === 'mr_update_participants' ? write.promise : undefined);
    const hook = await testHook.ready();
    const pending = hook.updateParticipants('assignee',[11],[8]);
    if (change === 'account') await testHook.switchAccount();
    else if (change === 'mr') await hook.select(502);
    else {hook.backWorkspace();await testHook.render().select(501);}
    write.resolve({state:'updated',message:'Updated',detail:updated});
    assert.equal((await pending).state,'uncertain');
    const selected = await testHook.settle();
    assert.notEqual(selected.latest,updated);
    assert.equal(testHook.calls.filter(call => call.command === 'mr_update_participants').length,1);
  }
});

test('stale handlers cannot start reads or writes for a selection changed before React renders', async () => {
  const testHook = harness();
  const hook = await testHook.ready();
  await hook.select(502);
  await assert.rejects(hook.updateParticipants('assignee',[11],[8]),/合并请求/);
  await assert.rejects(hook.participantCandidates('',1),/合并请求/);
  testHook.render();
  await hook.select(501);
  const reopened = testHook.render();
  await assert.rejects(hook.updateParticipants('assignee',[11],[8]),/合并请求/);
  await reopened.updateParticipants('assignee',[11],[8]);
  assert.equal(testHook.calls.filter(call => call.command === 'mr_update_participants').length,1);
});

test('detail reads started before or during a mutation cannot restore old participant state', async () => {
  for (const startedDuring of [false,true]) {
    const write = deferred(), read = deferred();
    const testHook = harness((command,args) => {
      if (command === 'mr_update_participants') return write.promise;
      if (command === 'mr_detail' && args.force) return read.promise;
    });
    const hook = await testHook.ready();
    let refresh;
    if (!startedDuring) {refresh=hook.refresh();await testHook.settle();}
    const pending = hook.updateParticipants('assignee',[11],[8]);
    if (startedDuring) {refresh=hook.refresh();await testHook.settle();}
    write.resolve({state:'updated',message:'Updated',detail:updated});
    assert.equal((await pending).state,'updated');
    assert.equal(testHook.render().latest,updated);
    read.resolve(detail);
    await refresh;
    const refreshed = await testHook.settle();
    assert.equal(refreshed.latest,updated);
    assert.equal(refreshed.detail,hook.detail);
    assert.equal(refreshed.diffVersion,hook.diffVersion);
  }
});

test('a newer authoritative poll survives a delayed successful mutation response', async () => {
  const write = deferred();
  const newer = {...updated,summary:{...updated.summary,updatedAt:'2026-10-09T00:00:02Z'},assignees:[reviewer]};
  const testHook = harness(command => command === 'mr_update_participants' ? write.promise : undefined);
  const hook = await testHook.ready();
  const pending = hook.updateParticipants('assignee',[11],[8]);
  testHook.emit(newer);
  write.resolve({state:'updated',message:'Updated',detail:updated});
  assert.equal((await pending).state,'updated');
  const refreshed = await testHook.settle();
  assert.equal(refreshed.latest,newer);
  assert.equal(refreshed.detail,hook.detail);
  assert.equal(refreshed.diffVersion,hook.diffVersion);
});

test('a response for a different global MR or project-local identity cannot replace selected detail', async () => {
  for (const summary of [{...updated.summary,id:502},{...updated.summary,projectId:11},{...updated.summary,iid:2}]) {
    const testHook = harness(command => command === 'mr_update_participants'
      ? {state:'updated',message:'Updated',detail:{...updated,summary}} : undefined);
    const hook = await testHook.ready();
    assert.equal((await hook.updateParticipants('assignee',[11],[8])).state,'uncertain');
    assert.equal((await testHook.settle()).latest,detail);
  }
});
