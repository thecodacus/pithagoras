import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { inProcessHome } from "../../../tests/helpers.mts";
import { serveBrowser } from "./portal.mts";

/**
 * Browser's routes, as its page and its Settings page use them, with Docker running the container (Docker's own half
 * against the tests' daemon): installing, the lifecycle after it, and wiring the agent's chats to the browser's tools.
 */
const home = inProcessHome("pithagoras-browser-routes-");
// No browser answers on its debugging port: what the routes say of a running one is the tools' tests'.
process.env.BROWSER_CDP_URL = "http://127.0.0.1:1";
delete process.env.BROWSER_EXTERNAL;
delete process.env.BROWSER_BIND;
const browser = await serveBrowser();
const { docker, db, host } = browser;

/** The chats loaded again: the routes ask it of the portal, which the tests stand in for. */
let reloads = 0;
host.setChatBridge({ tell: async () => false, offers: () => undefined, reload: async () => ((reloads += 1), { reloaded: 0, waiting: 0 }) });

const call = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`${browser.at}${route}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const state = async () => (await call("GET", "/state")).body;
const NAMES = ["browser_navigate", "browser_back", "browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_key", "browser_scroll", "browser_find", "browser_get_text", "browser_screenshot"];
const adopted = () => {
  const file = path.join(realpathSync(home), "extension-data", "pithagoras-docker", "adopted.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { containers: {}, volumes: {} };
};
browser.chat("c1");

test("before anything is installed: Docker can run it, nothing is there, and the agent is not wired to it", async () => {
  assert.deepEqual(await state(), {
    running: false,
    unprotected: false,
    version: null,
    pages: [],
    uiPort: "3011",
    uiExposed: false,
    uiOutdated: false,
    cursor: true,
    connected: false,
    install: { available: true, mode: "docker", image: false, container: "absent", pulling: { active: false, line: "" } },
    config: { user: "agent", hasPassword: false },
    byDefault: true,
    chats: [],
    routines: [],
  });
  assert.deepEqual(Object.keys(browser.tools("c1")).filter((name) => name.startsWith("browser_")), [], "no browser tools in a chat");
  assert.deepEqual(host.offeredTools().get("pithagoras-browser"), [], "and none offered");
});

test("it is not installed without a password, which guards a browser holding live logins", async () => {
  assert.deepEqual(await call("POST", "/install"), { status: 400, body: { error: "Set a password before installing — it guards a browser holding live logins" } });
  assert.deepEqual([docker.pulls, docker.containers], [[], []]);
});

test("installing pulls the image, takes over the profile, makes and starts the container, and then wires the agent to it; a second install meanwhile is refused", async () => {
  assert.deepEqual((await call("PUT", "/config", { password: "secret", port: "", httpsPort: 7 })).body, { user: "agent", hasPassword: true });
  // The profile the portal made before Browser was an extension, not taken over yet.
  docker.volumes.push({ Name: "pithagoras_browser-profile", Labels: null });
  let release!: () => void;
  docker.hold.pull = new Promise<void>((resolve) => (release = resolve));
  reloads = 0;
  try {
    const first = call("POST", "/install");
    for (let n = 0; n < 100 && !(await state()).install.pulling.active; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await state()).install.pulling.active, true, "the download is shown as it goes");
    assert.deepEqual(await call("POST", "/install"), { status: 409, body: { error: "The browser is already being installed" } });
    assert.equal((await state()).connected, false, "not wired to a browser that is not there yet");
    release();
    assert.deepEqual(await first, { status: 200, body: { ok: true } });
  } finally {
    release();
    delete docker.hold.pull;
  }
  assert.equal(docker.pulls.length, 1);
  assert.deepEqual(docker.volumes, [{ Name: "pithagoras_browser-profile", Labels: null }], "the same volume, taken over");
  assert.deepEqual(adopted().volumes, { "pithagoras_browser-profile": "pithagoras-browser" });
  const [made] = docker.containers;
  assert.deepEqual([made.Name, made.State, made.Labels], ["pithagoras-browser", "running", { "pithagoras.browser-bind": "127.0.0.1", "pithagoras.extension": "pithagoras-browser" }]);
  assert.ok((made.made!.Env as string[]).includes("PASSWORD=secret"));
  assert.deepEqual((made.made!.HostConfig as { Binds: string[] }).Binds, ["pithagoras_browser-profile:/config"]);
  const now = await state();
  assert.deepEqual([now.connected, now.install.container, now.install.image, now.install.pulling], [true, "running", true, { active: false, line: "done" }]);
  assert.equal(reloads, 1, "the chats that are idle are loaded again, with the tools");
});

test("while it is wired, every chat has the 11 tools, one at a time, each held by the guard to what it reads and where it goes", () => {
  const tools = browser.tools("c1");
  assert.deepEqual(Object.keys(tools).filter((name) => name.startsWith("browser_")).sort(), [...NAMES].sort());
  for (const name of NAMES) {
    assert.equal(tools[name].executionMode, "sequential", name);
    assert.deepEqual(tools[name].guard, { outside: true, reaches: ["url"] }, name);
    // That a page is data is the portal's to say once, while any tool that reads outside content is on.
    assert.doesNotMatch(JSON.stringify(tools[name].promptGuidelines ?? []), /untrusted|not instructions/i, name);
  }
  assert.deepEqual(host.offeredTools().get("pithagoras-browser").map((tool: { name: string }) => tool.name).sort(), [...NAMES].sort());
});

test("unwired, no chat has them, and wired again they are back", async () => {
  reloads = 0;
  assert.deepEqual(await call("DELETE", "/connect"), { status: 200, body: { connected: false } });
  assert.deepEqual(Object.keys(browser.tools("c1")).filter((name) => name.startsWith("browser_")), []);
  assert.deepEqual(host.offeredTools().get("pithagoras-browser"), []);
  assert.deepEqual(await call("POST", "/connect"), { status: 200, body: { connected: true } });
  assert.equal(Object.keys(browser.tools("c1")).filter((name) => name.startsWith("browser_")).length, 11);
  assert.equal(reloads, 2);
});

test("who may drive it: the chats whose switches differ from the default, each with the other answer", async () => {
  browser.chat("c2");
  db.setSessionTools("c2", { off: NAMES, on: [] });
  const now = await state();
  assert.equal(now.byDefault, true);
  assert.deepEqual(now.chats, [{ id: "c2", title: "A chat", kind: "task", allowed: false }]);
});

test("stopped and started, and the cursor switched, from the Browser page", async () => {
  assert.deepEqual(await call("POST", "/stop"), { status: 200, body: { ok: true } });
  assert.equal(docker.containers[0].State, "exited");
  assert.equal((await state()).install.container, "stopped");
  assert.deepEqual(await call("POST", "/start"), { status: 200, body: { ok: true } });
  assert.equal(docker.containers[0].State, "running");

  assert.deepEqual(await call("PUT", "/cursor", { on: false }), { status: 200, body: { cursor: false } });
  assert.equal((await state()).cursor, false);
  assert.deepEqual(await call("PUT", "/cursor", { on: "no" }), { status: 400, body: { error: "on must be a boolean" } });
  assert.deepEqual(await call("PUT", "/cursor", { on: true }), { status: 200, body: { cursor: true } });

  assert.match((await call("GET", "/suggest-password")).body.password, /^[0-9a-f]{24}$/);
});

test("removed, the agent is unwired and the logins stay; forgetting the profile takes them too", async () => {
  reloads = 0;
  assert.deepEqual(await call("DELETE", "/install"), { status: 200, body: { ok: true } });
  assert.deepEqual(docker.containers, []);
  assert.equal(docker.volumes.length, 1, "the logins stay");
  assert.equal((await state()).connected, false);
  assert.equal(reloads, 1);

  assert.deepEqual(await call("POST", "/install"), { status: 200, body: { ok: true } });
  assert.equal(docker.pulls.length, 1, "the image is there: not downloaded again");
  assert.deepEqual(await call("DELETE", "/install?profile=forget"), { status: 200, body: { ok: true } });
  assert.deepEqual([docker.containers, docker.volumes], [[], []]);
  assert.deepEqual(adopted().volumes, {}, "and nothing is kept of it");
  // Gone already is gone.
  assert.deepEqual(await call("DELETE", "/install?profile=forget"), { status: 200, body: { ok: true } });
});

test("a container that is another extension's is not Browser's to replace, and says so", async () => {
  docker.containers.push({ Id: "other".padEnd(64, "0"), Name: "pithagoras-browser", Image: "x", State: "running", Labels: { "pithagoras.extension": "pithagoras-elsewhere" }, Tty: false, out: "", err: "" });
  try {
    assert.deepEqual(await call("POST", "/install"), { status: 400, body: { error: "pithagoras-browser is pithagoras-elsewhere's container, not pithagoras-browser's" } });
    assert.equal((await state()).connected, false);
  } finally {
    docker.containers.length = 0;
  }
});

test("a container and a profile the half could not take over as it started, Docker coming up after it, are taken over as they are acted on", async () => {
  // As the portal made them before Browser was an extension: no extension's name on either, and nothing kept of them.
  const OLD = { Id: "825eb3e279a0".padEnd(64, "0"), Name: "pithagoras-browser", Image: "lscr.io/linuxserver/chromium:latest", State: "running", Labels: {}, Tty: false, out: "", err: "" };
  // The install refused just before made Browser a volume of its own.
  docker.volumes.length = 0;
  docker.containers.push({ ...OLD });
  docker.volumes.push({ Name: "pithagoras_browser-profile", Labels: null });
  assert.deepEqual(adopted(), { containers: {}, volumes: {} });
  assert.deepEqual(await call("POST", "/stop"), { status: 200, body: { ok: true } });
  assert.deepEqual(adopted().containers, { [OLD.Id]: "pithagoras-browser" });
  assert.deepEqual(docker.containers.map(({ Id, State }) => ({ Id, State })), [{ Id: OLD.Id, State: "exited" }], "the same container, stopped");
  assert.deepEqual(await call("POST", "/start"), { status: 200, body: { ok: true } });
  assert.equal(docker.containers[0].State, "running");
  assert.deepEqual(await call("DELETE", "/install?profile=forget"), { status: 200, body: { ok: true } });
  assert.deepEqual([docker.containers, docker.volumes], [[], []]);
});
