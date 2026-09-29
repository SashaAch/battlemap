import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EDGE_TYPES, TERRAIN } from "../client/src/board/catalog.ts";
import {
  applyPatch,
  applyToChange,
  beginChange,
  cancelChange,
  COLLECTIONS,
  finishChange,
  mergeInverses,
  newHistory,
  newScene,
  parseScene,
  redo,
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

  test("keys are canonical: no -0, no leading zeros", () => {
    const bad: [string, string, unknown][] = [
      ["cells", "-0,5", "floor"],
      ["cells", "007,1", "floor"],
      ["cells", "1,00", "floor"],
      ["rooms", "0,-0", 1],
      ["edges", "h:-0,0", "wall"],
      ["edges", "v:01,2", "wall"],
    ];
    for (const op of bad) assertSceneError(() => validatePatch([op]), "key");
    assertSceneError(() => parseScene({ v: 1, cells: { "-0,5": "floor" } }), "key");
    validatePatch([
      ["cells", "0,0", "floor"],
      ["cells", "-9999,9999", "floor"],
      ["cells", "10,-100", "floor"],
      ["edges", "v:-1,0", "wall"],
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
