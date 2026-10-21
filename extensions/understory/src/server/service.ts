import { randomBytes } from "node:crypto";
import type { ContainerInfo, PullState } from "../../../docker/src/api";
import { docker, portal } from "./host";
import { modelServer } from "./llm";
import { putSettings, setting } from "./store";

/**
 * Understory, run by the portal: installed from Settings → Memory, so the
 * model that keeps the memory and how often it tidies up can be chosen there.
 * Docker runs its container (`pithagoras-docker`, which Understory requires).
 *
 * Understory reads all of that from its environment, once, when it starts —
 * its own settings page only shows it. So a change is saved here and the
 * container made again with it; the memory is in a volume and stays.
 *
 * It shares the portal's loopback (`sharedNetwork`): a model server the
 * portal reaches on localhost is reached the same way from there, and so is
 * the one of this half (llm.ts). Understory listens on every interface, so it
 * gets a token of its own, which only the portal holds — the agent's MCP entry
 * and the Memory page are its only callers.
 *
 * The container and the volume the portal made before Understory was an
 * extension carry no extension's name, and are taken over by their names
 * (`settleKept`, and again before Understory acts on them).
 */

export const IMAGE = "ghcr.io/thecodacus/understory:latest";
export const CONTAINER = "pithagoras-understory";
export const VOLUME = process.env.UNDERSTORY_VOLUME || "pithagoras_understory-memory";
export const port = (): number => Number(process.env.UNDERSTORY_PORT) || 3800;
export const managedUrl = (): string => `http://127.0.0.1:${port()}/mcp`;

export type LlmFormat = "openai" | "anthropic";

/**
 * Where the model that keeps the memory comes from: the chat's (the one the
 * chat asking is on — see llm.ts), a provider set up here, or an address of
 * its own.
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
  const saved = setting("config");
  const raw = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  return {
    // Nothing chosen is the chat's: the model already loaded, which asks nothing of anyone.
    llm: raw.llm && typeof raw.llm === "object" ? (raw.llm as LlmChoice) : { source: "auto" },
    dreamInterval: typeof raw.dreamInterval === "string" && validInterval(raw.dreamInterval) ? raw.dreamInterval : "",
    dreamAt: typeof raw.dreamAt === "string" && validTime(raw.dreamAt) ? raw.dreamAt : "",
  };
}

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
  putSettings({ config: { llm, dreamInterval: next.dreamAt ? "" : next.dreamInterval, dreamAt: next.dreamAt } });
  scheduleDreams();
  return config();
}

/** What is saved, as it is stored: nothing where nothing was said, to be put back as it was (`restoreConfig`). */
export const savedConfig = (): unknown => setting("config");

/** Puts back what was saved before (`savedConfig`), key and all, as it was. */
export function restoreConfig(before: unknown): void {
  putSettings({ config: before });
  scheduleDreams();
}

function secret(key: "token" | "llmToken"): string {
  const had = setting(key);
  if (had) return had;
  const made = randomBytes(24).toString("hex");
  putSettings({ [key]: made });
  return made;
}

/** The token the container is given and the portal calls it with; made once. Asked through `heldToken`. */
export const token = (): string => secret("token");

/**
 * The token for a container about to be made, or for the agent's entry to call it with (`token`) — but not while
 * the container there is the portal's own from before Understory was an extension, and what the portal kept of it has
 * not been taken up (handoff.ts): one made then is not the one that container and the agent's entry carry, and the
 * one kept would not be taken up after it.
 */
export async function heldToken(): Promise<string> {
  if (setting("token") === undefined && (await installed())) {
    throw refused(
      "What the portal kept of Understory, with the token its container was made with, has not been taken up yet, and until it is the container is left as it is: Understory takes it up as it starts, and the portal's log says why it could not",
      409,
    );
  }
  return token();
}

/** The key Understory calls the model server with, in "the chat's" mode; made once. */
export const llmToken = (): string => secret("llmToken");

/** Where Understory reaches the model server of this half: on the loopback it shares with the portal. */
const modelServerUrl = (): string => `http://127.0.0.1:${modelServer().port}/v1`;

/** Why Understory cannot reach the chat's model now, where it cannot: the model server could not take its port. */
function modelServerMissing(): string | undefined {
  const { listening, port: at } = modelServer();
  return listening ? undefined : `Understory's model server could not listen on 127.0.0.1:${at}; set UNDERSTORY_LLM_PORT to a port that is free, or give Understory a model of its own`;
}

