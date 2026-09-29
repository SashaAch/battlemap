// The event stream of an open game (plan 6.3): `api/stream?game=<id>` read with the browser's EventSource,
// which reconnects by itself when the connection drops; the server then starts again with a fresh snapshot.
// A refusal (no session, not a member, too many streams) ends it for good: the caller finds out why.

/** The events of plan 6.3 this stage sends. */
const EVENTS = ["scene.snapshot", "scene.patch", "scene.switch", "ping", "presence"] as const;
export type StreamEventName = (typeof EVENTS)[number];

export interface StreamHandlers {
  /** An event with its data, in the order the server sent them. Data that is not JSON ends the stream as `failed`. */
  event(name: StreamEventName, data: unknown): void;
  /** The stream is open (again). */
  connected(): void;
  /** The connection dropped; the browser is reconnecting. */
  lost(): void;
  /** The server refused the stream, or sent something unreadable; nothing more comes. */
  failed(): void;
}

export interface GameStream {
  close(): void;
}

export function openStream(gameId: number, handlers: StreamHandlers): GameStream {
  const source = new EventSource(`api/stream?game=${gameId}`);
  let open = true;
  const stop = (): void => {
    open = false;
    source.close();
  };
  for (const name of EVENTS) {
    source.addEventListener(name, (message) => {
      if (!open) return;
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        stop();
        handlers.failed();
        return;
      }
      handlers.event(name, data);
    });
  }
  source.addEventListener("open", () => {
    if (open) handlers.connected();
  });
  source.addEventListener("error", () => {
    if (!open) return;
    if (source.readyState === EventSource.CLOSED) {
      stop();
      handlers.failed();
    } else {
      handlers.lost();
    }
  });
  return { close: stop };
}
