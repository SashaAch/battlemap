// Tokens, objects and pencil marks (plan 8.3): numbered names, tiny tokens in quarters of a cell,
// hit tests and the patches that place, move, edit and delete them. No DOM, no storage.

import { sizeSpan, TINY_PER_CELL } from "./catalog.ts";
import type { MarkColor, ObjectType, SideId, SizeId } from "./catalog.ts";
import { isCellInRange, isPointInRange } from "./geometry.ts";
import type { CellSquare, Point } from "./geometry.ts";
import { isMapObject, isToken, MARK_POINTS_MAX, TOKEN_NAME_MAX } from "./store.ts";
import type { CollectionName, MapObject, Patch, Scene, Token } from "./store.ts";

/** What the tokens tool puts down and the edit dialog changes. */
export interface TokenDraft {
  name: string;
  side: SideId;
  size: SizeId;
}

const ID_LENGTH = 8;

/** A random id of `prefix` and base-36 characters that is not a key of `entries` (keys match ^[a-z0-9]{1,12}$). */
export function newId(entries: Readonly<Record<string, unknown>>, prefix: string, random: () => number = Math.random): string {
  for (;;) {
    let id = prefix;
    while (id.length < prefix.length + ID_LENGTH) id += Math.floor(random() * 36).toString(36);
    if (!Object.hasOwn(entries, id)) return id;
  }
}

// ---- names ----

/** `base` with the number `n`, the base cut so the name fits TOKEN_NAME_MAX characters. */
function numbered(base: string, n: number): string {
  const suffix = ` ${n}`;
  return [...base].slice(0, TOKEN_NAME_MAX - suffix.length).join("") + suffix;
}

const NUMBERED = /^(.*\S) ([1-9]\d*)$/;

/**
 * The name for a token named `typed` (trimmed, at most TOKEN_NAME_MAX characters) among the tokens of the
 * scene other than `self`, and the tokens renamed with it. Equal names are numbered: the first «Гоблин»
 * keeps its name; with a second one the first becomes «Гоблин 1» and the new one «Гоблин 2»; the next
 * gets the smallest free number. A typed «Гоблин 5» is kept while no other token is called so.
 */
export function tokenName(scene: Scene, typed: string, self: string | null = null): { name: string; renames: [string, string][] } {
  const name = [...typed.trim()].slice(0, TOKEN_NAME_MAX).join("");
  if (name === "") return { name, renames: [] };
  const base = NUMBERED.exec(name)?.[1] ?? name;
  const bare: string[] = [];
  const used = new Set<number>();
  let taken = false;
  for (const [id, token] of Object.entries(scene.tokens)) {
    if (id === self || !isToken(token)) continue;
    if (token.name === name) taken = true;
    if (token.name === base) {
      bare.push(id);
      continue;
    }
    const match = NUMBERED.exec(token.name);
    if (match && token.name === numbered(base, Number(match[2]))) used.add(Number(match[2]));
  }
  if (base !== name && !taken) return { name, renames: [] };
  if (bare.length === 0 && used.size === 0) return { name, renames: [] };
  let next = 1;
  const nextFree = (): string => {
    while (used.has(next)) next++;
    used.add(next);
    return numbered(base, next);
  };
  const renames = bare.sort().map((id): [string, string] => [id, nextFree()]);
  return { name: nextFree(), renames };
}

// ---- tokens ----

/** Tiny tokens in a cell, by key order; `self` is left out. */
function tinyIdsAt(scene: Scene, x: number, y: number, self: string | null): string[] {
  const ids: string[] = [];
  for (const [id, token] of Object.entries(scene.tokens)) {
    if (id !== self && isToken(token) && token.size === "tiny" && token.x === x && token.y === y) ids.push(id);
  }
  return ids.sort();
}

function renamePatch(scene: Scene, renames: readonly [string, string][]): Patch {
  return renames.map(([id, name]): [CollectionName, string, unknown] => ["tokens", id, { ...(scene.tokens[id] as Token), name }]);
}

/**
 * Puts a new token with its top-left cell at `cell`, numbering equal names in the same patch.
 * Null when the token is tiny and the cell already holds TINY_PER_CELL tiny tokens;
 * empty when the space does not fit the key range.
 */
export function placeTokenPatch(scene: Scene, id: string, draft: TokenDraft, cell: Point): Patch | null {
  if (draft.size === "tiny" && tinyIdsAt(scene, cell.x, cell.y, null).length >= TINY_PER_CELL) return null;
  const { name, renames } = tokenName(scene, draft.name);
  const token: Token = { name, side: draft.side, size: draft.size, x: cell.x, y: cell.y, hidden: false, vision: null, character: null };
  if (!isToken(token)) return [];
  return [...renamePatch(scene, renames), ["tokens", id, token]];
}

/** Moves a token to the place `place`; null when a tiny token meets a full cell, empty when nothing changes. */
export function moveTokenPatch(scene: Scene, id: string, place: Point): Patch | null {
  const token = scene.tokens[id];
  if (!isToken(token) || (token.x === place.x && token.y === place.y)) return [];
  if (token.size === "tiny" && tinyIdsAt(scene, place.x, place.y, id).length >= TINY_PER_CELL) return null;
  const moved: Token = { ...token, x: place.x, y: place.y };
  return isToken(moved) ? [["tokens", id, moved]] : [];
}

/** Why an edit of a token was refused: a tiny token in a full cell, or a space past the end of the key range. */
export type EditRefusal = "tinyFull" | "outOfRange";

/**
 * Changes side, size and name of a token; a changed name is numbered like a new one.
 * Empty when nothing changes or the token is gone.
 */
