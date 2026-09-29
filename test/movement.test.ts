// Movement cost and ruler distances (plan 5.6, 8.3; canon-5e.md).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TerrainId } from "../client/src/board/catalog.ts";
import type { Point } from "../client/src/board/geometry.ts";
import { distance, extendPath, pathCost, stepsBetween } from "../client/src/board/movement.ts";
import { diagonalRule, newScene } from "../client/src/board/store.ts";

/** A path of places starting at `start`, walked through the given cells one step at a time. */
function walk(start: Point, ...places: [number, number][]): Point[] {
  return [start, ...places.map(([x, y]) => ({ x, y }))];
}

function terrain(...entries: [string, TerrainId][]): Record<string, unknown> {
  return Object.fromEntries(entries);
}

const straight6 = walk({ x: 0, y: 0 }, [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]);
const diagonal3 = walk({ x: 0, y: 0 }, [1, 1], [2, 2], [3, 3]);

describe("path cost", () => {
  test("a straight path of 6 cells costs 30 ft by either rule", () => {
    assert.equal(pathCost({}, straight6, 1, "5"), 30);
    assert.equal(pathCost({}, straight6, 1, "5-10-5"), 30);
  });

  test("3 diagonals cost 15 ft by the core rule and 20 ft by 5/10/5", () => {
    assert.equal(pathCost({}, diagonal3, 1, "5"), 15);
    assert.equal(pathCost({}, diagonal3, 1, "5-10-5"), 20);
  });

  test("5/10/5 counts diagonals along the whole path, straight steps between them do not reset it", () => {
    const path = walk({ x: 0, y: 0 }, [1, 1], [2, 1], [3, 2], [4, 3]);
    assert.equal(pathCost({}, path, 1, "5-10-5"), 5 + 5 + 10 + 5);
    assert.equal(pathCost({}, path, 1, "5"), 20);
  });

  test("a path through 2 cells of difficult terrain costs 10 ft more", () => {
    const cells = terrain(["2,0", "rubble"], ["3,0", "snow"]);
    assert.equal(pathCost(cells, straight6, 1, "5"), 40);
    assert.equal(pathCost(cells, straight6, 1, "5") - pathCost({}, straight6, 1, "5"), 10);
  });

  test("every kind of difficult terrain costs 5 ft more to enter, normal terrain does not", () => {
    const path = walk({ x: 0, y: 0 }, [1, 0]);
    for (const id of ["snow", "ice", "rubble", "brush", "shallow", "mud"] as const) {
      assert.equal(pathCost(terrain(["1,0", id]), path, 1, "5"), 10, id);
    }
    for (const id of ["floor", "wood", "dirt", "grass", "sand", "lava"] as const) {
      assert.equal(pathCost(terrain(["1,0", id]), path, 1, "5"), 5, id);
    }
  });

  test("deep water costs 5 ft more to enter", () => {
    assert.equal(pathCost(terrain(["1,0", "deep"]), walk({ x: 0, y: 0 }, [1, 0]), 1, "5"), 10);
  });

  test("chasm and rock do not stop a token and cost nothing extra", () => {
    const cells = terrain(["1,0", "chasm"], ["2,0", "rock"]);
    assert.equal(pathCost(cells, walk({ x: 0, y: 0 }, [1, 0], [2, 0]), 1, "5"), 10);
  });

  test("leaving difficult terrain for normal ground costs a normal step", () => {
    const cells = terrain(["0,0", "mud"]);
    assert.equal(pathCost(cells, walk({ x: 0, y: 0 }, [1, 0]), 1, "5"), 5);
  });

  test("a diagonal into difficult terrain adds 5 ft to the diagonal of either rule", () => {
    const cells = terrain(["2,2", "brush"]);
    assert.equal(pathCost(cells, walk({ x: 0, y: 0 }, [1, 1], [2, 2]), 1, "5"), 15);
    assert.equal(pathCost(cells, walk({ x: 0, y: 0 }, [1, 1], [2, 2]), 1, "5-10-5"), 20);
  });

  test("a Large token pays for difficult terrain when one of the four cells of its new place is difficult", () => {
    // The place at 1,0 covers cells 1,0 2,0 1,1 2,1; only 2,1 is difficult.
    const cells = terrain(["2,1", "rubble"]);
    const path = walk({ x: 0, y: 0 }, [1, 0]);
    assert.equal(pathCost(cells, path, 2, "5"), 10);
    assert.equal(pathCost(cells, path, 1, "5"), 5); // a Medium token at 1,0 does not touch 2,1
  });

  test("difficult terrain and deep water in one place do not stack", () => {
    const cells = terrain(["1,0", "shallow"], ["2,1", "deep"], ["1,1", "ice"]);
    assert.equal(pathCost(cells, walk({ x: 0, y: 0 }, [1, 0]), 2, "5"), 10);
  });

  test("a path of one place costs nothing", () => {
    assert.equal(pathCost({}, [{ x: 3, y: 3 }], 1, "5"), 0);
  });

  test("a step that is not to a neighbour is a programming error", () => {
    assert.throws(() => pathCost({}, walk({ x: 0, y: 0 }, [2, 0]), 1, "5"));
    assert.throws(() => pathCost({}, walk({ x: 0, y: 0 }, [0, 0]), 1, "5"));
  });
});

