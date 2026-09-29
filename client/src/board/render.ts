// Drawing the board on a canvas: void, terrain, hatching of difficult terrain, grid, walls and openings, tool cursor.

import { EDGE_COLORS, TERRAIN_BY_ID } from "./catalog.ts";
import { parseCellKey, parseEdgeKey, screenToWorld, worldToScreen } from "./geometry.ts";
import type { Camera, CellSquare, GridEdge, Point } from "./geometry.ts";
import type { Scene } from "./store.ts";

/** What the current tool shows under the pointer: the brush or eraser square, the nearest edge, the outline being drawn. */
export type BoardCursor =
  | { kind: "square"; square: CellSquare }
  | { kind: "edge"; key: string }
  | { kind: "outline"; points: readonly Point[] };

/** Board interface colours taken from the current theme (themes.css). */
export interface BoardColors {
  void: string;
  grid: string;
  cursor: string;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Hatch lines per cell, measured along the x axis. */
const HATCH_PER_CELL = 4;

export function readBoardColors(): BoardColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => {
    const value = style.getPropertyValue(name).trim();
    if (!value) throw new Error(`theme variable ${name} is not set`);
    return value;
  };
  return { void: read("--board-void"), grid: read("--board-grid"), cursor: read("--board-cursor") };
}

/** Matches the canvas backing store to its CSS size and the device pixel ratio. */
export function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Viewport {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  const backingWidth = Math.round(width * ratio);
  const backingHeight = Math.round(height * ratio);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width, height };
}

export function drawBoard(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  scene: Scene,
  camera: Camera,
  colors: BoardColors,
  cursor: BoardCursor | null,
): void {
  const topLeft = screenToWorld(camera, { x: 0, y: 0 });
  const bottomRight = screenToWorld(camera, { x: viewport.width, y: viewport.height });

  ctx.fillStyle = colors.void;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const hatched = new Map<string, Path2D>();
  for (const [key, terrainId] of Object.entries(scene.cells)) {
    const cell = parseCellKey(key);
    if (cell.x + 1 < topLeft.x || cell.x > bottomRight.x || cell.y + 1 < topLeft.y || cell.y > bottomRight.y) continue;
    const terrain = TERRAIN_BY_ID.get(terrainId as string);
    if (!terrain) throw new Error(`unknown terrain in cell ${key}`);
    const [x, y, w, h] = cellRect(camera, cell.x, cell.y, 1);
    ctx.fillStyle = terrain.color;
    ctx.fillRect(x, y, w, h);
    if (terrain.hatch) {
      let path = hatched.get(terrain.hatch);
      if (!path) hatched.set(terrain.hatch, (path = new Path2D()));
      path.rect(x, y, w, h);
    }
  }
  for (const [color, area] of hatched) drawHatch(ctx, camera, topLeft, bottomRight, color, area);

  drawGrid(ctx, viewport, camera, topLeft, bottomRight, colors.grid);
  drawEdges(ctx, scene, camera, topLeft, bottomRight);
  if (cursor) drawCursor(ctx, camera, cursor, colors.cursor);
}

