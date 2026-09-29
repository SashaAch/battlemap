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