/** What Understory is told about its model: the provider's address and key, looked up when the container is made. */
export async function llmEnv(llm: LlmChoice): Promise<{ baseUrl: string; apiKey: string; model: string; format: LlmFormat }> {
  if (llm.source === "auto") {
    const missing = modelServerMissing();
    if (missing) throw new Error(missing);
    return { baseUrl: modelServerUrl(), apiKey: llmToken(), model: "auto", format: "openai" };
  }
  if (llm.source === "custom") return { baseUrl: llm.baseUrl, apiKey: llm.apiKey || "none", model: llm.model, format: llm.format };
  const { models } = portal();
  if (!models.list().some((p) => p.provider === llm.provider && p.baseUrl !== undefined)) throw new Error(`There is no provider "${llm.provider}" with an address any more`);
  const endpoint = await models.endpoint(llm.provider, llm.model);
  // A command (`!…`) is pi's to run, not ours to hand a container: what it gave this time outlives the request there.
  if (endpoint.keyFromCommand) throw new Error("That provider's key is a command pi runs; give Understory an address and key of its own instead");
  return {
    baseUrl: endpoint.baseUrl,
    // A local server without one still needs something: Understory refuses to start with no key.
    apiKey: endpoint.key || "none",
    model: llm.model,
    format: endpoint.api === "anthropic-messages" ? "anthropic" : "openai",
  };
}

/** How a container the portal made before Understory was an extension is told from anything else by that name: its label. */
export const LABEL = "pithagoras.addon";
const portalMade = (labels: Record<string, string>) => labels[LABEL] === "understory" || labels["pithagoras.managed"] === "true";

/**
 * `networkMode`: the portal's own network — the host's, or the portal
 * container's where it runs in one — so each reaches the other on loopback.
 * The label stays as the portal wrote it, so a portal that goes back to an
 * older version still knows the container (Docker adds Understory's name).
 */
