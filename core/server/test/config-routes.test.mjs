import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { freePort, serverEnv, startServer, testHome } from "./server-harness.mjs";

/**
 * The routes that write what pi reads at every start: mcp.json, settings.json,
 * the packages and the channels. Each has a guard that keeps a bad write from
 * reaching the file or the command, and a guard that is only ever read is one a
 * change can take out with every test green.
 *
 * The server runs as it is deployed, with a `pi` and an `npm` of its own in
 * front on the PATH: they only write down what they were asked to run, so that
 * a spec the route should have turned away is seen not to have got any further.
 */
const home = testHome("config-routes-");
const agent = path.join(home, "agent");
const mcpFile = path.join(agent, "mcp.json");
const settingsFile = path.join(agent, "settings.json");
const bin = path.join(home, "bin");
const ran = path.join(home, "ran");
mkdirSync(bin);
for (const command of ["pi", "npm"]) {
  const file = path.join(bin, command);
  // One line for each run, the arguments told apart by a character no spec has. `npm:fails` is a package that cannot be installed.
  writeFileSync(file, `#!/bin/bash\n( IFS=$'\\x1f'; echo "${command}$IFS$*" ) >> "${ran}"\nfor a in "$@"; do [ "$a" = npm:fails ] && { echo "no such package" >&2; exit 1; }; done\necho "$*"\nexit 0\n`);
  chmodSync(file, 0o755);
}
const runs = () => (existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\x1f")) : []);

let base;
before(async () => {
  const port = await freePort();
  ({ base } = await startServer(serverEnv(home, port, { PATH: `${bin}${path.delimiter}${process.env.PATH}` })));
});
beforeEach(() => {
  rmSync(ran, { force: true });
  rmSync(mcpFile, { force: true });
  rmSync(settingsFile, { force: true });
});

const send = async (url, method = "GET", body) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const read = (file) => readFileSync(file, "utf8");
const MCP = JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } }, null, 2) + "\n";
/** What a hand edit leaves: a comma too many. */
const BROKEN = '{\n  "mcpServers": {\n    "notes": { "command": "notes-mcp" },\n  }\n}\n';
const refused = (res, status, pattern) => {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.match(res.body.error, pattern);
};

// --- mcp.json ---

test("the raw editor refuses what is not JSON, and the file is as it was", async () => {
  writeFileSync(mcpFile, MCP);
  for (const content of ["{", '{ "mcpServers": ', "not json", ""]) {
    refused(await send("/api/mcp/raw", "PUT", { content }), 400, /Not valid JSON/);
  }
  refused(await send("/api/mcp/raw", "PUT", { content: 42 }), 400, /content required/);
  refused(await send("/api/mcp/raw", "PUT", {}), 400, /content required/);
  assert.equal(read(mcpFile), MCP);
});

test("the raw editor takes what the adapter reads, comments too, and puts it in place as typed for its owner alone", async () => {
  const content = '{\n  // the one server\n  "mcpServers": { "notes": { "command": "notes-mcp" } /* kept */ }\n}';
  assert.equal((await send("/api/mcp/raw", "PUT", { content })).status, 200);
  assert.equal(read(mcpFile), content + "\n", "the comments stay, and the file ends in a newline");
  assert.equal(statSync(mcpFile).mode & 0o777, 0o600);
  const shown = (await send("/api/mcp")).body;
  assert.equal(shown.parseError, null);
  assert.deepEqual(shown.servers.map((s) => s.name), ["notes"]);
});

test("a server is refused a name the adapter would not take, and the file is as it was", async () => {
  writeFileSync(mcpFile, MCP);
  // Express hands the route the name decoded, so a slash and a space reach it as they were typed.
  for (const name of ["-dash", ".dot", "_under", "a%20b", "a%2Fb", "a%3Bb"]) {
    refused(await send(`/api/mcp/servers/${name}`, "PUT", { entry: { command: "x" } }), 400, /Name must be/);
  }
  assert.equal(read(mcpFile), MCP);
  assert.equal((await send("/api/mcp/servers/Fine-name_1.2", "PUT", { entry: { command: "x" } })).status, 200);
});

