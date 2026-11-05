import test from "node:test";
import assert from "node:assert/strict";
import { CLOCK_TICK_MS, setClockActive, subscribeClock } from "../src/clock.ts";

test.afterEach(() => setClockActive(true));

test("ticks on the shared interval and stops after unsubscribe", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const stop = subscribeClock(() => { calls++; });
  t.mock.timers.tick(CLOCK_TICK_MS * 2);
  assert.equal(calls, 2);
  stop();
  t.mock.timers.tick(CLOCK_TICK_MS * 2);
  assert.equal(calls, 2);
});

test("pauses in the background and catches up once on return", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const stop = subscribeClock(() => { calls++; });
  setClockActive(false);
  t.mock.timers.tick(CLOCK_TICK_MS * 5);
  assert.equal(calls, 0);
  setClockActive(true);
  assert.equal(calls, 1);
  t.mock.timers.tick(CLOCK_TICK_MS);
  assert.equal(calls, 2);
  stop();
});

test("many subscribers share one timer", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const counts = [0, 0, 0];
  const stops = counts.map((_, i) => subscribeClock(() => { counts[i]++; }));
  t.mock.timers.tick(CLOCK_TICK_MS);
  assert.deepEqual(counts, [1, 1, 1]);
  stops.forEach((stop) => stop());
});
