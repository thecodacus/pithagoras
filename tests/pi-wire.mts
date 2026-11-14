// A real pi session whose requests are captured as the provider adapters build them, for the tests of what the model is
// given: the `tools` array and the system prompt that head every request.
//
// Nothing goes over the network. pi runs as it does in the portal (the session, its extensions, the agent loop), and its
// stream function is replaced by one that asks the real adapter of the model's API to build its request and stops at
// `onPayload`, the hook every adapter calls with the finished body, then answers with what the test scripted. So what is
// captured is what a provider would have received, byte for byte, and the model's words are the test's.
//
// Import it before anything else of pi's: it points pi's agent directory at a folder of its own first.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const agentDir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "pitha-wire-"));
mkdirSync(path.join(agentDir, "agent"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(agentDir, "agent");
// A server of the kind a person runs themselves, which pi has no catalog entry for: its own provider, as models.json has it.
writeFileSync(
  path.join(agentDir, "agent", "models.json"),
  JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "none", models: [{ id: "local-model", name: "Local", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }] } } }),
);
// What this file made, and no more.
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));

export const pi: any = await import("@earendil-works/pi-coding-agent");
const piAi: any = await import("@earendil-works/pi-ai");
const adapters: Record<string, any> = {
  "anthropic-messages": await import("@earendil-works/pi-ai/api/anthropic-messages"),
  "openai-responses": await import("@earendil-works/pi-ai/api/openai-responses"),
  "openai-completions": await import("@earendil-works/pi-ai/api/openai-completions"),
  "google-generative-ai": await import("@earendil-works/pi-ai/api/google-generative-ai"),
  "google-vertex": await import("@earendil-works/pi-ai/api/google-vertex"),
  "mistral-conversations": await import("@earendil-works/pi-ai/api/mistral-conversations"),
  "bedrock-converse-stream": await import("@earendil-works/pi-ai/api/bedrock-converse-stream"),
};

/** One scripted answer of the model: words, or calls of tools (`{ name, args }`). */
export type Say = string | { name: string; args: unknown } | { name: string; args: unknown }[];

/** The request one adapter built, as the JSON the provider would have been sent. */
export interface Captured {
  /** The whole body. */
  body: any;
  /** The tool declarations of the head, serialised: what the provider caches on first. */
  tools: string;
  /** The system prompt of the head, serialised. */
  system: string;
}

const stop = new Error("request captured");

/**
 * Where each API keeps the head of its request. Both are JSON text, so that two requests are equal when the text is:
 * a byte-identical head is what the provider's prompt cache and a local server's KV cache both need.
 */
export function headOf(api: string, body: any): { tools: string; system: string } {
  switch (api) {
    case "anthropic-messages":
      return { tools: JSON.stringify(body.tools ?? null), system: JSON.stringify(body.system ?? null) };
    case "openai-responses":
      // The Responses API takes the prompt as the first input item, or as `instructions`.
      return {
        tools: JSON.stringify(body.tools ?? null),
        system: JSON.stringify(body.instructions ?? body.input?.filter((i: any) => i?.role === "system" || i?.role === "developer").slice(0, 1) ?? null),
      };
    case "openai-completions":
      return { tools: JSON.stringify(body.tools ?? null), system: JSON.stringify(body.messages?.filter((m: any) => m?.role === "system" || m?.role === "developer").slice(0, 1) ?? null) };
    case "google-generative-ai":
    case "google-vertex":
      return { tools: JSON.stringify(body.config?.tools ?? body.tools ?? null), system: JSON.stringify(body.config?.systemInstruction ?? body.systemInstruction ?? null) };
    case "mistral-conversations":
      return { tools: JSON.stringify(body.tools ?? null), system: JSON.stringify(body.messages?.filter((m: any) => m?.role === "system").slice(0, 1) ?? null) };
    case "bedrock-converse-stream":
      return { tools: JSON.stringify(body.toolConfig ?? null), system: JSON.stringify(body.system ?? null) };
    default:
      throw new Error(`no head known for ${api}`);
  }
}

/**
 * A pi session on `model` whose model is scripted and whose requests are captured.
 * `extensions` are inline extension factories; `script` says what the model does at each request, by its number.
 */
