// HTTP plumbing for app.ts: security headers, request checks, bodies with limits, cookies, client files.

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { ApiError } from "./errors.ts";

/** Sent with every response (plan 5.10). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const KIB = 1024;
export const MIB = 1024 * KIB;

// ---- requests ----

/** The path of the request target exactly as sent, without the query; null for anything but an absolute path. */
export function requestPath(req: IncomingMessage): string | null {
  const target = req.url ?? "";
  if (!target.startsWith("/")) return null;
  const query = target.indexOf("?");
  return query < 0 ? target : target.slice(0, query);
}

/** The request came from a page of this server: Origin equals the scheme and Host of the request (a Host already allowed). */
export function isSameOrigin(req: IncomingMessage, secure: boolean): boolean {
  const { origin, host } = req.headers;
  if (!origin || !host) return false;
  return origin.toLowerCase() === `${secure ? "https" : "http"}://${host.toLowerCase()}`;
}

export function isJsonRequest(req: IncomingMessage): boolean {
  const type = req.headers["content-type"];
  return type !== undefined && type.split(";")[0].trim().toLowerCase() === "application/json";
}

/** The client closed the connection before sending the whole body: nothing to answer, not a server error. */
export class RequestAborted extends Error {}

/** The client declared a body that has not been read to the end. */
export function hasUnreadBody(req: IncomingMessage): boolean {
  const length = req.headers["content-length"];
  const declared = req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
  return declared && !req.readableEnded;
}

/**
 * Reads the body, stopping as soon as it passes `limit` bytes: a declared Content-Length over the limit
 * is refused before reading anything, a longer stream at the first chunk over the limit.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers["content-length"]) > limit) return Promise.reject(new ApiError("request.tooLarge"));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onFailure);
      req.off("close", onFailure);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        stop();
        req.pause();
        reject(new ApiError("request.tooLarge"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      resolve(Buffer.concat(chunks, size));
    };
    const onFailure = (): void => {
      stop();
      reject(new RequestAborted("the client closed the request before its body ended"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onFailure);
    req.on("close", onFailure);
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A JSON object body; anything else is `request.format`. */
export async function readJsonObject(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, limit);
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new ApiError("request.format");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError("request.format");
  return value as Record<string, unknown>;
}

// ---- fields of a JSON body ----

export function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new ApiError("request.format");
  return value;
}

export function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  return body[name] === undefined ? undefined : stringField(body, name);
}

export function booleanField(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") throw new ApiError("request.format");
  return value;
}

export function idField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ApiError("request.format");
  return value;
}

// ---- cookies ----

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const equals = part.indexOf("=");
    if (equals > 0 && part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim();
  }
  return undefined;
}

/** A cookie the page scripts cannot read; `value` null removes it. */
export function cookieHeader(name: string, value: string | null, maxAgeMs: number, secure: boolean): string {
  const parts = [`${name}=${value ?? ""}`, `Max-Age=${value === null ? 0 : Math.floor(maxAgeMs / 1000)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// ---- responses ----

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (body === undefined) {
    res.writeHead(status, { ...headers, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

// ---- client files ----

/**
 * The only client files served: the page, its two style sheets and the build output in dist/.
 * A name that does not match exactly (`..`, `\`, `%2e%2e`, `:`, sub-folders) is simply not found.
 */
const CLIENT_FILE = /^(?:index\.html|style\.css|themes\.css|dist\/[A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves a client file for GET or HEAD. `clientDir` must be a real path (no links in it).
 * Returns false when there is no such file, so the caller answers 404.
 */
export async function serveClientFile(req: IncomingMessage, res: ServerResponse, clientDir: string, urlPath: string): Promise<boolean> {
  let name: string;
  try {
    name = decodeURIComponent(urlPath.slice(1)) || "index.html";
  } catch {
    return false;
  }
  if (!CLIENT_FILE.test(name)) return false;

  let file: string;
  try {
    // A link inside client/ must not lead out of it either.
    file = await realpath(path.join(clientDir, ...name.split("/")));
  } catch {
    return false;
  }
  const inside = path.relative(clientDir, file);
  if (inside === "" || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return false;
  const info = await stat(file);
  if (!info.isFile()) return false;

  // no-cache: the browser asks every time, so the client always matches the server (plan 7).
  const tag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    ETag: tag,
  };
  if (req.headers["if-none-match"] === tag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
  return true;
}
