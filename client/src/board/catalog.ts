// Canonical board data shared by the client and the server: terrain and edge types. No DOM, no storage.

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
