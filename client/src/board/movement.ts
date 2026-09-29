// Movement cost of a dragged token and straight distances for the ruler (plan 5.6, canon-5e.md
// «Клетка и диагонали», «Трудная местность и особое движение»). No DOM, no storage.

import { costsExtraToEnter } from "./catalog.ts";
import { cellKey } from "./geometry.ts";
import type { Point } from "./geometry.ts";
import type { DiagonalRule } from "./store.ts";

export const FEET_PER_CELL = 5;

/**
 * Cells from `from` (excluded) to `to` (included), each a step to a neighbour, diagonals included:
 * a jump of the pointer over several cells is filled in along the straight line between them.
 */
export function stepsBetween(from: Point, to: Point): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const count = Math.max(Math.abs(dx), Math.abs(dy));
  const steps: Point[] = [];
  for (let i = 1; i <= count; i++) {
    steps.push({ x: from.x + Math.round((dx * i) / count) + 0, y: from.y + Math.round((dy * i) / count) + 0 });
  }
  return steps;
}

/**
 * The path of a dragged token after the pointer reaches `target` (Р40): the steps to it are added one by one,
 * and a step onto a place already on the path cuts the path back to that place, so going back costs nothing.
 * Returns a new path; `path` must hold at least the starting place.
 */
export function extendPath(path: readonly Point[], target: Point): Point[] {
  const next = [...path];
  for (const step of stepsBetween(next[next.length - 1], target)) {
    const seen = next.findIndex((place) => place.x === step.x && place.y === step.y);
    if (seen >= 0) next.length = seen + 1;
    else next.push(step);
  }
  return next;
}

/**
 * Feet spent along a path of places, `path[0]` the starting one; a place is the top-left cell of a space
 * of `span` × `span` cells, and each next place is a step to a neighbour. A step costs 5 ft; a diagonal
 * step 5 ft by the core rule, and by the 5/10/5 rule every second diagonal of the whole path costs 10 ft.
 * Entering a place with difficult terrain or deep water in at least one of its cells costs 5 ft more,
 * once however many such cells there are (causes do not stack). Walls, chasm and rock stop nothing.
 */
export function pathCost(cells: Readonly<Record<string, unknown>>, path: readonly Point[], span: number, rule: DiagonalRule): number {
  let feet = 0;
  let diagonals = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i].x - path[i - 1].x);
    const dy = Math.abs(path[i].y - path[i - 1].y);
    if (dx > 1 || dy > 1 || dx + dy === 0) throw new Error("a path step must go to a neighbouring cell");
    if (dx === 1 && dy === 1) {
      diagonals++;
      feet += rule === "5-10-5" && diagonals % 2 === 0 ? 2 * FEET_PER_CELL : FEET_PER_CELL;
    } else {
      feet += FEET_PER_CELL;
    }
    if (placeCostsExtra(cells, path[i], span)) feet += FEET_PER_CELL;
  }
  return feet;
}

function placeCostsExtra(cells: Readonly<Record<string, unknown>>, place: Point, span: number): boolean {
  for (let y = place.y; y < place.y + span; y++) {
    for (let x = place.x; x < place.x + span; x++) {
      if (costsExtraToEnter(cells[cellKey(x, y)])) return true;
    }
  }
  return false;
}

export interface Distance {
  feet: number;
  /** Cells of the path by either rule: `max(dx, dy)` (Р40). */
  cells: number;
}

/**
 * Straight distance between two cells: by the core rule `max(dx, dy) × 5` ft,
 * by the 5/10/5 rule `(max(dx, dy) + floor(min(dx, dy) / 2)) × 5` ft (canon-5e.md).
 */
export function distance(from: Point, to: Point, rule: DiagonalRule): Distance {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const cells = Math.max(dx, dy);
  const extra = rule === "5-10-5" ? Math.floor(Math.min(dx, dy) / 2) : 0;
  return { feet: (cells + extra) * FEET_PER_CELL, cells };
}
