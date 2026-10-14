import { randomBytes } from "node:crypto";
import { getSetting, putSetting } from "../db.js";
import { tlsFiles } from "../http-security.js";
import { readModelsJson, resolveKey, storedKey } from "../providers.js";
import { containerAction, dockerAvailable, ensureImage, imagePresent, request, type PullState } from "./docker.js";
import { voiceNetworkMode as sharedNetworkMode } from "./voice-service.js";

/**
 * Understory, run by the portal: installed from Settings → Add-ons → Memory
 * like the browser, so the model that keeps the memory and how often it tidies
 * up can be chosen there.
 *
 * Understory reads all of that from its environment, once, when it starts —
 * its own settings page only shows it. So a change is saved here and the
 * container made again with it; the memory is in a volume and stays.
 *
 * Host networking, as the browser has: a model server the portal reaches on
 * localhost is reached the same way from here. Understory listens on every
 * interface, so it gets a token of its own, which only the portal holds — the
 * agent's MCP entry and the Memory page are its only callers.
 */

export const IMAGE = "ghcr.io/thecodacus/understory:latest";
export const CONTAINER = "pithagoras-understory";
export const VOLUME = process.env.UNDERSTORY_VOLUME || "pithagoras_understory-memory";
export const port = (): number => Number(process.env.UNDERSTORY_PORT) || 3800;
export const managedUrl = (): string => `http://127.0.0.1:${port()}/mcp`;

export type LlmFormat = "openai" | "anthropic";

/**
 * Where the model that keeps the memory comes from: the chat's (the one the
 * chat asking is on — see memory-llm.ts), a provider set up here, or an
 * address of its own.
 */
export type LlmChoice =
  | { source: "auto" }
  | { source: "provider"; provider: string; model: string }
  | { source: "custom"; baseUrl: string; model: string; format: LlmFormat; apiKey?: string };

export interface UnderstoryConfig {
  llm: LlmChoice;
  /** How often it tidies the memory up — Understory's "dreaming" — as it reads it: "6h", "1d". Empty for never. */
  dreamInterval: string;
  /**
   * Or once a day at this time, "03:00", in the portal's time zone: the
   * portal starts the pass itself, since Understory only counts from its own
   * start. Wins over the interval.
   */
  dreamAt: string;
}

const KEY = "understory_config";
const TOKEN = "understory_token";
const LLM_TOKEN = "understory_llm_token";
const LAST_DREAM = "understory_last_dream";

/** Understory's own reading of an interval, and its floor: five minutes. */
export function intervalMs(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
  if (!m) return null;
  return Math.round(Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "m" | "h" | "d"]);
}

/** A time of day, "HH:MM", or empty. */
export const validTime = (raw: string): boolean => !raw || /^([01]\d|2[0-3]):[0-5]\d$/.test(raw);

export function validInterval(raw: string): boolean {
  if (!raw) return true;
  const ms = intervalMs(raw);
  return ms !== null && ms >= 5 * 60_000;
}

export function config(): UnderstoryConfig {
  try {
    const raw = JSON.parse(getSetting(KEY) || "{}");
    return {
      // Nothing chosen is the chat's: the model already loaded, which asks nothing of anyone.
      llm: raw.llm && typeof raw.llm === "object" ? (raw.llm as LlmChoice) : { source: "auto" },
      dreamInterval: typeof raw.dreamInterval === "string" && validInterval(raw.dreamInterval) ? raw.dreamInterval : "",
      dreamAt: typeof raw.dreamAt === "string" && validTime(raw.dreamAt) ? raw.dreamAt : "",
    };
  } catch {
    return { llm: { source: "auto" }, dreamInterval: "", dreamAt: "" };
  }
}

const put = putSetting;

/**
 * A choice as it would be saved: as given, except that a custom address sent
 * without a key keeps the one it had, for the same address only. The page never
 * holds the key, so it cannot send it back.
 */
export function withSavedKey(llm: LlmChoice): LlmChoice {
  const had = config().llm;
  // Only for the same address: a key is the one server's, and must not go to another.
  if (llm.source === "custom" && llm.apiKey === undefined && had.source === "custom" && had.baseUrl === llm.baseUrl) return { ...llm, apiKey: had.apiKey };
  return llm;
}

