// Patches of the drawing tools (plan 5.5): fill, room, walls, Shift+click with walls, eraser.
// Built from the scene as it is, they change only what differs. No DOM, no storage.

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
import { isPlainObject, ROOM } from "./store.ts";
import type { CollectionName, Patch, Scene } from "./store.ts";

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
 * Shift+click with walls: the selected edge type on the boundary of the region of the same terrain
 * around `cell`, connected through sides. Bare edges and walls get the type; doors, windows and other
 * openings already there stay. An empty cell gives nothing (the void is endless);
 * null when the region is larger than ENCLOSE_LIMIT.
 */
export function enclosePatch(scene: Scene, cell: Point, type: EdgeType): Patch | null {
  const terrain = scene.cells[cellKey(cell.x, cell.y)];
  if (terrain === undefined) return [];
  const region = connectedRegion(cell, (x, y) => scene.cells[cellKey(x, y)] === terrain, ENCLOSE_LIMIT);
  if (!region) return null;
  const patch: Patch = [];
  for (const { key } of boundaryEdges(region)) {
    const current = scene.edges[key];
    if (isEdgeInRange(key) && (current === undefined || current === "wall") && current !== type) patch.push(["edges", key, type]);
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
