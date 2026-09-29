import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EDGE_TYPES, TERRAIN } from "../client/src/board/catalog.ts";
import { cellKey } from "../client/src/board/geometry.ts";
import type { Point } from "../client/src/board/geometry.ts";
import {
  applyPatch,
  applyToChange,
  beginChange,
  cancelChange,
  COLLECTIONS,
  edgesPatch,
  ENCLOSE_LIMIT,
  enclosePatch,
  erasePatch,
  fillPatch,
  finishChange,
  mergeInverses,
  newHistory,
  newScene,
  parseScene,
  redo,
  roomPatch,
  SceneError,
  undo,
  validatePatch,
} from "../client/src/board/store.ts";
import type { History, Patch, PatchOp, Scene } from "../client/src/board/store.ts";

/** Deterministic PRNG (mulberry32), so a failing run repeats. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOp(random: () => number): PatchOp {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const coord = (): number => Math.floor(random() * 7) - 3; // small range, so keys repeat
  const cell = (): string => `${coord()},${coord()}`;
  const remove = random() < 0.25;
  switch (pick(COLLECTIONS)) {
    case "settings": {
      const key = pick(["name", "diagonal", "fog"] as const);
      const value = { name: pick(["", "Склеп", "Crypt"]), diagonal: pick(["5", "5-10-5"]), fog: random() < 0.5 }[key];
      return ["settings", key, remove ? null : value];
    }
    case "cells":
      return ["cells", cell(), remove ? null : pick(TERRAIN).id];
    case "rooms":
      return ["rooms", cell(), remove ? null : 1];
    case "revealed":
      return ["revealed", cell(), remove ? null : 1];
    case "edges":
      return ["edges", `${pick(["h", "v"])}:${cell()}`, remove ? null : pick(EDGE_TYPES)];
    case "objects":
      return ["objects", `o${Math.floor(random() * 5)}`, remove ? null : { type: "pillar", x: coord(), y: coord() }];
    case "tokens":
      return ["tokens", `t${Math.floor(random() * 5)}`, remove ? null : { name: "Гоблин", x: coord(), y: coord() }];
    case "marks":
      return ["marks", `m${Math.floor(random() * 5)}`, remove ? null : { color: "#c0392b", pts: [[random(), random()]] }];
  }
}

function randomPatch(random: () => number): Patch {
  return Array.from({ length: 1 + Math.floor(random() * 6) }, () => randomOp(random));
}

function sceneWithCells(...keys: string[]): Scene {
  const scene = newScene();
  for (const key of keys) scene.cells[key] = "floor";
  return scene;
}

function assertSceneError(action: () => unknown, code: SceneError["code"]): void {
  assert.throws(action, (error) => error instanceof SceneError && error.code === code);
}

describe("scene", () => {
  test("a new scene has version 1 and every collection empty", () => {
    const scene = newScene();
    assert.equal(scene.v, 1);
    for (const name of COLLECTIONS) assert.deepEqual(scene[name], {});
  });

  test("100 random patches applied and undone by their inverses give back the original JSON", () => {
    const random = seededRandom(20260929);
    const scene = newScene();
    for (let i = 0; i < 30; i++) applyPatch(scene, randomPatch(random));
    const original = JSON.parse(JSON.stringify(scene));

    const inverses: Patch[] = [];
    for (let i = 0; i < 100; i++) inverses.push(applyPatch(scene, randomPatch(random)));
    assert.notDeepEqual(scene, original);
    for (const inverse of inverses.reverse()) applyPatch(scene, inverse);

    assert.deepEqual(JSON.parse(JSON.stringify(scene)), original);
  });

  test("a patch that sets one key twice is undone to the value before it", () => {
    const scene = sceneWithCells("0,0");
    const inverse = applyPatch(scene, [
      ["cells", "0,0", "grass"],
      ["cells", "0,0", "lava"],
    ]);
    assert.equal(scene.cells["0,0"], "lava");
    applyPatch(scene, inverse);
    assert.deepEqual(scene.cells, { "0,0": "floor" });
  });

  test("null deletes an entry and the inverse puts it back", () => {
    const scene = sceneWithCells("1,1");
    const inverse = applyPatch(scene, [["cells", "1,1", null]]);
    assert.deepEqual(scene.cells, {});
    assert.deepEqual(inverse, [["cells", "1,1", "floor"]]);
    applyPatch(scene, inverse);
    assert.deepEqual(scene.cells, { "1,1": "floor" });
  });

  test("a patch with one bad entry changes nothing", () => {
    const scene = sceneWithCells("0,0");
    assertSceneError(() => applyPatch(scene, [["cells", "1,0", "grass"], ["cells", "2,0", "marble"]]), "value");
    assert.deepEqual(scene.cells, { "0,0": "floor" });
  });
});

describe("merged inverses", () => {
  test("restore the state before a sequence of patches", () => {
    const scene = sceneWithCells("0,0", "1,0");
    const before = structuredClone(scene);
    const inverses = [
      applyPatch(scene, [["cells", "0,0", "grass"], ["cells", "2,0", "sand"]]),
      applyPatch(scene, [["cells", "0,0", "lava"], ["cells", "1,0", null]]),
      applyPatch(scene, [["cells", "2,0", "ice"]]),
    ];
    const merged = mergeInverses(inverses);
    assert.equal(merged.length, 3);
    applyPatch(scene, merged);
    assert.deepEqual(scene, before);
  });

  test("of nothing are empty", () => {
    assert.deepEqual(mergeInverses([]), []);
  });
});

/** A change of one patch, as a one-dab stroke. */
function commit(scene: Scene, history: History, patch: Patch): void {
  beginChange(history);
  applyToChange(scene, history, patch);
  finishChange(history);
}