export function saveConfig(next: UnderstoryConfig): UnderstoryConfig {
  const llm = withSavedKey(next.llm);
  // A set time wins, and Understory's own timer is left off: two passes a day would be one too many.
  put(KEY, JSON.stringify({ llm, dreamInterval: next.dreamAt ? "" : next.dreamInterval, dreamAt: next.dreamAt }));
  scheduleDreams();
  return config();
}

/** Puts back what was saved before, key and all, as it was. */
export function restoreConfig(before: UnderstoryConfig): void {
  put(KEY, JSON.stringify(before));
  scheduleDreams();
}

function secret(key: string): string {
  const had = getSetting(key);
  if (had) return had;
  const made = randomBytes(24).toString("hex");
  put(key, made);
  return made;
}

/** The token the container is given and the portal calls it with; made once. */
export const token = (): string => secret(TOKEN);

/** The key Understory calls the portal's model server with, in "the chat's" mode; made once. */
export const llmToken = (): string => secret(LLM_TOKEN);

/** That key if one was ever made — never made by asking: a stranger's request must not make one. */
export const existingLlmToken = (): string | undefined => getSetting(LLM_TOKEN);

/**
 * Where Understory reaches the portal's model server: on the host network,
 * the portal's own port on loopback. Not over the portal's own TLS, whose
 * certificate Understory has no reason to trust — then there is no "the
 * chat's", and a model of its own is needed.
 */
export function portalLlmBase(): string | undefined {
  // The portal's own decision, the one the server serves by.
  if (tlsFiles()) return undefined;
  return `http://127.0.0.1:${Number(process.env.PORT || 4100)}/understory-llm/v1`;
}

/**
 * The key a provider is saved with, as pi reads it. A command (`!…`) is pi's
 * to run, not ours to hand a container.
 */
function providerKey(provider: string): string | undefined {
  const key = storedKey(provider);
  if (key?.startsWith("!")) throw new Error("That provider's key is a command pi runs; give Understory an address and key of its own instead");
  return resolveKey(key);
}

/** What Understory is told about its model: the provider's address and key, looked up when the container is made. */
export function llmEnv(llm: LlmChoice): { baseUrl: string; apiKey: string; model: string; format: LlmFormat } {
  if (llm.source === "auto") {
    const baseUrl = portalLlmBase();
    if (!baseUrl) throw new Error("The portal serves its own TLS, which Understory cannot reach it through; give Understory a model of its own");
    return { baseUrl, apiKey: llmToken(), model: "auto", format: "openai" };
  }
  if (llm.source === "custom") return { baseUrl: llm.baseUrl, apiKey: llm.apiKey || "none", model: llm.model, format: llm.format };
  const raw = readModelsJson().providers?.[llm.provider];
  if (!raw || typeof raw.baseUrl !== "string") throw new Error(`There is no provider "${llm.provider}" with an address any more`);
  return {
    baseUrl: raw.baseUrl,
    // A local server without one still needs something: Understory refuses to start with no key.
    apiKey: providerKey(llm.provider) || "none",
    model: llm.model,
    format: raw.api === "anthropic-messages" ? "anthropic" : "openai",
  };
}

/** How the portal's own container is told from anything else by that name: its label. */
export const LABEL = "pithagoras.addon";
const ours = (labels: Record<string, string> | undefined) =>
  labels?.[LABEL] === "understory" || labels?.["pithagoras.managed"] === "true";

/**
 * `networkMode`: the portal's own network — the host's, or the portal
 * container's where it runs in one — so each reaches the other on loopback.
 */
