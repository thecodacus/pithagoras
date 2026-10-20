import { Type } from "typebox";
import { fail, say } from "./tool-result.js";
import { piDependency } from "./package.js";
import { GATEWAY_TOOL } from "./tools-gateway-names.js";
import { oneOf } from "./tool-schema.js";

/**
 * One tool for all the tools a conversation has as lazy.
 *
 * A lazy tool is not in what the model is offered, so its schema and description cost nothing in a
 * conversation that never needs it. This is how the model reaches it when it does: it searches by what
 * the tool does, asks for the parameters of the one it found, and calls it. The portal offers the tool
 * only while the conversation has a lazy tool, and the tools are the conversation's own, not a second
 * list: what is switched off stays off here. A lazy tool is a tool that is on in every other respect; it
 * is only not in the list.
 *
 * A call is the same call as a direct one. pi puts every call through the extensions' hooks, the guard's
 * among them, and a call made from inside a tool would skip them, so the hooks are run here for the tool
 * that is called, with its name and its arguments. Everything the guard holds a direct call to holds
 * this one too: the allowlist of sites the agent's tools may reach, the rules after untrusted content, who may run what.
 */

/** What the gateway asks of the conversation it serves, which the client that owns the tool switches provides. */
export interface GatewayHost {
  /** pi's session: the tool definitions, and the extensions' hooks that a call is put through. */
  session: () => any;
  /** The tools that are on, that pi wants active, and that are reached only through the gateway. */
  lazy: () => ReadonlySet<string>;
  /** The tools switched off, which no way leads to. */
  off: () => ReadonlySet<string>;
}

/** pi's own check of a call's arguments, which a direct call goes through: loaded from pi's copy of pi-ai. */
let piAi: Promise<any> | undefined;

/** How many tools one search lists: enough to choose from, few enough not to be the prompt it replaced. */
const SEARCH_LIMIT = 20;

/** How much of a description a search shows of each tool. */
const BLURB = 140;

interface Lazy {
  name: string;
  description: string;
  parameters: unknown;
  /** What the tool's extension wrote for the system prompt about it: see lazyGuidelines. */
  guidelines: string[];
}

/** The first line of a description, shortened: enough to tell tools apart. */
function blurb(description: string): string {
  const line = description.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > BLURB ? `${line.slice(0, BLURB - 1).trimEnd()}…` : line;
}

/** Words for matching: a name's underscores and hyphens are word breaks, as the model would say them. */
const words = (text: string): string[] => text.toLowerCase().replace(/[_\-.]+/g, " ").split(/\s+/).filter(Boolean);

/** The arguments of a call, from an object or from the text of one: models send either. */
function argsOf(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return fail("args must be an object of the tool's arguments, or the JSON text of one.");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("args must be an object of the tool's arguments.");
  }
  return { ...(value as Record<string, unknown>) };
}

/**
 * The one line that tells the model which lazy tools exist, by the names of their sets: the tools are not
 * in its list, and a model that does not know of them says it cannot do what they do.
 */
export function lazyHint(sets: readonly string[]): string {
  if (!sets.length) return `Some tools are not in your list one by one. Search them with the ${GATEWAY_TOOL} tool before you say you cannot do something.`;
  const list = sets.length > 1 ? `${sets.slice(0, -1).join(", ")} and ${sets[sets.length - 1]}` : sets[0];
  return `You have ${list} tools; search for them with the ${GATEWAY_TOOL} tool.`;
}

export class ToolsGateway {
  private host?: GatewayHost;
  /** The extension API of the runner that has the tool registered, to register it again when what it says changes. */
  private api?: any;
  /** The rules of the lazy tools, which the tool says in their place: see lazyGuidelines. */
  private rules: string[] = [];
  /** Where the calls of tools that run one at a time wait for each other: see inTurn. */
  private line: Promise<void> = Promise.resolve();
  /** The definition this gateway registered last: what tells its tool from an extension's of the same name, see owns. */
  private definition?: unknown;
  /** The calls of the gateway that another tool made (a code mode script's), by their ids, with the call that made each. */
  private madeBy = new Map<string, string>();

