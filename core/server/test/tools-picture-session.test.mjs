import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { inProcessHome } from "./server-harness.mjs";

/**
 * What a chat's own tool list says of the picture tools, for the page to group
 * the portal's in one box: a chat that has started lists what its pi
 * registered, one that has not lists what was remembered. Either way the
 * portal's own are marked `inline` and an extension's of the same name is not.
 */
const home = inProcessHome("pithagoras-tools-picture-session-");

const db = await import("../dist/db.js");
const { sessions } = await import("../dist/session-manager.js");

const marked = async (id) => Object.fromEntries((await sessions.getTools(id)).tools.map((t) => [t.name, t.inline === true]));

test("a chat that has not started marks the portal's picture tools, not an extension's of the same name", async () => {
  db.rememberTools([
    { name: "show_image", source: "pictures", package: null, inline: true },
    { name: "edit_image", source: "image-editing", package: null, inline: true },
    // A loose extension file called image-generation.ts, reported as not the portal's.
    { name: "generate_image", source: "image-generation", package: null, inline: false },
    { name: "web_search", source: "pi-web-access", package: null, inline: false },
  ]);
  db.createSession({ id: "idle", title: "idle", workspace: home, executor: "host" });
  const tools = await marked("idle");
  assert.equal(tools.show_image, true);
  assert.equal(tools.generate_image, false);
  assert.equal(tools.web_search, false);
});

test("a chat that is running marks what its pi says is the portal's own", async () => {
  db.createSession({ id: "live", title: "live", workspace: home, executor: "host" });
  sessions.live.set("live", {
    client: {
      getTools: async () => [
        { name: "show_image", source: "pictures", inline: true, enabled: true },
        { name: "generate_image", source: "my-images", enabled: true },
        { name: "web_search", source: "pi-web-access", enabled: true },
      ],
    },
  });
  try {
    assert.deepEqual(await marked("live"), { show_image: true, generate_image: false, web_search: false });
  } finally {
    sessions.live.delete("live");
  }
});
