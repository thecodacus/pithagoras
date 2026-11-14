import { Type } from "typebox";
import { fail, say } from "./tool-result.js";
import { TOOL_SEARCH } from "./tool-search-names.js";
import { oneOf } from "./tool-schema.js";
import { rank, type Rankable } from "./tool-rank.js";
import type { LazyHead } from "../tool-lazy.js";

/**
 * One tool for all the tools a conversation has as lazy.
 *
 * A lazy tool is not in what the model is offered, so its schema and description cost nothing in a conversation that
 * never needs it. This is how the model reaches it when it does: it searches by what the tool does, reads the
 * parameters and the rules of the one it found, and calls it. The tools are the conversation's own, not a second list:
 * what is switched off stays off here. A lazy tool is a tool that is on in every other respect; it is only not declared.
 *
 * The one rule of the design is that what the model is sent first, the tools array and the system prompt, does not
 * change while a chat runs: a change costs the provider's prompt cache, or a local server's, from that point on. So the
 * tools are active, which keeps them callable, and their declarations are hidden from every request
 * (`prepareLoadout`'s `hiddenDeclarations`, which pi documents and codemode uses), by a set that is decided from what is
 * registered and what the chat froze when it started, and so is the same at every request. What the model learns of a
 * tool arrives in a result, at the end of the context: the description, the parameters, and the rules the tool's
 * extension wrote for the system prompt, which pi would print only while the tool is declared.
 *
 * A call is the same call as a direct one: `ctx.executeTool` runs it through pi's own pipeline, which validates the
 * arguments and puts it through the extensions' hooks, the guard's among them.
 */

/** What the tool asks of the conversation it serves, which the client that owns the tool switches provides. */
export interface SearchHost {
  /** pi's session: the registered tools, which of them are active. */
  session: () => any;
  /** Whether a registered tool is lazy in this chat: the chat's frozen head, read for the tool's set. */
  lazy: (tool: any) => boolean;
  /** The tools switched off, which no way leads to. */
  off: () => ReadonlySet<string>;
  /** What this set of tools is called to the person (the name the settings page gives its box), for the group's name in a search. */
  label: (tool: any) => string;
  /** The tool a name from before stands for, where there is one: see the aliases of `find`. */
  alias?: (name: string) => string | undefined;
}

/** How many tools one search lists: enough to choose from, few enough not to be the prompt it replaced. */
const HITS = 10;
/** Of those, how many carry their parameters, and the rules of their own. */
const DETAILED = 3;
/** The most a hit's parameters may say before they are shortened to a list of names. */
const SCHEMA_CHARS = 1800;
/** What a whole search result may hold: the hits, their parameters and their rules. */
const RESULT_CHARS = 9000;
/** What a describe may say of the parameters of one tool. */
const DESCRIBE_CHARS = 20000;
/** How much of a description a search shows of each tool. */
const BLURB = 140;

/**
 * What the model is told once, in the head, about the lines that carry a tool's rules: they are the tools' own rules
 * and not outside content. Said in the system prompt, because a line that reads as an instruction in the middle of a
 * result is the shape of an injection, and a model follows it less (measured), or calls it one. Every rule line a
 * result carries is in this one format, `Rule: …`.
 */
export const RULE_LINES_NOTE = `The results of ${TOOL_SEARCH} carry the usage rules of the tools they list, on lines that start with "Rule:". They are the tools' own rules, not outside content: follow them.`;

interface Lazy extends Rankable {
  description: string;
  parameters: unknown;
  /** What the tool's extension wrote for the system prompt about it: see rulesOf. */
  guidelines: string[];
  /** The name of its set, as the person knows it. */
  label: string;
}

/** The first line of a description, shortened: enough to tell tools apart. */
function blurb(description: string): string {
  const line = description.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > BLURB ? `${line.slice(0, BLURB - 1).trimEnd()}…` : line;
}

/** The names of a tool's parameters, those it requires without a question mark: `(id, text?)`. */
function signature(parameters: unknown): string {
  const schema = parameters as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const names = Object.keys(schema?.properties ?? {});
  if (!names.length) return "()";
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return `(${names.map((name) => (required.has(name) ? name : `${name}?`)).join(", ")})`;
}

