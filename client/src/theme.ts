// Themes (plan 5.15): a theme is a set of CSS variables in themes.css under data-theme on <html>.

export const THEME_CHOICES = ["system", "light", "dark", "parchment", "dungeon", "contrast"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return (THEME_CHOICES as readonly unknown[]).includes(value);
}

/**
 * Applies `initial` and keeps «system» in step with prefers-color-scheme.
 * `applied` runs after every change of the page theme. Returns the function that switches the choice.
 */
export function startThemes(initial: ThemeChoice, applied: () => void): (choice: ThemeChoice) => void {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  let choice = initial;

  const apply = (): void => {
    document.documentElement.dataset.theme = choice === "system" ? (systemDark.matches ? "dark" : "light") : choice;
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
