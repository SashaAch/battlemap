// Start-up: interface language, theme, draft in localStorage, toolbar with the tools, palette, status bar and the board;
// then the account part (app/login.ts), which finds out whether a server is there (plan 5.3), and the games
// (app/game.ts), which put a scene from the server on the board instead of the draft.

import { showAdmin } from "./app/admin.ts";
import { forwardPatch } from "./app/api.ts";
import type { AccountSettings } from "./app/api.ts";
import { startGame } from "./app/game.ts";
import type { BoardAccess, GameBoard } from "./app/game.ts";
import type { RoundTripSummary } from "./app/measure.ts";
import { showGames } from "./app/games.ts";
import { startAccount } from "./app/login.ts";
import { EDGE_TYPES, isSideId, isSizeId, MARK_COLORS, OBJECT_TYPES, SIDES, SIZES, TERRAIN } from "./board/catalog.ts";
import type { TerrainId } from "./board/catalog.ts";
import { cellAt, DEFAULT_SCALE, panBy } from "./board/geometry.ts";
import type { Point } from "./board/geometry.ts";
import { editTokenPatch } from "./board/pieces.ts";
import { drawBoard, fitCanvas, readBoardColors } from "./board/render.ts";
import type { BoardColors, BoardOverlay, Viewport } from "./board/render.ts";
import { drawObjectSign } from "./board/signs.ts";
import { ENCLOSE_LIMIT, ERASE_FILTERS } from "./board/edit.ts";
import { applyToChange, beginChange, DIAGONAL_RULES, diagonalRule, finishChange, isToken, newHistory, redo, undo } from "./board/store.ts";
import type { Patch } from "./board/store.ts";
import { attachTools, BRUSH_SIZES, TOOLS } from "./board/tools.ts";
import type { Board, Tool } from "./board/tools.ts";
import { openDraft, saveDraft } from "./draft.ts";
import type { DraftProblem, DraftStorage } from "./draft.ts";
import { defaultLang, getLang, isKey, isLang, LANGS, setLang, t } from "./i18n/index.ts";
import type { Key } from "./i18n/index.ts";
import { isThemeChoice, startThemes, THEME_CHOICES } from "./theme.ts";

const LANG_KEY = "battlemap.lang";
const THEME_KEY = "battlemap.theme";
const DRAFT_SAVE_DELAY_MS = 1000;
/** Tools a read-only board keeps: looking around and measuring. */
const READ_ONLY_TOOLS: readonly Tool[] = ["select", "ruler"];
/** A player moves tokens of the side "players", measures and pings (plan 5.4, R6). */
const PLAYER_TOOLS: readonly Tool[] = ["select", "ruler", "ping"];
/** The draft has no one to ping. */
const DRAFT_TOOLS: readonly Tool[] = TOOLS.filter((tool) => tool !== "ping");
/** How long a ping shows on the board (plan 8.6). */
const PING_MS = 3000;

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
const objectGroup = byId("object-group", HTMLElement);
const objectTypes = byId("object-types", HTMLElement);
const tokenGroup = byId("token-group", HTMLElement);
const tokenSides = byId("token-sides", HTMLElement);
const tokenSize = byId("token-size", HTMLSelectElement);
const tokenName = byId("token-name", HTMLInputElement);
const markGroup = byId("mark-group", HTMLElement);
const markColors = byId("mark-colors", HTMLElement);
const diagonalSelect = byId("diagonal", HTMLSelectElement);
const tokenDialog = byId("token-dialog", HTMLDialogElement);
const tokenForm = byId("token-form", HTMLFormElement);
const editSide = byId("edit-side", HTMLSelectElement);
const editSize = byId("edit-size", HTMLSelectElement);
const editName = byId("edit-name", HTMLInputElement);
const languageSelect = byId("language", HTMLSelectElement);
const themeSelect = byId("theme", HTMLSelectElement);
const terrainList = byId("terrain-list", HTMLElement);
const notice = byId("notice", HTMLElement);
const noticeText = byId("notice-text", HTMLElement);
const noticeClose = byId("notice-close", HTMLButtonElement);
const statusCell = byId("status-cell", HTMLElement);
const statusMeasure = byId("status-measure", HTMLElement);

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
  updateMeasure();
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
/** The undo history of the draft, kept while a game scene is on the board. */
let draftHistory = newHistory();

