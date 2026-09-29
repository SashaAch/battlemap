// English interface strings. The type makes tsc reject a missing or an extra key.

import type { ru } from "./ru.ts";

export const en: Record<keyof typeof ru, string> = {
  "app.title": "battlemap: board",

  "toolbar.undo": "Undo",
  "toolbar.undoHint": "Undo (Ctrl+Z)",
  "toolbar.redo": "Redo",
  "toolbar.redoHint": "Redo (Ctrl+Shift+Z or Ctrl+Y)",
  "toolbar.brush": "Brush",
  "toolbar.brushHint": "Brush size in squares, keys [ and ]",
  "toolbar.language": "Language",
  "toolbar.theme": "Theme",

  "lang.ru": "Русский",
  "lang.en": "English",

  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.parchment": "Parchment",
  "theme.dungeon": "Dungeon",
  "theme.contrast": "High contrast",

  "palette.title": "Terrain",
  "terrain.floor": "Stone floor",
  "terrain.wood": "Wooden floor",
  "terrain.dirt": "Dirt",
  "terrain.grass": "Grass",
  "terrain.sand": "Sand",
  "terrain.snow": "Deep snow",
  "terrain.ice": "Ice",
  "terrain.rubble": "Rubble",
  "terrain.brush": "Undergrowth",
  "terrain.shallow": "Shallow water",
  "terrain.deep": "Deep water",
  "terrain.mud": "Mud, swamp",
  "terrain.lava": "Lava",
  "terrain.chasm": "Chasm",
  "terrain.rock": "Rock",

  "status.cell": "Square {x}, {y}",
  "status.scale": "1 square = 5 ft",

  "notice.close": "Close",
  "notice.draftBroken": "The draft is damaged and was not opened. It has been kept separately; an empty scene was opened.",
  "notice.draftNewer": "The draft was saved by a newer version of the app and was not opened here. It has been kept separately; an empty scene was opened.",
  "notice.draftUnkept": "The draft cannot be opened, and keeping a separate copy of it failed. To avoid overwriting it, changes to this scene are not saved.",
  "notice.storageFailed": "The browser does not allow saving data: the draft and settings are not kept.",
};
