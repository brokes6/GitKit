import test from "node:test";
import assert from "node:assert/strict";
import { readGlabInstance, requestRepository } from "../src/branchRequest.ts";

test("repository scope is bound to its instance and namespace", () => {
  const instance = "https://git.example:8443/lab";
  assert.equal(requestRepository("https://git.example:8443/lab/org/sub/api.git", instance), "org/sub/api");
  assert.equal(requestRepository("git@git.example:lab/sub/api.git", instance), "lab/sub/api");
  assert.equal(requestRepository("ssh://git@git.example:2222/org/sub/api.git", instance), "org/sub/api");
  assert.equal(requestRepository("https://git.example/lab/org/sub/api.git", instance), null);
  assert.equal(requestRepository("https://git.example:8443/other/org/api.git", instance), null);
  assert.equal(requestRepository("git@other.example:org/sub/api.git", instance), null);
});

test("CLI settings restore the explicit HTTP or HTTPS root and reject other URLs", t => {
  let saved;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  for (const value of ["http://git.example", "http://git.example:8080", "https://git.example"]) {
    saved = value + "/";
    assert.equal(readGlabInstance(), value);
  }
  for (saved of ["http://git.example/subpath", "ssh://git.example", "http://user@git.example"]) {
    assert.equal(readGlabInstance(), "");
  }
});
