// Vector signs of the objects (plan 8.3): canvas paths in a unit cell, not a font or pictures,
// so they look the same in every theme and on every system.

import { OBJECT_COLORS } from "./catalog.ts";
import type { ObjectType } from "./catalog.ts";

const C = OBJECT_COLORS;

/** Draws a sign in a cell of `size` pixels whose top-left corner is `x`,`y` on the screen. */
export function drawObjectSign(ctx: CanvasRenderingContext2D, type: ObjectType, x: number, y: number, size: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.lineWidth = Math.max(1, size * 0.04) / size;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = C.ink;
  SIGNS[type](ctx);
  ctx.restore();
}

type Sign = (ctx: CanvasRenderingContext2D) => void;

function shape(ctx: CanvasRenderingContext2D, fill: string, path: () => void): void {
  ctx.beginPath();
  path();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

function lines(ctx: CanvasRenderingContext2D, segments: readonly [number, number, number, number][]): void {
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
}

const circle = (ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) => (): void => {
  ctx.moveTo(cx + r, cy);
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
};

const rect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => (): void => {
  ctx.rect(x, y, w, h);
};

const polygon = (ctx: CanvasRenderingContext2D, points: readonly [number, number][]) => (): void => {
  for (const [px, py] of points) ctx.lineTo(px, py);
  ctx.closePath();
};

const SIGNS: Record<ObjectType, Sign> = {
  pillar(ctx) {
    shape(ctx, C.stone, circle(ctx, 0.5, 0.5, 0.32));
    shape(ctx, C.stone, circle(ctx, 0.5, 0.5, 0.2));
  },
  stairs(ctx) {
    shape(ctx, C.stone, rect(ctx, 0.15, 0.12, 0.7, 0.76));
    lines(ctx, [0.28, 0.42, 0.56, 0.7].map((sy): [number, number, number, number] => [0.15, sy, 0.85, sy]));
  },
  trapdoor(ctx) {
    shape(ctx, C.wood, rect(ctx, 0.18, 0.18, 0.64, 0.64));
    lines(ctx, [[0.18, 0.3, 0.82, 0.3]]);
    ctx.beginPath();
    circle(ctx, 0.5, 0.64, 0.07)();
    ctx.stroke();
  },
  pit(ctx) {
    shape(ctx, C.hole, rect(ctx, 0.15, 0.15, 0.7, 0.7));
    ctx.save();
    ctx.strokeStyle = C.stone;
    lines(ctx, [
      [0.15, 0.15, 0.85, 0.85],
      [0.85, 0.15, 0.15, 0.85],
    ]);
    ctx.restore();
  },
  statue(ctx) {
    shape(ctx, C.stone, rect(ctx, 0.2, 0.2, 0.6, 0.6));
    shape(ctx, C.cloth, polygon(ctx, [[0.5, 0.26], [0.57, 0.42], [0.74, 0.43], [0.61, 0.54], [0.65, 0.72], [0.5, 0.62], [0.35, 0.72], [0.39, 0.54], [0.26, 0.43], [0.43, 0.42]]));
  },
  tree(ctx) {
    shape(ctx, C.leaf, () => {
      const lobes = 7;
      for (let i = 0; i < lobes; i++) {
        const a = (2 * Math.PI * i) / lobes;
        const cx = 0.5 + Math.cos(a) * 0.27;
        const cy = 0.5 + Math.sin(a) * 0.27;
        ctx.moveTo(cx + 0.14, cy);
        ctx.arc(cx, cy, 0.14, 0, 2 * Math.PI);
      }
    });
    shape(ctx, C.leaf, circle(ctx, 0.5, 0.5, 0.26));
    shape(ctx, C.wood, circle(ctx, 0.5, 0.5, 0.07));
  },
  boulder(ctx) {
    shape(ctx, C.stone, polygon(ctx, [[0.3, 0.2], [0.62, 0.16], [0.83, 0.38], [0.78, 0.7], [0.55, 0.84], [0.26, 0.76], [0.16, 0.48]]));
    lines(ctx, [[0.42, 0.4, 0.58, 0.5]]);
  },
  crate(ctx) {
    shape(ctx, C.wood, rect(ctx, 0.18, 0.18, 0.64, 0.64));
    lines(ctx, [
      [0.18, 0.18, 0.82, 0.82],
      [0.82, 0.18, 0.18, 0.82],
    ]);
  },
  barrel(ctx) {
    shape(ctx, C.wood, circle(ctx, 0.5, 0.5, 0.32));
    ctx.beginPath();
    circle(ctx, 0.5, 0.5, 0.22)();
    ctx.stroke();
    shape(ctx, C.wood, circle(ctx, 0.5, 0.5, 0.06));
  },
  chest(ctx) {
    shape(ctx, C.wood, rect(ctx, 0.14, 0.26, 0.72, 0.48));
    lines(ctx, [[0.14, 0.42, 0.86, 0.42]]);
    shape(ctx, C.flame, rect(ctx, 0.44, 0.36, 0.12, 0.13));
  },
  table(ctx) {
    shape(ctx, C.wood, rect(ctx, 0.1, 0.24, 0.8, 0.52));
    lines(ctx, [[0.16, 0.5, 0.84, 0.5]]);
  },
  bed(ctx) {
    shape(ctx, C.wood, rect(ctx, 0.24, 0.08, 0.52, 0.84));
    shape(ctx, C.cloth, rect(ctx, 0.3, 0.14, 0.4, 0.16));
    shape(ctx, C.danger, rect(ctx, 0.24, 0.4, 0.52, 0.52));
  },
  campfire(ctx) {
    const stones = 8;
    for (let i = 0; i < stones; i++) {
      const a = (2 * Math.PI * i) / stones;
      shape(ctx, C.stone, circle(ctx, 0.5 + Math.cos(a) * 0.32, 0.5 + Math.sin(a) * 0.32, 0.07));
    }
    shape(ctx, C.fire, polygon(ctx, [[0.5, 0.24], [0.66, 0.5], [0.62, 0.68], [0.5, 0.74], [0.38, 0.68], [0.34, 0.5]]));
    shape(ctx, C.flame, polygon(ctx, [[0.5, 0.42], [0.58, 0.58], [0.5, 0.68], [0.42, 0.58]]));
  },
  altar(ctx) {
    shape(ctx, C.stone, rect(ctx, 0.12, 0.3, 0.76, 0.4));
    shape(ctx, C.cloth, rect(ctx, 0.12, 0.44, 0.76, 0.12));
    shape(ctx, C.flame, circle(ctx, 0.24, 0.37, 0.05));
    shape(ctx, C.flame, circle(ctx, 0.76, 0.37, 0.05));
  },
  trap(ctx) {
    shape(ctx, C.flame, polygon(ctx, [[0.5, 0.14], [0.88, 0.82], [0.12, 0.82]]));
    ctx.save();
    ctx.strokeStyle = C.danger;
    ctx.lineWidth *= 2;
    lines(ctx, [[0.5, 0.38, 0.5, 0.6]]);
    ctx.restore();
    ctx.beginPath();
    circle(ctx, 0.5, 0.71, 0.04)();
    ctx.fillStyle = C.danger;
    ctx.fill();
  },
};
