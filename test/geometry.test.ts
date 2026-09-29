import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  boundaryEdges,
  brushSquare,
  cellAt,
  cellEdges,
  cellKey,
  cellsOfSquare,
  connectedRegion,
  edgeKey,
  edgesBetween,
  innerEdges,
  isCellInRange,
  isEdgeInRange,
  MAX_SCALE,
  MIN_SCALE,
  nearestEdge,
  outlineCells,
  panBy,
  parseCellKey,
  parseEdgeKey,
  pointsAlong,
  screenToWorld,
  snapToVertex,
  wheelGesture,
  worldToScreen,
  zoomAt,
} from "../client/src/board/geometry.ts";
import type { Camera, Point } from "../client/src/board/geometry.ts";

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

describe("wheel: mouse or trackpad", () => {
  const wheel = (deltaY: number, deltaMode = 0, deltaX = 0, ctrlKey = false) => ({ deltaX, deltaY, deltaMode, ctrlKey });

  test("a mouse wheel on Windows (whole 100 px steps) zooms", () => {
    assert.equal(wheelGesture(wheel(100)), "zoom");
    assert.equal(wheelGesture(wheel(-100)), "zoom");
  });

  test("a mouse wheel in Firefox (lines) and in page mode zooms", () => {
    assert.equal(wheelGesture(wheel(3, 1)), "zoom");
    assert.equal(wheelGesture(wheel(-1, 2)), "zoom");
  });

  test("a two-finger trackpad scroll pans", () => {
    assert.equal(wheelGesture(wheel(4.5, 0, 1.2)), "pan");
  });

  test("a strictly vertical trackpad scroll with a fractional or small step pans", () => {
    assert.equal(wheelGesture(wheel(2.25)), "pan");
    assert.equal(wheelGesture(wheel(-117.5)), "pan");
    assert.equal(wheelGesture(wheel(4)), "pan");
  });

  test("a trackpad pinch (wheel with Ctrl) zooms", () => {
    assert.equal(wheelGesture(wheel(4.5, 0, 1.2, true)), "zoom");
    assert.equal(wheelGesture(wheel(-0.8, 0, 0, true)), "zoom");
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

const keysOf = (cells: readonly Point[]): string[] => cells.map((c) => cellKey(c.x, c.y)).sort();

/** A hand-drawn loop around cells 0..2 × 0..2: a wobbly square through the outer halves of the border cells. */
const LOOP_3X3: Point[] = [
  { x: -0.3, y: -0.2 },
  { x: 1.4, y: -0.4 },
  { x: 3.2, y: -0.1 },
  { x: 3.4, y: 1.6 },
  { x: 3.1, y: 3.3 },
  { x: 1.5, y: 3.2 },
  { x: -0.2, y: 3.4 },
  { x: -0.4, y: 1.4 },
];

describe("edge keys", () => {
  test("h is the top side of a cell, v the left side; -0 becomes 0", () => {
    assert.equal(edgeKey("h", 3, -2), "h:3,-2");
    assert.equal(edgeKey("v", -0, -0), "v:0,0");
    assert.deepEqual(parseEdgeKey("v:-12,7"), { dir: "v", x: -12, y: 7 });
    assert.deepEqual(cellEdges(2, -1), ["h:2,-1", "v:3,-1", "h:2,0", "v:2,-1"]);
  });

  test("the bottom and right sides of the last cells do not fit the key format", () => {
    assert.equal(isEdgeInRange("h:9999,-9999"), true);
    assert.equal(isEdgeInRange("h:9999,10000"), false);
    assert.equal(isEdgeInRange("v:10000,0"), false);
  });

  test("a vertex snaps to the nearest grid corner without -0", () => {
    const vertex = snapToVertex({ x: -0.2, y: -0.4 });
    assert.deepEqual(vertex, { x: 0, y: 0 });
    assert.ok(!Object.is(vertex.x, -0) && !Object.is(vertex.y, -0));
    assert.deepEqual(snapToVertex({ x: 2.6, y: -1.7 }), { x: 3, y: -2 });
  });
});

describe("outline", () => {
  test("a loop around 3×3 cells gives 9 cells and 12 boundary edges", () => {
    const cells = outlineCells(LOOP_3X3);
    assert.deepEqual(keysOf(cells), keysOf(cellsOfSquare({ x: 0, y: 0, size: 3 })));
    const boundary = boundaryEdges(cells);
    assert.equal(boundary.length, 12);
    assert.equal(new Set(boundary.map((edge) => edge.key)).size, 12);
    assert.equal(innerEdges(cells).length, 12);
  });

  test("the direction of drawing does not matter", () => {
    assert.deepEqual(keysOf(outlineCells([...LOOP_3X3].reverse())), keysOf(outlineCells(LOOP_3X3)));
  });

  test("an uneven figure eight takes the cells of both loops", () => {
    // Two loops crossing near 3.4,2.3, the left one larger.
    const keys = keysOf(
      outlineCells([
        { x: 0, y: 0 },
        { x: 6, y: 4 },
        { x: 6, y: 1 },
        { x: 0, y: 4 },
      ]),
    );
    assert.ok(keys.includes("0,1") && keys.includes("5,2"), keys.join(" "));
    assert.ok(!keys.includes("3,0") && !keys.includes("3,3"));
  });

  test("an even figure eight takes the cells of both loops too: their areas do not cancel out", () => {
    const bowTie = keysOf(
      outlineCells([
        { x: 0, y: 0 },
        { x: 4, y: 4 },
        { x: 4, y: 0 },
        { x: 0, y: 4 },
      ]),
    );
    assert.deepEqual(bowTie, ["0,1", "0,2", "3,1", "3,2"]);

    const lemniscate = Array.from({ length: 64 }, (_, i) => {
      const t = (i / 64) * 2 * Math.PI;
      return { x: 3 * Math.sin(t), y: 3 * Math.sin(t) * Math.cos(t) };
    });
    const keys = keysOf(outlineCells(lemniscate));
    assert.ok(keys.includes("2,0") && keys.includes("-3,-1"), keys.join(" "));
  });

  test("a thin sliver through several cell centres is a click", () => {
    // 5.6 × 0.05 cells: about 0.28 of a cell in area, yet the centres of six cells lie inside.
    const sliver = [
      { x: 0.2, y: 0.525 },
      { x: 0.2, y: 0.475 },
      { x: 5.8, y: 0.475 },
      { x: 5.8, y: 0.525 },
      { x: 3.5, y: 0.525 },
    ];
    assert.deepEqual(outlineCells(sliver), [{ x: 3, y: 0 }]);
  });

  test("an outline of less than half a cell is a click on the cell under the last point", () => {
    const scribble = [
      { x: 2.3, y: 1.6 },
      { x: 2.5, y: 1.9 },
      { x: 2.7, y: 1.5 },
      { x: 2.6, y: 1.4 },
    ];
    assert.deepEqual(outlineCells(scribble), [{ x: 2, y: 1 }]);
    assert.deepEqual(outlineCells([{ x: -0.5, y: -0.5 }]), [{ x: -1, y: -1 }]);
    assert.deepEqual(outlineCells([]), []);
  });

  test("over negative cells the keys come out without -0", () => {
    const cells = outlineCells([
      { x: -0.9, y: -0.9 },
      { x: 0.9, y: -0.9 },
      { x: 0.9, y: 0.9 },
      { x: -0.9, y: 0.9 },
    ]);
    assert.deepEqual(keysOf(cells), ["-1,-1", "-1,0", "0,-1", "0,0"]);
    assert.ok(cells.every((c) => !Object.is(c.x, -0) && !Object.is(c.y, -0)));
  });

  test("cells outside the key range are left out", () => {
    const cells = outlineCells([
      { x: 9997.1, y: 0.1 },
      { x: 10002, y: 0.1 },
      { x: 10002, y: 0.9 },
      { x: 9997.1, y: 0.9 },
    ]);
    assert.deepEqual(keysOf(cells), ["9997,0", "9998,0", "9999,0"]);
  });
});

/** Edges laid by a stroke through `points`, the way the walls tool lays them. */
function strokeEdges(points: readonly Point[]): string[] {
  let vertex = snapToVertex(points[0]);
  const edges: string[] = [];
  for (let i = 1; i < points.length; i++) {
    for (const point of pointsAlong(points[i - 1], points[i], 0.25)) {
      const next = snapToVertex(point);
      edges.push(...edgesBetween(vertex, next));
      vertex = next;
    }
  }
  return edges;
}

describe("walls along the grid", () => {
  test("a run along a grid line, in both directions", () => {
    assert.deepEqual(edgesBetween({ x: 0, y: 0 }, { x: 3, y: 0 }), ["h:0,0", "h:1,0", "h:2,0"]);
    assert.deepEqual(edgesBetween({ x: 0, y: 0 }, { x: -2, y: 0 }), ["h:-1,0", "h:-2,0"]);
    assert.deepEqual(edgesBetween({ x: 1, y: 1 }, { x: 1, y: -1 }), ["v:1,0", "v:1,-1"]);
    assert.deepEqual(edgesBetween({ x: 4, y: 4 }, { x: 4, y: 4 }), []);
  });

  test("a jump across 3 vertices diagonally gives a staircase of 6 edges", () => {
    const expected = ["h:0,0", "v:1,0", "h:1,1", "v:2,1", "h:2,2", "v:3,2"];
    assert.deepEqual(edgesBetween({ x: 0, y: 0 }, { x: 3, y: 3 }), expected);
  });

  test("a hand stroke along the diagonal through 3 vertices gives a staircase of 6 edges", () => {
    const edges = new Set(strokeEdges([{ x: 0.1, y: 0.05 }, { x: 2.9, y: 3.05 }]));
    assert.equal(edges.size, 6);
    const parsed = [...edges].map((key) => parseEdgeKey(key));
    assert.equal(parsed.filter((e) => e.dir === "h").length, 3);
    assert.equal(parsed.filter((e) => e.dir === "v").length, 3);
  });

  test("a shallow slope makes long treads", () => {
    assert.deepEqual(edgesBetween({ x: 0, y: 0 }, { x: 4, y: 1 }), ["h:0,0", "h:1,0", "v:2,0", "h:2,1", "h:3,1"]);
  });
});

describe("nearest edge", () => {
  test("a click by an edge picks that edge, not a neighbouring one", () => {
    assert.equal(nearestEdge({ x: 2.5, y: 3.1 }), "h:2,3");
    assert.equal(nearestEdge({ x: 2.5, y: 3.9 }), "h:2,4");
    assert.equal(nearestEdge({ x: 2.05, y: 3.5 }), "v:2,3");
    assert.equal(nearestEdge({ x: 2.95, y: 3.5 }), "v:3,3");
    // Near a corner the closer of the two edges wins.
    assert.equal(nearestEdge({ x: 2.8, y: 3.1 }), "h:2,3");
    assert.equal(nearestEdge({ x: 2.9, y: 3.2 }), "v:3,3");
  });

  test("over negative cells", () => {
    assert.equal(nearestEdge({ x: -0.5, y: -0.1 }), "h:-1,0");
    assert.equal(nearestEdge({ x: -0.05, y: 0.5 }), "v:0,0");
  });
});

describe("connected region", () => {
  const grass = new Set(["0,0", "1,0", "1,1", "3,0"]);
  const isGrass = (x: number, y: number): boolean => grass.has(cellKey(x, y));

  test("takes side neighbours only", () => {
    assert.deepEqual(keysOf(connectedRegion({ x: 0, y: 0 }, isGrass, 100) ?? []), ["0,0", "1,0", "1,1"]);
  });

  test("is empty when the start cell does not belong", () => {
    assert.deepEqual(connectedRegion({ x: 2, y: 0 }, isGrass, 100), []);
  });

  test("is null above the limit and whole at the limit", () => {
    assert.equal(connectedRegion({ x: 0, y: 0 }, isGrass, 2), null);
    assert.equal(connectedRegion({ x: 0, y: 0 }, isGrass, 3)?.length, 3);
  });

  test("an endless area stops at the limit", () => {
    assert.equal(connectedRegion({ x: 0, y: 0 }, () => true, 500), null);
  });
});
