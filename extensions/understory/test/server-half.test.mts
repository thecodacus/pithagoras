import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { freePort, inProcessHome } from "../../../tests/helpers.mts";
import { CONTAINER, VOLUME, envOf, startUnderstory } from "./portal.mts";

/**
 * Understory's server half in the portal's own extension host: it builds on Docker, starts only after it, and starts and
 * stops without waiting on Docker or touching Understory's container. It holds the agent's memory while its server is
 * the chats'. The container and the volume the portal made before Understory was an extension are taken over by their
 * names as it starts, what of the portal's still ran in the container is ended, and a container made for the portal's
 * old model route, or for a portal container that is gone, is made again once, with its memory and its token.
 */

const home = inProcessHome("pithagoras-understory-half-");
const { host, halves, docker, machine, adapterOn, putServers } = await startUnderstory();
const both = [halves.docker, halves.understory];
const store = await import("../src/server/store.ts");
const service = await import("../src/server/service.ts");
const { memoryHolder } = await import(new URL("../../../core/server/dist/memory-holder.js", import.meta.url).href);
const { memoryRule } = await import(new URL("../../../core/server/dist/pi/sdk-client.js", import.meta.url).href);

/** What Docker keeps of what each extension took over. */
const adopted = () => {
  const file = path.join(realpathSync(home), "extension-data", "pithagoras-docker", "adopted.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { containers: {}, volumes: {} };
};
const until = async (done: () => boolean, what: string) => {
  for (const end = Date.now() + 30_000; Date.now() < end; ) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`not ${what} in time`);
};
/** What the half says, as the portal's log has it, while `fn` runs and until `done` holds of it (or ten seconds have gone by), or for a second after. */
async function logged(fn: () => Promise<void>, done?: (said: string) => boolean): Promise<string> {
  const lines = mock.method(console, "log", () => {});
  const said = () => lines.mock.calls.map((call) => String(call.arguments[0])).join("\n");
  try {
    await fn();
    for (const end = Date.now() + (done ? 10_000 : 1_000); Date.now() < end && !done?.(said()); ) await new Promise((resolve) => setTimeout(resolve, 10));
    return said();
  } finally {
    lines.mock.restore();
  }
}
/**
 * Understory's half started again, as Docker's update or switching it off and on does, and what it does with the
 * container as it starts done: one more look through the same queue, which nothing passes before it, ends after it.
 */
const restart = async () => {
  await host.stopServerHalves();
  await host.syncServerHalves(both);
  await service.settleKept();
};
/** Whether the model server answers on its port. */
const modelServerAnswers = () =>
  fetch(`http://127.0.0.1:${process.env.UNDERSTORY_LLM_PORT}/v1/models`).then(
    () => true,
    () => false,
  );

/** Understory's container as the portal made it: labelled as Understory, no extension's name on it, thinking with the chat's model through the portal's own route. */
const TOKEN = "a".repeat(48);
const OLD = {
  Id: "c0ffee000000".padEnd(64, "0"),
  made: {
    Env: ["BUNDLE_ROOT=/bundle", "PORT=3800", `AUTH_TOKEN=${TOKEN}`, "LLM_API_BASE_URL=http://127.0.0.1:4100/understory-llm/v1", "LLM_API_KEY=k", "LLM_API_FORMAT=openai", "LLM_MODEL=auto"],
    HostConfig: { NetworkMode: "container:portal-one", RestartPolicy: { Name: "unless-stopped" }, Binds: [`${VOLUME}:/bundle`] },
  },
};

test("Understory's server half does not start without Docker, which it requires, and starts after it", async () => {
  await host.syncServerHalves([halves.understory]);
  assert.equal(host.isServing("pithagoras-understory"), false);
  assert.match(host.serverFailure("pithagoras-understory") ?? "", /It needs pithagoras-docker \(\^1\.1\.0\), which is not installed, or is switched off/);

  await host.syncServerHalves(both);
  assert.equal(host.serverFailure("pithagoras-understory"), undefined);
  assert.deepEqual([host.isServing("pithagoras-docker"), host.isServing("pithagoras-understory")], [true, true]);
});

