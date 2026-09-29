// Board input: camera (mouse wheel and trackpad, space or middle button drag, two fingers) and the terrain brush.

import type { TerrainId } from "./catalog.ts";
import {
  brushSquare,
  cellKey,
  cellsOfSquare,
  isCellInRange,
  panBy,
  pointsAlong,
  screenToWorld,
  wheelGesture,
  zoomAt,
} from "./geometry.ts";
import type { Camera, Point } from "./geometry.ts";
import { applyToChange, beginChange, cancelChange, finishChange } from "./store.ts";
import type { History, Patch, Scene } from "./store.ts";

export const BRUSH_SIZES = [1, 2, 3] as const;
type BrushSize = (typeof BRUSH_SIZES)[number];

export interface Board {
  scene: Scene;
  history: History;
  camera: Camera;
  terrain: TerrainId;
  brushSize: BrushSize;
  /** World point under the mouse or pen, null when it is off the board. */
  hover: Point | null;
}

interface ToolHooks {
  /** The picture changed: camera, brush outline or cells in a stroke under way. */
  redraw(): void;
  /** A finished change entered the history. */
  committed(): void;
  hoverChanged(): void;
  brushSizeChanged(): void;
  undo(): void;
  redo(): void;
}

/** Distance between brush samples along a stroke, in cells. */
const STROKE_STEP = 0.25;
/** Zoom speed per wheel pixel: plain wheel and trackpad pinch (sent as wheel with Ctrl). */
const WHEEL_ZOOM = 0.0015;
const PINCH_ZOOM = 0.01;
const LINE_HEIGHT_PX = 16;

interface Stroke {
  pointerId: number;
  last: Point;
}

interface Pinch {
  mid: Point;
  distance: number;
}

export function attachTools(canvas: HTMLCanvasElement, board: Board, hooks: ToolHooks): void {
  let spaceHeld = false;
  let panPointer: { id: number; last: Point } | null = null;
  let stroke: Stroke | null = null;
  let pinch: Pinch | null = null;
  const touches = new Map<number, Point>();

  const screenPoint = (e: PointerEvent | WheelEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const updateCursor = (): void => {
    canvas.style.cursor = panPointer ? "grabbing" : spaceHeld ? "grab" : "crosshair";
  };

  const paintSquareAt = (world: Point): void => {
    if (!stroke) return;
    const patch: Patch = [];
    for (const { x, y } of cellsOfSquare(brushSquare(world, board.brushSize))) {
      const key = cellKey(x, y);
      if (isCellInRange(x, y) && board.scene.cells[key] !== board.terrain) patch.push(["cells", key, board.terrain]);
    }
    if (patch.length === 0) return;
    applyToChange(board.scene, board.history, patch);
    hooks.redraw();
  };

  // One stroke, from press to release, is one change and one undo step; undo and redo wait for its end.
  const startStroke = (pointerId: number, world: Point): void => {
    if (stroke) return;
    beginChange(board.history);
    stroke = { pointerId, last: world };
    paintSquareAt(world);
  };

  const continueStroke = (world: Point): void => {
    if (!stroke) return;
    for (const point of pointsAlong(stroke.last, world, STROKE_STEP)) paintSquareAt(point);
    stroke.last = world;
  };

  const finishStroke = (): void => {
    if (!stroke) return;
    stroke = null;
    if (finishChange(board.history)) hooks.committed();
  };

  // A second finger turns a stroke into a pinch: the cells painted by the first finger are taken back.
  const cancelStroke = (): void => {
    if (!stroke) return;
    cancelChange(board.scene, board.history);
    stroke = null;
    hooks.redraw();
  };

  const pinchOf = (): Pinch => {
    const [a, b] = [...touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  canvas.addEventListener("pointerdown", (e) => {
    const point = screenPoint(e);
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, point);
      if (touches.size === 2) {
        cancelStroke();
        pinch = pinchOf();
      } else if (touches.size === 1 && !spaceHeld) {
        startStroke(e.pointerId, screenToWorld(board.camera, point));
      }
    } else if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      panPointer = { id: e.pointerId, last: point };
      updateCursor();
    } else if (e.button === 0) {
      startStroke(e.pointerId, screenToWorld(board.camera, point));
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
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
    hooks.redraw();
  });

  // Keeps the browser from starting its own autoscroll on the middle button.
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  const release = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    }
    if (panPointer && panPointer.id === e.pointerId) {
      panPointer = null;
      updateCursor();
    }
    if (stroke && stroke.pointerId === e.pointerId) finishStroke();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

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
    if (isTextEntry(e.target)) return;
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
    } else if (!mod && (e.code === "BracketLeft" || e.code === "BracketRight")) {
      const index = BRUSH_SIZES.indexOf(board.brushSize) + (e.code === "BracketLeft" ? -1 : 1);
      const size = BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, Math.max(0, index))];
      if (size === board.brushSize) return;
      board.brushSize = size;
      hooks.brushSizeChanged();
      hooks.redraw();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || isTextEntry(e.target)) return;
    e.preventDefault(); // keeps a focused button from being pressed by the space bar
    spaceHeld = false;
    updateCursor();
  });

  window.addEventListener("blur", () => {
    spaceHeld = false;
    updateCursor();
  });

  updateCursor();
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
