// Limits on attempts per key in a sliding window (plan 5.10, R39), and the key for a client address.

import { isIPv4, isIPv6 } from "node:net";

/** Expired keys are swept out at most this often, so a flood of new keys does not make every attempt slow. */
const SWEEP_EVERY_MS = 10_000;
/** The most keys a limiter keeps; beyond that a new key counts as used up (429), the safe side. */
export const MAX_KEYS = 100_000;

/** Counts attempts per key in a sliding window. An attempt is booked before the slow check it guards. */
export class AttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #attempts = new Map<string, number[]>();
  #sweptAt = -Infinity;

  constructor(max: number, windowMs: number, maxKeys = MAX_KEYS) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  /**
   * Books an attempt; false when the key already has `max` in the window.
   * Booking first means parallel requests cannot all pass the check before any of them is counted.
   */
  take(key: string, now: number): boolean {
    if (now - this.#sweptAt >= SWEEP_EVERY_MS) this.#sweep(now);
    const known = this.#attempts.get(key);
    if (!known && this.#attempts.size >= this.#maxKeys) return false;
    const recent = (known ?? []).filter((time) => time > now - this.#windowMs);
    this.#attempts.set(key, recent);
    if (recent.length >= this.#max) return false;
    recent.push(now);
    return true;
  }

  /** Takes back an attempt booked at `time` that turned out not to count (a right password). */
  giveBack(key: string, time: number): void {
    const list = this.#attempts.get(key);
    const index = list ? list.indexOf(time) : -1;
    if (!list || index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.#attempts.delete(key);
  }

  #sweep(now: number): void {
    this.#sweptAt = now;
    for (const [key, list] of this.#attempts) {
      if (list.every((time) => time <= now - this.#windowMs)) this.#attempts.delete(key);
    }
  }
}

/** The eight 16-bit groups of an IPv6 address, as numbers. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const embedded = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(1).map(Number);
    text = `${text.slice(0, embedded.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...gap, ...right].map((group) => parseInt(group, 16));
}

/**
 * The key an address is limited by: an IPv4 address as is (also when written as `::ffff:a.b.c.d`),
 * an IPv6 address by its /64 network, because one home or one provider customer usually gets a whole /64.
 */
export function addressKey(address: string): string {
  const plain = address.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(plain)) return plain;
  return `${ipv6Groups(plain)
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
