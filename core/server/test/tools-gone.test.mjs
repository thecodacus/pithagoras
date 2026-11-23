import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fakeModel } from "./fake-model.mjs";
import { freePort, inProcessHome, serverEnv, startServer } from "./server-harness.mjs";

/**
 * The tools the portal remembers are what the chats register (#383): a tool its extension stopped registering leaves
 * Settings → Tools once a chat that loads the extension has started, as pi-web-access's `web_enable` does when its tools
 * are made eager. One registered and left inactive stays, one of an extension the chat did not load stays, and one that
 * comes back is not new: what was switched for it stands. Real pi and the portal's own client.
 */
const home = inProcessHome("pithagoras-tools-gone-");
const agent = process.env.PI_CODING_AGENT_DIR;
mkdirSync(path.join(agent, "extensions"), { recursive: true });
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
const modeFile = path.join(agent, "web-mode.txt");
const mode = (value) => writeFileSync(modeFile, value);
mode("lazy");

// Like pi-web-access: its tools are registered either way; lazily, they are inactive until a loader switches them on, and
// the loader is registered only then.
writeFileSync(path.join(agent, "extensions", "web.ts"), `
import { readFileSync } from "node:fs";
const tool = (name, more) => ({
  name, label: name, description: "Does " + name + ".", parameters: { type: "object", properties: {} },
  async execute() { return { content: [{ type: "text", text: name + " ran" }], details: {} }; },
  ...more,
});
export default function (pi) {
  pi.registerTool(tool("web_find"));
  if (readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() === "eager") return;
  pi.registerTool(tool("web_load"));
  pi.registerTool(tool("web_risky", { offByDefault: true }));
  pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "web_find")));
}
`);

const model = await fakeModel(() => "Done.");
writeFileSync(path.join(agent, "models.json"), JSON.stringify(model.models()));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));

const db = await import("../dist/db.js");

let base;
before(async () => {
  ({ base } = await startServer(serverEnv(home, await freePort())));
});

const json = async (url, method = "GET", body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${url}: ${res.status} ${await res.clone().text()}`);
  return res.json();
};
const listed = async () => (await json("/api/tools")).tools.map((t) => t.name);
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(what);
};
/** A chat that has started: pi is up once it has answered. */
async function started() {
  const chat = await json("/api/sessions", "POST", {});
  const first = model.requests.length;
  await json(`/api/sessions/${chat.id}/prompt`, "POST", { message: "Go on" });
  await until(() => model.requests.length > first && db.getSession(chat.id).status !== "running", "the chat answers");
  return chat;
}

test("a tool its extension no longer registers leaves Settings → Tools, and one that comes back keeps what was switched for it", async () => {
  await started();
  await until(async () => (await listed()).includes("web_load"), "the loader is listed");
  assert.ok(db.toolDefaultsOff().includes("web_risky"), "off by default, once");
  // Somebody switched it on everywhere; and a tool of an extension no chat here loads.
  db.setToolDefaultsOff(db.toolDefaultsOff().filter((name) => name !== "web_risky"));
  db.rememberTools([db.remembered({ name: "far_tool", source: "elsewhere" })]);

  mode("eager");
  await started();
  await until(async () => !(await listed()).includes("web_load"), "the loader is gone once a chat registered none");
  const eager = await listed();
  assert.ok(eager.includes("web_find"));
  assert.ok(!eager.includes("web_risky"));
  assert.ok(eager.includes("far_tool"), "a tool of an extension the chat did not load is another chat's to say");

  mode("lazy");
  await started();
  await until(async () => (await listed()).includes("web_risky"), "back with the extension that registers it");
  assert.ok(!db.toolDefaultsOff().includes("web_risky"), "not new: on, as somebody switched it");
  assert.ok((await listed()).includes("web_find"), "registered and inactive is still there");
});

test("forgetGoneTools: only the tools of what the chat loaded, not the portal's inline ones, and their names are kept aside", () => {
  db.rememberTools([
    db.remembered({ name: "pkg_a", source: "pkg" }),
    db.remembered({ name: "pkg_b", source: "pkg" }),
    db.remembered({ name: "half_tool", source: "half", inline: true }),
    db.remembered({ name: "other_a", source: "other" }),
  ]);
  assert.deepEqual(db.forgetGoneTools({ names: ["pkg_a"], sources: ["pkg", "half"] }), ["pkg_b"]);
  const known = db.knownTools().map((t) => t.name);
  assert.ok(known.includes("pkg_a") && known.includes("half_tool") && known.includes("other_a"));
  assert.ok(!known.includes("pkg_b"));
  assert.deepEqual(db.forgetGoneTools({ names: ["pkg_a"], sources: ["pkg"] }), [], "nothing more to forget");

  // A package narrowed to some of its extensions: what the others register is left out of the chat, and stays listed.
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m", packages: [{ source: "npm:narrow", extensions: ["one.ts"] }] }));
  try {
    db.rememberTools([db.remembered({ name: "narrow_one", source: "narrow", package: "npm:narrow" }), db.remembered({ name: "narrow_two", source: "narrow", package: "npm:narrow" })]);
    assert.deepEqual(db.forgetGoneTools({ names: ["narrow_one"], sources: ["narrow"] }), []);
  } finally {
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "m" }));
  }
});
