// Scene state, patches, undo and redo, validation (plan 5.2, 6.1, 6.2). No DOM, no storage.

import { isTerrainId } from "./catalog.ts";

const SCENE_VERSION = 1;

export const COLLECTIONS = ["settings", "cells", "rooms", "edges", "objects", "tokens", "marks", "revealed"] as const;
type CollectionName = (typeof COLLECTIONS)[number];

export type Scene = { v: typeof SCENE_VERSION } & Record<CollectionName, Record<string, unknown>>;

/** One change: `[collection, key, value]`; value `null` deletes the entry. */
export type PatchOp = [CollectionName, string, unknown];
export type Patch = PatchOp[];

export interface History {
  /** Inverse patches of applied changes, the last one is undone first. */
  undo: Patch[];
  /** Inverse patches of undone changes, the last one is redone first. */
  redo: Patch[];
  /** Inverses of the patches of an unfinished change, null when no change is open. */
  open: Patch[] | null;
}

type SceneErrorCode = "version" | "format" | "collection" | "key" | "value";

export class SceneError extends Error {
  readonly code: SceneErrorCode;

  constructor(code: SceneErrorCode, message: string) {
    super(message);
    this.name = "SceneError";
    this.code = code;
  }
}

const DIAGONAL_RULES = ["5", "5-10-5"] as const;
const SCENE_NAME_MAX = 40;

const CELL_KEY = /^-?\d{1,4},-?\d{1,4}$/;
const EDGE_KEY = /^[hv]:-?\d{1,4},-?\d{1,4}$/;
const OBJECT_KEY = /^[a-z0-9]{1,12}$/;

const KEY_PATTERN: Record<Exclude<CollectionName, "settings">, RegExp> = {
  cells: CELL_KEY,
  rooms: CELL_KEY,
  revealed: CELL_KEY,
  edges: EDGE_KEY,
  objects: OBJECT_KEY,
  tokens: OBJECT_KEY,
  marks: OBJECT_KEY,
};

const SETTING_IS_VALID: Record<string, (value: unknown) => boolean> = {
  name: (v) => typeof v === "string" && [...v].length <= SCENE_NAME_MAX,
  diagonal: (v) => (DIAGONAL_RULES as readonly unknown[]).includes(v),
  fog: (v) => typeof v === "boolean",
};

export function newScene(): Scene {
  return {
    v: SCENE_VERSION,
    settings: {},
    cells: {},
    rooms: {},
    edges: {},
    objects: {},
    tokens: {},
    marks: {},
    revealed: {},
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCollectionName(value: unknown): value is CollectionName {
  return (COLLECTIONS as readonly unknown[]).includes(value);
}

function checkKey(collection: CollectionName, key: string): void {
  const valid = collection === "settings" ? Object.hasOwn(SETTING_IS_VALID, key) : KEY_PATTERN[collection].test(key);
  if (!valid) throw new SceneError("key", `bad key ${JSON.stringify(key)} in ${collection}`);
}

// Values of rooms, edges and revealed are checked by the stages that introduce them.
function checkValue(collection: CollectionName, key: string, value: unknown): void {
  let valid = true;
  if (collection === "settings") valid = SETTING_IS_VALID[key](value);
  else if (collection === "cells") valid = isTerrainId(value);
  else if (collection === "objects" || collection === "tokens" || collection === "marks") valid = isPlainObject(value);
  if (!valid) throw new SceneError("value", `bad value for ${collection} ${key}`);
}

/** Validates an untrusted patch; throws SceneError on the first problem. */
export function validatePatch(patch: unknown): Patch {
  if (!Array.isArray(patch)) throw new SceneError("format", "patch is not a list");
  for (const op of patch) {
    if (!Array.isArray(op) || op.length !== 3) throw new SceneError("format", "patch entry is not a triple");
    const [collection, key, value] = op;
    if (!isCollectionName(collection)) throw new SceneError("collection", `unknown collection ${String(collection)}`);
    if (typeof key !== "string") throw new SceneError("key", "key is not a string");
    checkKey(collection, key);
    if (value !== null) checkValue(collection, key, value);
  }
  return patch as Patch;
}

/**
 * Validates the whole patch, then applies it to the scene in order.
 * Returns the inverse patch: applying it restores the scene exactly.
 */
export function applyPatch(scene: Scene, patch: Patch): Patch {
  validatePatch(patch);
  const inverse: Patch = [];
  for (const [collection, key, value] of patch) {
    const entries = scene[collection];
    inverse.push([collection, key, Object.hasOwn(entries, key) ? entries[key] : null]);
    if (value === null) delete entries[key];
    else entries[key] = value;
  }
  return inverse.reverse();
}

/**
 * Joins inverses of patches applied one after another (first to last)
 * into a single inverse that restores the state before the first one.
 */
export function mergeInverses(inverses: readonly Patch[]): Patch {
  const merged = new Map<string, PatchOp>();
  for (let i = inverses.length - 1; i >= 0; i--) {
    for (const op of inverses[i]) merged.set(`${op[0]}\u0000${op[1]}`, op);
  }
  return [...merged.values()];
}

/** Reads a scene from untrusted data (plan 6.1, 6.2); throws SceneError. */
export function parseScene(data: unknown): Scene {
  if (!isPlainObject(data)) throw new SceneError("format", "scene is not an object");
  const { v } = data;
  if (typeof v === "number" && v > SCENE_VERSION) throw new SceneError("version", `scene version ${v} is newer than ${SCENE_VERSION}`);
  if (v !== SCENE_VERSION) throw new SceneError("format", "scene version is missing or invalid");

  const scene = newScene();
  for (const name of Object.keys(data)) {
    if (name === "v") continue;
    if (!isCollectionName(name)) throw new SceneError("collection", `unknown collection ${name}`);
    const entries = data[name];
    if (!isPlainObject(entries)) throw new SceneError("format", `${name} is not an object`);
    for (const [key, value] of Object.entries(entries)) {
      checkKey(name, key);
      if (value === null) throw new SceneError("value", `null value in ${name} ${key}`);
      checkValue(name, key, value);
      scene[name][key] = value;
    }
  }
  return scene;
}

export function newHistory(): History {
  return { undo: [], redo: [], open: null };
}

/**
 * Opens a change built from several patches (a brush stroke from press to release).
 * Until it is finished or cancelled, undo and redo do nothing.
 */
export function beginChange(history: History): void {
  if (history.open) throw new Error("a change is already open");
  history.open = [];
}

export function applyToChange(scene: Scene, history: History, patch: Patch): void {
  if (!history.open) throw new Error("no open change");
  history.open.push(applyPatch(scene, patch));
}

/** Closes the open change as one undo step; returns false if it changed nothing. */
export function finishChange(history: History): boolean {
  if (!history.open) throw new Error("no open change");
  const inverse = mergeInverses(history.open);
  history.open = null;
  if (inverse.length === 0) return false;
  history.undo.push(inverse);
  history.redo.length = 0;
  return true;
}

/** Takes the open change back from the scene without a trace in the history. */
export function cancelChange(scene: Scene, history: History): void {
  if (!history.open) throw new Error("no open change");
  applyPatch(scene, mergeInverses(history.open));
  history.open = null;
}

export function undo(scene: Scene, history: History): boolean {
  if (history.open) return false;
  const inverse = history.undo.pop();
  if (!inverse) return false;
  history.redo.push(applyPatch(scene, inverse));
  return true;
}

export function redo(scene: Scene, history: History): boolean {
  if (history.open) return false;
  const inverse = history.redo.pop();
  if (!inverse) return false;
  history.undo.push(applyPatch(scene, inverse));
  return true;
}
