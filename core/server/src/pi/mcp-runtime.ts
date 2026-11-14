import path from "node:path";
import { chatServers, entryEnabled, mcpConfigPath, type ChatServer } from "../api/mcp.js";
import { configHash, declarationTokens, cachedServer, cachedServers, rememberServerTools, type CachedTool } from "../mcp-tools.js";
import { mcpNamespace, resolvedEntry } from "../mcp-config.js";
import { isResourceTool, mcpNamespaceOf, serversOfNamespace } from "./mcp-origin.js";
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
}

/** The exposure of `toolExposure` entries the chat keeps: hidden tools stay hidden; the chat decides everything else. */
function hiddenOnly(toolExposure: unknown): Record<string, string> | undefined {
  if (!toolExposure || typeof toolExposure !== "object" || Array.isArray(toolExposure)) return undefined;
  const hidden = Object.entries(toolExposure as Record<string, unknown>).filter(([, one]) => one === "hidden");
  return hidden.length ? Object.fromEntries(hidden.map(([tool]) => [tool, "hidden"])) : undefined;
}

/**
 * How a chat treats a server: connected with the chat (`start`), connected when a tool of it is first wanted (`lazy`), or
 * not at all (`off`: the file says it is off, or hides it, or every tool the portal knows of it is switched off in this
 * chat). Decided from the chat's frozen head and the tools it has off, never from what is connected now.
 */
export function planOf(entry: Record<string, unknown>, name: string, head: Pick<LazyHead, "lazy" | "direct">, codemodeOnly: boolean, off: ReadonlySet<string>): Plan {
  if (!entryEnabled(entry) || resolvedEntry(entry).exposure === "hidden") return "off";
  const known = cachedServer(name)?.tools ?? [];
  if (known.length && known.every((tool) => off.has(tool.name))) return "off";
  if (codemodeOnly) return "start";
  const prefix = toolEntry(`${mcpNamespace(name)}__`);
  // A tool of it that is kept in the list by its own entry needs the server with the chat.
  if (head.direct.some((entry) => entry.startsWith(prefix))) return "start";
  return headLazy(head, { name: "", set: name }) ? "lazy" : "start";
}

