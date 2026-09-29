import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  brushSquare,
  cellAt,
  cellKey,
  cellsOfSquare,
  isCellInRange,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  parseCellKey,
  pointsAlong,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "../client/src/board/geometry.ts";
import type { Camera } from "../client/src/board/geometry.ts";

describe("cells", () => {
  test("cell boundaries: 0, -0.0001 and negative cells", () => {
    const cases: [number, number][] = [
      [0, 0],
      [-0.0001, -1],
      [0.9999, 0],
      [1, 1],
      [-1, -1],
      [-1.0001, -2],
      [-9999.5, -10000],
    ];
    for (const [world, cell] of cases) {
      assert.deepEqual(cellAt({ x: world, y: world }), { x: cell, y: cell }, `world ${world}`);
    }
  });

  test("-0 falls into cell 0, not -0", () => {
    assert.ok(Object.is(cellAt({ x: -0, y: -0 }).x, 0));
  });

  test("screen to cell with a camera over negative cells", () => {
    const camera: Camera = { x: -3.5, y: -2, scale: 40 };
    assert.deepEqual(cellAt(screenToWorld(camera, { x: 0, y: 0 })), { x: -4, y: -2 });
    assert.deepEqual(cellAt(screenToWorld(camera, { x: 19.9, y: 39.9 })), { x: -4, y: -2 });
    assert.deepEqual(cellAt(screenToWorld(camera, { x: 20, y: 40 })), { x: -3, y: -1 });
    assert.deepEqual(cellAt(screenToWorld(camera, { x: 140, y: 80 })), { x: 0, y: 0 });
  });

  test("screen and world coordinates convert back and forth", () => {
    const camera: Camera = { x: -12.25, y: 7.5, scale: 33 };
    const world = screenToWorld(camera, { x: 311, y: 97 });
    const screen = worldToScreen(camera, world);
    assert.ok(Math.abs(screen.x - 311) < 1e-9 && Math.abs(screen.y - 97) < 1e-9);
  });

  test("keys", () => {
    assert.equal(cellKey(3, -2), "3,-2");
    assert.equal(cellKey(-0, 0), "0,0");
    assert.deepEqual(parseCellKey("-9999,17"), { x: -9999, y: 17 });
  });

  test("range of the key format", () => {
    assert.equal(isCellInRange(9999, -9999), true);
    assert.equal(isCellInRange(10000, 0), false);
    assert.equal(isCellInRange(0, -10000), false);
  });
});

describe("camera", () => {
  test("zoom keeps the world point under the cursor in place", () => {
    const camera: Camera = { x: -5, y: 3, scale: 40 };
    const cursor = { x: 250, y: 130 };
    const before = screenToWorld(camera, cursor);
    const after = screenToWorld(zoomAt(camera, cursor, 1.7), cursor);
    assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
  });

  test("zoom is clamped", () => {
    const camera: Camera = { x: 0, y: 0, scale: 40 };
    assert.equal(zoomAt(camera, { x: 0, y: 0 }, 100).scale, MAX_SCALE);
    assert.equal(zoomAt(camera, { x: 0, y: 0 }, 0.001).scale, MIN_SCALE);
  });

  test("the map follows a dragged pointer", () => {
    const camera: Camera = { x: 1, y: 1, scale: 20 };
    const grabbed = screenToWorld(camera, { x: 100, y: 100 });
    const moved = panBy(camera, 30, -50);
    assert.deepEqual(screenToWorld(moved, { x: 130, y: 50 }), grabbed);
  });
});

describe("brush", () => {
  test("size 1 is the cell under the point", () => {
    assert.deepEqual(brushSquare({ x: 0.2, y: -0.0001 }, 1), { x: 0, y: -1, size: 1 });
  });

  test("size 3 is centred on the cell under the point", () => {
    assert.deepEqual(brushSquare({ x: 0.5, y: -0.5 }, 3), { x: -1, y: -2, size: 3 });
    assert.equal(cellsOfSquare(brushSquare({ x: 0.5, y: 0.5 }, 3)).length, 9);
  });

  test("size 2 is centred on the nearest grid corner", () => {
    assert.deepEqual(brushSquare({ x: 0.6, y: 0.4 }, 2), { x: 0, y: -1, size: 2 });
    assert.deepEqual(brushSquare({ x: -0.6, y: -0.4 }, 2), { x: -2, y: -1, size: 2 });
  });

  test("cells of a square, row by row", () => {
    assert.deepEqual(cellsOfSquare({ x: -1, y: 0, size: 2 }), [
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  test("points along a stroke end at the target and are no further apart than the step", () => {
    const from = { x: 0, y: 0 };
    const points = pointsAlong(from, { x: 3, y: -4 }, 0.25);
    assert.equal(points.length, 20);
    assert.deepEqual(points.at(-1), { x: 3, y: -4 });
    let previous = from;
    for (const point of points) {
      assert.ok(Math.hypot(point.x - previous.x, point.y - previous.y) <= 0.25 + 1e-9);
      previous = point;
    }
  });

  test("a stroke that does not move gives the target once", () => {
    assert.deepEqual(pointsAlong({ x: 1, y: 1 }, { x: 1, y: 1 }, 0.25), [{ x: 1, y: 1 }]);
  });
});
