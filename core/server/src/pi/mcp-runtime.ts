import path from "node:path";
import { chatServers, entryEnabled, mcpConfigPath, type ChatServer } from "../api/mcp.js";
import { configHash, declarationTokens, cachedServer, rememberServerTools, type CachedServer, type CachedTool } from "../mcp-tools.js";
import { mcpNamespace, resolvedEntry, toolExposureOf } from "../mcp-config.js";
import { MCP_RESOURCE_TOOLS, isResourceTool, mcpNamespaceOf, serversOfNamespace } from "./mcp-origin.js";
import { headLazy, toolEntry, type LazyHead } from "../tool-lazy.js";

/**
 * The MCP servers of one chat, on pi's own MCP support.
 *
 * pi 1.1 connects every server of its config when a session starts, declares what the config says, and has no cache of a
 * server's tools. The portal wants three things it does not do: a server a chat never uses is never started, what the
 * model is sent first does not change when a server connects, and the tools of servers the chat has as lazy are found
 * and called through `tool_search`. So the portal gives pi its own `loadConfig` (the seam pi documents) and keeps the rest
 * here:
 *
 * - **Exposure per chat.** The file says how pi (the CLI, a container) reaches a server; a chat is told by what it froze
 *   when it started (LazyHead): a server that is direct there is connected with the chat and declared (`direct`); one that
 *   is lazy is not in pi's config at all and is registered with `pi.registerMcpServer` when a tool of it is first wanted,
 *   `direct` as well, and its tools are hidden from every request by namespace (see ToolSearch.hidden) so that the model
 *   is told of them in a result, at the end of the context, and the tools array never changes. A chat that works through
 *   the code tool alone has every server connected with the chat, `codemode` where it would have been lazy.
 * - **Connect on first use**, with a wait of its own (pi has none) and an idle disconnect of what the portal started.
 * - **Cache.** What each server offered when it last connected (mcp-tools.ts) serves the search before a server is up.
 * - **What pi would add** to the prompt (the `mcp_servers` section) or say (that neither codemode nor tool_search is
 *   active) is taken out, as the first changes with every connection, which is a change of the head.
 */

/** How long a call or a search waits for a server to connect and register its tools: pi has no await, so it is a poll. */
const CONNECT_WAIT_MS = 30_000;
/** How long a server the portal started may sit unused before it is stopped. */
const IDLE_MS = 10 * 60_000;
/** How often the idle servers are looked for. */
const IDLE_CHECK_MS = 30_000;

export type Plan = "start" | "lazy" | "off";

/** What pi gets of a server at the start of a chat, and what the portal does with it. */
interface Planned {
  server: ChatServer;
  plan: Plan;
  /** The entry as pi is given it, with the exposure the chat wants. */
  config: Record<string, unknown>;
  /** Off only because every tool of it is switched off in the chat: a switch that turns one on brings it back (see switched). */
  byOff?: boolean;
}

/**
 * The file's `toolExposure` as the chat gives it to pi: every entry kept, in its order, hidden tools hidden and every other
 * one at the chat's exposure. pi takes an exact name before a pattern and the first pattern that matches, so an allow-list
 * (`{ search: "deferred", "*": "hidden" }`) only means what it says with all of its entries: `"*": "hidden"` alone would hide
 * every tool of the server.
 */
function chatToolExposure(toolExposure: unknown, exposure: string): Record<string, string> | undefined {
  if (!toolExposure || typeof toolExposure !== "object" || Array.isArray(toolExposure)) return undefined;
  const entries = Object.entries(toolExposure as Record<string, unknown>);
  return entries.length ? Object.fromEntries(entries.map(([tool, one]) => [tool, one === "hidden" ? "hidden" : exposure])) : undefined;
}

/** What is remembered of a server's tools, where it was read from the configuration it has now: an entry changed since, or another server of that name, is not served as this one. */
function cachedFor(name: string, entry: Record<string, unknown>, narrowedTo: Record<string, unknown> = entry): CachedServer | undefined {
  const cached = cachedServer(name);
  if (!cached || cached.hash !== configHash(entry)) return undefined;
  // A trusted project can hide tools of the user's server for its own chats: what the file's entry has, less those.
  return narrowedTo === entry ? cached : { ...cached, tools: cached.tools.filter((tool) => toolExposureOf(narrowedTo, tool.original) !== "hidden") };
}

