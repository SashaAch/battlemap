// Grid geometry: screen and world coordinates, cells and keys. No DOM, no storage.
// World units are cells: cell x,y covers [x, x+1) × [y, y+1), the y axis points down.

export interface Point {
  x: number;
  y: number;
}

/** `x`,`y` is the world point at the top-left corner of the screen; `scale` is pixels per cell. */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** A square of cells: top-left cell and side length in cells. */
export interface CellSquare {
  x: number;
  y: number;
  size: number;
}

export const MIN_SCALE = 8;
export const MAX_SCALE = 160;
export const DEFAULT_SCALE = 40;
/** Largest absolute cell coordinate that fits the key format `-?\d{1,4}` (plan 6.2). */
const MAX_COORD = 9999;

export function screenToWorld(camera: Camera, screen: Point): Point {
  return { x: camera.x + screen.x / camera.scale, y: camera.y + screen.y / camera.scale };
}

export function worldToScreen(camera: Camera, world: Point): Point {
  return { x: (world.x - camera.x) * camera.scale, y: (world.y - camera.y) * camera.scale };
}

/** The cell containing a world point. `+ 0` turns -0 into 0. */
export function cellAt(world: Point): Point {
  return { x: Math.floor(world.x) + 0, y: Math.floor(world.y) + 0 };
}

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseCellKey(key: string): Point {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

export function isCellInRange(x: number, y: number): boolean {
  return Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD;
}

/** Scales the camera by `factor` keeping the world point under `screen` in place. */
export function zoomAt(camera: Camera, screen: Point, factor: number): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.scale * factor));
  const anchor = screenToWorld(camera, screen);
  return { x: anchor.x - screen.x / scale, y: anchor.y - screen.y / scale, scale };
}

/** Moves the map together with a pointer dragged by `dx`,`dy` screen pixels. */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale, scale: camera.scale };
}

/**
 * The brush square of `size` cells centred on a world point:
 * odd sizes centre on the cell under the point, even sizes on the nearest grid corner.
 */
export function brushSquare(world: Point, size: number): CellSquare {
  const offset = 0.5 - size / 2;
  return { x: Math.floor(world.x + offset) + 0, y: Math.floor(world.y + offset) + 0, size };
}

export function cellsOfSquare(square: CellSquare): Point[] {
  const cells: Point[] = [];
  for (let y = square.y; y < square.y + square.size; y++) {
    for (let x = square.x; x < square.x + square.size; x++) cells.push({ x, y });
  }
  return cells;
}

/** Points from `from` (excluded) to `to` (included), no more than `step` apart. */
export function pointsAlong(from: Point, to: Point, step: number): Point[] {
  const count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
  const points: Point[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return points;
}