test("it holds the agent's memory while its server is the chats': there, not switched off, and pi-mcp-adapter on", async () => {
  const agentHome = process.env.AGENT_HOME!;
  putServers({});
  assert.equal(memoryHolder(), undefined);
  assert.deepEqual(memoryRule(agentHome), []);
  putServers({ understory: { url: "http://127.0.0.1:1/mcp" } });
  assert.equal(memoryHolder(), undefined, "without the adapter its tools are no one's");
  adapterOn();
  assert.equal(memoryHolder()?.label, "Understory");
  assert.match(memoryRule(agentHome)[0], /understory_memory_query/);
  putServers({ understory: { url: "http://127.0.0.1:1/mcp", disabled: true } });
  assert.equal(memoryHolder(), undefined, "switched off in Settings → MCP");
  // Let go when the half stops.
  putServers({ understory: { url: "http://127.0.0.1:1/mcp" } });
  await host.stopServerHalves();
  assert.equal(memoryHolder(), undefined);
  await host.syncServerHalves(both);
  assert.equal(memoryHolder()?.label, "Understory");
  putServers({});
});

test("as it starts, the container and the volume the portal made are taken over, what of the portal's ran in it is ended, and it is made again once for the model server and the portal's loopback", async () => {
  machine.reset();
  store.putSettings({ token: TOKEN, config: { llm: { source: "auto" }, dreamInterval: "", dreamAt: "" } });
  machine.putUnderstory(OLD);
  docker.volumes.push({ Name: VOLUME, Labels: null });
  await restart();
  assert.equal(machine.understory()?.State, "running");
  // What still ran in it, ended before anything else.
  assert.deepEqual([docker.execs[0].ContainerID, ...new Set(machine.ran())], [OLD.Id, "pkill"]);
  const now = machine.understory()!;
  const env = envOf(now);
  assert.equal(env.LLM_API_BASE_URL, `http://127.0.0.1:${process.env.UNDERSTORY_LLM_PORT}/v1`);
  assert.equal(env.AUTH_TOKEN, TOKEN, "its token stays: the agent's MCP entry carries it");
  assert.equal(env.LLM_API_KEY, store.setting("llmToken"));
  assert.deepEqual(now.Labels, { "pithagoras.addon": "understory", "pithagoras.extension": "pithagoras-understory" });
  const made = now.made as any;
  assert.deepEqual(made.HostConfig, { NetworkMode: "container:portal-one", RestartPolicy: { Name: "unless-stopped" }, Binds: [`${VOLUME}:/bundle`] });
  // The one taken over is let go of with it, and the volume is kept as it is.
  await until(() => !(OLD.Id in adopted().containers), "let go of");
  assert.deepEqual(adopted().volumes, { [VOLUME]: "pithagoras-understory" });
  assert.deepEqual(docker.volumes, [{ Name: VOLUME, Labels: null }]);
  assert.deepEqual(docker.pulls, [], "no image is downloaded: the one it runs is there");
  assert.equal(await modelServerAnswers(), true, "and the model server it is pointed at listens");

  // Once: a start finds it as it should be, and leaves it.
  const said = await logged(restart);
  assert.doesNotMatch(said, /could not|left alone/);
  assert.equal(machine.made().length, 1);
});

test("a stopped one made for a portal container that is gone is made again on the portal's, and left stopped", async () => {
  machine.reset();
  machine.portalIs("portal-two");
  machine.putUnderstory({ ...OLD, State: "exited", made: { ...OLD.made, Env: OLD.made.Env.map((e) => (e.startsWith("LLM_API_BASE_URL=") ? "LLM_API_BASE_URL=http://gpu:8080/v1" : e)) } });
  store.putSettings({ config: { llm: { source: "custom", baseUrl: "http://gpu:8080/v1", model: "m", format: "openai" }, dreamInterval: "", dreamAt: "" } });
  await restart();
  assert.equal(machine.made().length, 1);
  assert.equal((machine.understory()!.made as any).HostConfig.NetworkMode, "container:portal-two");
  assert.equal(envOf(machine.understory()!).LLM_API_BASE_URL, "http://gpu:8080/v1");
  assert.equal(machine.understory()!.State, "created", "not started: it was stopped");
  assert.deepEqual(machine.ran(), [], "nothing runs in a stopped one");
});

test("every half minute, a running one is made again where the portal's container was made again since", async () => {
  machine.reset();
  await restart();
  await service.install();
  const first = machine.understory()!.Id;
  service.lookAfter();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(machine.understory()!.Id, first, "on the portal's loopback: left as it is");
  machine.portalIs("portal-three");
  service.lookAfter();
  await until(() => machine.understory()?.Id !== first && machine.understory()?.State === "running", "made again");
  assert.equal((machine.understory()!.made as any).HostConfig.NetworkMode, "container:portal-three");
});

