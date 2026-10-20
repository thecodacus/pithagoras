import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { MAX_SIZE, TIMEOUT_SECONDS, parseSize, promptWith, type NativeSettings, type OutputFormat } from "./image-settings";
import { decodeBase64, pictureExt } from "./picture-files";
import { getSetting, putSetting } from "./store";

/**
 * Image generation as an add-on: the agent's `generate_image` tool asks an
 * image model the person has set up for a picture, and gets one back.
 *
 * The endpoint speaks the OpenAI-style `images/generations` shape — a request
 * with a model and a prompt, an answer with a picture as base64 or as an
 * address — which hosted providers and local servers alike offer. The settings
 * are Media's own, in its store (see store.ts), read each time the tool is
 * called, so a change to the address or the model needs no restart. The key
 * is kept here and goes to the endpoint it was given for, and nowhere else: not
 * into a log, not into an answer of the API (only whether one is set), and not
 * to another host.
 *
 * Editing a picture (`images/edits`, see image-editing.ts) is the same add-on
 * with a switch of its own: not every endpoint that makes pictures changes
 * them, so it is opt-in apart, and may be asked of another address.
 */

const KEY = "image_generation";

/** The agent's tool: it exists only while the add-on is ready (see imageGenerationReady). */
export const GENERATE_IMAGE_TOOL = "generate_image";
/** The agent's tool for changing a picture: it exists only while editing is ready (see imageEditingReady). */
export const EDIT_IMAGE_TOOL = "edit_image";

export interface ImageGenerationConfig {
  enabled: boolean;
  /** The API's base, such as https://host/v1: no credentials, query or fragment, so that nothing secret is in what the page is shown. */
  baseUrl: string;
  /** Sent as `model` when it is not empty. */
  model: string;
  /** Sent as `size` when it is not empty, unless the agent asks for another. */
  size: string;
  apiKey: string;
  /** Editing is opt-in apart from generation: an endpoint that makes pictures may not change them. */
  editEnabled: boolean;
  /** Where edits go, with the same rules as `baseUrl`. Empty is the address above. */
  editBaseUrl: string;
  /** Sent as `model` on an edit when it is not empty; never the generation model, which may be one that only makes pictures. */
  editModel: string;
  /** The key of the edit address; see imageEditingTarget for when the one above is used instead. */
  editApiKey: string;
  /**
   * The edit endpoint takes several pictures in one request, so edit_image may be given a list. Endpoints differ
   * (some take one, some several), so it is off until the person says this one does, and it is said of an
   * endpoint: moving edits to another server takes it off again.
   */
  editMultiple: boolean;
  /**
   * The most pixels a picture sent to be edited may have, as `1024x1024`: the size of the box it must fit, turned
   * either way. Empty is none, as an empty `size` sends none; a request beyond it is refused before anything is sent.
   */
  editMaxSize: string;
  /** How long a request for a picture, generated or edited, may take in all; see TIMEOUT_SECONDS. */
  timeoutSeconds: number;
  /**
   * The endpoint is stable-diffusion.cpp's server, which reads settings the OpenAI format does not have out of the
   * prompt (see image-settings.ts). Off until the person says it is: nothing of the sort is shown on the Media page
   * or sent, to this endpoint or to any other, whatever was typed or kept. It is said of the endpoint, for generating
   * and editing: either address moving to another server takes it off again.
   */
  sdExtras: boolean;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const validTimeout = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= TIMEOUT_SECONDS.min && (v as number) <= TIMEOUT_SECONDS.max;

/** What is saved, as it is: without the defaults the config fills in. */
function savedSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(getSetting(KEY) || "{}");
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Unreadable is as good as nothing saved.
  }
  return {};
}