/** The entry a server's tools are remembered by: the user's, as the file has it, and none where a project's override took tools away from it (the chat saw fewer than the server has). */
function rememberedEntry(server: ChatServer): Record<string, unknown> | undefined {
  if (server.from !== "user") return undefined;
  return server.file && configHash(server.file) !== configHash(server.entry) ? undefined : (server.file ?? server.entry);
}

/**
 * How a chat treats a server: connected with the chat (`start`), connected when a tool of it is first wanted (`lazy`), or
 * not at all (`off`: the file says it is off, or hides it, or the chat would connect it with it and wants nothing of it:
 * every tool the portal knows of it is switched off in this chat, and its resources are not reached either). Decided
 * from the chat's frozen head and the tools it has off, never from what is connected now.
 */
export function planOf(entry: Record<string, unknown>, name: string, head: Pick<LazyHead, "lazy" | "direct">, codemodeOnly: boolean, off: ReadonlySet<string>, from: ChatServer["from"] = "user", file: Record<string, unknown> = entry): Plan {
  if (!entryEnabled(entry) || resolvedEntry(entry).exposure === "hidden") return "off";
  // A project's server is not remembered (see snapshot): what is kept under its name is another server's.
  const cached = from === "user" ? cachedFor(name, file, entry) : undefined;
  const known = cached?.tools ?? [];
  // pi's resource tools reach every server that has resources, whatever its own tools are switched to.
  const resources = cached?.resources === true && MCP_RESOURCE_TOOLS.some((tool) => !off.has(tool));
  const unwanted = known.length > 0 && known.every((tool) => off.has(tool.name)) && !resources;
  if (codemodeOnly) return unwanted ? "off" : "start";
  const prefix = toolEntry(`${mcpNamespace(name)}__`);
  // A tool of it that is kept in the list by its own entry needs the server with the chat.
  if (head.direct.some((entry) => entry.startsWith(prefix))) return unwanted ? "off" : "start";
  // A lazy server costs nothing until a tool of it is wanted, and one switched on in the middle of the chat is wanted then.
  return headLazy(head, { name: "", set: name }) ? "lazy" : unwanted ? "off" : "start";
}

/** The config pi is given for a server: the chat's exposure, and the tools the file hides. */
function configFor(entry: Record<string, unknown>, plan: Plan, head: Pick<LazyHead, "direct">, name: string, codemodeOnly: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = { ...resolvedEntry(entry) };
  delete config.disabled;
  // Where everything is reached through the code tool, the servers the chat would have found are scripts' to call.
  const pinned = head.direct.includes(name) || head.direct.some((one) => one.startsWith(toolEntry(`${mcpNamespace(name)}__`)));
  const exposure = codemodeOnly && plan === "start" && !pinned ? "codemode" : "direct";
  const kept = chatToolExposure(config.toolExposure, exposure);
  delete config.toolExposure;
  if (kept) config.toolExposure = kept;
  config.exposure = exposure;
  config.enabled = true;
  return config;
}

/** What a search finds of a tool whose server is not running: from the cache. */
export interface OfflineTool {
  name: string;
  description: string;
  parameters: unknown;
  /** The server's name, as the person knows the group. */
  server: string;
}

/**
 * The resource tools as the search offers them while no server that has resources is running in the chat: pi registers them
 * when the first one connects. A call names its server, which is started for it (see ensure).
 */
const RESOURCE_STAND_INS: { name: string; description: string; parameters: unknown }[] = [
  { name: "list_mcp_resources", description: "Lists resources provided by MCP servers.", parameters: { type: "object", properties: { server: { type: "string", description: "MCP server name." }, cursor: { type: "string" } } } },
  { name: "list_mcp_resource_templates", description: "Lists resource templates provided by MCP servers.", parameters: { type: "object", properties: { server: { type: "string", description: "MCP server name." }, cursor: { type: "string" } } } },
  { name: "read_mcp_resource", description: "Read a specific resource from an MCP server given the server name and resource URI.", parameters: { type: "object", properties: { server: { type: "string", description: "MCP server name exactly as configured." }, uri: { type: "string" } }, required: ["server", "uri"] } },
];
if (RESOURCE_STAND_INS.some((tool) => !MCP_RESOURCE_TOOLS.includes(tool.name))) throw new Error("the resource tools' stand-ins are pi's resource tools");

