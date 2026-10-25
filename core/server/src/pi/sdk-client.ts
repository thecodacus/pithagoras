import { acceptPrompt } from "./accept-prompt.js";
import { AUDIO_MESSAGE_PREFIX, AudioRule, VoiceFirstTurn, audioMessage, spokenIn } from "./voice-first.js";
import { sandboxTools } from "../sandbox/tools.js";
import { sandboxOn } from "../sandbox/policy.js";
import { projectSkillPaths, withoutFolderMcp } from "../sandbox/project-trust.js";
import { agentSkillsDir, skillsLine } from "../agent-skills.js";
import { agentFilesAt, agentFor, memoryHeldAt } from "../project-agent.js";
import { crossModelThinkingExtension } from "./cross-model-thinking.js";
import { BROWSER_READING_RULE, BROWSER_SCREENSHOT_RULE } from "./browser-mcp-rules.js";
import { bundledPath } from "../bundled.js";
import { type AgentUse, baseDir, readBytes } from "../workspace-files.js";
import { agentOf } from "../agents.js";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DraftStore, LoadError, PiClient, PiCommand, PiState, PiStats, PiTool, PromptTaken } from "./types.js";
import type { ImageContent } from "../prompt-images.js";
import { routineTools } from "./routine-tools.js";
import { reportTool, reportToFor } from "./report-tool.js";
import { OUTSIDE_CONTENT_GUIDELINE, declaredFiles, declaredGuard, guardExtension, type DeclaredGuard } from "./guard.js";
import { CODEMODE_TOOL, CODEMODE_TOOLS, codemodeExtension } from "./codemode.js";
import { findSessionFile } from "./session-file.js";
import { CONTEXT_FILES, SHARED_FILES } from "./context-files.js";
import { heartbeatTool } from "./heartbeat-tool.js";
import { ToolsGateway } from "./tools-gateway.js";
import { CALLED_TOOL_KEY, GATEWAY_TOOL, calledThrough } from "./tools-gateway-names.js";
import { askPrimaryTool } from "./ask-primary.js";
import { ASK_QUESTION_SOURCE, askQuestionTool } from "./ask-question.js";
import { SANDBOX } from "./inline-extensions.js";
import { proxyBaseUrl } from "../llama-progress.js";
import { bridgeSubagents, SUBAGENT_INPUT, SUBAGENT_STOP, type Bridge } from "../subagent-protocol.js";
import { bridgeExtensionUi, UI_RECEIVE } from "../extension-ui.js";
import { hostExtensions } from "../extension-host.js";
import { adapterTool, contextWindowFor, getSkipThinkingProviders, getVoiceInstructions, getVoiceModel, questionWaitMs, voiceSpeaks } from "../db.js";
import { configStamp, isLlamaProvider } from "../providers.js";
import { rereadConfig } from "./model-runtime.js";
import { browserServers } from "../api/mcp.js";
import { PI_BUILT_IN_TOOLS } from "../tool-policy.js";

/** A message on its way into pi: see SdkPiClient.prompt(). */
interface Handoff {
  /** Its words as handed to pi. */
  text: string;
  /** The queue it goes into if a run is going. */
  lane: "steering" | "followUp";
  /** Its words as pi queued them, once it has. */
  queued?: string;
}

/** One failure of a load, told from another: the same failure at the next load is not new. */
const failureKey = (failure: LoadError) => `${failure.path}\n${failure.error}`;

function asArray(v: any): any[] {
  const resolved = typeof v === "function" ? v() : v;
  return Array.isArray(resolved) ? resolved : [];
}

/**
 * While something holds the agent's memory (memory-holder.ts), MEMORY.md is
 * not read: two memories would drift apart, and the file would be the stale
 * one. It stays where it is, and is read again once that lets it go. Asked for
 * the place the chat works in, since a project can do without it.
 */
const filesFor = (cwd: string, role?: string) =>
  !role || role === "primary" ? (memoryHeldAt(cwd) ? CONTEXT_FILES.filter((f) => f !== "MEMORY.md") : CONTEXT_FILES) : SHARED_FILES;

/** Said in place of MEMORY.md, to a chat with the person, while something holds the agent's memory: the holder's rule. */
export function memoryRule(cwd: string, role?: string): string[] {
  const holder = !role || role === "primary" ? memoryHeldAt(cwd) : undefined;
  return holder ? [holder.rule] : [];
}

/**
 * Where the agent's own files are read from for a chat working in `cwd`: the
 * folder itself, which is the agent's home for a chat there. A chat in a
 * project that is linked to an agent reads the agent's home instead, and the
 * project's folder, which the agent can write to, is not a place to take its
 * soul from. A blank-slate project has none: only its AGENTS.md, which pi reads.
 */
const filesIn = agentFilesAt;

/**
 * pi's own theme, for extensions that style text with it even when nothing
 * will draw it — as pi's no-UI context hands them. pi's CLI loads it on start;
 * the SDK does not, and the theme object pi hands out throws on every read
 * until it has. Loaded once, with the SDK, then read where pi keeps it.
 */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
let themeLoaded: string | null = null;
export function loadTheme(
  pi: { initTheme?: (name?: string, watch?: boolean) => void; SettingsManager?: { create(cwd: string): { getTheme(): string | undefined } } },
  cwd = process.cwd(),
) {
  // The one set in pi's settings, as pi's CLI loads it; its default without one.
  let name: string | undefined;
  try {
    name = pi.SettingsManager?.create(cwd).getTheme();
  } catch {
    // Settings that cannot be read leave the default.
  }
  if (themeLoaded === (name ?? "")) return;
  themeLoaded = name ?? "";
  try {
    pi.initTheme?.(name, false);
  } catch {
    try {
      pi.initTheme?.(undefined, false);
    } catch {
      // An extension reading it gets undefined, as it did before.
    }
  }
}
const piTheme = () => (globalThis as Record<symbol, unknown>)[THEME_KEY];

/**
 * A file of the agent's in the folder `from`, as text, or nothing.
 *
 * Read from a descriptor opened without following a link, and only where the
 * agents `as` names could read it themselves (see AgentUse in workspace-files.ts).
 * With the sandbox on the portal reads as root, and the agent can leave a link
 * in its home in place of MEMORY.md that leads to another agent's files or to
 * the portal's own: what it leads to would be handed to the agent as its own.
 * A file that is not there, is a link or is closed to the agent is nothing, as
 * an unreadable one always was: the session should still start. Nobody named,
 * with the sandbox on, is a refusal, as it is there. With `head` 0 nothing is
 * read: what is answered is only that there is one.
 */
