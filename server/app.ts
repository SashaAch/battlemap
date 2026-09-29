// The site: settings, database, accounts, the API routes of plan 6.4 and the client files.
// main.ts starts it for real; the tests start it on a free port with the data in a temporary folder.

import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { TLSSocket } from "node:tls";

import { Accounts, checkSettings, meView, SESSION_COOKIE, SESSION_LIFETIME_MS, userView } from "./auth.ts";
import type { Authenticated } from "./auth.ts";
import { Database } from "./db.ts";
import { ApiError } from "./errors.ts";
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
  requestPath,
  SECURITY_HEADERS,
  sendJson,
  serveClientFile,
  stringField,
} from "./http.ts";
import { SettingsFile } from "./settings.ts";

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
  /** Set for every route but `anyone`, which may still get a session. */
  auth: Authenticated | null;
  address: string;
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

function signedIn(call: Call): Authenticated {
  if (!call.auth) throw new ApiError("auth.required");
  return call.auth;
}

function makeRoutes(accounts: Accounts, settings: SettingsFile): Map<string, Route> {
  const openRegistration = (): boolean => settings.current.openRegistration;

  return new Map<string, Route>([
    [
      "POST /api/auth/register",
      {
        access: "anyone",
        limit: AUTH_BODY_LIMIT,
        async handle({ body }) {
          const { user, token } = await accounts.register(
            {
              login: stringField(body, "login"),
              displayName: stringField(body, "displayName"),
              password: stringField(body, "password"),
              code: optionalStringField(body, "code"),
              setup: optionalStringField(body, "setup"),
            },
            openRegistration(),
          );
          return { status: 201, body: meView(user), session: token };
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
        handle({ auth }) {
          if (auth) accounts.logout(auth);
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
          const user = await accounts.changePassword(signedIn(call), stringField(body, "currentPassword"), stringField(body, "newPassword"), address);
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
              const role = body.role === undefined ? "user" : body.role;
              if (role !== "user" && role !== "admin") throw new ApiError("request.format");
              const created = await accounts.createUser(stringField(body, "login"), stringField(body, "displayName"), role);
              return { status: 201, body: { user: userView(created.user), password: created.password } };
            }
            case "resetPassword": {
              const reset = await accounts.resetPassword(admin, idField(body, "id"));
              return { status: 200, body: { user: userView(reset.user), password: reset.password } };
            }
            case "setDisabled":
              return { status: 200, body: { user: userView(accounts.setDisabled(admin, idField(body, "id"), booleanField(body, "disabled"))) } };
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
          return { status: 201, body: accounts.createInvite(signedIn(call).user) };
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
  let setupToken: string | null;

  try {
    db.deleteExpired(now());
    const accounts = new Accounts(db, now);
    setupToken = accounts.startSetup();
    const routes = makeRoutes(accounts, settings);

    const handleApi = async (req: IncomingMessage, res: ServerResponse, urlPath: string, secure: boolean): Promise<void> => {
      const route = routes.get(`${req.method} ${urlPath}`);
      if (!route) throw new ApiError("request.notFound");

      // Forged requests from other sites (plan 5.10): a change needs JSON and our own Origin.
      const changes = req.method !== "GET";
      if (changes && !isSameOrigin(req, secure)) throw new ApiError("request.origin");
      if (changes && !isJsonRequest(req)) throw new ApiError("request.contentType");

      const auth = accounts.authenticate(readCookie(req, SESSION_COOKIE));
      if (route.access !== "anyone") {
        if (!auth) throw new ApiError("auth.required");
        if (auth.user.mustChangePassword && !route.beforePasswordChange) throw new ApiError("auth.mustChangePassword");
        if (route.access === "admin" && auth.user.role !== "admin") throw new ApiError("auth.forbidden");
      }

      const body = changes ? await readJsonObject(req, route.limit ?? BODY_LIMIT) : {};
      const reply = await route.handle({ body, auth, address: req.socket.remoteAddress ?? "" });

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
        if (urlPath === null) throw new ApiError("request.notFound");
        if (urlPath.startsWith("/api/")) return handleApi(req, res, urlPath, secure);
        const isRead = req.method === "GET" || req.method === "HEAD";
        if (!isRead || !(await serveClientFile(req, res, clientDir, urlPath))) throw new ApiError("request.notFound");
      };

      answer().catch((error: unknown) => {
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
    server.close();
    db.close();
    throw error;
  }

  const port = (server.address() as AddressInfo).port;
  const shownHost = options.host === undefined || options.host === "0.0.0.0" || options.host === "::" ? "localhost" : options.host;
  const origin = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}`;
  const setupLink = setupToken === null ? null : `${origin}/#setup=${setupToken}`;

  if (created) log(`Создан файл настроек / Settings file created: ${path.join(options.dataDir, "settings.json")}`);
  log(`battlemap: ${origin}/`);
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
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
    },
  };
}
