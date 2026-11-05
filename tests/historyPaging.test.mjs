import test from "node:test";
import assert from "node:assert/strict";
import { HISTORY_MAX, HISTORY_PAGE_SIZE, isHistoryTruncated, nextHistoryLimit } from "../src/historyPaging.ts";

const commit = (fullHash, ...parents) => ({ fullHash, parents });

test("a history closed under parents is complete", () => {
  assert.equal(isHistoryTruncated([commit("c", "b"), commit("b", "a"), commit("a")]), false);
  assert.equal(isHistoryTruncated([commit("m", "a", "b"), commit("b", "a"), commit("a")]), false);
});

test("a missing parent means the log was cut off", () => {
  assert.equal(isHistoryTruncated([commit("c", "b"), commit("b", "a")]), true);
  assert.equal(isHistoryTruncated([commit("m", "x", "a"), commit("a")]), true);
});

test("empty history is not truncated", () => {
  assert.equal(isHistoryTruncated([]), false);
});

test("limit grows by one page and stops at the cap", () => {
  assert.equal(nextHistoryLimit(HISTORY_PAGE_SIZE), HISTORY_PAGE_SIZE * 2);
  assert.equal(nextHistoryLimit(HISTORY_MAX), null);
  assert.equal(nextHistoryLimit(HISTORY_MAX - HISTORY_PAGE_SIZE), HISTORY_MAX);
});