export function spec(cfg: UnderstoryConfig, auth: string, networkMode = "host") {
  const llm = llmEnv(cfg.llm);
  return {
    Image: IMAGE,
    Env: [
      "BUNDLE_ROOT=/bundle",
      `PORT=${port()}`,
      `AUTH_TOKEN=${auth}`,
      `LLM_API_BASE_URL=${llm.baseUrl}`,
      `LLM_API_KEY=${llm.apiKey}`,
      `LLM_API_FORMAT=${llm.format}`,
      `LLM_MODEL=${llm.model}`,
      // At a set time the portal starts the pass itself: Understory's timer stays off.
      ...(cfg.dreamInterval && !cfg.dreamAt ? [`DREAM_INTERVAL=${cfg.dreamInterval}`] : []),
    ],
    Labels: { [LABEL]: "understory" },
    HostConfig: {
      NetworkMode: networkMode,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: [`${VOLUME}:/bundle`],
    },
  };
}

let pulling: PullState = { active: false, line: "" };

/** The container by that name: whether it is there, running, and the portal's own. */
async function inspect(): Promise<{ exists: boolean; running: boolean; ours: boolean }> {
  const { status, body } = await request<{ State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> } }>(
    "GET",
    `/containers/${CONTAINER}/json`,
  );
  if (status !== 200) return { exists: false, running: false, ours: false };
  return { exists: true, running: Boolean(body?.State?.Running), ours: ours(body?.Config?.Labels) };
}

/** Whether the portal's own Understory is running: what a script may be run in. */
export async function runningHere(): Promise<boolean> {
  if (!dockerAvailable()) return false;
  const c = await inspect();
  return c.ours && c.running;
}

export async function status() {
  if (!dockerAvailable()) return { available: false, image: false, container: "absent" as const, pulling };
  // A socket there but not usable — no permission, no daemon — is no Docker, not a failure of the page.
  const [image, c] = await Promise.all([imagePresent(IMAGE), inspect()]).catch(
    () => [false, { exists: false, running: false, ours: false }] as const,
  );
  if (!c.exists && !image && !(await request("GET", "/_ping").then((r) => r.status === 200, () => false))) {
    return { available: false, image: false, container: "absent" as const, pulling };
  }
  return {
    available: true,
    image,
    // "foreign": one by that name that is not the portal's, which it leaves alone.
    container: (!c.exists ? "absent" : !c.ours ? "foreign" : c.running ? "running" : "stopped") as "absent" | "stopped" | "running" | "foreign",
    pulling,
  };
}

/** Whether the portal runs Understory: its own container is there. */
export async function installed(): Promise<boolean> {
  if (!dockerAvailable()) return false;
  const c = await inspect();
  return c.exists && c.ours;
}

/** Refuses to touch a container by that name that the portal did not make. */
async function onlyOurs(): Promise<{ exists: boolean; running: boolean }> {
  const c = await inspect();
  if (c.exists && !c.ours) {
    throw Object.assign(new Error(`A container named ${CONTAINER} is there that the portal did not make; rename or remove it first`), { status: 409 });
  }
  return c;
}

/**
 * Pulls the image if it is not there, and makes the container anew with what
 * is saved — once nothing runs in it. `start: false` leaves it made and
 * stopped, as a stopped one was.
 */
export const install = ({ start = true }: { start?: boolean } = {}): Promise<void> => exclusive(() => installNow(start), WAIT_MS);
export const start = (): Promise<void> => exclusive(startNow, WAIT_MS);
export const stop = (): Promise<void> => exclusive(stopNow, WAIT_MS);
export const remove = (): Promise<void> => exclusive(removeNow, WAIT_MS);

async function installNow(start = true): Promise<void> {
  if (!dockerAvailable()) throw new Error("The portal cannot reach Docker here, so it cannot run Understory");
  const cfg = config();
  const made = spec(cfg, token(), await sharedNetworkMode());
  await ensureImage(IMAGE, (state) => (pulling = state));
  await request("POST", "/volumes/create", { Name: VOLUME });
  if ((await onlyOurs()).exists) await removeNow();
  const created = await request<{ message?: string }>("POST", `/containers/create?name=${CONTAINER}`, made);
  if (created.status >= 400) throw new Error(created.body?.message || `Create failed (${created.status})`);
  if (start) await startNow();
}

async function startNow(): Promise<void> {
  await onlyOurs();
  await containerAction(CONTAINER, "start");
}

async function stopNow(): Promise<void> {
  await onlyOurs();
  await containerAction(CONTAINER, "stop");
}