export async function wireSession(model: any, extensions: ((pi: any) => void)[], script: (n: number, requests: Captured[]) => Say | undefined, options: { tools?: string[]; cwd?: string; sessionManager?: any } = {}) {
  const cwd = options.cwd ?? mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "pitha-wire-cwd-"));
  const modelRuntime = await pi.ModelRuntime.create();
  // A key of no account: the session wants one to take a prompt, and the adapter never sends it anywhere.
  await modelRuntime.setRuntimeApiKey(model.provider, "test-key");
  const settingsManager = pi.SettingsManager.inMemory ? pi.SettingsManager.inMemory() : pi.SettingsManager.create(cwd, pi.getAgentDir());
  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir: pi.getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: extensions.map((factory, i) => ({ name: `wire-${i}`, factory })),
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd,
    modelRuntime,
    model,
    settingsManager,
    resourceLoader: loader,
    sessionManager: options.sessionManager ?? pi.SessionManager.inMemory(),
    ...(options.tools ? { tools: options.tools } : {}),
  });
  const requests: Captured[] = [];
  const adapter = adapters[model.api];
  if (!adapter) throw new Error(`no adapter for ${model.api}`);
  session.agent.streamFunction = async (m: any, context: any, opts: any) => {
    // The real adapter builds the request, from the same transcript pi would send, and stops at the finished body.
    let body: any;
    const real = adapter.streamSimple(m, context, {
      ...opts,
      apiKey: "test-key",
      onPayload: async (payload: any, mm: any) => {
        const transformed = (await opts?.onPayload?.(payload, mm)) ?? payload;
        body = JSON.parse(JSON.stringify(transformed));
        throw stop;
      },
    });
    for await (const _ of real) {
      // drained: the adapter ends with an error event, because the request was stopped
    }
    if (!body) throw new Error("the adapter did not build a request");
    requests.push({ body, ...headOf(m.api, body) });
    const said = script(requests.length - 1, requests);
    const content = typeof said === "string" || said === undefined
      ? [piAi.fauxText?.(said ?? "Done.") ?? { type: "text", text: said ?? "Done." }]
      : [said].flat().map((call, i) => ({ type: "toolCall", id: `call_${requests.length}_${i}`, name: call.name, arguments: call.args }));
    const calls = typeof said === "object" && said !== null;
    const message = {
      role: "assistant",
      content,
      api: m.api,
      provider: m.provider,
      model: m.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: calls ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    const out = new piAi.AssistantMessageEventStream();
    out.push({ type: "done", reason: message.stopReason, message });
    return out;
  };
  // What the extensions say to the person (`ctx.ui.notify`), kept: the notices of pi's own MCP support are among the things to check.
  const notices: { text: string; type: string }[] = [];
  const noop = () => undefined;
  const uiContext = {
    select: async () => undefined, confirm: async () => false, input: async () => undefined,
    notify: (text: string, type = "info") => void notices.push({ text, type }),
    onTerminalInput: () => noop, setStatus: noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop,
    setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop, custom: async () => undefined, pasteToEditor: noop, setEditorText: noop,
    getEditorText: () => "", editor: async () => undefined, addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: noop,
    theme: {}, getAllThemes: () => [], getTheme: noop, setTheme: () => ({ success: false, error: "no UI" }), getToolsExpanded: () => false, setToolsExpanded: noop,
  };
  const errors: { event: string; error: string }[] = [];
  await session.bindExtensions({ uiContext, onError: (e: any) => void errors.push({ event: e.event, error: e.error }) });
  /** What the portal's client does when it lets a session go (see SdkPiClient.shutdown): dispose() alone leaves the extensions' servers running. */
  const close = async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
      if (!options.cwd) rmSync(cwd, { recursive: true, force: true });
    }
  };
  return { session, requests, modelRuntime, cwd, notices, errors, close };
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const schema = (Type: any) => Type.Object({ x: Type.Optional(Type.String({ description: "what to do it with" })) });

/** The tools of a lazy group of the tests: what they say about themselves reaches the model only through a search. */
export const GROUP = ["alpha_open", "alpha_read"] as const;

/**
 * What a tool search is, as the tests stand it up before the portal has one: a group of tools that stays active and
 * callable but is left out of every request (pi's `prepareLoadout` with `hiddenDeclarations`), and one tool, `tool_search`,
 * that finds them as text and calls them through `ctx.executeTool`. The tools array and the system prompt never change.
 */
export async function callThrough(): Promise<(pi: any) => void> {
  const { Type } = await import("typebox");
  return (p: any) => {
    for (const name of [...GROUP, "plain_tool"]) {
      p.registerTool({
        name,
        label: name,
        description: `${name} does one thing with its argument.`,
        promptSnippet: `${name} snippet`,
        promptGuidelines: [`${name} rule`],
        parameters: schema(Type),
        async execute(_id: string, args: any) {
          return reply(`${name} ran ${JSON.stringify(args)}`);
        },
      });
    }
    p.registerTool({
      name: "tool_search",
      label: "tool_search",
      description: "Find the tools that are not in your list, and call them. action search, describe or call.",
      promptSnippet: "find and call the tools kept out of this list",
      parameters: Type.Object({ action: Type.String(), name: Type.Optional(Type.String()), args: Type.Optional(Type.Any()) }),
      exposure: "model-only",
      // The group is decided here, from a fixed list and not from anything live: the same on every request.
      // The whole group, whether a tool of it is active now or not: a tool switched off in the middle of a chat is then taken
      // out of the model's list without a word to the provider about a tool it never had (see the spike on `toolsRemoved`).
      prepareLoadout: () => ({ hiddenDeclarations: [...GROUP] }),
      async execute(_id: string, a: any, signal: AbortSignal, _update: unknown, ctx: any) {
        if (a.action === "call") return (await ctx.executeTool(a.name, a.args ?? {}, { signal })).result;
        return reply(`${GROUP.join(", ")}: each takes {"x": string}`);
      },
    });
  };
}

/**
 * pi's own way of offering a found tool, for the tests to compare with: the tools of the group are registered `deferred`,
 * and the search activates them, so the next request declares them (a tool added to the list, or a mid-conversation
 * update, whichever the provider's adapter can send).
 */
export async function nativeLoading(): Promise<(pi: any) => void> {
  const { Type } = await import("typebox");
  return (p: any) => {
    for (const name of GROUP) {
      p.registerTool({
        name,
        label: name,
        description: `${name} does one thing with its argument.`,
        promptSnippet: `${name} snippet`,
        promptGuidelines: [`${name} rule`],
        exposure: "deferred",
        parameters: schema(Type),
        async execute(_id: string, args: any) {
          return reply(`${name} ran ${JSON.stringify(args)}`);
        },
      });
    }
    p.registerTool({
      name: "tool_search",
      label: "tool_search",
      description: "Find the tools that are not in your list and load them.",
      promptSnippet: "find and load the tools kept out of this list",
      parameters: Type.Object({ action: Type.String() }),
      exposure: "model-only",
      async execute() {
        p.setActiveTools([...p.getActiveTools(), ...GROUP]);
        return reply(`loaded ${GROUP.join(", ")}`);
      },
    });
  };
}
