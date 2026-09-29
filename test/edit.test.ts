// Patches of the drawing tools (plan 5.5, 8.2).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { TERRAIN } from "../client/src/board/catalog.ts";
import {
  edgesPatch,
  ENCLOSE_LIMIT,
  enclosePatch,
  erasePatch,
  fillPatch,
  roomPatch,
} from "../client/src/board/edit.ts";
import { cellKey } from "../client/src/board/geometry.ts";
import type { Point } from "../client/src/board/geometry.ts";
import { applyPatch, applyToChange, beginChange, finishChange, newHistory, newScene, redo, undo } from "../client/src/board/store.ts";
import type { History, Patch, Scene } from "../client/src/board/store.ts";

/** A change of one patch, as one tool action. */
function commit(scene: Scene, history: History, patch: Patch): void {
  beginChange(history);
  applyToChange(scene, history, patch);
  finishChange(history);
}

/** Cells of a w × h rectangle with top-left cell x,y. */
function rect(x: number, y: number, w: number, h: number): Point[] {
  const cells: Point[] = [];
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) cells.push({ x: i, y: j });
  return cells;
}

function paint(scene: Scene, cells: readonly Point[], terrain: (typeof TERRAIN)[number]["id"]): void {
  applyPatch(scene, fillPatch(scene, cells, terrain));
}

function drawRoom(scene: Scene, cells: readonly Point[]): void {
  applyPatch(scene, roomPatch(scene, cells, "floor"));
}

const edgesOfType = (scene: Scene, type: string): string[] =>
  Object.keys(scene.edges)
    .filter((key) => scene.edges[key] === type)
    .sort();

/** The walls of a closed w × h rectangle of cells. */
function rectWalls(x: number, y: number, w: number, h: number): string[] {
  const keys: string[] = [];
  for (let i = x; i < x + w; i++) keys.push(`h:${i},${y}`, `h:${i},${y + h}`);
  for (let j = y; j < y + h; j++) keys.push(`v:${x},${j}`, `v:${x + w},${j}`);
  return keys.sort();
}

describe("room", () => {
  test("a room on grass is walled in", () => {
    const scene = newScene();
    paint(scene, rect(-1, -1, 5, 5), "grass");
    drawRoom(scene, rect(0, 0, 3, 3));
    assert.deepEqual(edgesOfType(scene, "wall"), rectWalls(0, 0, 3, 3));
    assert.deepEqual(Object.keys(scene.rooms).sort(), rect(0, 0, 3, 3).map((c) => cellKey(c.x, c.y)).sort());
    assert.equal(scene.cells["1,1"], "floor");
    assert.equal(scene.cells["-1,-1"], "grass");
    assert.equal(scene.cells["3,1"], "grass");
  });

  test("a corridor drawn over a room takes away the wall at the entrance", () => {
    const scene = newScene();
    drawRoom(scene, rect(0, 0, 3, 3));
    drawRoom(scene, rect(2, 1, 5, 1)); // from the room's middle right cell out to x = 6
    assert.equal(scene.edges["v:3,1"], undefined);
    assert.equal(scene.edges["v:3,0"], "wall");
    assert.equal(scene.edges["v:3,2"], "wall");
    // Inside the old room the corridor adds no walls.
    assert.equal(scene.edges["h:2,1"], undefined);
    assert.equal(scene.edges["h:2,2"], undefined);
    for (const key of ["h:3,1", "h:6,1", "h:3,2", "h:6,2", "v:7,1"]) assert.equal(scene.edges[key], "wall", key);
    assert.equal(edgesOfType(scene, "wall").length, 12 - 1 + 9);
  });

  test("a room right next to another gets one shared wall", () => {
    const scene = newScene();
    drawRoom(scene, rect(0, 0, 3, 3));
    drawRoom(scene, rect(3, 0, 3, 3));
    assert.deepEqual(edgesOfType(scene, "wall"), [...new Set([...rectWalls(0, 0, 3, 3), ...rectWalls(3, 0, 3, 3)])].sort());
    assert.equal(Object.keys(scene.edges).length, 21);
  });

  test("a room drawn over another merges with it", () => {
    const scene = newScene();
    drawRoom(scene, rect(0, 0, 3, 3));
    drawRoom(scene, rect(2, 0, 3, 3));
    assert.deepEqual(edgesOfType(scene, "wall"), rectWalls(0, 0, 5, 3));
  });

  test("a door on a boundary that stays is kept", () => {
    const scene = newScene();
    drawRoom(scene, rect(0, 0, 3, 3));
    applyPatch(scene, [["edges", "v:3,1", "door"], ["edges", "v:0,1", "door"]]);
    drawRoom(scene, rect(3, 0, 3, 3)); // next to the right door
    drawRoom(scene, rect(1, -3, 1, 4)); // a corridor out through the top wall, away from both doors
    assert.equal(scene.edges["v:3,1"], "door");
    assert.equal(scene.edges["v:0,1"], "door");
    assert.equal(scene.edges["h:1,0"], undefined);
  });

  test("an inner door stays, only walls go", () => {
    const scene = newScene();
    applyPatch(scene, [["edges", "v:1,0", "door"], ["edges", "v:2,0", "wall"]]);
    drawRoom(scene, rect(0, 0, 3, 1));
    assert.equal(scene.edges["v:1,0"], "door");
    assert.equal(scene.edges["v:2,0"], undefined);
  });

  test("a room is undone in one step, and the whole scene comes back", () => {
    const scene = newScene();
    const history = newHistory();
    paint(scene, rect(-2, -2, 10, 8), "grass");
    drawRoom(scene, rect(0, 0, 3, 3));
    applyPatch(scene, [["edges", "v:0,1", "door"]]);
    const before = structuredClone(scene);

    commit(scene, history, roomPatch(scene, rect(2, 1, 5, 2), "wood"));
    const after = structuredClone(scene);
    assert.notDeepEqual(after, before);
    assert.equal(history.undo.length, 1);

    assert.equal(undo(scene, history), true);
    assert.deepEqual(scene, before);
    assert.equal(redo(scene, history), true);
    assert.deepEqual(scene, after);
  });

  test("a one-cell room gets four walls", () => {
    const scene = newScene();
    drawRoom(scene, [{ x: -1, y: 0 }]);
    assert.deepEqual(edgesOfType(scene, "wall"), rectWalls(-1, 0, 1, 1));
  });

  test("at the end of the key range the edges that do not fit are left out", () => {
    const scene = newScene();
    drawRoom(scene, [{ x: 9999, y: 9999 }]);
    assert.deepEqual(edgesOfType(scene, "wall"), ["h:9999,9999", "v:9999,9999"]);
  });
});

