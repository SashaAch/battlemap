// Tokens, objects and pencil marks (plan 8.3).

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addMarkPoint,
  editTokenPatch,
  markPatch,
  moveObjectPatch,
  moveTokenPatch,
  newId,
  objectAt,
  placeObjectPatch,
  placeTokenPatch,
  tokenAt,
  tokenLayout,
  tokenName,
} from "../client/src/board/pieces.ts";
import type { TokenDraft } from "../client/src/board/pieces.ts";
import { applyPatch, applyToChange, beginChange, finishChange, newHistory, newScene, undo, validatePatch } from "../client/src/board/store.ts";
import type { History, Patch, Scene, Token } from "../client/src/board/store.ts";

function commit(scene: Scene, history: History, patch: Patch): void {
  beginChange(history);
  applyToChange(scene, history, patch);
  finishChange(history);
}

const goblin: TokenDraft = { name: "Гоблин", side: "enemies", size: "small" };

/** Places a token through the patch the tokens tool makes; fails the test when it is refused. */
function place(scene: Scene, id: string, draft: TokenDraft, x = 0, y = 0): void {
  const patch = placeTokenPatch(scene, id, draft, { x, y });
  assert.ok(patch, `placing ${id} was refused`);
  applyPatch(scene, patch);
}

const names = (scene: Scene): string[] =>
  Object.values(scene.tokens)
    .map((token) => (token as Token).name)
    .sort();

describe("placing a token", () => {
  test("makes a valid token at the cell with the draft's side, size and name", () => {
    const scene = newScene();
    const patch = placeTokenPatch(scene, "t1", { name: "  Орк ", side: "allies", size: "large" }, { x: 3, y: -2 });
    assert.ok(patch);
    validatePatch(patch);
    assert.deepEqual(patch, [
      ["tokens", "t1", { name: "Орк", side: "allies", size: "large", x: 3, y: -2, hidden: false, vision: null, character: null }],
    ]);
  });

  test("three goblins are called «Гоблин 1..3»", () => {
    const scene = newScene();
    place(scene, "a", goblin);
    assert.deepEqual(names(scene), ["Гоблин"]);
    place(scene, "b", goblin, 1);
    assert.equal((scene.tokens.a as Token).name, "Гоблин 1");
    assert.equal((scene.tokens.b as Token).name, "Гоблин 2");
    place(scene, "c", goblin, 2);
    assert.deepEqual(names(scene), ["Гоблин 1", "Гоблин 2", "Гоблин 3"]);
  });

  test("the renaming and the new token are one undo step", () => {
    const scene = newScene();
    const history = newHistory();
    commit(scene, history, placeTokenPatch(scene, "a", goblin, { x: 0, y: 0 }) ?? []);
    commit(scene, history, placeTokenPatch(scene, "b", goblin, { x: 1, y: 0 }) ?? []);
    assert.deepEqual(names(scene), ["Гоблин 1", "Гоблин 2"]);
    undo(scene, history);
    assert.deepEqual(names(scene), ["Гоблин"]);
  });

  test("a new token takes the smallest free number", () => {
    const scene = newScene();
    for (const id of ["a", "b", "c"]) place(scene, id, goblin);
    applyPatch(scene, [["tokens", "b", null]]);
    place(scene, "d", goblin);
    assert.equal((scene.tokens.d as Token).name, "Гоблин 2");
    place(scene, "e", goblin);
    assert.equal((scene.tokens.e as Token).name, "Гоблин 4");
  });

  test("different names are not numbered, and a name that only starts the same is another name", () => {
    const scene = newScene();
    place(scene, "a", goblin);
    place(scene, "b", { ...goblin, name: "Орк" });
    place(scene, "c", { ...goblin, name: "Гоблин-лучник" });
    assert.deepEqual(names(scene), ["Гоблин", "Гоблин-лучник", "Орк"]);
  });

  test("a typed number is kept while it is free, and a taken one gets the next free number", () => {
    const scene = newScene();
    place(scene, "a", { ...goblin, name: "Гоблин 5" });
    assert.deepEqual(names(scene), ["Гоблин 5"]);
    place(scene, "b", { ...goblin, name: "Гоблин 5" });
    assert.equal((scene.tokens.b as Token).name, "Гоблин 1");
    place(scene, "c", goblin);
    assert.equal((scene.tokens.c as Token).name, "Гоблин 2");
  });

  test("an empty name stays empty and is not numbered", () => {
    const scene = newScene();
    place(scene, "a", { ...goblin, name: " " });
    place(scene, "b", { ...goblin, name: "" });
    assert.deepEqual(names(scene), ["", ""]);
  });

  test("a numbered long name still fits 40 characters", () => {
    const scene = newScene();
    const long = "я".repeat(40);
    place(scene, "a", { ...goblin, name: long });
    place(scene, "b", { ...goblin, name: long });
    place(scene, "c", { ...goblin, name: long });
    assert.deepEqual(names(scene), [`${"я".repeat(38)} 1`, `${"я".repeat(38)} 2`, `${"я".repeat(38)} 3`]);
  });

  test("a space out of the key range puts nothing", () => {
    assert.deepEqual(placeTokenPatch(newScene(), "t1", { ...goblin, size: "huge" }, { x: 9998, y: 0 }), []);
  });
});

