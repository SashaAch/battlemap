// Grid geometry: screen and world coordinates, cells, edges and keys, outlines. No DOM, no storage.
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

/** The fields of a wheel event that tell a mouse wheel from a trackpad. */
interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  deltaMode: number;
  ctrlKey: boolean;
}

// A mouse wheel notch is a whole pixel step of at least this size on one axis; trackpads send smaller or fractional steps.
const MOUSE_WHEEL_MIN_STEP_PX = 50;

/**
 * Guesses the gesture behind a wheel event: a mouse wheel and a trackpad pinch
 * (sent with Ctrl) zoom, a two-finger trackpad scroll pans.
 */
export function wheelGesture(input: WheelInput): "zoom" | "pan" {
  if (input.ctrlKey) return "zoom";
  if (input.deltaMode !== 0) return "zoom";
  if (input.deltaX !== 0) return "pan";
  const step = Math.abs(input.deltaY);
  return Number.isInteger(step) && step >= MOUSE_WHEEL_MIN_STEP_PX ? "zoom" : "pan";
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

// ---- edges and outlines (plan 5.5) ----
// Vertex x,y is the top-left corner of cell x,y. Edge `h:x,y` runs from vertex x,y to x+1,y (the top of cell x,y),
// edge `v:x,y` from vertex x,y to x,y+1 (the left of cell x,y).

type EdgeDir = "h" | "v";

/** A parsed edge key: direction and the vertex it starts from. */
export interface GridEdge {
  dir: EdgeDir;
  x: number;
  y: number;
}

/** An edge between a cell of a set and a cell outside it; `inner` is the cell inside the set. */
export interface BoundaryEdge {
  key: string;
  inner: Point;
}

/** Outlines with a smaller area inside are taken for a click on the cell under the pointer. */
const CLICK_AREA = 0.5;
/** Distance between the lines along which the area inside an outline is summed, in cells. */
const AREA_STEP = 1 / 16;

export function edgeKey(dir: EdgeDir, x: number, y: number): string {
  return `${dir}:${x + 0},${y + 0}`;
}

export function parseEdgeKey(key: string): GridEdge {
  const { x, y } = parseCellKey(key.slice(2));
  return { dir: key[0] === "h" ? "h" : "v", x, y };
}

/** Whether an edge key fits the key format; the bottom and right sides of the last cells do not. */
export function isEdgeInRange(key: string): boolean {
  const { x, y } = parseEdgeKey(key);
  return isCellInRange(x, y);
}

/** The four sides of a cell with the neighbour across each: top, right, bottom, left. */
function sidesOf(x: number, y: number): [string, Point][] {
  return [
    [edgeKey("h", x, y), { x, y: y - 1 }],
    [edgeKey("v", x + 1, y), { x: x + 1, y }],
    [edgeKey("h", x, y + 1), { x, y: y + 1 }],
    [edgeKey("v", x, y), { x: x - 1, y }],
  ];
}

/** The four sides of a cell: top, right, bottom, left. */
export function cellEdges(x: number, y: number): string[] {
  return sidesOf(x, y).map(([key]) => key);
}

/** Edges between a cell of the set and a cell outside it, once each. */
export function boundaryEdges(cells: readonly Point[]): BoundaryEdge[] {
  const inside = new Set(cells.map((c) => cellKey(c.x, c.y)));
  const edges: BoundaryEdge[] = [];
  for (const cell of cells) {
    for (const [key, across] of sidesOf(cell.x, cell.y)) {
      if (!inside.has(cellKey(across.x, across.y))) edges.push({ key, inner: cell });
    }
  }
  return edges;
}

/** Edges between two cells of the set, once each. */
export function innerEdges(cells: readonly Point[]): string[] {
  const inside = new Set(cells.map((c) => cellKey(c.x, c.y)));
  const edges: string[] = [];
  for (const { x, y } of cells) {
    // Each inner edge is the top or the left side of exactly one cell of the set.
    if (inside.has(cellKey(x, y - 1))) edges.push(edgeKey("h", x, y));
    if (inside.has(cellKey(x - 1, y))) edges.push(edgeKey("v", x, y));
  }
  return edges;
}

/**
 * x of every crossing of the closed outline with the horizontal line at `y`, sorted;
 * a vertex on the line counts once. By the even-odd rule, the stretches between crossings 0-1, 2-3, … are inside.
 */
function crossingsAt(points: readonly Point[], y: number): number[] {
  const crossings: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a.y > y !== b.y > y) crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  return crossings.sort((p, q) => p - q);
}

/**
 * Whether the area inside the outline by the even-odd rule reaches `area`. The area is summed along
 * horizontal lines AREA_STEP apart on a fixed grid, so the loops of a figure eight add up instead of
 * cancelling out, and the sum stops as soon as it is enough.
 */
function evenOddAreaReaches(points: readonly Point[], minY: number, maxY: number, area: number): boolean {
  let sum = 0;
  for (let k = Math.floor(minY / AREA_STEP); (k + 0.5) * AREA_STEP < maxY; k++) {
    const crossings = crossingsAt(points, (k + 0.5) * AREA_STEP);
    for (let i = 0; i + 1 < crossings.length; i += 2) sum += (crossings[i + 1] - crossings[i]) * AREA_STEP;
    if (sum >= area) return true;
  }
  return false;
}