export function imageGenerationConfig(): ImageGenerationConfig {
  const raw = savedSettings();
  return {
    enabled: raw.enabled === true,
    baseUrl: text(raw.baseUrl),
    model: text(raw.model),
    // One saved before the sizes were limited, and outside them, is as good as none.
    size: typeof raw.size === "string" && typeof parseSize(raw.size) === "string" ? raw.size.trim() : "",
    apiKey: text(raw.apiKey),
    editEnabled: raw.editEnabled === true,
    editBaseUrl: text(raw.editBaseUrl),
    editModel: text(raw.editModel),
    editApiKey: text(raw.editApiKey),
    editMultiple: raw.editMultiple === true,
    // A setup saved before there was a maximum has none, and an unreadable one is as good as none.
    editMaxSize: typeof raw.editMaxSize === "string" && MAX_SIZE.test(raw.editMaxSize) ? raw.editMaxSize : "",
    // A setup saved before there was a limit has none, and an unreadable one is as good as none.
    timeoutSeconds: validTimeout(raw.timeoutSeconds) ? raw.timeoutSeconds : TIMEOUT_SECONDS.default,
    // A setup saved before there was the switch has it off.
    sdExtras: raw.sdExtras === true,
  };
}

/** On, and told where to ask: only then is there a tool, so there is no tool that always fails. */
export const imageGenerationReady = (config: ImageGenerationConfig = imageGenerationConfig()): boolean => config.enabled && config.baseUrl !== "";

/** Editing is on and has an address to ask, its own or the one of generation: only then is there an edit tool. */
export const imageEditingReady = (config: ImageGenerationConfig = imageGenerationConfig()): boolean =>
  config.editEnabled && (config.editBaseUrl || config.baseUrl) !== "";

/**
 * Editing is ready and its endpoint takes several pictures: the shape of the
 * edit tool, which a chat decides when it loads, as it does whether there is one.
 */
export const imageEditingMultiple = (config: ImageGenerationConfig = imageGenerationConfig()): boolean => imageEditingReady(config) && config.editMultiple;

/** Where an edit goes, and what goes with it. */
export interface ImageEditingTarget {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Whether the endpoint takes more than one picture: otherwise an edit with several is refused before anything is sent. */
  multiple: boolean;
  /** The most pixels a picture may have, as `1024x1024`, or empty for no limit; see ImageGenerationConfig.editMaxSize. */
  maxSize: string;
  /** How long the request may take; see TIMEOUT_SECONDS. */
  timeoutSeconds: number;
  /** Whether what only stable-diffusion.cpp reads may be sent with an edit; see ImageGenerationConfig.sdExtras. */
  sdExtras: boolean;
}

/**
 * The edit address, or the address of generation while none is given of its own.
 * A key belongs to the server it was given for: the generation key goes along
 * only when the edits go to the generation server, never to another one.
 */
export function imageEditingTarget(config: ImageGenerationConfig = imageGenerationConfig()): ImageEditingTarget {
  const baseUrl = config.editBaseUrl || config.baseUrl;
  const sameServer = baseUrl !== "" && originOf(baseUrl) === originOf(config.baseUrl);
  return { baseUrl, model: config.editModel, apiKey: config.editApiKey || (sameServer ? config.apiKey : ""), multiple: config.editMultiple, maxSize: config.editMaxSize, timeoutSeconds: config.timeoutSeconds, sdExtras: config.sdExtras };
}

/** What the page is told of the settings: never a key itself. */
export function imageGenerationState() {
  const config = imageGenerationConfig();
  const { apiKey, editApiKey, ...rest } = config;
  return { ...rest, keySet: apiKey !== "", editKeySet: editApiKey !== "", ready: imageGenerationReady(config), editReady: imageEditingReady(config) };
}

export interface ImageGenerationPatch {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  size?: string;
  /** "" takes the saved one away. */
  apiKey?: string;
  editEnabled?: boolean;
  /** "" is the address of generation. */
  editBaseUrl?: string;
  editModel?: string;
  /** "" takes the saved one away. */
  editApiKey?: string;
  editMultiple?: boolean;
  /** `1024x1024`; "" takes the limit away. */
  editMaxSize?: string;
  /** Whole seconds, from TIMEOUT_SECONDS.min to its max; null takes the saved one away, which is the default again. */
  timeoutSeconds?: number | null;
  sdExtras?: boolean;
}