describe("tiny tokens", () => {
  const tiny: TokenDraft = { name: "Крыса", side: "neutral", size: "tiny" };

  test("up to four share a cell; the fifth is refused", () => {
    const scene = newScene();
    for (const id of ["a", "b", "c", "d"]) place(scene, id, tiny, 2, 2);
    assert.equal(placeTokenPatch(scene, "e", tiny, { x: 2, y: 2 }), null);
    assert.ok(placeTokenPatch(scene, "e", tiny, { x: 3, y: 2 }));
    assert.ok(placeTokenPatch(scene, "e", { ...tiny, size: "medium" }, { x: 2, y: 2 }), "a bigger token may stand there");
  });

  test("take the quarters of their cell by key order", () => {
    const scene = newScene();
    for (const id of ["d", "b", "c", "a"]) place(scene, id, tiny, 2, 2);
    const squares = Object.fromEntries(tokenLayout(scene).map(({ id, square }) => [id, square]));
    assert.deepEqual(squares.a, { x: 2, y: 2, size: 0.5 });
    assert.deepEqual(squares.b, { x: 2.5, y: 2, size: 0.5 });
    assert.deepEqual(squares.c, { x: 2, y: 2.5, size: 0.5 });
    assert.deepEqual(squares.d, { x: 2.5, y: 2.5, size: 0.5 });
    assert.equal(tokenAt(scene, { x: 2.7, y: 2.2 }), "b");
    assert.equal(tokenAt(scene, { x: 2.2, y: 2.8 }), "c");
  });

  test("a tiny token cannot be moved or resized into a full cell", () => {
    const scene = newScene();
    for (const id of ["a", "b", "c", "d"]) place(scene, id, tiny, 2, 2);
    place(scene, "e", tiny, 3, 3);
    place(scene, "m", { ...goblin, size: "medium" }, 2, 2);
    assert.equal(moveTokenPatch(scene, "e", { x: 2, y: 2 }), null);
    assert.equal(editTokenPatch(scene, "m", { ...goblin, size: "tiny" }), "tinyFull");
    // One of the four stays in its full cell without a change and may leave it.
    assert.deepEqual(moveTokenPatch(scene, "a", { x: 2, y: 2 }), []);
    assert.ok(moveTokenPatch(scene, "a", { x: 4, y: 4 }));
  });
});

describe("moving, editing and finding tokens", () => {
  test("a move changes only the place", () => {
    const scene = newScene();
    place(scene, "a", goblin, 0, 0);
    const patch = moveTokenPatch(scene, "a", { x: -4, y: 7 });
    assert.ok(patch);
    applyPatch(scene, patch);
    assert.deepEqual(scene.tokens.a, { name: "Гоблин", side: "enemies", size: "small", x: -4, y: 7, hidden: false, vision: null, character: null });
    assert.deepEqual(moveTokenPatch(scene, "a", { x: -4, y: 7 }), []);
    assert.deepEqual(moveTokenPatch(scene, "missing", { x: 0, y: 0 }), []);
  });

  test("editing changes side, size and name; a new name is numbered among the others", () => {
    const scene = newScene();
    place(scene, "a", goblin);
    place(scene, "b", { ...goblin, name: "Орк" }, 1);
    const patch = editTokenPatch(scene, "b", { name: "Гоблин", side: "allies", size: "large" });
    assert.ok(Array.isArray(patch));
    applyPatch(scene, patch);
    assert.deepEqual(names(scene), ["Гоблин 1", "Гоблин 2"]);
    const b = scene.tokens.b as Token;
    assert.equal(b.name, "Гоблин 2");
    assert.equal(b.side, "allies");
    assert.equal(b.size, "large");
  });

  test("growing a token past the end of the key range is refused with a reason", () => {
    const scene = newScene();
    place(scene, "a", goblin, 9998, 0);
    assert.equal(editTokenPatch(scene, "a", { ...goblin, size: "huge" }), "outOfRange");
    assert.ok(Array.isArray(editTokenPatch(scene, "a", { ...goblin, size: "large" })));
  });

  test("editing without changes gives nothing and keeps the number", () => {
    const scene = newScene();
    place(scene, "a", goblin);
    place(scene, "b", goblin);
    assert.deepEqual(editTokenPatch(scene, "b", { ...goblin, name: "Гоблин 2" }), []);
  });

  test("the topmost token under a point is found; a Large one covers four cells", () => {
    const scene = newScene();
    place(scene, "big", { ...goblin, size: "large" }, 0, 0);
    place(scene, "small", { ...goblin, name: "Орк" }, 1, 1);
    assert.equal(tokenAt(scene, { x: 0.5, y: 1.5 }), "big");
    assert.equal(tokenAt(scene, { x: 1.5, y: 1.5 }), "small", "the smaller token is drawn and hit on top");
    assert.equal(tokenAt(scene, { x: 2.5, y: 0.5 }), null);
  });

  test("tokenName reports the renames it needs", () => {
    const scene = newScene();
    place(scene, "a", goblin);
    assert.deepEqual(tokenName(scene, "Гоблин"), { name: "Гоблин 2", renames: [["a", "Гоблин 1"]] });
    assert.deepEqual(tokenName(scene, "Гоблин", "a"), { name: "Гоблин", renames: [] });
  });
});