describe("fill and walls", () => {
  test("fill changes only the cells of another terrain and adds no rooms or walls", () => {
    const scene = newScene();
    paint(scene, [{ x: 0, y: 0 }], "grass");
    assert.deepEqual(fillPatch(scene, rect(0, 0, 2, 1), "grass"), [["cells", "1,0", "grass"]]);
  });

  test("walls set the type once per edge, change other types and skip what does not fit", () => {
    const scene = newScene();
    applyPatch(scene, [["edges", "h:0,0", "wall"], ["edges", "h:1,0", "door"]]);
    const patch = edgesPatch(scene, ["h:0,0", "h:1,0", "h:2,0", "h:2,0", "h:9999,10000"], "wall");
    assert.deepEqual(patch, [["edges", "h:1,0", "wall"], ["edges", "h:2,0", "wall"]]);
  });
});

describe("Shift+click with walls", () => {
  test("on an empty cell does nothing", () => {
    const scene = newScene();
    paint(scene, rect(0, 0, 3, 3), "grass");
    const before = structuredClone(scene);
    assert.deepEqual(enclosePatch(scene, { x: 10, y: 10 }, "wall"), []);
    assert.deepEqual(scene, before);
  });

  test("walls in the region of the same terrain connected through sides and keeps a door", () => {
    const scene = newScene();
    paint(scene, rect(0, 0, 4, 4), "floor");
    paint(scene, [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 3 }], "grass"); // 0,3 touches only by a corner
    applyPatch(scene, [["edges", "v:1,1", "door"]]);
    const patch = enclosePatch(scene, { x: 2, y: 1 }, "wall");
    assert.ok(patch);
    assert.deepEqual(
      patch.map((op) => op[1]).sort(),
      ["h:1,1", "h:2,1", "v:3,1", "h:2,2", "v:2,2", "h:1,3", "v:1,2"].sort(),
    );
    assert.ok(patch.every((op) => op[0] === "edges" && op[2] === "wall"));
  });

  test("with bars selected puts bars around the region: over walls, not over a door", () => {
    const scene = newScene();
    paint(scene, rect(0, 0, 4, 4), "floor");
    paint(scene, rect(1, 1, 2, 1), "grass");
    applyPatch(scene, [["edges", "v:1,1", "door"], ["edges", "h:1,1", "wall"], ["edges", "h:2,1", "bars"]]);
    const patch = enclosePatch(scene, { x: 1, y: 1 }, "bars");
    assert.ok(patch);
    applyPatch(scene, patch);
    assert.deepEqual(edgesOfType(scene, "bars"), ["h:1,1", "h:1,2", "h:2,1", "h:2,2", "v:3,1"]);
    assert.equal(scene.edges["v:1,1"], "door");
    assert.equal(patch.length, 4); // h:2,1 already had bars
  });

  test("a region larger than the limit gives null; one at the limit is walled in", () => {
    const side = Math.sqrt(ENCLOSE_LIMIT);
    const scene = newScene();
    paint(scene, rect(0, 0, side, side), "grass");
    assert.equal(enclosePatch(scene, { x: 5, y: 5 }, "wall")?.length, 4 * side);
    paint(scene, rect(side, 0, 1, 1), "grass");
    assert.equal(enclosePatch(scene, { x: 5, y: 5 }, "wall"), null);
  });
});

