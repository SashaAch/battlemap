// Drawing the board on a canvas: void, terrain, hatching of difficult terrain, grid, brush outline.

import { TERRAIN_BY_ID } from "./catalog.ts";
import { parseCellKey, screenToWorld, worldToScreen } from "./geometry.ts";
import type { Camera, CellSquare, Point } from "./geometry.ts";
import type { Scene } from "./store.ts";

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
  brush: CellSquare | null,
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

  if (brush) {
    const [x, y, w, h] = cellRect(camera, brush.x, brush.y, brush.size);
    ctx.strokeStyle = colors.cursor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }
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
