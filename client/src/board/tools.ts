// Board input: camera (mouse wheel and trackpad, space or middle button drag, two fingers)
// and the tools (plan 5.5, 5.9): select, brush, fill, room, walls, objects, tokens, pencil, ruler, eraser, ping.

import { sizeSpan } from "./catalog.ts";
import type { EdgeType, MarkColor, ObjectType, TerrainId } from "./catalog.ts";
import {
  brushSquare,
  cellAt,
  cellsOfSquare,
  isCellInRange,
  nearestEdge,
  outlineCells,
  panBy,
  pointsAlong,
  screenToWorld,
  strokeEdges,
  wheelGesture,
  zoomAt,
} from "./geometry.ts";
import type { Camera, Point } from "./geometry.ts";
import type { BoardOverlay } from "./render.ts";
import { edgesPatch, enclosePatch, erasePatch, fillPatch, roomPatch } from "./edit.ts";
import type { EraseFilter } from "./edit.ts";
import { distance, extendPath, pathCost } from "./movement.ts";
import type { Distance } from "./movement.ts";
import {
  addMarkPoint,
  markPatch,
  moveObjectPatch,
  moveTokenPatch,
  newId,
  objectAt,
  placeObjectPatch,
  placeTokenPatch,
  tokenAt,
  tokenLayout,
} from "./pieces.ts";
import type { TokenDraft } from "./pieces.ts";
import { applyToChange, beginChange, cancelChange, diagonalRule, finishChange, isMapObject, isToken } from "./store.ts";
import type { History, Patch, Scene } from "./store.ts";

export const BRUSH_SIZES = [1, 2, 3] as const;
type BrushSize = (typeof BRUSH_SIZES)[number];

export const TOOLS = ["select", "brush", "fill", "room", "walls", "objects", "tokens", "pencil", "ruler", "eraser", "ping"] as const;
export type Tool = (typeof TOOLS)[number];

/** Tool shortcuts by physical key (plan 5.9), so they work in any keyboard layout. */
const TOOL_KEYS: Record<string, Tool> = {
  KeyV: "select",
  KeyB: "brush",
  KeyF: "fill",
  KeyR: "room",
  KeyW: "walls",
  KeyO: "objects",
  KeyT: "tokens",
  KeyP: "pencil",
  KeyM: "ruler",
  KeyE: "eraser",
  KeyG: "ping",
};

/** A selected token or object: Delete removes it. */
interface Selection {
  collection: "tokens" | "objects";
  id: string;
}

export interface Board {
  scene: Scene;
  history: History;
  camera: Camera;
  tool: Tool;
  terrain: TerrainId;
  /** Side of the brush and eraser square in cells. */
  brushSize: BrushSize;
  edgeType: EdgeType;
  eraseFilter: EraseFilter;
  objectType: ObjectType;
  /** Side, size and name of the next token. */
  tokenDraft: TokenDraft;
  markColor: MarkColor;
  selection: Selection | null;
  /** World point under the mouse or pen, null when it is off the board. */
  hover: Point | null;
  /** A player's board (plan 5.4): select takes only tokens of the side "players", nothing is deleted. */
  playerTokensOnly: boolean;
}

interface ToolHooks {
  /** The picture changed: camera, cursor or cells in a stroke under way. */
  redraw(): void;
  /** A finished change entered the history. */
  committed(): void;
  hoverChanged(): void;
  brushSizeChanged(): void;
  toolChanged(): void;
  /** Shift+click with walls hit a region larger than ENCLOSE_LIMIT; nothing was changed. */
  enclosureTooBig(): void;
  /** A tiny token was put or dropped in a cell that already holds four; nothing was changed. */
  tinyCellFull(): void;
  /** A double click on a token with the select tool. */
  editToken(id: string): void;
  /** Text of the ruler. */
  rulerLabel(distance: Distance): string;
  /** Text of the cost of the path of a dragged token, in feet. */
  costLabel(feet: number): string;
  undo(): void;
  redo(): void;
  /** A click with the ping tool. */
  ping(world: Point): void;
}

export interface Tools {
  /** What to draw over the board for the current tool. */
  overlays(): BoardOverlay[];
}

