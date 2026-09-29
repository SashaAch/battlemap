import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { newScene } from "../client/src/board/store.ts";
import { DRAFT_KEY, openDraft, saveDraft, UNREADABLE_DRAFT_KEY } from "../client/src/draft.ts";
import type { DraftStorage } from "../client/src/draft.ts";

/** In-memory storage; `fail.get` and `fail.set` make the matching calls throw like a blocked or full localStorage. */
function memoryStorage(items: Record<string, string> = {}, fail: { get?: boolean; set?: boolean } = {}) {
  const data = new Map(Object.entries(items));
  const storage: DraftStorage = {
    getItem(key) {
      if (fail.get) throw new Error("storage is disabled");
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (fail.set) throw new Error("quota exceeded");
      data.set(key, value);
    },
  };
  return { storage, data };
}

describe("opening the draft", () => {
  test("no draft gives an empty scene without a notice", () => {
    const { storage } = memoryStorage();
    assert.deepEqual(openDraft(storage), { scene: newScene(), problem: null, canSave: true });
  });

  test("a normal draft is read", () => {
    const scene = newScene();
    scene.cells["3,-2"] = "grass";
    scene.settings.name = "Склеп";
    const { storage, data } = memoryStorage({ [DRAFT_KEY]: JSON.stringify(scene) });
    assert.deepEqual(openDraft(storage), { scene, problem: null, canSave: true });
    assert.equal(data.has(UNREADABLE_DRAFT_KEY), false);
  });

  test("damaged JSON gives an empty scene, a notice and a copy of the text", () => {
    const text = '{"v":1,"cells":';
    const { storage, data } = memoryStorage({ [DRAFT_KEY]: text });
    assert.deepEqual(openDraft(storage), { scene: newScene(), problem: "broken", canSave: true });
    assert.equal(data.get(UNREADABLE_DRAFT_KEY), text);
  });

  test("a scene that fails the checks is damaged too", () => {
    const text = JSON.stringify({ v: 1, cells: { "99999,0": "floor" } });
    const { storage, data } = memoryStorage({ [DRAFT_KEY]: text });
    assert.equal(openDraft(storage).problem, "broken");
    assert.equal(data.get(UNREADABLE_DRAFT_KEY), text);
  });

  test("a v: 2 scene gives an empty scene, a notice and a copy of the text", () => {
    const text = JSON.stringify({ v: 2, cells: { "0,0": "floor" } });
    const { storage, data } = memoryStorage({ [DRAFT_KEY]: text, [UNREADABLE_DRAFT_KEY]: "older copy" });
    assert.deepEqual(openDraft(storage), { scene: newScene(), problem: "newer", canSave: true });
    assert.equal(data.get(UNREADABLE_DRAFT_KEY), text);
  });

  test("the draft key may be overwritten once the copy is made", () => {
    const text = "not json";
    const { storage, data } = memoryStorage({ [DRAFT_KEY]: text });
    const opened = openDraft(storage);
    assert.equal(saveDraft(storage, opened.scene), true);
    assert.deepEqual(JSON.parse(data.get(DRAFT_KEY) ?? ""), newScene());
    assert.equal(data.get(UNREADABLE_DRAFT_KEY), text);
  });

  test("an unreadable draft that cannot be copied must not be overwritten", () => {
    const { storage } = memoryStorage({ [DRAFT_KEY]: "not json" }, { set: true });
    assert.deepEqual(openDraft(storage), { scene: newScene(), problem: "unkept", canSave: false });
  });

  test("storage that throws does not break reading", () => {
    const { storage } = memoryStorage({ [DRAFT_KEY]: JSON.stringify(newScene()) }, { get: true, set: true });
    assert.deepEqual(openDraft(storage), { scene: newScene(), problem: null, canSave: true });
  });
});

describe("saving the draft", () => {
  test("writes the scene as JSON", () => {
    const scene = newScene();
    scene.cells["0,0"] = "lava";
    const { storage, data } = memoryStorage();
    assert.equal(saveDraft(storage, scene), true);
    assert.deepEqual(JSON.parse(data.get(DRAFT_KEY) ?? ""), scene);
  });

  test("reports a refusing storage instead of throwing", () => {
    const { storage } = memoryStorage({}, { set: true });
    assert.equal(saveDraft(storage, newScene()), false);
  });
});
