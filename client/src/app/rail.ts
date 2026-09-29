// The tool column of variant V (R45): an icon for each tool with the hint «Brush · B» on hover, undo and redo at
// the bottom, and a button that shows the names beside the icons. Names and hints come from the dictionaries through
// data-i18n and data-i18n-aria (main.ts); the key letter is the physical key of the tool (tools.ts).

import { TOOLS, toolKey } from "../board/tools.ts";
import type { Tool } from "../board/tools.ts";
import { t } from "../i18n/index.ts";
import type { Key } from "../i18n/index.ts";
import { icon } from "../ui/icons.ts";
import type { IconName } from "../ui/icons.ts";
import { setKey } from "./login.ts";

/** Tools in groups with a line between them, after the variant V mock-up. */
const GROUPS: readonly (readonly Tool[])[] = [
  ["select"],
  ["brush", "fill", "room", "walls"],
  ["objects", "tokens", "pencil"],
  ["ruler", "eraser", "ping"],
];

if (GROUPS.flat().length !== TOOLS.length || !TOOLS.every((tool) => GROUPS.flat().includes(tool))) {
  throw new Error("every tool must be in exactly one group of the tool column");
}

const ICON_PX = 21;

export interface RailHooks {
  choose(tool: Tool): void;
  undo(): void;
  redo(): void;
  /** The user pressed the button that shows or hides the names. */
  expandedChanged(expanded: boolean): void;
}

export interface Rail {
  undoButton: HTMLButtonElement;
  redoButton: HTMLButtonElement;
  /** Shows only the tools of `allowed` and marks `current` pressed. */
  show(allowed: readonly Tool[], current: Tool): void;
  setExpanded(expanded: boolean): void;
}

/** A button with an icon, a name shown in the expanded column, and the name with `key` in its hint. */
function railButton(iconName: IconName, nameKey: Key, key: string, onPress: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "rail-button";
  button.dataset.i18nAria = nameKey;
  if (key) button.dataset.key = key;
  const label = document.createElement("span");
  label.className = "rail-label";
  label.dataset.i18n = nameKey;
  button.append(icon(iconName, ICON_PX), label);
  button.addEventListener("click", onPress);
  return button;
}

function group(...buttons: HTMLButtonElement[]): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "rail-group";
  element.append(...buttons);
  return element;
}

export function buildRail(nav: HTMLElement, hooks: RailHooks): Rail {
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const toolGroups = GROUPS.map((tools) =>
    group(
      ...tools.map((tool) => {
        const button = railButton(tool, `tool.${tool}`, toolKey(tool), () => hooks.choose(tool));
        toolButtons.set(tool, button);
        return button;
      }),
    ),
  );
  const undoButton = railButton("undo", "toolbar.undo", "Ctrl+Z", hooks.undo);
  const redoButton = railButton("redo", "toolbar.redo", "Ctrl+Shift+Z", hooks.redo);
  const history = group(undoButton, redoButton);
  history.classList.add("rail-history");

  let expanded = false;
  const expandButton = document.createElement("button");
  expandButton.type = "button";
  expandButton.className = "rail-button rail-expand";
  const expandLabel = document.createElement("span");
  expandLabel.className = "rail-label";
  // The chevron points where the column goes (style.css): right to open, left to close.
  expandButton.append(icon("chevron", ICON_PX), expandLabel);
  expandButton.addEventListener("click", () => {
    setExpanded(!expanded);
    hooks.expandedChanged(expanded);
  });
  const expandGroup = group(expandButton);
  expandGroup.classList.add("rail-toggle");

  nav.append(...toolGroups, history, expandGroup);

  function setExpanded(next: boolean): void {
    expanded = next;
    nav.classList.toggle("expanded", expanded);
    const key: Key = expanded ? "rail.collapse" : "rail.expand";
    expandButton.dataset.i18nAria = key;
    expandButton.setAttribute("aria-label", t(key));
    setKey(expandLabel, key);
    expandButton.setAttribute("aria-expanded", String(expanded));
  }

  setExpanded(false);

  return {
    undoButton,
    redoButton,
    show(allowed, current) {
      for (const [tool, button] of toolButtons) {
        button.hidden = !allowed.includes(tool);
        button.setAttribute("aria-pressed", String(tool === current));
      }
      for (const element of toolGroups) element.hidden = [...element.children].every((child) => (child as HTMLElement).hidden);
    },
    setExpanded,
  };
}