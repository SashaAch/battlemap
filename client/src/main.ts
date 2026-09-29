// Start-up: interface language, theme, draft in localStorage, toolbar, palette, status bar and the board.

import { TERRAIN } from "./board/catalog.ts";
import type { TerrainId } from "./board/catalog.ts";
import { brushSquare, cellAt, DEFAULT_SCALE, panBy } from "./board/geometry.ts";
import { drawBoard, fitCanvas, readBoardColors } from "./board/render.ts";
import type { BoardColors, Viewport } from "./board/render.ts";
import { newHistory, newScene, parseScene, redo, SceneError, undo } from "./board/store.ts";
import type { Scene } from "./board/store.ts";
import { attachTools, BRUSH_SIZES } from "./board/tools.ts";
import type { Board } from "./board/tools.ts";
import { en } from "./i18n/en.ts";
import { ru } from "./i18n/ru.ts";
import { isThemeChoice, startThemes, THEME_CHOICES } from "./theme.ts";

const STORAGE = { lang: "battlemap.lang", theme: "battlemap.theme", draft: "battlemap.draft" } as const;
const DRAFT_SAVE_DELAY_MS = 1000;

// ---- storage: every access guarded, the page works without it ----

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    showNotice("notice.storageFailed");
  }
}

// ---- languages ----

type Key = keyof typeof ru;
const DICTIONARIES = { ru, en };
type Lang = keyof typeof DICTIONARIES;

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && Object.hasOwn(DICTIONARIES, value);
}

function isKey(value: unknown): value is Key {
  return typeof value === "string" && Object.hasOwn(ru, value);
}

const storedLang = readStorage(STORAGE.lang);
let lang: Lang = isLang(storedLang) ? storedLang : navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";

function t(key: Key, params: Record<string, string | number> = {}): string {
  return DICTIONARIES[lang][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

function translateAttribute(attribute: string, apply: (element: HTMLElement, text: string) => void): void {
  for (const element of document.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    const key = element.getAttribute(attribute);
    if (!isKey(key)) throw new Error(`unknown dictionary key ${key} in ${attribute}`);
    apply(element, t(key));
  }
}

function applyLanguage(): void {
  document.documentElement.lang = lang;
  document.title = t("app.title");
  translateAttribute("data-i18n", (element, text) => (element.textContent = text));
  translateAttribute("data-i18n-title", (element, text) => (element.title = text));
  updateStatus();
  updateNotice();
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
const brushSizes = byId("brush-sizes", HTMLElement);
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

// ---- notice ----

let noticeKey: Key | null = null;

function showNotice(key: Key): void {
  noticeKey = key;
  updateNotice();
}

function updateNotice(): void {
  notice.hidden = noticeKey === null;
  noticeText.textContent = noticeKey === null ? "" : t(noticeKey);
}

noticeClose.addEventListener("click", () => {
  noticeKey = null;
  updateNotice();
});

// ---- draft ----

function loadDraft(): Scene {
  const raw = readStorage(STORAGE.draft);
  if (raw === null) return newScene();
  try {
    return parseScene(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SceneError && error.code === "version") showNotice("notice.draftNewer");
    else if (error instanceof SceneError || error instanceof SyntaxError) showNotice("notice.draftBroken");
    else throw error;
    return newScene();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function saveDraft(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  writeStorage(STORAGE.draft, JSON.stringify(board.scene));
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
}

// A reload right after a change would otherwise lose it.
window.addEventListener("pagehide", () => {
  if (saveTimer !== undefined) saveDraft();
});

// ---- board ----

const board: Board = {
  scene: loadDraft(),
  history: newHistory(),
  camera: { x: 0, y: 0, scale: DEFAULT_SCALE },
  terrain: TERRAIN[0].id,
  brushSize: BRUSH_SIZES[0],
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
    const brush = board.hover ? brushSquare(board.hover, board.brushSize) : null;
    drawBoard(ctx, viewport, board.scene, board.camera, colors, brush);
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

for (const code of Object.keys(DICTIONARIES) as Lang[]) languageSelect.append(option(code, `lang.${code}`));
languageSelect.value = lang;
languageSelect.addEventListener("change", () => {
  if (!isLang(languageSelect.value)) return;
  lang = languageSelect.value;
  writeStorage(STORAGE.lang, lang);
  applyLanguage();
});

const storedTheme = readStorage(STORAGE.theme);
const initialTheme = isThemeChoice(storedTheme) ? storedTheme : "system";
for (const choice of THEME_CHOICES) themeSelect.append(option(choice, `theme.${choice}`));
themeSelect.value = initialTheme;
const setTheme = startThemes(initialTheme, () => {
  colors = readBoardColors();
  redraw();
});
themeSelect.addEventListener("change", () => {
  if (!isThemeChoice(themeSelect.value)) return;
  writeStorage(STORAGE.theme, themeSelect.value);
  setTheme(themeSelect.value);
});

attachTools(canvas, board, {
  redraw,
  committed: sceneChanged,
  hoverChanged: updateStatus,
  brushSizeChanged: updateBrushSizes,
  undo: doUndo,
  redo: doRedo,
});

updateBrushSizes();
updateTerrainButtons();
updateHistoryButtons();
applyLanguage();
redraw();
