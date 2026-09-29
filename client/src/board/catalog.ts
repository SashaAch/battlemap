// Canonical board data shared by the client and the server: terrain, edge types, token sides and sizes,
// object types, pencil colours. No DOM, no storage.

interface TerrainDef {
  readonly id: string;
  /** Fill colour, identical in every theme so all players see the same map. */
  readonly color: string;
  /** Hatch line colour for difficult terrain, or null for no hatching. */
  readonly hatch: string | null;
}

const DARK_HATCH = "rgba(0, 0, 0, 0.4)";
const LIGHT_HATCH = "rgba(255, 255, 255, 0.45)";

// Order and ids follow canon-5e.md, section «Местность на доске».
export const TERRAIN = [
  { id: "floor", color: "#9b9a94", hatch: null },
  { id: "wood", color: "#b9844b", hatch: null },
  { id: "dirt", color: "#7a5836", hatch: null },
  { id: "grass", color: "#6aa84f", hatch: null },
  { id: "sand", color: "#dfbd62", hatch: null },
  { id: "snow", color: "#dce8f2", hatch: DARK_HATCH },
  { id: "ice", color: "#a8e0ec", hatch: DARK_HATCH },
  { id: "rubble", color: "#8c8378", hatch: DARK_HATCH },
  { id: "brush", color: "#3d7a37", hatch: LIGHT_HATCH },
  { id: "shallow", color: "#5ca6d4", hatch: DARK_HATCH },
  { id: "deep", color: "#1f5a99", hatch: null },
  { id: "mud", color: "#50472b", hatch: LIGHT_HATCH },
  { id: "lava", color: "#e8531d", hatch: null },
  { id: "chasm", color: "#2e2146", hatch: null },
  { id: "rock", color: "#4a4540", hatch: null },
] as const satisfies readonly TerrainDef[];

export type TerrainId = (typeof TERRAIN)[number]["id"];

export const TERRAIN_BY_ID: ReadonlyMap<string, TerrainDef> = new Map(TERRAIN.map((t) => [t.id, t]));

export function isTerrainId(value: unknown): value is TerrainId {
  return typeof value === "string" && TERRAIN_BY_ID.has(value);
}

// Edge types (plan 8.2) and their signs: wall a thick line; door a rectangle across the edge;
// secret door a wall with the letter S; window a thin double line; bars a dashed line.
export const EDGE_TYPES = ["wall", "door", "secret", "window", "bars"] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export function isEdgeType(value: unknown): value is EdgeType {
  return (EDGE_TYPES as readonly unknown[]).includes(value);
}

/** Colours of walls and openings, identical in every theme like the terrain. */
export const EDGE_COLORS = {
  line: "#26211c",
  door: "#a8743e",
  letter: "#f4ead2",
} as const;

/**
 * Terrain that costs 5 ft more to enter (plan 5.6, canon-5e.md «Местность на доске»): difficult terrain
 * and deep water (swimming without a swim speed). Chasm and rock stop nothing and cost nothing extra,
 * the GM rules on them.
 */
const EXTRA_COST_TERRAIN: ReadonlySet<string> = new Set<TerrainId>(["snow", "ice", "rubble", "brush", "shallow", "mud", "deep"]);

export function costsExtraToEnter(terrain: unknown): boolean {
  return typeof terrain === "string" && EXTRA_COST_TERRAIN.has(terrain);
}

// ---- tokens (plan 8.3) ----

/** Sides of a token with their colours, identical in every theme. */
export const SIDES = [
  { id: "players", color: "#2f7de1" },
  { id: "enemies", color: "#d23c3c" },
  { id: "allies", color: "#2e9e57" },
  { id: "neutral", color: "#c9971c" },
] as const;

export type SideId = (typeof SIDES)[number]["id"];

const SIDE_COLOR: ReadonlyMap<string, string> = new Map(SIDES.map((s) => [s.id, s.color]));

export function isSideId(value: unknown): value is SideId {
  return typeof value === "string" && SIDE_COLOR.has(value);
}

export function sideColor(side: SideId): string {
  const color = SIDE_COLOR.get(side);
  if (!color) throw new Error(`unknown side ${side}`);
  return color;
}

/**
 * Creature sizes (canon-5e.md «Размеры существ»): `span` is the side of the space in cells.
 * A tiny token takes a quarter of its cell, up to TINY_PER_CELL in one cell.
 */
export const SIZES = [
  { id: "tiny", span: 1 },
  { id: "small", span: 1 },
  { id: "medium", span: 1 },
  { id: "large", span: 2 },
  { id: "huge", span: 3 },
  { id: "gargantuan", span: 4 },
] as const;

export type SizeId = (typeof SIZES)[number]["id"];

export const TINY_PER_CELL = 4;

const SIZE_SPAN: ReadonlyMap<string, number> = new Map(SIZES.map((s) => [s.id, s.span]));

export function isSizeId(value: unknown): value is SizeId {
  return typeof value === "string" && SIZE_SPAN.has(value);
}

export function sizeSpan(size: SizeId): number {
  const span = SIZE_SPAN.get(size);
  if (span === undefined) throw new Error(`unknown size ${size}`);
  return span;
}

/** Colours of the token outline and name label, identical in every theme. */
export const TOKEN_COLORS = {
  outline: "#15181c",
  label: "#ffffff",
  labelBack: "rgba(15, 18, 22, 0.75)",
} as const;

// ---- objects (plan 8.3): map symbols drawn as vector signs (signs.ts) ----

export const OBJECT_TYPES = [
  "pillar",
  "stairs",
  "trapdoor",
  "pit",
  "statue",
  "tree",
  "boulder",
  "crate",
  "barrel",
  "chest",
  "table",
  "bed",
  "campfire",
  "altar",
  "trap",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export function isObjectType(value: unknown): value is ObjectType {
  return (OBJECT_TYPES as readonly unknown[]).includes(value);
}

/** Colours of the object signs, identical in every theme like the terrain. */
export const OBJECT_COLORS = {
  ink: "#26211c",
  stone: "#c9c4ba",
  wood: "#a8743e",
  leaf: "#3f8a3a",
  fire: "#f08a24",
  flame: "#ffd23f",
  hole: "#141210",
  danger: "#c0392b",
  cloth: "#e9e2d0",
} as const;

// ---- pencil (plan 8.3) ----

/** Colours of pencil marks, the first is the default; identical in every theme. A mark stores `value`. */
export const MARK_COLORS = [
  { id: "red", value: "#c0392b" },
  { id: "orange", value: "#e67e22" },
  { id: "yellow", value: "#f1c40f" },
  { id: "green", value: "#27ae60" },
  { id: "blue", value: "#2980b9" },
  { id: "purple", value: "#8e44ad" },
  { id: "white", value: "#ffffff" },
  { id: "black", value: "#1d1d1d" },
] as const;

export type MarkColor = (typeof MARK_COLORS)[number]["value"];

export function isMarkColor(value: unknown): value is MarkColor {
  return MARK_COLORS.some((color) => color.value === value);
}
