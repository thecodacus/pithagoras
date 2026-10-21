import { test } from "node:test";
import assert from "node:assert/strict";
import { inProcessHome } from "./server-harness.mjs";

inProcessHome("pithagoras-sandbox-tool-names-");

const { SdkPiClient } = await import("../dist/pi/sdk-client.js");

/**
 * With the sandbox on, the portal's `sandbox` extension registers pi's own tools again, run as the chat's agent. pi
 * keeps the first tool of a name, and an installed package loads before the portal's extensions, so a package that
 * registers `bash` has its own run in the sandbox's place, as the portal. Such a name is off in that chat, with a
 * load error naming the package. The parts of pi's AgentSession the client reads for it, as in tools-reload.test.mjs.
 */
function fakeSession() {
  const session = {
    /** Whether the sandbox was on as the chat loaded: its extension registered tools. */
    sandboxed: true,
    /** Whose `bash` pi kept. */
    bashFrom: "<inline:sandbox>",
    active: ["read", "bash", "notes_add"],
    tools: () => [
      { name: "read", sourceInfo: { path: session.sandboxed ? "<inline:sandbox>" : "builtin:read" } },
      { name: "bash", sourceInfo: { path: session.bashFrom } },
      { name: "notes_add", sourceInfo: { path: "/data/home/.pi/agent/git/notes/index.js" } },
    ],
    getAllTools: () => session.tools(),
    getToolDefinition: (name) => (session.tools().some((tool) => tool.name === name) ? { name } : undefined),
    getActiveToolNames: () => [...session.active],
    _setActiveTools(names) {
      session.active = [...new Set(names)].filter((name) => session.tools().some((tool) => tool.name === name));
    },
    async reload() {
      // pi activates every tool again as it reloads.
      this._setActiveTools(session.tools().map((tool) => tool.name));
    },
    resourceLoader: {
      getExtensions: () => ({
        extensions: [{ path: "<inline:sandbox>", tools: new Map(session.sandboxed ? [["read", {}], ["bash", {}]] : []) }],
        // pi's own word on a tool of a name another extension registered first, filed under the later one.
        errors: session.sandboxed && session.bashFrom !== "<inline:sandbox>" ? [{ path: "<inline:sandbox>", error: `Tool "bash" conflicts with ${session.bashFrom}` }] : [],
      }),
    },
  };
  return session;
}

test("with the sandbox on, a package's tool of one of pi's own names is off in the chat, and the load error names the package", async () => {
  const session = fakeSession();
  const client = new SdkPiClient(session, {}, () => {});
  const said = [];
  client.on("event", (event) => event.type === "extension_error" && said.push(event));

  session.bashFrom = "/data/home/.pi/agent/git/shadow/index.js";
  await client.reload();
  assert.deepEqual(session.active, ["read", "notes_add"]);
  assert.equal(client.offers("bash"), undefined);
  assert.equal((await client.getTools()).find((tool) => tool.name === "bash")?.enabled, false);
  assert.ok(client.switchedOff.has("bash"), "off for the guard and the scripts as well");
  const error = 'shadow registers "bash", one of pi\'s own tools. With the sandbox on, only the sandbox may give a tool that name, so "bash" is off in this chat.';
  assert.deepEqual(client.loadErrors(), [{ path: "/data/home/.pi/agent/git/shadow/index.js", error }], "said by the portal, naming the package, not by pi as the sandbox's");
  assert.deepEqual(said.map((event) => event.error), [error]);

  // The chat's own switches do not bring it back.
  await client.setToolsOff([]);
  assert.ok(!session.active.includes("bash"));

  // Gone once the package no longer takes it, and the switches are as they were.
  session.bashFrom = "<inline:sandbox>";
  await client.reload();
  assert.deepEqual(session.active, ["read", "bash", "notes_add"]);
  assert.deepEqual(client.loadErrors(), []);
  assert.equal(client.switchedOff.size, 0);
});

test("one registered after the load is off from then on, and said once", async () => {
  const session = fakeSession();
  const client = new SdkPiClient(session, {}, () => {});
  const said = [];
  client.on("event", (event) => event.type === "extension_error" && said.push(event.error));
  await client.reload();
  assert.ok(session.active.includes("bash"));

  // A package registers `bash` as a run starts: pi keeps it over the sandbox's, which loaded later, and activates its tools again.
  session.bashFrom = "/data/home/.pi/agent/git/shadow/index.js";
  session._setActiveTools(session.tools().map((tool) => tool.name));
  assert.ok(!session.active.includes("bash"));
  assert.ok(client.switchedOff.has("bash"));
  const error = 'shadow registers "bash", one of pi\'s own tools. With the sandbox on, only the sandbox may give a tool that name, so "bash" is off in this chat.';
  assert.deepEqual(said, [error]);
  assert.deepEqual(client.loadErrors(), [{ path: "/data/home/.pi/agent/git/shadow/index.js", error }]);
  session._setActiveTools(session.tools().map((tool) => tool.name));
  assert.equal(said.length, 1, "said once");

  // Nor said again by the load after it, where it is still there.
  await client.reload();
  assert.equal(said.length, 1);
  assert.ok(!session.active.includes("bash"));
});

test("with the sandbox off, a package's own `bash` is the chat's as before", async () => {
  const session = fakeSession();
  session.sandboxed = false;
  session.bashFrom = "/data/home/.pi/agent/git/shadow/index.js";
  const client = new SdkPiClient(session, {}, () => {});
  await client.reload();
  assert.ok(session.active.includes("bash"));
  assert.deepEqual(client.loadErrors(), []);
  // Nor after the load.
  session._setActiveTools(session.tools().map((tool) => tool.name));
  assert.ok(session.active.includes("bash"));
});
