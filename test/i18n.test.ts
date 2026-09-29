// Languages and themes (plan 5.15).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { en } from "../client/src/i18n/en.ts";
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
    for (const name of ["--board-void", "--board-grid", "--board-cursor"]) assert.ok(variables.includes(name), name);
  });
});
