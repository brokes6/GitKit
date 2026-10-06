import test from "node:test";
import assert from "node:assert/strict";
import { createProjectReadQueue } from "../src/projectReadQueue.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(paths, options = {}) {
  const calls = [];
  const batches = [];
  const busy = [];
  const activePaths = new Set();
  let active = 0;
  let peak = 0;
  const load = (path) => {
    assert.equal(activePaths.has(path), false, `overlapping native reads for ${path}`);
    activePaths.add(path);
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      const call = {
        path, startedAt: Date.now(), finished: false,
        finish(value = `${path}:${calls.indexOf(call)}`, error = null) {
          if (call.finished) return;
          call.finished = true;
          activePaths.delete(path);
          active--;
          if (error) reject(new Error(error)); else resolve(value);
        },
      };
      calls.push(call);
    });
  };
  const queue = createProjectReadQueue(load, {
    onBatch: (results) => batches.push(results),
    onBusyChange: (value) => busy.push(value),
    ...options,
  });
  queue.setPaths(paths);
  const drain = async () => {
    for (let iteration = 0; iteration < 30; iteration++) {
      calls.filter((call) => !call.finished).forEach((call) => call.finish());
      await turn();
      if (!queue.busy) return;
      if (options.minReadIntervalMs && active === 0) await delay(options.minReadIntervalMs + 2);
    }
    assert.fail("queue did not drain");
  };
  return { queue, calls, batches, busy, drain, get active() { return active; }, get peak() { return peak; } };
}

test("initial paths wait for activation, deduplicate, and share the default three-slot pool", async () => {
  const f = fixture(["a", "b", "a", "c", "d", "e", "f", "g"]);
  assert.equal(f.queue.busy, false);
  await turn();
  assert.equal(f.calls.length, 0);
  f.queue.setActive(true);
  await turn();
  assert.equal(f.active, 3);
  await f.drain();
  assert.equal(f.peak, 3);
  assert.equal(f.calls.length, 7);
  assert.deepEqual(f.batches.flat().map(({ path }) => path).sort(), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(f.busy, [true, false]);
  f.queue.dispose();
});

test("setPaths reordering retains results and pending work; only new paths are loaded", async () => {
  const f = fixture(["a", "b", "c", "d"]);
  f.queue.setActive(true);
  await turn();
  f.queue.setPaths(["d", "c", "b", "a"]);
  await f.drain();
  assert.equal(f.calls.length, 4);
  f.queue.setPaths(["c", "a", "d", "b"]);
  await turn();
  assert.equal(f.calls.length, 4);
  f.queue.setPaths(["c", "a", "new", "d", "b"]);
  await turn();
  assert.deepEqual(f.calls.slice(4).map(({ path }) => path), ["new"]);
  await f.drain();
  f.queue.dispose();
});

test("targeted refresh bursts coalesce and never reread unrelated settled paths", async () => {
  const f = fixture(["a", "b", "c"]);
  f.queue.setActive(true);
  await f.drain();
  for (let i = 0; i < 50; i++) f.queue.refresh(["b", "b", "unknown"]);
  await turn();
  assert.equal(f.calls.filter(({ path }) => path === "b").length, 2);
  assert.equal(f.calls.filter(({ path }) => path === "a").length, 1);
  assert.equal(f.calls.filter(({ path }) => path === "c").length, 1);
  await f.drain();
  assert.equal(f.batches.flat().filter(({ path }) => path === "b").length, 2);
  f.queue.dispose();
});

test("in-flight invalidation drops stale data and gives waiting paths a slot before one trailing read", async () => {
  const f = fixture(["a", "b", "c", "d"]);
  f.queue.setActive(true);
  await turn();
  for (let i = 0; i < 100; i++) f.queue.refresh(["a"]);
  f.calls[0].finish("stale-a");
  await turn();
  assert.equal(f.calls[3].path, "d");
  f.calls[1].finish("fresh-b");
  await turn();
  assert.equal(f.calls[4].path, "a");
  f.calls[4].finish("fresh-a");
  await f.drain();
  assert.equal(f.calls.filter(({ path }) => path === "a").length, 2);
  assert.equal(f.batches.flat().some(({ value }) => value === "stale-a"), false);
  assert.equal(f.batches.flat().find(({ path }) => path === "a").value, "fresh-a");
  assert.equal(f.peak, 3);
  f.queue.dispose();
});

test("ready paths publish while another native read remains pending", async () => {
  const f = fixture(["ready-a", "ready-b", "slow"], { batchDelay: 10 });
  f.queue.setActive(true);
  await turn();
  f.calls[0].finish();
  f.calls[1].finish();
  await delay(30);
  assert.equal(f.batches.length, 1);
  assert.deepEqual(f.batches[0].map(({ path }) => path), ["ready-a", "ready-b"]);
  assert.equal(f.active, 1);
  assert.equal(f.queue.busy, true);
  await f.drain();
  f.queue.dispose();
});

test("pause retains dirty work and physical slots, discards late results, and rereads on resume", async () => {
  const f = fixture(["a", "b", "c", "queued"]);
  f.queue.setActive(true);
  await turn();
  f.queue.setActive(false);
  assert.equal(f.queue.busy, false);
  f.queue.refresh(["queued"]);
  f.calls[0].finish("paused-a");
  await turn();
  assert.equal(f.calls.length, 3);
  assert.equal(f.batches.length, 0);
  f.queue.setActive(true);
  await turn();
  assert.equal(f.calls.length, 4);
  assert.equal(f.active, 3);
  await f.drain();
  assert.equal(f.peak, 3);
  assert.equal(f.batches.flat().some(({ value }) => value === "paused-a"), false);
  assert.deepEqual(f.batches.flat().map(({ path }) => path).sort(), ["a", "b", "c", "queued"]);
  f.queue.dispose();
});

test("pause before a pending batch discards it and requeues its unread publication", async () => {
  const f = fixture(["ready", "slow"], { batchDelay: 1000 });
  f.queue.setActive(true);
  await turn();
  f.calls[0].finish("unpublished");
  await turn();
  f.queue.setActive(false);
  f.calls[1].finish();
  await turn();
  assert.equal(f.batches.length, 0);
  f.queue.setActive(true);
  await f.drain();
  assert.equal(f.calls.filter(({ path }) => path === "ready").length, 2);
  assert.equal(f.batches.flat().some(({ value }) => value === "unpublished"), false);
  f.queue.dispose();
});

test("removed queued or in-flight paths never publish, and re-added paths cannot accept old incarnations", async () => {
  const f = fixture(["a", "b", "c", "removed-queued"]);
  f.queue.setActive(true);
  await turn();
  f.queue.setPaths(["b", "c"]);
  f.queue.setPaths(["b", "c", "a"]);
  f.calls[0].finish("old-incarnation");
  await turn();
  assert.equal(f.calls[3].path, "a");
  await f.drain();
  assert.equal(f.calls.some(({ path }) => path === "removed-queued"), false);
  assert.equal(f.batches.flat().some(({ value }) => value === "old-incarnation"), false);
  assert.equal(f.batches.flat().filter(({ path }) => path === "a").length, 1);
  f.queue.dispose();
});

test("removed ready results are pruned before a delayed batch", async () => {
  const f = fixture(["removed", "slow"], { batchDelay: 1000 });
  f.queue.setActive(true);
  await turn();
  f.calls[0].finish();
  await turn();
  f.queue.setPaths(["slow"]);
  await f.drain();
  assert.deepEqual(f.batches.flat().map(({ path }) => path), ["slow"]);
  f.queue.dispose();
});

test("native failures publish once and release slots for subsequent queued paths", async () => {
  const f = fixture(["bad", "next"], { concurrency: 1 });
  f.queue.setActive(true);
  await turn();
  f.calls[0].finish(null, "cannot read repository");
  await turn();
  assert.equal(f.calls[1].path, "next");
  await f.drain();
  assert.deepEqual(f.batches.flat().find(({ path }) => path === "bad"), {
    path: "bad", value: null, error: "cannot read repository",
  });
  assert.equal(f.peak, 1);
  f.queue.dispose();
});

test("full refresh explicitly invalidates all current paths", async () => {
  const f = fixture(["a", "b", "c"]);
  f.queue.setActive(true);
  await f.drain();
  f.queue.refresh();
  await f.drain();
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.batches.flat().map(({ path }) => path).sort(), ["a", "a", "b", "b", "c", "c"]);
  f.queue.dispose();
});

