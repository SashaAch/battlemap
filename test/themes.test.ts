// Themes of variant V (plan 8.27 item 8, R23, R45): every colour reads, text contrast by WCAG 2.1, and the colour
// helpers the board and the account settings use. That every theme has every variable is in i18n.test.ts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { isHexColor, solidHex } from "../client/src/theme.ts";

const css = readFileSync(path.join(import.meta.dirname, "..", "client", "themes.css"), "utf8");

/** The variables of each theme block in themes.css. */
const themes = new Map<string, Map<string, string>>();
for (const match of css.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
  themes.set(match[1], new Map([...match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((variable) => [variable[1], variable[2].trim()])));
}

/** Relative luminance of #rrggbb (WCAG 2.1, 1.4.3). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Text on a background as the interface has it: [text, background, where]. A see-through background is laid over
 * the page (panels) or the void (labels on the canvas) first.
 */
const PAIRS: readonly [string, string, string][] = [
  ["--ui-fg", "--ui-bg", "main text on a panel, the menu, a window, a card"],
  ["--ui-muted", "--ui-bg", "muted text on a panel: labels, the status plate, who is online"],
  ["--ui-fg", "--ui-page", "main text on the page behind the screens"],
  ["--ui-muted", "--ui-page", "muted text on the page"],
  ["--ui-accent-fg", "--ui-accent", "text on an accent button and a pressed tool"],
  ["--ui-fg", "--ui-field", "text in a field, a list and a plain button"],
  ["--ui-fg", "--ui-hover", "text on a hovered button and the chosen side of a token"],
  ["--ui-notice-fg", "--ui-notice-bg", "a notice and a note in a form"],
  ["--ui-error", "--ui-bg", "an error, «no connection», «delete the game»"],
  ["--board-label-fg", "--board-label-bg", "a label on the board: token names, the ruler, pings"],
];

const MIN_CONTRAST = 4.5;

describe("themes.css", () => {
  test("every colour is #rrggbb or rgba(r, g, b, a), as the board and the pickers read them", () => {
    for (const [name, variables] of themes) {
      for (const [variable, value] of variables) {
        if (variable.startsWith("--")) assert.doesNotThrow(() => solidHex(value, "#000000"), `${name} ${variable}: ${value}`);
      }
    }
  });

  for (const [text, background, where] of PAIRS) {
    test(`${where}: ${text} on ${background} is at least ${MIN_CONTRAST}:1 in every theme`, () => {
      for (const [name, variables] of themes) {
        const get = (variable: string): string => {
          const value = variables.get(variable);
          assert.ok(value, `${name} lacks ${variable}`);
          return value;
        };
        const under = solidHex(get(background.startsWith("--board") ? "--board-void" : "--ui-page"), "#000000");
        const back = solidHex(get(background), under);
        const ratio = contrast(solidHex(get(text), back), back);
        assert.ok(ratio >= MIN_CONTRAST, `${name}: ${text} on ${background} is ${ratio.toFixed(2)}:1`);
      }
    });
  }
});

describe("colour helpers (client/src/theme.ts)", () => {
  test("isHexColor takes #rrggbb in any case and nothing else", () => {
    for (const value of ["#000000", "#a1B2c3", "#FFFFFF"]) assert.equal(isHexColor(value), true, value);
    for (const value of ["red", "#fff", "#12345g", "#1234567", " #123456", "123456", "", null, 0x123456, ["#123456"]]) {
      assert.equal(isHexColor(value), false, String(value));
    }
  });

  test("solidHex lays a see-through colour over the one under it", () => {
    assert.equal(solidHex("#AbCdEf", "#000000"), "#abcdef");
    assert.equal(solidHex("rgba(255, 255, 255, 0.5)", "#000000"), "#808080");
    assert.equal(solidHex("rgba(0, 0, 0, 0.25)", "#ffffff"), "#bfbfbf");
    assert.equal(solidHex("rgba(10, 20, 30, 1)", "#ffffff"), "#0a141e");
    assert.throws(() => solidHex("red", "#000000"));
    assert.throws(() => solidHex("rgba(0, 0, 0, 0.5)", "black"));
  });
});