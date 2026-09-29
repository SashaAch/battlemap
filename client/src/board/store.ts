// Scene state, patches, undo and redo, validation (plan 5.2, 6.1, 6.2),
// and the patches of the drawing tools (plan 5.5). No DOM, no storage.

import { isEdgeType, isTerrainId } from "./catalog.ts";
import type { EdgeType, TerrainId } from "./catalog.ts";
import {
  boundaryEdges,
  cellEdges,
  cellKey,
  cellsOfSquare,
  connectedRegion,
  innerEdges,
  isEdgeInRange,
} from "./geometry.ts";
import type { CellSquare, Point } from "./geometry.ts";

const SCENE_VERSION = 1;
/** The value of a cell in `rooms` (plan 6.1). */
const ROOM = 1;

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

// Values of revealed are checked by the stage that introduces them.
function checkValue(collection: CollectionName, key: string, value: unknown): void {
  let valid = true;
  if (collection === "settings") valid = SETTING_IS_VALID[key](value);
  else if (collection === "cells") valid = isTerrainId(value);
  else if (collection === "rooms") valid = value === ROOM;
  else if (collection === "edges") valid = isEdgeType(value);
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

// ---- patches of the drawing tools (plan 5.5), built from the scene as it is; they change only what differs ----

/** Shift+click with walls encloses at most this many cells, so a click on a huge field cannot hang the page. */
export const ENCLOSE_LIMIT = 10_000;

/** What the eraser takes: everything, terrain (with the room marks), walls and openings, objects and pencil marks. */
export const ERASE_FILTERS = ["all", "terrain", "walls", "items"] as const;
export type EraseFilter = (typeof ERASE_FILTERS)[number];

/** Fill: the cells get the terrain. */
export function fillPatch(scene: Scene, cells: readonly Point[], terrain: TerrainId): Patch {
  const patch: Patch = [];
  for (const { x, y } of cells) {
    const key = cellKey(x, y);
    if (scene.cells[key] !== terrain) patch.push(["cells", key, terrain]);
  }
  return patch;
}

/**
 * Room: the cells get the terrain and the room mark, walls between them go. On the boundary an edge
 * whose inner cell was already a room stays as it is (rooms merge); any other bare edge gets a wall.
 */
export function roomPatch(scene: Scene, cells: readonly Point[], terrain: TerrainId): Patch {
  const patch = fillPatch(scene, cells, terrain);
  for (const { x, y } of cells) {
    const key = cellKey(x, y);
    if (scene.rooms[key] !== ROOM) patch.push(["rooms", key, ROOM]);
  }
  for (const key of innerEdges(cells)) {
    if (scene.edges[key] === "wall") patch.push(["edges", key, null]);
  }
  for (const { key, inner } of boundaryEdges(cells)) {
    if (!isEdgeInRange(key) || Object.hasOwn(scene.rooms, cellKey(inner.x, inner.y)) || Object.hasOwn(scene.edges, key)) continue;
    patch.push(["edges", key, "wall"]);
  }
  return patch;
}

/** Walls: the edges get the type. */
export function edgesPatch(scene: Scene, keys: readonly string[], type: EdgeType): Patch {
  const patch: Patch = [];
  for (const key of new Set(keys)) {
    if (isEdgeInRange(key) && scene.edges[key] !== type) patch.push(["edges", key, type]);
  }
  return patch;
}

/**
 * Shift+click with walls: walls on the bare boundary edges of the region of the same terrain
 * around `cell`, connected through sides. An empty cell gives nothing (the void is endless);
 * null when the region is larger than ENCLOSE_LIMIT.
 */
export function enclosePatch(scene: Scene, cell: Point): Patch | null {
  const terrain = scene.cells[cellKey(cell.x, cell.y)];
  if (terrain === undefined) return [];
  const region = connectedRegion(cell, (x, y) => scene.cells[cellKey(x, y)] === terrain, ENCLOSE_LIMIT);
  if (!region) return null;
  const patch: Patch = [];
  for (const { key } of boundaryEdges(region)) {
    if (isEdgeInRange(key) && !Object.hasOwn(scene.edges, key)) patch.push(["edges", key, "wall"]);
  }
  return patch;
}

function isInSquare(square: CellSquare, x: unknown, y: unknown): boolean {
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    x >= square.x &&
    x < square.x + square.size &&
    y >= square.y &&
    y < square.y + square.size
  );
}

/** A pencil mark is under the eraser when any of its points is. */
function isMarkInSquare(square: CellSquare, mark: unknown): boolean {
  if (!isPlainObject(mark) || !Array.isArray(mark.pts)) return false;
  return mark.pts.some((point: unknown) => Array.isArray(point) && isInSquare(square, point[0], point[1]));
}

/**
 * Eraser: takes from the square what the filter names. Walls are the sides of its cells, the outline included;
 * an object goes when its cell is inside, a pencil mark when any of its points is. Tokens are not erased.
 */
export function erasePatch(scene: Scene, square: CellSquare, filter: EraseFilter): Patch {
  const patch: Patch = [];
  const remove = (collection: CollectionName, key: string): void => {
    if (Object.hasOwn(scene[collection], key)) patch.push([collection, key, null]);
  };
  const cells = cellsOfSquare(square);
  if (filter === "all" || filter === "terrain") {
    for (const { x, y } of cells) {
      remove("cells", cellKey(x, y));
      remove("rooms", cellKey(x, y));
    }
  }
  if (filter === "all" || filter === "walls") {
    for (const key of new Set(cells.flatMap(({ x, y }) => cellEdges(x, y)))) remove("edges", key);
  }
  if (filter === "all" || filter === "items") {
    for (const [id, item] of Object.entries(scene.objects)) {
      if (isPlainObject(item) && isInSquare(square, item.x, item.y)) remove("objects", id);
    }
    for (const [id, mark] of Object.entries(scene.marks)) {
      if (isMarkInSquare(square, mark)) remove("marks", id);
    }
  }
  return patch;
}
