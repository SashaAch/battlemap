// Themes (plan 5.15): a theme is a set of CSS variables in themes.css under data-theme on <html>.
// The page parts are passed in, so this module also type-checks without the DOM library.

export const THEME_CHOICES = ["system", "light", "dark", "parchment", "dungeon", "contrast"] as const;
type ThemeChoice = (typeof THEME_CHOICES)[number];

/** The element that carries data-theme (<html>). */
interface ThemeRoot {
  dataset: { theme?: string };
}

/** The prefers-color-scheme: dark media query. */
interface DarkSchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (THEME_CHOICES as readonly unknown[]).includes(value);
}

/** A user's own colour of the void or the grid (R45): `#rrggbb`, any case. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

const RGBA = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)$/;

/**
 * A theme colour (`#rrggbb` or `rgba(r, g, b, a)`, the two forms themes.css uses) as the `#rrggbb` it shows
 * laid over `under` (`#rrggbb`). Throws on any other form.
 */
export function solidHex(color: string, under: string): string {
  const channels = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  if (isHexColor(color)) return color.toLowerCase();
  const match = RGBA.exec(color);
  if (!match || !isHexColor(under)) throw new Error(`not a theme colour: ${color} over ${under}`);
  const alpha = Number(match[4]);
  const base = channels(under);
  return `#${[1, 2, 3]
    .map((index, at) => Math.round(Number(match[index]) * alpha + base[at] * (1 - alpha)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Applies `initial` and keeps «system» in step with the system setting.
 * `applied` runs after every change of the page theme. Returns the function that switches the choice.
 */
export function startThemes(
  root: ThemeRoot,
  systemDark: DarkSchemeQuery,
  initial: ThemeChoice,
  applied: () => void,
): (choice: ThemeChoice) => void {
  let choice = initial;

  const apply = (): void => {
    root.dataset.theme = choice === "system" ? (systemDark.matches ? "dark" : "light") : choice;
    applied();
  };

  systemDark.addEventListener("change", () => {
    if (choice === "system") apply();
  });
  apply();

  return (next) => {
    choice = next;
    apply();
  };
}
