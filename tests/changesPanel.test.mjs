import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && ['ChangesSectionHeader', 'ChangesPanel'].includes(node.name?.text));
assert.ok(functions.some(node => node.name.text === 'ChangesPanel'));
const source = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React },
}).outputText;
const files = [
  { path: 'modified.ts', staged: false, status: 'modified' },
  { path: 'partial.ts', staged: true, status: 'modified', hasStaged: true },
  { path: 'partial.ts', staged: false, status: 'modified', hasStaged: true },
  { path: 'new.ts', staged: false, status: 'untracked' },
];
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
}
const header = (tree, action) => descendants(tree).find(node => node.props.action === action);
const buttons = element => descendants(element.type(element.props)).filter(node => node.type === 'button');
const actionButton = element => buttons(element).find(node => node.props.children === element.props.action);

// Evaluate the real components with deterministic hook slots, without importing App's native startup.
function harness(extra = {}) {
  const slots = [], stageCalls = [], unstageCalls = [];
  let cursor = 0, draft = '';
  let props = { files, selectedFile: null, currentBranch: 'main', busy: false, operationActive: false,
    identities: [{ id: 'author', name: 'Author', email: 'author@example.invalid' }],
    defaultIdentityId: 'author', projectKey: '/repo', onFileSelect() {}, onConfigureIdentity() {},
    onDiscard() {}, onDiscardAll() {}, onCommit: async () => {},
    onStage: async paths => { stageCalls.push(Array.from(paths)); },
    onUnstage: async paths => { unstageCalls.push(Array.from(paths)); }, ...extra };
  const context = { React, R: 8, tx: value => value, tf: value => value,
    useTheme: () => ({}), useEffect() {}, loadCommitDraft: () => draft,
    saveCommitDraft: (_, value) => { draft = value; }, resolveIdentityId: () => 'author',
    saveProjectIdentity() {}, workingFileKey: file => `${file.path}:${file.staged}`,
    WorkingFileRow: () => null, Users: () => null, GitCommit: () => null,
    press: callback => ({ onClick: callback }), toast: { error() {} },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
  };
  runInNewContext(source, context);
  return { stageCalls, unstageCalls, render(next = {}) {
    props = { ...props, ...next }; cursor = 0; return context.ChangesPanel(props);
  } };
}

test('bulk action headers retain their React type across selection, status refresh and draft edits', () => {
  const panel = harness(), first = panel.render();
  const firstHeaders = ['全部暂存', '全部取消'].map(action => header(first, action));
  const selected = panel.render({ selectedFile: files[0] });
  const refreshed = panel.render({ files: files.map(file => ({ ...file })) });
  descendants(refreshed).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Draft' } });
  const edited = panel.render();
  for (const tree of [selected, refreshed, edited]) {
    firstHeaders.forEach(previous => assert.equal(header(tree, previous.props.action).type, previous.type,
      `${previous.props.action} must update its existing DOM rather than remount between pointer events`));
  }
});

test('one bulk stage click submits every unstaged side, including partial and untracked files', () => {
  const panel = harness(), tree = panel.render();
  actionButton(header(tree, '全部暂存')).props.onClick();
  assert.deepEqual(panel.stageCalls, [['modified.ts', 'partial.ts', 'new.ts']]);
  actionButton(header(tree, '全部取消')).props.onClick();
  assert.deepEqual(panel.unstageCalls, [['partial.ts']]);
});

test('busy and in-flight commit states disable both bulk actions and reset without changing header types', async () => {
  let finish;
  const panel = harness({ onCommit: () => new Promise(resolve => { finish = resolve; }) });
  const tree = panel.render(), stageType = header(tree, '全部暂存').type;
  const busy = panel.render({ busy: true });
  for (const action of ['全部暂存', '全部取消'])
    assert.ok(buttons(header(busy, action)).every(button => button.props.disabled));
  const ready = panel.render({ busy: false });
  descendants(ready).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Commit' } });
  const pending = descendants(panel.render()).find(node => node.type === 'button'
    && node.props.className.includes('gk-primary-sweep')).props.onClick();
  const committing = panel.render();
  for (const action of ['全部暂存', '全部取消'])
    assert.ok(buttons(header(committing, action)).every(button => button.props.disabled));
  assert.equal(header(committing, '全部暂存').type, stageType);
  finish(); await pending;
  assert.equal(actionButton(header(panel.render(), '全部暂存')).props.disabled, false);
});