/** The names the adapter gave the tools of a server: `<server>_<tool>`, hyphens as underscores and the tool's dots too. For old chats' history, which names them so. */
export const adapterName = (server: string, original: string): string => `${server.replace(/-/g, "_")}_${original.replace(/\./g, "_")}`;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export interface McpRuntimeOptions {
  /** The chat's frozen head, read at each use: it is the one place the chat's lazy servers are said. */
  head: () => LazyHead;
  /** Whether the chat works through the code tool alone. */
  codemodeOnly: () => boolean;
  /** The tools the chat has switched off, by pi's names. */
  off: () => ReadonlySet<string>;
  /** pi's session once there is one. */
  session: () => any;
  /** Waits and timings, for tests. */
  connectWaitMs?: number;
  idleMs?: number;
  idleCheckMs?: number;
}

export class McpRuntime {
  private pi?: any;
  /** The servers of this chat as the last `loadConfig` planned them. */
  private planned = new Map<string, Planned>();
  /** The servers the portal registered with pi (the lazy ones that were used), by when they were last used. */
  private started = new Map<string, number>();
  /** The starts that are under way, so that two calls for one server start it once. */
  private starting = new Map<string, Promise<void>>();
  /** The calls of tools of a server the portal started that have not ended, so that an idle check does not stop a server mid-call. */
  private running = new Map<string, string>();
  /** The lazy servers that did not connect in this session, and why: a search does not wait for them again. */
  private failed = new Map<string, string>();
  /** The servers started with the chat that were asked in this session whether they offer resources (see noteResources). */
  private probed = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  /** pi's own handlers for the end of a session, as its MCP extension registers them: what closes the servers pi started (see close). */
  private closers: ((event: unknown, ctx?: unknown) => unknown)[] = [];
  /** Ends with the session (a reload, the chat being let go): a connect that is under way stops waiting then. */
  private life = new AbortController();
  private readonly connectWait: number;
  private readonly idle: number;

  constructor(private readonly options: McpRuntimeOptions) {
    this.connectWait = options.connectWaitMs ?? CONNECT_WAIT_MS;
    this.idle = options.idleMs ?? IDLE_MS;
  }

  /** The two factories that give a session its MCP servers, in the order they must load: pi's own, then this one's handlers. */
  factories(piModule: any): { name: string; factory: (pi: any) => void }[] {
    const mcp = piModule.createMcpExtension({
      loadConfig: (ctx: any) => this.loadConfig(ctx),
      // The first prompt waits this long for the servers whose tools are declared (pi's default is 10 s too).
      startupWaitMs: 10_000,
      // pi's `/mcp login` opens the sign-in page in a browser of the machine it runs on, which is the portal's host and not
      // the person's: the address is said in the chat (pi notifies it too), and nothing is opened there.
      openUrl: () => undefined,
    });
    return [
      {
        name: "mcp",
        factory: (pi) => {
          // Each load makes a new instance of pi's extension, and pi has told the one before it that it ends: its handler is
          // of no use any more, and would keep that load's whole runtime alive for as long as the chat lives.
          this.closers = [];
          mcp(this.watched(pi));
        },
      },
      { name: "mcp-gate", factory: (pi) => this.extension(pi) },
    ];
  }

  /** pi's API as its MCP extension is given it: the same, but its handlers for the end of a session are kept (see close). */
  private watched(pi: any): any {
    const on = (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
      if (event === "session_shutdown") this.closers.push(handler);
      return pi.on(event, handler);
    };
    return Object.create(pi, { on: { value: on } });
  }

  /**
   * Stop every server of the chat, the ones pi connected with it and the ones the portal registered later: the chat is let
   * go. pi stops them when it is told that the session ends, which a runtime says (SdkPiClient.shutdown) and
   * AgentSession.dispose() does not: a client disposed without it left each stdio server running, and their pipes kept the
   * portal's process from ending. So pi's own handler is called here, which closes what it opened as at a shutdown (stdin,
   * then the server's process group); after a shutdown it finds nothing left to close.
   */
  async close(): Promise<void> {
    this.life.abort();
    clearInterval(this.timer);
    this.timer = undefined;
    this.started.clear();
    this.starting.clear();
    this.running.clear();
    await Promise.allSettled(this.closers.map(async (close) => close({ type: "session_shutdown", reason: "quit" })));
  }