/** Removes the container. The memory is in its volume, and stays. */
async function removeNow(): Promise<void> {
  if (!(await onlyOurs()).exists) return;
  await containerAction(CONTAINER, "remove");
}

/** Forgets the memory as well. Separate on purpose, and not undoable. */
export const forgetMemory = (): Promise<void> => exclusive(forgetNow, WAIT_MS);

async function forgetNow(): Promise<void> {
  await removeNow();
  const res = await request<{ message?: string }>("DELETE", `/volumes/${VOLUME}`);
  if (res.status >= 400 && res.status !== 404) throw new Error(res.body?.message || `Could not remove the memory (${res.status})`);
}

// --- tidying up at a set time ---

/** What the last pass the portal started came to. */
export interface DreamRun {
  at: string;
  ok: boolean;
  /** It found something to do. */
  ran?: boolean;
  /** What it did, or why it did nothing, or what went wrong. */
  said: string;
}

export function lastDream(): DreamRun | null {
  try {
    const raw = getSetting(LAST_DREAM);
    return raw ? (JSON.parse(raw) as DreamRun) : null;
  } catch {
    return null;
  }
}

/** In every script the portal runs there, so one given up on can be found and ended. */
const MARK = "pithagoras-portal-run";

/**
 * Code run inside Understory's container, with its own library, settings and
 * bundle — Understory has no API that writes, and none that tidies up on
 * demand, but its library does both, keeping index.md and log.md right as it
 * goes. Its input is handed over base64'd in the environment; it prints what
 * it came to, as JSON, as its last line.
 */
function script(body: string): string {
  return `/* ${MARK} */ (async () => {
  const m = await import("@understory/core");
  const kb = new m.KnowledgeBase(process.env.BUNDLE_ROOT, { gitAutocommit: process.env.GIT_AUTOCOMMIT === "true" });
  const input = process.env.PORTAL_INPUT ? JSON.parse(Buffer.from(process.env.PORTAL_INPUT, "base64").toString("utf8")) : {};
  const health = async () => {
    const lint = await kb.lint();
    const valid = await kb.validate();
    return { healthy: lint.healthy && valid.conformant, orphans: lint.orphans, brokenLinks: lint.brokenLinks, issues: valid.issues };
  };
  ${body}
})().catch((e) => { console.log(JSON.stringify({ error: String(e?.message ?? e) })); process.exit(1); });`;
}

