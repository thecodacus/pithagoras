import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { config, saveConfig } from "../src/server/service.ts";
import { openStore } from "../src/server/store.ts";
import { scratch } from "../../../tests/helpers.mts";

/** Browser's settings: in its own settings.json, for its owner alone, each read with the environment behind it. */
const data = realpathSync(scratch("browser-store-"));
openStore(data);

test("the browser's address settings are read one by one, with the environment behind them", () => {
  delete process.env.BROWSER_USER;
  delete process.env.BROWSER_PORT;
  assert.deepEqual([config().user, config().port], ["agent", "3010"]);
  process.env.BROWSER_PORT = "4010";
  assert.equal(config().port, "4010");
  assert.equal(saveConfig({ port: "4020", user: "alice" }).user, "alice");
  // Not saved, and not the way to forget what was.
  assert.equal(saveConfig({ user: "" }).user, "alice");
  delete process.env.BROWSER_PORT;
  assert.equal(config().port, "4020");
});

test("they are kept in Browser's own folder, for its owner alone, and read again as it starts", () => {
  const file = path.join(data, "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { port: "4020", user: "alice" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  openStore(data);
  assert.equal(config().user, "alice");
});