  /**
   * What pi connects at the start of the chat: the servers it has with the chat, and none that are lazy (they are
   * registered when first wanted), off, or hidden. Read again at every start and reload of the session.
   */
  private loadConfig(ctx: any) {
    this.planned.clear();
    let read: ReturnType<typeof chatServers>;
    try {
      read = chatServers(String(ctx.cwd ?? ""), ctx.isProjectTrusted?.() === true);
    } catch (e) {
      console.error(`[portal] could not read the MCP configuration: ${(e as Error).message}`);
      return { servers: [], errors: [], autoEnableCodemode: false };
    }
    const head = this.options.head();
    const only = this.options.codemodeOnly();
    const off = this.options.off();
    const connect: { name: string; config: any; source: string; scope: "global" | "project" }[] = [];
    const project = path.join(String(ctx.cwd ?? ""), ".pi", "mcp.json");
    for (const server of read.servers) {
      const plan = planOf(server.entry, server.name, head, only, off, server.from, server.file);
      const config = configFor(server.entry, plan, head, server.name, only);
      const byOff = plan === "off" && planOf(server.entry, server.name, head, only, new Set(), server.from, server.file) !== "off";
      this.planned.set(server.name, { server, plan, config, ...(byOff ? { byOff } : {}) });
      if (plan === "start") connect.push({ name: server.name, config, source: server.from === "project" ? project : mcpConfigPath(), scope: server.from === "project" ? "project" : "global" });
    }
    // What is wrong with the file shows on the settings page; a notice in every chat that starts says nothing new.
    for (const error of read.errors) console.warn(`[portal] MCP configuration: ${error}`);
    return { servers: connect, errors: [], autoEnableCodemode: false };
  }

  /**
   * The chat's switches changed. A server that was left off because every tool of it was switched off is reached as the
   * chat's head says once one of them is on, without a reload: one the head has with the chat is connected now, as it would
   * have been at the start. (A lazy one is never off by its switches: see planOf.)
   */
  switched(): void {
    const head = this.options.head();
    const only = this.options.codemodeOnly();
    const off = this.options.off();
    for (const [name, one] of this.planned) {
      if (one.plan !== "off" || !one.byOff) continue;
      const plan = planOf(one.server.entry, name, head, only, off, one.server.from, one.server.file);
      if (plan === "off") continue;
      const config = configFor(one.server.entry, plan, head, name, only);
      this.planned.set(name, { server: one.server, plan, config });
      if (plan !== "start") continue;
      try {
        this.pi?.registerMcpServer(name, config);
      } catch (e) {
        console.warn(`[portal] could not start the MCP server ${name}: ${(e as Error).message}`);
      }
    }
  }

  /** The names of the servers this chat's configuration has, enabled or not: what a tool's namespace is told apart by. */
  names(): string[] {
    return [...this.planned.keys()];
  }

  /** The server a tool is of, as configured: by its namespace. The folded name where it is a server the portal does not have. */
  serverOf(tool: unknown): string | undefined {
    const space = mcpNamespaceOf(tool);
    if (!space) return undefined;
    return serversOfNamespace(space, this.names())[0] ?? space.slice("mcp__".length);
  }

  /** Whether the chat has any server it keeps lazy: the tool to reach them is wanted even when none is registered yet. */
  hasLazy(): boolean {
    return [...this.planned.values()].some((one) => one.plan === "lazy");
  }

  /** Whether this server is one the chat connects when a tool of it is first wanted. */
  isLazy(server: string): boolean {
    return this.planned.get(server)?.plan === "lazy";
  }

  /** The servers of the chat that are lazy, by name. */
  lazyServers(): string[] {
    return [...this.planned].filter(([, one]) => one.plan === "lazy").map(([name]) => name);
  }

  private tools(): any[] {
    return this.options.session()?.getAllTools?.() ?? this.pi?.getAllTools?.() ?? [];
  }

  /** Whether tools of this server are registered with pi and reachable now. */
  private up(server: string): boolean {
    const space = mcpNamespace(server);
    return this.tools().some((tool) => mcpNamespaceOf(tool) === space && tool.exposure !== "hidden");
  }

