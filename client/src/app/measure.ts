// Measuring the delay from the master to a player in a home network (R42), turned on by `?measure` in the address.
// A phone and a computer do not share a clock to the millisecond, so the time is measured there and back on the
// master's side: the player's board, once it has drawn a change from someone else, puts a ping in cell 0,0 at once,
// and the master's board counts from sending its change to that ping.

import type { Point } from "../board/geometry.ts";

/** The middle of cell 0,0, where the player's board puts its answer. */
export const ECHO_POINT: Point = { x: 0.5, y: 0.5 };
/** A change with no answer within this time is taken as lost (a ping over the limit of 5 a second reaches nobody). */
export const LOST_MS = 5000;

/** Whether the address asks for measuring: `measure` among the parameters after `?`. */
export function measuring(search: string): boolean {
  return new URLSearchParams(search).has("measure");
}

/** The middle value; the mean of the two middle ones for an even count. NaN for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The player's side: a change from someone else was applied; when measuring, a ping follows on the next frame. */
export function echoChange(on: boolean, nextFrame: (callback: () => void) => void, ping: (point: Point) => void): void {
  if (on) nextFrame(() => ping(ECHO_POINT));
}

export interface RoundTripSummary {
  count: number;
  median: number;
  worst: number;
}

/** The master's side: changes sent and the answers to them, paired in order. */
export class RoundTrips {
  /** When each change not answered yet was sent (performance.now()). */
  readonly #waiting: number[] = [];
  readonly #times: number[] = [];

  sent(at: number): void {
    this.#waiting.push(at);
  }

  /** An answer came at `at`: pairs with the oldest change still waiting; returns the time there and back, null for none. */
  answered(at: number): number | null {
    while (this.#waiting.length > 0 && at - this.#waiting[0] > LOST_MS) this.#waiting.shift();
    const start = this.#waiting.shift();
    if (start === undefined) return null;
    const time = at - start;
    this.#times.push(time);
    return time;
  }

  summary(): RoundTripSummary {
    return { count: this.#times.length, median: median(this.#times), worst: Math.max(...this.#times) };
  }
}
