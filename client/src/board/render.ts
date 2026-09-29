// Drawing the board on a canvas, bottom to top (plan 5.8): void, terrain, hatching of difficult terrain, grid,
// objects, walls and openings, pencil marks, tokens, then what the tools show over it.

import { EDGE_COLORS, sideColor, TERRAIN_BY_ID, TOKEN_COLORS } from "./catalog.ts";
import type { MarkColor } from "./catalog.ts";
import { parseCellKey, parseEdgeKey, screenToWorld, worldToScreen } from "./geometry.ts";
import type { Camera, CellSquare, GridEdge, Point } from "./geometry.ts";
import { tokenLayout } from "./pieces.ts";
import { drawObjectSign } from "./signs.ts";
import { isMapObject, isMark } from "./store.ts";
import type { Scene } from "./store.ts";

/**
 * What the tools show over the board: the brush or eraser square, the nearest edge, the outline being drawn,
 * the pencil line being drawn, the ruler, the path of a dragged token with its cost, the selected square.
 */
export type BoardOverlay =
  | { kind: "square"; square: CellSquare }
  | { kind: "edge"; key: string }
  | { kind: "outline"; points: readonly Point[] }
  | { kind: "mark"; color: MarkColor; points: readonly [number, number][] }
  | { kind: "ruler"; from: Point; to: Point; label: string }
  | { kind: "path"; places: readonly Point[]; span: number; label: string }
  | { kind: "selected"; square: CellSquare };

/** Board interface colours taken from the current theme (themes.css). */
export interface BoardColors {
  void: string;
  grid: string;
  cursor: string;
  labelBack: string;
  labelText: string;
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
  return {
    void: read("--board-void"),
    grid: read("--board-grid"),
    cursor: read("--board-cursor"),
    labelBack: read("--board-label-bg"),
    labelText: read("--board-label-fg"),
  };
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
  overlays: readonly BoardOverlay[],
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
  drawObjects(ctx, scene, camera, topLeft, bottomRight);
  drawEdges(ctx, scene, camera, topLeft, bottomRight);
  for (const mark of Object.values(scene.marks)) {
    if (isMark(mark)) drawMarkLine(ctx, camera, mark.color, mark.pts);
  }
  drawTokens(ctx, scene, camera, topLeft, bottomRight);
  for (const overlay of overlays) drawOverlay(ctx, camera, overlay, colors);
}

const isSquareVisible = (square: CellSquare, topLeft: Point, bottomRight: Point): boolean =>
  square.x + square.size >= topLeft.x && square.x <= bottomRight.x && square.y + square.size >= topLeft.y && square.y <= bottomRight.y;

function drawObjects(ctx: CanvasRenderingContext2D, scene: Scene, camera: Camera, topLeft: Point, bottomRight: Point): void {
  for (const item of Object.values(scene.objects)) {
    if (!isMapObject(item) || !isSquareVisible({ x: item.x, y: item.y, size: 1 }, topLeft, bottomRight)) continue;
    const corner = worldToScreen(camera, item);
    drawObjectSign(ctx, item.type, corner.x, corner.y, camera.scale);
  }
}

/** Pencil line width in cells, with a floor in pixels. */
const MARK_WIDTH = 0.08;

function drawMarkLine(ctx: CanvasRenderingContext2D, camera: Camera, color: string, points: readonly [number, number][]): void {
  if (points.length === 0) return;
  const width = Math.max(2, camera.scale * MARK_WIDTH);
  const screen = points.map(([x, y]) => worldToScreen(camera, { x, y }));
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (screen.length === 1) {
    ctx.arc(screen[0].x, screen[0].y, width / 2, 0, 2 * Math.PI);
    ctx.fill();
  } else {
    for (const p of screen) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  ctx.restore();
}

// Tokens: a disc of the side colour in the space; the name under it on a dark plate when the token is large enough on screen.
const TOKEN_INSET = 0.06;
const TOKEN_OUTLINE = 0.05;
const NAME_MIN_PX = 28;
const NAME_FONT = 0.28;

function drawTokens(ctx: CanvasRenderingContext2D, scene: Scene, camera: Camera, topLeft: Point, bottomRight: Point): void {
  ctx.save();
  for (const { token, square } of tokenLayout(scene)) {
    if (!isSquareVisible(square, topLeft, bottomRight)) continue;
    const px = square.size * camera.scale;
    const center = worldToScreen(camera, { x: square.x + square.size / 2, y: square.y + square.size / 2 });
    ctx.beginPath();
    ctx.arc(center.x, center.y, px * (0.5 - TOKEN_INSET), 0, 2 * Math.PI);
    ctx.fillStyle = sideColor(token.side);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, Math.min(px, camera.scale) * TOKEN_OUTLINE);
    ctx.strokeStyle = TOKEN_COLORS.outline;
    ctx.stroke();
    if (token.name !== "" && px >= NAME_MIN_PX) drawName(ctx, token.name, center.x, center.y + px * 0.5, camera.scale);
  }
  ctx.restore();
}