const SCRIPTS = {
  // Understory's own pass — but not over an empty memory, where it would still
  // reflect on the log of what was deleted, at the model's cost.
  dream: script(`const lint = await kb.lint();
  if (lint.conceptCount === 0) { console.log(JSON.stringify({ ran: false, reason: "The memory is empty: nothing to tidy up" })); return; }
  console.log(JSON.stringify(await m.runDream(kb)));`),
  // What memory_maintain does: the model mends links to nothing and wires in
  // notes nothing links to — and is not asked at all when there are none.
  repair: script(`const lint = await kb.lint();
  if (lint.healthy) { console.log(JSON.stringify({ ran: false, reason: "Nothing to repair", health: await health() })); return; }
  const orphans = lint.orphans.map((o) => "- " + o.path + (o.title ? " (" + o.title + ")" : "")).join("\\n") || "(none)";
  const broken = lint.brokenLinks.map((b) => "- " + b.path + " → " + b.target + " (missing)").join("\\n") || "(none)";
  const instruction = "Repair the knowledge graph. This is a maintenance task — use the write tools.\\n\\n" +
    "ORPHANED CONCEPTS (no other concept links to them). For each, read it and the concepts it relates to, then wire it in: " +
    "patch a genuinely related concept to reference it, and/or add outbound links from it to related concepts. Do NOT invent " +
    "relationships that don't exist — if an orphan genuinely relates to nothing, leave it.\\n" + orphans + "\\n\\n" +
    "BROKEN LINKS (target does not exist). Fix the path if the target was renamed/moved, or remove the link if the target is gone.\\n" +
    broken + "\\n\\nFollow the enrich / link-both-ways rules. Read concepts before editing.";
  const outcome = await m.runMutation(kb, instruction);
  if (outcome && outcome.ok === false) throw new Error(String(outcome.error ?? "the repair failed"));
  const result = outcome?.result ?? outcome;
  console.log(JSON.stringify({ ran: true, summary: result.summary ?? "", filesChanged: result.filesChanged ?? [], health: await health() }));`),
  health: script(`console.log(JSON.stringify({ health: await health() }));`),
  save: script(`const concept = await kb.writeConcept(input.path, input.frontmatter, input.body, input.summary);
  console.log(JSON.stringify({ concept, health: await health() }));`),
  delete: script(`await kb.deleteConcept(input.path, input.summary);
  console.log(JSON.stringify({ health: await health() }));`),
  // The record of what changed, and the paths Understory's queries took,
  // started over: the notes stay. log.md keeps its heading, as Understory
  // writes a new one; it only ever appends to it.
  clearLog: script(`const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.writeFile(path.join(process.env.BUNDLE_ROOT, "log.md"), "# Directory Update Log\\n");
  await fs.rm(path.join(process.env.BUNDLE_ROOT, ".traces"), { recursive: true, force: true });
  console.log(JSON.stringify({ health: await health() }));`),
  // The memory from nothing: every note and folder gone, with the query
  // paths; the root index and the log as a new bundle has them. Its git
  // history, if it keeps one, stays.
  wipe: script(`const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = process.env.BUNDLE_ROOT;
  for (const name of await fs.readdir(root)) {
    if (name === "index.md" || name === "log.md" || name === ".git") continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
  await fs.writeFile(path.join(root, "log.md"), "# Directory Update Log\\n");
  await m.regenerateIndex(kb.bundle);
  console.log(JSON.stringify({ health: await health() }));`),
  // Every folder's index.md written anew, deepest first, after the empty ones
  // are gone: what Understory does for one folder after each change, for all.
  reindex: script(`const pruned = await m.pruneEmptyDirs(kb.bundle);
  const dirs = [];
  const walk = (n) => { if (n.kind === "directory") { dirs.push(n.path); (n.children ?? []).forEach(walk); } };
  walk(await kb.listTree());
  for (const dir of dirs.sort((a, b) => b.length - a.length)) await m.regenerateIndex(kb.bundle, dir === "/" ? undefined : dir);
  console.log(JSON.stringify({ pruned, reindexed: dirs.length, health: await health() }));`),
} as const;

/** The report a run printed last, from all it printed. */
export function readReport(output: string): Record<string, any> | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Not the report; look further up.
    }
  }
  return null;
}

/**
 * The runs Understory's model is part of — minutes, as long as the model
 * needs — and how long any run may take before it is given up on. A run given
 * up on may still be going in the container; the ones after it go ahead.
 */
const MODEL_RUNS = new Set<keyof typeof SCRIPTS>(["dream", "repair"]);
const RUN_MS = 60_000;
const MODEL_RUN_MS = 30 * 60_000;
/** How long a change waits for the run before it, before it says Understory is busy. */
export const WAIT_MS = 15_000;

/**
 * The largest input a run can be given: it travels as one variable of the
 * environment, and Linux takes at most 128 KiB for one (MAX_ARG_STRLEN), its
 * name and its end included — measured as it goes, UTF-8 and base64.
 */
const ENV_MAX = 131_072;
const envOf = (input: unknown) => `PORTAL_INPUT=${Buffer.from(JSON.stringify(input), "utf8").toString("base64")}`;
export const fitsInEnv = (input: unknown): boolean => Buffer.byteLength(envOf(input)) + 1 <= ENV_MAX;

const refused = (message: string, status: number) => Object.assign(new Error(message), { status });

