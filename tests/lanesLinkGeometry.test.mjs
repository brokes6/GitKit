import test from "node:test";
import assert from "node:assert/strict";
import { dockPoint, facingEdges, linkPath, rowAnchor } from "../src/lanes/linkGeometry.ts";

const rect = (left, right, top, bottom) => ({ left, right, top, bottom });

test("uses facing card edges in both lane orders", () => {
  const left = rect(10, 110, 0, 200);
  const right = rect(140, 240, 0, 200);
  assert.deepEqual(facingEdges(left, right), [110, 140]);
  assert.deepEqual(facingEdges(right, left), [140, 110]);
});

test("keeps a visible row at its vertical centre", () => {
  const viewport = rect(0, 100, 20, 120);
  assert.deepEqual(rowAnchor(100, rect(0, 100, 20, 40), viewport), { x: 100, y: 30, clipped: null });
  assert.deepEqual(rowAnchor(100, rect(0, 100, 120, 140)), { x: 100, y: 130, clipped: null });
});

test("clamps fully and partially clipped rows to their scroll edge", () => {
  const viewport = rect(0, 100, 20, 120);
  for (const [top, bottom] of [[-20, 0], [15, 45]]) {
    assert.deepEqual(rowAnchor(100, rect(0, 100, top, bottom), viewport), { x: 100, y: 20, clipped: "up" });
  }
  for (const [top, bottom] of [[140, 160], [100, 125]]) {
    assert.deepEqual(rowAnchor(100, rect(0, 100, top, bottom), viewport), { x: 100, y: 120, clipped: "down" });
  }
});

test("clamps a row clipped at both edges toward its centre", () => {
  const viewport = rect(0, 100, 20, 120);
  assert.deepEqual(rowAnchor(100, rect(0, 100, 0, 125), viewport), { x: 100, y: 20, clipped: "up" });
  assert.deepEqual(rowAnchor(100, rect(0, 100, 15, 140), viewport), { x: 100, y: 120, clipped: "down" });
});

test("projects the lane centre onto the dock's top edge", () => {
  const dock = rect(40, 220, 260, 300);
  assert.deepEqual(dockPoint(rect(60, 160, 0, 200), dock), { x: 110, y: 260 });
  assert.deepEqual(dockPoint(rect(0, 60, 0, 200), dock), { x: 40, y: 260 });
  assert.deepEqual(dockPoint(rect(200, 280, 0, 200), dock), { x: 220, y: 260 });
});

test("uses horizontal lane tangents and vertical dock tangents", () => {
  const from = { x: 10, y: 40 };
  const to = { x: 30, y: 80 };
  assert.equal(linkPath(from, to), "M 10 40 C 21 40 19 80 30 80");
  assert.equal(linkPath(to, from), "M 30 80 C 19 80 21 40 10 40");
  assert.equal(linkPath(from, to, true), "M 10 40 C 10 62 30 58 30 80");
});