test("an entry that is not one server is refused, and the file is as it was", async () => {
  writeFileSync(mcpFile, MCP);
  const entries = [undefined, null, "notes-mcp", [], {}, { command: "  " }, { command: "a", url: "https://mcp.example.test" }, { url: "https://x.test", socket: "/s" }, { command: "a", args: "--fast" }];
  for (const entry of entries) {
    const res = await send("/api/mcp/servers/fresh", "PUT", { entry });
    assert.equal(res.status, 400, JSON.stringify(entry));
  }
  assert.equal(read(mcpFile), MCP);
});

test("a file that does not parse is not written over by any of the forms, and is shown as it is", async () => {
  writeFileSync(mcpFile, BROKEN);
  for (const [url, method, body] of [
    ["/api/mcp/servers/fresh", "PUT", { entry: { command: "x" } }],
    ["/api/mcp/servers/notes", "DELETE"],
    ["/api/mcp/settings", "PUT", { settings: { toolPrefix: "short" } }],
    ["/api/mcp/import", "POST", { text: '{ "other": { "command": "x" } }' }],
  ]) {
    refused(await send(url, method, body), 409, /Fix the file first/);
    assert.equal(read(mcpFile), BROKEN, `${method} ${url}`);
  }
  const shown = (await send("/api/mcp")).body;
  assert.equal(shown.raw, BROKEN, "what the raw editor has to start from");
  assert.ok(shown.parseError);
  // The raw editor is the way out, and it works over the broken file.
  assert.equal((await send("/api/mcp/raw", "PUT", { content: MCP })).status, 200);
  assert.equal((await send("/api/mcp/servers/fresh", "PUT", { entry: { command: "x" } })).status, 200);
});

test("the adapter's settings are an object, and an empty one takes them out", async () => {
  writeFileSync(mcpFile, MCP);
  for (const settings of [undefined, null, [], "short"]) {
    refused(await send("/api/mcp/settings", "PUT", { settings }), 400, /settings must be an object/);
  }
  assert.equal(read(mcpFile), MCP);
  await send("/api/mcp/settings", "PUT", { settings: { toolPrefix: "short" } });
  assert.deepEqual(JSON.parse(read(mcpFile)).settings, { toolPrefix: "short" });
  await send("/api/mcp/settings", "PUT", { settings: {} });
  assert.equal("settings" in JSON.parse(read(mcpFile)), false);
});

test("a pasted config adds what is usable, says what it left out, and writes nothing when there is none", async () => {
  writeFileSync(mcpFile, MCP);
  for (const text of [undefined, "", "   ", "{", "[1", "42"]) {
    assert.equal((await send("/api/mcp/import", "POST", { text })).status, 400, String(text));
  }
  refused(await send("/api/mcp/import", "POST", { text: "{}" }), 400, /No servers found/);
  assert.equal(read(mcpFile), MCP);

  const only = await send("/api/mcp/import", "POST", { text: '{ "bad name": { "command": "x" }, "empty": {} }' });
  assert.equal(only.status, 200);
  assert.deepEqual(only.body.added, []);
  assert.deepEqual(only.body.skipped.map((s) => s.name).sort(), ["bad name", "empty"]);
  assert.equal(read(mcpFile), MCP, "nothing was usable, so nothing is written");

  // The blob a server's README hands out, with its comments, and the keys that are not servers.
  const text = '{\n  // from the README\n  "mcpServers": { "github": { "url": "https://mcp.example.test" }, "bad name": { "command": "x" }, "settings": { "command": "x" } }\n}';
  const mixed = await send("/api/mcp/import", "POST", { text });
  assert.deepEqual(mixed.body.added, ["github"]);
  assert.deepEqual(mixed.body.skipped.map((s) => s.name), ["bad name"]);
  assert.deepEqual(Object.keys(JSON.parse(read(mcpFile)).mcpServers).sort(), ["github", "notes"]);
});

