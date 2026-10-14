import { test } from "node:test";
import assert from "node:assert/strict";

// Fixed, so that "midnight" and the day a clock changes mean the same everywhere.
process.env.TZ = "UTC";

const { parseCron, nextRun, isDue } = await import("../dist/routines/cron.js");

/** What nextRun was before it skipped ahead: every minute tried in turn, as a reference to hold it to. */
function scanned(cron, from) {
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const limit = new Date(at.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (at <= limit) {
    if (isDue(cron, at, null)) return new Date(at.getTime());
    at.setMinutes(at.getMinutes() + 1);
  }
  return null;
}

const EXPRESSIONS = [
  "* * * * *",
  "*/7 * * * *",
  "0 9 * * 1-5",
  "30 2 29 2 *",
  "0 0 1 1 *",
  "15 14 1 * 1",
  "0 0 31 * *",
  "5 4 * * sun",
  "0 */6 * jun *",
  "59 23 31 12 *",
  "0 0 13 * 5",
  "30 2 30 2 *",
  "0 12 * * 0,6",
  "@weekly",
  "@monthly",
];

const STARTS = [
  new Date(2026, 0, 1, 0, 0, 0),
  new Date(2026, 0, 31, 23, 59, 30),
  new Date(2026, 1, 28, 23, 59, 59),
  new Date(2027, 11, 31, 23, 59, 0),
  new Date(2028, 1, 29, 12, 0, 0),
  new Date(2026, 5, 15, 13, 7, 41),
  new Date(2026, 9, 3, 9, 0, 0),
];

test("skipping ahead finds the same moment as trying every minute", () => {
  for (const expression of EXPRESSIONS) {
    const cron = parseCron(expression);
    for (const from of STARTS) {
      assert.equal(
        nextRun(cron, from)?.toISOString() ?? null,
        scanned(cron, from)?.toISOString() ?? null,
        `${expression} after ${from.toISOString()}`,
      );
    }
  }
});

test("a clock that changes still gives the moment the minute scan gave", () => {
  process.env.TZ = "America/New_York";
  try {
    // Clocks go forward on 2026-03-08 (02:30 does not exist) and back on 2026-11-01 (01:30 comes twice).
    const cases = [
      ["30 2 * * *", new Date(Date.UTC(2026, 2, 7, 12, 0))],
      ["0 * * * *", new Date(Date.UTC(2026, 2, 8, 5, 30))],
      ["30 1 * * *", new Date(Date.UTC(2026, 9, 31, 12, 0))],
      ["30 1 * * *", new Date(Date.UTC(2026, 10, 1, 5, 45))],
      ["0 9 * * *", new Date(Date.UTC(2026, 10, 1, 5, 0))],
    ];
    for (const [expression, from] of cases) {
      const cron = parseCron(expression);
      assert.equal(nextRun(cron, from)?.toISOString(), scanned(cron, from)?.toISOString(), `${expression} after ${from.toISOString()}`);
    }
  } finally {
    process.env.TZ = "UTC";
  }
});

test("a rare schedule is found without trying half a million minutes", () => {
  const started = Date.now();
  for (let i = 0; i < 40; i++) {
    assert.ok(nextRun(parseCron("@yearly"), new Date(2026, 5, 1)));
    assert.equal(nextRun(parseCron("30 2 30 2 *"), new Date(2026, 5, 1)), null);
  }
  // Each of those took about a tenth of a second when every minute was tried.
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});
