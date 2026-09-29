// Password hashes (plan 5.10): scrypt with a 16-byte salt, compared with timingSafeEqual.
// The scrypt parameters are stored next to each hash, so they can be raised later without a migration:
// a password made with older parameters is hashed again at the next successful sign-in.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import type { StoredPassword } from "./db.ts";

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Parameters for new hashes. */
const CURRENT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

const SALT_BYTES = 16;
const HASH_BYTES = 64;

const formatParams = ({ N, r, p }: ScryptParams): string => `scrypt:${N}:${r}:${p}`;

function parseParams(text: string): ScryptParams {
  const match = /^scrypt:(\d+):(\d+):(\d+)$/.exec(text);
  const [N, r, p] = match ? match.slice(1).map(Number) : [];
  if (!match || N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) throw new Error(`unknown password parameters "${text}"`);
  return { N, r, p };
}

function derive(password: string, salt: Uint8Array, { N, r, p }: ScryptParams): Promise<Buffer> {
  // Asynchronous: scrypt runs in the thread pool and does not stop other requests.
  // scrypt needs about 128 * N * r bytes; twice that leaves room (the default limit is exactly 32 MiB).
  const options = { N, r, p, maxmem: 256 * N * r * p };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFC"), salt, HASH_BYTES, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<StoredPassword> {
  const passSalt = randomBytes(SALT_BYTES);
  return { passHash: await derive(password, passSalt, CURRENT), passSalt, passParams: formatParams(CURRENT) };
}

export async function passwordMatches(password: string, stored: StoredPassword): Promise<boolean> {
  const actual = await derive(password, stored.passSalt, parseParams(stored.passParams));
  return actual.length === stored.passHash.length && timingSafeEqual(actual, stored.passHash);
}

/** False for a hash made with older parameters. */
export function isCurrent(stored: StoredPassword): boolean {
  return stored.passParams === formatParams(CURRENT);
}

/** A hash of a password nobody knows: checked when the login does not exist, so both cases take as long. */
export function decoyPassword(): StoredPassword {
  return { passHash: randomBytes(HASH_BYTES), passSalt: randomBytes(SALT_BYTES), passParams: formatParams(CURRENT) };
}