test("per-path cooldown serves other eligible paths and is measured from read start without resetting on events", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  context.mock.method(performance, "now", () => Date.now());
  const f = fixture(["a"], { concurrency: 1, minReadIntervalMs: 40 });
  f.queue.setActive(true);
  await turn();
  f.calls[0].finish();
  await turn();
  const first = f.calls[0];
  f.queue.refresh(["a"]);
  f.queue.setPaths(["a", "new"]);
  await turn();
  assert.equal(f.calls[1].path, "new");
  f.calls[1].finish();
  await turn();
  for (let i = 0; i < 13; i++) {
    context.mock.timers.tick(5);
    f.queue.refresh(["a"]);
    await turn();
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].path, "a");
  assert.equal(f.calls[2].startedAt - first.startedAt, 40);
  f.calls[2].finish("superseded-second-read");
  await turn();
  context.mock.timers.tick(15);
  await turn();
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].startedAt - first.startedAt, 80);
  f.calls[3].finish();
  await turn();
  assert.equal(f.queue.busy, false);
  assert.equal(f.batches.flat().some(({ value }) => value === "superseded-second-read"), false);
  f.queue.dispose();
});

test("pause and disposal cancel wakeups; disposal rejects all late publications and further API calls", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  context.mock.method(performance, "now", () => Date.now());
  const f = fixture(["a"], { minReadIntervalMs: 30 });
  f.queue.setActive(true);
  await turn();
  f.calls[0].finish();
  await turn();
  f.queue.refresh(["a"]);
  f.queue.setActive(false);
  context.mock.timers.tick(45);
  await turn();
  assert.equal(f.calls.length, 1);
  f.queue.setActive(true);
  await turn();
  assert.equal(f.calls.length, 2);
  f.queue.dispose();
  f.calls[1].finish("after-disposal");
  f.queue.refresh();
  f.queue.setPaths(["other"]);
  f.queue.setActive(true);
  context.mock.timers.tick(45);
  await turn();
  assert.equal(f.calls.length, 2);
  assert.equal(f.batches.flat().some(({ value }) => value === "after-disposal"), false);
  assert.equal(f.queue.busy, false);
});

test("load exceptions are ordinary failed reads and callback invalidations stay in the same pool", async () => {
  let attempts = 0;
  const results = [];
  let queue;
  queue = createProjectReadQueue(() => {
    attempts++;
    if (attempts === 1) throw new Error("synchronous native bridge failure");
    return Promise.resolve("recovered");
  }, { onBatch: (batch) => {
    results.push(...batch);
    if (results.length === 1) queue.refresh(["a"]);
  } });
  queue.setPaths(["a"]);
  queue.setActive(true);
  await turn();
  assert.equal(attempts, 2);
  assert.equal(results[0].error, "synchronous native bridge failure");
  assert.equal(results[1].value, "recovered");
  assert.equal(queue.busy, false);
  queue.dispose();
});
