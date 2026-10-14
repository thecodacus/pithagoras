import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * The pictures sent with a chat's messages, against the whole server: they are
 * served while the chat exists, and not after it is gone, whatever a failed
 * clean-up left on the disk.
 */
// The data folder is below a dot folder, as it is for `~/.pithagoras` or
// `~/.local/share/...`: Express takes a file under one for hidden and answers 404.
const home = path.join(inProcessHome("pithagoras-image-route-"), ".pithagoras");
mkdirSync(path.join(home, "agent"), { recursive: true });
mkdirSync(path.join(home, "agent-home"), { recursive: true });
process.env.DATA_DIR = home;
const { createSession, getDb } = await import("../dist/db.js");

const NAME = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

test("a picture of a chat that has been deleted is not served, even when its file is still there", async () => {
  createSession({ id: "pictured", title: "pictured", workspace: home, executor: "host" });
  mkdirSync(path.join(home, "images", "pictured"), { recursive: true });
  writeFileSync(path.join(home, "images", "pictured", NAME), PNG);

  const served = await fetch(`${base}/api/sessions/pictured/images/${NAME}`);
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  // The chat's rows go; its folder, as when removing pi's own failed first, stays.
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run("pictured");
  const gone = await fetch(`${base}/api/sessions/pictured/images/${NAME}`);
  assert.equal(gone.status, 404);
});