  /**
   * Whether pi's resource tools reach this server now: it is connected and offers resources. pi says which servers those are
   * nowhere but in the tool itself, which refuses a server it does not reach before it asks anything; asked with a signal
   * that is already aborted, it asks the server nothing either way.
   */
  private async servesResources(server: string): Promise<boolean> {
    const tool = this.options.session()?.getToolDefinition?.("list_mcp_resources");
    if (typeof tool?.execute !== "function") return false;
    const stop = new AbortController();
    stop.abort();
    try {
      await tool.execute("portal-mcp-probe", { server }, stop.signal);
      return true;
    } catch (e) {
      return !/has no resources/.test(String((e as Error)?.message ?? e));
    }
  }

  /** Whether the server is connected: a tool of it is registered, or, for one that offers only resources, the resource tools reach it. */
  private async reached(server: string): Promise<boolean> {
    return this.up(server) || (await this.servesResources(server));
  }

  /** What is remembered of a server of this chat, where it is the user's and the entry is the one it was read from. */
  private known(server: string): CachedServer | undefined {
    const planned = this.planned.get(server);
    return planned && planned.server.from === "user" ? cachedFor(server, planned.server.file ?? planned.server.entry, planned.server.entry) : undefined;
  }

  /**
   * What each server of the chat offered, as pi has registered it, kept in the cache. Called when something may have
   * changed: a server connected, a prompt starts.
   */
  snapshot(): void {
    let tools: any[];
    try {
      tools = this.tools();
    } catch {
      return;
    }
    const session = this.options.session();
    const by = new Map<string, CachedTool[]>();
    for (const tool of tools) {
      const server = this.serverOf(tool);
      if (!server || tool.exposure === "hidden" || isResourceTool(String(tool.name))) continue;
      const label = String(session?.getToolDefinition?.(tool.name)?.label ?? "");
      const original = label.startsWith(`${server}/`) ? label.slice(server.length + 1) : label.includes("/") ? label.slice(label.indexOf("/") + 1) : String(tool.name);
      const description = typeof tool.description === "string" ? tool.description : "";
      const annotations = tool.annotations && typeof tool.annotations === "object" ? { ...tool.annotations } : undefined;
      by.set(server, [...(by.get(server) ?? []), { name: String(tool.name), original, description, parameters: tool.parameters ?? { type: "object", properties: {} }, tokens: declarationTokens(String(tool.name), description, tool.parameters), ...(annotations ? { annotations } : {}) }]);
    }
    for (const [server, found] of by) {
      const planned = this.planned.get(server);
      // Only the user's servers are remembered: a project's is somebody else's, and a server of that name in another chat
      // would be shown its tools and descriptions as its own. Nor is one whose tools a project's override took away: what
      // this chat saw is less than the file's entry offers.
      const entry = planned && rememberedEntry(planned.server);
      if (!entry) continue;
      const sorted = found.sort((a, b) => a.name.localeCompare(b.name));
      try {
        rememberServerTools(server, configHash(entry), sorted);
      } catch (e) {
        console.error(`[portal] could not keep the tools of ${server}: ${(e as Error).message}`);
      }
    }
    for (const [server, one] of this.planned) if (one.plan === "start" && rememberedEntry(one.server) && !this.probed.has(server)) void this.noteResources(server, one);
  }

  /**
   * Whether a server the chat started with it offers resources, kept with its tools: connect() asks it of a lazy server it
   * starts, and a later chat that has this one lazy finds the resource tools from the cache before it runs. Asked once a
   * session, or again while it has not connected.
   */
  private async noteResources(server: string, one: Planned): Promise<void> {
    const entry = rememberedEntry(one.server);
    if (!entry) return;
    this.probed.add(server);
    const has = await this.servesResources(server);
    if (!has) {
      if (!this.up(server)) this.probed.delete(server);
      return;
    }
    try {
      rememberServerTools(server, configHash(entry), this.known(server)?.tools ?? [], true);
    } catch (e) {
      console.error(`[portal] could not keep what ${server} offers: ${(e as Error).message}`);
    }
  }

