import test from 'node:test';
import assert from 'node:assert/strict';
import { isMrCommentableLine, mrCommentLineKey, mrLineDiscussionIndex, mrLineDiscussions } from '../src/mrDiffCommentHelpers.ts';

const refs = { baseSha: 'base', startSha: 'start', headSha: 'head' };
const file = { oldPath: 'src/before.ts', newPath: 'src/after.ts' };
const line = (oldLine, newLine) => ({ ...file, oldLine, newLine });
const thread = (id, position, extraNotes = []) => ({ id, individualNote: false,
  notes: [{ id: 1, body: 'review', position: position && { ...refs, positionType: 'text', ...position } }, ...extraNotes] });

test('only numbered additions, deletions and context rows can start line comments', () => {
  assert.equal(isMrCommentableLine({ kind: 'add', oldNo: null, newNo: 1 }), true);
  assert.equal(isMrCommentableLine({ kind: 'del', oldNo: 12, newNo: null }), true);
  assert.equal(isMrCommentableLine({ kind: 'ctx', oldNo: 14, newNo: 15 }), true);
  for (const row of [
    { kind: 'hunk', oldNo: null, newNo: null },
    { kind: 'meta', oldNo: null, newNo: null },
    { kind: 'hunk', oldNo: 14, newNo: 15 },
    { kind: 'meta', oldNo: 14, newNo: 15 },
    { kind: 'ctx', oldNo: 14, newNo: null },
    { kind: 'add', oldNo: 1, newNo: 1 },
    { kind: 'del', oldNo: 1, newNo: 1 },
    { kind: 'add', oldNo: null, newNo: 0 },
    { kind: 'del', oldNo: -1, newNo: null },
    { kind: 'ctx', oldNo: 1.5, newNo: 2 },
    { kind: 'add', oldNo: null, newNo: Number.NaN },
    { kind: 'add', oldNo: null, newNo: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(isMrCommentableLine(row), false, JSON.stringify(row));
});

test('added and deleted lines remain on their own diff side', () => {
  const added = thread('added', line(null, 7));
  const deleted = thread('deleted', line(7, null));
  const context = thread('context', line(7, 7));
  const discussions = [added, deleted, context];
  assert.deepEqual(mrLineDiscussions(discussions, refs, line(null, 7)), [added]);
  assert.deepEqual(mrLineDiscussions(discussions, refs, line(7, null)), [deleted]);
});

test('context comments use both old and new line numbers after an offset', () => {
  const context = thread('context', line(14, 15));
  const oldOffset = thread('old-offset', line(15, 15));
  const newOffset = thread('new-offset', line(14, 14));
  const newSideOnly = thread('new-side-only', line(null, 15));
  assert.deepEqual(mrLineDiscussions([context, oldOffset, newOffset, newSideOnly], refs, line(14, 15)), [context]);
});

test('renamed files match both paths without confusing another source file', () => {
  const renamed = thread('renamed', line(14, 15));
  const oldPathMismatch = thread('wrong-old-path', { ...line(14, 15), oldPath: 'src/other.ts' });
  const newPathMismatch = thread('wrong-new-path', { ...line(14, 15), newPath: 'src/other.ts' });
  assert.deepEqual(mrLineDiscussions([renamed, oldPathMismatch, newPathMismatch], refs, line(14, 15)), [renamed]);
});

test('all three diff refs must match even if source head and line numbers still match', () => {
  const current = thread('current', line(14, 15));
  const stale = ['baseSha', 'startSha', 'headSha'].map(key => thread(key, { ...line(14, 15), [key]: 'old' }));
  assert.deepEqual(mrLineDiscussions([...stale, current], refs, line(14, 15)), [current]);
  assert.deepEqual(mrLineDiscussions([current], null, line(14, 15)), []);
  assert.deepEqual(mrLineDiscussions([current], { ...refs, headSha: '' }, line(14, 15)), []);
});

test('ordinary notes, file comments and image positions never become code-row comments', () => {
  const regular = thread('regular', null);
  const unpositioned = { id: 'unpositioned', individualNote: true, notes: [{ id: 2, body: 'general comment' }] };
  const fileComment = thread('file', line(null, null));
  const image = thread('image', { ...line(14, 15), positionType: 'image' });
  assert.deepEqual(mrLineDiscussions([regular, unpositioned, fileComment, image], refs, line(14, 15)), []);
});

test('matching a thread keeps its replies and does not duplicate it', () => {
  const reply = { id: 2, body: 'reply', position: null };
  const secondAnchor = { id: 3, body: 'another note', position: { ...refs, positionType: 'text', ...line(14, 15) } };
  const discussion = thread('thread', line(14, 15), [reply, secondAnchor]);
  const result = mrLineDiscussions([discussion], refs, line(14, 15));
  assert.deepEqual(result, [discussion]);
  assert.equal(result[0], discussion);
  assert.equal(result[0].notes.length, 3);
});

test('invalid positions do not attach discussions to metadata or synthetic line zero', () => {
  const current = thread('current', line(14, 15));
  for (const position of [line(null, null), line(0, 15), line(14, -1), line(14, 1.5), { ...line(14, 15), oldPath: '' }]) {
    assert.deepEqual(mrLineDiscussions([current], refs, position), []);
  }
});

test('file index separates both diff sides and returns each full thread only once per line', () => {
  const added = thread('added', line(null, 7));
  const deleted = thread('deleted', line(7, null));
  const context = thread('context', line(14, 15), [
    { id: 2, position: { ...refs, positionType: 'text', ...line(14, 15) } },
    { id: 3, body: 'reply' },
  ]);
  const second = thread('second', line(14, 15));
  const wrongFile = thread('wrong-file', { ...line(14, 15), newPath: 'src/other.ts' });
  const stale = thread('stale', { ...line(14, 15), startSha: 'old' });
  const index = mrLineDiscussionIndex([added, deleted, context, second, wrongFile, stale], refs, file);
  assert.equal(index.size, 3);
  assert.deepEqual(index.get(mrCommentLineKey(line(null, 7))), [added]);
  assert.deepEqual(index.get(mrCommentLineKey(line(7, null))), [deleted]);
  assert.deepEqual(index.get(mrCommentLineKey(line(14, 15))), [context, second]);
  assert.equal(mrLineDiscussionIndex([context], null, file).size, 0);
});
