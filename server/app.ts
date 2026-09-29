// The site: settings, database, accounts, the API routes of plan 6.4 and the client files.
// main.ts starts it for real; the tests start it on a free port with the data in a temporary folder.

import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { TLSSocket } from "node:tls";

import { Accounts, checkSettings, meView, SESSION_COOKIE, SESSION_LIFETIME_MS, sha256, userView } from "./auth.ts";
import type { Authenticated } from "./auth.ts";
import { Database } from "./db.ts";
import type { GameKind, Role, User } from "./db.ts";
import { ApiError } from "./errors.ts";
import { Games } from "./games.ts";
import {
  booleanField,
  cookieHeader,
  hasUnreadBody,
  idField,
  isJsonRequest,
  isSameOrigin,
  KIB,
  MIB,
  optionalStringField,
  readCookie,
  readJsonObject,
  RequestAborted,
  requestPath,
  SECURITY_HEADERS,
  sendJson,
  serveClientFile,
  stringField,
} from "./http.ts";
import { hostName, HostCheck, inviteLinks, siteLinks } from "./network.ts";
import { SettingsFile } from "./settings.ts";
import { Streams } from "./stream.ts";

const CLIENT_DIR = path.join(import.meta.dirname, "..", "client");

/** Plan 6.2: bodies up to 2 MiB, for sign-in and registration up to 4 KiB. */
const BODY_LIMIT = 2 * MIB;
const AUTH_BODY_LIMIT = 4 * KIB;

export interface ServerOptions {
  /** Folder with settings.json and battlemap.db; created when missing. */
  dataDir: string;
  /** Address to listen on; all addresses when absent. */
  host?: string;
  /** Overrides the port from settings.json; 0 picks a free one. */
  port?: number;
  /** The clock, replaced in tests. */
  now?: () => number;
  /** How often open event streams are kept awake and their sessions checked; HEARTBEAT_MS, shorter in tests. */
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  /** The one-time link for creating the first administrator; null when users exist. */
  setupLink: string | null;
  close(): Promise<void>;
}

// ---- routes ----

interface Call {
  body: Record<string, unknown>;
  /** The `:name` parts of the route path (see matchRoute). */
  params: Record<string, string>;
  /** Set for every route but `anyone`, which may still get a session. */
  auth: Authenticated | null;
  /** The session cookie as sent, valid or not. */
  sessionToken: string | undefined;
  address: string;
  /** The Host header as sent (HostCheck has let it in) and whether the request came over HTTPS. */
  host: string | undefined;
  secure: boolean;
}

interface Reply {
  status: number;
  body?: unknown;
  /** A new session token to set, or null to remove the cookie. */
  session?: string | null;
}

interface Route {
  access: "anyone" | "user" | "admin";
  /** Body limit of a request that changes data. */
  limit?: number;
  /** Open to a user who still has to replace a password reset by an administrator. */
  beforePasswordChange?: boolean;
  handle(call: Call): Reply | Promise<Reply>;
}

function roleField(body: Record<string, unknown>): Role {
  if (body.role !== "user" && body.role !== "admin") throw new ApiError("request.format");
  return body.role;
}

function signedIn(call: Call): Authenticated {
  if (!call.auth) throw new ApiError("auth.required");
  return call.auth;
}

function gameKindField(body: Record<string, unknown>): GameKind {
  if (body.kind !== "gm" && body.kind !== "personal") throw new ApiError("request.format");
  return body.kind;
}

/** A path part that is a record id: 1 and up, at most 15 digits, so it is a safe integer. */
const ID_PART = /^[1-9][0-9]{0,14}$/;
/** A path part that is an invite code. */
const CODE_PART = /^[a-z0-9]{1,64}$/;

/**
 * Finds the route for a method and path. A route path part `:code` matches an invite code, any other `:name`
 * a record id; anything else must be equal. No route, including a malformed id, is 404.
 */
