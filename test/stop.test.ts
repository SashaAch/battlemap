// Stopping on a signal (server/stop.ts): every stop signal, Windows ones too, closes the server once, which writes
// the scenes, and then the process ends. The signals come from an EventEmitter in place of the process.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import { STOP_SIGNALS, stopOnSignals } from "../server/stop.ts";

function watch(close: () => Promise<void>) {
  const source = new EventEmitter();
  const calls = { closes: 0, exits: [] as number[], reports: [] as unknown[] };
  stopOnSignals(
    source,
    () => {
      calls.closes++;
      return close();
    },
    (code) => calls.exits.push(code),
    (error) => calls.reports.push(error),
  );
  return { source, calls };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("stopping on a signal", () => {
  test("the signals are Ctrl+C, a service manager's, a closed console window and Ctrl+Break", () => {
    assert.deepEqual([...STOP_SIGNALS], ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
  });

  for (const signal of STOP_SIGNALS) {
    test(`${signal} closes the server, then the process ends with 0`, async () => {
      const { source, calls } = watch(async () => undefined);
      source.emit(signal);
      await settled();
      assert.deepEqual(calls, { closes: 1, exits: [0], reports: [] });
    });
  }

  test("more signals while closing do not close again or end the process early", async () => {
    let finish = (): void => undefined;
    const { source, calls } = watch(() => new Promise<void>((resolve) => (finish = resolve)));
    source.emit("SIGHUP");
    source.emit("SIGINT");
    source.emit("SIGHUP");
    await settled();
    assert.deepEqual(calls, { closes: 1, exits: [], reports: [] }, "still writing");
    finish();
    await settled();
    assert.deepEqual(calls, { closes: 1, exits: [0], reports: [] });
  });

  test("a failed close is reported and the process ends with 1", async () => {
    const failure = new Error("disk full");
    const { source, calls } = watch(() => Promise.reject(failure));
    source.emit("SIGBREAK");
    await settled();
    assert.deepEqual(calls, { closes: 1, exits: [1], reports: [failure] });
  });
});