// --- settings.json ---

test("an extension setting is written only under a key that is a name, and the file is as it was", async () => {
  const text = JSON.stringify({ packages: ["npm:pi-example"] }, null, 2) + "\n";
  writeFileSync(settingsFile, text);
  for (const key of ["", "1a", "a-b", "a b", "a.b", "packages\n", 5, null, undefined]) {
    refused(await send("/api/extensions/settings", "PUT", { key, value: "v" }), 400, /Invalid settings key/);
  }
  assert.equal(read(settingsFile), text);
});

test("a package is switched only with a spec and a boolean, and one that is not installed is not found", async () => {
  const text = JSON.stringify({ packages: ["npm:pi-example"] }, null, 2) + "\n";
  writeFileSync(settingsFile, text);
  for (const body of [{}, { spec: "npm:pi-example" }, { spec: "", enabled: true }, { spec: "npm:pi-example", enabled: "false" }, { spec: 5, enabled: true }]) {
    refused(await send("/api/extensions/enabled", "PUT", body), 400, /spec and enabled are required/);
  }
  refused(await send("/api/extensions/enabled", "PUT", { spec: "npm:pi-other", enabled: false }), 404, /not installed/);
  assert.equal(read(settingsFile), text);
});

test("the raw editor of settings.json refuses what pi cannot parse, comments too, and what is not an object", async () => {
  const text = '{\n  "defaultProvider": "local"\n}\n';
  writeFileSync(settingsFile, text);
  // Unlike mcp.json, pi reads this one with a plain JSON.parse.
  for (const content of ['{\n  // a note\n  "defaultProvider": "other"\n}', "{", "[1]", "null"]) {
    assert.equal((await send("/api/pi-settings", "PUT", { content })).status, 400, content);
  }
  refused(await send("/api/pi-settings", "PUT", {}), 400, /content required/);
  assert.equal(read(settingsFile), text);
});

// --- packages ---

const BAD_SPECS = ["--registry=https://registry.example.test", "-g", "npm:pkg --registry=x", "npm:a;rm", "npm:a\nb", "$(id)", "ftp://host/pkg", "pkg", "npm:", "./--registry=x", "", 42, null, undefined];

test("a package spec that is not one pi documents is refused before pi is run", async () => {
  for (const spec of BAD_SPECS) {
    assert.equal((await send("/api/packages", "POST", { spec })).status, 400, `install ${String(spec)}`);
    assert.equal((await send("/api/packages", "DELETE", { spec })).status, 400, `remove ${String(spec)}`);
  }
  assert.deepEqual(runs(), [], "pi was not run");
});

test("a spec of a documented shape reaches pi as one argument of its own", async () => {
  const specs = ["npm:pkg@1.0.0", "npm:@scope/pkg@2.1.0", "git:github.com/user/repo", "https://example.test/pkg.tgz", "./local/pkg", "/abs/pkg"];
  for (const spec of specs) assert.equal((await send("/api/packages", "POST", { spec })).status, 200, spec);
  assert.equal((await send("/api/packages", "DELETE", { spec: "npm:pkg@1.0.0" })).status, 200);
  assert.deepEqual(runs(), [...specs.map((s) => ["pi", "install", s]), ["pi", "remove", "npm:pkg@1.0.0"]]);
});

test("a package pi cannot install is an error with pi's words, and the next one still goes", async () => {
  refused(await send("/api/packages", "POST", { spec: "npm:fails" }), 500, /no such package/);
  assert.equal((await send("/api/packages", "POST", { spec: "npm:works" })).status, 200);
});

test("Update all updates the installed packages and leaves pi to the portal's own version", async () => {
  assert.equal((await send("/api/packages/update", "POST")).status, 200);
  // `--all` would have pi update itself too, which it refuses where it is the locked copy of the image.
  assert.deepEqual(runs(), [["pi", "update", "--extensions"]]);
});

// --- channels ---