/** A game scene on the board (app/game.ts) and what the user may do on it, null for the draft. */
let game: BoardAccess | null = null;
const readOnly = (): boolean => game !== null && game.changed === null;
/** A player's board: no painting, no undo, only tokens of the side "players" move (plan 5.4). */
const player = (): boolean => game !== null && game.player;

function allowedTools(): readonly Tool[] {
  if (!game) return DRAFT_TOOLS;
  if (readOnly()) return READ_ONLY_TOOLS;
  return player() ? PLAYER_TOOLS : TOOLS;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function saveNow(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!saveDraft(storage, draft.scene)) showNotice("notice.storageFailed");
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
  tool: "select", // Р40: the board opens with the select tool
  terrain: TERRAIN[0].id,
  brushSize: BRUSH_SIZES[0],
  edgeType: EDGE_TYPES[0],
  eraseFilter: ERASE_FILTERS[0],
  objectType: OBJECT_TYPES[0],
  tokenDraft: { name: "", side: "enemies", size: "medium" },
  markColor: MARK_COLORS[0].value,
  selection: null,
  hover: null,
  playerTokensOnly: false,
};

// Starts at zero size with the camera on cell 0,0, so the first frame puts cell 0,0 in the middle.
let viewport: Viewport = { width: 0, height: 0 };
let colors: BoardColors = readBoardColors();
let frame = 0;
/** Pings shown on the board, with the time each one came (performance.now()). */
let pings: { point: Point; name: string; shownAt: number }[] = [];

