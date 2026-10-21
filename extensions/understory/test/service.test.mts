import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { scratch } from "../../../tests/helpers.mts";
import { setPortal } from "../src/server/host.ts";
import { openStore } from "../src/server/store.ts";

/**
 * What the Understory the portal runs is made with and reads back, over a stand-in for the portal: its settings, the
 * container's environment, tidying up at a set time, what its scripts print, and the MCP entry that makes it the
 * agent's memory.
 */

delete process.env.MEMORY_UNDERSTORY_URL;
setPortal({ extension: "pithagoras-understory", log: () => {} } as any);
openStore(realpathSync(scratch("understory-service-")));
const service = await import("../src/server/service.ts");
const { understoryDefaultUrl, understoryEntry, understoryTokenOf, UNDERSTORY_RULE } = await import("../src/server/entry.ts");

const llm = { source: "custom" as const, baseUrl: "http://gpu:8080/v1", model: "m", format: "openai" as const };

test("its tidying up: Understory's own reading of an interval and its floor, a time of day, and the next time it comes round", () => {
  assert.equal(service.intervalMs("6h"), 6 * 3_600_000);
  assert.equal(service.intervalMs("sometimes"), null);
  assert.equal(service.validInterval(""), true, "never is an interval too");
  assert.equal(service.validInterval("30m"), true);
  assert.equal(service.validInterval("2m"), false, "Understory's floor is five minutes");
  assert.equal(service.validTime("03:00"), true);
  assert.equal(service.validTime(""), true);
  assert.equal(service.validTime("3am"), false);
  assert.equal(service.validTime("24:00"), false);

  const evening = new Date(2026, 8, 28, 22, 15);
  assert.deepEqual(service.nextAt("03:00", evening), new Date(2026, 8, 29, 3, 0));
  const night = new Date(2026, 8, 29, 2, 0);
  assert.deepEqual(service.nextAt("03:00", night), new Date(2026, 8, 29, 3, 0), "later the same night");
  assert.deepEqual(service.nextAt("03:00", new Date(2026, 8, 29, 3, 0)), new Date(2026, 8, 30, 3, 0), "not twice in the same minute");
});