describe("undo and redo", () => {
  test("undo restores, redo repeats, a new change clears redo", () => {
    const scene = newScene();
    const history = newHistory();
    commit(scene, history, [["cells", "0,0", "grass"]]);
    commit(scene, history, [["cells", "1,0", "sand"]]);

    assert.equal(undo(scene, history), true);
    assert.deepEqual(scene.cells, { "0,0": "grass" });
    assert.equal(undo(scene, history), true);
    assert.deepEqual(scene.cells, {});
    assert.equal(undo(scene, history), false);

    assert.equal(redo(scene, history), true);
    assert.deepEqual(scene.cells, { "0,0": "grass" });

    commit(scene, history, [["cells", "5,5", "rock"]]);
    assert.equal(redo(scene, history), false);
    assert.deepEqual(scene.cells, { "0,0": "grass", "5,5": "rock" });
  });

  test("10 changes, 10 undos give an empty scene, 10 redos bring it back", () => {
    const scene = newScene();
    const history = newHistory();
    for (let x = 0; x < 10; x++) commit(scene, history, [["cells", `${x},0`, "dirt"]]);
    const painted = structuredClone(scene);
    for (let i = 0; i < 10; i++) assert.equal(undo(scene, history), true);
    assert.deepEqual(scene, newScene());
    for (let i = 0; i < 10; i++) assert.equal(redo(scene, history), true);
    assert.deepEqual(scene, painted);
  });

  test("a change that changed nothing is not recorded", () => {
    const history = newHistory();
    beginChange(history);
    assert.equal(finishChange(history), false);
    assert.equal(history.undo.length, 0);
  });
});