/** An API address as the settings keep it, or the reason it is not one. */
export function parseBase(value: unknown): { base: string } | { error: string } {
  if (typeof value !== "string") return { error: "The address must be text" };
  const given = value.trim();
  if (!given) return { base: "" };
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return { error: "The address must be an http or https URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "The address must be an http or https URL" };
  if (url.username || url.password || url.search || url.hash) return { error: "The address is the API's base, such as https://host/v1: the key goes in the key field, not in the address" };
  return { base: url.toString().replace(/\/+$/, "") };
}

/** What a request may change, checked; the reason when it may not. */
export function parseImageGenerationPatch(body: unknown): ImageGenerationPatch | string {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const patch: ImageGenerationPatch = {};
  for (const field of ["enabled", "editEnabled", "editMultiple", "sdExtras"] as const) {
    if (b[field] === undefined) continue;
    if (typeof b[field] !== "boolean") return `${field} must be true or false`;
    patch[field] = b[field];
  }
  for (const field of ["baseUrl", "editBaseUrl"] as const) {
    if (b[field] === undefined) continue;
    const parsed = parseBase(b[field]);
    if ("error" in parsed) return parsed.error;
    patch[field] = parsed.base;
  }
  for (const field of ["model", "editModel"] as const) {
    if (b[field] === undefined) continue;
    const given = b[field];
    if (typeof given !== "string" || given.length > 200) return "The model must be text of at most 200 characters";
    patch[field] = given.trim();
  }
  if (b.size !== undefined) {
    if (typeof b.size !== "string") return 'The size looks like "1024x1024"';
    // The same sizes the Media page and the agent's tool take: a default that the gallery refuses is none.
    const size = b.size.trim() ? parseSize(b.size) : "";
    if (typeof size !== "string") return size.error;
    patch.size = size;
  }
  if (b.editMaxSize !== undefined) {
    if (typeof b.editMaxSize !== "string" || (b.editMaxSize.trim() && !MAX_SIZE.test(b.editMaxSize.trim()))) return 'The maximum size looks like "2048x2048"';
    patch.editMaxSize = b.editMaxSize.trim();
  }
  if (b.timeoutSeconds !== undefined) {
    if (b.timeoutSeconds !== null && !validTimeout(b.timeoutSeconds)) return `The time limit must be a whole number of seconds from ${TIMEOUT_SECONDS.min} to ${TIMEOUT_SECONDS.max}`;
    patch.timeoutSeconds = b.timeoutSeconds as number | null;
  }
  for (const field of ["apiKey", "editApiKey"] as const) {
    if (b[field] === undefined) continue;
    const given = b[field];
    if (typeof given !== "string" || given.length > 4000) return "The key must be text of at most 4000 characters";
    patch[field] = given.trim();
  }
  return patch;
}

export const originOf = (address: string): string => {
  try {
    return new URL(address).origin;
  } catch {
    return "";
  }
};

/**
 * Saves a change, or refuses it: switched on, there must be an address to ask.
 * A key belongs to the server it was given for, so a new address of another
 * origin that does not come with one has none. A key saved before any address
 * was given for no server yet, and stays for the first. Both keys follow this
 * rule, the edit key by the address edits go to (see imageEditingTarget). So
 * does "takes several pictures", which was said of one endpoint and is not
 * assumed of another. And so does "stable-diffusion.cpp", which is said of the
 * endpoint as a whole: either address moving takes it off, since any other
 * server would read what it makes the Media page send as part of the description.
 */
export function saveImageGeneration(patch: ImageGenerationPatch): ImageGenerationConfig {
  const had = imageGenerationConfig();
  const { timeoutSeconds: asked, ...others } = patch;
  const next = { ...had, ...others, ...(typeof asked === "number" ? { timeoutSeconds: asked } : asked === null ? { timeoutSeconds: TIMEOUT_SECONDS.default } : {}) };
  // Only from one server to another: a key saved before there was an address was given for none, and goes with the first.
  const movedGeneration = had.baseUrl !== "" && originOf(next.baseUrl) !== originOf(had.baseUrl);
  if (patch.apiKey === undefined && movedGeneration) next.apiKey = "";
  const wasEditedAt = had.editBaseUrl || had.baseUrl;
  const movedEdits = wasEditedAt !== "" && originOf(next.editBaseUrl || next.baseUrl) !== originOf(wasEditedAt);
  if (patch.editApiKey === undefined && movedEdits) next.editApiKey = "";
  if (patch.editMultiple === undefined && movedEdits) next.editMultiple = false;
  // One switch for both addresses: it is not known of a server that either one moved to.
  if (patch.sdExtras === undefined && (movedGeneration || movedEdits)) next.sdExtras = false;
  if (next.enabled && !next.baseUrl) throw new ImageGenerationError("Set the address of the image endpoint before switching it on");
  if (next.editEnabled && !(next.editBaseUrl || next.baseUrl)) throw new ImageGenerationError("Set the address of the image endpoint before switching editing on");
  // The default stays unsaved until a limit is chosen, so that it is the default of the day for every setup that never chose one.
  const { timeoutSeconds, ...rest } = next;
  putSetting(KEY, JSON.stringify(typeof asked === "number" || (asked === undefined && "timeoutSeconds" in savedSettings()) ? next : rest));
  return next;
}

/** What went wrong with a picture, in words the agent can pass on: nothing in it is secret. */
export class ImageGenerationError extends Error {}

/** After decoding: what the portal serves back as a picture, with room to spare. */
export const MAX_GENERATED_BYTES = 20 * 1024 * 1024;

export interface GenerateOptions {
  /** The chat being stopped. */
  signal?: AbortSignal;
  /** The limit of the request in milliseconds; without it, the default of TIMEOUT_SECONDS; the callers pass the one of the settings. */
  timeoutMs?: number;
  maxBytes?: number;
}

/** Where the request goes: the base, with the route the OpenAI-style APIs have unless it is already there. */
export function endpointUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = base.endsWith("/images/generations") ? base : `${base}/images/generations`;
  return url;
}