test("saved, a set time wins over Understory's own timer and is armed; a key the page never holds is kept for its own address only", () => {
  service.saveConfig({ llm, dreamInterval: "6h", dreamAt: "03:00" });
  assert.deepEqual([service.config().dreamInterval, service.config().dreamAt], ["", "03:00"]);
  assert.ok(service.nextDreamAt(), "armed once saved");
  service.saveConfig({ llm, dreamInterval: "", dreamAt: "" });
  assert.equal(service.nextDreamAt(), undefined, "and no longer once it is not");

  service.saveConfig({ llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", format: "openai", apiKey: "sk-1" }, dreamInterval: "1d", dreamAt: "" });
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai" }, dreamInterval: "1d", dreamAt: "" });
  assert.deepEqual(service.config(), { llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai", apiKey: "sk-1" }, dreamInterval: "1d", dreamAt: "" });
  // Another address does not get the key the last one had.
  assert.equal((service.withSavedKey({ source: "custom", baseUrl: "http://other:8080/v1", model: "m", format: "openai" }) as { apiKey?: string }).apiKey, undefined, "a key is its server's");
  service.saveConfig({ llm: { source: "custom", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", format: "openai", apiKey: "" }, dreamInterval: "", dreamAt: "" });
  assert.equal((service.config().llm as { apiKey?: string }).apiKey, "", "an empty one clears it");

  // What was saved before is put back as it was, key and all.
  const before = service.config();
  service.saveConfig({ llm: { source: "auto" }, dreamInterval: "6h", dreamAt: "" });
  service.restoreConfig(before);
  assert.deepEqual(service.config(), before);
  service.stopDreams();
});

test("the container is made with its token, on the network it is given, with the label a portal that goes back knows it by", async () => {
  const token = service.token();
  assert.equal(service.token(), token, "made once");
  const made = await service.spec({ llm, dreamInterval: "6h", dreamAt: "" }, token, "container:abc");
  for (const line of ["BUNDLE_ROOT=/bundle", "PORT=3800", `AUTH_TOKEN=${token}`, "LLM_API_BASE_URL=http://gpu:8080/v1", "LLM_API_KEY=none", "LLM_API_FORMAT=openai", "LLM_MODEL=m", "DREAM_INTERVAL=6h"]) assert.ok(made.Env.includes(line), line);
  assert.ok(!(await service.spec({ llm, dreamInterval: "", dreamAt: "" }, token)).Env.some((l) => l.startsWith("DREAM_INTERVAL")), "never is no interval at all");
  assert.ok(!(await service.spec({ llm, dreamInterval: "6h", dreamAt: "03:00" }, token)).Env.some((l) => l.startsWith("DREAM_INTERVAL")), "a set time wins");
  assert.deepEqual(made.Labels, { "pithagoras.addon": "understory" });
  assert.deepEqual(made.HostConfig, { NetworkMode: "container:abc", RestartPolicy: { Name: "unless-stopped" }, Binds: ["pithagoras_understory-memory:/bundle"] });
});

test("what a script printed: its report is its last line that is JSON; a summary is one plain line; what it is handed is measured as it travels", () => {
  assert.deepEqual(service.readReport('\u001b[0mloading\r\n{"ran":false,"reason":"memory healthy"}\r\n'), { ran: false, reason: "memory healthy" });
  assert.deepEqual(service.readReport('{"ran":true,"summary":"merged two","filesChanged":["/a.md"]}\nbye'), { ran: true, summary: "merged two", filesChanged: ["/a.md"] });
  assert.equal(service.readReport("Error: boom"), null);

  assert.equal(service.firstLine("The orphan is resolved — the graph is now healthy (4 concepts).\n\n## What changed\n\n- a"), "The orphan is resolved — the graph is now healthy (4 concepts).");
  assert.equal(service.firstLine("**Fixed** the link from [branches](/deployment/branches.md). More."), "Fixed the link from branches.");
  assert.equal(service.firstLine("x".repeat(300)).length, 160);
  assert.equal(service.firstLine(undefined), "");

  // UTF-8, base64, in one variable of at most 128 KiB.
  const note = (body: string) => ({ path: "/a.md", frontmatter: { type: "T", title: "A" }, body, summary: "x" });
  assert.equal(service.fitsInEnv(note("a".repeat(90_000))), true);
  assert.equal(service.fitsInEnv(note("a".repeat(99_000))), false, "under 100 000 characters, over the limit once base64'd");
  assert.equal(service.fitsInEnv(note("記".repeat(30_000))), true);
  assert.equal(service.fitsInEnv(note("記".repeat(34_000))), false, "three bytes a letter");
});

test("its MCP entry puts its tools in front of the agent: its own token written in, one from the environment named", () => {
  assert.equal(understoryDefaultUrl(), "http://localhost:3800/mcp");
  assert.deepEqual(understoryEntry("http://understory:3800/mcp"), { url: "http://understory:3800/mcp", lifecycle: "lazy", directTools: true });
  assert.deepEqual(understoryEntry("http://u/mcp", { tokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" }), { url: "http://u/mcp", lifecycle: "lazy", directTools: true, auth: "bearer", bearerTokenEnv: "MEMORY_UNDERSTORY_AUTH_TOKEN" });
  assert.deepEqual(understoryEntry("http://127.0.0.1:3800/mcp", { token: "t0k" }), { url: "http://127.0.0.1:3800/mcp", lifecycle: "lazy", directTools: true, auth: "bearer", bearerToken: "t0k" });
  assert.equal(understoryTokenOf({ bearerToken: "t0k" }), "t0k");
  process.env.SOME_TOKEN = "from-env";
  assert.equal(understoryTokenOf({ bearerTokenEnv: "SOME_TOKEN" }), "from-env");
  assert.equal(understoryTokenOf({ url: "x" }), undefined);
  assert.match(UNDERSTORY_RULE, /understory_memory_query/);
});
