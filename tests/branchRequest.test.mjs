import test from "node:test";
import assert from "node:assert/strict";
import { requestRepository } from "../src/branchRequest.ts";

test("repository scope is bound to its instance and namespace", () => {
  const instance = "https://git.example:8443/lab";
  assert.equal(requestRepository("https://git.example:8443/lab/org/sub/api.git", instance), "org/sub/api");
  assert.equal(requestRepository("git@git.example:lab/sub/api.git", instance), "lab/sub/api");
  assert.equal(requestRepository("ssh://git@git.example:2222/org/sub/api.git", instance), "org/sub/api");
  assert.equal(requestRepository("https://git.example/lab/org/sub/api.git", instance), null);
  assert.equal(requestRepository("https://git.example:8443/other/org/api.git", instance), null);
  assert.equal(requestRepository("git@other.example:org/sub/api.git", instance), null);
});