export function editTokenPatch(scene: Scene, id: string, draft: TokenDraft): Patch | EditRefusal {
  const token = scene.tokens[id];
  if (!isToken(token)) return [];
  if (draft.size === "tiny" && token.size !== "tiny" && tinyIdsAt(scene, token.x, token.y, id).length >= TINY_PER_CELL) return "tinyFull";
  const renamed = draft.name.trim() === token.name ? { name: token.name, renames: [] } : tokenName(scene, draft.name, id);
  const edited: Token = { ...token, name: renamed.name, side: draft.side, size: draft.size };
  // Side and size come from the catalog and the name is cut to fit, so only a space too large for the place can fail.
  if (!isToken(edited)) return "outOfRange";
  const patch = renamePatch(scene, renamed.renames);
  if (edited.name !== token.name || edited.side !== token.side || edited.size !== token.size) patch.push(["tokens", id, edited]);
  return patch;
}

/**
 * The square a token covers in world coordinates. A tiny token takes the quarter of its cell given by its
 * slot: the tiny tokens of one cell by key order fill the top left, top right, bottom left, bottom right.
 */
function tokenSquare(token: Token, slot: number): CellSquare {
  if (token.size !== "tiny") return { x: token.x, y: token.y, size: sizeSpan(token.size) };
  const quarter = slot % TINY_PER_CELL;
  return { x: token.x + (quarter % 2) / 2, y: token.y + Math.floor(quarter / 2) / 2, size: 0.5 };
}

/** Tokens in drawing order, bottom first (larger sizes under smaller ones), with the squares they cover. */
export function tokenLayout(scene: Scene): { id: string; token: Token; square: CellSquare }[] {
  // Tiny slots follow key order within a cell.
  const slots = new Map<string, number>();
  const taken = new Map<string, number>();
  for (const id of Object.keys(scene.tokens).sort()) {
    const token = scene.tokens[id];
    if (!isToken(token) || token.size !== "tiny") continue;
    const cell = `${token.x},${token.y}`;
    const slot = taken.get(cell) ?? 0;
    taken.set(cell, slot + 1);
    slots.set(id, slot);
  }
  const layout: { id: string; token: Token; square: CellSquare }[] = [];
  for (const [id, token] of Object.entries(scene.tokens)) {
    if (isToken(token)) layout.push({ id, token, square: tokenSquare(token, slots.get(id) ?? 0) });
  }
  // A stable sort keeps the order of placing among tokens of one size.
  return layout.sort((a, b) => b.square.size - a.square.size);
}

function isInSquare(square: CellSquare, world: Point): boolean {
  return world.x >= square.x && world.x < square.x + square.size && world.y >= square.y && world.y < square.y + square.size;
}

/** The topmost token under a world point, or null. */
export function tokenAt(scene: Scene, world: Point): string | null {
  const layout = tokenLayout(scene);
  for (let i = layout.length - 1; i >= 0; i--) if (isInSquare(layout[i].square, world)) return layout[i].id;
  return null;
}

// ---- objects ----

/** The last object in a cell, or null. */
export function objectAt(scene: Scene, cell: Point): string | null {
  let found: string | null = null;
  for (const [id, item] of Object.entries(scene.objects)) {
    if (isMapObject(item) && item.x === cell.x && item.y === cell.y) found = id;
  }
  return found;
}

/** Whether a cell is out of range or already holds an object of the type other than `self`. */
function isObjectCellTaken(scene: Scene, type: ObjectType, cell: Point, self: string | null): boolean {
  if (!isCellInRange(cell.x, cell.y)) return true;
  return Object.entries(scene.objects).some(
    ([id, item]) => id !== self && isMapObject(item) && item.type === type && item.x === cell.x && item.y === cell.y,
  );
}

/** Puts an object in a cell; empty when the cell already holds one of that type or is out of range. */
export function placeObjectPatch(scene: Scene, id: string, type: ObjectType, cell: Point): Patch {
  if (isObjectCellTaken(scene, type, cell, null)) return [];
  const item: MapObject = { type, x: cell.x, y: cell.y };
  return [["objects", id, item]];
}

/** Moves an object to a cell; empty, as when placing, when the cell holds one of that type or is out of range. */
export function moveObjectPatch(scene: Scene, id: string, cell: Point): Patch {
  const item = scene.objects[id];
  if (!isMapObject(item) || (item.x === cell.x && item.y === cell.y) || isObjectCellTaken(scene, item.type, cell, id)) return [];
  return [["objects", id, { ...item, x: cell.x, y: cell.y }]];
}

// ---- pencil marks ----

/** Points of a mark closer than this to the last kept one are dropped, in cells. */
const MARK_STEP = 0.08;
const MARK_PRECISION = 100;

const round = (v: number): number => Math.round(v * MARK_PRECISION) / MARK_PRECISION + 0;

/**
 * Adds a world point to the points of a mark being drawn, rounded to hundredths of a cell; skips it when it is
 * too close to the last one, out of range, or the mark already has MARK_POINTS_MAX points.
 */
export function addMarkPoint(points: [number, number][], world: Point): void {
  if (points.length >= MARK_POINTS_MAX || !isPointInRange(world.x, world.y)) return;
  const last = points[points.length - 1];
  if (last && Math.hypot(world.x - last[0], world.y - last[1]) < MARK_STEP) return;
  points.push([round(world.x), round(world.y)]);
}

export function markPatch(id: string, color: MarkColor, points: readonly [number, number][]): Patch {
  return points.length === 0 ? [] : [["marks", id, { color, pts: points.map(([x, y]) => [x, y]) }]];
}