/** Distance between samples along a stroke, in cells. */
const STROKE_STEP = 0.25;
/** Zoom speed per wheel pixel: plain wheel and trackpad pinch (sent as wheel with Ctrl). */
const WHEEL_ZOOM = 0.0015;
const PINCH_ZOOM = 0.01;
const LINE_HEIGHT_PX = 16;

interface Stroke {
  pointerId: number;
  /** The tool the stroke started with; switching tools during a stroke does not change it. */
  tool: Tool;
  last: Point;
  /** Fill, room and walls: the points drawn so far. */
  points: Point[];
  /** Pencil: the points of the mark, rounded and thinned. */
  mark: [number, number][];
}

/** A token or object dragged with the select tool: one change from press to release. */
type Drag =
  | {
      kind: "token";
      pointerId: number;
      id: string;
      /** The pressed cell relative to the top-left cell of the space. */
      grab: Point;
      span: number;
      /** The path so far, the first place where the drag started; a return to a place cuts it back (extendPath). */
      places: Point[];
    }
  | { kind: "object"; pointerId: number; id: string };

interface Ruler {
  pointerId: number;
  from: Point;
  to: Point;
}

interface Pinch {
  mid: Point;
  distance: number;
}

export function attachTools(canvas: HTMLCanvasElement, board: Board, hooks: ToolHooks): Tools {
  let spaceHeld = false;
  let panPointer: { id: number; last: Point } | null = null;
  let stroke: Stroke | null = null;
  let drag: Drag | null = null;
  let ruler: Ruler | null = null;
  let pinch: Pinch | null = null;
  const touches = new Map<number, Point>();

  const screenPoint = (e: PointerEvent | WheelEvent | MouseEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const updateCursor = (): void => {
    canvas.style.cursor = panPointer ? "grabbing" : spaceHeld ? "grab" : "crosshair";
  };

  const apply = (patch: Patch): void => {
    if (patch.length === 0) return;
    applyToChange(board.scene, board.history, patch);
    hooks.redraw();
  };

  /** A change of one patch, not a stroke: placing a token or an object, deleting one. */
  const commit = (patch: Patch): void => {
    if (patch.length === 0) return;
    beginChange(board.history);
    applyToChange(board.scene, board.history, patch);
    if (finishChange(board.history)) hooks.committed();
  };

  // Brush and eraser: one dab of the square under a stroke sample.
  const dab = (tool: Tool, world: Point): void => {
    const square = brushSquare(world, board.brushSize);
    if (tool === "eraser") apply(erasePatch(board.scene, square, board.eraseFilter));
    else apply(fillPatch(board.scene, cellsOfSquare(square).filter(({ x, y }) => isCellInRange(x, y)), board.terrain));
  };

  // One stroke, from press to release, is one change and one undo step; undo and redo wait for its end.
  const startStroke = (pointerId: number, world: Point): void => {
    beginChange(board.history);
    stroke = { pointerId, tool: board.tool, last: world, points: [world], mark: [] };
    if (stroke.tool === "brush" || stroke.tool === "eraser") dab(stroke.tool, world);
    else if (stroke.tool === "pencil") addMarkPoint(stroke.mark, world);
    hooks.redraw();
  };

  const continueStroke = (world: Point): void => {
    if (!stroke) return;
    const { tool } = stroke;
    if (tool === "brush" || tool === "eraser") {
      for (const point of pointsAlong(stroke.last, world, STROKE_STEP)) dab(tool, point);
    } else if (tool === "pencil") {
      addMarkPoint(stroke.mark, world);
    } else {
      stroke.points.push(world);
    }
    // Walls show up as they are drawn; a click is decided on release.
    if (tool === "walls") {
      const { edges, click } = strokeEdges(stroke.points);
      if (!click) apply(edgesPatch(board.scene, edges, board.edgeType));
    }
    stroke.last = world;
  };

  const finishStroke = (): void => {
    if (!stroke) return;
    const { tool, points, mark } = stroke;
    stroke = null;
    if (tool === "fill") apply(fillPatch(board.scene, outlineCells(points), board.terrain));
    else if (tool === "room") apply(roomPatch(board.scene, outlineCells(points), board.terrain));
    else if (tool === "walls") apply(edgesPatch(board.scene, strokeEdges(points).edges, board.edgeType));
    else if (tool === "pencil") apply(markPatch(newId(board.scene.marks, "m"), board.markColor, mark));
    if (finishChange(board.history)) hooks.committed();
    else hooks.redraw();
  };

  // ---- select: drag tokens and objects ----

  const startDrag = (pointerId: number, world: Point): boolean => {
    const tokenId = tokenAt(board.scene, world);
    const cell = cellAt(world);
    if (tokenId !== null) {
      const token = board.scene.tokens[tokenId];
      if (!isToken(token) || (board.playerTokensOnly && token.side !== "players")) return false;
      board.selection = { collection: "tokens", id: tokenId };
      drag = {
        kind: "token",
        pointerId,
        id: tokenId,
        grab: { x: cell.x - token.x, y: cell.y - token.y },
        span: sizeSpan(token.size),
        places: [{ x: token.x, y: token.y }],
      };
    } else {
      const objectId = board.playerTokensOnly ? null : objectAt(board.scene, cell);
      if (objectId === null) return false;
      board.selection = { collection: "objects", id: objectId };
      drag = { kind: "object", pointerId, id: objectId };
    }
    beginChange(board.history);
    hooks.redraw();
    return true;
  };

  const continueDrag = (world: Point): void => {
    if (!drag) return;
    const cell = cellAt(world);
    if (drag.kind === "object") {
      apply(moveObjectPatch(board.scene, drag.id, cell));
      return;
    }
    const target = { x: cell.x - drag.grab.x, y: cell.y - drag.grab.y };
    const last = drag.places[drag.places.length - 1];
    if (target.x === last.x && target.y === last.y) return;
    drag.places = extendPath(drag.places, target);
    // A tiny token over a full cell stays where it was until it leaves it; the drop decides.
    apply(moveTokenPatch(board.scene, drag.id, target) ?? []);
  };

  const finishDrag = (): void => {
    if (!drag) return;
    const done = drag;
    drag = null;
    if (done.kind === "token") {
      const patch = moveTokenPatch(board.scene, done.id, done.places[done.places.length - 1]);
      if (patch === null) {
        cancelChange(board.scene, board.history);
        hooks.tinyCellFull();
        hooks.redraw();
        return;
      }
      apply(patch);
    }
    if (finishChange(board.history)) hooks.committed();
    else hooks.redraw();
  };

  // A second finger turns a stroke or a drag into a pinch, and a cancelled pointer ends it: what was done is taken back.
  const cancelGesture = (): void => {
    ruler = null;
    if (stroke || drag) {
      cancelChange(board.scene, board.history);
      stroke = null;
      drag = null;
    }
    hooks.redraw();
  };

  // ---- one-click tools ----

  // Shift+click with walls: one change of its own, not a stroke.
  const enclose = (world: Point): void => {
    const patch = enclosePatch(board.scene, cellAt(world), board.edgeType);
    if (patch === null) hooks.enclosureTooBig();
    else commit(patch);
  };

  const placeToken = (world: Point): void => {
    const id = newId(board.scene.tokens, "t");
    const patch = placeTokenPatch(board.scene, id, board.tokenDraft, cellAt(world));
    if (patch === null) {
      hooks.tinyCellFull();
      return;
    }
    commit(patch);
    if (Object.hasOwn(board.scene.tokens, id)) board.selection = { collection: "tokens", id };
    hooks.redraw();
  };

  const placeObject = (world: Point): void => {
    const id = newId(board.scene.objects, "o");
    commit(placeObjectPatch(board.scene, id, board.objectType, cellAt(world)));
    if (Object.hasOwn(board.scene.objects, id)) board.selection = { collection: "objects", id };
    hooks.redraw();
  };

  const deleteSelection = (): void => {
    const selection = board.selection;
    if (!selection || board.history.open || board.playerTokensOnly) return;
    board.selection = null;
    if (Object.hasOwn(board.scene[selection.collection], selection.id)) commit([[selection.collection, selection.id, null]]);
    hooks.redraw();
  };

  /**
   * A press of the main button, a pen or one finger: starts what the tool does. Returns true
   * when the pointer should be captured; the select tool on an empty place pans the map.
   */
  const press = (pointerId: number, point: Point, shift: boolean): boolean => {
    if (stroke || drag || ruler) return false;
    const world = screenToWorld(board.camera, point);
    switch (board.tool) {
      case "select":
        if (startDrag(pointerId, world)) return true;
        if (board.selection) {
          board.selection = null;
          hooks.redraw();
        }
        panPointer = { id: pointerId, last: point };
        updateCursor();
        return true;
      case "walls":
        if (shift) {
          enclose(world);
          return false;
        }
        startStroke(pointerId, world);
        return true;
      case "tokens":
        placeToken(world);
        return false;
      case "objects":
        placeObject(world);
        return false;
      case "ping":
        hooks.ping(world);
        return false;
      case "ruler": {
        const cell = cellAt(world);
        ruler = { pointerId, from: cell, to: cell };
        hooks.redraw();
        return true;
      }
      default:
        startStroke(pointerId, world);
        return true;
    }
  };

  const pinchOf = (): Pinch => {
    const [a, b] = [...touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const point = screenPoint(e);
    let capture: boolean;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, point);
      capture = true;
      if (touches.size === 2) {
        cancelGesture();
        panPointer = null;
        pinch = pinchOf();
      } else if (touches.size === 1 && !spaceHeld) {
        press(e.pointerId, point, false);
      }
    } else if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      panPointer = { id: e.pointerId, last: point };
      updateCursor();
      capture = true;
    } else if (e.button === 0) {
      capture = press(e.pointerId, point, e.shiftKey);
    } else {
      capture = false;
    }
    if (capture) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    const point = screenPoint(e);
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, point);
      if (pinch && touches.size === 2) {
        const next = pinchOf();
        const moved = panBy(board.camera, next.mid.x - pinch.mid.x, next.mid.y - pinch.mid.y);
        board.camera = zoomAt(moved, next.mid, pinch.distance > 0 ? next.distance / pinch.distance : 1);
        pinch = next;
        hooks.redraw();
        return;
      }
    }
    if (panPointer && panPointer.id === e.pointerId) {
      board.camera = panBy(board.camera, point.x - panPointer.last.x, point.y - panPointer.last.y);
      panPointer.last = point;
    }
    const world = screenToWorld(board.camera, point);
    if (e.pointerType !== "touch") {
      board.hover = world;
      hooks.hoverChanged();
    }
    if (stroke && stroke.pointerId === e.pointerId) continueStroke(world);
    if (drag && drag.pointerId === e.pointerId) continueDrag(world);
    if (ruler && ruler.pointerId === e.pointerId) ruler.to = cellAt(world);
    hooks.redraw();
  });

  // Keeps the browser from starting its own autoscroll on the middle button.
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener("dblclick", (e) => {
    if (board.tool !== "select") return;
    const id = tokenAt(board.scene, screenToWorld(board.camera, screenPoint(e)));
    if (id !== null) hooks.editToken(id);
  });

  // Release ends a stroke or a drag as a change; a cancelled pointer (the browser took it away) takes it back.
  const release = (e: PointerEvent, cancelled: boolean): void => {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    }
    if (panPointer && panPointer.id === e.pointerId) {
      panPointer = null;
      updateCursor();
    }
    if (ruler && ruler.pointerId === e.pointerId) {
      ruler = null;
      hooks.redraw();
    }
    const mine = (stroke && stroke.pointerId === e.pointerId) || (drag && drag.pointerId === e.pointerId);
    if (!mine) return;
    if (cancelled) cancelGesture();
    else if (stroke) finishStroke();
    else finishDrag();
  };
  canvas.addEventListener("pointerup", (e) => release(e, false));
  canvas.addEventListener("pointercancel", (e) => release(e, true));

  canvas.addEventListener("pointerleave", () => {
    board.hover = null;
    hooks.hoverChanged();
    hooks.redraw();
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const point = screenPoint(e);
      if (wheelGesture(e) === "pan") {
        // Two-finger trackpad scroll: always in pixels, the map moves against the scroll like a page.
        board.camera = panBy(board.camera, -e.deltaX, -e.deltaY);
      } else {
        const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1;
        const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM));
        board.camera = zoomAt(board.camera, point, factor);
      }
      board.hover = screenToWorld(board.camera, point);
      hooks.hoverChanged();
      hooks.redraw();
    },
    { passive: false },
  );

  // Keys by physical position (e.code), so shortcuts work in any keyboard layout.
  window.addEventListener("keydown", (e) => {
    if (isTextEntry(e.target) || isInDialog(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === "Space") {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        updateCursor();
      }
    } else if (mod && (e.code === "KeyZ" || e.code === "KeyY")) {
      e.preventDefault();
      if (e.code === "KeyY" || e.shiftKey) hooks.redo();
      else hooks.undo();
    } else if (!mod && (e.code === "Delete" || e.code === "Backspace")) {
      // Backspace too: the Mac keyboard names it Delete.
      e.preventDefault();
      deleteSelection();
    } else if (!mod && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      const index = BRUSH_SIZES.indexOf(board.brushSize) + (e.code === "BracketLeft" ? -1 : 1);
      const size = BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, Math.max(0, index))];
      if (size === board.brushSize) return;
      board.brushSize = size;
      hooks.brushSizeChanged();
      hooks.redraw();
    } else if (!mod && !e.altKey && Object.hasOwn(TOOL_KEYS, e.code)) {
      const tool = TOOL_KEYS[e.code];
      if (tool === board.tool) return;
      board.tool = tool;
      hooks.toolChanged();
      hooks.redraw();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || isTextEntry(e.target)) return;
    // Keeps a focused toolbar button from being pressed by the space bar; in the token editor it presses buttons as usual.
    if (!isInDialog(e.target)) e.preventDefault();
    spaceHeld = false;
    updateCursor();
  });

  window.addEventListener("blur", () => {
    spaceHeld = false;
    updateCursor();
  });

  updateCursor();

  const selectionOverlay = (): BoardOverlay | null => {
    const selection = board.selection;
    if (!selection) return null;
    if (selection.collection === "objects") {
      const item = board.scene.objects[selection.id];
      return isMapObject(item) ? { kind: "selected", square: { x: item.x, y: item.y, size: 1 } } : null;
    }
    const placed = tokenLayout(board.scene).find((entry) => entry.id === selection.id);
    return placed ? { kind: "selected", square: placed.square } : null;
  };

  const hoverOverlay = (): BoardOverlay | null => {
    if (!board.hover || stroke || drag || ruler) return null;
    if (board.tool === "brush" || board.tool === "eraser") return { kind: "square", square: brushSquare(board.hover, board.brushSize) };
    if (board.tool === "walls") return { kind: "edge", key: nearestEdge(board.hover) };
    const cell = cellAt(board.hover);
    if (board.tool === "objects") return { kind: "square", square: { ...cell, size: 1 } };
    if (board.tool === "tokens") return { kind: "square", square: { ...cell, size: sizeSpan(board.tokenDraft.size) } };
    return null;
  };

  return {
    overlays(): BoardOverlay[] {
      const overlays: BoardOverlay[] = [];
      const selected = selectionOverlay();
      if (selected) overlays.push(selected);
      if (stroke && (stroke.tool === "fill" || stroke.tool === "room")) overlays.push({ kind: "outline", points: stroke.points });
      if (stroke?.tool === "pencil") overlays.push({ kind: "mark", color: board.markColor, points: stroke.mark });
      if (ruler) {
        const label = hooks.rulerLabel(distance(ruler.from, ruler.to, diagonalRule(board.scene)));
        overlays.push({ kind: "ruler", from: ruler.from, to: ruler.to, label });
      }
      if (drag?.kind === "token" && drag.places.length > 1) {
        const label = hooks.costLabel(pathCost(board.scene.cells, drag.places, drag.span, diagonalRule(board.scene)));
        overlays.push({ kind: "path", places: drag.places, span: drag.span, label });
      }
      const hover = hoverOverlay();
      if (hover) overlays.push(hover);
      return overlays;
    },
  };
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Keys pressed in an open dialog (the token editor) belong to it, not to the board. */
function isInDialog(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("dialog") !== null;
}
