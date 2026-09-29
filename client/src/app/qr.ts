// A QR Code encoder after ISO/IEC 18004:2015 (plan 8.26, R43): byte mode with the text as UTF-8, error correction
// level M, versions 1..10, the mask chosen by the four penalty rules of the standard. A pure function from a
// string to a matrix of modules, with no DOM: the page draws the matrix (invite.ts), the tests check it in Node.
// Section and table numbers below are those of ISO/IEC 18004:2015.

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 10;

/** A symbol: `modules[y][x]` is true for a dark module; row 0 is the top, column 0 the left. */
export interface QrCode {
  version: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** The mask pattern 0..7 (Table 10). */
  mask: number;
  modules: boolean[][];
}

/** The text does not fit version 10 at level M. */
export class QrTooLongError extends Error {
  constructor(bytes: number) {
    super(`the text is ${bytes} bytes in UTF-8, a QR code of version ${QR_MAX_VERSION}-M holds at most ${byteCapacity(QR_MAX_VERSION)}`);
  }
}

// ---- tables for level M (Table 9: error correction characteristics) ----

interface Blocks {
  /** Error correction codewords in every block. */
  ecPerBlock: number;
  /** Groups of blocks: how many blocks, and how many data codewords each has. */
  groups: readonly (readonly [count: number, dataCodewords: number])[];
}

/** Level M, versions 1..10 (index 0 is version 1). */
const M_BLOCKS: readonly Blocks[] = [
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
];

/** Row and column coordinates of the alignment pattern centres, versions 2..10 (Annex E, Table E.1). */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Mode indicator of the byte mode (Table 2). */
const BYTE_MODE = 0b0100;
/** Error correction level M in the format information (Table 12). */
const LEVEL_M_BITS = 0b00;
/** Pad codewords (7.4.10). */
const PAD_CODEWORDS = [0xec, 0x11];
/** Format information: BCH (15, 5) generator and the mask applied to it (7.9.1). */
const FORMAT_GENERATOR = 0x537;
const FORMAT_MASK = 0x5412;
/** Version information: BCH (18, 6) generator (7.10); versions 7 and up carry it. */
const VERSION_GENERATOR = 0x1f25;
/** Penalty points of the four rules (7.8.3.1, Table 11). */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const blocksOf = (version: number): Blocks => M_BLOCKS[version - 1];

export function dataCodewords(version: number): number {
  return blocksOf(version).groups.reduce((sum, [count, data]) => sum + count * data, 0);
}

/** Bits of the character count indicator in byte mode (Table 3). */
const countBits = (version: number): number => (version <= 9 ? 8 : 16);

/** Bytes of UTF-8 a symbol of the version holds at level M in byte mode (Table 7). */
export function byteCapacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

// ---- Reed-Solomon over GF(2^8) with the field polynomial x^8 + x^4 + x^3 + x^2 + 1 (7.5.2) ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let power = 0; power < 255; power++) {
    EXP[power] = value;
    LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let power = 255; power < 512; power++) EXP[power] = EXP[power - 255];
}

function multiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** The generator polynomial (x - α^0)(x - α^1)…(x - α^(degree-1)), coefficients from the highest power down (Annex A). */
export function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= multiply(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The exponent of α for a non-zero field element (to compare with the tables of Annex A, which list exponents). */
export const alphaExponent = (value: number): number => LOG[value];

/** The error correction codewords of a block: the remainder of data × x^degree divided by the generator. */
export function errorCorrection(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const codeword of data) {
    const factor = codeword ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let i = 0; i < degree; i++) remainder[i] ^= multiply(generator[i + 1], factor);
  }
  return remainder;
}

// ---- format and version information ----

/** The 15 bits of format information for level M and a mask, with the BCH bits and the mask 0x5412 (7.9.1). */
export function formatBits(mask: number): number {
  const data = (LEVEL_M_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * FORMAT_GENERATOR);
  return ((data << 10) | remainder) ^ FORMAT_MASK;
}

/** The 18 bits of version information (7.10), for versions 7 and up. */
export function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * VERSION_GENERATOR);
  return (version << 12) | remainder;
}

// ---- the codewords ----

/** The smallest version that holds `length` bytes, or null. */
export function versionFor(length: number): number | null {
  for (let version = QR_MIN_VERSION; version <= QR_MAX_VERSION; version++) {
    if (length <= byteCapacity(version)) return version;
  }
  return null;
}

/** Data codewords (7.4): mode, count, the bytes, terminator, zero bits to a whole byte, pad codewords. */
export function dataCodewordsFor(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(BYTE_MODE, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let i = 0; codewords.length < capacity / 8; i++) codewords.push(PAD_CODEWORDS[i % 2]);
  return codewords;
}

/** Splits the data codewords into blocks, adds the error correction of each and interleaves them (7.6). */
export function finalCodewords(data: readonly number[], version: number): number[] {
  const { ecPerBlock, groups } = blocksOf(version);
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      dataBlocks.push(data.slice(offset, offset + size));
      offset += size;
    }
  }
  const ecBlocks = dataBlocks.map((block) => errorCorrection(block, ecPerBlock));
  const result: number[] = [];
  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

// ---- the matrix ----

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  /** Modules of the function patterns and of the format and version information: data and masks leave them. */
  readonly reserved: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y][x] = dark;
    this.reserved[y][x] = true;
  }
}

/** A finder pattern centred at x, y with its separator (7.3.2, 7.3.3); modules outside the symbol are skipped. */
function drawFinder(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      matrix.set(x, y, ring !== 2 && ring !== 4);
    }
  }
}

function drawAlignment(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) matrix.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

