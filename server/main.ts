// Starts the site: `node server/main.ts [--data <folder>] [--host <address>]`.
// The data folder defaults to data/ in the current folder; without --host the server listens on all addresses.

import path from "node:path";
import { parseArgs } from "node:util";

import { startServer } from "./app.ts";
import { stopOnSignals } from "./stop.ts";

const { values } = parseArgs({ options: { data: { type: "string" }, host: { type: "string" } } });

try {
  const server = await startServer({
    dataDir: path.resolve(values.data ?? "data"),
    host: values.host,
    log: (line) => console.log(line),
  });
  // Closing writes the scenes changed in the last second; a failure there is printed.
  stopOnSignals(
    process,
    () => server.close(),
    (code) => process.exit(code),
    (error) => console.error(`battlemap: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
  );
} catch (error) {
  console.error(`battlemap: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
