import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenInfoCache } from '../src/tokenInfoCache.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('fresh reads normalize credentials and reuse success metadata until the exact TTL boundary', async () => {
  let now = 100;
  const calls = [];
  const cache = createTokenInfoCache(async (url, token) => {
    calls.push({ url, token });
    return { login: 'fixture', revision: calls.length };
  }, { now: () => now });
  assert.equal(cache.read('https://example.invalid', 'fixture'), null);
  assert.equal(cache.isFresh('https://example.invalid', 'fixture'), false);
  const first = await cache.load(' https://example.invalid/// ', ' fixture ');
  assert.deepEqual(calls, [{ url: 'https://example.invalid', token: 'fixture' }]);
  assert.equal(first.checkedAt, 100);
  assert.equal(cache.read('https://example.invalid/', 'fixture'), first);
  now += 5 * 60_000 - 1;
  assert.equal(cache.isFresh('https://example.invalid', 'fixture'), true);
  assert.equal(await cache.load('https://example.invalid', 'fixture'), first);
  assert.equal(calls.length, 1);
  now++;
  assert.equal(cache.isFresh('https://example.invalid', 'fixture'), false);
  assert.equal(cache.read('https://example.invalid', 'fixture'), first);
  const second = await cache.load('https://example.invalid', 'fixture');
  assert.equal(second.info.revision, 2);
  assert.equal(second.checkedAt, now);
  assert.equal(cache.isFresh('https://example.invalid', 'fixture'), true);
});

test('force refresh and normal loads share a single active request while read retains its previous snapshot', async () => {
  const refresh = deferred();
  let calls = 0;
  const cache = createTokenInfoCache(() => ++calls === 1
    ? Promise.resolve({ scopes: ['repo'] }) : refresh.promise);
  const first = await cache.load('', 'fixture');
  const pending = cache.load('', 'fixture', true);
  assert.equal(cache.load('', 'fixture', true), pending);
  assert.equal(cache.load('', 'fixture'), pending);
  assert.equal(cache.read('', 'fixture'), first);
  assert.equal(cache.isFresh('', 'fixture'), false);
  await flush();
  assert.equal(calls, 2);
  refresh.resolve({ scopes: [] });
  assert.deepEqual((await pending).info.scopes, []);
  assert.deepEqual(cache.read('', 'fixture').info.scopes, []);
});

test('failures clear prior authorization and use the shorter error TTL, including a synchronous throw', async () => {
  let now = 0;
  let calls = 0;
  const cache = createTokenInfoCache(() => {
    calls++;
    if (calls === 1) return Promise.resolve({ scopes: ['repo'] });
    if (calls === 2) throw new Error('revoked fixture');
    return Promise.resolve({ scopes: [] });
  }, { now: () => now });
  await cache.load('', 'fixture');
  now = 20;
  const failed = await cache.load('', 'fixture', true);
  assert.deepEqual(failed, { info: null, error: 'Error: revoked fixture', checkedAt: 20 });
  assert.equal(cache.read('', 'fixture'), failed);
  now = 30_019;
  assert.equal(cache.isFresh('', 'fixture'), true);
  assert.equal(await cache.load('', 'fixture'), failed);
  assert.equal(calls, 2);
  now++;
  assert.equal(cache.isFresh('', 'fixture'), false);
  assert.deepEqual((await cache.load('', 'fixture')).info.scopes, []);
  assert.equal(calls, 3);
});

test('TTL options and clock rollback do not treat stale snapshots as fresh', async () => {
  let now = 10;
  let calls = 0;
  const cache = createTokenInfoCache(async () => { calls++; return calls; }, {
    now: () => now, successTtlMs: 10, errorTtlMs: 2,
  });
  await cache.load('', 'fixture');
  now = 9;
  assert.equal(cache.isFresh('', 'fixture'), false);
  now = 19;
  assert.equal(cache.isFresh('', 'fixture'), true);
  now = 20;
  assert.equal(cache.isFresh('', 'fixture'), false);
  await cache.load('', 'fixture');
  assert.equal(calls, 2);
  const failed = createTokenInfoCache(async () => { throw ''; }, { now: () => now, errorTtlMs: 2 });
  await failed.load('', 'fixture');
  now = 22;
  assert.equal(failed.isFresh('', 'fixture'), false);
});

