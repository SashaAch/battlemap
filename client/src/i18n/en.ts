// English interface strings. The type makes tsc reject a missing or an extra key.

import type { ru } from "./ru.ts";

export const en: Record<keyof typeof ru, string> = {
  "app.title": "battlemap: board",

  "toolbar.undo": "Undo",
  "toolbar.undoHint": "Undo (Ctrl+Z)",
  "toolbar.redo": "Redo",
  "toolbar.redoHint": "Redo (Ctrl+Shift+Z or Ctrl+Y)",
  "toolbar.tool": "Tool",
  "toolbar.size": "Size",
  "toolbar.sizeHint": "Brush and eraser size in squares, keys [ and ]",
  "toolbar.edgeType": "Type",
  "toolbar.eraseFilter": "Erase",
  "toolbar.language": "Language",
  "toolbar.theme": "Theme",

  "tool.brush": "Brush",
  "tool.brushHint": "Brush (B): paints squares with the selected terrain",
  "tool.fill": "Fill",
  "tool.fillHint": "Fill (F): outline an area, the squares inside get the selected terrain",
  "tool.room": "Room",
  "tool.roomHint": "Room (R): outline a room, floor inside and walls along the edge",
  "tool.walls": "Walls",
  "tool.wallsHint": "Walls (W): draw along the grid lines; a click sets the nearest edge; Shift+click walls in an area of one terrain",
  "tool.eraser": "Eraser",
  "tool.eraserHint": "Eraser (E): erases what the filter selects under the brush",

  "edge.wall": "Wall",
  "edge.door": "Door",
  "edge.secret": "Secret door",
  "edge.window": "Window",
  "edge.bars": "Bars",

  "erase.all": "Everything",
  "erase.terrain": "Terrain",
  "erase.walls": "Walls",
  "erase.items": "Objects and marks",

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
  "notice.enclosureTooBig": "The area is larger than {limit} squares, no walls were placed around it. Draw them in parts with the Walls tool.",
};
