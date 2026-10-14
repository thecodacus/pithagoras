import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The only way to make a folder for chats to work in is a project, which has
 * rules the old workspace route never kept: it made "home", the name Home is
 * read by, and a routine set to it then ran in Home.
 */
const home = testHome("pithagoras-workspaces-");
let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const post = (url, body) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("there is no route that makes a folder under the workspace root outside the project rules", async () => {
  const res = await post("/api/workspaces", { name: "Home" });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /No such API route/);
  assert.equal(existsSync(path.join(home, "ws", "home")), false);
  // Listing them is still there, and a project is how one is made.
  assert.equal((await fetch(base + "/api/workspaces")).status, 200);
  assert.equal((await post("/api/projects", { name: "Home" })).status, 400);
  assert.equal((await post("/api/projects", { name: "Notes" })).status, 200);
});