export async function spec(cfg: UnderstoryConfig, auth: string, networkMode = "host") {
  const llm = await llmEnv(cfg.llm);
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

/** The container by that name as the page sees it: none, Understory's (running or not), or one that is not, which it leaves alone. */
type Kind = "absent" | "stopped" | "running" | "foreign";
function kindOf(found: ContainerInfo | undefined): Kind {
  if (!found) return "absent";
  // The portal's own from before, not taken over yet, is Understory's all the same.
  if (found.owner !== portal().extension && (found.owner || !portalMade(found.labels))) return "foreign";
  return found.state === "running" ? "running" : "stopped";
}

const foreign = () => Object.assign(new Error(`A container named ${CONTAINER} is there that the portal did not make; rename or remove it first`), { status: 409 });

/** Docker's answer that there is no such container or volume, which is no failure where nothing has to be there. */
function absent(e: unknown): void {
  if ((e as { status?: number }).status !== 404) throw e;
}

/**
 * The container, where it is Understory's: one the portal made before Understory was an extension is taken over first,
 * and one by that name that is not is refused, and left alone.
 */
async function ours(): Promise<ContainerInfo | undefined> {
  const d = docker();
  const found = await d.containers.get(CONTAINER);
  if (kindOf(found) === "foreign") throw foreign();
  if (!found || found.owner === portal().extension) return found;
  return d.containers.adopt(CONTAINER);
}

/** Whether Understory's container is running: what a script may be run in. */
export async function runningHere(): Promise<boolean> {
  if (!(await docker().available())) return false;
  const found = await ours().catch((e) => {
    if ((e as { status?: number }).status !== 409) throw e;
    return undefined;
  });
  return found?.state === "running";
}

export async function status() {
  const d = docker();
  if (!(await d.available())) return { available: false, image: false, container: "absent" as Kind, pulling };
  const [image, found] = await Promise.all([d.images.present(IMAGE), d.containers.get(CONTAINER)]);
  return { available: true, image, container: kindOf(found), pulling };
}

/** Whether the portal runs Understory: its container is there. */
export async function installed(): Promise<boolean> {
  const d = docker();
  if (!(await d.available())) return false;
  return ["running", "stopped"].includes(kindOf(await d.containers.get(CONTAINER)));
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
  const d = docker();
  if (!(await d.available())) throw new Error("The portal cannot reach Docker here, so it cannot run Understory");
  // Worked out first: a choice it cannot be made with leaves the container as it is.
  const made = await spec(config(), await heldToken(), await d.sharedNetwork());
  await d.images.ensure(IMAGE, (state) => (pulling = state));
  // The volume the portal made before Understory was an extension is taken over; one there is none of is made.
  await d.volumes.adopt(VOLUME).catch(absent);
  await d.volumes.create(VOLUME);
  // Made again in place of the one there: Docker replaces only what is Understory's.
  await ours();
  await d.containers.create(CONTAINER, made);
  if (start) await d.containers.start(CONTAINER);
}

async function startNow(): Promise<void> {
  const unheard = mustNotRun();
  if (unheard) throw new Error(unheard);
  await ours();
  await docker().containers.start(CONTAINER);
}

async function stopNow(): Promise<void> {
  await ours();
  await docker().containers.stop(CONTAINER);
}

/** Removes the container. The memory is in its volume, and stays. */
async function removeNow(): Promise<void> {
  await ours();
  await docker().containers.remove(CONTAINER);
}

/** Forgets the memory as well. Separate on purpose, and not undoable. */
export const forgetMemory = (): Promise<void> => exclusive(forgetNow, WAIT_MS);

async function forgetNow(): Promise<void> {
  await removeNow();
  // Taken over first, as the container is; one that is gone already is gone.
  await docker().volumes.adopt(VOLUME).catch(absent);
  await docker().volumes.remove(VOLUME);
}

/** Of Docker's inspect body, what is read here. */
type Inspected = { Config?: { Env?: string[] | null }; HostConfig?: { NetworkMode?: string } };

/**
 * Whether the container was made for what is there no more: in "the chat's" mode, for another address of the model
 * server than its own now — the portal's own model route of before Understory was an extension (`/understory-llm/v1`),
 * or a port `UNDERSTORY_LLM_PORT` no longer says — or for the network of a portal container that has been made again
 * since.
 */
async function stale(): Promise<boolean> {
  const made = (await docker().containers.inspect(CONTAINER)) as Inspected | undefined;
  if (!made) return false;
  const base = made.Config?.Env?.find((line) => line.startsWith("LLM_API_BASE_URL="));
  return (config().llm.source === "auto" && base !== `LLM_API_BASE_URL=${modelServerUrl()}`) || made.HostConfig?.NetworkMode !== (await docker().sharedNetwork());
}

/**
 * Why Understory must not run now, where it must not: it thinks with the chat's model, and the model server could not
 * take its port, so what it sends there — the conversation, and its key — would go to whatever holds that port. Not
 * said of the portal's own container from before Understory was an extension while what the portal kept has not been
 * taken up (`heldToken`): which model that one was made with is not known here until then.
 */
function mustNotRun(): string | undefined {
  if (setting("token") === undefined || config().llm.source !== "auto") return undefined;
  return modelServerMissing();
}

/** The container stopped where it must not run (`mustNotRun`), which the log says. */
async function halt(why: string): Promise<void> {
  await docker().containers.stop(CONTAINER);
  portal().log(`${CONTAINER} is stopped, as what it sends the chat's model would go to whatever holds that port: ${why}`);
}

/**
 * The container made again with what is saved, and started if it was running: its memory is in the volume, and its
 * token stays (`heldToken`). What it cannot be made with is said in the log, and it is left as it is.
 */
async function remake(running: boolean): Promise<void> {
  await installNow(running).then(
    () => portal().log(`${CONTAINER} was made again with its settings, its memory and its token kept`),
    (e) => portal().log(`${CONTAINER} could not be made again with its settings, and is left as it is: ${(e as Error).message}`),
  );
}

/**
 * Takes over the volume and the container the portal made before Understory was an extension, by their names, as the
 * half starts: the first in the queue, so no change runs before it. Then, where the container runs, stops it where it
 * must not run (`mustNotRun`), or else ends what of the portal's still runs in it (a run left going when the portal or
 * this half last stopped), and makes it again once where it was made for what is there no more (`stale`). One that is
 * not there is not taken over, and one that is another's is not Understory's to take, which the portal's log says.
 */
export function settleKept(): Promise<void> {
  return exclusive(async () => {
    const d = docker();
    if (!(await d.available())) return;
    await d.volumes.adopt(VOLUME).catch((e) => {
      if ((e as { status?: number }).status !== 404) portal().log(`could not take over the memory, the volume ${VOLUME}: ${(e as Error).message}`);
    });
    const found = await ours().catch((e) => {
      if ((e as { status?: number }).status !== 409) throw e;
      portal().log(`${CONTAINER} is not Understory's, and is left alone`);
      return undefined;
    });
    if (!found) return;
    const running = found.state === "running";
    const unheard = mustNotRun();
    if (running && unheard) return halt(unheard);
    if (running) await endRuns();
    if (await stale()) await remake(running);
  });
}

/**
 * Made again where the portal's own container was made again since, while it runs, and stopped where it must not run,
 * however it was started: asked every half minute, and not again while one asked is still waiting its turn (a pass of
 * the model holds the queue for as long as it takes).
 */
let looking = false;
export function lookAfter(): void {
  if (looking) return;
  looking = true;
  void exclusive(async () => {
    const d = docker();
    if (!(await d.available()) || kindOf(await d.containers.get(CONTAINER)) !== "running") return;
    await ours();
    const unheard = mustNotRun();
    if (unheard) return halt(unheard);
    if (await stale()) await remake(true);
  })
    .catch((e) => portal().log(`could not look after ${CONTAINER}: ${(e as Error).message}`))
    .finally(() => (looking = false));
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
  return (setting("lastDream") as DreamRun | undefined) ?? null;
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
/** Replaceable, so that a test need not wait a minute for a run to be given up on. */
export const runLimits = { run: 60_000, model: 30 * 60_000 };
/** How long a change waits for the run before it, before it says Understory is busy. */
export const WAIT_MS = 15_000;

/**
 * The largest input a run can be given: it travels as one variable of the
 * environment, and Linux takes at most 128 KiB for one (MAX_ARG_STRLEN), its
 * name and its end included — measured as it goes, UTF-8 and base64.
 */
const ENV_MAX = 131_072;
const encoded = (input: unknown) => Buffer.from(JSON.stringify(input), "utf8").toString("base64");
export const fitsInEnv = (input: unknown): boolean => Buffer.byteLength(`PORTAL_INPUT=${encoded(input)}`) + 1 <= ENV_MAX;

const refused = (message: string, status: number) => Object.assign(new Error(message), { status });

/** Runs one of the scripts in the container and reads what it said. */
async function exec(name: keyof typeof SCRIPTS, input: unknown, timeoutMs: number): Promise<Record<string, any>> {
  if (!(await runningHere())) throw new Error("Understory is not running");
  const ran = await docker().containers.exec(CONTAINER, ["node", "-e", SCRIPTS[name]], {
    env: input === undefined ? {} : { PORTAL_INPUT: encoded(input) },
    workingDir: "/app/server",
    // A terminal: its output comes back as it was printed, not in Docker's framed stream.
    tty: true,
    timeoutMs,
  });
  if (ran.timedOut) {
    // Given up on here, and ended there too: left, it would go on writing
    // while the next run in the queue writes as well.
    await endRuns().catch(() => {});
    throw new Error("Understory did not finish in time");
  }
  const report = readReport(ran.output);
  if (!report) throw new Error("Understory ended without saying what it did");
  if (report.error) throw new Error(report.error);
  return report;
}

/** Ends whatever script of the portal's still runs in the container. */
async function endRuns(): Promise<void> {
  await docker().containers.exec(CONTAINER, ["pkill", "-f", MARK], { timeoutMs: 10_000 });
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
  const limit = model ? runLimits.model : runLimits.run;
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
    const r = await exec("wipe", undefined, runLimits.run);
    await docker().containers.stop(CONTAINER);
    await docker().containers.start(CONTAINER);
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
      // The token held, never one made here, which no container would have (`heldToken`).
      const r = await fetch(`${origin}/api/validate`, { headers: { authorization: `Bearer ${setting("token") ?? ""}` }, signal: AbortSignal.timeout(2000) });
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
  putSettings({ lastDream: result });
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
 * The pass at the set time, once a day, while Understory's server half runs.
 * Set anew whenever the settings are saved, and when the half starts.
 */
export function scheduleDreams(): void {
  stopDreams();
  const { dreamAt } = config();
  if (!dreamAt) return;
  nextDream = nextAt(dreamAt);
  const armed = setTimeout(async () => {
    try {
      if (await runningHere()) await dreamNow();
    } catch (e) {
      portal().log(`tidying the memory up failed: ${(e as Error).message}`);
    }
    // Not where the half stopped meanwhile, or the settings were saved and set it anew.
    if (timer === armed) scheduleDreams();
  }, nextDream.getTime() - Date.now());
  // Never what keeps the portal running.
  armed.unref();
  timer = armed;
}

/** No pass at a set time: as the half stops. */
export function stopDreams(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  nextDream = undefined;
}