function matchRoute(routes: Map<string, Route>, method: string, urlPath: string): { route: Route; params: Record<string, string> } | null {
  // A path with ":" is never looked up as is: a literal `/api/join/:code` must not reach a route without its parameters.
  const exact = urlPath.includes(":") ? undefined : routes.get(`${method} ${urlPath}`);
  if (exact) return { route: exact, params: {} };
  const parts = urlPath.split("/");
  for (const [key, route] of routes) {
    const [routeMethod, routePath] = key.split(" ");
    const routeParts = routePath.split("/");
    if (routeMethod !== method || routeParts.length !== parts.length || !routePath.includes(":")) continue;
    const params: Record<string, string> = {};
    const matches = routeParts.every((part, index) => {
      if (!part.startsWith(":")) return part === parts[index];
      const name = part.slice(1);
      params[name] = parts[index];
      return (name === "code" ? CODE_PART : ID_PART).test(parts[index]);
    });
    if (matches) return { route, params };
  }
  return null;
}

const idParam = (call: Call, name: string): number => Number(call.params[name]);

/** Where the server listens; the port is set once it listens, before any request comes. */
interface Listening {
  host: string | undefined;
  port: number;
}

function makeRoutes(accounts: Accounts, settings: SettingsFile, games: Games, streams: Streams, listening: Listening): Map<string, Route> {
  const openRegistration = (): boolean => settings.current.openRegistration;
  const user = (call: Call): User => signedIn(call).user;
  const gameId = (call: Call): number => idParam(call, "id");
  const sceneId = (call: Call): number => idParam(call, "sid");

  return new Map<string, Route>([
    [
      "POST /api/auth/register",
      {
        access: "anyone",
        limit: AUTH_BODY_LIMIT,
        async handle({ body, address }) {
          const { user, token, gameId } = await accounts.register(
            {
              login: stringField(body, "login"),
              displayName: stringField(body, "displayName"),
              password: stringField(body, "password"),
              code: optionalStringField(body, "code"),
              setup: optionalStringField(body, "setup"),
            },
            openRegistration(),
            address,
          );
          // An administrator's game invite made the user a player (R43): the others see them at once.
          if (gameId !== null) games.memberRegistered(gameId);
          return { status: 201, body: { ...meView(user), gameId }, session: token };
        },
      },
    ],
    [
      "POST /api/auth/login",
      {
        access: "anyone",
        limit: AUTH_BODY_LIMIT,
        async handle({ body, address }) {
          const { user, token } = await accounts.login(stringField(body, "login"), stringField(body, "password"), address);
          return { status: 200, body: meView(user), session: token };
        },
      },
    ],
    [
      "POST /api/auth/logout",
      {
        access: "anyone",
        limit: AUTH_BODY_LIMIT,
        handle({ auth, sessionToken }) {
          if (auth) accounts.logout(auth);
          // The streams of this cookie close even when its session already expired (auth is null then).
          if (sessionToken !== undefined) streams.closeSession(sha256(sessionToken));
          return { status: 204, session: null };
        },
      },
    ],
    [
      "GET /api/me",
      {
        access: "anyone",
        beforePasswordChange: true,
        handle({ auth }) {
          // Without a session the client shows the sign-in screen and needs to know whether a code is asked for.
          if (!auth) return { status: 401, body: { error: "auth.required", openRegistration: accounts.registrationOpen(openRegistration()) } };
          return { status: 200, body: meView(auth.user) };
        },
      },
    ],
    [
      "POST /api/me/password",
      {
        access: "user",
        limit: BODY_LIMIT,
        beforePasswordChange: true,
        async handle(call) {
          const { body, address } = call;
          const auth = signedIn(call);
          const user = await accounts.changePassword(auth, stringField(body, "currentPassword"), stringField(body, "newPassword"), address);
          // The other sessions ended, and so do their streams.
          streams.closeUser(user.id, auth.tokenHash);
          return { status: 200, body: meView(user) };
        },
      },
    ],
    [
      "PUT /api/me/settings",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          return { status: 200, body: { settings: accounts.saveSettings(signedIn(call).user, checkSettings(call.body)) } };
        },
      },
    ],
    [
      "GET /api/admin/users",
      {
        access: "admin",
        handle() {
          return { status: 200, body: { users: accounts.listUsers().map(userView) } };
        },
      },
    ],
    [
      "POST /api/admin/users",
      {
        access: "admin",
        limit: BODY_LIMIT,
        async handle(call) {
          const { body } = call;
          const admin = signedIn(call).user;
          switch (body.action) {
            case "create": {
              const role = body.role === undefined ? "user" : roleField(body);
              const created = await accounts.createUser(stringField(body, "login"), stringField(body, "displayName"), role);
              return { status: 201, body: { user: userView(created.user), password: created.password } };
            }
            case "resetPassword": {
              const reset = await accounts.resetPassword(admin, idField(body, "id"));
              streams.closeUser(reset.user.id);
              return { status: 200, body: { user: userView(reset.user), password: reset.password } };
            }
            case "setDisabled": {
              const changed = accounts.setDisabled(admin, idField(body, "id"), booleanField(body, "disabled"));
              if (changed.disabled) streams.closeUser(changed.id);
              return { status: 200, body: { user: userView(changed) } };
            }
            case "setRole":
              return { status: 200, body: { user: userView(accounts.setRole(admin, idField(body, "id"), roleField(body))) } };
            default:
              throw new ApiError("request.format");
          }
        },
      },
    ],
    [
      "POST /api/admin/invites",
      {
        access: "admin",
        limit: BODY_LIMIT,
        handle(call) {
          const { body } = call;
          return { status: 201, body: accounts.createInvite(signedIn(call).user, idField(body, "maxUses"), idField(body, "days")) };
        },
      },
    ],
    // ---- games (plan 5.11, 6.4); games.ts checks the rights in the game ----
    [
      "GET /api/games",
      {
        access: "user",
        handle(call) {
          return { status: 200, body: { games: games.listGames(user(call)) } };
        },
      },
    ],
    [
      "POST /api/games",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          return { status: 201, body: games.createGame(user(call), stringField(call.body, "title"), gameKindField(call.body)) };
        },
      },
    ],
    [
      "GET /api/games/:id",
      {
        access: "user",
        handle(call) {
          return { status: 200, body: games.getGame(user(call), gameId(call)) };
        },
      },
    ],
    [
      "DELETE /api/games/:id",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.deleteGame(user(call), gameId(call));
          return { status: 204 };
        },
      },
    ],
    [
      "POST /api/games/:id/invites",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          const invite = games.createInvite(user(call), gameId(call), idField(call.body, "maxUses"), idField(call.body, "days"));
          // Links a phone in the same network opens (R43, plan 8.26); the first is the one shown at the start.
          const links = inviteLinks({
            listenHost: listening.host,
            port: listening.port,
            pageHost: call.host,
            secure: call.secure,
            fragment: `join=${invite.code}`,
          });
          return { status: 201, body: { ...invite, links } };
        },
      },
    ],
    [
      "POST /api/join/:code",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          return { status: 200, body: games.join(user(call), call.params.code, call.address) };
        },
      },
    ],
    [
      "POST /api/games/:id/master",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.setMaster(user(call), gameId(call), idField(call.body, "userId"));
          return { status: 200, body: games.getGame(user(call), gameId(call)) };
        },
      },
    ],
    [
      "DELETE /api/games/:id/master",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.takeMastery(user(call), gameId(call));
          return { status: 200, body: games.getGame(user(call), gameId(call)) };
        },
      },
    ],
    [
      "POST /api/games/:id/leave",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.leave(user(call), gameId(call));
          return { status: 204 };
        },
      },
    ],
    [
      "DELETE /api/games/:id/members/:user",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.removeMember(user(call), gameId(call), idParam(call, "user"));
          return { status: 204 };
        },
      },
    ],
    [
      "GET /api/games/:id/scenes",
      {
        access: "user",
        handle(call) {
          return { status: 200, body: { scenes: games.listScenes(user(call), gameId(call)) } };
        },
      },
    ],
    [
      "POST /api/games/:id/scenes",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          return { status: 201, body: games.createScene(user(call), gameId(call), stringField(call.body, "name")) };
        },
      },
    ],
    [
      "GET /api/games/:id/scenes/:sid",
      {
        access: "user",
        handle(call) {
          return { status: 200, body: games.getScene(user(call), gameId(call), sceneId(call)) };
        },
      },
    ],
    [
      "PUT /api/games/:id/scenes/:sid",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          const { body } = call;
          const change = {
            name: optionalStringField(body, "name"),
            visible: body.visible === undefined ? undefined : booleanField(body, "visible"),
          };
          return { status: 200, body: games.updateScene(user(call), gameId(call), sceneId(call), change) };
        },
      },
    ],
    [
      "POST /api/games/:id/scenes/:sid/patch",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          // The editor gets the new version, as in stage 5; a player's move is 204 (plan 8.6).
          const { version, editor } = games.patchScene(user(call), gameId(call), sceneId(call), call.body.patch);
          return editor ? { status: 200, body: { version } } : { status: 204 };
        },
      },
    ],
    [
      "POST /api/games/:id/scenes/:sid/activate",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.activateScene(user(call), gameId(call), sceneId(call));
          return { status: 204 };
        },
      },
    ],
    [
      "POST /api/games/:id/ping",
      {
        access: "user",
        limit: BODY_LIMIT,
        handle(call) {
          games.ping(user(call), gameId(call), call.body.x, call.body.y);
          return { status: 204 };
        },
      },
    ],
    [
      "GET /api/admin/settings",
      {
        access: "admin",
        handle() {
          return { status: 200, body: { openRegistration: openRegistration() } };
        },
      },
    ],
    [
      "PUT /api/admin/settings",
      {
        access: "admin",
        limit: BODY_LIMIT,
        async handle({ body }) {
          await settings.setOpenRegistration(booleanField(body, "openRegistration"));
          return { status: 200, body: { openRegistration: openRegistration() } };
        },
      },
    ],
  ]);
}

