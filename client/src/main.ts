// Start-up: interface language, theme, draft in localStorage, toolbar with the tools, palette, status bar and the board.

import { EDGE_TYPES, TERRAIN } from "./board/catalog.ts";
import type { TerrainId } from "./board/catalog.ts";
import { cellAt, DEFAULT_SCALE, panBy } from "./board/geometry.ts";
import { drawBoard, fitCanvas, readBoardColors } from "./board/render.ts";
import type { BoardColors, Viewport } from "./board/render.ts";
import { ENCLOSE_LIMIT, ERASE_FILTERS, newHistory, redo, undo } from "./board/store.ts";
import { attachTools, BRUSH_SIZES, TOOLS } from "./board/tools.ts";
import type { Board } from "./board/tools.ts";
import { openDraft, saveDraft } from "./draft.ts";
import type { DraftProblem, DraftStorage } from "./draft.ts";
import { defaultLang, getLang, isKey, isLang, LANGS, setLang, t } from "./i18n/index.ts";
import type { Key } from "./i18n/index.ts";
import { isThemeChoice, startThemes, THEME_CHOICES } from "./theme.ts";

const LANG_KEY = "battlemap.lang";
const THEME_KEY = "battlemap.theme";
const DRAFT_SAVE_DELAY_MS = 1000;

const DRAFT_NOTICE: Record<DraftProblem, Key> = {
  newer: "notice.draftNewer",
  broken: "notice.draftBroken",
  unkept: "notice.draftUnkept",
};

// ---- storage: every access may throw (disabled storage, full quota), the page works without it ----

const storage: DraftStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};

function readSetting(key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    showNotice("notice.storageFailed");
  }
}

// ---- page elements ----

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`element #${id} is missing`);
  return element;
}

const canvas = byId("board", HTMLCanvasElement);
const undoButton = byId("undo", HTMLButtonElement);
const redoButton = byId("redo", HTMLButtonElement);
const toolList = byId("tools", HTMLElement);
const sizeGroup = byId("size-group", HTMLElement);
const brushSizes = byId("brush-sizes", HTMLElement);
const edgeGroup = byId("edge-group", HTMLElement);
const edgeTypes = byId("edge-types", HTMLElement);
const eraseGroup = byId("erase-group", HTMLElement);
const eraseFilters = byId("erase-filters", HTMLElement);
const languageSelect = byId("language", HTMLSelectElement);
const themeSelect = byId("theme", HTMLSelectElement);
const terrainList = byId("terrain-list", HTMLElement);
const notice = byId("notice", HTMLElement);
const noticeText = byId("notice-text", HTMLElement);
const noticeClose = byId("notice-close", HTMLButtonElement);
const statusCell = byId("status-cell", HTMLElement);

const context = canvas.getContext("2d");
if (!context) throw new Error("canvas 2d context is unavailable");
const ctx = context;

// ---- languages ----

const storedLang = readSetting(LANG_KEY);
setLang(isLang(storedLang) ? storedLang : defaultLang(navigator.language));

function translateAttribute(attribute: string, apply: (element: HTMLElement, text: string) => void): void {
  for (const element of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    const key = element.getAttribute(attribute);
    if (!isKey(key)) throw new Error(`unknown dictionary key ${key} in ${attribute}`);
    apply(element, t(key));
  }
}

function applyLanguage(): void {
  document.documentElement.lang = getLang();
  document.title = t("app.title");
  translateAttribute("data-i18n", (element, text) => (element.textContent = text));
  translateAttribute("data-i18n-title", (element, text) => (element.title = text));
  updateStatus();
  updateNotice();
}

// ---- notice ----

let noticeKey: Key | null = null;
let noticeParams: Record<string, string | number> = {};

function showNotice(key: Key, params: Record<string, string | number> = {}): void {
  noticeKey = key;
  noticeParams = params;
  updateNotice();
}

function updateNotice(): void {
  notice.hidden = noticeKey === null;
  noticeText.textContent = noticeKey === null ? "" : t(noticeKey, noticeParams);
}

noticeClose.addEventListener("click", () => {
  noticeKey = null;
  updateNotice();
});

// ---- draft ----

const draft = openDraft(storage);
if (draft.problem) showNotice(DRAFT_NOTICE[draft.problem]);

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function saveNow(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!saveDraft(storage, board.scene)) showNotice("notice.storageFailed");
}

function scheduleSave(): void {
  if (!draft.canSave) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, DRAFT_SAVE_DELAY_MS);
}

// A reload right after a change would otherwise lose it.
window.addEventListener("pagehide", () => {
  if (saveTimer !== undefined) saveNow();
});

// ---- board ----

const board: Board = {
  scene: draft.scene,
  history: newHistory(),
  camera: { x: 0, y: 0, scale: DEFAULT_SCALE },
  tool: TOOLS[0],
  terrain: TERRAIN[0].id,
  brushSize: BRUSH_SIZES[0],
  edgeType: EDGE_TYPES[0],
  eraseFilter: ERASE_FILTERS[0],
  hover: null,
};

// Starts at zero size with the camera on cell 0,0, so the first frame puts cell 0,0 in the middle.
let viewport: Viewport = { width: 0, height: 0 };
let colors: BoardColors = readBoardColors();
let frame = 0;

function redraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const next = fitCanvas(canvas, ctx);
    // The middle of the board stays in place when the window changes size.
    board.camera = panBy(board.camera, (next.width - viewport.width) / 2, (next.height - viewport.height) / 2);
    viewport = next;
    drawBoard(ctx, viewport, board.scene, board.camera, colors, tools.cursor());
  });
}

new ResizeObserver(redraw).observe(canvas);