describe("objects", () => {
  test("are put in a cell, not twice of one type, and moved", () => {
    const scene = newScene();
    const patch = placeObjectPatch(scene, "o1", "chest", { x: 1, y: 2 });
    validatePatch(patch);
    applyPatch(scene, patch);
    assert.deepEqual(placeObjectPatch(scene, "o2", "chest", { x: 1, y: 2 }), []);
    applyPatch(scene, placeObjectPatch(scene, "o2", "table", { x: 1, y: 2 }));
    assert.equal(objectAt(scene, { x: 1, y: 2 }), "o2");
    applyPatch(scene, moveObjectPatch(scene, "o2", { x: 5, y: 5 }));
    assert.deepEqual(scene.objects.o2, { type: "table", x: 5, y: 5 });
    assert.equal(objectAt(scene, { x: 1, y: 2 }), "o1");
    assert.equal(objectAt(scene, { x: 0, y: 0 }), null);
    assert.deepEqual(placeObjectPatch(scene, "o3", "pit", { x: 10000, y: 0 }), []);
  });

  test("are not moved onto a cell with one of the same type, as when placing", () => {
    const scene = newScene();
    applyPatch(scene, placeObjectPatch(scene, "o1", "barrel", { x: 0, y: 0 }));
    applyPatch(scene, placeObjectPatch(scene, "o2", "barrel", { x: 1, y: 0 }));
    applyPatch(scene, placeObjectPatch(scene, "o3", "crate", { x: 2, y: 0 }));
    assert.deepEqual(moveObjectPatch(scene, "o2", { x: 0, y: 0 }), []);
    assert.deepEqual(moveObjectPatch(scene, "o2", { x: 2, y: 0 }), [["objects", "o2", { type: "barrel", x: 2, y: 0 }]]);
    assert.deepEqual(moveObjectPatch(scene, "o2", { x: 0, y: 10000 }), []);
  });
});

describe("pencil marks", () => {
  test("points are rounded, thinned and capped at 2000", () => {
    const points: [number, number][] = [];
    addMarkPoint(points, { x: 1.23456, y: -0.004 });
    addMarkPoint(points, { x: 1.25, y: 0 }); // too close to the last one
    addMarkPoint(points, { x: 2, y: 0 });
    addMarkPoint(points, { x: 20000, y: 0 }); // out of range
    assert.deepEqual(points, [
      [1.23, 0],
      [2, 0],
    ]);
    const long: [number, number][] = [];
    for (let i = 0; i < 2500; i++) addMarkPoint(long, { x: i / 5, y: 0 });
    assert.equal(long.length, 2000);
    validatePatch(markPatch("m1", "#2980b9", long));
  });

  test("one line is one mark; an empty line gives nothing", () => {
    const patch = markPatch("m1", "#c0392b", [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(patch, [["marks", "m1", { color: "#c0392b", pts: [[0, 0], [1, 1]] }]]);
    assert.deepEqual(markPatch("m2", "#c0392b", []), []);
  });
});

describe("ids", () => {
  test("fit the key pattern and are not taken", () => {
    assert.match(newId({}, "t"), /^[a-z0-9]{1,12}$/);
    let calls = 0;
    // The first attempt gives the taken t00000000, the second one tiiiiiiii.
    const random = (): number => (calls++ < 8 ? 0 : 0.5);
    assert.equal(newId({ t00000000: 1 }, "t", random), "tiiiiiiii");
  });
});