/** Runs one of the scripts in the container and reads what it said. */
async function exec(name: keyof typeof SCRIPTS, input: unknown, timeoutMs: number): Promise<Record<string, any>> {
  if (!(await runningHere())) throw new Error("Understory is not running");
  const made = await request<{ Id?: string; message?: string }>("POST", `/containers/${CONTAINER}/exec`, {
    Cmd: ["node", "-e", SCRIPTS[name]],
    WorkingDir: "/app/server",
    Env: input === undefined ? [] : [envOf(input)],
    AttachStdout: true,
    AttachStderr: true,
    // A terminal: its output comes back as it was printed, not in Docker's framed stream.
    Tty: true,
  });
  if (made.status >= 400 || !made.body?.Id) throw new Error(made.body?.message || `Could not reach Understory (${made.status})`);
  const out = await request<unknown>("POST", `/exec/${made.body.Id}/start`, { Detach: false, Tty: true }, timeoutMs).catch(async (e) => {
    if ((e as { code?: string }).code !== "ETIMEDOUT") throw e;
    // Given up on here, and ended there too: left, it would go on writing
    // while the next run in the queue writes as well.
    await endRuns().catch(() => {});
    throw new Error("Understory did not finish in time");
  });
  const report = readReport(typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? ""));
  if (!report) throw new Error("Understory ended without saying what it did");
  if (report.error) throw new Error(report.error);
  return report;
}

/** Ends whatever script of the portal's still runs in the container. */
async function endRuns(): Promise<void> {
  const made = await request<{ Id?: string }>("POST", `/containers/${CONTAINER}/exec`, {
    Cmd: ["pkill", "-f", MARK],
    AttachStdout: true,
    AttachStderr: true,
  });
  if (made.body?.Id) await request("POST", `/exec/${made.body.Id}/start`, { Detach: false }, 10_000);
}

// Changes one at a time: two writers in the bundle at once would each rewrite
// the index the other just wrote, and the container made again or removed
// under a run leaves it half written. Reading what the memory looks like is
// not one, and goes beside them.
let tail: Promise<unknown> = Promise.resolve();

/**
 * `fn` once whatever runs in or on Understory before it is done. `waitMs`:
 * given up on, saying Understory is busy, when its turn has not come by then
 * — for what someone is waiting on; a pass of the model waits as long as it takes.
 */
function exclusive<T>(fn: () => Promise<T>, waitMs?: number): Promise<T> {
  let started = false;
  let gaveUp = false;
  const mine = tail.then(() => {
    if (gaveUp) return undefined as T;
    started = true;
    return fn();
  });
  tail = mine.catch(() => {});
  if (waitMs === undefined) return mine;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      if (started) return;
      gaveUp = true;
      reject(refused("Understory is busy with a pass of the model; try again once it is done", 409));
    }, waitMs);
    mine.then(
      (v) => {
        clearTimeout(t);
        if (!gaveUp) resolve(v);
      },
      (e) => {
        clearTimeout(t);
        if (!gaveUp) reject(e);
      },
    );
  });
}

/** Runs one of the scripts in the container, after the change before it. */
function run(name: keyof typeof SCRIPTS, input?: unknown): Promise<Record<string, any>> {
  if (input !== undefined && !fitsInEnv(input)) return Promise.reject(refused("Too much to hand Understory at once", 400));
  const model = MODEL_RUNS.has(name);
  const limit = model ? MODEL_RUN_MS : RUN_MS;
  if (name === "health") return exec(name, input, limit);
  return exclusive(() => exec(name, input, limit), model ? undefined : WAIT_MS);
}

/** What `lint` and `validate` say about the bundle: what a change may have left behind. */
export interface Health {
  healthy: boolean;
  orphans: { path: string; title?: string }[];
  brokenLinks: { path: string; target: string }[];
  issues: { path: string; severity: string; message: string }[];
}

export async function noteHealth(): Promise<Health> {
  return (await run("health")).health;
}

/** A note written by hand, through Understory's own write path: its index and log follow. */
export async function saveNote(path: string, frontmatter: Record<string, unknown>, body: string): Promise<{ concept: unknown; health: Health }> {
  const r = await run("save", { path, frontmatter, body, summary: `Edited [${frontmatter.title ?? path}](${path}) by hand in the portal.` });
  return { concept: r.concept, health: r.health };
}

export async function deleteNote(path: string): Promise<{ health: Health }> {
  const r = await run("delete", { path, summary: `Deleted ${path} by hand in the portal.` });
  return { health: r.health };
}