test("one whose token was not taken up from what the portal kept is left as it is, which is said", async () => {
  machine.reset();
  // What the portal kept not taken up: none of its settings, the token and the model among them, are here.
  const config = store.setting("config");
  store.putSettings({ token: undefined, config: undefined });
  machine.putUnderstory(OLD);
  const said = await logged(restart, (text) => /left as it is/.test(text));
  assert.match(said, /pithagoras-understory could not be made again with its settings, and is left as it is: What the portal kept of Understory, with the token its container was made with, has not been taken up yet/);
  assert.deepEqual(machine.made(), []);
  assert.equal(store.setting("token"), undefined, "no token is made in its place");
  store.putSettings({ token: TOKEN, config });
});

test("a running one made for the chat's model is made again as it starts where UNDERSTORY_LLM_PORT says another port since", async () => {
  machine.reset();
  store.putSettings({ token: TOKEN, config: { llm: { source: "auto" }, dreamInterval: "", dreamAt: "" } });
  await service.install();
  const was = process.env.UNDERSTORY_LLM_PORT;
  process.env.UNDERSTORY_LLM_PORT = String(await freePort());
  try {
    await restart();
    assert.equal(machine.made().length, 2);
    const env = envOf(machine.understory()!);
    assert.deepEqual([env.LLM_API_BASE_URL, env.AUTH_TOKEN], [`http://127.0.0.1:${process.env.UNDERSTORY_LLM_PORT}/v1`, TOKEN]);
    assert.equal(machine.understory()!.State, "running");
    assert.equal(await modelServerAnswers(), true, "where the model server listens now");
  } finally {
    process.env.UNDERSTORY_LLM_PORT = was;
    await restart();
  }
});

test("none there is nothing to take over; one that is not Understory's, or another extension's, is not its to take, which is said", async () => {
  machine.reset();
  let said = await logged(restart);
  assert.doesNotMatch(said, /could not|left alone/);

  machine.putUnderstory({ Labels: {} });
  said = await logged(restart, (text) => /left alone/.test(text));
  assert.match(said, /\[extension pithagoras-understory\] pithagoras-understory is not Understory's, and is left alone/);
  assert.equal(machine.understory()!.Id in adopted().containers, false);

  machine.putUnderstory({ Labels: { "pithagoras.extension": "pithagoras-elsewhere", "pithagoras.addon": "understory" } });
  docker.volumes.push({ Name: VOLUME, Labels: { "pithagoras.extension": "pithagoras-elsewhere" } });
  said = await logged(restart, (text) => /left alone/.test(text) && /volume/.test(text));
  assert.match(said, /could not take over the memory, the volume pithagoras_understory-memory: pithagoras_understory-memory is pithagoras-elsewhere's volume, not pithagoras-understory's/);
  assert.deepEqual([machine.made(), machine.ran()], [[], []]);
});

test("the half stops without stopping Understory's container, its pass at a set time, nor its model server, and starts them again", async () => {
  machine.reset();
  await service.install();
  service.saveConfig({ llm: { source: "auto" }, dreamInterval: "", dreamAt: "03:00" });
  assert.ok(service.nextDreamAt(), "armed");
  await host.stopServerHalves();
  assert.equal(machine.understory()!.State, "running");
  assert.equal(service.nextDreamAt(), undefined, "no pass while the half is stopped");
  assert.equal(await modelServerAnswers(), false, "the model server is closed");
  await host.syncServerHalves(both);
  assert.equal(host.isServing("pithagoras-understory"), true);
  assert.ok(service.nextDreamAt(), "armed again as it starts");
  assert.equal(await modelServerAnswers(), true);
  service.saveConfig({ llm: { source: "auto" }, dreamInterval: "", dreamAt: "" });
});

test("a start does not wait for a Docker that is slow to answer", async () => {
  // A daemon that answers that it is there, and holds every other question: Docker's requests may take 30 seconds,
  // and a half has 15 to start.
  let asked = 0;
  const slow = http.createServer((req) => {
    if (req.url === "/_ping") return void req.socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    asked++;
  });
  const socket = path.join(docker.dir, "slow.sock");
  await new Promise<void>((resolve) => slow.listen(socket, resolve));
  const fast = process.env.DOCKER_SOCKET;
  process.env.DOCKER_SOCKET = socket;
  try {
    await host.stopServerHalves();
    const began = Date.now();
    await host.syncServerHalves(both);
    assert.equal(host.isServing("pithagoras-understory"), true);
    await until(() => asked > 0, "asked of Docker");
    assert.ok(Date.now() - began < 3000, `started in ${Date.now() - began} ms, Docker not answering`);
  } finally {
    process.env.DOCKER_SOCKET = fast;
    slow.closeAllConnections();
    slow.close();
    await restart();
  }
});