test('invalidating an active request rejects its cache write and serializes a deduplicated fresh generation', async () => {
  const old = deferred();
  const current = deferred();
  let calls = 0;
  const cache = createTokenInfoCache(() => ++calls === 1 ? old.promise : current.promise);
  const initial = cache.load('https://example.invalid/', 'fixture');
  await flush();
  cache.invalidate(' https://example.invalid ', ' fixture ');
  assert.equal(cache.read('https://example.invalid', 'fixture'), null);
  const later = cache.load('https://example.invalid', 'fixture');
  const forced = cache.load('https://example.invalid', 'fixture', true);
  await flush();
  assert.equal(calls, 1);
  old.resolve({ scopes: ['old'] });
  await initial;
  assert.equal(cache.read('https://example.invalid', 'fixture'), null);
  await flush();
  assert.equal(calls, 2);
  current.resolve({ scopes: ['new'] });
  assert.deepEqual((await later).info.scopes, ['new']);
  assert.deepEqual((await forced).info.scopes, ['new']);
  assert.equal(calls, 2);
  assert.deepEqual(cache.read('https://example.invalid', 'fixture').info.scopes, ['new']);
  cache.invalidate('https://example.invalid', 'fixture');
  assert.equal(cache.read('https://example.invalid', 'fixture'), null);
  assert.equal(cache.isFresh('https://example.invalid', 'fixture'), false);
});

test('different credentials stay isolated and completed entries are evicted in least recently used order', async () => {
  const cache = createTokenInfoCache(async (url, token) => ({ url, token }), { maxEntries: 2 });
  await cache.load('https://first.invalid', 'fixture');
  await cache.load('https://second.invalid', 'fixture');
  assert.ok(cache.read('https://first.invalid', 'fixture'));
  await cache.load('https://first.invalid', 'other');
  assert.equal(cache.read('https://second.invalid', 'fixture'), null);
  assert.ok(cache.read('https://first.invalid', 'fixture'));
  assert.ok(cache.read('https://first.invalid', 'other'));
});

test('entry bounds never evict an active request or allow duplicates, and settle back to the limit', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const calls = Array(5).fill(0);
  const cache = createTokenInfoCache((url) => {
    const index = Number(url);
    calls[index]++;
    return gates[index].promise;
  }, { maxEntries: 2 });
  const requests = gates.map((_, index) => cache.load(String(index), 'fixture'));
  await flush();
  assert.equal(cache.load('0', 'fixture', true), requests[0]);
  for (let index = 0; index < gates.length; index++) {
    gates[index].resolve({ index });
    await requests[index];
  }
  assert.deepEqual(calls, [1, 1, 1, 1, 1]);
  const retained = gates.filter((_, index) => cache.read(String(index), 'fixture'));
  assert.equal(retained.length, 2);
  assert.equal(cache.read('0', 'fixture'), null);
  assert.ok(cache.read('3', 'fixture'));
  assert.ok(cache.read('4', 'fixture'));
});

test('the shared request pool caps old and new credentials at three concurrent reads and deduplicates queued requests', async () => {
  const gates = Array.from({ length: 7 }, deferred);
  const calls = Array(7).fill(0);
  let active = 0;
  let peak = 0;
  const cache = createTokenInfoCache(async (url) => {
    const index = Number(url);
    calls[index]++;
    active++;
    peak = Math.max(peak, active);
    await gates[index].promise;
    active--;
    return { index };
  });
  const older = [0, 1, 2].map(index => cache.load(String(index), 'fixture'));
  await flush();
  assert.equal(active, 3);
  const newer = [3, 4, 5, 6].map(index => cache.load(String(index), 'fixture'));
  assert.equal(cache.load('6', 'fixture', true), newer[3]);
  await flush();
  assert.deepEqual(calls, [1, 1, 1, 0, 0, 0, 0]);
  for (const gate of gates) gate.resolve();
  await Promise.all([...older, ...newer]);
  assert.deepEqual(calls, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('a configurable request bound remains available across failures and synchronous loader throws', async () => {
  const failure = deferred();
  const calls = [];
  const cache = createTokenInfoCache((url) => {
    calls.push(url);
    if (url === 'first') return failure.promise;
    if (url === 'second') throw new Error('fixture failure');
    return Promise.resolve({ url });
  }, { maxConcurrent: 1 });
  const first = cache.load('first', 'fixture');
  const second = cache.load('second', 'fixture');
  const third = cache.load('third', 'fixture');
  await flush();
  assert.deepEqual(calls, ['first']);
  failure.reject(new Error('fixture rejection'));
  const snapshots = await Promise.all([first, second, third]);
  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.equal(snapshots[0].info, null);
  assert.equal(snapshots[1].info, null);
  assert.deepEqual(snapshots[2].info, { url: 'third' });
});
