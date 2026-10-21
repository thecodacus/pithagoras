import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { IMAGE, VOLUME, envOf, serveUnderstory } from "./portal.mts";

/**
 * The routes of Understory's page in Settings, at /api/x/pithagoras-understory, as the portal serves them: whether it
 * is the agent's memory and where, the Understory the portal runs, its model and its tidying up, and the agent's MCP
 * entry and the guard's trust of it, which it writes through `portal.mcp`.
 */

inProcessHome("pithagoras-understory-routes-");
const { at, api, docker, machine, scripts, db, adapterOn, servers, putServers, agentDir, host, halves } = await serveUnderstory();
const service = await import("../src/server/service.ts");
const store = await import("../src/server/store.ts");
const { understoryEntry } = await import("../src/server/entry.ts");

const json = { "content-type": "application/json" };
const call = async (method: string, route: string, body?: unknown) => {
  const r = await fetch(`${at}${route}`, { method, ...(body === undefined ? {} : { headers: json, body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json() };
};
const state = async () => (await call("GET", "/state")).body;
const trusted = () => [...db.trustedMcpServers()];
const MANAGED = `http://127.0.0.1:${process.env.UNDERSTORY_PORT}/mcp`;

// The adapter its tools come through is there: switching Understory on installs nothing.
adapterOn();
putServers({});

test("without Docker the page is told so, and what it is told otherwise of the memory", async () => {
  const socket = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = path.join(os.tmpdir(), "no-docker-here.sock");
  try {
    const now = await state();
    assert.deepEqual([now.enabled, now.url, now.tokenSet], [false, "http://localhost:3800/mcp", false]);
    assert.deepEqual([now.managed.available, now.managed.image, now.managed.container], [false, false, "absent"]);
    assert.deepEqual([now.managed.url, now.managed.autoPossible, now.managed.config], [MANAGED, true, { llm: { source: "auto" }, dreamInterval: "", dreamAt: "" }]);
    assert.equal(now.managed.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone.replace("Etc/Unknown", "UTC"));
    assert.equal("adapterInstalled" in now || "configError" in now, false);
  } finally {
    process.env.DOCKER_SOCKET = socket;
  }
});

test("switched on, Understory elsewhere is the agent's memory, trusted by the guard, with what was in its entry kept; off, it is gone, and so is the trust", async () => {
  putServers({ understory: { url: "http://old:3800/mcp", timeout: 5000, disabled: true, bearerToken: "stale" } });
  process.env.MEMORY_UNDERSTORY_AUTH_TOKEN = "from-env";
  try {
    const on = await call("PUT", "/use", { enabled: true, url: "http://understory.test:3800/mcp" });
    assert.equal(on.status, 200);
    assert.deepEqual([on.body.reloaded, on.body.waiting], [0, 0], "what the reload of the idle chats did");
    assert.deepEqual(servers().understory, { url: "http://understory.test:3800/mcp", timeout: 5000, lifecycle: "lazy", directTools: true, auth: "bearer", bearerTokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" });
    assert.deepEqual([on.body.understory.enabled, on.body.understory.url, on.body.understory.tokenSet], [true, "http://understory.test:3800/mcp", true]);
    assert.deepEqual(trusted(), ["understory"]);
    assert.deepEqual((await (await fetch(`${api}/features/flags`)).json()).memory, { held: true, by: "Understory" });

    const off = await call("PUT", "/use", { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(servers().understory, undefined);
    assert.deepEqual(trusted(), []);
    assert.equal(off.body.understory.enabled, false);
    assert.deepEqual((await (await fetch(`${api}/features/flags`)).json()).memory, { held: false, by: null });
  } finally {
    delete process.env.MEMORY_UNDERSTORY_AUTH_TOKEN;
  }
  assert.deepEqual((await call("PUT", "/use", { enabled: "yes" })).body, { error: "enabled must be true or false" });
  assert.deepEqual((await call("PUT", "/use", { enabled: true, url: "ftp://x" })).body, { error: "The address must be an http or https URL" });
  // An mcp.json that cannot be read is the person's to fix: said, and nothing written over it.
  writeFileSync(path.join(agentDir, "mcp.json"), "{ nope");
  const broken = await call("PUT", "/use", { enabled: true });
  assert.equal(broken.status, 409);
  assert.match(broken.body.error, /^Fix mcp.json first/);
  putServers({});
});

test("installed, it runs here with the image downloaded, on the portal's loopback, and is the agent's memory with its own token", async () => {
  machine.reset();
  docker.images.clear();
  const installed = await call("POST", "/install");
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.deepEqual(docker.pulls, [IMAGE]);
  const made = machine.understory()!;
  assert.equal(made.State, "running");
  const env = envOf(made);
  assert.deepEqual([env.BUNDLE_ROOT, env.PORT, env.AUTH_TOKEN, env.LLM_API_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL], ["/bundle", process.env.UNDERSTORY_PORT, store.setting("token"), `http://127.0.0.1:${process.env.UNDERSTORY_LLM_PORT}/v1`, store.setting("llmToken"), "auto"]);
  assert.deepEqual(made.Labels, { "pithagoras.addon": "understory", "pithagoras.extension": "pithagoras-understory" });
  assert.deepEqual((made.made as any).HostConfig, { NetworkMode: "container:portal-one", RestartPolicy: { Name: "unless-stopped" }, Binds: [`${VOLUME}:/bundle`] });
  assert.deepEqual(docker.volumes, [{ Name: VOLUME, Labels: { "pithagoras.extension": "pithagoras-understory" } }]);
  assert.deepEqual(servers().understory, { url: MANAGED, lifecycle: "lazy", directTools: true, auth: "bearer", bearerToken: store.setting("token") });
  assert.deepEqual(trusted(), ["understory"]);
  const shown = installed.body.understory;
  assert.deepEqual([shown.enabled, shown.url, shown.managed.container, shown.managed.image, shown.managed.pulling.active], [true, MANAGED, "running", true, false]);

  // Stopped and started from the page.
  assert.equal((await call("POST", "/stop")).body.understory.managed.container, "stopped");
  assert.equal((await call("POST", "/start")).body.understory.managed.container, "running");
});

test("its model: a provider's with its key, a command's key refused, an address of its own whose key is kept and never shown; a running one is made again with it", async () => {
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "llama-swap": { baseUrl: "http://gpu:8080/v1", api: "openai-completions", apiKey: "sk-gpu", models: [{ id: "model-a" }] },
        claude: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "!pass show claude", models: [{ id: "sonnet" }] },
      },
    }),
  );
  const providers = (await state()).managed.providers;
  assert.deepEqual(providers, [{ id: "llama-swap", models: ["model-a"] }, { id: "claude", models: ["sonnet"] }]);
  const first = machine.understory()!.Id;
  const provider = await call("PUT", "/config", { llm: { source: "provider", provider: "llama-swap", model: "model-a" }, dreamInterval: "6h" });
  assert.equal(provider.status, 200, JSON.stringify(provider.body));
  const env = envOf(machine.understory()!);
  assert.deepEqual([env.LLM_API_BASE_URL, env.LLM_API_KEY, env.LLM_API_FORMAT, env.LLM_MODEL, env.DREAM_INTERVAL], ["http://gpu:8080/v1", "sk-gpu", "openai", "model-a", "6h"]);
  assert.notEqual(machine.understory()!.Id, first);
  assert.equal(machine.understory()!.State, "running", "running as it was");

  const command = await call("PUT", "/config", { llm: { source: "provider", provider: "claude", model: "sonnet" } });
  assert.deepEqual(command, { status: 400, body: { error: "That provider's key is a command pi runs; give Understory an address and key of its own instead" } });
  assert.deepEqual((await call("PUT", "/config", { llm: { source: "provider", provider: "gone", model: "x" } })).status, 400);

  const custom = await call("PUT", "/config", { llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", format: "openai", apiKey: "sk-1" }, dreamAt: "03:00", dreamInterval: "1d" });
  assert.deepEqual(custom.body.understory.managed.config, { llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", format: "openai", hasKey: true }, dreamInterval: "", dreamAt: "03:00" });
  assert.doesNotMatch(JSON.stringify(custom.body), /sk-1/);
  assert.equal(envOf(machine.understory()!).DREAM_INTERVAL, undefined, "a set time wins over Understory's own timer");
  assert.ok(custom.body.understory.managed.nextDream);
  // Sent without its key, for the same address: the one saved stays.
  await call("PUT", "/config", { llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai" } });
  assert.equal(envOf(machine.understory()!).LLM_API_KEY, "sk-1");

  for (const [body, error] of [
    [{ llm: { source: "sometimes" } }, "Choose the chat's model, a provider and model, or an http(s) address, a model and a format"],
    [{ llm: { source: "auto" }, dreamInterval: "2m" }, "Tidying up takes an interval like 30m, 6h or 1d, of at least 5 minutes"],
    [{ llm: { source: "auto" }, dreamAt: "3am" }, "Tidying up at a time takes one like 03:00"],
  ] as const) {
    assert.deepEqual(await call("PUT", "/config", body), { status: 400, body: { error } });
  }
  // A stopped one is made again stopped.
  await call("POST", "/stop");
  await call("PUT", "/config", { llm: { source: "auto" } });
  assert.deepEqual([machine.understory()!.State, envOf(machine.understory()!).LLM_MODEL], ["created", "auto"]);
  await call("POST", "/start");
});

test("tidying up now runs Understory's own pass and keeps what came of it; one that fails says why", async () => {
  scripts.dream = () => ({ out: `loading\n${JSON.stringify({ ran: true, summary: "**Merged** two notes on [the GPUs](/gpus.md). More.", filesChanged: ["/a.md", "/b.md"] })}\n` });
  const ran = await call("POST", "/dream");
  assert.equal(ran.status, 200);
  assert.deepEqual([ran.body.run.ok, ran.body.run.ran, ran.body.run.said], [true, true, "2 files changed — Merged two notes on the GPUs."]);
  assert.deepEqual(ran.body.understory.managed.lastDream, ran.body.run);
  assert.deepEqual(store.setting("lastDream"), ran.body.run);
  scripts.dream = () => ({ out: `${JSON.stringify({ error: "the model is gone" })}\n`, code: 1 });
  const failed = await call("POST", "/dream");
  assert.deepEqual([failed.status, failed.body.error, failed.body.run.ok], [502, "the model is gone", false]);
});

test("a run given up on is ended in the container too, before the next goes ahead", async () => {
  const limits = { ...service.runLimits };
  service.runLimits.run = 200;
  let release!: () => void;
  docker.hold.exec = new Promise<void>((resolve) => (release = resolve));
  try {
    const health = fetch(`${at}/health`).then((r) => r.json());
    for (let n = 0; n < 500 && !machine.ran().includes("pkill"); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(machine.ran().slice(-2), ["health", "pkill"]);
    release();
    // Writable whatever the check says: the check is what was given up on.
    assert.deepEqual(await health, { writable: true });
  } finally {
    docker.hold.exec = undefined;
    release();
    Object.assign(service.runLimits, limits);
  }
  scripts.save = () => ({ out: "" });
  const silent = await call("PUT", "/concept", { path: "/a.md", frontmatter: { type: "Note", title: "A" }, body: "" });
  assert.deepEqual(silent, { status: 502, body: { error: "Understory ended without saying what it did" } });
  delete scripts.save;
});

test("removed, the memory stays in its volume and Understory stops being the agent's memory; forgotten, the volume goes too", async () => {
  const removed = await call("DELETE", "/install");
  assert.equal(removed.status, 200);
  assert.equal(machine.understory(), undefined);
  assert.deepEqual(docker.volumes.map((v) => v.Name), [VOLUME]);
  assert.equal(servers().understory, undefined);
  assert.deepEqual([removed.body.reloaded, removed.body.waiting, removed.body.understory.enabled, removed.body.understory.managed.container], [0, 0, false, "absent"]);
  assert.deepEqual(trusted(), []);

  // Understory elsewhere stays the agent's memory when the portal's goes.
  await call("POST", "/install");
  await call("PUT", "/use", { enabled: true, url: "http://understory.test:3800/mcp" });
  const forgotten = await call("DELETE", "/install?memory=forget");
  assert.deepEqual([forgotten.status, "reloaded" in forgotten.body], [200, false]);
  assert.deepEqual(docker.volumes, []);
  assert.equal(servers().understory.url, "http://understory.test:3800/mcp");
  await call("PUT", "/use", { enabled: false });
});

test("a container by its name that the portal did not make is left alone, and an install says so", async () => {
  machine.reset();
  machine.putUnderstory({ Labels: {} });
  assert.equal((await state()).managed.container, "foreign");
  assert.deepEqual(await call("POST", "/install"), { status: 409, body: { error: "A container named pithagoras-understory is there that the portal did not make; rename or remove it first" } });
  assert.deepEqual(await call("DELETE", "/install"), { status: 409, body: { error: "A container named pithagoras-understory is there that the portal did not make; rename or remove it first" } });
  assert.deepEqual(machine.made(), []);
  // One the portal made before Understory was an extension is Understory's.
  machine.putUnderstory({});
  assert.equal((await state()).managed.container, "running");
});

test("a download that is under way is shown as it goes, and one that fails is said, and nothing is made", async () => {
  machine.reset();
  docker.images.clear();
  let open!: () => void;
  docker.hold.pull = new Promise<void>((resolve) => (open = resolve));
  try {
    const installing = call("POST", "/install");
    let shown: any;
    for (let n = 0; n < 500 && !(shown = (await state()).managed.pulling).line.startsWith("Downloading"); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(shown, { active: true, line: "Downloading [=====>   ] 5MB/10MB" });
    open();
    assert.equal((await installing).status, 200);
    assert.deepEqual((await state()).managed.pulling, { active: false, line: "done" });
  } finally {
    open();
    docker.hold.pull = undefined;
  }
  await call("DELETE", "/install?memory=forget");
  docker.images.clear();
  docker.failing.set(IMAGE, "pull access denied");
  const failed = await call("POST", "/install");
  assert.deepEqual([failed.status, failed.body.error], [500, "pull access denied"]);
  assert.deepEqual((await state()).managed.pulling, { active: false, line: "", error: "pull access denied" });
  assert.equal(machine.understory(), undefined);
  docker.failing.clear();
  docker.images.add(IMAGE);
});

test("while what the portal kept has not been taken up, its container keeps the token it and the agent's entry carry: saving and switching on are refused, and nothing is made, saved or written", async () => {
  machine.reset();
  const had = { token: store.setting("token"), config: store.setting("config") };
  const kept = "b".repeat(48);
  // As the portal left it: its container made with the token its MCP entry carries, and none of it in Understory's store.
  store.putSettings({ token: undefined, config: undefined });
  machine.putUnderstory({ made: { Env: [`AUTH_TOKEN=${kept}`, "LLM_API_BASE_URL=http://127.0.0.1:4100/understory-llm/v1"], HostConfig: { NetworkMode: "container:portal-one" } } });
  putServers({ understory: understoryEntry(MANAGED, { token: kept }) });
  const custom = { llm: { source: "custom", baseUrl: "http://gpu:8080/v1", model: "m", format: "openai" } };
  try {
    const saved = await call("PUT", "/config", custom);
    assert.equal(saved.status, 409);
    assert.match(saved.body.error, /^What the portal kept of Understory, with the token its container was made with, has not been taken up yet/);
    const on = await call("PUT", "/use", { enabled: true });
    assert.deepEqual([on.status, on.body.error], [409, saved.body.error]);
    assert.deepEqual(machine.made(), [], "not made again");
    assert.deepEqual([store.setting("token"), store.setting("config")], [undefined, undefined], "no token made, and nothing saved: what the portal kept is still to be taken up");
    assert.equal(servers().understory.bearerToken, kept);

    // Taken up, it is made again with the token it had, which the entry carries.
    store.putSettings({ token: kept });
    assert.equal((await call("PUT", "/config", custom)).status, 200);
    assert.equal(envOf(machine.understory()!).AUTH_TOKEN, kept);
    assert.equal((await call("PUT", "/use", { enabled: true })).status, 200);
    assert.equal(servers().understory.bearerToken, kept);
  } finally {
    store.putSettings(had);
    putServers({});
  }
});

test("where the model server could not take its port, the chat's model is not offered, and an Understory made for it is stopped and not started: what it sends would go to whatever holds the port", async () => {
  machine.reset();
  await call("PUT", "/config", { llm: { source: "auto" } });
  assert.equal((await call("POST", "/install")).status, 200);
  const port = Number(process.env.UNDERSTORY_LLM_PORT);
  const both = [halves.docker, halves.understory];
  await host.stopServerHalves();
  const other = net.createServer().listen(port, "127.0.0.1");
  await once(other, "listening");
  const lines = mock.method(console, "log", () => {});
  try {
    await host.syncServerHalves(both);
    // What the half does with the container as it starts, done: one more look through the same queue ends after it.
    await service.settleKept();
    const said = lines.mock.calls.map((c) => String(c.arguments[0])).join("\n");
    assert.match(said, new RegExp(`the model server for Understory could not listen on 127\\.0\\.0\\.1:${port}`));
    assert.match(said, /pithagoras-understory is stopped, as what it sends the chat's model would go to whatever holds that port: .*UNDERSTORY_LLM_PORT/);
    assert.equal(machine.understory()!.State, "exited");
    assert.equal((await state()).managed.autoPossible, false);

    const config = store.setting("config");
    const auto = await call("PUT", "/config", { llm: { source: "auto" }, dreamInterval: "6h", dreamAt: "" });
    assert.equal(auto.status, 400);
    assert.match(auto.body.error, /could not listen on 127\.0\.0\.1:\d+; set UNDERSTORY_LLM_PORT to a port that is free/);
    assert.deepEqual(store.setting("config"), config, "nothing saved");
    const started = await call("POST", "/start");
    assert.match(started.body.error, /UNDERSTORY_LLM_PORT/);
    assert.equal(machine.understory()!.State, "exited", "not started");
  } finally {
    lines.mock.restore();
    other.close();
    await host.stopServerHalves();
    await host.syncServerHalves(both);
    await service.settleKept();
  }
  assert.equal((await call("POST", "/start")).status, 200, "started once the model server listens");
});
