import test from "node:test";
import assert from "node:assert/strict";
import { glabLoginCommand, readGlabInstance, requestRepository } from "../src/branchRequest.ts";

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

test("glab sign-in instructions preserve the API endpoint and omit unsafe inputs", () => {
  assert.equal(glabLoginCommand("http://git.example"), "glab auth login --hostname git.example --api-protocol http");
  assert.equal(glabLoginCommand("https://git.example:8443/"), "glab auth login --hostname git.example --api-host git.example:8443 --api-protocol https");
  for (const bad of ["bad", "https://user:password@git.example", "https://git.example/subpath", "https://bad;host", "https://-flag", "https://git.example/?token=x"]) {
    assert.equal(glabLoginCommand(bad), null);
  }
});