function updateStatus(): void {
  if (!board.hover) {
    statusCell.textContent = "";
    return;
  }
  const cell = cellAt(board.hover);
  statusCell.textContent = t("status.cell", { x: cell.x, y: cell.y });
}

function updateHistoryButtons(): void {
  undoButton.disabled = board.history.undo.length === 0;
  redoButton.disabled = board.history.redo.length === 0;
}

function sceneChanged(): void {
  updateHistoryButtons();
  scheduleSave();
  redraw();
}

// Both do nothing while a stroke is under way (see beginChange in store.ts).
function doUndo(): void {
  if (undo(board.scene, board.history)) sceneChanged();
}

function doRedo(): void {
  if (redo(board.scene, board.history)) sceneChanged();
}

undoButton.addEventListener("click", doUndo);
redoButton.addEventListener("click", doRedo);

// ---- toolbar and palette ----

function option(value: string, key: Key): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.dataset.i18n = key;
  return element;
}

function toggleButton(onPress: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.addEventListener("click", onPress);
  return button;
}

/** A row of toggle buttons, one per value; returns a function that marks the current value pressed. */
function choiceButtons<T extends string>(
  container: HTMLElement,
  values: readonly T[],
  label: (value: T) => Key,
  hint: ((value: T) => Key) | null,
  choose: (value: T) => void,
): (current: T) => void {
  const buttons = values.map((value) => {
    const button = toggleButton(() => choose(value));
    button.dataset.i18n = label(value);
    if (hint) button.dataset.i18nTitle = hint(value);
    container.append(button);
    return { value, button };
  });
  return (current) => {
    for (const { value, button } of buttons) button.setAttribute("aria-pressed", String(value === current));
  };
}

const markTool = choiceButtons(
  toolList,
  TOOLS,
  (tool) => `tool.${tool}`,
  (tool) => `tool.${tool}Hint`,
  (tool) => {
    board.tool = tool;
    updateTools();
    redraw();
  },
);

const markEdgeType = choiceButtons(edgeTypes, EDGE_TYPES, (type) => `edge.${type}`, null, (type) => {
  board.edgeType = type;
  markEdgeType(type);
});

const markEraseFilter = choiceButtons(eraseFilters, ERASE_FILTERS, (filter) => `erase.${filter}`, null, (filter) => {
  board.eraseFilter = filter;
  markEraseFilter(filter);
});

// Each tool shows only its own options: size for the brush and the eraser, edge type for walls, filter for the eraser.
function updateTools(): void {
  markTool(board.tool);
  sizeGroup.hidden = board.tool !== "brush" && board.tool !== "eraser";
  edgeGroup.hidden = board.tool !== "walls";
  eraseGroup.hidden = board.tool !== "eraser";
}

const sizeButtons = BRUSH_SIZES.map((size) => {
  const button = toggleButton(() => {
    board.brushSize = size;
    updateBrushSizes();
    redraw();
  });
  button.textContent = String(size);
  brushSizes.append(button);
  return { size, button };
});

function updateBrushSizes(): void {
  for (const { size, button } of sizeButtons) button.setAttribute("aria-pressed", String(size === board.brushSize));
}

const terrainKey = (id: TerrainId): Key => `terrain.${id}`;

const terrainButtons = TERRAIN.map((terrain) => {
  const button = toggleButton(() => {
    board.terrain = terrain.id;
    updateTerrainButtons();
  });
  button.dataset.i18nTitle = terrainKey(terrain.id);
  // Terrain colours come from the catalog, not the theme: they are the same in every theme.
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.backgroundColor = terrain.color;
  if (terrain.hatch) {
    swatch.style.backgroundImage = `repeating-linear-gradient(45deg, ${terrain.hatch} 0 1.5px, transparent 1.5px 4.5px)`;
  }
  const name = document.createElement("span");
  name.className = "name";
  name.dataset.i18n = terrainKey(terrain.id);
  button.append(swatch, name);
  terrainList.append(button);
  return { id: terrain.id, button };
});

function updateTerrainButtons(): void {
  for (const { id, button } of terrainButtons) button.setAttribute("aria-pressed", String(id === board.terrain));
}

for (const code of LANGS) languageSelect.append(option(code, `lang.${code}`));
languageSelect.value = getLang();
languageSelect.addEventListener("change", () => {
  if (!isLang(languageSelect.value)) return;
  setLang(languageSelect.value);
  writeSetting(LANG_KEY, languageSelect.value);
  applyLanguage();
});

const storedTheme = readSetting(THEME_KEY);
const initialTheme = isThemeChoice(storedTheme) ? storedTheme : "system";
for (const choice of THEME_CHOICES) themeSelect.append(option(choice, `theme.${choice}`));
themeSelect.value = initialTheme;
const setTheme = startThemes(
  document.documentElement,
  window.matchMedia("(prefers-color-scheme: dark)"),
  initialTheme,
  () => {
    colors = readBoardColors();
    redraw();
  },
);
themeSelect.addEventListener("change", () => {
  if (!isThemeChoice(themeSelect.value)) return;
  writeSetting(THEME_KEY, themeSelect.value);
  setTheme(themeSelect.value);
});

const tools = attachTools(canvas, board, {
  redraw,
  committed: sceneChanged,
  hoverChanged: updateStatus,
  brushSizeChanged: updateBrushSizes,
  toolChanged: updateTools,
  enclosureTooBig: () => showNotice("notice.enclosureTooBig", { limit: ENCLOSE_LIMIT }),
  undo: doUndo,
  redo: doRedo,
});

updateTools();
markEdgeType(board.edgeType);
markEraseFilter(board.eraseFilter);
updateBrushSizes();
updateTerrainButtons();
updateHistoryButtons();
applyLanguage();
redraw();