describe("eraser", () => {
  function furnished(): Scene {
    const scene = newScene();
    drawRoom(scene, rect(0, 0, 3, 3));
    applyPatch(scene, [
      ["objects", "o1", { type: "pillar", x: 2, y: 1 }],
      ["objects", "o2", { type: "pillar", x: 0, y: 0 }],
      ["marks", "m1", { color: "#c0392b", pts: [[0.2, 0.2], [2.5, 1.5]] }],
      ["marks", "m2", { color: "#c0392b", pts: [[0.5, 0.5]] }],
      ["tokens", "t1", { name: "Гоблин", x: 2, y: 1 }],
    ]);
    return scene;
  }
  const at21 = { x: 2, y: 1, size: 1 };

  test("the walls filter takes a piece of wall and leaves the floor", () => {
    const scene = furnished();
    applyPatch(scene, erasePatch(scene, at21, "walls"));
    assert.equal(scene.edges["v:3,1"], undefined);
    assert.equal(edgesOfType(scene, "wall").length, 11);
    assert.equal(Object.keys(scene.cells).length, 9);
    assert.equal(Object.keys(scene.rooms).length, 9);
    assert.equal(Object.keys(scene.objects).length, 2);
  });

  test("the terrain filter takes the floor with the room mark and leaves the walls", () => {
    const scene = furnished();
    applyPatch(scene, erasePatch(scene, at21, "terrain"));
    assert.equal(scene.cells["2,1"], undefined);
    assert.equal(scene.rooms["2,1"], undefined);
    assert.equal(Object.keys(scene.cells).length, 8);
    assert.equal(scene.edges["v:3,1"], "wall");
  });

  test("the objects and marks filter takes those under the square and nothing else", () => {
    const scene = furnished();
    applyPatch(scene, erasePatch(scene, at21, "items"));
    assert.deepEqual(Object.keys(scene.objects), ["o2"]);
    assert.deepEqual(Object.keys(scene.marks), ["m2"]);
    assert.deepEqual(Object.keys(scene.tokens), ["t1"]);
    assert.equal(Object.keys(scene.cells).length, 9);
  });

  test("everything takes all of it but tokens", () => {
    const scene = furnished();
    applyPatch(scene, erasePatch(scene, { x: 0, y: 0, size: 3 }, "all"));
    for (const name of ["cells", "rooms", "edges", "objects", "marks"] as const) assert.deepEqual(scene[name], {}, name);
    assert.deepEqual(Object.keys(scene.tokens), ["t1"]);
  });

  test("an edge shared by two erased cells is removed once", () => {
    const scene = furnished();
    const patch = erasePatch(scene, { x: 0, y: 0, size: 2 }, "walls");
    const keys = patch.map((op) => op[1]);
    assert.equal(new Set(keys).size, keys.length);
  });

  test("marks and objects with odd data are left alone", () => {
    const scene = newScene();
    applyPatch(scene, [
      ["objects", "o1", { type: "pillar" }],
      ["marks", "m1", { pts: "none" }],
      ["marks", "m2", { pts: [[1], "x"] }],
    ]);
    assert.deepEqual(erasePatch(scene, { x: 0, y: 0, size: 3 }, "items"), []);
  });

  test("an empty square gives nothing", () => {
    assert.deepEqual(erasePatch(newScene(), { x: 0, y: 0, size: 3 }, "all"), []);
  });
});
