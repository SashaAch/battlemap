// `npm run dev` (plan 5.14): rebuilds the client on every change and restarts the server with `node --watch`.
// The build options match the `build` script in package.json, plus a source map and no minifying.

import { spawn } from "node:child_process";
import path from "node:path";

import { context } from "esbuild";

const root = path.join(import.meta.dirname, "..");

const client = await context({
  entryPoints: [path.join(root, "client", "src", "main.ts")],
  bundle: true,
  sourcemap: true,
  target: "es2022",
  outfile: path.join(root, "client", "dist", "app.js"),
  logLevel: "info",
});
await client.watch();

const server = spawn(process.execPath, ["--watch", path.join(root, "server", "main.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
server.on("exit", (code) => {
  void client.dispose().finally(() => process.exit(code ?? 0));
});
