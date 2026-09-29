// Requests to the server (plan 6.4). Paths are relative, so the page also works from a sub-folder (GitHub Pages).
// No DOM here.

import type { Patch, Scene } from "../board/store.ts";
import type { LANGS } from "../i18n/index.ts";
import type { THEME_CHOICES } from "../theme.ts";

/** The settings kept in the account (server/auth.ts). */
export interface AccountSettings {
  lang?: (typeof LANGS)[number];
  theme?: (typeof THEME_CHOICES)[number];
  /** The user's own colours of the void and the grid over it, `#rrggbb` (R45). */
  voidColor?: string;
  gridColor?: string;
  /** The tool column shows the names beside the icons (R45). */
  toolsExpanded?: boolean;
}

/** A change of the settings; a colour set to null goes back to the theme's. */
export type SettingsChange = Omit<AccountSettings, "voidColor" | "gridColor"> & {
  voidColor?: string | null;
  gridColor?: string | null;
};

export interface UserInfo {
  id: number;
  login: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: number;
}

export interface Me extends UserInfo {
  settings: AccountSettings;
}

/** A registration code or game invite that still lets someone in, in the administrator's list (R50); never the code. */
export interface AdminInvite {
  id: number;
  kind: "register" | "game";
  creatorName: string;
  /** The game of a game invite, null for a registration code. */
  gameTitle: string | null;
  usesLeft: number;
  expiresAt: number;
}

/** The answer to a registration:the new user, and the game an administrator's invite made them a player of (R43). */
export interface Registered extends Me {
  gameId: number | null;
}

// ---- games (server/games.ts) ----

export type GameKind = "gm" | "personal";
export type MemberRole = "gm" | "player";

/** A game in "my games". */
export interface GameSummary {
  id: number;
  title: string;
  kind: GameKind;
  role: MemberRole;
  isOwner: boolean;
  hasMaster: boolean;
}

export interface MemberInfo {
  id: number;
  displayName: string;
  role: MemberRole;
}

export interface SceneSummary {
  id: number;
  name: string;
  visible: boolean;
  /** The current scene of the game. */
  active: boolean;
  version: number;
}

/** A game as its member sees it; a player gets only the current scene, and only while it is visible. */
export interface GameInfo {
  id: number;
  title: string;
  kind: GameKind;
  ownerId: number;
  gmId: number | null;
  role: MemberRole;
  isOwner: boolean;
  /** Changes scenes, invites, members and the master. */
  editor: boolean;
  /** The master of a game, the owner of a personal campaign (R41). */
  canDelete: boolean;
  /** Anyone but the master and the owner of a personal campaign (R41). */
  canLeave: boolean;
  activeSceneId: number | null;
  members: MemberInfo[];
  scenes: SceneSummary[];
}

/** A link of a game invite on one address of the server's computer, with its network adapter when known (plan 8.26). */
export interface InviteLink {
  url: string;
  adapter: string | null;
}

/** A new game invite; the first link is the one to show at the start. */
export interface GameInvite {
  code: string;
  expiresAt: number;
  maxUses: number;
  links: InviteLink[];
}

/** An invite of a game that still lets someone in, in its editor's list (R52); never the code. */
export interface ActiveGameInvite {
  id: number;
  creatorName: string;
  usesLeft: number;
  expiresAt: number;
}

export interface SceneData extends SceneSummary {
  /** The scene (plan 6.1), not yet checked. */
  scene: unknown;
}

/**
 * The change sent to the server after a change of the board: every entry the inverse patch names, with its
 * value now (null when it is gone). Brings the server's copy from before to now for a new change, an undo and a redo.
 */
export function forwardPatch(scene: Scene, inverse: Patch): Patch {
  return inverse.map(([collection, key]) => {
    const entries = scene[collection];
    return [collection, key, Object.hasOwn(entries, key) ? entries[key] : null];
  });
}

/** What the page is at start-up (plan 5.3). */
export type Mode =
  | { kind: "draft" }
  | { kind: "signedOut"; openRegistration: boolean }
  | { kind: "signedIn"; me: Me };

/** Error codes made by the client itself; the rest come from the server (server/errors.ts). */
export const CLIENT_ERRORS = ["network", "unknown", "passwordMismatch"] as const;

export class ApiFailure extends Error {
  /** A server error code, or one of CLIENT_ERRORS. */
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const START_TIMEOUT_MS = 10_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMe(value: unknown): value is Me {
  return isObject(value) && typeof value.login === "string" && typeof value.displayName === "string" && isObject(value.settings);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Asks `api/me`. No answer, or an answer that is not from this server (GitHub Pages gives an HTML 404),
 * means the draft mode without a server.
 */
export async function detectMode(): Promise<Mode> {
  let response: Response;
  try {
    response = await fetch("api/me", { credentials: "same-origin", signal: AbortSignal.timeout(START_TIMEOUT_MS) });
  } catch {
    return { kind: "draft" };
  }
  const body = await readJson(response);
  if (response.status === 200 && isMe(body)) return { kind: "signedIn", me: body };
  if (response.status === 401 && isObject(body) && body.error === "auth.required") {
    return { kind: "signedOut", openRegistration: body.openRegistration === true };
  }
  return { kind: "draft" };
}

/** Sends a request; a change always goes as JSON (the server refuses anything else). Throws ApiFailure. */
export async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: object): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (method !== "GET") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiFailure(0, "network");
  }
  if (response.status === 204) return undefined as T;
  const data = await readJson(response);
  if (!response.ok) {
    throw new ApiFailure(response.status, isObject(data) && typeof data.error === "string" ? data.error : "unknown");
  }
  return data as T;
}