describe("a change of several patches (a stroke)", () => {
  test("is one undo step", () => {
    const scene = newScene();
    const history = newHistory();
    beginChange(history);
    applyToChange(scene, history, [["cells", "0,0", "grass"]]);
    applyToChange(scene, history, [["cells", "1,0", "grass"], ["cells", "0,0", "lava"]]);
    assert.equal(finishChange(history), true);
    assert.equal(history.undo.length, 1);
    assert.equal(undo(scene, history), true);
    assert.deepEqual(scene, newScene());
  });

  test("blocks undo and redo until it ends, so the history stays in step with the scene", () => {
    const scene = newScene();
    const history = newHistory();
    commit(scene, history, [["cells", "0,0", "sand"]]);
    commit(scene, history, [["cells", "1,0", "sand"]]);
    undo(scene, history);

    beginChange(history);
    applyToChange(scene, history, [["cells", "0,0", "ice"], ["cells", "2,0", "ice"]]);
    assert.equal(undo(scene, history), false);
    assert.equal(redo(scene, history), false);
    assert.deepEqual(scene.cells, { "0,0": "ice", "2,0": "ice" });
    assert.equal(history.undo.length, 1);
    assert.equal(history.redo.length, 1);

    applyToChange(scene, history, [["cells", "3,0", "ice"]]);
    finishChange(history);
    assert.equal(history.redo.length, 0);
    assert.equal(undo(scene, history), true);
    assert.deepEqual(scene.cells, { "0,0": "sand" });
    assert.equal(undo(scene, history), true);
    assert.deepEqual(scene, newScene());
    assert.equal(undo(scene, history), false);
  });

  test("cancelled, leaves the scene and the history as they were", () => {
    const scene = newScene();
    const history = newHistory();
    commit(scene, history, [["cells", "0,0", "sand"]]);
    const before = structuredClone(scene);
    beginChange(history);
    applyToChange(scene, history, [["cells", "0,0", "mud"], ["cells", "4,4", "mud"]]);
    cancelChange(scene, history);
    assert.deepEqual(scene, before);
    assert.equal(history.undo.length, 1);
    assert.equal(history.open, null);
    assert.equal(undo(scene, history), true);
  });

  test("cannot be opened twice or used when not open", () => {
    const scene = newScene();
    const history = newHistory();
    assert.throws(() => applyToChange(scene, history, []));
    assert.throws(() => finishChange(history));
    assert.throws(() => cancelChange(scene, history));
    beginChange(history);
    assert.throws(() => beginChange(history));
  });
});

