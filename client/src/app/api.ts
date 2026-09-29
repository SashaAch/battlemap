// Requests to the server (plan 6.4). Paths are relative, so the page also works from a sub-folder (GitHub Pages).
// No DOM here.

import type { LANGS } from "../i18n/index.ts";
import type { THEME_CHOICES } from "../theme.ts";

export interface AccountSettings {
  lang?: (typeof LANGS)[number];
  theme?: (typeof THEME_CHOICES)[number];
}

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
export async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: object): Promise<T> {
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