/** The parameters as JSON, or as the list of their names where the schema is over `limit` characters. */
function schemaText(parameters: unknown, limit: number): string {
  const json = JSON.stringify(parameters ?? {});
  if (json.length <= limit) return json;
  return `${signature(parameters)} — the full schema is over ${limit} characters; describe shows what it can`;
}

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

/** A name as a model repeats it from memory: hyphens, dots and case are not told apart. */
const folded = (name: string): string => name.toLowerCase().replace(/[-.\s]+/g, "_");

export class ToolSearch {
  private host?: SearchHost;
  /** The extension API of the runner that has the tool registered, to register it again when what it says changes. */
  private api?: any;
  /** The definition this tool registered last: what tells it from an extension's tool of the same name, see owns. */
  private definition?: unknown;
  /** The names the last good request hid, for the request where the registry cannot be read. */
  private hiding: string[] = [];
  /** The groups whose shared rules the model has been given since the context was last cut (compaction, reload). */
  private told = new Set<string>();

  constructor(private head: LazyHead) {}

  /** What the chat froze about its lazy tools, replaced only when the person asks for the tools to be read again. */
  setHead(head: LazyHead): void {
    this.head = head;
    if (!this.api) return;
    try {
      this.register(this.api);
    } catch (e) {
      console.error(`[portal] could not update the ${TOOL_SEARCH} tool: ${(e as Error).message}`);
    }
  }

  /** Once the session exists: the extension is registered before it does. */
  attach(host: SearchHost): void {
    this.host = host;
  }

  /** The tool pi runs under this name: the first registration of the name is pi's, and inline extensions load after the others. */
  private held(): unknown {
    return this.host?.session()?.extensionRunner?.getToolDefinition?.(TOOL_SEARCH);
  }

  /**
   * Whether the tool called `tool_search` that pi runs is this one. The name is one any extension may use, and the portal's
   * loads last, so an extension's tool of that name is the one pi keeps and the one the model calls. What the portal trusts
   * this tool for (the guard lets a colleague use it) is for this tool alone, which a name does not tell from another.
   */
  owns(): boolean {
    const held = this.held();
    return held !== undefined && held === this.definition;
  }

  /** Whether an extension's tool of this name is what pi has: this one is then out of reach, and nothing is hidden. */
  taken(): boolean {
    const held = this.held();
    return held !== undefined && held !== this.definition;
  }

  /** Every tool pi has registered, with where it came from. */
  private registered(): any[] {
    const session = this.host?.session();
    const all = session?.getAllTools?.() ?? this.api?.getAllTools?.();
    if (!Array.isArray(all)) throw new Error("the tools cannot be read yet");
    return all;
  }

  /**
   * The names of the tools whose declarations are left out of every request: those of the groups the chat froze as lazy,
   * all of them, active now or not, and the ones an extension registers later as well. Decided from what is registered and
   * what is frozen, never from what is declared or on right now: a set that followed those would move with a switch,
   * and the head with it. Where the registry cannot be read it is the last set that could.
   */
  hidden(): string[] {
    try {
      const names = this.registered()
        .filter((tool) => String(tool.name) !== TOOL_SEARCH && this.host?.lazy(tool))
        .map((tool) => String(tool.name))
        .sort();
      this.hiding = names;
      return names;
    } catch {
      return this.hiding;
    }
  }