describe("reading a scene", () => {
  const example = {
    v: 1,
    settings: { name: "Склеп", diagonal: "5", fog: false },
    cells: { "3,-2": "floor" },
    rooms: { "3,-2": 1 },
    edges: { "h:3,-2": "wall", "v:4,-2": "door" },
    objects: { o1a2: { type: "pillar", x: 3, y: -2 } },
    tokens: { t9k: { name: "Гоблин 2", side: "enemies", size: "small", x: 5, y: 1, hidden: false, vision: 60, character: null } },
    marks: { m7: { color: "#c0392b", pts: [[3.5, -1.2], [4.1, -0.8]] } },
    revealed: { "3,-2": 1 },
  };

  test("the example from plan 6.1 reads back unchanged", () => {
    assert.deepEqual(parseScene(JSON.parse(JSON.stringify(example))), example);
  });

  test("missing collections read as empty", () => {
    assert.deepEqual(parseScene({ v: 1 }), newScene());
  });

  test("v: 2 is an error, not an empty map", () => {
    assertSceneError(() => parseScene({ ...example, v: 2 }), "version");
  });

  test("a missing or non-numeric version is a format error", () => {
    assertSceneError(() => parseScene({ cells: {} }), "format");
    assertSceneError(() => parseScene({ v: "1" }), "format");
    assertSceneError(() => parseScene({ v: 0 }), "format");
  });

  test("something other than an object is a format error", () => {
    for (const data of [null, "scene", 1, []]) assertSceneError(() => parseScene(data), "format");
    assertSceneError(() => parseScene({ v: 1, cells: [] }), "format");
  });

  test("an unknown collection is rejected", () => {
    assertSceneError(() => parseScene({ v: 1, walls: {} }), "collection");
    assertSceneError(() => parseScene(JSON.parse('{"v":1,"__proto__":{}}')), "collection");
  });

  test("key 99999,0 is rejected", () => {
    assertSceneError(() => parseScene({ v: 1, cells: { "99999,0": "floor" } }), "key");
    assertSceneError(() => validatePatch([["cells", "99999,0", "floor"]]), "key");
  });

  test("keys follow the pattern of their collection", () => {
    const bad: [string, string, unknown][] = [
      ["cells", "1;2", "floor"],
      ["cells", "1.5,2", "floor"],
      ["rooms", "h:1,2", 1],
      ["revealed", "a,b", 1],
      ["edges", "1,2", "wall"],
      ["edges", "d:1,2", "wall"],
      ["edges", "h:10000,0", "wall"],
      ["objects", "O1", { type: "pillar" }],
      ["tokens", "t-1", {}],
      ["marks", "m1234567890123", {}],
      ["settings", "color", "red"],
    ];
    for (const op of bad) assertSceneError(() => validatePatch([op]), "key");
    validatePatch([
      ["cells", "-9999,9999", "floor"],
      ["edges", "v:-1,0", "wall"],
      ["tokens", "abc123def456", {}],
    ]);
  });

  test("cell values come only from the terrain list", () => {
    for (const terrain of TERRAIN) validatePatch([["cells", "0,0", terrain.id]]);
    for (const value of ["marble", 1, true, {}]) assertSceneError(() => validatePatch([["cells", "0,0", value]]), "value");
  });

  test("edge values come only from the edge types", () => {
    for (const type of EDGE_TYPES) validatePatch([["edges", "h:0,0", type]]);
    for (const value of ["portal", "Wall", 1, true, {}]) assertSceneError(() => validatePatch([["edges", "h:0,0", value]]), "value");
    assertSceneError(() => parseScene({ v: 1, edges: { "v:1,1": "gate" } }), "value");
  });

  test("a room cell holds 1", () => {
    validatePatch([["rooms", "0,0", 1]]);
    for (const value of [0, 2, "1", true, {}]) assertSceneError(() => validatePatch([["rooms", "0,0", value]]), "value");
    assertSceneError(() => parseScene({ v: 1, rooms: { "0,0": 3 } }), "value");
  });

  test("settings: diagonal rule, name up to 40 characters, fog flag", () => {
    validatePatch([["settings", "diagonal", "5-10-5"], ["settings", "name", "я".repeat(40)], ["settings", "fog", true]]);
    assertSceneError(() => validatePatch([["settings", "diagonal", "10"]]), "value");
    assertSceneError(() => validatePatch([["settings", "name", "я".repeat(41)]]), "value");
    assertSceneError(() => validatePatch([["settings", "name", 5]]), "value");
    assertSceneError(() => validatePatch([["settings", "fog", "yes"]]), "value");
  });

  test("objects, tokens and marks hold objects", () => {
    for (const name of ["objects", "tokens", "marks"]) {
      for (const value of ["x", 1, []]) assertSceneError(() => validatePatch([[name, "a1", value]]), "value");
    }
  });

  test("null is a deletion in a patch but not a stored value", () => {
    validatePatch([["cells", "0,0", null], ["settings", "name", null]]);
    assertSceneError(() => parseScene({ v: 1, cells: { "0,0": null } }), "value");
  });

  test("a malformed patch is a format or collection error", () => {
    assertSceneError(() => validatePatch({}), "format");
    assertSceneError(() => validatePatch([["cells", "0,0"]]), "format");
    assertSceneError(() => validatePatch([["walls", "0,0", "floor"]]), "collection");
    assertSceneError(() => validatePatch([["cells", 5, "floor"]]), "key");
  });
});

// ---- patches of the drawing tools (plan 5.5, 8.2) ----

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
    assert.deepEqual(enclosePatch(scene, { x: 10, y: 10 }), []);
    assert.deepEqual(scene, before);
  });

  test("walls in the region of the same terrain connected through sides and keeps a door", () => {
    const scene = newScene();
    paint(scene, rect(0, 0, 4, 4), "floor");
    paint(scene, [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 3 }], "grass"); // 0,3 touches only by a corner
    applyPatch(scene, [["edges", "v:1,1", "door"]]);
    const patch = enclosePatch(scene, { x: 2, y: 1 });
    assert.ok(patch);
    assert.deepEqual(
      patch.map((op) => op[1]).sort(),
      ["h:1,1", "h:2,1", "v:3,1", "h:2,2", "v:2,2", "h:1,3", "v:1,2"].sort(),
    );
    assert.ok(patch.every((op) => op[0] === "edges" && op[2] === "wall"));
  });

  test("a region larger than the limit gives null; one at the limit is walled in", () => {
    const side = Math.sqrt(ENCLOSE_LIMIT);
    const scene = newScene();
    paint(scene, rect(0, 0, side, side), "grass");
    assert.equal(enclosePatch(scene, { x: 5, y: 5 })?.length, 4 * side);
    paint(scene, rect(side, 0, 1, 1), "grass");
    assert.equal(enclosePatch(scene, { x: 5, y: 5 }), null);
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
