// The user's own colours of the void around the map and of the grid over the void (R45, plan 8.27 item 5). They lie
// over the chosen theme on the board only: the theme's variables for the rest of the interface stay as they are.

import type { BoardColors } from "../board/render.ts";
import { solidHex } from "../theme.ts";
import type { SettingsChange } from "./api.ts";

/** A colour `#rrggbb`, or null for the theme's. */
export interface OwnColors {
  void: string | null;
  grid: string | null;
}

/** A change of the colours for the account: null takes a colour back to the theme's. */
export type OwnColorsChange = Pick<SettingsChange, "voidColor" | "gridColor">;

export interface ColorControls {
  voidInput: HTMLInputElement;
  voidReset: HTMLButtonElement;
  gridInput: HTMLInputElement;
  gridReset: HTMLButtonElement;
}

export interface OwnColorHooks {
  /** The board colours changed: draw it again. */
  changed(): void;
  /** The user settled on a colour, or took one back to the theme's. */
  save(change: OwnColorsChange): void;
}

export interface OwnColorsView {
  /** The colours of the board: the theme's `theme` with the user's own over them. */
  boardColors(theme: BoardColors): BoardColors;
  /** The theme changed: the pickers show its colours where the user has none. */
  showTheme(theme: BoardColors): void;
  /** Colours from the account; a missing one stays as it is. */
  apply(change: Partial<OwnColors>): void;
}

export function startOwnColors(controls: ColorControls, initial: OwnColors, hooks: OwnColorHooks): OwnColorsView {
  let own = { ...initial };
  let theme: BoardColors | null = null;

  const boardColors = (base: BoardColors): BoardColors => ({ ...base, void: own.void ?? base.void, grid: own.grid ?? base.grid });

  /** The pickers show the colours the board has; a picker takes only #rrggbb, so a see-through grid is shown as it looks. */
  const showPickers = (): void => {
    if (theme) {
      const shown = boardColors(theme);
      const voidHex = solidHex(shown.void, "#000000");
      controls.voidInput.value = voidHex;
      controls.gridInput.value = solidHex(shown.grid, voidHex);
    }
    controls.voidReset.disabled = own.void === null;
    controls.gridReset.disabled = own.grid === null;
  };

  const pick = (key: keyof OwnColors, value: string | null): void => {
    own = { ...own, [key]: value };
    showPickers();
    hooks.changed();
  };

  const wire = (key: keyof OwnColors, input: HTMLInputElement, reset: HTMLButtonElement, name: keyof OwnColorsChange): void => {
    // "input" comes while the user drags in the picker, "change" when the picker closes.
    input.addEventListener("input", () => pick(key, input.value));
    input.addEventListener("change", () => hooks.save({ [name]: input.value }));
    reset.addEventListener("click", () => {
      pick(key, null);
      hooks.save({ [name]: null });
    });
  };
  wire("void", controls.voidInput, controls.voidReset, "voidColor");
  wire("grid", controls.gridInput, controls.gridReset, "gridColor");
  showPickers();

  return {
    boardColors,
    showTheme(next) {
      theme = next;
      showPickers();
    },
    apply(change) {
      own = { void: change.void ?? own.void, grid: change.grid ?? own.grid };
      showPickers();
      hooks.changed();
    },
  };
}