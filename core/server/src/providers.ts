import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { piAgentDir } from "./pi-settings.js";
import { piEntry } from "./pi/package.js";

/**
 * Where models come from, as the Settings → Models page offers them.
 *
 * pi keeps this in two files of its own: `models.json` for servers it reaches
 * by URL (llama.cpp, llama-swap, Ollama, anything OpenAI-compatible), and
 * `auth.json` for the keys of services whose catalogue it already ships
 * (OpenRouter, Anthropic, OpenAI …). The portal writes both the way pi reads
 * them, so what is set up here also works for pi on the command line, and a
 * file edited by hand keeps whatever the forms know nothing about.
 */
export const modelsJsonPath = () => path.join(piAgentDir(), "models.json");
export const authJsonPath = () => path.join(piAgentDir(), "auth.json");
/**
 * What kind each server set up here is — llama-swap, Ollama — which pi has no
 * field for. Beside pi's files rather than in models.json, which pi checks
 * against its own schema; a server not in it is told by its name.
 */
export const kindsJsonPath = () => path.join(piAgentDir(), "portal-providers.json");

/** What a provider is, as the page offers them — not a field pi knows about. */
export type ProviderKind = "llama-cpp" | "llama-swap" | "ollama" | "openrouter" | "hosted" | "custom";

export interface Preset {
  kind: ProviderKind;
  label: string;
  description: string;
  /** The name it is filed under, unless the person picks another. */
  id: string;
  /** A server the portal reaches by URL and asks for its models. */
  endpoint: boolean;
  baseUrl?: string;
  /** Whether it takes a key: local servers mostly do not. */
  key: "none" | "optional" | "required";
  /** pi only lists a model whose provider has a key, so a keyless server is given this one. */
  placeholderKey?: string;
  compat?: Record<string, unknown>;
}

export const PRESETS: Preset[] = [
  {
    kind: "llama-cpp", label: "llama.cpp", id: "llama-server", endpoint: true, key: "optional", placeholderKey: "none",
    baseUrl: "http://127.0.0.1:8080/v1",
    description: "A llama-server on this machine or the network. Shows how far it is through a long prompt.",
  },
  {
    kind: "llama-swap", label: "llama-swap", id: "llama-swap", endpoint: true, key: "optional", placeholderKey: "none",
    baseUrl: "http://127.0.0.1:8080/v1",
    description: "A llama-swap gateway that starts the right llama-server for each model.",
  },
  {
    kind: "ollama", label: "Ollama", id: "ollama", endpoint: true, key: "none", placeholderKey: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    // Ollama's OpenAI endpoint knows neither the developer role nor reasoning_effort.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    description: "Models pulled with Ollama.",
  },
  {
    kind: "openrouter", label: "OpenRouter", id: "openrouter", endpoint: false, key: "required",
    description: "Hundreds of hosted models behind one key.",
  },
  {
    kind: "hosted", label: "Another hosted service", id: "", endpoint: false, key: "required",
    description: "Anthropic, OpenAI, Google, Mistral, Groq and the other services pi knows — by API key.",
  },
  {
    kind: "custom", label: "Custom endpoint", id: "", endpoint: true, key: "optional", placeholderKey: "none",
    description: "Any server that speaks the OpenAI API — vLLM, LM Studio, a proxy, a gateway.",
  },
];

/** The APIs pi can speak to a server it reaches by URL. */
export const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  [key: string]: unknown;
}

/** How a key is shown: never itself, only enough to tell one from another. */
export interface KeyInfo {
  set: boolean;
  /** "sk-o…3f9a", an environment variable's name, or a command — what it is, not what it holds. */
  hint?: string;
  /** Where pi finds it, when not in the portal's files. */
  source?: string;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  api?: string;
  key: KeyInfo;
  models: ModelEntry[];
  /** Kept in models.json — a server reached by URL. */
  endpoint: boolean;
}

// --- files ---

