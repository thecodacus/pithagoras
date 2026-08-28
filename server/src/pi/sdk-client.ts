import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PiClient, PiCommand, PiState, PiStats } from "./types.js";
import { routineTools } from "./routine-tools.js";
import { reportTool, reportToFor } from "./report-tool.js";
import { guardExtension } from "./guard.js";
import { askPrimaryTool } from "./ask-primary.js";

function asArray(v: any): any[] {
  const resolved = typeof v === "function" ? v() : v;
  return Array.isArray(resolved) ? resolved : [];
}

/**
 * Files pi should treat as context on top of the ones it finds itself.
 *
 * Only picked up where they exist, so a task workspace is unaffected and the
 * agent's home directory gets its character, its user and its memory without
 * anything being generated.
 */
/**
 * The agent's own files, and who is allowed to see them.
 *
 * SOUL.md is who the agent is and travels everywhere. PrimaryUser.md and
 * MEMORY.md are one person's notes about themselves and their work, so a
 * conversation with anyone else must not load them — otherwise a teammate
 * messaging the bot gets an agent carrying your private context.
 *
 * TEAM.md is the shared half: what everyone may be told.
 */
const CONTEXT_FILES = ["SOUL.md", "PrimaryUser.md", "MEMORY.md"];
const SHARED_FILES = ["SOUL.md", "TEAM.md"];

const filesFor = (role?: string) => (!role || role === "primary" ? CONTEXT_FILES : SHARED_FILES);

function extraContextFiles(cwd: string, role?: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const name of filesFor(role)) {
    const file = path.join(cwd, name);
    try {
      if (existsSync(file)) out.push({ path: file, content: readFileSync(file, "utf8") });
    } catch {
      // Unreadable is the same as absent here; the session should still start.
    }
  }
  return out;
}

/**
 * A short anchor saying the files are the agent's own.
 *
 * Each file opens with its own instruction block, so this does not repeat them
 * — it exists because a context file is otherwise presented as reference
 * material, and the model read its own identity as notes about a third party.
 * One line at system level is enough to change what they are.
 */
function framing(cwd: string, role?: string): string[] {
  const present = filesFor(role).filter((name) => {
    try {
      return existsSync(path.join(cwd, name));
    } catch {
      return false;
    }
  });
  if (!present.length) return [];
  return [
    `${present.join(", ")} in your working directory are yours, not reference material about someone else. Each opens with a block saying what it is for; follow it.`,
  ];
}

/**
 * Skills shipped with the portal, loaded from the image rather than installed.
 *
 * Resolved relative to the compiled file so it works from dist and from source,
 * the same way the builtin channels are found.
 */