  /** The tools of the chat's lazy servers that are not running, as the cache has them: found and described like the others, started when called. */
  offline(): OfflineTool[] {
    const out: OfflineTool[] = [];
    const all = this.tools();
    const registered = new Set(all.map((tool) => String(tool.name)));
    // pi leaves the resource tools registered, hidden, while no server that has resources is connected.
    const reachable = new Set(all.filter((tool) => tool.exposure !== "hidden").map((tool) => String(tool.name)));
    let resources: string | undefined;
    for (const [server, one] of this.planned) {
      if (one.plan !== "lazy") continue;
      const known = this.known(server);
      for (const tool of known?.tools ?? []) {
        if (registered.has(tool.name) && this.up(server)) continue;
        out.push({ name: tool.name, description: tool.description, parameters: tool.parameters, server });
      }
      if (known?.resources) resources ??= server;
    }
    // A lazy server known to offer resources: the resource tools are found before any server that has them runs.
    if (resources !== undefined) for (const tool of RESOURCE_STAND_INS) if (!reachable.has(tool.name)) out.push({ ...tool, server: resources });
    return out;
  }

  /**
   * The namespace of a tool that is not registered, from what the portal remembers of the servers: the guard judges whose
   * words a search quotes by it, and a tool of a server that is not running is not in pi's registry to ask.
   */
  namespaceOfCached(name: string): string | undefined {
    for (const server of this.planned.keys()) if (this.known(server)?.tools.some((tool) => tool.name === name)) return mcpNamespace(server);
    return undefined;
  }