function readOwn(from: string, name: string, as: AgentUse, head?: number): string | undefined {
  try {
    return readBytes(baseDir(from), name, { direct: true, likeParent: true, ...as, head }).bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

/** A file read for the chat `chat`: as its agent, as the sandbox runs it. */
const forChat = (chat: string | undefined): AgentUse => ({ chats: chat ? [chat] : [] });

/**
 * Whom the agent's files in `from` are read as for the chat `chat`, working in
 * `cwd`: the chat's agent, where they are in the chat's folder. A chat in a
 * project linked to an agent reads them in that agent's home, which the
 * sandbox closes to every other agent, the one the project's chats run as
 * among them: there they are read as the agent whose home it is, which is the
 * one that can leave a link or a file there.
 */
const readerOf = (cwd: string, from: string, chat: string | undefined): AgentUse => {
  if (from === cwd) return forChat(chat);
  const owner = agentOf(from);
  return { agents: owner ? [owner.id] : [] };
};

/**
 * Files pi should treat as context on top of the ones it finds itself.
 *
 * Only picked up where they exist, so a task workspace is unaffected and the
 * agent's home directory gets its character, its user and its memory without
 * anything being generated. Who may see which of them is settled in
 * context-files.ts, which the guard reads as well. Read for the chat `chat`
 * (see readerOf).
 */
export function extraContextFiles(cwd: string, role?: string, chat?: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const from = filesIn(cwd);
  if (!from) return out;
  const as = readerOf(cwd, from, chat);
  for (const name of filesFor(cwd, role)) {
    const content = readOwn(from, name, as);
    if (content !== undefined) out.push({ path: path.join(from, name), content });
  }
  return out;
}

/**
 * pi's own context files (AGENTS.md or CLAUDE.md, the first one a folder has,
 * from the chat's folder up to `/`), held to what the agent's files are.
 *
 * pi reads them by their path, following links, as the portal's user, and the
 * agent can leave a link as AGENTS.md in a folder it writes in that leads to
 * another agent's files or to /root/.ssh. So each is read again as readOwn
 * reads, and what is handed on is that text, not pi's: one that is a link now,
 * or is closed to the agent of `chat`, is dropped. The one in pi's agent folder
 * is the portal's own, which no agent can write and the sandbox closes to all
 * of them: it stays as pi read it.
 */
export function agentsFilesFor(files: { path: string; content: string }[], agentDir: string, chat?: string): { path: string; content: string }[] {
  const portals = path.resolve(agentDir);
  return files.flatMap((file) => {
    if (path.dirname(file.path) === portals) return [file];
    const content = readOwn(path.dirname(file.path), path.basename(file.path), forChat(chat));
    // Without a byte order mark, as pi hands on what it read.
    return content === undefined ? [] : [{ ...file, content: content.replace(/^\uFEFF/, "") }];
  });
}

/**
 * A short anchor saying the files are the agent's own: the ones handed to it now.
 *
 * Each file opens with its own instruction block, so this does not repeat them
 * — it exists because a context file is otherwise presented as reference
 * material, and the model read its own identity as notes about a third party.
 * One line at system level is enough to change what they are.
 */
export function ownFiles(cwd: string, role?: string, chat?: string): string[] {
  const from = filesIn(cwd);
  if (!from) return [];
  // The ones that are handed over: a link, or a file closed to the agent, is not named either.
  const as = readerOf(cwd, from, chat);
  const present = filesFor(cwd, role).filter((name) => readOwn(from, name, as, 0) !== undefined);
  // In a project the files are not in the working directory: they are the agent's the project works with.
  const where = from === cwd ? "in your working directory" : "of the agent this project works with";
  return present.length
    ? [`${present.join(", ")} ${where} are yours, not reference material about someone else. Each opens with a block saying what it is for; follow it.`]
    : [];
}

/**
 * Whether a Playwright MCP server is attached to a running browser (see browserServers). A file that cannot be read or parsed says
 * there is none: this runs while the options of the resource loader are made, and a failure there leaves
 * the chat without the loader, and with it without every extension of the portal's, the guard among them.
 */
function hasPlaywrightBrowser(): boolean {
  try {
    return browserServers().length > 0;
  } catch {
    return false;
  }
}

function framing(): string[] {
  // The rule for spoken replies is not here: the resource loader adds it, to
  // the conversations that have had voice (see PortalLoader and AudioRule).
  // Nor the line naming the agent's own files: which there are can change
  // under an open chat (MEMORY.md is not read while something holds the
  // memory), so it is asked for each time the prompt is built — see ownFiles.
  // These are a Playwright MCP's rules, so they are said only where such a server is attached: a package's
  // browser tools carry their own as promptGuidelines, which pi includes only while they are active.
  const lines: string[] = hasPlaywrightBrowser() ? [BROWSER_READING_RULE, BROWSER_SCREENSHOT_RULE] : [];
  // The bracketed-ref trap that used to need a line here is handled in the
  // guard now, which normalises the argument for every session whether it
  // reads this or not. Nothing to say, so nothing spent saying it.
  return lines;
}

/** pi's resource loader with the rule for spoken replies: see portalLoader. */
let PortalLoader: (new (options: unknown, rule: AudioRule, said?: () => string[], more?: () => unknown[]) => any) | undefined;

/**
 * pi's resource loader, adding the rule for spoken replies to what pi appends
 * to its system prompt where the conversation has had voice.
 *
 * Asked each time pi builds the prompt, so the rule is part of pi's own prompt
 * and stays through every rebuild. Made once, the first time pi is loaded:
 * pi is imported lazily, so the class cannot exist before.
 */
function portalLoader(pi: any): new (options: unknown, rule: AudioRule, said?: () => string[], more?: () => unknown[]) => any {
  return (PortalLoader ??= class extends pi.DefaultResourceLoader {
    private readonly rule: AudioRule;
    /** Lines that depend on how the portal is set up now, asked each time like the rule. */
    private readonly said: () => string[];
    /** The skill paths the portal gives, before a folder's own are added to them. */
    private readonly portalSkillPaths: string[];
    /** The portal's own extensions, as they were given; what the server halves add is asked for at each load (`more`). */
    private readonly portalFactories: unknown[];
    private readonly more: () => unknown[];
    constructor(options: unknown, rule: AudioRule, said: () => string[] = () => [], more: () => unknown[] = () => []) {
      super(options);
      this.rule = rule;
      this.said = said;
      this.portalSkillPaths = [...((options as { additionalSkillPaths?: string[] }).additionalSkillPaths ?? [])];
      this.portalFactories = [...this.extensionFactories];
      this.more = more;
    }
    /**
     * While the sandbox is on, the chat's folder is the agent's to write, and
     * pi runs inside the portal: its extensions, packages and settings are not
     * taken from there, and its skills are (see sandbox/project-trust.ts).
     * Decided at each load, as switching the sandbox reloads the open chats.
     */
    async reload(options?: unknown): Promise<void> {
      const sandboxed = sandboxOn();
      this.settingsManager.setProjectTrusted(!sandboxed);
      this.additionalSkillPaths = [...this.portalSkillPaths, ...(sandboxed ? projectSkillPaths(this.cwd) : [])];
      // The server halves as they are now: one installed since the chat's pi started is in it after a reload.
      this.extensionFactories = [...this.portalFactories, ...this.more()];
      return super.reload(options);
    }
    getAppendSystemPrompt(): string[] {
      return [...super.getAppendSystemPrompt(), ...this.said(), ...(this.rule?.lines() ?? [])];
    }
    /** What is appended without the rule: where the rule goes after. */
    appendedByPi(): string {
      return [...super.getAppendSystemPrompt(), ...this.said()].join("\n\n");
    }
  });
}

/** Skills shipped with the portal, loaded from the image rather than installed. */
export function builtinSkillsDir(): string | undefined {
  return bundledPath("skills");
}

/**
 * Route a llama.cpp model through the portal's progress proxy.
 *
 * Only llama.cpp: it is the one provider that reports how far along a prompt
 * is, and the one where prefill is slow enough to be worth showing. Everything
 * else is returned untouched, and so is a llama model when there is no proxy —
 * a missed indicator is not a reason to fail to start.
 */
export function viaProgressProxy<T extends { provider?: string; baseUrl?: string }>(
  model: T | undefined,
  sessionId: string | undefined,
): T | undefined {
  if (!model || !sessionId || !model.baseUrl || !isLlamaProvider(model.provider)) return model;
  // Already routed. Wrapping it again would nest one proxy path inside another.
  if (model.baseUrl.includes("/s/" + sessionId)) return model;
  const rerouted = proxyBaseUrl(sessionId, model.baseUrl);
  if (!rerouted) return model;
  console.log(`[portal] prefill progress for ${sessionId}: ${model.baseUrl} -> ${rerouted}`);
  return { ...model, baseUrl: rerouted };
}

/**
 * Who a tool belongs to, said the way a person would.
 *
 * pi's own `source` is the kind of place it came from — "builtin", "auto",
 * "inline" — which groups four unrelated packages under one word. The name is
 * in the path: the package for anything installed, the file for a loose
 * extension, and pi's own angle-bracketed markers for the rest.
 */
function sourceLabel(info: any): string {
  const path = typeof info?.path === "string" ? info.path : "";

  // pi writes its own as builtin:read (<builtin:read> before pi 1.1) and the
  // portal's inline ones as <inline:sandbox>. The second is worth naming; the
  // first is the agent.
  const marker = /^(?:<(builtin|inline):([^>]+)>|(builtin):.+)$/.exec(path);
  if (marker) return marker[1] === "inline" ? marker[2] : "built in";

  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path);
  if (pkg) return pkg[1];

  if (path) {
    const parts = path.split("/").filter(Boolean);
    const file = parts.pop() ?? "";
    const name = file.replace(/\.[cm]?[jt]sx?$/, "");
    // An extension in a directory of its own is named by the directory, which
    // is what its author called it — "index" is not a name.
    return name === "index" ? (parts.pop() ?? name) : name || "built in";
  }

  const source = typeof info?.source === "string" ? info.source.trim() : "";
  return source || "built in";
}

/**
 * The entry in pi's settings.json a tool's package is listed as. Only for the
 * user's own packages: a project's are listed in the project, where the portal
 * does not look.
 */
function packageOf(info: any): string | undefined {
  return info?.origin === "package" && info?.scope === "user" && typeof info.source === "string" ? info.source : undefined;
}

/** Whether the portal's own inline extension registered it: pi names those <inline:name>, which no file's path is. */
function isInline(info: any): boolean {
  return typeof info?.path === "string" && /^<inline:[^>]+>$/.test(info.path);
}

/** Read a member that may be a getter or a method, without assuming which. */
function callable(obj: any, key: string): any {
  const v = obj?.[key];
  return typeof v === "function" ? v.call(obj) : v;
}

/**
 * pi driven through its SDK, in this process.
 *
 * Preferred over the RPC subprocess for host sessions: pi's own docs recommend
 * it for Node, the config surface is typed instead of stringly-typed commands,
 * and — the reason this migration happened — `session.prompt()` runs registered
 * slash commands, which RPC accepted and then silently dropped.
 *
 * The trade is isolation: a crash here takes the portal with it, where a
 * subprocess crash only took its own session. Container sessions keep using RPC
 * and are unaffected.
 */
export class SdkPiClient extends EventEmitter implements PiClient {
  private disposed = false;
  private toldShutdown = false;
  private voiceFirst?: VoiceFirstTurn;
  private audioRule?: AudioRule;
  private loader?: { appendedByPi(): string };
  /** Dialogs an extension is waiting on, keyed by request id. */
  private pendingUi = new Map<string, (r: { cancelled?: boolean; value?: unknown }) => void>();
  /** Whether a dialog is shown to a person. Where nobody can answer, it is answered at once with its no-answer value. */
  private dialogs = true;
  /** The same dialogs as they were sent, for a page that opens later, and how to close each from the run's side. */
  private openDialogs = new Map<string, { request: Record<string, unknown>; close: () => void }>();
  /** The chat box's text, kept by the portal: see useDrafts. */
  private drafts?: DraftStore;

  useDrafts(drafts: DraftStore): void {
    this.drafts = drafts;
  }
  /** The portal's own id for this conversation — what prefill progress is reported against. */
  portalSessionId?: string;
  /** The extensions' event bus, when this client made one. */
  bus?: { emit(channel: string, data: unknown): void };
  unbridge?: Bridge;
  private unbridgeUi?: () => void;

  // Only to one running here that takes it: after a restart, the bus is new
  // and nobody on it, and "sent" would be a message that went nowhere.
  subagentInput(id: string, text: string): boolean {
    if (!this.bus || !this.unbridge?.takes(id, "input")) return false;
    this.bus.emit(SUBAGENT_INPUT, { id, text });
    return true;
  }

  subagentStop(id: string): boolean {
    if (!this.bus || !this.unbridge?.takes(id, "stop")) return false;
    this.bus.emit(SUBAGENT_STOP, { id });
    return true;
  }

  /** What a page says to an extension's own half in this chat: see extension-ui.ts. False where there is no bus to say it on. */
  tellExtension(extension: string, data: unknown): boolean {
    if (!this.bus) return false;
    this.bus.emit(UI_RECEIVE, { extension, data });
    return true;
  }

  subagentsRunning(): number {
    return this.unbridge?.running() ?? 0;
  }

  dialogsOpen(): number {
    return this.pendingUi.size;
  }

  endSubagents(why: string): void {
    this.unbridge?.endAll(why);
  }
  /** The model object applyContextLimit last put on the session, to tell it from one pi put there. */
  private appliedModel?: object;
  /** What each model's own definition says its window is, as last seen on a model that was pi's. */
  private definitionWindows = new Map<string, number | undefined>();

  private constructor(
    private readonly session: any,
    private readonly modelRuntime: any,
    private readonly unsubscribe: () => void
  ) {
    super();
    this.setMaxListeners(0);
    this.guardActiveTools();
  }

  static async create(opts: {
    cwd: string;
    sessionDir: string;
    /** A previous run's session file. Reopened exactly, when it still exists. */
    sessionFile?: string;
    provider?: string;
    modelId?: string;
    thinkingLevel?: string;
    /**
     * Register the routine tools. Off unless asked: only a conversation with
     * the agent should be able to touch the schedule (see hasRoutineTools).
     */
    routineTools?: boolean;
    /** Register ask_question: only for a chat a person talks to in the portal's pages (see asksQuestions). */
    questions?: boolean;
    /** Show the dialogs an extension opens (default); off where nobody can answer them (see showsDialogs). */
    dialogs?: boolean;
    /**
     * The routine this session runs, when it is one. Gives the agent the report
     * tool, so a run with nobody watching can still reach someone.
     */
    routineSlug?: string | null;
    /** Whoever is speaking right now — read at each tool call. */
    whoNow?: () => { role: string; key?: string };
    /** Lowest role this conversation serves, deciding which context files load. */
    role?: string;
    /** Tools this conversation has switched off, by name. */
    toolsOff?: string[];
    /** The tools the portal has seen, for one that says it is off until switched on: see `unseenOff`. */
    toolsSeen?: () => ReadonlySet<string>;
    /** The tools that are on and lazy: not offered one by one, and found through the `tools` tool instead. */
    toolsLazy?: string[];
    /** What the lazy tools are called as sets, for the one line that tells the model they exist. */
    lazySets?: string[];
    /** The code tool's presentation in a chat whose mode works through it: see codemode.ts. */
    codemode?: "only";
    /** Said after the portal's rules each time the prompt is built: the chat's mode's instructions. */
    modeLines?: () => string[];
    /** The portal's session id, for tools that record against it. */
    sessionId?: string;
    /** The taint rules a run may act against after it read something untrusted, read at each call — see guardExtension. */
    exemptNow?: () => ReadonlySet<string>;
    /** The sites the agent's tools may reach, read at each tool call, so a change takes effect without a restart. */
    allowlistNow?: () => string[];
    /** The agent whose heartbeat this is: gives it the note tool. See heartbeat.ts. */
    heartbeatAgent?: string;
    /** Told the chat's model when a spoken turn is about to run on another: see useVoiceModel. */
    rememberChatModel?: (provider: string, modelId: string) => void;
    /** Whether a reload that is due may happen between two requests of a run: see prepareEachTurn. */
    canReloadNow?: () => boolean;
  }): Promise<SdkPiClient> {
    // Imported lazily so the server still boots (and the container executor
    // still works) if the SDK cannot initialise in this environment.
    const pi: any = await import("@earendil-works/pi-coding-agent");
    loadTheme(pi, opts.cwd);

    const modelRuntime = await pi.ModelRuntime.create();
    // Shared with the extensions, so one that runs a subagent can tell the
    // portal about it, and be told what the person wants of it.
    const eventBus = typeof pi.createEventBus === "function" ? pi.createEventBus() : undefined;

    // Without an explicit loader the SDK starts with no extensions, skills or
    // prompt templates — so installed packages contribute no commands at all.
    // The CLI wires this up for you; here it has to be asked for.
    const voiceFirst = new VoiceFirstTurn(getSkipThinkingProviders);
    let resourceLoader: any;
    const settingsManager = pi.SettingsManager.create(opts.cwd, pi.getAgentDir());
    // What the conversation has switched off: the client's, once there is one.
    let switchedOff: () => ReadonlySet<string> = () => new Set(opts.toolsOff ?? []);
    // The files a tool declares it is approved for, from its definition once the session has it: see declaredFiles.
    let filesOf: (name: string) => readonly string[] | undefined = () => undefined;
    // Whether the MCP adapter registered a tool, from what the session knows of it once there is one: see untrustedResult.
    let fromAdapter: (name: string) => boolean = () => false;
    // What a tool declares the guard is to hold it to, from its definition once the session has it: see declaredGuard.
    let guardOf: (name: string) => DeclaredGuard | undefined = () => undefined;
    // The line that outside content is data, while a tool that declares it is on or lazy: asked once the session is there (below).
    let outsideLines: () => string[] = () => [];
    const gateway = new ToolsGateway(opts.lazySets);
    // What the tools that are on ask to be told in a spoken turn, whoever registered them: `voiceGuidelines` on a
    // tool, as pi's own promptGuidelines are for every turn. Asked once the session is there (below).
    let toolVoiceLines: () => string[] = () => [];
    const audioRule = new AudioRule(getVoiceInstructions, () => toolVoiceLines().filter(Boolean).join(" "), voiceSpeaks);
    // Code mode, active from the start and switched like any other tool: off by default (see codemode.ts).
    const codemode = codemodeExtension(pi, opts.codemode);
    try {
      // Both are required: the constructor resolves each and throws on
      // undefined, which previously left every session with no extensions.
      const builtinSkills = builtinSkillsDir();
      // The skills the agent wrote for itself, in its own home: a chat in a project is the one the project is linked to, else the first agent's.
      const skillsOf = agentFor(opts.cwd);
      // Every session, unconditionally: the point is to limit what a turn can do
      // after it reads something untrusted, and any session can read something.
      const factories: { name: string; factory: (pi: any) => void; replaceable?: boolean }[] = [
        { name: "voice-first", factory: voiceFirst.extension },
        // After a model switch, the earlier model's thinking is not handed on as answer text: see #60.
        { name: "cross-model-thinking", factory: crossModelThinkingExtension },
        { name: "guard", factory: guardExtension(
            opts.sessionDir,
            opts.whoNow ?? (() => ({ role: "primary" })),
            opts.sessionId,
            opts.exemptNow ?? (() => new Set()),
            opts.allowlistNow ?? (() => []),
            opts.cwd,
            [path.join(pi.getAgentDir(), "skills"), ...(builtinSkills ? [builtinSkills] : [])],
            () => switchedOff(),
            () => gateway.owns(),
            (name) => filesOf(name),
            (name) => fromAdapter(name),
            (name) => guardOf(name),
            opts.dialogs !== false,
          ) },
        // Offered only while the conversation has a lazy tool: see applyToolsOff.
        { name: "tools-gateway", factory: gateway.extension },
      ];
      // While the sandbox is on, pi's own tools do what they do to the system as the sandbox user: see sandbox/.
      factories.push({ name: SANDBOX, factory: await sandboxTools(pi, opts.cwd) });
      if (opts.routineTools)
        factories.push({ name: "routines", factory: routineTools(opts.sessionId) });
      if (opts.questions) factories.push({ name: ASK_QUESTION_SOURCE, factory: askQuestionTool(questionWaitMs) });
      // Only where it means something: a conversation with the primary user has
      // nobody to escalate to, and the tool would just be noise.
      if (opts.sessionId && opts.role && opts.role !== "primary") {
        factories.push({ name: "ask-primary", factory: askPrimaryTool(opts.sessionId, (name) => filesOf(name), (name) => guardOf(name)?.acts) });
      }
      // Only when there is somewhere for it to go — a tool that always fails is
      // worse than no tool, and the model will keep trying it.
      if (opts.routineSlug !== undefined && reportToFor(opts.routineSlug)) {
        factories.push({ name: "report", factory: reportTool(opts.routineSlug ?? null) });
      }
      if (codemode) factories.push(codemode);
      // A heartbeat's way of saying what it found: it can do nothing else.
      if (opts.heartbeatAgent && opts.sessionId) {
        factories.push({ name: "heartbeat", factory: heartbeatTool(opts.heartbeatAgent, opts.sessionId) });
      }
      resourceLoader = new (portalLoader(pi))({
        cwd: opts.cwd,
        // One for the loader and the session, so the folder's trust the loader decides holds for both.
        settingsManager,
        // The MCP adapter reads no config from the folder, and starts no server there, while the sandbox is on.
        extensionsOverride: (loaded: { extensions: any[] }) => (sandboxOn() ? withoutFolderMcp(loaded) : loaded),
        ...(eventBus ? { eventBus } : {}),
        agentDir: pi.getAgentDir(),
        // Available everywhere without being installed, and not editable in
        // place: they belong to the image, so an edit would be lost on the next
        // deploy without saying so.
        // Its own only once it has one: pi reports a skill path that is not there as an error.
        additionalSkillPaths: [...(builtinSkills ? [builtinSkills] : []), ...(skillsOf && existsSync(agentSkillsDir(skillsOf)) ? [agentSkillsDir(skillsOf)] : [])],
        // The portal's own extensions, inline rather than an installed package:
        // the portal owns routines, so a package would have to call back over
        // HTTP to reach the database it sits beside. The list is built above,
        // each registered only where it belongs: routine management for sessions
        // reached through a channel, reporting for routine runs.
        extensionFactories: factories,
        // pi discovers one context file per directory — AGENTS.md or CLAUDE.md
        // — so the agent's own files would be invisible to it. Rather than
        // generating an AGENTS.md from them and keeping it in sync, they are
        // handed to pi as context files directly. Nothing to regenerate, and an
        // edit is live for the next session that starts. Both halves are read
        // as the chat's agent could read them: see readOwn.
        agentsFilesOverride: (base: { agentsFiles: any[] }) => ({
          agentsFiles: [...agentsFilesFor(base.agentsFiles, pi.getAgentDir(), opts.sessionId), ...extraContextFiles(opts.cwd, opts.role, opts.sessionId)],
        }),
        // Content alone is not enough. Handed over as plain context files, pi
        // presents them as reference material and the model answers "who are
        // you" from its own base identity — verified: it read a fact out of
        // MEMORY.md correctly while insisting it was Pi, made by Baidu. This
        // says what the files are for.
        appendSystemPrompt: framing(),
        // Where MEMORY.md would have been, while something holds the memory:
        // asked each time the prompt is built, so a switch reaches a reloaded chat.
        // A conversation with anyone else had no memory to replace.
      }, audioRule, () => [
        ...ownFiles(opts.cwd, opts.role, opts.sessionId),
        // Where its own skills go: only for the person it works for; a look or a colleague does not write them.
        ...(skillsOf && (!opts.role || opts.role === "primary") && !opts.heartbeatAgent ? [skillsLine(skillsOf)] : []),
        ...memoryRule(opts.cwd, opts.role),
        ...outsideLines(),
        ...(opts.modeLines?.() ?? []),
      ],
      // What the installed extensions' server halves add to the chat's pi, each under its package's name, as they are
      // at each load: see extension-host.ts.
      () => (opts.sessionId ? hostExtensions(opts.sessionId) : []));
      await resourceLoader.reload();
    } catch (e) {
      console.error(`[portal] resource loader unavailable: ${(e as Error).message}`);
      resourceLoader = undefined;
    }

    // Resolved twice on purpose. Extensions register their own providers, and
    // they are not bound yet — so a llama-server model is invisible here and
    // only becomes findable further down, after bindExtensions.
    const wanted =
      opts.provider && opts.modelId ? { provider: opts.provider, modelId: opts.modelId } : undefined;
    const model = viaProgressProxy(
      wanted ? modelRuntime.getModel(wanted.provider, wanted.modelId) : undefined,
      opts.sessionId,
    );

    // Reopen the exact file this portal session owns, rather than creating a
    // new one — `create` started a fresh conversation on every restart, which
    // is why history vanished and context usage read 0%.
    //
    // Not continueRecent: "most recent in the directory" is a guess, and one
    // stray file would silently attach the wrong conversation. The path is
    // recorded in the database, so the mapping is exact.
    //
    // Note the argument order — (cwd, sessionDir). Only one was being passed,
    // so the session directory was taken as the working directory and pi filed
    // everything under an encoded path derived from it.
    const sessionFile = findSessionFile(opts.sessionFile, opts.sessionDir);
    const sessionManager = sessionFile
      ? pi.SessionManager.open(sessionFile, opts.sessionDir, opts.cwd)
      : pi.SessionManager.create(opts.cwd, opts.sessionDir);
    // Before the prompt is first built: a reopened conversation may have had
    // voice. What the model is given, not the whole path: a spoken message
    // compacted away left nothing the rule is about.
    audioRule.set(spokenIn(sessionManager.buildContextEntries()));

    const { session } = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager,
      modelRuntime,
      ...(resourceLoader ? { resourceLoader, settingsManager } : {}),
      // Added to pi's default tools, not in place of them; the switches take it out again where it is off.
      ...(resourceLoader && codemode ? { tools: CODEMODE_TOOLS } : {}),
      ...(model ? { model } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });
    filesOf = (name) => declaredFiles(session.getToolDefinition(name));
    guardOf = (name) => declaredGuard(session.getToolDefinition(name));
    fromAdapter = (name) => {
      const tool = (session.getAllTools?.() ?? []).find((one: any) => one?.name === name);
      return tool !== undefined && adapterTool({ source: sourceLabel(tool.sourceInfo), package: packageOf(tool.sourceInfo) });
    };

    const client = new SdkPiClient(session, modelRuntime, () => {});
    switchedOff = () => client.switchedOff;
    gateway.attach({ session: () => session, lazy: () => client.reachableLazy(), off: () => client.switchedOff });
    // The lazy tools the chat reaches through the `tools` tool as well: the model can call those too, and a line that
    // says how to use one is no less true for its being found that way.
    toolVoiceLines = () => {
      const lines = new Set<string>();
      for (const name of new Set([...session.getActiveToolNames(), ...client.reachableLazy()])) {
        const asked = (session.getToolDefinition(name) as { voiceGuidelines?: unknown } | undefined)?.voiceGuidelines;
        if (Array.isArray(asked)) for (const line of asked) if (typeof line === "string") lines.add(line);
      }
      return [...lines];
    };
    // Said once, whichever of the tools that declare outside content are on, and through the `tools` tool where they
    // are lazy: what they return comes in the short envelope (see pageEnvelope in guard.ts), which leaves it out.
    outsideLines = () =>
      [...new Set([...session.getActiveToolNames(), ...client.reachableLazy()])].some((name) => guardOf(name)?.outside)
        ? [OUTSIDE_CONTENT_GUIDELINE]
        : [];
    client.portalSessionId = opts.sessionId;
    client.dialogs = opts.dialogs !== false;
    client.rememberChatModel = opts.rememberChatModel;
    client.canReloadNow = opts.canReloadNow;
    if (eventBus && resourceLoader) {
      client.bus = eventBus;
      client.unbridge = bridgeSubagents(eventBus, (event) => client.emit("event", event));
      client.unbridgeUi = bridgeExtensionUi(eventBus, (event) => client.emit("event", event));
    }
    if (resourceLoader) {
      client.voiceFirst = voiceFirst;
      client.audioRule = audioRule;
      client.loader = resourceLoader;
      client.prepareEachTurn();
    }
    // The tool a call through the gateway called, from its start to its end.
    const lazyCalls = new Map<string, string>();
    const unsub = session.subscribe((event: any) => {
      client.noteRun(event);
      // As pi emits it, not as forward() passes it on: a queue_update held
      // behind a settle would be too late for the prompt() that caused it.
      client.noteQueue(event);
      // A call through the gateway to the lazy tools is a call of the tool it calls, to the pages; all pi's events make of it is `tools`.
      const starting = event?.type === "tool_execution_start";
      const ending = event?.type === "tool_execution_end";
      const called = starting && event.toolName === GATEWAY_TOOL && !gateway.taken() ? calledThrough(event.args)?.name : undefined;
      if (called) lazyCalls.set(String(event.toolCallId), called);
      // The end of a call carries no arguments, so it is told again there which tool was called.
      const was = ending ? lazyCalls.get(String(event.toolCallId)) : undefined;
      if (ending) lazyCalls.delete(String(event.toolCallId));
      client.forward(was ? { ...event, [CALLED_TOOL_KEY]: was } : event);
    });
    // Replace the placeholder now that we have the real unsubscribe.
    (client as any).unsubscribe = typeof unsub === "function" ? unsub : () => {};

    // Extensions are loaded by the resource loader but stay inert until they
    // are bound. Every pi mode does this; the SDK leaves it to the host, which
    // is why commands were missing and hasExtensionHandlers was false.
    //
    // Binding a uiContext is what makes interactive commands work at all: an
    // unbound host makes ctx.ui.select() return a default immediately, so a
    // command that asks the user something silently does nothing.

    client.toolsSeen = opts.toolsSeen;
    client.codemodeOnly = opts.codemode === "only";
    client.switchedOff = new Set([...(opts.toolsOff ?? []), ...client.unseenOff()]);
    client.lazy = client.lazyOf(opts.toolsLazy ?? []);
    client.gateway = gateway;
    try {
      await session.bindExtensions({
        uiContext: client.buildUiContext(),
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          // Through the client, not the session: a reload has to put the tool
          // switches back, and only the client knows them.
          reload: () => client.reload(),
        },
        onError: (err: any) =>
          client.emit("event", {
            type: "extension_error",
            extensionPath: err?.extensionPath,
            error: String(err?.error ?? err),
          }),
      });
    } catch (e) {
      console.error(`[portal] binding extensions failed: ${(e as Error).message}`);
    }

    // Second attempt: the provider may only exist now that extensions are
    // bound. Without this the session silently ran on pi's fallback model.
    if (wanted && !model) {
      const late = viaProgressProxy(
        modelRuntime.getModel(wanted.provider, wanted.modelId),
        opts.sessionId,
      );
      if (late) {
        try {
          await session.setModel(late);
        } catch (e) {
          console.error(`[portal] could not apply ${wanted.modelId}: ${(e as Error).message}`);
        }
      } else {
        console.error(
          `[portal] model ${wanted.provider}/${wanted.modelId} not found; using pi's default`
        );
      }
    }

    // The portal only ever names a model when somebody picked one; most
    // sessions run on pi's own default, which is chosen in here and never
    // passes through the code above. Route whatever it settled on, or prefill
    // progress only ever appears for a session whose model was set by hand.
    try {
      const settled = session.model;
      const routed = viaProgressProxy(settled, opts.sessionId);
      if (routed && routed !== settled) await session.setModel(routed);
    } catch (e) {
      console.error(`[portal] could not route llama progress: ${(e as Error).message}`);
    }

    client.applyLimitQuietly();
    // After binding, as the switches below: what an extension registers as it starts is in it.
    const failed = client.noteLoad();
    // After binding, not before: a tool an extension registers does not exist
    // until then, and switching it off ahead of time switches off nothing.
    // Also with nothing switched off: the gateway is registered active, and is only wanted while a tool is lazy.
    client.applyToolsOff();
    // Now that every tool is registered, the gateway can carry the rules of the lazy ones.
    client.gateway?.refresh();
    // Said once the portal listens, which it does as soon as it has the client.
    if (failed.length) setImmediate(() => client.sayLoadErrors(failed));
    return client;
  }

  get running(): boolean {
    return !this.disposed;
  }

  /** Undefined until pi has actually written the file. */
  get sessionFile(): string | undefined {
    return this.session.sessionFile ?? undefined;
  }

  /**
   * Bridges pi's extension dialogs to the browser: each call emits a request
   * event and parks a promise until the UI answers, mirroring what the TUI does
   * by drawing a menu.
   */
  private buildUiContext() {
    const ask = (payload: Record<string, unknown>, opts: any, fallback: unknown) =>
      new Promise((resolve) => {
        // Nobody to answer (a routine, a heartbeat, a channel's chat): not shown anywhere, and nothing waits.
        if (!this.dialogs || opts?.signal?.aborted) { resolve(fallback); return; }
        const id = randomUUID();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts?.signal?.removeEventListener?.("abort", stop);
          this.pendingUi.delete(id);
          this.openDialogs.delete(id);
          resolve(value);
        };
        // Ended from the run's side (its wait is up, or it is stopped): the pages still showing it close it.
        // One answered or cancelled on a page is dropped by that page. The reason is for the record a question
        // of ask_question keeps in the chat (see questions.ts).
        const close = (reason: "expired" | "stopped") => {
          if (settled) return;
          this.emit("event", { type: "extension_ui_cancel", id, reason });
          finish(fallback);
        };
        const stop = () => close("stopped");
        this.pendingUi.set(id, (r) => finish(r.cancelled ? fallback : r.value));

        // A dialog waits until it is answered, cancelled or the run is stopped. Only a caller that names
        // a wait (pi's `timeout` option, the question tool's setting) gets one.
        const ms = typeof opts?.timeout === "number" ? opts.timeout : 0;
        if (ms > 0) {
          timer = setTimeout(() => close("expired"), ms);
          if (typeof timer.unref === "function") timer.unref();
        }
        opts?.signal?.addEventListener?.("abort", stop, { once: true });

        const request = { type: "extension_ui_request", id, ...payload };
        this.openDialogs.set(id, { request, close: stop });
        this.emit("event", request);
      });

    const fireAndForget = (payload: Record<string, unknown>) =>
      this.emit("event", { type: "extension_ui_request", id: randomUUID(), ...payload });

    return {
      select: (title: string, options: string[], opts?: any) =>
        ask({ method: "select", title, options }, opts, undefined),
      confirm: (title: string, message: string, opts?: any) =>
        ask({ method: "confirm", title, message }, opts, false),
      input: (title: string, placeholder: string, opts?: any) =>
        ask({ method: "input", title, placeholder }, opts, undefined),
      editor: (title: string, content: string, opts?: any) =>
        ask({ method: "editor", title, defaultValue: content }, opts, undefined),
      // The portal's own, beside pi's: several questions at once, drawn in the chat. See ask-question.ts. When its
      // wait ends goes with it, so that a question kept over a restart of the portal still ends then.
      questions: (payload: { title?: string; questions: unknown[] }, opts?: any) =>
        ask({ method: "questions", ...payload, ...(opts?.timeout > 0 ? { until: Date.now() + opts.timeout } : {}) }, opts, undefined),
      notify: (message: string, type?: string) =>
        fireAndForget({ method: "notify", message, notifyType: type }),
      setStatus: (key: string, text: string) =>
        fireAndForget({ method: "setStatus", statusKey: key, statusText: text }),
      setWidget: (key: string, content: unknown) => {
        if (content === undefined || Array.isArray(content)) {
          fireAndForget({ method: "setWidget", widgetKey: key, widgetContent: content });
        }
      },
      onTerminalInput: () => () => {},
      // TUI-only affordances with no meaning in a browser.
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      // The rest of pi's UI, which extensions call whether or not there is a
      // terminal. Missing, a call threw — "ctx.ui.custom is not a function" —
      // and the command failed for no reason of its own. As pi's RPC mode
      // does: what a browser can do is passed on, the rest does nothing.
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      // A view drawn for the terminal. Passed on so the chat can say it cannot be shown.
      custom: async () => {
        fireAndForget({ method: "custom" });
        return undefined;
      },
      // Into the chat box, for the person to send or change.
      // What is in the box follows at once, for a getEditorText right after.
      setEditorText: (text: string) => {
        this.drafts?.set(String(text ?? ""));
        fireAndForget({ method: "setEditorText", text: String(text ?? "") });
      },
      // Over what is selected, or at the end, as the page puts it.
      pasteToEditor: (text: string) => {
        const given = String(text ?? "");
        const draft = this.drafts?.get()?.text ?? "";
        const { start, end } = this.drafts?.get()?.caret ?? { start: draft.length, end: draft.length };
        const at = start + given.length;
        this.drafts?.set(draft.slice(0, start) + given + draft.slice(end), { start: at, end: at });
        fireAndForget({ method: "setEditorText", text: given, paste: true });
      },
      // Answered with nothing, an extension that adds to the draft replaced it.
      getEditorText: () => this.drafts?.get()?.text ?? "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return piTheme();
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "The portal's theme is set in the browser." }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  /**
   * The dialogs (confirm, select, input, editor, questions) still waiting for an answer, as they were
   * sent. Live events are not stored, so a page that opens or switches to this chat while one waits
   * asks for them here.
   */
  openDialogRequests(): Record<string, unknown>[] {
    return [...this.openDialogs.values()].map((d) => d.request);
  }

  /** Answer a dialog the UI just resolved. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    const pending = this.pendingUi.get(id);
    if (!pending) return false;
    pending(response);
    return true;
  }

  async prompt(
    message: string,
    options?: { voice?: boolean; images?: ImageContent[]; steer?: boolean },
  ): Promise<PromptTaken> {
    // See `reloading`. Failed or not, the chat is what it left.
    if (this.reloading) await this.reloading.catch(() => {});
    if (options?.voice) {
      this.useVoiceModel();
      this.voiceFirst?.arm(this.isIdle());
    } else {
      this.voiceFirst?.reset();
      // Typed into the moment between idle and settled: the voice model is not
      // for this one, and the settle that would put the chat back is a run late.
      this.restoreChatModel();
    }
    const ruleFromThis = this.sayAudioRule(options?.voice === true);
    const promptOptions = {
      expandPromptTemplates: true,
      // Mid-run, a message waits for the run to end — unless it was said to
      // steer it, when it is taken in after the tools that are running now.
      streamingBehavior: options?.steer ? "steer" : "followUp",
      ...(options?.images?.length ? { images: options.images } : {}),
    };
    // Answered once pi has taken it, typed or spoken, not once the run it
    // starts is over — as the RPC client does. `session.prompt()` holds on to
    // the whole run, and so did the request that sent it: the browser was
    // still "sending" for as long as the agent worked, and its Send stayed
    // greyed out, with no way to steer. What fails after that is reported as
    // portal_failed, ahead of the run's agent_settled: see forward().
    const text = options?.voice ? audioMessage(message) : message;
    const handoff: Handoff = { text, lane: options?.steer ? "steering" : "followUp" };
    this.handoffs.push(handoff);
    // pi says it has the message just before it either returns — queued, or
    // handled by an extension — or starts the run: idle then and running a
    // moment later is a run this message started.
    let idleWhenTaken = false;
    try {
      await acceptPrompt(
        preflightResult =>
          this.session.prompt(text, {
            ...promptOptions,
            preflightResult: (success: boolean) => {
              idleWhenTaken = this.session.isIdle;
              preflightResult(success);
            },
          }),
        error => {
          if (options?.voice) this.voiceFirst?.reset();
          if (ruleFromThis) this.unsayAudioRule();
          this.restoreChatModel();
          const reason = error instanceof Error ? error.message : String(error);
          this.emit("event", { type: "portal_failed", error: `${options?.voice ? "Voice turn" : "The run"} failed: ${reason}` });
        },
      );
    } catch (error) {
      if (options?.voice) this.voiceFirst?.reset();
      if (ruleFromThis) this.unsayAudioRule();
      this.restoreChatModel();
      throw error;
    }
    finally {
      this.handoffs.splice(this.handoffs.indexOf(handoff), 1);
    }
    if (handoff.queued !== undefined) return { outcome: "queued", lane: handoff.lane, text: handoff.queued };
    if (idleWhenTaken && !this.session.isIdle) return { outcome: "started" };
    // Taken by an extension, and not into the conversation.
    if (ruleFromThis) this.unsayAudioRule();
    this.restoreChatModel();
    return { outcome: "handled" };
  }

  /** What the model in use depends on at the start and the end of a run, from pi's events as they come. */
  noteRun(event: any): void {
    // Before anything is measured against the window: pi swaps the model for the
    // registry's whenever an extension registers a provider, and that undoes it.
    if (event?.type === "agent_start") this.applyLimitQuietly();
    // See restoreChatModel for the settle that comes in a run late.
    if (event?.type === "agent_settled") this.restoreChatModel();
  }

  /** The chat's model and the voice model's name, while a spoken turn runs on the voice model instead: see useVoiceModel. */
  private displaced?: { chat: any; provider: string; id: string };

  /** Set by create(): where the chat's model is kept for a chat that names none. */
  rememberChatModel?: (provider: string, modelId: string) => void;

  /**
   * Puts a spoken turn on the model the voice settings name, where one is named.
   *
   * Only for a turn that starts a run: a spoken message into a run that is
   * going is answered by the model that run is on. The model is put on the
   * agent's state, as applyContextLimit does, rather than through setModel,
   * which would write a model change into the conversation and make the voice
   * model pi's default for every other chat. The chat's model stays what the
   * chat has chosen, and is back once the run has settled: restoreChatModel.
   *
   * pi marks itself idle a moment before it emits agent_settled, while the
   * extensions' handlers are awaited. A spoken message in that moment finds the
   * previous run's voice model still in place and keeps it, and the late settle
   * is ignored while a run is going (restoreChatModel). Known limit: pi awaits
   * the extensions' input handlers before it marks the next run as running, and
   * a settle that falls into that wait still counts as idle, so that one spoken
   * message may be answered by the chat's model. Closing it would mean tying
   * each borrow to the run it was made for, which pi's events do not name.
   */
  private useVoiceModel(): void {
    if (this.displaced || !this.isIdle()) return;
    const wanted = getVoiceModel();
    if (!wanted) return;
    const current = this.session.model;
    if (current?.provider === wanted.provider && current?.id === wanted.modelId) return;
    const model = viaProgressProxy(this.modelRuntime.getModel(wanted.provider, wanted.modelId), this.portalSessionId);
    if (!model) {
      console.error(`[portal] voice model ${wanted.provider}/${wanted.modelId} not found; the chat's model answers`);
      return;
    }
    this.displaced = { chat: current, provider: wanted.provider, id: wanted.modelId };
    // A chat that names no model anywhere is reopened by pi on the model of the
    // last answer, which would be this one: the portal keeps the chat's own.
    if (current) this.rememberChatModel?.(current.provider, current.id);
    this.session.agent.state.model = model;
    this.applyLimitQuietly();
  }

  /**
   * The chat's own model again after a spoken turn. Not while a run is going:
   * pi is idle a moment before it settles, and a settle that arrives after the
   * next run has begun is the previous run's. Left alone where the person
   * picked another model meanwhile: that choice is theirs (see setModel).
   */
  restoreChatModel(): void {
    const displaced = this.displaced;
    if (!displaced || !this.isIdle()) return;
    this.displaced = undefined;
    const current = this.session.model;
    if (current?.provider !== displaced.provider || current?.id !== displaced.id) return;
    this.session.agent.state.model = displaced.chat;
    this.applyLimitQuietly();
  }

  /**
   * The rule for spoken replies, in from this spoken message on. True when it
   * was this message that put it in.
   *
   * Not taken out by a typed message: a spoken one still waiting in pi's queue
   * is not on the conversation's path yet, and would be answered without it.
   * Out it goes when this message was refused and no other spoken one is
   * there (unsayAudioRule), or when the conversation is opened again with none
   * in what the model is given — after a restart, a compaction, or an edit,
   * which stops pi and reopens it.
   *
   * In before pi takes the message, so a run it starts has the rule from its
   * first turn: pi's prompt is built again at once. Every turn after that is
   * seen to by prepareEachTurn, whoever set its prompt.
   */
  private sayAudioRule(spoken: boolean): boolean {
    if (!spoken || !this.audioRule?.set(true)) return false;
    if (this.buildPromptAgain()) return true;
    // As it was, so the next spoken message tries once more.
    this.audioRule.undo();
    return false;
  }

  /**
   * The rule out again, for a spoken message pi refused or an extension took
   * — unless another spoken one is in the conversation, in pi's queue, or
   * being handed to it now.
   */
  private unsayAudioRule(): void {
    const spoken = (text: string) => text.startsWith(AUDIO_MESSAGE_PREFIX);
    let context: readonly unknown[] = [];
    try {
      context = this.session.sessionManager.buildContextEntries();
    } catch {
      return;
    }
    if (spokenIn(context)) return;
    if ([...this.queue.steering, ...this.queue.followUp].some(spoken)) return;
    if (this.handoffs.some((h) => spoken(h.text))) return;
    if (this.audioRule?.set(false)) this.buildPromptAgain();
  }

  /**
   * pi's prompt built again, with the tools as they are: `activate` is pi's own
   * setter, beneath the tool switches, so nothing about them changes.
   */
  private buildPromptAgain(): boolean {
    try {
      this.activate?.(this.session.getActiveToolNames());
      return !!this.activate;
    } catch (e) {
      console.error(`[portal] the system prompt could not be built again: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * What pi's own preparation of every turn after a run's first is to find.
   *
   * A reload that became due while the run went on (see reloadIdle), where
   * nothing beside the run would be cut off by it (`canReloadNow`): between two
   * requests no tool is running, and pi's preparation takes the tools again
   * from what the reload left, so the next request has them. Where it cannot,
   * the chat is reloaded once the run is over.
   *
   * And the rule as it should be, in the prompt. pi takes that prompt afresh
   * between turns, from the options the run was started with: what it appends
   * to its own prompt, and the whole text where an extension forced one for
   * the run (pi-background-tasks sets one for every run on the test host).
   * Those say what they were given when the run started, so a message queued
   * into a run that is going would be answered without the rule, or with an
   * earlier wording of it. So before pi builds each turn's prompt from them,
   * both are made to say what the rule says now.
   */
  private prepareEachTurn(): void {
    const session = this.session;
    const agent = session?.agent;
    const rule = this.audioRule;
    const loader = this.loader;
    const prepare = agent?.prepareNextTurnWithContext;
    if (!rule || !loader || typeof prepare !== "function") return;
    agent.prepareNextTurnWithContext = async (turn: unknown, signal: unknown) => {
      if (this.reloadDue && this.canReloadNow?.()) {
        try {
          await this.reload();
        } catch (e) {
          // The run goes on with what it had, as a chat that could not be reloaded while idle does, and the next step tries again.
          console.error(`[portal] could not reload ${this.portalSessionId ?? "a chat"} between two steps: ${(e as Error).message}`);
        }
      }
      const options = session._runSystemPromptOptions as { appendSystemPrompt?: unknown; forceSystemPrompt?: unknown } | undefined;
      if (options) {
        const after = loader.appendedByPi();
        if (typeof options.appendSystemPrompt === "string") options.appendSystemPrompt = rule.into(options.appendSystemPrompt, after).trim();
        if (typeof options.forceSystemPrompt === "string") options.forceSystemPrompt = rule.into(options.forceSystemPrompt, after);
      }
      return prepare.call(agent, turn, signal);
    };
  }

  /** Messages being handed to pi right now, oldest first: see noteQueue(). */
  private handoffs: Handoff[] = [];

  /** pi's queue as its last queue_update had it. */
  private queue: Record<Handoff["lane"], string[]> = { steering: [], followUp: [] };

  /**
   * Which message pi just queued, and as what.
   *
   * pi queues the words it ends up with — a template or skill expanded, an
   * input handler's rewrite applied — and says so in a queue_update with the
   * one entry added at the end. That is the message it hands the agent later,
   * word for word, so it is what the portal knows the message by. Given to the
   * message being handed over into that lane that says the same, or else the
   * oldest one: pi queues them in the order it is given them.
   */
  noteQueue(event: any): void {
    if (event?.type !== "queue_update") return;
    for (const lane of ["steering", "followUp"] as const) {
      const now = (Array.isArray(event[lane]) ? event[lane] : []).map(String);
      const was = this.queue[lane];
      if (now.length === was.length + 1 && was.every((text, i) => now[i] === text)) {
        const added = now[now.length - 1];
        const open = this.handoffs.filter((h) => h.lane === lane && h.queued === undefined);
        const handoff = open.find((h) => h.text === added) ?? open[0];
        if (handoff) handoff.queued = added;
      }
      this.queue[lane] = now;
    }
  }

  /** Events held back behind an agent_settled, in order: see forward(). */
  private held?: any[];

  /**
   * Hands pi's events on, keeping one order the portal depends on.
   *
   * pi settles a run in the finally of its prompt(), and only after that does
   * the prompt() throw for a run that failed. Passed on as they come, the
   * portal saw the run settle cleanly — idle, and an ask() answered with
   * whatever had been said — and heard about the failure afterwards, when
   * nothing was listening. So a settle waits for the turn of the event loop
   * after it, with anything behind it: nothing but promises stand between it
   * and that throw, and all of them are through by then.
   *
   * Held for that one turn and no longer, with whatever pi emits in it: a
   * prompt can start the next run in the moment pi has marked itself idle but
   * not yet settled the last one, and events of that run are passed on after
   * the settle rather than before it.
   */
  forward(event: any): void {
    if (this.held) {
      this.held.push(event);
      return;
    }
    if (event?.type === "agent_settled") {
      const held = (this.held = [event]);
      setImmediate(() => {
        this.held = undefined;
        const [settled, ...after] = held;
        this.emit("event", settled);
        for (const e of after) this.forward(e);
      });
      return;
    }
    this.emit("event", event);
  }

  async abort(): Promise<void> {
    // Nobody is to answer the dialogs of a stopped run, and pi's abort waits for a tool that is waiting on one.
    for (const dialog of [...this.openDialogs.values()]) dialog.close();
    // Compaction runs on a controller of its own, so session.abort() stops an
    // agent run and leaves a summarisation going — the one case where Stop
    // looks like it did nothing at all.
    if (this.session.isCompacting) this.session.abortCompaction();
    await this.session.abort();
  }

  /**
   * True when nothing is streaming — a command that ran no agent turn is idle.
   *
   * `isIdle` and `isStreaming` are getters, not methods. Calling them threw
   * every time, the throw was swallowed, and this answered "idle" for a session
   * that was mid-run — which is why the Stop button kept vanishing while the
   * model was still working. It also covers a queued follow-up and a retry,
   * neither of which ends at agent_end.
   */
  isIdle(): boolean {
    return this.session.isIdle;
  }

  clearQueue(): string[] {
    const { steering, followUp } = this.session.clearQueue();
    return [...steering, ...followUp].map(String);
  }

  /**
   * What pi's own runtime does before it lets a session go. AgentSession.dispose()
   * does not: it is the runtime that tells the extensions, and this portal has
   * none. They stop their timers and the servers they started there. Left
   * unsaid, each pi that was released stayed running and in memory.
   */
  async shutdown(): Promise<void> {
    if (this.disposed || this.toldShutdown) return;
    this.toldShutdown = true;
    try {
      const runner = this.session.extensionRunner;
      if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      // An extension that fails to wind down must not keep its pi from being let go.
    }
  }

  dispose(): void {
    this.unbridge?.();
    this.unbridgeUi?.();
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.unsubscribe();
    } catch {
      // best effort
    }
    try {
      this.session.dispose?.();
    } catch {
      // best effort
    }
    this.emit("exit", { code: 0, signal: null });
  }

  async getState(): Promise<PiState> {
    const model = this.session.model;
    return {
      model: {
        id: model?.id ?? "unknown",
        name: model?.name ?? "unknown",
        provider: model?.provider ?? "unknown",
        contextWindow: model?.contextWindow,
        input: Array.isArray(model?.input) ? model.input : undefined,
      },
      thinkingLevel: this.session.thinkingLevel ?? "medium",
      autoCompactionEnabled: callable(this.session, "autoCompactionEnabled") ?? true,
      messageCount: callable(this.session, "messages")?.length,
    };
  }

  async getStats(): Promise<PiStats> {
    // Read here as well as on run start: the figure shown is worked out against
    // whatever model the session has now.
    this.applyLimitQuietly();
    const stats = (await this.session.getSessionStats?.()) ?? {};
    const usage = (await this.session.getContextUsage?.()) ?? {};
    const contextWindow = usage.contextWindow ?? this.session.model?.contextWindow ?? 0;
    // pi says null, not 0, just after a compaction: the count it had was taken
    // before it. Passed on as it is, or the pill claims an empty context.
    const unknown = usage.tokens === null;
    const used = usage.tokens ?? 0;
    return {
      tokens: stats.tokens ?? { input: 0, output: 0, total: 0 },
      cost: stats.cost ?? 0,
      contextUsage: {
        tokens: unknown ? null : used,
        contextWindow,
        percent: unknown ? null : (usage.percent ?? (contextWindow ? (used / contextWindow) * 100 : 0)),
      },
      toolCalls: stats.toolCalls ?? 0,
      totalMessages: stats.totalMessages ?? 0,
    };
  }

  async getThinkingLevels(): Promise<string[]> {
    const levels = callable(this.session, "getAvailableThinkingLevels");
    return Array.isArray(levels) && levels.length
      ? levels
      : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  }

  /** When pi's model and key files were last read here. */
  private configSeen = configStamp();

  /** Only models with working auth, unlike RPC which listed the whole catalogue. */
  async getModels(): Promise<PiState["model"][]> {
    // pi reads models.json and auth.json once, when the conversation starts. A
    // provider set up in Settings since then is read in now, when the model
    // menu is opened, rather than only in the next conversation.
    const stamp = configStamp();
    if (stamp !== this.configSeen) {
      this.configSeen = stamp;
      await rereadConfig(this.modelRuntime).catch(() => {});
    }
    const available = (await this.modelRuntime.getAvailable?.()) ?? [];
    return available.map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider,
      contextWindow: m.contextWindow,
      input: Array.isArray(m.input) ? m.input : undefined,
    }));
  }

  /**
   * Names this session has switched off. Applied at every start and on change.
   * Not private: create() fills it before the session is handed over. With
   * them, the names of pi's own tools another extension took while the
   * sandbox is on, which are off whatever the switches say: see `taken`.
   */
  get switchedOff(): Set<string> {
    return this.taken.size ? new Set([...this.switches, ...this.taken]) : this.switches;
  }
  set switchedOff(names: Set<string>) {
    this.switches = names;
  }
  /** The switches alone. */
  private switches = new Set<string>();

  toolsSeen?: () => ReadonlySet<string>;

  /**
   * The tools that say they are off until switched on (`offByDefault: true` where they are registered) and that the
   * portal has not seen yet. Off here from the start, after a reload that brings one, and whatever switches the portal
   * sends before it has seen it: the portal writes the default down once it is told of the tool (rememberTools), and
   * its switches have the last word from then on.
   */
  unseenOff(): string[] {
    const seen = this.toolsSeen?.();
    if (!seen) return [];
    return (this.session.getAllTools?.() ?? []).map((tool: { name: unknown }) => String(tool.name)).filter((name: string) => !seen.has(name) && this.offByDefault(name));
  }

  /** A field of the tool's own definition, which pi keeps as it was registered. */
  private offByDefault(name: string): boolean {
    return (this.session.getToolDefinition(name) as { offByDefault?: unknown } | undefined)?.offByDefault === true;
  }

  /**
   * The tools that are on and lazy: out of the model's list, and found and called through the `tools`
   * tool. Never in `switchedOff`: a lazy tool that is switched off is off for good, and no way leads to it.
   */
  lazy = new Set<string>();

  /** Its chat works through the code tool alone, in pi's `only` presentation: set as it is created, as pi fixes that then. */
  codemodeOnly = false;

  /**
   * Of the tools marked lazy, the ones this chat keeps lazy. None where it works through the code tool and has it on:
   * every tool that is on is active there, hidden from the model by pi's `only` presentation, and a script finds it
   * with searchTools. pi lets a script call only an active tool, so one kept lazy would be out of a script's reach;
   * and with no lazy tool the `tools` tool is not offered (keptOut). Switched off in the chat, the code tool hides
   * nothing, and the marks hold.
   */
  private lazyOf(tools: readonly string[]): Set<string> {
    if (this.codemodeOnly && !this.switchedOff.has(CODEMODE_TOOL)) return new Set();
    return new Set(tools.filter((name) => !this.switchedOff.has(name)));
  }

  /** The `tools` tool of this session, which is told what the lazy tools are called. */
  gateway?: ToolsGateway;

  /** How the model is offered a tool now: by its own name, through the `tools` tool, or not at all (lazy and out of reach, switched off, not registered). */
  offers(tool: string): "direct" | "lazy" | undefined {
    if (this.reachableLazy().has(tool)) return "lazy";
    try {
      return this.session.getActiveToolNames().includes(tool) ? "direct" : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The lazy tools the gateway reaches: those that are on, registered and that pi wants active. Not every
   * tool pi has registered: an extension may register a tool and keep it inactive until it is time for it
   * (pi-goal-x with no goal set), and a direct call to such a tool fails. A lazy tool is a tool that is on in
   * every other respect, so the gateway does not reach what the model could not call if it were not lazy.
   */
  reachableLazy(): ReadonlySet<string> {
    const lazy = this.lazyNow();
    if (!lazy.size) return new Set();
    try {
      const known = new Set((this.session.getAllTools?.() ?? []).map((tool: any) => String(tool.name)));
      return new Set([...lazy].filter((name) => known.has(name) && this.wanted.has(name) && !this.switchedOff.has(name)));
    } catch {
      return new Set();
    }
  }

  /**
   * The tools that are lazy now: those that were marked, unless an extension has a tool called `tools` of its own.
   * pi keeps the first tool of a name and the gateway loads last, so that tool is the model's and the gateway is not
   * there: nothing leads to the lazy tools, and they are offered one by one, as if nothing were lazy, rather than
   * being out of reach. The portal's own tool is the one that is hidden or trusted by this name, never the other.
   */
  private lazyNow(): ReadonlySet<string> {
    if (!this.lazy.size || !this.gateway?.taken()) return this.lazy;
    if (!this.warnedTaken) {
      this.warnedTaken = true;
      console.warn(`[portal] an extension has a tool called "${GATEWAY_TOOL}", which is the portal's name for the way to the lazy tools: its tools are offered one by one in this conversation.`);
    }
    return new Set();
  }
  private warnedTaken = false;

  /** Whether the session has a lazy tool for the gateway to reach. */
  private hasLazy(): boolean {
    return this.reachableLazy().size > 0;
  }

  /**
   * Whether pi keeps this tool out of what the model is offered.
   *
   * The switched-off tools, the lazy ones (the gateway offers those instead), and the gateway while
   * there is no lazy tool to reach through it: a tool that lists nothing is noise in the prompt of
   * every conversation, which is what lazy tools avoid. Not an extension's own tool of the gateway's name.
   */
  private keptOut(name: string): boolean {
    return this.switchedOff.has(name) || this.lazyNow().has(name) || (this.isGateway(name) && !this.hasLazy());
  }

  /** Whether the name is the portal's gateway: its name, with no extension's tool of that name in its place. */
  private isGateway(name: string): boolean {
    return name === GATEWAY_TOOL && !this.gateway?.taken();
  }

  /**
   * What pi wants active, before the switches take anything out of it.
   *
   * The registry is not that: `getAllTools()` is every definition pi knows,
   * including `grep`, `find` and `ls`, which it registers and leaves inactive.
   * Subtracting the switches from the registry switched those on the first
   * time anyone turned anything off. The baseline is pi's own choice, in
   * whatever way it makes it — at start, when an extension registers a tool
   * later, on a reload — and the switches only ever take names out of it.
   */
  private wanted = new Set<string>();
  private activate?: (names: string[]) => void;

  /**
   * Put the switches in the one place every activation goes through.
   *
   * pi activates tools from several directions and none of them asks us: an
   * extension that registers a tool later (`lifecycle: "lazy"` is the whole
   * point of an MCP server that connects on first use) has it activated by
   * `refreshTools()`, and a reload activates every extension tool again. Each
   * ends in `_setActiveTools`, pi's own `setActiveToolsByName` included, so
   * that is where the names come out. (Before pi 1.0 each ended in
   * `setActiveToolsByName`; a reload no longer goes through it.)
   */
  private guardActiveTools(): void {
    const session = this.session;
    if (typeof session?._setActiveTools !== "function") return;
    const original = session._setActiveTools.bind(session) as (names: string[]) => void;
    this.activate = original;
    try {
      this.wanted = new Set<string>(session.getActiveToolNames?.() ?? []);
    } catch {
      this.wanted = new Set();
    }
    this.keepSwitchedOffFromScripts(session);
    session._setActiveTools = (names: string[]) => {
      this.takenLate();
      const held = this.heldBack(session, names, this.fromExtension);
      this.wanted = new Set([...names, ...held]);
      // What was held back and is not kept out now is offered: a lazy tool when an extension's `tools` has taken the
      // gateway's place since, which pi's list never had, as the tool was kept out when pi made it.
      const active = [...names, ...held].filter((name) => !this.keptOut(name));
      // An extension's list leaves out the gateway, which it never saw, or which was idle when it took its snapshot:
      // when a lazy tool is reachable now, so is the way to it.
      if (this.isGateway(GATEWAY_TOOL) && this.wanted.has(GATEWAY_TOOL) && !this.keptOut(GATEWAY_TOOL) && !active.includes(GATEWAY_TOOL)) active.push(GATEWAY_TOOL);
      original(active);
      // A lazy tool that registers now brings rules of its own, which the gateway says in its place. It registers
      // itself again for that, and pi's refresh of its tools then is pi's, not the extension's whose list this was.
      const fromExtension = this.fromExtension;
      this.fromExtension = false;
      try {
        this.gateway?.refresh();
      } finally {
        this.fromExtension = fromExtension;
      }
    };
    this.hearExtensions(session);
  }

  /**
   * Take what is switched off out of what a script can call.
   *
   * pi lets a script call every tool that is registered for scripts (`exposure: "codemode"` or `"deferred"`), active or
   * not, and tells the model about them in the description of `codemode`; a script lists them as `ALL_TOOLS`. Taking a
   * tool out of the active tools, which is all a switch does, leaves that open. So the tools a script can call are the
   * ones pi says less those switched off: out of the description and the list, and not found when called.
   */
  private keepSwitchedOffFromScripts(session: any): void {
    if (typeof session?._getCallableTools !== "function") return;
    const original = session._getCallableTools.bind(session) as (...args: unknown[]) => any[];
    session._getCallableTools = (...args: unknown[]) => original(...args).filter((tool) => !this.switchedOff.has(String(tool?.name)));
  }

  /** True while an extension's `setActiveTools` is being carried out. */
  private fromExtension = false;

  /**
   * Tell an extension's list of tools from pi's own.
   *
   * An extension is shown what is active — what the model is — so a switched-off
   * tool is not in anything it reads, and whatever it writes into a prompt names
   * only tools the model can call. So a list it sets says nothing about
   * switched-off tools: pi-goal-x, on session start, sets what is active less
   * its goal tools, and taken as a narrowing that dropped every switched-off
   * tool from the chat's list for good — one switched off before the first
   * message could not be switched on again. What is switched off is the
   * switch's to decide: kept, and on again when it is switched on.
   *
   * Which also means an extension cannot hide a tool that is switched off: a
   * list without it may be "not this one" or "one I could not see", and there
   * is no telling the two apart. Switched on again, it is on — even where the
   * extension, pi-goal-x with no goal set, would have kept its own tool
   * hidden. That takes somebody switching it on on purpose; the other reading
   * lost switched-off tools from the chat for good.
   *
   * A lazy tool is different: it is on, and the model reaches it, so the extension is
   * shown it among the active tools, and a list without it means what it says. An
   * extension that hides its tool is believed, and the gateway does not reach it
   * (reachableLazy) any more than the model could call it were it not lazy.
   *
   * Extensions reach pi through the runtime every extension API shares, which
   * pi fills when it binds a runner — at start, and a new one on every reload.
   */
  private hearExtensions(session: any): void {
    const hear = (runner: any) => {
      const runtime = runner?.runtime;
      if (!runtime || typeof runtime.setActiveTools !== "function") return;
      const set = runtime.setActiveTools;
      runtime.setActiveTools = (names: string[]) => {
        this.fromExtension = true;
        try {
          return set(names);
        } finally {
          this.fromExtension = false;
        }
      };
      // The lazy tools are active as far as an extension can tell: see above.
      const active = runtime.getActiveTools;
      if (typeof active !== "function") return;
      runtime.getActiveTools = (...args: unknown[]) => {
        const names: string[] = active.apply(runtime, args) ?? [];
        const lazy = [...this.reachableLazy()].filter((name) => !names.includes(name));
        return lazy.length ? [...names, ...lazy] : names;
      };
    };
    hear(session._extensionRunner);
    if (typeof session._bindExtensionCore !== "function") return;
    const bind = session._bindExtensionCore.bind(session);
    session._bindExtensionCore = (runner: any, ...rest: unknown[]) => {
      const bound = bind(runner, ...rest);
      hear(runner);
      return bound;
    };
  }

  /**
   * What is switched off and still wanted, though `names` leaves it out.
   *
   * pi refreshes — an extension registering a tool, an MCP server connecting, a
   * reload — by adding to `getActiveToolNames()`, which the switches have
   * already thinned. Taken as it came, every refresh dropped whatever was off
   * from what pi wants: gone from the chat's list, with no way to switch it
   * back on. Such a list keeps everything that is active; one that leaves an
   * active tool out is a choice, and means what it says. An extension's list
   * never says anything about what is switched off (hearExtensions): it keeps
   * it; it does say something about a lazy tool, which it was shown. Either way
   * a tool pi no longer has, its extension unloaded, is not wanted any more.
   */
  private heldBack(session: any, names: string[], always = false): string[] {
    let active: string[];
    let known: Set<string>;
    try {
      active = session.getActiveToolNames?.() ?? [];
      known = new Set((session.getAllTools?.() ?? []).map((tool: any) => String(tool.name)));
    } catch {
      return [];
    }
    if (!always && !active.every((name) => names.includes(name))) return [];
    // An extension's list is not taken for a lazy tool's: it was shown that (hearExtensions), so it said what it meant.
    // The gateway is the portal's, whatever an extension's list says (a fixed list never names it): whether it is
    // offered is for keptOut to say, by whether a lazy tool is reachable.
    // A tool marked lazy is kept even where keptOut does not keep it out: an extension's own `tools` that registers
    // later takes the gateway's place, and the tool is offered by its own name from then on. It must stay wanted
    // for that, and for the day its mark is taken away.
    const kept = (name: string) => (always ? this.switchedOff.has(name) || this.isGateway(name) : this.keptOut(name) || this.lazy.has(name));
    return [...this.wanted].filter((name) => kept(name) && !names.includes(name) && known.has(name));
  }

  /**
   * Every tool the session could be offered, with where it came from.
   *
   * The source is what a person recognises: a package name rather than the
   * path pi tracks it by, so the list groups the way somebody thinks about it
   * — "the web search one", not four unrelated rows. A tool pi leaves inactive
   * is not listed: a tick beside something the model cannot call is a state
   * the session is not in. Except one registered for scripts only, which pi
   * never activates and a code mode script can call: listed, or there would
   * be no way to switch it off.
   */
  async getTools(): Promise<PiTool[]> {
    const all: any[] = this.session.getAllTools?.() ?? [];
    const forScripts = (tool: any) => tool.exposure === "codemode" || tool.exposure === "deferred";
    // Not the gateway: it is the portal's way to the lazy tools and no tool to switch.
    const offered = (this.wanted.size ? all.filter((tool) => this.wanted.has(String(tool.name)) || forScripts(tool)) : all).filter((tool) => !this.isGateway(String(tool.name)));
    return offered.map((tool) => ({
      name: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : undefined,
      source: sourceLabel(tool.sourceInfo),
      package: packageOf(tool.sourceInfo),
      ...(isInline(tool.sourceInfo) ? { inline: true as const } : {}),
      ...(forScripts(tool) ? { scriptsOnly: true as const } : {}),
      ...(this.offByDefault(String(tool.name)) ? { offByDefault: true as const } : {}),
      ...((files) => (files ? { approvalFiles: [...files] } : {}))(declaredFiles(this.session.getToolDefinition(String(tool.name)))),
      enabled: !this.switchedOff.has(String(tool.name)),
    }));
  }

  /**
   * Switch tools off by name. `lazy` are tools that stay on but are not offered one by one: the model
   * finds them through the `tools` tool, and `sets` says what they are called, for the hint to the model.
   *
   * Named rather than listing what stays: pi wants the active set, but that is
   * a snapshot, and a tool registered later would silently never be on. The
   * active set is computed from what pi wants right now, every time.
   */
  async setToolsOff(names: string[], lazy: { tools: string[]; sets: string[] } = { tools: [], sets: [] }): Promise<void> {
    // The portal's switches name a tool that is off until switched on only once it has seen it: until then it stays off.
    this.switchedOff = new Set([...names, ...this.unseenOff()]);
    this.lazy = this.lazyOf(lazy.tools);
    this.applyToolsOff();
    // After the switches: registering the tool again has pi set its active tools, and by then the
    // tools that are wanted again must be active already, or they are dropped from what is wanted.
    this.gateway?.hint(lazy.sets);
    // What the rule says of a tool that is switched off or on is for the next message, as for a reload.
    this.sayAudioRuleAgain();
  }

  applyToolsOff(): void {
    try {
      if (!this.activate || !this.wanted.size) return;
      this.activate([...this.wanted].filter((name) => !this.keptOut(name)));
    } catch (e) {
      console.error(`[portal] could not apply the tool switches: ${(e as Error).message}`);
    }
  }

  /**
   * Commands come from three places, matching how pi builds this list.
   * Extension commands live on the runner — promptTemplates alone is only the
   * templates, which is why an installed extension contributed nothing here.
   */
  async getCommands(): Promise<PiCommand[]> {
    const commands: PiCommand[] = [];

    for (const c of this.session.extensionRunner?.getRegisteredCommands?.() ?? []) {
      commands.push({
        name: c.invocationName ?? c.name,
        description: c.description,
        source: "extension",
      });
    }
    for (const t of asArray(this.session.promptTemplates)) {
      commands.push({ name: t.name, description: t.description, source: "prompt" });
    }
    for (const skill of asArray(this.session.resourceLoader?.getSkills?.()?.skills)) {
      commands.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
      });
    }
    return commands;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    // A pick ends the borrow, even of the voice model itself: it is the chat's now.
    this.displaced = undefined;
    await this.session.setModel(viaProgressProxy(model, this.portalSessionId) ?? model);
    this.applyLimitQuietly();
  }

  /**
   * For the places that have another job first: reading a stored number and
   * looking at the session's model can both fail (a database closing at
   * shutdown, a pi release that stops exposing `agent`), and a run that never
   * gets to say it started, or a config that answers 500 and takes every pill
   * with it, is a poor price for a window that could not be read.
   */
  applyLimitQuietly(): void {
    try {
      this.applyContextLimit();
    } catch (e) {
      console.error(`[portal] could not apply the context window: ${(e as Error).message}`);
    }
  }

  /**
   * Give the session the context window this portal holds the model to.
   *
   * pi reads the window off the model it is running, so the number is put there
   * rather than beside it — the percentage and the moment of compaction then
   * agree with it. Assigned to the agent's state instead of going through
   * setModel, which writes a model change into the conversation and into pi's
   * default model. With nothing set the definition's own number is put back, so
   * removing a limit takes effect too.
   */
  applyContextLimit(): void {
    const current = this.session.model;
    if (!current) return;
    const key = `${current.provider}/${current.id}`;
    // A model that is not the one put here last is pi's own — the registry's, put
    // back after a reload or a provider registering — and its window is what the
    // definition says. Kept, because the registry cannot always say it later: a
    // provider that has gone leaves nothing to look it up in, and the window
    // would then stay wherever it was last set.
    if (current !== this.appliedModel) this.definitionWindows.set(key, current.contextWindow);
    const declared = this.modelRuntime.getModel(current.provider, current.id)?.contextWindow ?? this.definitionWindows.get(key);
    const wanted = contextWindowFor(current.provider, current.id, declared);
    if (wanted === current.contextWindow) return;
    const next = { ...current, contextWindow: wanted };
    this.appliedModel = next;
    this.session.agent.state.model = next;
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
  }

  /**
   * Re-read pi's settings file into this session.
   *
   * A session takes a copy of the settings when it starts, so a compaction
   * tuned in the UI would otherwise not reach anything already open — and the
   * session you are looking at when you change it is exactly the one you meant.
   * Only the file is re-read; anything set on this session was written there
   * too, so nothing is lost.
   */
  async refreshSettings(): Promise<void> {
    await this.session.settingsManager?.reload?.();
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.session.setAutoCompactionEnabled(enabled);
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.session.setAutoRetryEnabled(enabled);
  }

  async compact(): Promise<void> {
    await this.session.compact();
  }

  /** See PiClient.reloadDue. */
  reloadDue = false;

  /** Set by create(): whether a reload that is due may happen between two requests of a run. See prepareEachTurn. */
  canReloadNow?: () => boolean;

  /**
   * A reload under way. A message handed over meanwhile waits for it rather than meet the extensions half loaded:
   * one sent into a run that is being reloaded between two of its steps, or one that started on its way just as a run
   * was over and its chat was reloaded.
   */
  private reloading?: Promise<void>;

  async reload(): Promise<void> {
    this.reloadDue = false;
    const reloading = this.loadAgain();
    this.reloading = reloading;
    try {
      await reloading;
    } catch (e) {
      // Not reloaded, so due still: see PiClient.reloadDue.
      this.reloadDue = true;
      throw e;
    } finally {
      if (this.reloading === reloading) this.reloading = undefined;
    }
  }

  private async loadAgain(): Promise<void> {
    this.loading = true;
    await this.session.reload();
    // Reloading has extensions register their providers again, which puts the
    // registry's model, with its own window, back on the session.
    this.applyLimitQuietly();
    // And has pi switch every extension tool back on — which is every MCP tool,
    // the browser's among them. The switches are the portal's to keep.
    for (const name of this.unseenOff()) this.switches.add(name);
    const failed = this.noteLoad();
    this.applyToolsOff();
    this.sayAudioRuleAgain();
    this.sayLoadErrors(failed);
  }

  /** What the last load could not load, as noteLoad found it. */
  private failedToLoad: LoadError[] = [];

  loadErrors(): LoadError[] {
    return this.failedToLoad.map((failure) => ({ ...failure }));
  }

  /**
   * pi's own tool names that came from another extension than the sandbox's, while the sandbox gives them. pi keeps
   * the first tool of a name, and an installed package loads before the portal's own extensions, so the package's
   * `bash` would be the chat's, run outside the sandbox. Off in this chat, whatever the switches say.
   */
  private taken = new Set<string>();

  /**
   * Whether the sandbox gave pi's tools at the last load. It decides that as it loads, by whether the sandbox is on,
   * and switching the sandbox reloads every chat.
   */
  private sandboxed = false;

  /** From the start of a load until noteLoad has noted what it left (a load that failed, until the next): see takenLate. */
  private loading = true;

  /** Each of pi's own tool names that another extension than the sandbox's gives now, with the error that says so. */
  private takenNow(): { name: string; failure: LoadError }[] {
    const sandbox = `<inline:${SANDBOX}>`;
    return asArray(this.session.getAllTools?.())
      .filter((tool) => PI_BUILT_IN_TOOLS.includes(String(tool?.name)) && tool.sourceInfo?.path !== sandbox)
      .map((tool) => ({
        name: String(tool.name),
        failure: {
          path: String(tool.sourceInfo?.path ?? ""),
          error: `${sourceLabel(tool.sourceInfo)} registers "${tool.name}", one of pi's own tools. With the sandbox on, only the sandbox may give a tool that name, so "${tool.name}" is off in this chat.`,
        },
      }));
  }

  /**
   * What the load that just ended left: pi's errors (an extension that threw as it loaded, a tool of a name another
   * had first), and where the sandbox is on, one for each of pi's own tool names another extension took. Kept for
   * loadErrors; those that were not there at the load before are returned, to be said.
   */
  private noteLoad(): LoadError[] {
    const loaded = this.session.resourceLoader?.getExtensions?.() ?? {};
    const sandbox = `<inline:${SANDBOX}>`;
    this.sandboxed = asArray(loaded.extensions).some((ext) => ext?.path === sandbox && ext.tools?.size > 0);
    const taken = this.sandboxed ? this.takenNow() : [];
    this.taken = new Set(taken.map(({ name }) => name));
    // pi files a tool of a name another extension had first under the one that loaded later, which for pi's own names
    // is the sandbox: the error that names the package says it instead.
    const conflict = (e: LoadError) => e.path === sandbox && [...this.taken].some((name) => e.error.startsWith(`Tool "${name}" conflicts with `));
    const failed: LoadError[] = asArray(loaded.errors)
      .map((e) => ({ path: String(e?.path ?? ""), error: String(e?.error ?? e) }))
      .filter((e) => !conflict(e));
    failed.push(...taken.map(({ failure }) => failure));
    this.loading = false;
    const before = new Set(this.failedToLoad.map(failureKey));
    this.failedToLoad = failed;
    return failed.filter((failure) => !before.has(failureKey(failure)));
  }

  /**
   * One of pi's own tool names taken by a tool an extension registers after the load (as it starts, as a run starts):
   * pi keeps the package's, which loaded first, from then on. Off at once, and said, as at a load. Every such
   * registration comes through guardActiveTools; one in the middle of a load is noteLoad's.
   */
  private takenLate(): void {
    if (this.loading || !this.sandboxed) return;
    const late = this.takenNow().filter(({ name }) => !this.taken.has(name));
    if (!late.length) return;
    for (const { name } of late) this.taken.add(name);
    const failed = late.map(({ failure }) => failure);
    this.failedToLoad.push(...failed);
    this.sayLoadErrors(failed);
  }

  /** Each as an extension's failure is said in the chat: see extension_error in the session manager. */
  private sayLoadErrors(failed: LoadError[]): void {
    for (const failure of failed) this.emit("event", { type: "extension_error", extensionPath: failure.path, error: failure.error });
  }

  /**
   * The rule as the tools are now, after a reload or a tool switch: what it
   * says of a tool that came or went, such as one that follows its settings,
   * holds from the next message of any kind, not only from the next spoken
   * one. A conversation that has no rule has nothing to correct.
   */
  private sayAudioRuleAgain(): void {
    const rule = this.audioRule;
    if (!rule?.lines().length) return;
    // As in sayAudioRule: a prompt that could not be built again leaves pi's as it was.
    if (rule.set(true) && !this.buildPromptAgain()) rule.undo();
  }

  /** HTML unless a .jsonl path is given, matching pi's own /export. */
  async exportSession(target?: string): Promise<string> {
    if (target && target.endsWith(".jsonl")) return this.session.exportToJsonl(target);
    return await this.session.exportToHtml(target);
  }
}