/** Both copies of the format information (7.9.1, Figure 25); bit 0 is the least significant. */
function drawFormat(matrix: Matrix, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  const last = matrix.size - 1;
  for (let i = 0; i <= 5; i++) matrix.set(8, i, bit(i));
  matrix.set(8, 7, bit(6));
  matrix.set(8, 8, bit(7));
  matrix.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) matrix.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) matrix.set(last - i, 8, bit(i));
  for (let i = 8; i < 15; i++) matrix.set(8, matrix.size - 15 + i, bit(i));
  // The dark module (7.9.1).
  matrix.set(8, matrix.size - 8, true);
}

/** Both copies of the version information (7.10, Figure 27), for versions 7 and up. */
function drawVersion(matrix: Matrix, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix.set(a, b, dark);
    matrix.set(b, a, dark);
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const { size } = matrix;
  // Timing patterns (7.3.5), drawn first: the finders and alignment patterns overwrite their ends.
  for (let i = 0; i < size; i++) {
    matrix.set(6, i, i % 2 === 0);
    matrix.set(i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);
  const centres = ALIGNMENT_CENTRES[version - 1];
  const lastIndex = centres.length - 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      // The three corners taken by the finder patterns get no alignment pattern.
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === lastIndex) || (i === lastIndex && j === 0);
      if (!onFinder) drawAlignment(matrix, centres[i], centres[j]);
    }
  }
  // Reserved now, written for each mask.
  drawFormat(matrix, 0);
  drawVersion(matrix, version);
}

/** Puts the codewords in the zigzag of 7.7.3, from the bottom right, two columns at a time; remainder bits stay light. */
function placeCodewords(matrix: Matrix, codewords: readonly number[]): void {
  const { size } = matrix;
  const total = codewords.length * 8;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // The vertical timing pattern takes column 6 whole.
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (matrix.reserved[y][x] || index >= total) continue;
        matrix.dark[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
        index++;
      }
    }
  }
}

/** The mask conditions of Table 10, with i the row and j the column. */
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** The modules with the mask applied to everything but the reserved modules, and the format information of the mask. */
function masked(matrix: Matrix, mask: number): boolean[][] {
  const condition = MASKS[mask];
  const result = new Matrix(matrix.size);
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      result.reserved[y][x] = matrix.reserved[y][x];
      result.dark[y][x] = matrix.dark[y][x] !== (!matrix.reserved[y][x] && condition(y, x));
    }
  }
  drawFormat(result, mask);
  return result.dark;
}

// ---- mask evaluation (7.8.3) ----

/**
 * Finder-like patterns ending in a line: the runs so far, the latest first; the space outside the symbol counts
 * as light (it is the quiet zone). A pattern is dark:light:dark:light:dark in the ratio 1:1:3:1:1 with a light
 * area 4 modules wide on at least one side; one with 4 light modules on both sides counts twice.
 */
function finderPatterns(runs: readonly number[]): number {
  const n = runs[1];
  const core = n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n;
  return (core && runs[0] >= n * 4 && runs[6] >= n ? 1 : 0) + (core && runs[6] >= n * 4 && runs[0] >= n ? 1 : 0);
}

/** Penalty points of one row or column for rules 1 (runs of 5 and more) and 3 (finder-like patterns). */
function linePenalty(line: readonly boolean[]): number {
  const size = line.length;
  let points = 0;
  // Runs, the latest first; the first light run gets the quiet zone before the line added.
  const runs = [0, 0, 0, 0, 0, 0, 0];
  const pushRun = (length: number): void => {
    runs.pop();
    runs.unshift(runs.every((run) => run === 0) ? length + size : length);
  };
  let color = false;
  let length = 0;
  for (const dark of line) {
    if (dark === color) {
      length++;
      if (length === 5) points += PENALTY_N1;
      else if (length > 5) points++;
    } else {
      pushRun(length);
      if (!color) points += finderPatterns(runs) * PENALTY_N3;
      color = dark;
      length = 1;
    }
  }
  // The line ends in the quiet zone: a dark run ends, the light run after it gets the quiet zone added.
  if (color) {
    pushRun(length);
    length = 0;
  }
  pushRun(length + size);
  return points + finderPatterns(runs) * PENALTY_N3;
}

export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let points = 0;
  for (let y = 0; y < size; y++) points += linePenalty(modules[y]);
  for (let x = 0; x < size; x++) points += linePenalty(modules.map((row) => row[x]));
  // Rule 2: every 2 × 2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) points += PENALTY_N2;
    }
  }
  // Rule 4: k steps of 5 % that the share of dark modules is away from 50 %; the size is odd, so it is never 50 % exactly.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return points + k * PENALTY_N4;
}

// ---- encoding ----

/**
 * Encodes the text as UTF-8 in the smallest version 1..10 at level M. The mask is the one with the fewest penalty
 * points (the lowest number when two tie), unless `forcedMask` names one. Throws QrTooLongError past version 10.
 */
export function encodeQr(text: string, forcedMask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === null) throw new QrTooLongError(bytes.length);
  const size = 17 + 4 * version;
  const matrix = new Matrix(size);
  drawFunctionPatterns(matrix, version);
  placeCodewords(matrix, finalCodewords(dataCodewordsFor(bytes, version), version));

  if (forcedMask !== undefined) {
    if (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask >= MASKS.length) throw new RangeError(`no mask ${forcedMask}`);
    return { version, size, mask: forcedMask, modules: masked(matrix, forcedMask) };
  }
  let best: QrCode | null = null;
  let bestPoints = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    const modules = masked(matrix, mask);
    const points = penalty(modules);
    if (points < bestPoints) {
      best = { version, size, mask, modules };
      bestPoints = points;
    }
  }
  if (!best) throw new Error("no mask was evaluated");
  return best;
}
