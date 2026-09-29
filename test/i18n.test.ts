// Languages and themes (plan 5.15).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { EDGE_TYPES, MARK_COLORS, OBJECT_TYPES, SIDES, SIZES, TERRAIN } from "../client/src/board/catalog.ts";
import { DIAGONAL_RULES } from "../client/src/board/store.ts";
import { en } from "../client/src/i18n/en.ts";
import { defaultLang, getLang, setLang, t } from "../client/src/i18n/index.ts";
import { ru } from "../client/src/i18n/ru.ts";
import { THEME_CHOICES } from "../client/src/theme.ts";

const clientDir = path.join(import.meta.dirname, "..", "client");

describe("dictionaries", () => {
  test("ru and en have the same keys", () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  });

  test("no empty strings", () => {
    for (const [name, dictionary] of Object.entries({ ru, en })) {
      for (const [key, text] of Object.entries(dictionary)) assert.ok(text.trim() !== "", `${name}: ${key} is empty`);
    }
  });

  test("every key used in index.html exists", () => {
    const html = readFileSync(path.join(clientDir, "index.html"), "utf8");
    const keys = [...html.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(keys.length > 0);
    for (const key of keys) assert.ok(Object.hasOwn(ru, key), `index.html uses unknown key ${key}`);
  });

  test("every catalog entry named in the interface has a string in both dictionaries", () => {
    const keys = [
      ...TERRAIN.map((terrain) => `terrain.${terrain.id}`),
      ...EDGE_TYPES.map((type) => `edge.${type}`),
      ...SIDES.map((side) => `side.${side.id}`),
      ...SIZES.map((size) => `size.${size.id}`),
      ...OBJECT_TYPES.map((type) => `object.${type}`),
      ...MARK_COLORS.map((color) => `color.${color.id}`),
      ...DIAGONAL_RULES.map((rule) => `diagonal.${rule}`),
    ];
    for (const key of keys) {
      assert.ok(Object.hasOwn(ru, key), `ru lacks ${key}`);
      assert.ok(Object.hasOwn(en, key), `en lacks ${key}`);
    }
  });
});

describe("t()", () => {
  test("follows the current language and fills parameters", () => {
    const before = getLang();
    try {
      setLang("ru");
      assert.equal(t("status.cell", { x: -3, y: 0 }), "Клетка -3, 0");
      setLang("en");
      assert.equal(t("status.cell", { x: 12, y: -7 }), "Square 12, -7");
      assert.equal(t("status.cell"), "Square {x}, {y}");
    } finally {
      setLang(before);
    }
  });

  test("the default language is Russian only for a ru* browser", () => {
    assert.equal(defaultLang("ru"), "ru");
    assert.equal(defaultLang("ru-RU"), "ru");
    assert.equal(defaultLang("RU"), "ru");
    assert.equal(defaultLang("en-US"), "en");
    assert.equal(defaultLang("uk-UA"), "en");
    assert.equal(defaultLang(""), "en");
  });
});

describe("themes.css", () => {
  const css = readFileSync(path.join(clientDir, "themes.css"), "utf8");
  const themes = new Map<string, string[]>();
  for (const match of css.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
    themes.set(match[1], [...match[2].matchAll(/(--[\w-]+)\s*:/g)].map((variable) => variable[1]).sort());
  }

  test("has a block for every theme choice except «system»", () => {
    assert.deepEqual([...themes.keys()].sort(), THEME_CHOICES.filter((choice) => choice !== "system").sort());
  });

  test("every variable is set in every theme", () => {
    const [first, ...rest] = [...themes.entries()];
    for (const [name, variables] of rest) assert.deepEqual(variables, first[1], `${name} differs from ${first[0]}`);
  });

  test("the board colours read by the canvas are there", () => {
    const variables = themes.values().next().value ?? [];
    for (const name of ["--board-void", "--board-grid", "--board-cursor", "--board-label-bg", "--board-label-fg"]) {
      assert.ok(variables.includes(name), name);
    }
  });
});
