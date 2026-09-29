// Drawing the board on a canvas, bottom to top (plan 5.8): void with its grid, terrain, hatching of difficult terrain,
// the grid over terrain, objects, walls and openings, pencil marks, tokens, then what the tools show over it.

import { EDGE_COLORS, sideColor, TERRAIN_BY_ID, TOKEN_COLORS } from "./catalog.ts";
import type { MarkColor, SideId } from "./catalog.ts";
import { parseCellKey, parseEdgeKey, screenToWorld, worldToScreen } from "./geometry.ts";
import type { Camera, CellSquare, GridEdge, Point } from "./geometry.ts";
import { tokenLayout } from "./pieces.ts";
import { drawObjectSign } from "./signs.ts";
import { isMapObject, isMark } from "./store.ts";
import type { Scene } from "./store.ts";

/**
 * What the tools show over the board: the brush or eraser square, the nearest edge, the outline being drawn,
 * the pencil line being drawn, the ruler, the path of a dragged token with its cost, the selected square;
 * and a ping, `age` from 0 when it came to 1 when it goes, with its author's name.
 */
export type BoardOverlay =
  | { kind: "square"; square: CellSquare }
  | { kind: "edge"; key: string }
  | { kind: "outline"; points: readonly Point[] }
  | { kind: "mark"; color: MarkColor; points: readonly [number, number][] }
  | { kind: "ruler"; from: Point; to: Point; label: string }
  | { kind: "path"; places: readonly Point[]; span: number; label: string }
  | { kind: "selected"; square: CellSquare }
  | { kind: "ping"; point: Point; label: string; age: number };

/** Board interface colours taken from the current theme (themes.css); void and grid may be the user's own (R45). */
export interface BoardColors {
  void: string;
  /** The grid over the void; over terrain it is TERRAIN_GRID, the same in every theme. */
  grid: string;
  cursor: string;
  labelBack: string;
  labelText: string;
  ping: string;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Hatch lines per cell, measured along the x axis. */
const HATCH_PER_CELL = 4;

/**
 * The grid over terrain (plan 8.27 item 6): a dark line and a light one side by side, the same in every theme, so the
 * cells read on a light floor and on dark water alike, inside buildings too.
 */
const TERRAIN_GRID = { dark: "rgba(0, 0, 0, 0.3)", light: "rgba(255, 255, 255, 0.22)" } as const;

/** The frame of a token by its side (plan 8.27 item 4), in the side colour: solid, dashed or dotted. */
export const SIDE_RINGS: Readonly<Record<SideId, "solid" | "dashed" | "dotted">> = {
  players: "solid",
  allies: "solid",
  enemies: "dashed",
  neutral: "dotted",
};

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
    ping: read("--board-ping"),
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
  ctx.strokeStyle = colors.grid;
  drawVoidGrid(ctx, viewport, camera, topLeft, bottomRight);

  /** The terrain cells in sight by row and by column: the grid over terrain goes along them. */
  const byRow = new Map<number, number[]>();
  const byColumn = new Map<number, number[]>();
  const hatched = new Map<string, Path2D>();
  for (const [key, terrainId] of Object.entries(scene.cells)) {
    const cell = parseCellKey(key);
    if (cell.x + 1 < topLeft.x || cell.x > bottomRight.x || cell.y + 1 < topLeft.y || cell.y > bottomRight.y) continue;
    const terrain = TERRAIN_BY_ID.get(terrainId as string);
    if (!terrain) throw new Error(`unknown terrain in cell ${key}`);
    const [x, y, w, h] = cellRect(camera, cell.x, cell.y, 1);
    ctx.fillStyle = terrain.color;
    ctx.fillRect(x, y, w, h);
    append(byRow, cell.y, cell.x);
    append(byColumn, cell.x, cell.y);
    if (terrain.hatch) {
      let path = hatched.get(terrain.hatch);
      if (!path) hatched.set(terrain.hatch, (path = new Path2D()));
      path.rect(x, y, w, h);
    }
  }
  for (const [color, area] of hatched) drawHatch(ctx, camera, topLeft, bottomRight, color, area);