/** The config pi is given for a server: the chat's exposure, and the tools the file hides. */
function configFor(entry: Record<string, unknown>, plan: Plan, head: Pick<LazyHead, "direct">, name: string, codemodeOnly: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = { ...resolvedEntry(entry) };
  delete config.disabled;
  const kept = hiddenOnly(config.toolExposure);
  delete config.toolExposure;
  if (kept) config.toolExposure = kept;
  // Where everything is reached through the code tool, the servers the chat would have found are scripts' to call.
  const pinned = head.direct.includes(name) || head.direct.some((one) => one.startsWith(toolEntry(`${mcpNamespace(name)}__`)));
  config.exposure = codemodeOnly && plan === "start" && !pinned ? "codemode" : "direct";
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
  private timer?: ReturnType<typeof setInterval>;
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
      { name: "mcp", factory: mcp },
      { name: "mcp-gate", factory: (pi) => this.extension(pi) },
    ];
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
      const plan = planOf(server.entry, server.name, head, only, off);
      const config = configFor(server.entry, plan, head, server.name, only);
      this.planned.set(server.name, { server, plan, config });
      if (plan === "start") connect.push({ name: server.name, config, source: server.from === "project" ? project : mcpConfigPath(), scope: server.from === "project" ? "project" : "global" });
    }
    // What is wrong with the file shows on the settings page; a notice in every chat that starts says nothing new.
    for (const error of read.errors) console.warn(`[portal] MCP configuration: ${error}`);
    return { servers: connect, errors: [], autoEnableCodemode: false };
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
      if (!planned) continue;
      const sorted = found.sort((a, b) => a.name.localeCompare(b.name));
      try {
        rememberServerTools(server, configHash(planned.server.entry), sorted);
      } catch (e) {
        console.error(`[portal] could not keep the tools of ${server}: ${(e as Error).message}`);
      }
    }
  }

  /** The tools of the chat's lazy servers that are not running, as the cache has them: found and described like the others, started when called. */
  offline(): OfflineTool[] {
    const out: OfflineTool[] = [];
    const registered = new Set(this.tools().map((tool) => String(tool.name)));
    for (const [server, one] of this.planned) {
      if (one.plan !== "lazy") continue;
      for (const tool of cachedServer(server)?.tools ?? []) {
        if (registered.has(tool.name) && this.up(server)) continue;
        out.push({ name: tool.name, description: tool.description, parameters: tool.parameters, server });
      }
    }
    return out;
  }

  /**
   * The namespace of a tool that is not registered, from what the portal remembers of the servers: the guard judges whose
   * words a search quotes by it, and a tool of a server that is not running is not in pi's registry to ask.
   */
  namespaceOfCached(name: string): string | undefined {
    for (const [server, entry] of Object.entries(cachedServers())) if (entry.tools.some((tool) => tool.name === name)) return mcpNamespace(server);
    return undefined;
  }

  /** The tool the adapter called this name, where a lazy server's cache has one: a chat from before has it in its history. */
  alias(name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [server, entry] of Object.entries(cachedServers())) {
      for (const tool of entry.tools) if (adapterName(server, tool.original).toLowerCase() === wanted) return tool.name;
    }
    return undefined;
  }

  /** The server whose cache has a tool of this name, among the chat's lazy ones. */
  private lazyServerOf(name: string): string | undefined {
    for (const [server, one] of this.planned) {
      if (one.plan === "lazy" && cachedServer(server)?.tools.some((tool) => tool.name === name)) return server;
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
    this.started.set(server, Date.now());
    if (this.up(server)) return;
    let start = this.starting.get(server);
    if (!start) {
      start = (async () => {
        if (!this.pi) throw new Error("MCP is not available in this chat");
        this.pi.registerMcpServer(server, planned.config);
        const from = Date.now();
        while (!this.up(server)) {
          if (signal?.aborted) throw new Error(`Stopped while the MCP server "${server}" was starting.`);
          if (Date.now() - from > this.connectWait) {
            throw new Error(`The MCP server "${server}" did not connect within ${Math.round(this.connectWait / 1000)} seconds. It may need a sign-in (\`pi mcp login ${server}\` in a terminal), or it may be down.`);
          }
          await sleep(25, signal);
        }
        this.snapshot();
      })().finally(() => this.starting.delete(server));
      this.starting.set(server, start);
    }
    await start;
  }

  /** Wait for the server of a tool that is not registered to be up: the call of a tool a search found in the cache. */
  async ensure(name: string, signal?: AbortSignal): Promise<void> {
    const server = this.lazyServerOf(name);
    if (!server) return;
    await this.connect(server, signal);
    // Up, but this tool is not there: the server no longer offers it.
    if (!this.tools().some((tool) => String(tool.name) === name)) throw new Error(`The MCP server "${server}" no longer has a tool "${name}": search again.`);
  }

  /** Start, in the background, the servers of these tools: a search found them, and the call that follows then finds them up. */
  warm(names: readonly string[]): void {
    const servers = new Set(names.map((name) => this.lazyServerOf(name)).filter((server): server is string => server !== undefined));
    for (const server of servers) this.connect(server).catch((e) => console.warn(`[portal] ${(e as Error).message}`));
  }

  /**
   * The lazy servers that have never connected: nothing is known of their tools, so a search could not find them. Connected,
   * with the wait, so that this search does.
   */
  async learn(signal?: AbortSignal): Promise<void> {
    const unknown = this.lazyServers().filter((server) => !cachedServer(server)?.tools.length);
    await Promise.allSettled(unknown.map((server) => this.connect(server, signal)));
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
      // pi's runtime of the old session is gone with its servers: nothing is started that this knows of.
      this.started.clear();
      this.starting.clear();
      this.running.clear();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.stopIdle(), this.options.idleCheckMs ?? IDLE_CHECK_MS);
      this.timer.unref?.();
    });
    pi.on("session_shutdown", () => {
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
    // What is used is not idle.
    pi.on("tool_call", (event: any) => {
      const server = this.serverOf(this.options.session()?.getToolDefinition?.(event.toolName));
      if (!server || !this.started.has(server)) return;
      this.started.set(server, Date.now());
      if (typeof event.toolCallId === "string") this.running.set(event.toolCallId, server);
    });
    const ended = (event: any) => {
      if (typeof event.toolCallId !== "string" || !this.running.delete(event.toolCallId)) return;
      const server = this.serverOf(this.options.session()?.getToolDefinition?.(event.toolName));
      if (server && this.started.has(server)) this.started.set(server, Date.now());
    };
    pi.on("tool_result", ended);
    // A call the guard refused ends without a result.
    pi.on("tool_execution_end", ended);
  }
}