type Json = Record<string, any>;

/** As pi reads its files: `//` comments and trailing commas allowed, strings left alone (pi's utils/json.js). */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/**
 * A file to change: none yet is empty, but one that is there and cannot be
 * read stops the change. Taken as empty, the next save would write back only
 * what it adds, and every provider or key in the file would be gone.
 */
function readForChange(file: string): Json {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new Error(`${path.basename(file)} could not be read (${(e as Error).message}), so nothing was changed. Put it right by hand, then save again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path.basename(file)} does not hold what pi expects, so nothing was changed.`);
  return parsed as Json;
}

/** A file to show: what cannot be read shows as nothing. */
function readJson(file: string): Json {
  try {
    return readForChange(file);
  } catch {
    return {};
  }
}

/** Through a temp file and a rename, so pi never reads half a file; readable by its owner only, as pi makes them. */
function writeJson(file: string, data: Json) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n", 0o600);
}

/**
 * Write models.json, keeping a copy first when it has comments: pi allows
 * them, but what is written is plain JSON, so a save would drop them. The
 * copy is named for when it was made, beside it — never over an older one.
 * Its name, when one was made.
 */
function writeModelsJson(data: Json): string | undefined {
  const file = modelsJsonPath();
  let backup: string | undefined;
  try {
    const text = readFileSync(file, "utf8");
    if (stripJsonComments(text) !== text) {
      backup = `${path.basename(file)}.before-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
      writeFileSync(path.join(path.dirname(file), backup), text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  writeJson(file, data);
  return backup;
}

/** What a change did besides: the copy kept of a models.json whose comments it dropped. */
export interface Changed {
  backup?: string;
}

let chain: Promise<unknown> = Promise.resolve();
/** One change at a time, so two saves cannot each drop the other's. */
function serial<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = chain.then(fn);
  chain = next.catch(() => {});
  return next;
}

export const readModelsJson = () => readJson(modelsJsonPath());
export const readAuthJson = () => readJson(authJsonPath());

interface Lockfile {
  lock(file: string, options: Json): Promise<() => Promise<void>>;
}
let lockfile: Lockfile | undefined;

/**
 * Change auth.json under pi's own lock. pi changes it under that lock too —
 * a chat refreshing a login, pi on the command line — and a change made
 * beside it would land over the refreshed token and sign the account out.
 * The lock is pi's copy of proper-lockfile, so it is always the one pi takes.
 * `change` says whether it changed anything.
 */
async function changeAuth<T>(change: (auth: Json) => T | false): Promise<T | false> {
  lockfile ??= createRequire(piEntry())("proper-lockfile") as Lockfile;
  const file = authJsonPath();
  mkdirSync(path.dirname(file), { recursive: true });
  // As pi takes it when it waits: a few tries, backing off, and a lock left by a process that died is taken over.
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  });
  try {
    const auth = readForChange(file);
    const result = change(auth);
    if (result !== false) writeJson(file, auth);
    return result;
  } finally {
    await release().catch(() => {});
  }
}

/** When either file last changed, for whoever keeps something built from them. */
export function configStamp(): string {
  return [modelsJsonPath(), authJsonPath()]
    .map((f) => { try { return String(statSync(f).mtimeMs); } catch { return "-"; } })
    .join("|");
}

// --- reading ---

/**
 * What kind of server a models.json entry is, from its name and address —
 * for one written by hand. Always a server: one named after a hosted service,
 * such as "openrouter", is still reached by its address and its own models.
 */
export function inferKind(id: string, baseUrl?: string): ProviderKind {
  if (id === "llama.cpp" || id.startsWith("llama-server") || id.startsWith("llama-cpp")) return "llama-cpp";
  if (id.startsWith("llama-swap")) return "llama-swap";
  if (id.startsWith("ollama") || /:11434(\/|$)/.test(baseUrl ?? "")) return "ollama";
  return "custom";
}

const SERVER_KINDS = new Set<ProviderKind>(["llama-cpp", "llama-swap", "ollama", "custom"]);

/** What kind a server is: as it was saved here, or else as its name says. */
function kindOf(id: string, baseUrl: string | undefined, kinds: Json): ProviderKind {
  const saved = kinds[id];
  return SERVER_KINDS.has(saved) ? saved : inferKind(id, baseUrl);
}

/**
 * Whether a provider is a llama.cpp server, or a llama-swap gateway in front of
 * one: by the kind saved for it in Settings, else by what its name says. What
 * reports the progress of a prompt and what thinking is switched off for
 * go by this, so they agree with the Providers page.
 */
export function isLlamaProvider(id: string | undefined): boolean {
  if (!id) return false;
  const kind = kindOf(id, readModelsJson().providers?.[id]?.baseUrl, readJson(kindsJsonPath()));
  return kind === "llama-cpp" || kind === "llama-swap";
}

/** A key that names an environment variable, as pi reads one: `$NAME` or `${NAME}`. */
const ENV_REF = /^\$\{?([A-Z_][A-Z0-9_]*)\}?$/i;

export function keyHint(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.startsWith("!")) return "from a command";
  const env = ENV_REF.exec(value);
  if (env) return env[1];
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** A key that only exists because pi wants one, not because the server does. */
const isPlaceholder = (key: unknown) => typeof key === "string" && ["none", "ollama", "local", "sk-no-key-required"].includes(key);

/**
 * Everything set up: servers from models.json, and keys from auth.json.
 * `names` gives each hosted service the name pi gives it; `envKeyed` lists the
 * ones pi finds a key for elsewhere — the environment — which are shown too,
 * as set up, since they are.
 */
export function listProviders(names: Record<string, string> = {}, envKeyed: Record<string, string> = {}): ProviderInfo[] {
  const models = readModelsJson().providers ?? {};
  const auth = readAuthJson();
  const kinds = readJson(kindsJsonPath());
  const out: ProviderInfo[] = [];
  for (const [id, raw] of Object.entries<Json>(models)) {
    if (!raw || typeof raw !== "object") continue;
    // Without a list of models it is an override of a built-in service — its
    // address, or a model's details — not a server of its own.
    if (!Array.isArray(raw.models)) continue;
    const kind = kindOf(id, raw.baseUrl, kinds);
    const stored = auth[id]?.type === "api_key" ? auth[id].key : undefined;
    const key = stored ?? raw.apiKey;
    out.push({
      // Its own name: the one it is filed and chosen under.
      id, kind, label: id,
      baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
      api: typeof raw.api === "string" ? raw.api : undefined,
      key: isPlaceholder(key) || !key ? { set: false } : { set: true, hint: keyHint(key) },
      models: Array.isArray(raw.models) ? raw.models.filter((m: Json) => m && typeof m.id === "string") : [],
      endpoint: true,
    });
  }
  const listed = new Set(out.map((p) => p.id));
  for (const [id, cred] of Object.entries<Json>(auth)) {
    if (listed.has(id) || !cred || typeof cred !== "object") continue;
    listed.add(id);
    out.push({
      id, kind: id === "openrouter" ? "openrouter" : "hosted", label: names[id] ?? id, models: [], endpoint: false,
      key: cred.type === "oauth" ? { set: true, hint: "signed in", source: "account" } : { set: true, hint: keyHint(cred.key) },
    });
  }
  for (const [id, source] of Object.entries(envKeyed)) {
    if (listed.has(id)) continue;
    out.push({ id, kind: id === "openrouter" ? "openrouter" : "hosted", label: names[id] ?? id, models: [], endpoint: false, key: { set: true, source } });
  }
  return out;
}

// --- finding a server's models ---

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);

/**
 * The models a server lists at /models, with whatever it says about them.
 *
 * The OpenAI shape is `{ data: [{ id }] }`; the rest is each server's own:
 * OpenRouter's `context_length` and modalities, llama.cpp's `meta`, vLLM's
 * `max_model_len`. What none of them says is left for pi's defaults.
 */
export function parseModels(json: unknown): ModelEntry[] {
  const body = json as Json;
  const list: unknown[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const out: ModelEntry[] = [];
  for (const item of list as Json[]) {
    const id = typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    const entry: ModelEntry = { id };
    if (typeof item === "object") {
      // llama-swap lists each alias as a model of its own, with the name of the model it stands for: every preset
      // behind one llama.cpp router carried the router's name. An alias is known by its own name.
      const alias = item.meta?.llamaswap?.type === "alias";
      if (!alias && typeof item.name === "string" && item.name !== id) entry.name = item.name;
      const ctx = num(item.context_length) ?? num(item.max_model_len) ?? num(item.context_window) ?? num(item.meta?.n_ctx) ?? num(item.meta?.n_ctx_train);
      if (ctx) entry.contextWindow = ctx;
      const modalities = item.architecture?.input_modalities;
      if (Array.isArray(modalities) && modalities.includes("image")) entry.input = ["text", "image"];
      if (Array.isArray(item.supported_parameters) && item.supported_parameters.includes("reasoning")) entry.reasoning = true;
    }
    out.push(entry);
  }
  return out;
}

/** An address as typed — "localhost:8080", a trailing slash — made into the base pi wants. */
export function normalizeBaseUrl(raw: string, kind: ProviderKind): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  // The local servers all serve the OpenAI API under /v1; an address without a path means that.
  if ((kind === "llama-cpp" || kind === "llama-swap" || kind === "ollama") && (parsed.pathname === "/" || parsed.pathname === "")) url += "/v1";
  return url.replace(/\/models$/, "");
}

/** A stored key as pi would read it: `$NAME` and `${NAME}` are looked up in the environment, anything else is the key as it stands, and a command is not run here. */
export function resolveKey(key: string | undefined): string | undefined {
  if (!key || isPlaceholder(key)) return undefined;
  const env = ENV_REF.exec(key);
  if (env) return process.env[env[1]];
  return key.startsWith("!") ? undefined : key;
}

/**
 * A key typed on the page, to send to the address typed beside it: only as
 * it is. Naming a variable or a command is how pi is told where to find a key
 * when it uses it — asked here, it would hand anything in the portal's
 * environment to whatever address was given.
 */
function typedKey(key: string | undefined): string | undefined {
  if (!key || isPlaceholder(key) || ENV_REF.test(key) || key.startsWith("!")) return undefined;
  return key;
}

const sameBase = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

async function getJson(url: string, key: string | undefined, ms = 6000, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(ms),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    if ((e as Error).name === "TimeoutError") throw new ProbeError(`No answer from ${new URL(url).host} within ${ms / 1000} seconds.`);
    throw new ProbeError(cause === "ENOTFOUND" ? `There is no ${new URL(url).hostname} to reach.` : `Nothing answered at ${new URL(url).host} — is the server running, and reachable from here?`);
  }
  if (res.status === 401 || res.status === 403) throw new ProbeError(key ? "The server turned the key down." : "The server wants an API key.", res.status);
  if (!res.ok) throw new ProbeError(`The server answered ${res.status} at ${new URL(url).pathname}.`);
  try {
    return await res.json();
  } catch {
    throw new ProbeError("The server answered, but not with a list of models. Is this the API address?");
  }
}

export class ProbeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * What llama-server itself says about the one model it has loaded: the window
 * each chat really gets (`-c` over `--parallel`), and whether it sees images.
 * Not asked of llama-swap, which answers /props by loading a model.
 */
async function llamaProps(base: string, key?: string): Promise<Partial<ModelEntry>> {
  try {
    const props = (await getJson(base.replace(/\/v1$/, "") + "/props", key, 2500)) as Json;
    const out: Partial<ModelEntry> = {};
    const ctx = num(props?.default_generation_settings?.n_ctx);
    if (ctx) out.contextWindow = ctx;
    if (props?.modalities?.vision) out.input = ["text", "image"];
    return out;
  } catch {
    return {};
  }
}

/** What Ollama knows of a model: its window and whether it sees or thinks. */
async function ollamaShow(base: string, model: string): Promise<Partial<ModelEntry>> {
  try {
    const info = (await getJson(base.replace(/\/v1$/, "") + "/api/show", undefined, 2500, {
      method: "POST", body: JSON.stringify({ model }), headers: { "content-type": "application/json" },
    })) as Json;
    const out: Partial<ModelEntry> = {};
    const ctxKey = Object.keys(info?.model_info ?? {}).find((k) => k.endsWith(".context_length"));
    const ctx = ctxKey ? num(info.model_info[ctxKey]) : undefined;
    if (ctx) out.contextWindow = ctx;
    const caps: unknown = info?.capabilities;
    if (Array.isArray(caps) && caps.includes("vision")) out.input = ["text", "image"];
    if (Array.isArray(caps) && caps.includes("thinking")) out.reasoning = true;
    return out;
  } catch {
    return {};
  }
}

/** A saved server's address and its key, for asking it again. */
export interface Saved {
  baseUrl: string;
  key?: string;
}

/**
 * Ask a server which models it has. `saved` is for a provider being edited:
 * its key never comes back to the page, so the page cannot send it — and it
 * is sent only to the address it was saved with, never to one typed since.
 */
export async function probeModels(kind: ProviderKind, baseUrl: string, key?: string, saved?: Saved): Promise<{ baseUrl: string; models: ModelEntry[] }> {
  const base = normalizeBaseUrl(baseUrl, kind);
  const keyFor = (at: string) => typedKey(key) ?? (saved && sameBase(at, saved.baseUrl) ? resolveKey(saved.key) : undefined);
  const ask = async (at: string) => {
    try {
      return parseModels(await getJson(`${at}/models`, keyFor(at)));
    } catch (e) {
      // Its saved key would have been sent to its saved address, not this one.
      if (e instanceof ProbeError && e.status && !keyFor(at) && resolveKey(saved?.key)) {
        throw new ProbeError("The saved key is only sent to the address it was saved with. Type it again to use it here.", e.status);
      }
      throw e;
    }
  };
  let models: ModelEntry[];
  let at = base;
  try {
    models = await ask(base);
  } catch (e) {
    // A custom address given without its /v1: try once with it before giving up.
    if (kind !== "custom" || /\/v\d+$/.test(base)) throw e;
    at = `${base}/v1`;
    const retried = await ask(at).catch(() => []);
    if (!retried.length) throw e;
    models = retried;
  }
  const auth = keyFor(at);
  if (kind === "llama-cpp") {
    const props = await llamaProps(at, auth);
    // One model per server: what it says of itself belongs to that one.
    if (models.length === 1) models = [{ ...models[0], ...props }];
  }
  // Every model is listed; only the first 40 are looked up one by one.
  if (kind === "ollama") models = await Promise.all(models.map(async (m, i) => (i < 40 ? { ...m, ...(await ollamaShow(at, m.id)) } : m)));
  return { baseUrl: at, models };
}

// --- whether a server answers now ---

export interface ProviderStatus {
  state: "up" | "down";
  /** How long it took to list its models. */
  ms?: number;
  message?: string;
  /** How many models it lists. */
  listed?: number;
  /** Chosen models it no longer lists: picking one would fail. */
  missing?: string[];
  /** What llama-swap has loaded now, when it says. */
  loaded?: string[];
}

/** Which models llama-swap has loaded: its own /running, beside the API. */
async function swapRunning(base: string, key?: string): Promise<string[] | undefined> {
  try {
    const r = (await getJson(base.replace(/\/v1$/, "") + "/running", key, 2000)) as Json;
    if (!Array.isArray(r?.running)) return undefined;
    return r.running
      .filter((x: Json) => x && typeof x.model === "string" && (!x.state || x.state === "ready"))
      .map((x: Json) => x.model as string);
  } catch {
    return undefined;
  }
}

async function checkOne(id: string, raw: Json, kind: ProviderKind): Promise<ProviderStatus> {
  const base = String(raw.baseUrl).replace(/\/+$/, "");
  const key = resolveKey(storedKey(id));
  const started = performance.now();
  try {
    const listed = parseModels(await getJson(`${base}/models`, key, 4000));
    const ms = Math.round(performance.now() - started);
    const ids = new Set(listed.map((m) => m.id));
    const chosen: string[] = raw.models.map((m: Json) => m?.id).filter((m: unknown): m is string => typeof m === "string");
    // A server that lists nothing is not saying the chosen ones are gone.
    const status: ProviderStatus = { state: "up", ms, listed: listed.length, missing: listed.length ? chosen.filter((m) => !ids.has(m)) : [] };
    if (kind === "llama-swap") status.loaded = await swapRunning(base, key);
    return status;
  } catch (e) {
    return { state: "down", message: (e as Error).message };
  }
}

/**
 * Whether each server in models.json answers now. Only those with an
 * address: a hosted service is not asked, since asking costs a request on
 * someone's key.
 */
export async function checkProviders(): Promise<Record<string, ProviderStatus>> {
  const providers = readModelsJson().providers ?? {};
  const kinds = readJson(kindsJsonPath());
  const out: Record<string, ProviderStatus> = {};
  await Promise.all(
    Object.entries<Json>(providers)
      .filter(([, raw]) => raw && Array.isArray(raw.models) && typeof raw.baseUrl === "string")
      .map(async ([id, raw]) => { out[id] = await checkOne(id, raw, kindOf(id, raw.baseUrl, kinds)); }),
  );
  return out;
}

// --- writing ---

const ID_RE = /^[A-Za-z0-9][\w.:=-]{0,63}$/;

export interface SaveProvider {
  kind: ProviderKind;
  /** Added, not edited: refused when something is set up under that name already. */
  adding?: boolean;
  baseUrl?: string;
  api?: string;
  /** Undefined keeps the stored key, "" removes it. */
  apiKey?: string;
  models?: ModelEntry[];
}

/** Only what the form edits: anything else on a stored model — a thinking map written by hand — stays. */
const EDITABLE = ["name", "contextWindow", "maxTokens", "input", "reasoning"] as const;

export function mergeModels(existing: ModelEntry[], wanted: ModelEntry[]): ModelEntry[] {
  const before = new Map(existing.map((m) => [m.id, m]));
  return wanted.map((w) => {
    const next: ModelEntry = { ...(before.get(w.id) ?? {}), id: w.id };
    for (const field of EDITABLE) {
      const value = w[field];
      if (value === undefined || value === null || value === "" || value === false) delete next[field];
      else next[field] = value as never;
    }
    return next;
  });
}

/** Something is set up under that name already. */
export class TakenError extends Error {}

export function saveProvider(id: string, body: SaveProvider): Promise<Changed> {
  if (!ID_RE.test(id)) return Promise.reject(new Error("A provider's name is letters, digits and - _ . : = — and starts with a letter or digit."));
  const preset = PRESETS.find((p) => p.kind === body.kind);
  if (!preset) return Promise.reject(new Error(`Unknown kind of provider: ${body.kind}`));
  const taken = () => new TakenError(`Something is set up as “${id}” already. Edit it, or pick another name.`);
  return serial(async () => {
    if (!preset.endpoint) {
      const key = body.apiKey;
      if (key === undefined) {
        if (body.adding && readAuthJson()[id]) throw taken();
        return {};
      }
      await changeAuth((auth) => {
        if (body.adding && auth[id]) throw taken();
        if (key.trim()) auth[id] = { ...(auth[id]?.type === "api_key" ? auth[id] : {}), type: "api_key", key: key.trim() };
        else if (auth[id]) delete auth[id];
        else return false;
      });
      return {};
    }
    if (!body.baseUrl?.trim()) throw new Error("An address is needed, such as http://127.0.0.1:8080/v1.");
    const file = readForChange(modelsJsonPath());
    const providers: Json = file.providers && typeof file.providers === "object" ? file.providers : {};
    // Added under a name already in use, it would be merged into what is there.
    if (body.adding && (providers[id] || readAuthJson()[id])) throw taken();
    const current: Json = providers[id] ?? {};
    const next: Json = { ...current, baseUrl: normalizeBaseUrl(body.baseUrl, body.kind) };
    next.api = body.api && (APIS as readonly string[]).includes(body.api) ? body.api : current.api ?? "openai-completions";
    // pi takes a key in auth.json over the one here: one kept there is changed there, or the new one would never be used.
    const keptInAuth = body.apiKey !== undefined && readAuthJson()[id]?.type === "api_key";
    if (keptInAuth) {
      const key = body.apiKey!.trim();
      await changeAuth((auth) => {
        if (auth[id]?.type !== "api_key") return false;
        if (key) auth[id] = { ...auth[id], key };
        else delete auth[id];
      });
      next.apiKey ??= preset.placeholderKey ?? "none";
    } else if (body.apiKey !== undefined) next.apiKey = body.apiKey.trim() || preset.placeholderKey || "none";
    else next.apiKey ??= preset.placeholderKey ?? "none";
    if (preset.compat && !current.compat) next.compat = preset.compat;
    next.models = mergeModels(Array.isArray(current.models) ? current.models : [], body.models ?? []);
    providers[id] = next;
    file.providers = providers;
    const backup = writeModelsJson(file);
    const kinds = readJson(kindsJsonPath());
    if (kinds[id] !== body.kind) writeJson(kindsJsonPath(), { ...kinds, [id]: body.kind });
    return { backup };
  });
}

export function removeProvider(id: string): Promise<Changed & { found: boolean }> {
  return serial(async () => {
    let found = false;
    let backup: string | undefined;
    // A models.json that cannot be read stops the removal — unless the name
    // is a key in auth.json, which is all the page could have shown for it:
    // it lists no server from a file it cannot read.
    let file: Json | undefined;
    try {
      file = readForChange(modelsJsonPath());
    } catch (e) {
      if (!readAuthJson()[id]) throw e;
    }
    // Only a server of its own. An entry without models overrides a hosted
    // service's address or details, written by hand: removing that service's
    // key leaves it, as the page knows nothing of it.
    if (file && Array.isArray(file.providers?.[id]?.models)) {
      delete file.providers[id];
      backup = writeModelsJson(file);
      found = true;
    }
    const kinds = readJson(kindsJsonPath());
    if (id in kinds) {
      delete kinds[id];
      writeJson(kindsJsonPath(), kinds);
    }
    if (readAuthJson()[id]) {
      const removed = await changeAuth((auth) => {
        if (!auth[id]) return false;
        delete auth[id];
        return true;
      });
      found ||= removed === true;
    }
    return { found, backup };
  });
}

/** The key stored for a provider, for asking its server again without sending it to the page and back. */
export function storedKey(id: string): string | undefined {
  const auth = readAuthJson()[id];
  if (auth?.type === "api_key" && typeof auth.key === "string") return auth.key;
  const key = readModelsJson().providers?.[id]?.apiKey;
  return typeof key === "string" ? key : undefined;
}

/** A saved server's address and key, for asking it again from its editor. None for a hosted service, which has no address here. */
export function savedServer(id: string): Saved | undefined {
  const raw = readModelsJson().providers?.[id];
  if (!raw || typeof raw.baseUrl !== "string") return undefined;
  return { baseUrl: raw.baseUrl, key: storedKey(id) };
}