  const lines = terrainGridLines(camera, byRow, byColumn);
  ctx.fillStyle = TERRAIN_GRID.dark;
  ctx.fill(linesPath(lines, 0));
  ctx.fillStyle = TERRAIN_GRID.light;
  ctx.fill(linesPath(lines, 1));

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

// Tokens (plan 8.27 item 4, the "ring" of the variant V mock-up): a dark disc in the space with a frame of the side
// colour, solid, dashed or dotted by side, so sides differ without telling colours apart; the first letter of the name
// in the disc, and the name under it on a dark plate when the token is large enough on screen.
const TOKEN_INSET = 0.06;
/** Frame width in cells, with a floor in pixels, so it shows at any scale. */
const TOKEN_RING = 0.09;
const TOKEN_RING_MIN_PX = 2;
const INITIAL_MIN_PX = 16;
const INITIAL_FONT = 0.36;
const NAME_MIN_PX = 28;
const NAME_FONT = 0.28;

/** Dashes or dots that go evenly round a circle of `length` pixels with a frame `width` pixels wide. */
function ringDash(style: "solid" | "dashed" | "dotted", length: number, width: number): number[] {
  if (style === "solid") return [];
  if (style === "dashed") {
    const period = length / Math.max(4, Math.round(length / (3.6 * width)));
    return [period * 0.6, period * 0.4];
  }
  // Dots: dashes of no length with round caps, one frame width across.
  return [0, length / Math.max(6, Math.round(length / (2.2 * width)))];
}

function drawTokens(ctx: CanvasRenderingContext2D, scene: Scene, camera: Camera, topLeft: Point, bottomRight: Point): void {
  ctx.save();
  const ring = Math.max(TOKEN_RING_MIN_PX, camera.scale * TOKEN_RING);
  for (const { token, square } of tokenLayout(scene)) {
    if (!isSquareVisible(square, topLeft, bottomRight)) continue;
    const px = square.size * camera.scale;
    const center = worldToScreen(camera, { x: square.x + square.size / 2, y: square.y + square.size / 2 });
    const radius = px * (0.5 - TOKEN_INSET);
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = TOKEN_COLORS.outline;
    ctx.fill();
    // The frame lies inside the disc: its gaps show the dark disc, which reads over any terrain.
    const width = Math.min(ring, radius);
    const ringRadius = radius - width / 2;
    const style = SIDE_RINGS[token.side];
    ctx.beginPath();
    ctx.arc(center.x, center.y, ringRadius, 0, 2 * Math.PI);
    ctx.lineWidth = width;
    ctx.lineCap = style === "dotted" ? "round" : "butt";
    ctx.setLineDash(ringDash(style, 2 * Math.PI * ringRadius, width));
    ctx.strokeStyle = sideColor(token.side);
    ctx.stroke();
    ctx.setLineDash([]);
    if (token.name !== "" && px >= INITIAL_MIN_PX) drawInitial(ctx, token.name, center, px);
    if (token.name !== "" && px >= NAME_MIN_PX) drawName(ctx, token.name, center.x, center.y + px * 0.5, camera.scale);
  }
  ctx.restore();
}

/** The first letter of a token name (user text, drawn as canvas text only). */
function drawInitial(ctx: CanvasRenderingContext2D, name: string, center: Point, px: number): void {
  const [first = ""] = name;
  ctx.font = `600 ${Math.round(px * INITIAL_FONT)}px system-ui, sans-serif`;
  ctx.fillStyle = TOKEN_COLORS.label;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(first, center.x, center.y);
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
/** Radius of a ping ring in cells, with a floor in pixels. */
const PING_RADIUS = 0.6;

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
    case "ping": {
      // A ring that widens and fades, over a steady one, with the author's name (user text, drawn as canvas text).
      const center = worldToScreen(camera, overlay.point);
      const radius = Math.max(12, camera.scale * PING_RADIUS);
      ctx.strokeStyle = colors.ping;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1 - overlay.age;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius * (1 + overlay.age), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (overlay.label !== "") drawLabel(ctx, overlay.label, center.x, center.y + radius + LABEL_FONT_PX, colors.labelBack, colors.labelText, "center");
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

// Grid lines are one pixel wide, at the pixel where each cell begins as cellRect rounds it. Each colour is one path
// drawn once: where lines cross, a see-through colour does not get darker.

/**
 * The grid over the void: lines across the whole viewport; terrain drawn after it covers them. One stroke, as before
 * stage 27: filling a rectangle per line over the whole viewport took a quarter more time per frame.
 */
function drawVoidGrid(ctx: CanvasRenderingContext2D, viewport: Viewport, camera: Camera, topLeft: Point, bottomRight: Point): void {
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

function append(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Runs of neighbouring whole numbers in `values` (sorted in place), as [first, last]. */
function runs(values: number[]): [number, number][] {
  values.sort((a, b) => a - b);
  const found: [number, number][] = [];
  for (const value of values) {
    const last = found[found.length - 1];
    if (last && value === last[1] + 1) last[1] = value;
    else found.push([value, value]);
  }
  return found;
}

type ScreenRect = [x: number, y: number, width: number, height: number];

/**
 * The grid over terrain: a line along the top of each run of terrain cells in a row and along the left of each run in
 * a column. One rectangle per run, not per cell, keeps the frame fast. The lines at the far edge of the terrain are
 * the void's: its grid shows there.
 */
function terrainGridLines(camera: Camera, byRow: Map<number, number[]>, byColumn: Map<number, number[]>): ScreenRect[] {
  const lines: ScreenRect[] = [];
  for (const [y, columns] of byRow) {
    for (const [first, last] of runs(columns)) {
      const [left, top] = cellRect(camera, first, y, 1);
      const [end] = cellRect(camera, last + 1, y, 1);
      lines.push([left, top, end - left, 1]);
    }
  }
  for (const [x, rows] of byColumn) {
    for (const [first, last] of runs(rows)) {
      const [left, top] = cellRect(camera, x, first, 1);
      const [, end] = cellRect(camera, x, last + 1, 1);
      lines.push([left, top, 1, end - top]);
    }
  }
  return lines;
}

/** The lines `shift` pixels right of and below where they are. */
function linesPath(lines: readonly ScreenRect[], shift: number): Path2D {
  const path = new Path2D();
  for (const [x, y, width, height] of lines) path.rect(x + shift, y + shift, width, height);
  return path;
}
