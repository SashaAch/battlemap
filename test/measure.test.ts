// Measuring there and back with `?measure` in the address (client/src/app/measure.ts, R42).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Point } from "../client/src/board/geometry.ts";
import { echoChange, LOST_MS, measuring, median, RoundTrips } from "../client/src/app/measure.ts";

describe("the measure flag", () => {
  test("only `measure` among the parameters after ? turns it on", () => {
    assert.equal(measuring(""), false);
    assert.equal(measuring("?lang=en"), false);
    assert.equal(measuring("?measurement"), false);
    assert.equal(measuring("?measure"), true);
    assert.equal(measuring("?lang=en&measure"), true);
    assert.equal(measuring("?measure=1"), true);
  });
});

describe("the player's answer to a change", () => {
  function run(on: boolean): { frames: number; pings: Point[]; nextFrame: () => void } {
    const waiting: (() => void)[] = [];
    const pings: Point[] = [];
    echoChange(on, (callback) => waiting.push(callback), (point) => pings.push(point));
    return {
      frames: waiting.length,
      pings,
      nextFrame: () => {
        for (const callback of waiting.splice(0)) callback();
      },
    };
  }

  test("without the flag there is no answer", () => {
    const echo = run(false);
    echo.nextFrame();
    assert.equal(echo.frames, 0);
    assert.deepEqual(echo.pings, []);
  });

  test("with the flag a ping in cell 0,0 follows the next frame, not sooner", () => {
    const echo = run(true);
    assert.equal(echo.frames, 1);
    assert.deepEqual(echo.pings, []);
    echo.nextFrame();
    assert.deepEqual(echo.pings, [{ x: 0.5, y: 0.5 }]);
  });
});

describe("median", () => {
  test("the middle value, the mean of the two middle ones for an even count, the order does not matter", () => {
    assert.equal(median([7]), 7);
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([10, 10, 1, 1000, 10]), 10);
    assert.ok(Number.isNaN(median([])));
  });

  test("does not reorder the values it gets", () => {
    const values = [3, 1, 2];
    median(values);
    assert.deepEqual(values, [3, 1, 2]);
  });
});

describe("round trips on the master's side", () => {
  test("answers pair with the changes in order; count, median and worst", () => {
    const trips = new RoundTrips();
    trips.sent(100);
    trips.sent(200);
    assert.equal(trips.answered(110), 10);
    assert.equal(trips.answered(230), 30);
    trips.sent(300);
    assert.equal(trips.answered(320), 20);
    assert.deepEqual(trips.summary(), { count: 3, median: 20, worst: 30 });
  });

  test("an answer with no change waiting is not counted", () => {
    const trips = new RoundTrips();
    assert.equal(trips.answered(50), null);
    assert.equal(trips.summary().count, 0);
  });

  test(`a change with no answer in ${LOST_MS} ms is lost and the next answer pairs with a later change`, () => {
    const trips = new RoundTrips();
    trips.sent(0);
    trips.sent(LOST_MS + 100);
    assert.equal(trips.answered(LOST_MS + 120), 20);
    assert.deepEqual(trips.summary(), { count: 1, median: 20, worst: 20 });
  });
});
