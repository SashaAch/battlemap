// Streams of events (plan 6.3): Server-Sent Events over node:http, one per tab of an open game. This module
// keeps the open streams, writes events, keeps them awake, limits them per user and closes them; who gets
// which event is decided by games.ts, which checks the rights. Presence (who is online) is the set of members
// of a game with an open stream.

import type { ServerResponse } from "node:http";

import { ApiError } from "./errors.ts";
import { MIB } from "./http.ts";

/** Plan 5.10: at most this many open streams per user; the next one gets 429. */
export const MAX_STREAMS_PER_USER = 16;
/** A comment line this often keeps proxies and browsers from dropping a quiet stream. */
export const HEARTBEAT_MS = 25_000;
/** A client that reads slower than the events come is cut off at this much unsent data; it reconnects and gets a fresh snapshot. */
const MAX_UNSENT_BYTES = 8 * MIB;

/** What the viewer of a stream was last shown; games.ts keeps it to tell when to send a new snapshot. */
export interface StreamView {
  editor: boolean;
  /** The scene the snapshot showed; null for "no scene". */
  sceneId: number | null;
}

export class Stream {
  readonly userId: number;
  readonly gameId: number;
  /** The session the stream was opened with: signing out closes the streams of that session. */
  readonly tokenHash: Buffer;
  view: StreamView | null = null;
  readonly #res: ServerResponse;

  constructor(res: ServerResponse, userId: number, gameId: number, tokenHash: Buffer) {
    this.#res = res;
    this.userId = userId;
    this.gameId = gameId;
    this.tokenHash = tokenHash;
  }

  get closed(): boolean {
    return this.#res.writableEnded || this.#res.destroyed;
  }

  send(event: string, data: unknown): void {
    // JSON.stringify escapes line breaks, so the data is always one line.
    this.#write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** A comment line: the browser ignores it. */
  heartbeat(): void {
    this.#write(":\n\n");
  }

  close(): void {
    if (!this.closed) this.#res.end();
  }

  #write(text: string): void {
    if (this.closed) return;
    this.#res.write(text);
    if (this.#res.writableLength > MAX_UNSENT_BYTES) this.#res.destroy();
  }
}

export class Streams {
  readonly #streams = new Set<Stream>();
  readonly #heartbeat: ReturnType<typeof setInterval>;

  constructor() {
    this.#heartbeat = setInterval(() => {
      for (const stream of this.#streams) stream.heartbeat();
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  /**
   * Starts the event stream answer on `res` and registers it; `headers` are added (a renewed session cookie).
   * 429 when the user already has MAX_STREAMS_PER_USER open. The caller sends the first events.
   */
  open(res: ServerResponse, userId: number, gameId: number, tokenHash: Buffer, headers: Record<string, string>): Stream {
    let count = 0;
    for (const stream of this.#streams) if (stream.userId === userId) count++;
    if (count >= MAX_STREAMS_PER_USER) throw new ApiError("stream.tooMany");
    res.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    const stream = new Stream(res, userId, gameId, tokenHash);
    this.#streams.add(stream);
    res.on("close", () => {
      this.#streams.delete(stream);
      this.announce(gameId);
    });
    return stream;
  }

  ofGame(gameId: number): Stream[] {
    return [...this.#streams].filter((stream) => stream.gameId === gameId && !stream.closed);
  }

  /** Sends the members online (with an open stream) to every stream of the game. */
  announce(gameId: number): void {
    const streams = this.ofGame(gameId);
    const online = [...new Set(streams.map((stream) => stream.userId))].sort((a, b) => a - b);
    for (const stream of streams) stream.send("presence", { online });
  }

  /** Signing out: the streams of that session. */
  closeSession(tokenHash: Buffer): void {
    this.#close((stream) => stream.tokenHash.equals(tokenHash));
  }

  /** A new password, a reset or disabling: every stream of the user, except those of the session `keep` (the one that changed the password). */
  closeUser(userId: number, keep?: Buffer): void {
    this.#close((stream) => stream.userId === userId && !(keep && stream.tokenHash.equals(keep)));
  }

  /** A deleted game. */
  closeGame(gameId: number): void {
    this.#close((stream) => stream.gameId === gameId);
  }

  /** The server stops. */
  closeAll(): void {
    clearInterval(this.#heartbeat);
    this.#close(() => true);
  }

  #close(which: (stream: Stream) => boolean): void {
    for (const stream of this.#streams) if (which(stream)) stream.close();
  }
}