  constructor(private sets: string[] = []) {}

  /**
   * Say which sets the lazy tools are in. The hint is part of the tool's registration, so a change
   * registers the tool again, which has pi read its description and guidelines afresh.
   */
  hint(sets: string[]): void {
    this.sync(sets);
  }

  /** Read the rules of the lazy tools again, for when a tool has turned up or the tools have been switched. */
  refresh(): void {
    this.sync(this.sets);
  }

  private sync(sets: string[]): void {
    const rules = this.lazyGuidelines();
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i]);
    const unchanged = same(sets, this.sets) && same(rules, this.rules);
    this.sets = sets;
    this.rules = rules;
    if (unchanged || !this.api) return;
    try {
      this.register(this.api);
    } catch (e) {
      console.error(`[portal] could not update the ${GATEWAY_TOOL} tool: ${(e as Error).message}`);
    }
  }

  /** Once the session exists: the extension is registered before it does. */
  attach(host: GatewayHost): void {
    this.host = host;
  }

  /** The tool pi runs under the gateway's name: the first registration of the name is pi's, and inline extensions load after the others. */
  private held(): unknown {
    return this.host?.session()?.extensionRunner?.getToolDefinition?.(GATEWAY_TOOL);
  }

  /**
   * Whether the tool called `tools` that pi runs is this gateway. `tools` is a name any extension may use, and
   * the portal's loads last, so an extension's tool of that name is the one pi keeps and the one the model
   * calls. What the portal trusts the gateway for (the guard lets a colleague use it) is for this tool alone,
   * which a name does not tell from another that has the same one.
   */
  owns(): boolean {
    const held = this.held();
    return held !== undefined && held === this.definition;
  }

  /** Whether an extension's tool of the gateway's name is what pi has: the gateway is then out of reach, and nothing is lazy. */
  taken(): boolean {
    const held = this.held();
    return held !== undefined && held !== this.definition;
  }

  /** The lazy tools this conversation has: those pi has registered, less any that is also switched off. */
  private lazyTools(): Lazy[] {
    const host = this.host;
    if (!host) return [];
    const lazy = host.lazy();
    const off = host.off();
    const all: any[] = host.session()?.getAllTools?.() ?? [];
    return all
      .filter((tool) => tool.name !== GATEWAY_TOOL && lazy.has(String(tool.name)) && !off.has(String(tool.name)))
      .map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters,
        guidelines: (Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []).filter((line: unknown): line is string => typeof line === "string"),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The rules the lazy tools' extensions wrote for the system prompt, each once.
   *
   * pi puts a tool's rules in the prompt only while the tool is active, and a lazy tool is not: what
   * its schema and description cost is saved, but its rules are not that. So the tool says them here,
   * where they are in the prompt as long as there is a lazy tool that has them. (The line that outside
   * content is data is the portal's, said while a lazy tool declares it: see outsideLines in sdk-client.ts.)
   */
  private lazyGuidelines(): string[] {
    const lines = new Set<string>();
    for (const tool of this.lazyTools()) for (const line of tool.guidelines) if (line.trim()) lines.add(line.trim());
    return [...lines];
  }

  /**
   * Run a call in its turn when its tool must run alone.
   *
   * pi runs the calls of one message one after another when one of the tools called is sequential (the
   * browser's are: a click and a typed word race each other on one tab), and else at the same time. Every
   * call through the gateway is a call of the one tool `tools`, which pi cannot tell from the tool it calls,
   * so the calls of sequential tools wait for each other here, in the order pi started them, as they would
   * called directly. Calls of other tools do not wait.
   */
  private inTurn<T>(alone: boolean, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (!alone) return work();
    const turn = this.line.then(() => {
      if (signal?.aborted) fail("Operation aborted");
      return work();
    });
    this.line = turn.then(() => {}, () => {});
    return turn;
  }

  /** The lazy tool of this name, or the reason there is none: what the model is told to do instead. */
  private find(name: string): Lazy {
    if (!name) return fail("Name the tool: search finds the names.");
    if (this.host?.off().has(name)) {
      return fail(`"${name}" is switched off in this conversation, here as everywhere. Say that it is switched off rather than looking for another way to it.`);
    }
    const tool = this.lazyTools().find((t) => t.name === name);
    if (tool) return tool;
    const active: string[] = this.host?.session()?.getActiveToolNames?.() ?? [];
    if (active.includes(name)) return fail(`"${name}" is not a lazy tool: call it directly by its own name.`);
    return fail(`There is no lazy tool called "${name}". Use search to find the names.`);
  }

  private search(query: string): ReturnType<typeof say> {
    const lazy = this.lazyTools();
    if (!lazy.length) return say("There are no lazy tools in this conversation.");
    const terms = words(query);
    const scored = lazy
      .map((tool) => {
        const text = words(`${tool.name} ${tool.description}`).join(" ");
        // A term counts where it is in the name or the description, also as the start of a word: "screen" finds "screenshot".
        return { tool, score: terms.filter((term) => text.includes(term)).length };
      })
      .filter((hit) => !terms.length || hit.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
    if (!scored.length) return say(`No lazy tool matches "${query}". Search with other words, or with none to list them all.`);
    const shown = scored.slice(0, SEARCH_LIMIT);
    const lines = shown.map(({ tool }) => `- ${tool.name}: ${blurb(tool.description) || "(no description)"}`);
    const more = scored.length > shown.length ? `\n${scored.length - shown.length} more match: narrow the search.` : "";
    return say(`${scored.length} lazy tool${scored.length === 1 ? "" : "s"}${query.trim() ? ` matching "${query.trim()}"` : ""}:\n${lines.join("\n")}${more}\n\nUse describe for the parameters of one, then call.`);
  }

  private describe(name: string): ReturnType<typeof say> {
    const tool = this.find(name);
    return say(`${tool.name}\n\n${tool.description || "(no description)"}\n\nParameters (JSON schema):\n${JSON.stringify(tool.parameters ?? {})}`);
  }

  private call(id: string, name: string, rawArgs: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
    const tool = this.find(name);
    const session = this.host?.session();
    const definition = session?.getToolDefinition?.(tool.name);
    // Taken at once, before anything is awaited, so the turns are in the order pi started the calls.
    return this.inTurn(definition?.executionMode === "sequential", signal, () => this.callTool(tool, definition, session, id, rawArgs, signal, onUpdate, ctx));
  }

  private async callTool(tool: Lazy, definition: any, session: any, id: string, rawArgs: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) {
    const runner = session?.extensionRunner;
    // Without the hooks the call would skip the guard, so there is no call.
    if (!definition || typeof runner?.emitToolCall !== "function" || typeof runner.emitToolResult !== "function") return fail(`"${tool.name}" cannot be called from here.`);

    // As pi does for a direct call, in its order: prepare the arguments, then validate (and coerce) them against the
    // schema, so the hooks and the tool see what they would see from a direct call. A failure is the call's error.
    let args = argsOf(rawArgs);
    if (typeof definition.prepareArguments === "function") args = argsOf(definition.prepareArguments(args));
    const { validateToolArguments } = await (piAi ??= piDependency("@earendil-works/pi-ai"));
    args = validateToolArguments(definition, { type: "toolCall", id, name: tool.name, arguments: args });

    // A call a script made carries the call that made it to the hooks, as a tool the script calls directly does: what
    // it reads is held for the script's own result, which is what the model is given. Without it the guard would
    // take the read for a call of the model's, and the script's result would go unwrapped.
    const parent = this.madeBy.get(id);
    const madeBy = parent ? { parentToolCallId: parent } : {};

    // As pi does for a direct call: the hooks before it, which may refuse it or change its arguments in place.
    const verdict = runner.hasHandlers("tool_call") ? await runner.emitToolCall({ type: "tool_call", toolName: tool.name, toolCallId: id, ...madeBy, input: args }) : undefined;
    // A stop that came while a hook was awaited keeps the tool from running, as it does for a direct call.
    if (signal?.aborted) return fail("Operation aborted");
    if (verdict?.block) {
      // An error result and not a throw, so that a refusal that says to stop (terminate) ends the turn, as it does for a direct call.
      return { content: [{ type: "text" as const, text: verdict.reason || `"${tool.name}" was refused.` }], details: {}, isError: true, ...(verdict.terminate === true ? { terminate: true } : {}) };
    }

    let result: any;
    let isError = false;
    try {
      result = await definition.execute(id, args, signal, onUpdate, ctx);
      // As pi 1.1 reads it: a tool that fails without throwing says so in its result.
      isError = result?.isError === true;
    } catch (e) {
      isError = true;
      result = { content: [{ type: "text", text: (e as Error)?.message ?? String(e) }], details: {} };
    }
    // And the hooks after it: what the guard wraps as untrusted, and the taint it takes from it, are read here.
    if (runner.hasHandlers("tool_result")) {
      const hooked = await runner.emitToolResult({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: id,
        ...madeBy,
        input: args,
        content: result?.content,
        details: result?.details,
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        isError,
        usage: result?.usage,
      });
      if (hooked) {
        // The hooks' result holds the structured content that is left: one that replaced the content has dropped the old.
        result = {
          ...result,
          content: hooked.content ?? result?.content,
          details: hooked.details ?? result?.details,
          usage: hooked.usage ?? result?.usage,
        };
        if (hooked.structuredContent === undefined) delete result.structuredContent;
        else result.structuredContent = hooked.structuredContent;
        isError = hooked.isError ?? isError;
      }
    }
    // The result as the tool returned it, so pi has what a direct call gives it: what else the result carries (terminate,
    // structuredContent, usage), and the error flag, which pi reads off the result: it is what the hooks made of it.
    const answer = { ...result, content: result?.content ?? [], details: result?.details ?? {} };
    if (isError || answer.isError !== undefined) answer.isError = isError;
    return answer;
  }

  /** An ExtensionFactory — see pi's InlineExtension. */
  extension = (pi: any): void => {
    this.api = pi;
    this.register(pi);
    // Which call made a call of the gateway, as pi says it. The hooks about the gateway's own call come before it runs.
    pi.on("tool_call", (event: any) => {
      if (event?.toolName === GATEWAY_TOOL && typeof event.parentToolCallId === "string" && event.parentToolCallId) {
        this.madeBy.set(String(event.toolCallId), event.parentToolCallId);
      }
    });
    pi.on("tool_result", (event: any) => {
      if (event?.toolName === GATEWAY_TOOL) this.madeBy.delete(String(event.toolCallId));
    });
  };

  private register(pi: any): void {
    const definition = {
      name: GATEWAY_TOOL,
      label: "Tools",
      description:
        "Reach the tools not in your list. action search: find them by words (no query lists all); describe: one tool's description and parameters (name); " +
        "call: run it (name, args). Describe a tool before its first call.",
      promptSnippet: "search, describe and call the tools kept out of this list",
      promptGuidelines: [
        lazyHint(this.sets),
        // The lazy tools' own rules, which their extensions meant for the prompt: see lazyGuidelines.
        ...this.rules,
      ],
      parameters: Type.Object({
        action: oneOf(["search", "describe", "call"]),
        query: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        args: Type.Optional(
          Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()], { description: "The tool's arguments: an object, or its JSON text" })
        ),
      }),
      execute: async (id: string, p: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => {
        const name = typeof p?.name === "string" ? p.name.trim() : "";
        switch (p?.action) {
          case "search":
            return this.search(typeof p.query === "string" ? p.query : "");
          case "describe":
            return this.describe(name);
          case "call":
            return this.call(id, name, p.args, signal, onUpdate, ctx);
          default:
            return fail('action is search, describe or call.');
        }
      },
    };
    this.definition = definition;
    pi.registerTool(definition);
  }
}
