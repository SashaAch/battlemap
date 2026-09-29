// Starts the site: `node server/main.ts [--data <folder>] [--host <address>]`.
// The data folder defaults to data/ in the current folder; without --host the server listens on all addresses.

import path from "node:path";
import { parseArgs } from "node:util";

import { startServer } from "./app.ts";

const { values } = parseArgs({ options: { data: { type: "string" }, host: { type: "string" } } });

try {
  const server = await startServer({
    dataDir: path.resolve(values.data ?? "data"),
    host: values.host,
    log: (line) => console.log(line),
  });
  const stop = (): void => {
    // Closing writes the scenes changed in the last second; a failure there is printed.
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`battlemap: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(`battlemap: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