/** A token name, user text, is drawn as canvas text only; long names are cut with an ellipsis. */
function drawName(ctx: CanvasRenderingContext2D, name: string, x: number, bottom: number, scale: number): void {
  const size = Math.max(10, Math.min(16, Math.round(scale * NAME_FONT)));
  ctx.font = `${size}px system-ui, sans-serif`;
  const maxWidth = Math.max(scale * 2.5, 60);
  let text = name;
  if (ctx.measureText(text).width > maxWidth) {
    const chars = [...name];
    while (chars.length > 1 && ctx.measureText(`${chars.join("")}…`).width > maxWidth) chars.pop();
    text = `${chars.join("")}…`;
  }
  drawLabel(ctx, text, x, bottom - size * 0.2, TOKEN_COLORS.labelBack, TOKEN_COLORS.label, "center");
}

/** Text on a rounded plate; `x` is the centre or the left edge, `y` the middle of the text. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  back: string,
  fore: string,
  align: "center" | "left",
): void {
  const width = ctx.measureText(text).width;
  const size = parseInt(ctx.font, 10);
  const padX = size * 0.35;
  const left = align === "center" ? x - width / 2 : x;
  ctx.beginPath();
  ctx.roundRect(left - padX, y - size * 0.65, width + 2 * padX, size * 1.3, size * 0.3);
  ctx.fillStyle = back;
  ctx.fill();
  ctx.fillStyle = fore;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left, y);
}

const LABEL_FONT_PX = 14;

function drawOverlay(ctx: CanvasRenderingContext2D, camera: Camera, overlay: BoardOverlay, colors: BoardColors): void {
  ctx.save();
  ctx.strokeStyle = colors.cursor;
  ctx.lineWidth = 2;
  ctx.font = `${LABEL_FONT_PX}px system-ui, sans-serif`;
  switch (overlay.kind) {
    case "square":
    case "selected": {
      const [x, y, w, h] = cellRect(camera, overlay.square.x, overlay.square.y, overlay.square.size);
      if (overlay.kind === "selected") ctx.setLineDash([6, 4]);
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      break;
    }
    case "edge": {
      const [a, b] = edgeEnds(camera, parseEdgeKey(overlay.key));
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case "outline":
      ctx.beginPath();
      for (const point of overlay.points) {
        const p = worldToScreen(camera, point);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
      break;
    case "mark":
      drawMarkLine(ctx, camera, overlay.color, overlay.points);
      break;
    case "ruler": {
      const a = worldToScreen(camera, { x: overlay.from.x + 0.5, y: overlay.from.y + 0.5 });
      const b = worldToScreen(camera, { x: overlay.to.x + 0.5, y: overlay.to.y + 0.5 });
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of [a, b]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = colors.cursor;
        ctx.fill();
      }
      drawLabel(ctx, overlay.label, b.x + 12, b.y - 14, colors.labelBack, colors.labelText, "left");
      break;
    }
    case "path": {
      const half = overlay.span / 2;
      const centers = overlay.places.map((place) => worldToScreen(camera, { x: place.x + half, y: place.y + half }));
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const p of centers) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = colors.cursor;
      for (const p of centers) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
      const last = overlay.places[overlay.places.length - 1];
      const corner = worldToScreen(camera, { x: last.x + overlay.span, y: last.y });
      drawLabel(ctx, overlay.label, corner.x + 6, corner.y + 4, colors.labelBack, colors.labelText, "left");
      break;
    }
  }
  ctx.restore();
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