// ---- the server ----

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);

  await mkdir(options.dataDir, { recursive: true });
  const { settings, created } = await SettingsFile.open(options.dataDir);
  const clientDir = await realpath(CLIENT_DIR);
  const db = new Database(path.join(options.dataDir, "battlemap.db"));
  const server = createServer();
  const accounts = new Accounts(db, now);
  const streams = new Streams((tokenHash) => accounts.sessionAlive(tokenHash), options.heartbeatMs);
  const games = new Games(db, now, streams, (error) => log(`error: a scene was not saved: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
  let setupToken: string | null;
  const listening: Listening = { host: options.host, port: 0 };

  try {
    db.deleteExpired(now());
    setupToken = accounts.startSetup();
    const routes = makeRoutes(accounts, settings, games, streams, listening);
    const hosts = new HostCheck(settings.current.allowedHosts);

    /**
     * The event stream of a game (plan 6.3): `GET /api/stream?game=<id>`. Rights as for the game itself: 401 without
     * a session, 404 for someone who is not a member; 429 over the streams allowed per user.
     */
    const openStream = (req: IncomingMessage, res: ServerResponse, secure: boolean): void => {
      if (req.method !== "GET") throw new ApiError("request.notFound");
      const target = req.url ?? "";
      const query = target.includes("?") ? target.slice(target.indexOf("?") + 1) : "";
      const gameParam = new URLSearchParams(query).get("game");
      if (gameParam === null || !ID_PART.test(gameParam)) throw new ApiError("request.notFound");
      const auth = accounts.authenticate(readCookie(req, SESSION_COOKIE));
      if (!auth) throw new ApiError("auth.required");
      if (auth.user.mustChangePassword) throw new ApiError("auth.mustChangePassword");
      const headers: Record<string, string> = auth.extended ? { "Set-Cookie": cookieHeader(SESSION_COOKIE, auth.token, SESSION_LIFETIME_MS, secure) } : {};
      const gameId = Number(gameParam);
      games.openStream(auth.user, gameId, () => streams.open(res, auth.user.id, gameId, auth.tokenHash, headers));
    };

    const handleApi = async (req: IncomingMessage, res: ServerResponse, urlPath: string, secure: boolean): Promise<void> => {
      if (urlPath === "/api/stream") return openStream(req, res, secure);
      const found = matchRoute(routes, req.method ?? "", urlPath);
      if (!found) throw new ApiError("request.notFound");
      const { route, params } = found;

      // Forged requests from other sites (plan 5.10): a change needs JSON and our own Origin.
      const changes = req.method !== "GET";
      if (changes && !isSameOrigin(req, secure)) throw new ApiError("request.origin");
      if (changes && !isJsonRequest(req)) throw new ApiError("request.contentType");

      const sessionToken = readCookie(req, SESSION_COOKIE);
      const auth = accounts.authenticate(sessionToken);
      if (route.access !== "anyone") {
        if (!auth) throw new ApiError("auth.required");
        if (auth.user.mustChangePassword && !route.beforePasswordChange) throw new ApiError("auth.mustChangePassword");
        if (route.access === "admin" && auth.user.role !== "admin") throw new ApiError("auth.forbidden");
      }

      const body = changes ? await readJsonObject(req, route.limit ?? BODY_LIMIT) : {};
      const reply = await route.handle({ body, params, auth, sessionToken, address: req.socket.remoteAddress ?? "", host: req.headers.host, secure });

      const headers: Record<string, string> = {};
      if (reply.session !== undefined) {
        headers["Set-Cookie"] = cookieHeader(SESSION_COOKIE, reply.session, SESSION_LIFETIME_MS, secure);
      } else if (auth?.extended) {
        headers["Set-Cookie"] = cookieHeader(SESSION_COOKIE, auth.token, SESSION_LIFETIME_MS, secure);
      }
      sendJson(res, reply.status, reply.body, headers);
    };

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      const secure = (req.socket as TLSSocket).encrypted === true;
      const urlPath = requestPath(req);

      const answer = async (): Promise<void> => {
        // DNS rebinding: a page of a foreign name that resolves to this computer gets nothing, not even files.
        if (!hosts.allows(hostName(req.headers.host))) throw new ApiError("request.host");
        if (urlPath === null) throw new ApiError("request.notFound");
        if (urlPath.startsWith("/api/")) return handleApi(req, res, urlPath, secure);
        const isRead = req.method === "GET" || req.method === "HEAD";
        if (!isRead || !(await serveClientFile(req, res, clientDir, urlPath))) throw new ApiError("request.notFound");
      };

      answer().catch((error: unknown) => {
        if (error instanceof RequestAborted) {
          res.destroy();
          return;
        }
        const failure = error instanceof ApiError ? error : new ApiError("server.error");
        if (!(error instanceof ApiError)) log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        // Whatever the client still sends is not read: the connection closes after the answer.
        if (hasUnreadBody(req)) {
          res.setHeader("Connection", "close");
          res.on("finish", () => req.destroy());
        }
        sendJson(res, failure.status, { error: failure.code });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? settings.current.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    streams.closeAll();
    server.close();
    db.close();
    throw error;
  }

  const port = (server.address() as AddressInfo).port;
  listening.port = port;
  const links = siteLinks(port, options.host);
  const setupLink = setupToken === null ? null : `${links[0]}#setup=${setupToken}`;

  if (created) log(`Создан файл настроек / Settings file created: ${path.join(options.dataDir, "settings.json")}`);
  log("battlemap открыт по адресам / battlemap is open at:");
  for (const link of links) log(`  ${link}`);
  log("Внимание: сервер работает по HTTP, пароли идут по сети открытым текстом. Для доступа из интернета нужен HTTPS.");
  log("Warning: the server runs plain HTTP, passwords travel over the network unencrypted. Use HTTPS for access from the internet.");
  if (!existsSync(path.join(clientDir, "dist", "app.js"))) {
    log("Клиент не собран, выполните npm run build / The client is not built, run npm run build");
  }
  if (setupLink) {
    log("Пользователей ещё нет. Создайте администратора по одноразовой ссылке (действует до перезапуска сервера):");
    log("No users yet. Create the administrator with this one-time link (valid until the server restarts):");
    log(setupLink);
  }

  return {
    port,
    setupLink,
    /** Ends the streams and the connections, then writes the scenes changed in the last second (plan 8.6). */
    async close() {
      streams.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      try {
        games.saveAll();
      } finally {
        db.close();
      }
    },
  };
}