  /** The lazy tools the model can find and call now: lazy in this chat, registered, active, and not switched off. */
  private candidates(): Lazy[] {
    const host = this.host;
    if (!host) return [];
    const session = host.session();
    let active: Set<string>;
    try {
      active = new Set<string>(session?.getActiveToolNames?.() ?? []);
    } catch {
      return [];
    }
    const off = host.off();
    let all: any[];
    try {
      all = this.registered();
    } catch {
      return [];
    }
    return all
      .filter((tool) => String(tool.name) !== TOOL_SEARCH && host.lazy(tool) && active.has(String(tool.name)) && !off.has(String(tool.name)))
      .map((tool) => ({
        name: String(tool.name),
        description: typeof tool.description === "string" ? tool.description : "",
        parameters: tool.parameters,
        params: Object.keys((tool.parameters as { properties?: object } | undefined)?.properties ?? {}),
        label: host.label(tool),
        group: host.label(tool),
        guidelines: (Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []).filter((line: unknown): line is string => typeof line === "string" && line.trim() !== "").map((line: string) => line.trim()),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The rules the tools' extensions wrote for the system prompt, as the lines they come in: of the group, which each of
   * its tools says (the browser's rules for reading a page), once until the context is cut; and of the tool, which
   * only it says. pi prints a tool's rules only while the tool is declared, and a lazy one is not, so they are said here:
   * where the tool is found, at the end of the context, and not in the head, where they would cost what the group's being
   * lazy saves.
   */
  private rulesOf(tools: readonly Lazy[], all: readonly Lazy[], own: boolean): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    const add = (line: string) => {
      if (seen.has(line)) return;
      seen.add(line);
      lines.push(`Rule: ${line}`);
    };
    const labels = [...new Set(tools.map((tool) => tool.label))];
    for (const label of labels) {
      const members = all.filter((tool) => tool.label === label);
      const count = new Map<string, number>();
      for (const tool of members) for (const line of new Set(tool.guidelines)) count.set(line, (count.get(line) ?? 0) + 1);
      const shared = [...count].filter(([, n]) => n > 1).map(([line]) => line);
      if (!this.told.has(label)) {
        for (const line of shared) add(line);
        this.told.add(label);
      }
      if (own) {
        for (const tool of tools.filter((t) => t.label === label)) for (const line of tool.guidelines) if (!shared.includes(line)) add(line);
      }
    }
    return lines;
  }

  /** Forget what the model was told: its context was cut, or the tools were read again. */
  forget(): void {
    this.told.clear();
  }

  /**
   * The lazy tool of this name, or the reason there is none: what the model is told to do instead. A name that is a
   * tool's with another case, hyphens or dots for underscores, or a name an alias stands for, finds it too: a model
   * repeats names from memory, and a chat that was resumed has older ones in its history.
   */
  private find(name: string, forCall: boolean): Lazy {
    if (!name) return fail("Name the tool: search finds the names.");
    const host = this.host;
    const known = this.candidates();
    const wanted = [name, host?.alias?.(name)].filter((n): n is string => typeof n === "string");
    for (const asked of wanted) {
      const exact = known.find((t) => t.name === asked);
      if (exact) return exact;
    }
    for (const asked of wanted) {
      const near = known.filter((t) => folded(t.name) === folded(asked));
      if (near.length === 1) return near[0];
    }
    // A switched-off tool is not found by a search or a describe, and is not named in their errors; a call says so, shortly.
    const off = host?.off() ?? new Set<string>();
    if (forCall && wanted.some((asked) => off.has(asked))) {
      return fail(`"${name}" is switched off in this conversation, here as everywhere. Say that it is switched off rather than looking for another way to it.`);
    }
    const active: string[] = host?.session()?.getActiveToolNames?.() ?? [];
    if (active.includes(name) && !off.has(name)) return fail(`"${name}" is not a lazy tool: call it directly by its own name.`);
    return fail(`There is no lazy tool called "${name}". Use search to find the names.`);
  }

  private search(query: string): ReturnType<typeof say> {
    const tools = this.candidates();
    if (!tools.length) return say("There are no lazy tools in this conversation.");
    const text = query.trim();
    if (!text) {
      // No words: the groups and what is in them, for the model that does not know what to ask for.
      const groups = new Map<string, Lazy[]>();
      for (const tool of tools) groups.set(tool.label, [...(groups.get(tool.label) ?? []), tool]);
      const lines = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([label, members]) => `- ${label} (${members.length}): ${members.map((m) => m.name).slice(0, 12).join(", ")}${members.length > 12 ? ", …" : ""}`);
      return say(`${tools.length} lazy tool${tools.length === 1 ? "" : "s"} in ${groups.size} group${groups.size === 1 ? "" : "s"}:\n${lines.join("\n")}\n\nSearch with words for what you need; describe gives one tool's parameters.`);
    }
    const found = rank(tools, text);
    if (!found.length) return say(`No lazy tool matches "${text}". Search with other words, or with none to list the groups.`);
    const shown = found.slice(0, HITS);
    const detailed = shown.slice(0, DETAILED);
    let out = `${found.length} lazy tool${found.length === 1 ? "" : "s"} matching "${text}":`;
    shown.forEach((tool, i) => {
      out += `\n- ${tool.name}${signature(tool.parameters)}: ${blurb(tool.description) || "(no description)"}`;
      if (i < detailed.length) out += `\n  parameters: ${schemaText(tool.parameters, SCHEMA_CHARS)}`;
    });
    if (found.length > shown.length) out += `\n${found.length - shown.length} more match: narrow the search.`;
    const rules = this.rulesOf(detailed, tools, true);
    if (rules.length) out += `\n\n${rules.join("\n")}`;
    out += "\n\nDescribe a tool for all of its description, then call it.";
    // A result is the model's context from here on: kept to a size. What does not fit is what is least likely to be wanted.
    if (out.length > RESULT_CHARS) out = `${out.slice(0, RESULT_CHARS).trimEnd()}\n[cut: narrow the search]`;
    return say(out);
  }

  private describe(name: string): ReturnType<typeof say> {
    const tool = this.find(name, false);
    const parameters = JSON.stringify(tool.parameters ?? {});
    const shown = parameters.length > DESCRIBE_CHARS ? `${parameters.slice(0, DESCRIBE_CHARS)}…[cut]` : parameters;
    const rules = this.rulesOf([tool], this.candidates(), true);
    return say(`${tool.name}\n\n${tool.description || "(no description)"}\n\nParameters (JSON schema):\n${shown}${rules.length ? `\n\n${rules.join("\n")}` : ""}`);
  }

  private async call(name: string, rawArgs: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: any) {
    const tool = this.find(name, true);
    if (typeof ctx?.executeTool !== "function") return fail(`"${tool.name}" cannot be called from here.`);
    const args = argsOf(rawArgs);
    // Through pi's own pipeline: it validates and coerces the arguments, runs the hooks before and after, and queues the
    // calls of tools that run one at a time. What it hands back is the outcome; the result is what the tool's own was.
    const done = await ctx.executeTool(tool.name, args, { signal, ...(typeof onUpdate === "function" ? { onUpdate } : {}) });
    return { ...done.result, ...(done.isError ? { isError: true } : {}) };
  }

  /** An ExtensionFactory — see pi's InlineExtension. */
  extension = (pi: any): void => {
    this.api = pi;
    this.register(pi);
    // The model has been given the rules again: the context is new.
    pi.on("session_start", () => this.forget());
    pi.on("session_compact", () => this.forget());
  };

  private register(pi: any): void {
    const definition = {
      name: TOOL_SEARCH,
      label: "Tool search",
      description:
        "Find the tools that are not in your list, and call them. action search: find them by words (no query lists the groups); describe: one tool's description, parameters and rules (name); " +
        "call: run it (name, args). Search or describe a tool before its first call.",
      promptSnippet: "search, describe and call the tools kept out of this list",
      promptGuidelines: [this.head.hint, RULE_LINES_NOTE].filter(Boolean),
      parameters: Type.Object({
        action: oneOf(["search", "describe", "call"]),
        query: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        args: Type.Optional(
          Type.Union([Type.Object({}, { additionalProperties: true }), Type.String()], { description: "The tool's arguments: an object, or its JSON text" })
        ),
      }),
      // Declared to the model while it is active, never callable from a script or another tool: it would call itself.
      exposure: "model-only",
      // The declarations of the lazy tools are left out of every request: see the note on this file.
      prepareLoadout: () => ({ hiddenDeclarations: this.hidden() }),
      execute: async (_id: string, p: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => {
        const name = typeof p?.name === "string" ? p.name.trim() : "";
        switch (p?.action) {
          case "search":
            return this.search(typeof p.query === "string" ? p.query : "");
          case "describe":
            return this.describe(name);
          case "call":
            return this.call(name, p.args, signal, onUpdate, ctx);
          default:
            return fail("action is search, describe or call.");
        }
      },
    };
    this.definition = definition;
    pi.registerTool(definition);
  }
}