function drawCursor(ctx: CanvasRenderingContext2D, camera: Camera, cursor: BoardCursor, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (cursor.kind === "square") {
    const [x, y, w, h] = cellRect(camera, cursor.square.x, cursor.square.y, cursor.square.size);
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    return;
  }
  ctx.beginPath();
  if (cursor.kind === "edge") {
    const [a, b] = edgeEnds(camera, parseEdgeKey(cursor.key));
    ctx.lineWidth = 4;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  } else {
    for (const point of cursor.points) {
      const p = worldToScreen(camera, point);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }
  ctx.stroke();
}

/** Screen ends of an edge: its first vertex and the next one to the right (h) or down (v). */
function edgeEnds(camera: Camera, { dir, x, y }: GridEdge): [Point, Point] {
  const a = worldToScreen(camera, { x, y });
  const b = worldToScreen(camera, dir === "h" ? { x: x + 1, y } : { x, y: y + 1 });
  return [a, b];
}

// Signs of edge types (catalog.ts). Sizes are parts of a cell, with a floor in pixels for small scales.
const WALL_WIDTH = 0.15;
const DOOR_FROM = 0.2; // the door leaf takes the middle of the edge, walls the ends
const DOOR_THICKNESS = 0.3;
const WINDOW_GAP = 0.07;
/** Width of the window lines and of the door outline. */
const THIN_WIDTH = 0.035;
const BARS_WIDTH = 0.08;
const BARS_DASH = 0.12;
const LETTER_SIZE = 0.45;
/** The S of a secret door sits on a dark disc of this radius, so it reads over any floor. */
const LETTER_DISC = 0.26;
/** Below this scale in pixels per cell the S of a secret door is not drawn. */
const LETTER_MIN_SCALE = 16;

function drawEdges(ctx: CanvasRenderingContext2D, scene: Scene, camera: Camera, topLeft: Point, bottomRight: Point): void {
  const s = camera.scale;
  const walls = new Path2D();
  const doors = new Path2D();
  const windows = new Path2D();
  const bars = new Path2D();
  const letters: Point[] = [];
  const doorThickness = Math.max(4, s * DOOR_THICKNESS);
  const windowGap = Math.max(1.5, s * WINDOW_GAP);

  for (const [key, type] of Object.entries(scene.edges)) {
    const edge = parseEdgeKey(key);
    if (edge.x < topLeft.x - 1 || edge.x > bottomRight.x + 1 || edge.y < topLeft.y - 1 || edge.y > bottomRight.y + 1) continue;
    const [a, b] = edgeEnds(camera, edge);
    // The point `t` of the way along the edge, shifted by `n` pixels across it.
    const horizontal = edge.dir === "h";
    const at = (t: number, n = 0): Point =>
      horizontal ? { x: a.x + s * t, y: a.y + n } : { x: a.x + n, y: a.y + s * t };
    if (type === "wall" || type === "secret") {
      walls.moveTo(a.x, a.y);
      walls.lineTo(b.x, b.y);
      if (type === "secret") letters.push(at(0.5));
    } else if (type === "door") {
      const leafStart = at(DOOR_FROM);
      const leafEnd = at(1 - DOOR_FROM);
      walls.moveTo(a.x, a.y);
      walls.lineTo(leafStart.x, leafStart.y);
      walls.moveTo(leafEnd.x, leafEnd.y);
      walls.lineTo(b.x, b.y);
      const corner = at(DOOR_FROM, -doorThickness / 2);
      const length = s * (1 - 2 * DOOR_FROM);
      if (horizontal) doors.rect(corner.x, corner.y, length, doorThickness);
      else doors.rect(corner.x, corner.y, doorThickness, length);
    } else if (type === "window") {
      for (const n of [-windowGap, windowGap]) {
        const from = at(0, n);
        const to = at(1, n);
        windows.moveTo(from.x, from.y);
        windows.lineTo(to.x, to.y);
      }
    } else if (type === "bars") {
      bars.moveTo(a.x, a.y);
      bars.lineTo(b.x, b.y);
    } else {
      throw new Error(`unknown edge type in ${key}`);
    }
  }

  ctx.save();
  ctx.strokeStyle = EDGE_COLORS.line;
  ctx.lineCap = "square";
  ctx.lineWidth = Math.max(2, s * WALL_WIDTH);
  ctx.stroke(walls);
  ctx.lineCap = "butt";
  ctx.lineWidth = Math.max(1, s * THIN_WIDTH);
  ctx.stroke(windows);
  ctx.fillStyle = EDGE_COLORS.door;
  ctx.fill(doors);
  ctx.stroke(doors);
  ctx.lineWidth = Math.max(1.5, s * BARS_WIDTH);
  ctx.setLineDash([Math.max(2, s * BARS_DASH), Math.max(2, s * BARS_DASH)]);
  ctx.stroke(bars);
  if (s >= LETTER_MIN_SCALE && letters.length > 0) {
    const discs = new Path2D();
    for (const p of letters) {
      discs.moveTo(p.x + s * LETTER_DISC, p.y);
      discs.arc(p.x, p.y, s * LETTER_DISC, 0, 2 * Math.PI);
    }
    ctx.fillStyle = EDGE_COLORS.line;
    ctx.fill(discs);
    ctx.font = `bold ${Math.round(s * LETTER_SIZE)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = EDGE_COLORS.letter;
    for (const p of letters) ctx.fillText("S", p.x, p.y);
  }
  ctx.restore();
}

/** Screen rectangle of a square of cells, rounded so neighbouring cells meet without seams. */
function cellRect(camera: Camera, cellX: number, cellY: number, size: number): [number, number, number, number] {
  const a = worldToScreen(camera, { x: cellX, y: cellY });
  const b = worldToScreen(camera, { x: cellX + size, y: cellY + size });
  const x = Math.round(a.x);
  const y = Math.round(a.y);
  return [x, y, Math.round(b.x) - x, Math.round(b.y) - y];
}

// Diagonal lines anchored to the world, so hatching runs on across neighbouring cells.
function drawHatch(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  topLeft: Point,
  bottomRight: Point,
  color: string,
  area: Path2D,
): void {
  ctx.save();
  ctx.clip(area);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, camera.scale / 24);
  ctx.beginPath();
  const first = Math.floor((topLeft.x - bottomRight.y) * HATCH_PER_CELL);
  const last = Math.ceil((bottomRight.x - topLeft.y) * HATCH_PER_CELL);
  for (let i = first; i <= last; i++) {
    const c = i / HATCH_PER_CELL; // the line x - y = c
    const from = worldToScreen(camera, { x: c + topLeft.y, y: topLeft.y });
    const to = worldToScreen(camera, { x: c + bottomRight.y, y: bottomRight.y });
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  camera: Camera,
  topLeft: Point,
  bottomRight: Point,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(topLeft.x); x <= bottomRight.x; x++) {
    const sx = Math.round(worldToScreen(camera, { x, y: 0 }).x) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, viewport.height);
  }
  for (let y = Math.ceil(topLeft.y); y <= bottomRight.y; y++) {
    const sy = Math.round(worldToScreen(camera, { x: 0, y }).y) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(viewport.width, sy);
  }
  ctx.stroke();
}