/** `message` without the key, in case the server repeated it. */
export const without = (message: string, key: string): string => (key ? message.split(key).join("[key]") : message);

const seconds = (ms: number) => Math.round(ms / 1000);

/** What the endpoints take of a prompt: DALL-E 3's four thousand characters is the least. */
export const MAX_PROMPT = 4000;

/**
 * A field of the request that an older version of the Media page sent as it was typed. Not sent any more: what
 * is not in the OpenAI format goes in the prompt (see image-settings.ts). Pictures made then still have theirs,
 * which the page shows as they were.
 */
export type ExtraValue = string | number | boolean;

/** What a request for a picture says, on top of the settings it is made with. */
export interface GenerateRequest {
  prompt: string;
  /** Instead of the saved size. */
  size?: string;
  /** Instead of the saved model, for the Media page: the agent's tool has the saved one only. */
  model?: string;
  /** Sent as `output_format`, and `output_compression` with it. */
  outputFormat?: OutputFormat;
  outputCompression?: number;
  /** Not in the OpenAI format: put in the prompt as stable-diffusion.cpp's server reads them, and only where one is set. */
  native?: NativeSettings;
}

/**
 * Asks for a picture and returns it, checked: what comes back is a PNG, JPEG,
 * GIF or WebP by its first bytes, whatever the server calls it, and not larger
 * than the limit. The request has the fields of the OpenAI image format and no
 * other; what the format does not have is in the prompt (see image-settings.ts).
 */