/** Links to nothing mended and orphans wired in, by the model — only when there are any. */
export async function repair(): Promise<{ ran: boolean; reason?: string; summary?: string; filesChanged?: string[]; health: Health }> {
  const r = await run("repair");
  return { ran: r.ran === true, reason: r.reason, summary: r.summary, filesChanged: r.filesChanged, health: r.health };
}

/**
 * Clears the whole memory, and starts Understory again: what it holds in its
 * own process — the notes it recalls, its answers kept, the overview it gives
 * a new session — is of the memory that is gone.
 */
export function wipe(): Promise<{ health: Health }> {
  return exclusive(async () => {
    const r = await exec("wipe", undefined, RUN_MS);
    const res = await request<{ message?: string }>("POST", `/containers/${CONTAINER}/restart?t=5`);
    if (res.status >= 400) throw new Error(res.body?.message || `Understory could not be started again (${res.status})`);
    // Answered once it answers again: the page reads the memory straight after.
    await untilAnswering();
    return { health: r.health };
  }, WAIT_MS);
}

/** Waits, a little at a time, until Understory answers after a start; half a minute at most. */
async function untilAnswering(): Promise<void> {
  const origin = new URL(managedUrl()).origin;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${origin}/api/validate`, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Empties the log and the query paths; the notes stay. */
export async function clearLog(): Promise<{ health: Health }> {
  const r = await run("clearLog");
  return { health: r.health };
}

/** A model's summary as one plain line: its first sentence, without the markdown. */
export function firstLine(summary: string | undefined, most = 160): string {
  const plain = String(summary ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = plain.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? plain;
  return sentence.length > most ? `${sentence.slice(0, most - 1)}…` : sentence;
}

/** Every index.md written anew, and folders left empty removed. No model involved. */
export async function reindex(): Promise<{ pruned: string[]; reindexed: number; health: Health }> {
  const r = await run("reindex");
  return { pruned: r.pruned ?? [], reindexed: r.reindexed ?? 0, health: r.health };
}

let dreaming = false;
export const isDreaming = () => dreaming;

/** Tidies the memory up now, and keeps what came of it. */
export async function dreamNow(): Promise<DreamRun> {
  if (dreaming) throw new Error("It is tidying up already");
  // Taken before anything is waited for: a second ask in the same moment finds it taken.
  dreaming = true;
  let result: DreamRun;
  try {
    if (!(await runningHere())) throw new Error("Understory is not running");
    const report = await run("dream");
    result = {
      at: new Date().toISOString(),
      ok: true,
      ran: report.ran === true,
      said: report.ran
        ? `${report.filesChanged?.length ?? 0} ${report.filesChanged?.length === 1 ? "file" : "files"} changed${report.summary ? ` — ${firstLine(report.summary)}` : ""}`
        : report.reason || "Nothing to do",
    };
  } catch (e) {
    result = { at: new Date().toISOString(), ok: false, said: (e as Error).message };
  } finally {
    dreaming = false;
  }
  put(LAST_DREAM, JSON.stringify(result));
  return result;
}

/** The next time `at` ("HH:MM") comes round after `from`, in the portal's time zone. */
export function nextAt(at: string, from = new Date()): Date {
  const [h, m] = at.split(":").map(Number);
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}

let timer: NodeJS.Timeout | undefined;
let nextDream: Date | undefined;
export const nextDreamAt = () => nextDream;

/**
 * The pass at the set time, once a day, while the portal runs Understory.
 * Set anew whenever the settings are saved, and when the portal starts.
 */
export function scheduleDreams(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  nextDream = undefined;
  const { dreamAt } = config();
  if (!dreamAt) return;
  nextDream = nextAt(dreamAt);
  timer = setTimeout(async () => {
    try {
      if (await runningHere()) await dreamNow();
    } catch (e) {
      console.error(`[portal] tidying the memory up failed: ${(e as Error).message}`);
    }
    scheduleDreams();
  }, nextDream.getTime() - Date.now());
  // Never what keeps the portal running.
  timer.unref();
}