const channelPort = async () => String(await freePort());
const channels = async () => (await send("/api/channels")).body.channels;

test("a channel is made only of a kind there is, what it requires and an agent there is", async () => {
  refused(await send("/api/channels", "POST", {}), 400, /Unknown channel type/);
  refused(await send("/api/channels", "POST", { kind: "nope", config: {} }), 400, /Unknown channel type/);
  refused(await send("/api/channels", "POST", { kind: "telegram", config: {} }), 400, /Missing: Bot token/);
  refused(await send("/api/channels", "POST", { kind: "webhook", config: { port: await channelPort() } }), 400, /Missing: Shared secret/);
  refused(await send("/api/channels", "POST", { kind: "webhook", config: { secret: "s", port: await channelPort() }, agentId: "nobody" }), 400, /No such agent/);
  assert.deepEqual(await channels(), [], "none of them was made");
});

test("a channel keeps its secret to itself, takes a free slug, and is changed only in ways that stay valid", async () => {
  const make = async (name, extra = {}) => (await send("/api/channels", "POST", { kind: "webhook", name, config: { secret: "hunter2", port: await channelPort() }, ...extra })).body;
  const one = await make("Hooks");
  assert.equal(one.slug, "hooks");
  assert.deepEqual(one.secretsSet, ["secret"]);
  assert.equal(JSON.stringify(one).includes("hunter2"), false, "the token does not leave the portal");
  const two = await make("Hooks");
  assert.equal(two.slug, "hooks-2", "a second channel is not merged into the first one's conversations");
  // The Agent page's chats carry the slug "browser", and are the owner's: no channel's conversations may be taken for them.
  const browser = await make("Browser");
  assert.equal(browser.slug, "browser-2");

  const patch = (id, body) => send(`/api/channels/${id}`, "PATCH", body);
  refused(await patch("nope", { name: "x" }), 404, /Not found/);
  refused(await patch(two.id, { slug: "hooks" }), 409, /already uses/);
  refused(await patch(two.id, { slug: "!!!" }), 400, /not a usable slug/);
  refused(await patch(two.id, { slug: "Browser" }), 409, /portal's own chats/);
  refused(await patch(two.id, { agentId: "nobody" }), 400, /No such agent/);
  refused(await patch(two.id, { config: { secret: null } }), 400, /Missing: Shared secret/);
  assert.deepEqual((await channels()).find((c) => c.id === two.id).secretsSet, ["secret"]);
  // A box left empty is not the secret cleared: the page never has it to send back.
  assert.equal((await patch(two.id, { config: { secret: "", senderName: "Pat" } })).status, 200);
  const kept = (await channels()).find((c) => c.id === two.id);
  assert.deepEqual(kept.secretsSet, ["secret"]);
  assert.equal(kept.config.senderName, "Pat");
  assert.equal((await patch(two.id, { slug: "Other Hooks", enabled: false })).body.slug, "other-hooks");

  assert.deepEqual((await send(`/api/channels/${one.id}`, "DELETE")).body.deleted, 0);
  assert.deepEqual((await send(`/api/channels/${two.id}`, "DELETE")).body.deleted, 0);
  assert.deepEqual((await send(`/api/channels/${browser.id}`, "DELETE")).body.deleted, 0);
  assert.deepEqual(await channels(), []);
});

test("a channel package is named, is not one that ships with the portal, and is not installed without a spec", async () => {
  for (const name of ["%2E%2E%2Fescape", "a%20b", "-g", "x%2Fy%2Fz"]) {
    refused(await send(`/api/channel-packages/${name}`, "DELETE"), 400, /Invalid package name/);
  }
  refused(await send("/api/channel-packages/pithagoras-channel-webhook", "DELETE"), 400, /ship with the portal/);
  for (const spec of [undefined, "", "   ", 5]) {
    refused(await send("/api/channel-packages", "POST", { spec }), 400, /spec required/);
  }
  assert.deepEqual(runs(), [], "npm was not run");
});