export async function generateImage(
  config: ImageGenerationConfig,
  request: GenerateRequest,
  options: GenerateOptions = {},
): Promise<{ bytes: Buffer; ext: string }> {
  const size = request.size || config.size;
  const model = request.model || config.model;
  const body = JSON.stringify({
    ...(model ? { model } : {}),
    // Where the switch is off nothing of the kind goes, whatever the request holds: the one place that holds for every caller.
    prompt: promptWith(request.prompt, config.sdExtras ? (request.native ?? {}) : {}),
    n: 1,
    ...(size ? { size } : {}),
    ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
    ...(request.outputCompression !== undefined ? { output_compression: request.outputCompression } : {}),
  });
  return requestPicture(endpointUrl(config.baseUrl), config.apiKey, body, { timeoutMs: config.timeoutSeconds * 1000, ...options });
}

/**
 * Sends a request to an image endpoint and returns the picture it answers
 * with, as generation and editing both do. `body` is the JSON text of a
 * generation, or the form of an edit, whose type fetch sets itself with its
 * boundary. The key goes with this request to this address, and is not
 * followed anywhere else.
 */
export async function requestPicture(
  endpoint: URL,
  apiKey: string,
  body: string | FormData,
  options: GenerateOptions = {},
): Promise<{ bytes: Buffer; ext: string }> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_SECONDS.default * 1000;
  const max = options.maxBytes ?? MAX_GENERATED_BYTES;
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]);
  const failed = (e: unknown): Error => {
    // The chat was stopped: nobody is told it failed.
    if (options.signal?.aborted) return e as Error;
    if (signal.aborted) return new ImageGenerationError(
        `The image endpoint did not answer within ${seconds(timeoutMs)} seconds. Raise the time limit under Media in Settings if it needs longer.`,
      );
    if (e instanceof ImageGenerationError) return e;
    const why = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code ?? (e as Error)?.message ?? "unknown error";
    return new ImageGenerationError(without(`Could not reach the image endpoint at ${endpoint.origin} (${why})`, apiKey));
  };

  try {
    const res = await post(endpoint, apiKey, body, signal);
    // The picture as base64 is a third larger than itself, and wrapped in JSON.
    const answer = await readBody(res, Math.ceil((max * 4) / 3) + 64 * 1024, "The image endpoint's answer");
    const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
    let parsed: any;
    try {
      parsed = JSON.parse(answer.toString("utf8"));
    } catch {
      if (!ok) throw new ImageGenerationError(`The image endpoint answered ${res.statusCode}`);
      throw new ImageGenerationError("The image endpoint did not answer with JSON");
    }
    if (!ok) {
      const said = text(parsed?.error?.message) || text(parsed?.error) || text(parsed?.message);
      // The key out first, then the cut: one that starts before the cut and ends after it would be found by neither.
      const shown = without(said, apiKey).replace(/\s+/g, " ").slice(0, 300);
      throw new ImageGenerationError(`The image endpoint answered ${res.statusCode}${shown ? `: ${shown}` : ""}`);
    }
    const first = Array.isArray(parsed?.data) ? parsed.data[0] : undefined;
    let bytes: Buffer;
    if (typeof first?.b64_json === "string" && first.b64_json) bytes = fromBase64(first.b64_json, max);
    else if (typeof first?.url === "string" && first.url.startsWith("data:")) bytes = fromBase64(first.url, max);
    else if (typeof first?.url === "string" && first.url) bytes = await download(first.url, endpoint, apiKey, signal, max);
    else throw new ImageGenerationError("The image endpoint answered, but with no picture in it");
    return picture(bytes, max);
  } catch (e) {
    throw failed(e);
  }
}

/**
 * POSTs to the endpoint and returns its answer once the headers are in. Not
 * `fetch`: its headers timeout is five minutes whatever the signal says, which
 * would cut off a request the person gave longer. Never followed elsewhere: the
 * key goes with this request, to this address, and a redirect is refused.
 */