function redraw(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const next = fitCanvas(canvas, ctx);
    // The middle of the board stays in place when the window changes size.
    board.camera = panBy(board.camera, (next.width - viewport.width) / 2, (next.height - viewport.height) / 2);
    viewport = next;
    const now = performance.now();
    pings = pings.filter((ping) => now - ping.shownAt < PING_MS);
    const pingOverlays = pings.map(({ point, name, shownAt }): BoardOverlay => ({ kind: "ping", point, label: name, age: (now - shownAt) / PING_MS }));
    drawBoard(ctx, viewport, board.scene, board.camera, colors, [...tools.overlays(), ...pingOverlays]);
    // A ping on the board keeps the frames coming until it is gone.
    if (pings.length > 0) redraw();
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

/** The times there and back with `?measure` in the address (app/measure.ts), null while there are none. */
let measured: RoundTripSummary | null = null;

function updateMeasure(): void {
  statusMeasure.hidden = measured === null;
  statusMeasure.textContent =
    measured === null ? "" : t("status.measure", { count: measured.count, median: measured.median.toFixed(1), worst: measured.worst.toFixed(1) });
}

function updateHistoryButtons(): void {
  undoButton.disabled = board.history.undo.length === 0;
  redoButton.disabled = board.history.redo.length === 0;
}

const lastPatch = (list: readonly Patch[]): Patch => list[list.length - 1] ?? [];

/** After a finished change, an undo or a redo; `inverse` is its inverse patch, which names every entry it touched. */
function sceneChanged(inverse: Patch): void {
  if (readOnly()) {
    // A read-only board does not change: whatever a tool did (a dragged token, Delete) is taken back.
    undo(board.scene, board.history);
    board.history = newHistory();
  } else if (game?.changed) {
    game.changed(forwardPatch(board.scene, inverse), inverse);
  } else {
    scheduleSave();
  }
  updateHistoryButtons();
  diagonalSelect.value = diagonalRule(board.scene);
  redraw();
}

/** A change of one patch made outside the tools: the diagonal rule, the token editor. */
function commit(patch: Patch): void {
  if (patch.length === 0 || board.history.open) return;
  beginChange(board.history);
  applyToChange(board.scene, board.history, patch);
  if (finishChange(board.history)) sceneChanged(lastPatch(board.history.undo));
}

// Both do nothing while a stroke is under way (see beginChange in store.ts). A player has no undo: taking back
// a move would also take back what the master changed in the token since.
function doUndo(): void {
  if (!player() && undo(board.scene, board.history)) sceneChanged(lastPatch(board.history.redo));
}

function doRedo(): void {
  if (!player() && redo(board.scene, board.history)) sceneChanged(lastPatch(board.history.undo));
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

// Each tool shows only its own options: size for the brush and the eraser, edge type for walls, filter for the eraser,
// the symbol for objects, side, size and name for tokens, colour for the pencil.
function updateTools(): void {
  const allowed = allowedTools();
  if (!allowed.includes(board.tool)) board.tool = "select";
  TOOLS.forEach((tool, index) => {
    const element = toolList.children[index];
    if (element instanceof HTMLElement) element.hidden = !allowed.includes(tool);
  });
  markTool(board.tool);
  sizeGroup.hidden = board.tool !== "brush" && board.tool !== "eraser";
  edgeGroup.hidden = board.tool !== "walls";
  eraseGroup.hidden = board.tool !== "eraser";
  objectGroup.hidden = board.tool !== "objects";
  tokenGroup.hidden = board.tool !== "tokens";
  markGroup.hidden = board.tool !== "pencil";
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

// ---- objects, tokens, pencil, diagonal rule (stage 3) ----

const ICON_PX = 22;

/** An object button shows its sign drawn on a small canvas, the name is in the tooltip. */
const objectButtons = OBJECT_TYPES.map((type) => {
  const button = toggleButton(() => {
    board.objectType = type;
    updateObjectButtons();
  });
  button.dataset.i18nTitle = `object.${type}`;
  const icon = document.createElement("canvas");
  const ratio = window.devicePixelRatio || 1;
  icon.width = icon.height = Math.round(ICON_PX * ratio);
  icon.className = "icon";
  const iconCtx = icon.getContext("2d");
  if (iconCtx) drawObjectSign(iconCtx, type, 0, 0, icon.width);
  button.append(icon);
  objectTypes.append(button);
  return { type, button };
});

function updateObjectButtons(): void {
  for (const { type, button } of objectButtons) button.setAttribute("aria-pressed", String(type === board.objectType));
}

/** A button with a colour swatch; the colour comes from the catalog, the same in every theme. */
function swatchButton(color: string, onPress: () => void): HTMLButtonElement {
  const button = toggleButton(onPress);
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.style.backgroundColor = color;
  button.append(swatch);
  return button;
}

const sideButtons = SIDES.map((side) => {
  const button = swatchButton(side.color, () => {
    board.tokenDraft.side = side.id;
    updateSideButtons();
  });
  button.dataset.i18nTitle = `side.${side.id}`;
  tokenSides.append(button);
  return { id: side.id, button };
});

function updateSideButtons(): void {
  for (const { id, button } of sideButtons) button.setAttribute("aria-pressed", String(id === board.tokenDraft.side));
}

for (const size of SIZES) {
  tokenSize.append(option(size.id, `size.${size.id}`));
  editSize.append(option(size.id, `size.${size.id}`));
}
for (const side of SIDES) editSide.append(option(side.id, `side.${side.id}`));
tokenSize.value = board.tokenDraft.size;
tokenSize.addEventListener("change", () => {
  if (isSizeId(tokenSize.value)) board.tokenDraft.size = tokenSize.value;
  redraw();
});
tokenName.addEventListener("input", () => {
  board.tokenDraft.name = tokenName.value;
});

const markColorButtons = MARK_COLORS.map((color) => {
  const button = swatchButton(color.value, () => {
    board.markColor = color.value;
    updateMarkColorButtons();
  });
  button.dataset.i18nTitle = `color.${color.id}`;
  markColors.append(button);
  return { value: color.value, button };
});

function updateMarkColorButtons(): void {
  for (const { value, button } of markColorButtons) button.setAttribute("aria-pressed", String(value === board.markColor));
}

// The diagonal rule is a setting of the scene: changing it is a change that undo takes back (Р27).
for (const rule of DIAGONAL_RULES) diagonalSelect.append(option(rule, `diagonal.${rule}`));
diagonalSelect.value = diagonalRule(board.scene);
diagonalSelect.addEventListener("change", () => {
  const rule = DIAGONAL_RULES.find((value) => value === diagonalSelect.value);
  if (rule && rule !== diagonalRule(board.scene)) commit([["settings", "diagonal", rule]]);
  else diagonalSelect.value = diagonalRule(board.scene);
});

// The token editor opens on a double click with the select tool; the name goes into an input, never into markup.
let editedToken: string | null = null;

function openTokenEditor(id: string): void {
  const token = board.scene.tokens[id];
  if (!isToken(token) || board.history.open || readOnly() || player()) return;
  editedToken = id;
  editSide.value = token.side;
  editSize.value = token.size;
  editName.value = token.name;
  tokenDialog.showModal();
}

// Both buttons submit the form, which closes the dialog; Escape closes it without a submit.
tokenForm.addEventListener("submit", (e) => {
  const id = editedToken;
  editedToken = null;
  const button = e.submitter;
  if (id === null || !(button instanceof HTMLButtonElement) || button.value !== "save") return;
  if (!isSideId(editSide.value) || !isSizeId(editSize.value)) return;
  const result = editTokenPatch(board.scene, id, { side: editSide.value, size: editSize.value, name: editName.value });
  if (result === "tinyFull") showNotice("notice.tinyFull");
  else if (result === "outOfRange") showNotice("notice.tokenOutOfRange");
  else commit(result);
});

updateObjectButtons();
updateSideButtons();
updateMarkColorButtons();

for (const code of LANGS) languageSelect.append(option(code, `lang.${code}`));
languageSelect.value = getLang();
languageSelect.addEventListener("change", () => {
  if (!isLang(languageSelect.value)) return;
  setLang(languageSelect.value);
  writeSetting(LANG_KEY, languageSelect.value);
  applyLanguage();
  account.saveSettings({ lang: languageSelect.value });
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
  account.saveSettings({ theme: themeSelect.value });
});

const tools = attachTools(canvas, board, {
  redraw,
  committed: () => sceneChanged(lastPatch(board.history.undo)),
  hoverChanged: updateStatus,
  brushSizeChanged: updateBrushSizes,
  toolChanged: updateTools,
  enclosureTooBig: () => showNotice("notice.enclosureTooBig", { limit: ENCLOSE_LIMIT }),
  tinyCellFull: () => showNotice("notice.tinyFull"),
  editToken: openTokenEditor,
  rulerLabel: ({ feet, cells }) => t("measure.ruler", { feet, cells }),
  costLabel: (feet) => t("measure.cost", { feet }),
  undo: doUndo,
  redo: doRedo,
  ping: (point) => game?.ping(point),
});

updateTools();
markEdgeType(board.edgeType);
markEraseFilter(board.eraseFilter);
updateBrushSizes();
updateTerrainButtons();
updateHistoryButtons();
applyLanguage();
redraw();

// ---- account: a signed-in user's language and theme come from the account (plan 5.15) ----

function applyAccountSettings(settings: AccountSettings): void {
  if (settings.lang && settings.lang !== getLang()) {
    setLang(settings.lang);
    languageSelect.value = settings.lang;
    writeSetting(LANG_KEY, settings.lang);
    applyLanguage();
  }
  if (settings.theme && settings.theme !== themeSelect.value) {
    themeSelect.value = settings.theme;
    writeSetting(THEME_KEY, settings.theme);
    setTheme(settings.theme);
  }
}

// ---- games: a scene from the server instead of the draft (plan 5.3, 8.5, 8.6) ----

/** After switching between the draft and a game scene, or between an editor's, a player's and a read-only board. */
function boardModeChanged(): void {
  // A player's board hides the palette and undo like a read-only one.
  document.body.classList.toggle("read-only", readOnly() || player());
  diagonalSelect.disabled = readOnly() || player();
  board.playerTokensOnly = player();
  board.selection = null;
  pings = [];
  updateTools();
  updateHistoryButtons();
  diagonalSelect.value = diagonalRule(board.scene);
  redraw();
}

const gameBoard: GameBoard = {
  show(scene, access) {
    if (!game) {
      if (saveTimer !== undefined) saveNow();
      draftHistory = board.history;
    }
    game = access;
    board.scene = scene;
    board.history = newHistory();
    boardModeChanged();
  },
  showDraft() {
    if (!game) return;
    game = null;
    board.scene = draft.scene;
    board.history = draftHistory;
    boardModeChanged();
  },
  busy: () => board.history.open !== null,
  refresh() {
    diagonalSelect.value = diagonalRule(board.scene);
    redraw();
  },
  ping(point, name) {
    pings.push({ point, name, shownAt: performance.now() });
    redraw();
  },
};

const games = startGame({
  board: gameBoard,
  showNotice,
  clearNotice(key) {
    if (noticeKey !== key) return;
    noticeKey = null;
    updateNotice();
  },
  failed: (error) => account.failed(error),
  showGames: () => account.showGames(),
  measured: (summary) => {
    measured = summary;
    updateMeasure();
  },
});

const account = startAccount({
  applySettings: applyAccountSettings,
  showNotice,
  showAdmin,
  showGames: (screen, actions, joinCode) => {
    const openGame = (gameId: number): void => {
      actions.close();
      games.open(gameId);
    };
    showGames(screen, { ...actions, openGame }, joinCode);
  },
  signedIn: games.reopen,
  gameLink: games.reopen,
  openGame: games.open,
  signedOut: games.close,
});