/**
 * Cells whose centre lies inside the outline drawn through `points` and closed back to the first point,
 * by the even-odd rule. An outline with no cell inside or with less than half a cell of area inside
 * is a click: the cell under the last point. Cells outside the key range are left out.
 */
export function outlineCells(points: readonly Point[]): Point[] {
  if (points.length === 0) return [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const cells: Point[] = [];
  for (let y = Math.floor(minY); y < maxY; y++) {
    const crossings = crossingsAt(points, y + 0.5);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      // Cells whose centre x + 0.5 lies strictly between two crossings.
      for (let x = Math.ceil(crossings[i] - 0.5); x + 0.5 < crossings[i + 1]; x++) {
        if (x + 0.5 > crossings[i] && isCellInRange(x, y)) cells.push({ x: x + 0, y: y + 0 });
      }
    }
  }
  if (cells.length > 0 && evenOddAreaReaches(points, minY, maxY, CLICK_AREA)) return cells;
  const cell = cellAt(points[points.length - 1]);
  return isCellInRange(cell.x, cell.y) ? [cell] : [];
}

/** The grid vertex nearest to a world point. */
export function snapToVertex(world: Point): Point {
  return { x: Math.round(world.x) + 0, y: Math.round(world.y) + 0 };
}

/**
 * Edges joining vertex `from` to vertex `to`: a straight run along a grid line,
 * or steps that follow the line between them, one edge per unit of x and of y.
 */
export function edgesBetween(from: Point, to: Point): string[] {
  const nx = Math.abs(to.x - from.x);
  const ny = Math.abs(to.y - from.y);
  const sx = Math.sign(to.x - from.x);
  const sy = Math.sign(to.y - from.y);
  const edges: string[] = [];
  let { x, y } = from;
  for (let i = 0, j = 0; i < nx || j < ny; ) {
    // Step along x when the line reaches the middle of the next x unit no later than that of the next y unit.
    if (j >= ny || (i < nx && (2 * i + 1) * ny <= (2 * j + 1) * nx)) {
      edges.push(edgeKey("h", Math.min(x, x + sx), y));
      x += sx;
      i++;
    } else {
      edges.push(edgeKey("v", x, Math.min(y, y + sy)));
      y += sy;
      j++;
    }
  }
  return edges;
}

/** Distance between the samples of a walls stroke, in cells: fine enough not to skip a vertex. */
const STROKE_SAMPLE = 0.25;

/**
 * The edges a walls stroke lays through world points `points`, in drawing order. The stroke is sampled,
 * every sample snaps to the nearest vertex and each next vertex is joined to the last by `edgesBetween`.
 * A stroke that never leaves its first vertex is a click: the nearest edge to the last point.
 */
export function strokeEdges(points: readonly Point[]): { edges: string[]; click: boolean } {
  if (points.length === 0) return { edges: [], click: false };
  let vertex = snapToVertex(points[0]);
  const edges: string[] = [];
  for (let i = 1; i < points.length; i++) {
    for (const point of pointsAlong(points[i - 1], points[i], STROKE_SAMPLE)) {
      const next = snapToVertex(point);
      if (next.x === vertex.x && next.y === vertex.y) continue;
      edges.push(...edgesBetween(vertex, next));
      vertex = next;
    }
  }
  if (edges.length > 0) return { edges, click: false };
  return { edges: [nearestEdge(points[points.length - 1])], click: true };
}

/** The edge nearest to a world point: the closest of the four sides of the cell under it. */
export function nearestEdge(world: Point): string {
  const { x, y } = cellAt(world);
  const fx = world.x - x;
  const fy = world.y - y;
  const sides: [number, string][] = [
    [fy, edgeKey("h", x, y)],
    [1 - fx, edgeKey("v", x + 1, y)],
    [1 - fy, edgeKey("h", x, y + 1)],
    [fx, edgeKey("v", x, y)],
  ];
  let best = sides[0];
  for (const side of sides) if (side[0] < best[0]) best = side;
  return best[1];
}

/**
 * Cells reachable from `start` through side neighbours for which `belongs` holds, `start` included;
 * empty when `start` itself does not belong, null when there are more than `limit` cells.
 */
export function connectedRegion(start: Point, belongs: (x: number, y: number) => boolean, limit: number): Point[] | null {
  if (!belongs(start.x, start.y)) return [];
  const seen = new Set([cellKey(start.x, start.y)]);
  const region: Point[] = [start];
  for (let i = 0; i < region.length; i++) {
    const { x, y } = region[i];
    for (const next of [
      { x, y: y - 1 },
      { x: x + 1, y },
      { x, y: y + 1 },
      { x: x - 1, y },
    ]) {
      const key = cellKey(next.x, next.y);
      if (seen.has(key) || !isCellInRange(next.x, next.y) || !belongs(next.x, next.y)) continue;
      if (region.length === limit) return null;
      seen.add(key);
      region.push(next);
    }
  }
  return region;
}