  /** The tool the adapter called this name, where a lazy server's cache has one: a chat from before has it in its history. */
  alias(name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const server of this.planned.keys()) {
      for (const tool of this.known(server)?.tools ?? []) if (adapterName(server, tool.original).toLowerCase() === wanted) return tool.name;
    }
    return undefined;
  }

  /** The server whose cache has a tool of this name, among the chat's lazy ones. */
  private lazyServerOf(name: string): string | undefined {
    for (const [server, one] of this.planned) {
      if (one.plan === "lazy" && this.known(server)?.tools.some((tool) => tool.name === name)) return server;
    }
    return undefined;
  }

  /**
   * Start a lazy server: register it with pi, which connects it in the background, and wait until its tools exist (pi has
   * no await for that). Throws with what to tell the model where it does not connect in time. One start per server at a time.
   */
  async connect(server: string, signal?: AbortSignal): Promise<void> {
    const planned = this.planned.get(server);
    if (!planned || planned.plan !== "lazy") return;
    if (this.life.signal.aborted) return;
    this.started.set(server, Date.now());
    if (await this.reached(server)) return;
    // The caller's signal, and the end of the session: a connect does not poll for a chat that has gone.
    const stop = signal ? AbortSignal.any([signal, this.life.signal]) : this.life.signal;
    let start = this.starting.get(server);
    if (!start) {
      start = (async () => {
        if (!this.pi) throw new Error("MCP is not available in this chat");
        this.pi.registerMcpServer(server, planned.config);
        const from = Date.now();
        while (!(await this.reached(server))) {
          if (stop.aborted) throw new Error(`Stopped while the MCP server "${server}" was starting.`);
          if (Date.now() - from > this.connectWait) {
            throw new Error(`The MCP server "${server}" did not connect within ${Math.round(this.connectWait / 1000)} seconds. It may need a sign-in (\`pi mcp login ${server}\` in a terminal), or it may be down.`);
          }
          await sleep(25, stop);
        }
        this.failed.delete(server);
        this.snapshot();
        // A server that offers no tool (only resources) is remembered too, so that a search does not wait for it again, and
        // whether it offers resources, so that the search finds the resource tools before it runs.
        const entry = rememberedEntry(planned.server);
        if (entry) {
          try {
            const hash = configHash(entry);
            rememberServerTools(server, hash, this.known(server)?.tools ?? [], await this.servesResources(server));
          } catch (e) {
            console.error(`[portal] could not keep what ${server} offers: ${(e as Error).message}`);
          }
        }
      })().then(undefined, (error: Error) => {
        this.failed.set(server, error.message);
        throw error;
      }).finally(() => this.starting.delete(server));
      this.starting.set(server, start);
    }
    await start;
  }

  /**
   * Wait for the server of a tool that is not registered to be up: the call of a tool a search found in the cache. For a
   * resource tool, the lazy server its call names.
   */
  async ensure(name: string, signal?: AbortSignal, args?: unknown): Promise<void> {
    if (isResourceTool(name)) {
      const wanted = args && typeof args === "object" ? (args as { server?: unknown }).server : undefined;
      if (typeof wanted === "string" && this.isLazy(wanted)) await this.connect(wanted, signal);
      return;
    }
    const server = this.lazyServerOf(name);
    if (!server) return;
    await this.connect(server, signal);
    // Up, but this tool is not there: the server no longer offers it.
    if (!this.tools().some((tool) => String(tool.name) === name)) throw new Error(`The MCP server "${server}" no longer has a tool "${name}": search again.`);
  }

  /** Start, in the background, the servers of these tools: a search found them, and the call that follows then finds them up. */
  warm(names: readonly string[]): void {
    const servers = new Set(names.map((name) => this.lazyServerOf(name)).filter((server): server is string => server !== undefined));
    for (const server of servers) this.connect(server).catch((e) => !this.life.signal.aborted && console.warn(`[portal] ${(e as Error).message}`));
  }

  /**
   * The lazy servers that have never connected: nothing is known of their tools, so a search could not find them. Connected,
   * with the wait, so that this search does.
   */
  async learn(signal?: AbortSignal): Promise<string[]> {
    const unknown = this.lazyServers().filter((server) => !this.known(server));
    // One that did not connect is not waited for again by every search: it is said, and a call of its tool tries it again.
    await Promise.allSettled(unknown.filter((server) => !this.failed.has(server)).map((server) => this.connect(server, signal)));
    return unknown.filter((server) => this.failed.has(server)).map((server) => this.failed.get(server)!);
  }

  /** Stop the servers the portal started that nobody has used for a while. */
  private stopIdle(): void {
    const now = Date.now();
    for (const [server, last] of this.started) {
      if (now - last < this.idle || [...this.running.values()].includes(server)) continue;
      this.started.delete(server);
      try {
        this.pi?.unregisterMcpServer(server);
      } catch (e) {
        console.warn(`[portal] could not stop the MCP server ${server}: ${(e as Error).message}`);
      }
    }
  }

  /** The extension: what is the portal's to do next to pi's own MCP support, whose handlers load before it. */
  private extension(pi: any): void {
    this.pi = pi;
    pi.on("session_start", () => {
      this.life = new AbortController();
      // pi's runtime of the old session is gone with its servers: nothing is started that this knows of.
      this.failed.clear();
      this.probed.clear();
      this.started.clear();
      this.starting.clear();
      this.running.clear();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.stopIdle(), this.options.idleCheckMs ?? IDLE_CHECK_MS);
      this.timer.unref?.();
    });
    pi.on("session_shutdown", () => {
      this.life.abort();
      clearInterval(this.timer);
      this.timer = undefined;
      this.started.clear();
      this.starting.clear();
      this.running.clear();
    });
    // pi writes its list of servers into the prompt, and the list changes when a server connects: the head would change
    // with it. The chat's head has the line that names what is lazy; this one is loaded after pi's own handler, so it has the
    // last word.
    pi.on("before_agent_start", (event: any) => {
      const sections = event?.systemPromptOptions?.sections;
      if (sections && typeof sections === "object") delete sections.mcp_servers;
      this.snapshot();
    });
    pi.on("agent_end", () => this.snapshot());
    // What is used is not idle. A resource tool is no server's own: its call names the server it reads.
    pi.on("tool_call", (event: any) => {
      const named = isResourceTool(String(event.toolName)) ? event.input?.server : undefined;
      const server = typeof named === "string" ? named : this.serverOf(this.options.session()?.getToolDefinition?.(event.toolName));
      if (!server || !this.started.has(server)) return;
      this.started.set(server, Date.now());
      if (typeof event.toolCallId === "string") this.running.set(event.toolCallId, server);
    });
    const ended = (event: any) => {
      if (typeof event.toolCallId !== "string") return;
      const server = this.running.get(event.toolCallId);
      if (!this.running.delete(event.toolCallId)) return;
      if (server && this.started.has(server)) this.started.set(server, Date.now());
    };
    pi.on("tool_result", ended);
    // A call the guard refused ends without a result.
    pi.on("tool_execution_end", ended);
  }
}