describe("steps between cells", () => {
  test("a jump of the pointer is filled in with steps to neighbours", () => {
    assert.deepEqual(stepsBetween({ x: 0, y: 0 }, { x: 3, y: 0 }), [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    assert.deepEqual(stepsBetween({ x: 0, y: 0 }, { x: -2, y: -2 }), [
      { x: -1, y: -1 },
      { x: -2, y: -2 },
    ]);
  });

  test("a slanted jump goes along the line with as many steps as the longer side", () => {
    const steps = stepsBetween({ x: 0, y: 0 }, { x: 4, y: 2 });
    assert.equal(steps.length, 4);
    assert.deepEqual(steps[steps.length - 1], { x: 4, y: 2 });
    let last = { x: 0, y: 0 };
    for (const step of steps) {
      assert.ok(Math.abs(step.x - last.x) <= 1 && Math.abs(step.y - last.y) <= 1);
      last = step;
    }
    assert.equal(pathCost({}, [{ x: 0, y: 0 }, ...steps], 1, "5"), 20);
  });

  test("the same cell gives no steps", () => {
    assert.deepEqual(stepsBetween({ x: 2, y: 2 }, { x: 2, y: 2 }), []);
  });
});

describe("the path of a dragged token (Р40)", () => {
  /** Drags from the start through the targets one after another. */
  function drag(start: Point, ...targets: [number, number][]): Point[] {
    let path = [start];
    for (const [x, y] of targets) path = extendPath(path, { x, y });
    return path;
  }

  test("4 cells forward and 2 back leave a path of 2 cells", () => {
    const path = drag({ x: 0, y: 0 }, [1, 0], [2, 0], [3, 0], [4, 0], [3, 0], [2, 0]);
    assert.deepEqual(path, walk({ x: 0, y: 0 }, [1, 0], [2, 0]));
    assert.equal(pathCost({}, path, 1, "5"), 10);
  });

  test("a jump back is cut the same way as steps back", () => {
    assert.deepEqual(drag({ x: 0, y: 0 }, [4, 0], [2, 0]), walk({ x: 0, y: 0 }, [1, 0], [2, 0]));
  });

  test("a return to the starting cell costs 0 ft", () => {
    const path = drag({ x: 0, y: 0 }, [1, 1], [2, 1], [1, 0], [0, 0]);
    assert.deepEqual(path, [{ x: 0, y: 0 }]);
    assert.equal(pathCost({}, path, 1, "5-10-5"), 0);
  });

  test("the cost is counted again over what is left, diagonals of 5/10/5 included", () => {
    const cells = terrain(["3,3", "rubble"]);
    const there = drag({ x: 0, y: 0 }, [3, 3]);
    assert.equal(pathCost(cells, there, 1, "5-10-5"), 25);
    const back = extendPath(there, { x: 1, y: 1 });
    assert.deepEqual(back, walk({ x: 0, y: 0 }, [1, 1]));
    assert.equal(pathCost(cells, back, 1, "5-10-5"), 5);
  });

  test("crossing the path somewhere else cuts the loop", () => {
    // Around a square and back into the second cell of the path.
    const path = drag({ x: 0, y: 0 }, [1, 0], [2, 0], [2, 1], [1, 1], [1, 0], [1, -1]);
    assert.deepEqual(path, walk({ x: 0, y: 0 }, [1, 0], [1, -1]));
  });

  test("the path given is not changed", () => {
    const start = [{ x: 0, y: 0 }];
    extendPath(start, { x: 2, y: 0 });
    assert.deepEqual(start, [{ x: 0, y: 0 }]);
  });
});

describe("ruler", () => {
  test("the core rule measures the longer side", () => {
    assert.deepEqual(distance({ x: 0, y: 0 }, { x: 6, y: 0 }, "5"), { feet: 30, cells: 6 });
    assert.deepEqual(distance({ x: 0, y: 0 }, { x: 3, y: 3 }, "5"), { feet: 15, cells: 3 });
    assert.deepEqual(distance({ x: 2, y: -1 }, { x: -3, y: 2 }, "5"), { feet: 25, cells: 5 });
  });

  test("5/10/5 adds half the shorter side to the feet, rounded down; cells are the cells of the path (Р40)", () => {
    assert.deepEqual(distance({ x: 0, y: 0 }, { x: 6, y: 0 }, "5-10-5"), { feet: 30, cells: 6 });
    assert.deepEqual(distance({ x: 0, y: 0 }, { x: 3, y: 3 }, "5-10-5"), { feet: 20, cells: 3 });
    assert.deepEqual(distance({ x: 0, y: 0 }, { x: 4, y: 4 }, "5-10-5"), { feet: 30, cells: 4 });
    assert.deepEqual(distance({ x: 2, y: -1 }, { x: -3, y: 2 }, "5-10-5"), { feet: 30, cells: 5 });
  });

  test("from a cell to itself is 0", () => {
    assert.deepEqual(distance({ x: 1, y: 1 }, { x: 1, y: 1 }, "5-10-5"), { feet: 0, cells: 0 });
  });

  test("the straight diagonal matches the cost of walking it", () => {
    for (const rule of ["5", "5-10-5"] as const) {
      assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 3 }, rule).feet, pathCost({}, diagonal3, 1, rule));
    }
  });
});

describe("the diagonal rule of a scene", () => {
  test("is the core rule unless 5/10/5 is set", () => {
    const scene = newScene();
    assert.equal(diagonalRule(scene), "5");
    scene.settings.diagonal = "5-10-5";
    assert.equal(diagonalRule(scene), "5-10-5");
    scene.settings.diagonal = "5";
    assert.equal(diagonalRule(scene), "5");
  });
});
