import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LANE_SETTINGS, normalizeLaneSettings, parseBranchList } from "../src/lanes/settings.ts";

test("stored lane settings are validated and completed", () => {
  assert.deepEqual(normalizeLaneSettings(null), DEFAULT_LANE_SETTINGS);
  const s = normalizeLaneSettings({
    slots: [{ kind: "trunk" }, { kind: "named", names: [" test ", "pre", "test", 3] }, { kind: "bogus" }],
    openAt: 9, maxLanes: 3, recentIncludesMerged: false, envOrder: "test", showLinks: "no",
  });
  assert.deepEqual(s.slots, [{ kind: "trunk" }, { kind: "named", names: ["test", "pre"] }, { kind: "recent" }, { kind: "recent" }]);
  assert.equal(s.openAt, 0);
  assert.equal(s.maxLanes, 3);
  assert.equal(s.recentIncludesMerged, false);
  assert.deepEqual(s.envOrder, []);
  assert.equal(s.showLinks, true);
});

test("branch lists accept commas, Chinese commas and spaces", () => {
  assert.deepEqual(parseBranchList("test, pre，dev  test、master"), ["test", "pre", "dev", "master"]);
  assert.deepEqual(parseBranchList("  "), []);
});
