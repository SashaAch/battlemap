// The QR encoder of the invite (client/src/app/qr.ts, plan 8.26): known vectors of ISO/IEC 18004:2015, whole
// symbols compared module by module with a published reference, and the capacity of versions 1..10 at level M.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  alphaExponent,
  byteCapacity,
  encodeQr,
  errorCorrection,
  formatBits,
  generatorPolynomial,
  QR_MAX_VERSION,
  QrTooLongError,
  versionBits,
} from "../client/src/app/qr.ts";

describe("known vectors of the standard", () => {
  test("the Reed-Solomon generator polynomials of level M, as exponents of α (ISO/IEC 18004 Annex A)", () => {
    const annexA: Record<number, number[]> = {
      10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
      16: [0, 120, 104, 107, 109, 102, 161, 76, 3, 91, 191, 147, 169, 182, 194, 225, 120],
      18: [0, 215, 234, 158, 94, 184, 97, 118, 170, 79, 187, 152, 148, 252, 179, 5, 98, 96, 153],
      22: [0, 210, 171, 247, 242, 93, 230, 14, 109, 221, 53, 200, 74, 8, 172, 98, 80, 219, 134, 160, 105, 165, 231],
      24: [0, 229, 121, 135, 48, 211, 117, 251, 126, 159, 180, 169, 152, 192, 226, 228, 218, 111, 0, 117, 232, 87, 96, 227, 21],
      26: [0, 173, 125, 158, 2, 103, 182, 118, 17, 145, 201, 111, 28, 165, 53, 161, 21, 245, 142, 13, 102, 48, 227, 153, 145, 218, 70],
    };
    for (const [degree, exponents] of Object.entries(annexA)) {
      assert.deepEqual(generatorPolynomial(Number(degree)).map(alphaExponent), exponents, `degree ${degree}`);
    }
  });

  test("error correction codewords of published examples", () => {
    // ISO/IEC 18004 Annex I: "01234567" in numeric mode, version 1-M, 16 data codewords and 10 for correction.
    const annexI = [0b00010000, 0b00100000, 0b00001100, 0b01010110, 0b01100001, 0b10000000, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
    assert.deepEqual(errorCorrection(annexI, 10), [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]);
    // thonky.com QR Code Tutorial: "HELLO WORLD" in version 1-Q, 13 data codewords and 13 for correction.
    const helloWorld = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
    assert.deepEqual(errorCorrection(helloWorld, 13), [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16]);
  });

  test("the format information of level M for every mask (Annex C, Table C.1)", () => {
    const tableC1 = [
      "101010000010010",
      "101000100100101",
      "101111001111100",
      "101101101001011",
      "100010111111001",
      "100000011001110",
      "100111110010111",
      "100101010100000",
    ];
    tableC1.forEach((bits, mask) => assert.equal(formatBits(mask).toString(2).padStart(15, "0"), bits, `mask ${mask}`));
  });

  test("the version information of versions 7..10 (Annex D, Table D.1)", () => {
    const tableD1: Record<number, string> = {
      7: "000111110010010100",
      8: "001000010110111100",
      9: "001001101010011001",
      10: "001010010011010011",
    };
    for (const [version, bits] of Object.entries(tableD1)) {
      assert.equal(versionBits(Number(version)).toString(2).padStart(18, "0"), bits, `version ${version}`);
    }
  });
});

/** Rows of the symbol as text: "#" dark, "." light. */
const picture = (modules: boolean[][]): string[] => modules.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

describe("whole symbols", () => {
  // Made by Project Nayuki's QR Code generator library (qrcodegen.js on https://www.nayuki.io/page/qr-code-generator-library,
  // 2026-09-29): QrCode.encodeSegments([QrSegment.makeBytes(<UTF-8>)], Ecc.MEDIUM, 1, 10, -1, false), that is
  // byte mode, level M, versions 1..10, the mask chosen by the penalty rules, no raising of the level.
  const references: { text: string; version: number; mask: number; rows: string[] }[] = [
    {
      text: "http://192.168.0.44:8080/#join=abcdefghijkmnpqr",
      version: 4,
      mask: 2,
      rows: [
        "#######.........#..#.####.#######",
        "#.....#..####..##.#..#..#.#.....#",
        "#.###.#.##..#.##.....#.#..#.###.#",
        "#.###.#.##..#.....##..#...#.###.#",
        "#.###.#.#.#..####...#.##..#.###.#",
        "#.....#.##.####...##.#..#.#.....#",
        "#######.#.#.#.#.#.#.#.#.#.#######",
        "........#...#...#.####.#.........",
        "#.#####..##.##...####..#..#####..",
        "######..###.###.##.#.#.#####.##.#",
        "#..#..##..#..#####...#....#.#.##.",
        "##.#.#.##.####..####.##.#...###.#",
        "#.#.#.#.##.##.#.#..##.#.##.###...",
        "##..#...####...#.##...##..#...###",
        "#....##...###.###.#.#.#.....##.#.",
        "##.#...#..#.#.##..#..#...#...##..",
        ".#....#.#..#...#.##.#..#...##...#",
        "..#.#...#..##...#..#.#######.##.#",
        "###.####.#...###..#.....#.#.#.##.",
        "#..##..#..#..#......##.#.#..####.",
        ".#.####...........#..#.###.###...",
        "####......#....##...##.#..#..##.#",
        "#.#.#.#...#..##...##.#....###.##.",
        "#...#..#.##.....#.####.###...####",
        "#.##.######..##..####..######..##",
        "........#.......####....#...#.#.#",
        "#######...#.#.####....###.#.#.##.",
        "#.....#.#..#.#...##.#...#...#.##.",
        "#.###.#.#....#.##...###.######.##",
        "#.###.#.#.#....#.##........####.#",
        "#.###.#.##.#.#####..#.#.####.##..",
        "#.....#.....#.##.....#....#####..",
        "#######.##.....#.##.#..##.###..#.",
      ],
    },
    {
      // Cyrillic letters are two bytes of UTF-8; version 9 has two groups of blocks and the version information.
      text: "Приглашение в игру «Склеп»: http://192.168.1.20:8080/#join=k7m2p9q4r8s3t6vw, до встречи за столом в пятницу!",
      version: 9,
      mask: 2,
      rows: [
        "#######..#...##....###.#.##.#.##.##.#....##...#######",
        "#.....#..#.....#..#..#....####..#.#.##.#..##..#.....#",
        "#.###.#.##..###.#.##...#.###.#####..#.#.##.#..#.###.#",
        "#.###.#.#..#....#..####....#....##.#...####.#.#.###.#",
        "#.###.#.#...#.######.#..#######..#...###..#...#.###.#",
        "#.....#.##.##.#..#..##..#...##....##.#.#.##...#.....#",
        "#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#######",
        "........#.##.#...###.##.#...#.##.#..#.#.#.##.........",
        "#.#####..#...##.##...#.######.#..##...##..#...#####..",
        "#...##....####........#.#......#.#.##.......###.#.#..",
        ".#..#.#.###.#.##.#..##......##....#.#.#.##.#..#.#####",
        "#....#...##.##########..#.##.#.#.#.#....###..#######.",
        "##....##.###.#.###.#..#..###...##..##.##.##.####.#.#.",
        "..#....#..###...#.##...#..#.##..#.#.##..##.#..###....",
        ".##...##.#.#####.#.###.#...#..###..#########...#....#",
        "#.###..####..#...#.#.#..#..##.####.#.#.#.#..##..#...#",
        "#..#..#.#.##.#.#..##..#...#........######..##.#..##.#",
        "###....#..#..#####.##..#......#..#..###...#.#..##..#.",
        "##.##.#........##..#.#.##...#..#...###.#.#...##.##.##",
        "#.##.#..#.#..#.##.#....#..##..##########.##..#...##..",
        "....#######.##.#.#...#..#####....#.#..#.##.#.#..##.#.",
        "##..#...#..##..#.#.#....###...##..########.##.##....#",
        ".##..####.##..#...#..#.##..#.......#....#####..#.#.#.",
        ".#.#.#.#.#..###..#....#.#....###.####.....#..#.#..##.",
        "##.######....#.....###.######..####.#...###.#####..##",
        "..#.#...#.......#.#.###.#...###..#.##.##....#...#####",
        "..###.#.#..##.#..##.##..#.#.##...##.####..#.#.#.#####",
        "#...#...#.###.####...#..#...#....####..##..##...#####",
        "##..######.##.#.#.#.##.#######.###.#.....#.#######.#.",
        "#.###...#..#..###.#.#.###.##.#..#...##..##...#.......",
        "##...#####....##..##.#.##....####.#.#.#..##.###.#...#",
        "...#.#...##..#.#....##..##..#.####.#....#.#.#.#.#.##.",
        "..#.#.##..#####..###.##....####.#...#..##.#######.#.#",
        "###..#....#...##.####.####..#.#..####..##...##.#..##.",
        "##.##.#.##...#.#.###.#.##..####..#..####.#....#.#..##",
        "#.###....######..##.##..####..###.##.....#.##...#....",
        "####..#.###.####.#.####.####..##.####...###.##.#.###.",
        ".##.....###.#.###.#...####..##.##.#.#.##.#####.......",
        "####.##.####.#####.#..#..##.###..#.#####...####.##..#",
        ".##.#....##...#..##.###.#.##.#.###.#...#..#.#.#.#.###",
        "####..######..#...#.#.#.#........#...#.#..#######..#.",
        ".###.#....###.#...####..####..#####.#......#.###....#",
        "##.######..##.####....##.#..##.##.#.##.#.#.##.....##.",
        ".##.....#..#.#...#.##.#.#..####.#.#.##.##.##.##.#####",
        "...#..##.##..##.##.#..#.######....##.#.#.#.#######.##",
        "........####.####.#.....#...#.##.#...###..#.#...#..#.",
        "#######....#...##....#..#.#.#..#.###.#.##...#.#.##..#",
        "#.....#.#.#....#.#.##..##...#.##.#....#.#.#.#...#.##.",
        "#.###.#.#.###..#.#.###.######.#...#.#..#..#.#####..#.",
        "#.###.#.#.....#..####....###...#.#..##..#..#.#.......",
        "#.###.#.#....##.....##.#.#.#.#....#.######.###..##.##",
        "#.....#...#####..#.....##..#.#.#.#.#..##.#...##.####.",
        "#######.#.###...##..#.##....#..#######..##..#.#.##...",
      ],
    },
  ];

  for (const reference of references) {
    test(`version ${reference.version}: the same modules and mask as the reference`, () => {
      const code = encodeQr(reference.text);
      assert.equal(code.version, reference.version);
      assert.equal(code.size, 17 + 4 * reference.version);
      assert.equal(code.mask, reference.mask);
      assert.deepEqual(picture(code.modules), reference.rows);
    });
  }

  test("a forced mask is used, and both copies of the format information name it", () => {
    for (let mask = 0; mask < 8; mask++) {
      const { modules, size } = encodeQr("battlemap", mask);
      const bit = (x: number, y: number): number => (modules[y][x] ? 1 : 0);
      // Bits 14..0 of the first copy (around the top left finder) and of the second (top right and bottom left).
      const first = [
        ...[0, 1, 2, 3, 4, 5].map((x) => bit(x, 8)),
        bit(7, 8),
        bit(8, 8),
        bit(8, 7),
        ...[5, 4, 3, 2, 1, 0].map((y) => bit(8, y)),
      ];
      const second = [
        ...[1, 2, 3, 4, 5, 6, 7].map((i) => bit(8, size - i)),
        ...[8, 7, 6, 5, 4, 3, 2, 1].map((i) => bit(size - i, 8)),
      ];
      const expected = formatBits(mask).toString(2).padStart(15, "0");
      assert.equal(first.join(""), expected, `first copy, mask ${mask}`);
      assert.equal(second.join(""), expected, `second copy, mask ${mask}`);
      assert.equal(bit(8, size - 8), 1, "the dark module");
    }
  });
});

describe("capacity of versions 1..10 at level M", () => {
  test("the byte capacities of Table 7", () => {
    assert.deepEqual(
      Array.from({ length: QR_MAX_VERSION }, (_, index) => byteCapacity(index + 1)),
      [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
    );
  });

  test("a text at the limit of a version takes that version, one byte more the next", () => {
    for (let version = 1; version <= QR_MAX_VERSION; version++) {
      const limit = byteCapacity(version);
      assert.equal(encodeQr("a".repeat(limit)).version, version, `${limit} bytes`);
      if (version < QR_MAX_VERSION) assert.equal(encodeQr("a".repeat(limit + 1)).version, version + 1, `${limit + 1} bytes`);
    }
  });

  test("the capacity counts bytes of UTF-8, not characters", () => {
    assert.equal(encodeQr("я".repeat(7)).version, 1);
    assert.equal(encodeQr(`${"я".repeat(7)}a`).version, 2);
  });

  test("past version 10 the text is refused with a clear error, not a broken code", () => {
    assert.throws(() => encodeQr("a".repeat(214)), QrTooLongError);
    assert.throws(() => encodeQr("я".repeat(107)), /214 bytes in UTF-8.*at most 213/);
  });

  test("an empty text is a code too", () => {
    assert.equal(encodeQr("").version, 1);
  });
});
