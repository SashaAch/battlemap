// Interface language (plan 5.15): the current language and t(). No DOM, no storage.

import { en } from "./en.ts";
import { ru } from "./ru.ts";

export type Key = keyof typeof ru;

const DICTIONARIES = { ru, en };
type Lang = keyof typeof DICTIONARIES;
export const LANGS = Object.keys(DICTIONARIES) as Lang[];

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && Object.hasOwn(DICTIONARIES, value);
}

export function isKey(value: unknown): value is Key {
  return typeof value === "string" && Object.hasOwn(ru, value);
}

/** The language for a first visit: `ru*` in the browser gives Russian, anything else English. */
export function defaultLang(browserLanguage: string): Lang {
  return browserLanguage.toLowerCase().startsWith("ru") ? "ru" : "en";
}

let current: Lang = "ru";

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
}

/** The string for `key` in the current language; `{name}` is replaced by `params.name`. */
export function t(key: Key, params: Record<string, string | number> = {}): string {
  return DICTIONARIES[current][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