async function post(endpoint: URL, apiKey: string, body: string | FormData, signal: AbortSignal): Promise<http.IncomingMessage> {
  // A form has its type, with the boundary, from the Response that encodes it.
  const sent = typeof body === "string" ? undefined : new Response(body);
  const bytes = sent ? Buffer.from(await sent.arrayBuffer()) : Buffer.from(body as string);
  const type = sent ? sent.headers.get("content-type") : "application/json";
  return sendRequest(endpoint, apiKey, { method: "POST", signal, body: bytes, type: type ?? undefined, what: "image endpoint" });
}

/**
 * One request to an endpoint, answered once the headers are in: the way every request to an image or video endpoint
 * is made (see `post`). `body` is the bytes of a request that has one, and `type` its content type. The key goes with
 * this request to this address and is not followed anywhere else: a redirect is refused, naming `what` the endpoint is,
 * as the error `fail` makes of it.
 */
export function sendRequest(
  endpoint: URL,
  apiKey: string,
  options: { method: "GET" | "POST"; signal: AbortSignal; body?: Buffer; type?: string; what: string; fail?: (message: string) => Error },
): Promise<http.IncomingMessage> {
  const { method, signal, body, type, what, fail = (message) => new ImageGenerationError(message) } = options;
  return new Promise((resolve, reject) => {
    const request = endpoint.protocol === "https:" ? https.request : http.request;
    const req = request(
      endpoint,
      {
        method,
        signal,
        // fetch sent one, and some endpoints sit behind a firewall that refuses a request with none.
        headers: {
          "user-agent": "pithagoras",
          ...(type ? { "content-type": type } : {}),
          ...(body ? { "content-length": body.length } : {}),
          accept: "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return reject(fail(`The ${what} answered with a redirect, which is not followed: give the address it redirects to`));
        }
        resolve(res);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** A picture, if these bytes are one. */
function picture(bytes: Buffer, max: number): { bytes: Buffer; ext: string } {
  if (bytes.length > max) throw new ImageGenerationError(`The picture is over ${max / 1024 / 1024} MB`);
  const ext = pictureExt(bytes.subarray(0, 12));
  if (!ext) throw new ImageGenerationError("What the image endpoint sent is not a PNG, JPEG, GIF or WebP picture");
  return { bytes, ext };
}

/** Base64, or a data: URL holding it, decoded. */
function fromBase64(given: string, max: number): Buffer {
  const decoded = decodeBase64(given, max);
  if ("error" in decoded) {
    throw new ImageGenerationError(decoded.error === "invalid" ? "The picture the image endpoint sent is not base64" : `The picture is over ${max / 1024 / 1024} MB`);
  }
  return decoded.bytes;
}

/** A body read up to a limit, which is not read past; `fail` makes the error of one that is over it. */
export async function readBody(stream: AsyncIterable<Uint8Array> | null, max: number, what: string, fail: (message: string) => Error = (message) => new ImageGenerationError(message)): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (!stream) return Buffer.alloc(0);
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > max) throw fail(`${what} is over ${Math.round(max / 1024 / 1024)} MB`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// --- a picture sent as an address ---

/** Not somewhere on the public internet: this machine, its network, the places that are reserved. */
const NOT_PUBLIC = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) NOT_PUBLIC.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  NOT_PUBLIC.addSubnet(net, bits, "ipv6");
}

/** Whether `address`, as an IP address, is one on the public internet. Anything that is not an address is not. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (!family) return false;
  try {
    // An IPv4 address written the IPv6 way (::ffff:10.0.0.1) is judged as the IPv4 one.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    return mapped ? !NOT_PUBLIC.check(mapped[1], "ipv4") : !NOT_PUBLIC.check(bare, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

/**
 * Why a picture may not be fetched from `url`, or undefined when it may.
 *
 * The address comes from the endpoint, which the person chose to trust with
 * their prompts, but it names a place the endpoint picked: a signed link on a
 * storage service of the provider's, usually, and not the API's own host. So
 * two places are fetched from. The endpoint's own origin, which is the
 * person's own choice — a local server on this machine hands out its pictures
 * itself. And, over https, any host on the public internet. Never another place
 * on this machine or its network: an endpoint answering with
 * http://169.254.169.254/… or http://localhost:8080/admin would otherwise have
 * the portal fetch it. A host given by name is checked where it is connected
 * to (publicLookup); one given as an address, here.
 */
export function pictureUrlRefusal(url: URL, endpoint: URL): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "The picture's address is not http or https";
  if (url.username || url.password) return "The picture's address has a login in it";
  if (url.origin === endpoint.origin) return undefined;
  if (url.protocol !== "https:") return `The picture is on ${url.host}, another host than the endpoint, and is only fetched from there over https`;
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && !isPublicAddress(url.hostname)) return `The picture is at ${url.host}, which is not on the public internet`;
  return undefined;
}

/** Connects only to public addresses: checked where the connection is made, so that a name cannot answer one way here and another there. */
const publicLookup = (host: string, options: dns.LookupOptions, callback: (...args: any[]) => void): void => {
  dns.lookup(host, { ...options, all: true }, (err, found) => {
    if (err) return callback(err);
    const addresses = found as dns.LookupAddress[];
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new ImageGenerationError(`The picture is on ${host}, which is not on the public internet`));
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

const MAX_REDIRECTS = 3;

/** What is sent with a request for a picture: the key only to the endpoint's own origin, which is the server it was given for. */
export function downloadHeaders(url: URL, endpoint: URL, key: string): Record<string, string> {
  return { accept: "image/*", ...(url.origin === endpoint.origin && key ? { authorization: `Bearer ${key}` } : {}) };
}

/**
 * Fetches a picture from an address the endpoint gave. The key is sent only
 * to the endpoint's own origin, and each redirect is judged like the address
 * itself, so one cannot lead anywhere the address could not.
 */
function download(address: string, endpoint: URL, key: string, signal: AbortSignal, max: number, hops = 0, from: URL = endpoint): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(address, from);
    } catch {
      return reject(new ImageGenerationError("The picture's address is not an address"));
    }
    const refusal = pictureUrlRefusal(url, endpoint);
    if (refusal) return reject(new ImageGenerationError(refusal));
    const own = url.origin === endpoint.origin;
    const get = url.protocol === "https:" ? https.get : http.get;
    const req = get(
      url,
      {
        signal,
        // A connection of its own, so what is known of one host is never taken for another's.
        agent: false,
        headers: downloadHeaders(url, endpoint, key),
        ...(own ? {} : { lookup: publicLookup }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const next = res.headers.location;
        if (status >= 300 && status < 400 && next) {
          res.resume();
          if (hops >= MAX_REDIRECTS) return reject(new ImageGenerationError("The picture's address redirects too often"));
          return void download(next, endpoint, key, signal, max, hops + 1, url).then(resolve, reject);
        }
        if (status !== 200) {
          res.resume();
          return reject(new ImageGenerationError(`The picture's address answered ${status}`));
        }
        if (Number(res.headers["content-length"]) > max) {
          res.destroy();
          return reject(new ImageGenerationError(`The picture is over ${max / 1024 / 1024} MB`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > max) {
            res.destroy();
            reject(new ImageGenerationError(`The picture is over ${max / 1024 / 1024} MB`));
          } else chunks.push(chunk);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
        res.on("close", () => {
          if (!res.complete) reject(new ImageGenerationError("The picture's download ended early"));
        });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e instanceof ImageGenerationError || signal.aborted) return reject(e);
      reject(new ImageGenerationError(without(`Could not download the picture from ${url.host} (${e.code ?? e.message})`, key)));
    });
  });
}