export function builtinSkillsDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, "../../../skills"),
    path.resolve(here, "../../skills"),
    path.resolve(process.cwd(), "skills"),
    path.resolve(process.cwd(), "../skills"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
  /** Dialogs an extension is waiting on, keyed by request id. */
  private pendingUi = new Map<string, (r: { cancelled?: boolean; value?: unknown }) => void>();

  private constructor(
    private readonly session: any,
    private readonly modelRuntime: any,
    private readonly unsubscribe: () => void
  ) {
    super();
    this.setMaxListeners(0);
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
     * Register the routine tools. Off unless asked: only a session reached
     * through a channel should be able to touch the schedule.
     */
    routineTools?: boolean;
    /**
     * The routine this session runs, when it is one. Gives the agent the report
     * tool, so a run with nobody watching can still reach someone.
     */
    routineSlug?: string | null;
    /** Whoever is speaking right now — read at each tool call. */
    whoNow?: () => { role: string; key?: string };
    /** Lowest role this conversation serves, deciding which context files load. */
    role?: string;
    /** The portal's session id, for tools that record against it. */
    sessionId?: string;
  }): Promise<SdkPiClient> {
    // Imported lazily so the server still boots (and the container executor
    // still works) if the SDK cannot initialise in this environment.
    const pi: any = await import("@earendil-works/pi-coding-agent");

    const modelRuntime = await pi.ModelRuntime.create();

    // Without an explicit loader the SDK starts with no extensions, skills or
    // prompt templates — so installed packages contribute no commands at all.
    // The CLI wires this up for you; here it has to be asked for.
    let resourceLoader: any;
    try {
      // Both are required: the constructor resolves each and throws on
      // undefined, which previously left every session with no extensions.
      const builtinSkills = builtinSkillsDir();
      // Every session, unconditionally: the point is to limit what a turn can do
      // after it reads something untrusted, and any session can read something.
      const factories: { name: string; factory: (pi: any) => void }[] = [
        { name: "guard", factory: guardExtension(opts.sessionDir, opts.whoNow ?? (() => ({ role: "primary" })), opts.sessionId) },
      ];
      if (opts.routineTools)
        factories.push({ name: "routines", factory: routineTools(opts.sessionId) });
      // Only where it means something: a conversation with the primary user has
      // nobody to escalate to, and the tool would just be noise.
      if (opts.sessionId && opts.role && opts.role !== "primary") {
        factories.push({ name: "ask-primary", factory: askPrimaryTool(opts.sessionId) });
      }
      // Only when there is somewhere for it to go — a tool that always fails is
      // worse than no tool, and the model will keep trying it.
      if (opts.routineSlug !== undefined && reportToFor(opts.routineSlug)) {
        factories.push({ name: "report", factory: reportTool(opts.routineSlug ?? null) });
      }
      resourceLoader = new pi.DefaultResourceLoader({
        cwd: opts.cwd,
        agentDir: pi.getAgentDir(),
        // Available everywhere without being installed, and not editable in
        // place: they belong to the image, so an edit would be lost on the next
        // deploy without saying so.
        ...(builtinSkills ? { additionalSkillPaths: [builtinSkills] } : {}),
        // Inline rather than an installed package: the portal owns routines, so
        // a package would have to call back over HTTP to reach the database it
        // sits beside. Absent unless asked, so a task session never sees them.
        // Registered only where each belongs: routine management for sessions
        // reached through a channel, reporting for routine runs.
        ...(factories.length ? { extensionFactories: factories } : {}),
        // pi discovers one context file per directory — AGENTS.md or CLAUDE.md
        // — so the agent's own files would be invisible to it. Rather than
        // generating an AGENTS.md from them and keeping it in sync, they are
        // handed to pi as context files directly. Nothing to regenerate, and an
        // edit is live for the next session that starts.
        agentsFilesOverride: (base: { agentsFiles: any[] }) => ({
          agentsFiles: [...base.agentsFiles, ...extraContextFiles(opts.cwd, opts.role)],
        }),
        // Content alone is not enough. Handed over as plain context files, pi
        // presents them as reference material and the model answers "who are
        // you" from its own base identity — verified: it read a fact out of
        // MEMORY.md correctly while insisting it was Pi, made by Baidu. This
        // says what the files are for.
        appendSystemPrompt: framing(opts.cwd, opts.role),
      });
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
    const model = wanted ? modelRuntime.getModel(wanted.provider, wanted.modelId) : undefined;

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
    const sessionManager =
      opts.sessionFile && existsSync(opts.sessionFile)
        ? pi.SessionManager.open(opts.sessionFile, opts.sessionDir, opts.cwd)
        : pi.SessionManager.create(opts.cwd, opts.sessionDir);

    const { session } = await pi.createAgentSession({
      cwd: opts.cwd,
      sessionManager,
      modelRuntime,
      ...(resourceLoader ? { resourceLoader } : {}),
      ...(model ? { model } : {}),
      ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    });

    const client = new SdkPiClient(session, modelRuntime, () => {});
    const unsub = session.subscribe((event: any) => client.emit("event", event));
    // Replace the placeholder now that we have the real unsubscribe.
    (client as any).unsubscribe = typeof unsub === "function" ? unsub : () => {};

    // Extensions are loaded by the resource loader but stay inert until they
    // are bound. Every pi mode does this; the SDK leaves it to the host, which
    // is why commands were missing and hasExtensionHandlers was false.
    //
    // Binding a uiContext is what makes interactive commands work at all: an
    // unbound host makes ctx.ui.select() return a default immediately, so a
    // command that asks the user something silently does nothing.
    try {
      await session.bindExtensions({
        uiContext: client.buildUiContext(),
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          reload: async () => {
            await session.reload();
          },
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
      const late = modelRuntime.getModel(wanted.provider, wanted.modelId);
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
        const id = randomUUID();
        let settled = false;
        const finish = (value: unknown) => {
          if (settled) return;
          settled = true;
          this.pendingUi.delete(id);
          resolve(value);
        };
        this.pendingUi.set(id, (r) => finish(r.cancelled ? fallback : r.value));

        // Never park forever — an unanswered dialog would wedge the session.
        const ms = typeof opts?.timeout === "number" ? opts.timeout : 300_000;
        const timer = setTimeout(() => {
          this.emit("event", { type: "extension_ui_cancel", id });
          finish(fallback);
        }, ms);
        if (typeof timer.unref === "function") timer.unref();
        opts?.signal?.addEventListener?.("abort", () => finish(fallback));

        this.emit("event", { type: "extension_ui_request", id, ...payload });
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
    };
  }

  /** Answer a dialog the UI just resolved. */
  respondUi(id: string, response: { cancelled?: boolean; value?: unknown }): boolean {
    const pending = this.pendingUi.get(id);
    if (!pending) return false;
    pending(response);
    return true;
  }

  async prompt(message: string): Promise<void> {
    // expandPromptTemplates lets "/name" resolve to its template or extension
    // command, which is how the TUI treats the same input.
    await this.session.prompt(message, { expandPromptTemplates: true });
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  /** True when nothing is streaming — a command that ran no agent turn is idle. */
  isIdle(): boolean {
    try {
      return this.session.isIdle?.() ?? !this.session.isStreaming?.();
    } catch {
      return true;
    }
  }

  dispose(): void {
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
      },
      thinkingLevel: this.session.thinkingLevel ?? "medium",
      autoCompactionEnabled: callable(this.session, "autoCompactionEnabled") ?? true,
      messageCount: callable(this.session, "messages")?.length,
    };
  }

  async getStats(): Promise<PiStats> {
    const stats = (await this.session.getSessionStats?.()) ?? {};
    const usage = (await this.session.getContextUsage?.()) ?? {};
    const contextWindow = usage.contextWindow ?? this.session.model?.contextWindow ?? 0;
    const used = usage.tokens ?? 0;
    return {
      tokens: stats.tokens ?? { input: 0, output: 0, total: 0 },
      cost: stats.cost ?? 0,
      contextUsage: {
        tokens: used,
        contextWindow,
        percent: usage.percent ?? (contextWindow ? (used / contextWindow) * 100 : 0),
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

  /** Only models with working auth, unlike RPC which listed the whole catalogue. */
  async getModels(): Promise<PiState["model"][]> {
    const available = (await this.modelRuntime.getAvailable?.()) ?? [];
    return available.map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider,
      contextWindow: m.contextWindow,
    }));
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
    await this.session.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
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

  async reload(): Promise<void> {
    await this.session.reload();
  }

  /** HTML unless a .jsonl path is given, matching pi's own /export. */
  async exportSession(target?: string): Promise<string> {
    if (target && target.endsWith(".jsonl")) return this.session.exportToJsonl(target);
    return await this.session.exportToHtml(target);
  }
}
