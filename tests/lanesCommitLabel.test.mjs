import test from "node:test";
import assert from "node:assert/strict";
import { parseMerge, shortDate } from "../src/lanes/commitLabel.ts";

test("merge messages become source → target", () => {
  assert.deepEqual(parseMerge("Merge branch 'feature/bridge-sentry-alerts' into 'master'\n\nreduce noise"), { source: "feature/bridge-sentry-alerts", target: "master" });
  assert.deepEqual(parseMerge("Merge branch 'master' into pre"), { source: "master", target: "pre" });
  assert.deepEqual(parseMerge("Merge branch 'hotfix/x'"), { source: "hotfix/x" });
  assert.deepEqual(parseMerge("Merge remote-tracking branch 'origin/dev' into feat"), { source: "dev", target: "feat" });
  assert.deepEqual(parseMerge("Merge pull request #12 from acme/feature/login"), { source: "feature/login" });
  assert.deepEqual(parseMerge("Merge feature/remove-liquidity into test"), { source: "feature/remove-liquidity", target: "test" });
  assert.equal(parseMerge("feat: add logo"), null);
});

test("short dates: time today, month/day this year, full date before", () => {
  const now = new Date(2026, 10, 28, 18, 0);
  assert.equal(shortDate(new Date(2026, 10, 28, 9, 5).toISOString(), now, "en-GB"), "09:05");
  assert.equal(shortDate(new Date(2026, 10, 19, 9, 5).toISOString(), now, "en-US"), "Nov 19");
  assert.equal(shortDate(new Date(2025, 0, 3).toISOString(), now, "en-US"), "1/3/2025");
});
