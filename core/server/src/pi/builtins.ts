import type { PiClient, PiCommand } from "./types.js";
import { piFile } from "./package.js";

/**
 * pi's built-in slash commands are implemented by whichever mode is running,
 * so `session.getCommands()` returns only extensions, templates and skills —
 * the TUI draws its own. The portal has to supply them too.
 *
 * The names and descriptions are read from the SDK's own BUILTIN_SLASH_COMMANDS
 * so they track pi's releases, but that module is not on the package's exports
 * map, so it is resolved by file path rather than a bare specifier.
 *
 * `where` decides who handles a command — the server acts on the session, the
 * client opens a piece of UI. Commands not listed here are TUI concerns
 * (`/quit`, `/hotkeys`, `/trust`, the auth pair) and are left out rather than
 * offered as a menu of things that quietly do nothing.
 */
const PORTAL_SUPPORTED: Record<string, "server" | "client"> = {
  compact: "server",
  session: "server",
  export: "server",
  reload: "server",
  model: "client",
  settings: "client",
  new: "client",
  clear: "client",
  name: "client",
};

/**
 * What the portal says about the commands it reinterprets. These win over pi's
 * own wording: pi's /clear talks about clearing the context, while here it
 * starts another chat, and the menu must not promise the one that is not done.
 */
const PORTAL_DESCRIPTIONS: Record<string, string> = {
  new: "Start a new chat in this folder",
  clear: "Start a fresh chat in this folder",
};

/** Used only if the SDK's internal module moves; keeps `/` working regardless. */
const FALLBACK_DESCRIPTIONS: Record<string, string> = {
  compact: "Manually compact the session context",
  session: "Show session info and stats",
  export: "Export session (HTML default, or specify path: .html/.jsonl)",
  reload: "Reload extensions, skills, prompts and settings",
  model: "Select model",
  settings: "Open settings",
  new: "Start a new session",
  clear: "Start a fresh chat in this folder",
  name: "Set session display name",
};

export interface BuiltinCommand extends PiCommand {
  where: "server" | "client";
  argumentHint?: string;
  /** Does nothing without an argument, so the menu completes it rather than running it. */
  needsArgument?: boolean;
}

/** `/name` with no name is a command that silently does nothing. */
const NEEDS_ARGUMENT = new Set(["name"]);

let cached: BuiltinCommand[] | undefined;

/** pi's builtins, filtered to the ones the portal actually implements. */
export async function getBuiltinCommands(): Promise<BuiltinCommand[]> {
  if (cached) return cached;

  let sdkCommands: { name: string; description: string; argumentHint?: string }[] = [];
  try {
    const mod: any = await import(piFile("core/slash-commands.js").href);
    sdkCommands = mod.BUILTIN_SLASH_COMMANDS ?? [];
  } catch (e) {
    console.error(`[portal] builtin command list unavailable from SDK: ${(e as Error).message}`);
  }

  const bySdk = new Map(sdkCommands.map((c) => [c.name, c]));
  cached = Object.entries(PORTAL_SUPPORTED).map(([name, where]) => ({
    name,
    description: PORTAL_DESCRIPTIONS[name] ?? bySdk.get(name)?.description ?? FALLBACK_DESCRIPTIONS[name],
    argumentHint: bySdk.get(name)?.argumentHint,
    ...(NEEDS_ARGUMENT.has(name) ? { needsArgument: true } : {}),
    source: "builtin",
    where,
  }));
  return cached;
}

export async function findServerBuiltin(name: string): Promise<BuiltinCommand | undefined> {
  return (await getBuiltinCommands()).find((c) => c.name === name && c.where === "server");
}

/**
 * Why `message` cannot be sent with pictures, or undefined if it can.
 *
 * A portal command acts on the session and never reaches the model, so
 * pictures sent with one would be lost without a word. Asked before anything
 * is done with them, so the refusal reaches someone who can put them back.
 */
export async function picturesRefused(message: string): Promise<string | undefined> {
  const name = /^\/([\w-]+)/.exec(message.trim())?.[1];
  if (name && (await findServerBuiltin(name))) {
    return `/${name} does not take pictures. Send them in a message of their own.`;
  }
  return undefined;
}

/** Run a server-side builtin, returning the notice to show in the transcript. */
export async function runBuiltin(name: string, args: string, client: PiClient): Promise<string> {
  switch (name) {
    case "compact":
      await client.compact();
      return "Context compacted.";

    case "reload":
      await client.reload();
      return "Reloaded extensions, skills, prompts and settings.";

    case "session": {
      const [state, stats] = await Promise.all([client.getState(), client.getStats()]);
      return [
        `Model: ${state.model.name}`,
        `Effort: ${state.thinkingLevel}`,
        stats.contextUsage.tokens === null || stats.contextUsage.percent === null
          ? `Context: unknown until the next reply / ${stats.contextUsage.contextWindow.toLocaleString()}`
          : `Context: ${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} (${stats.contextUsage.percent.toFixed(1)}%)`,
        `Tokens: ${stats.tokens.input.toLocaleString()} in, ${stats.tokens.output.toLocaleString()} out`,
        `Cost: $${stats.cost.toFixed(4)}`,
        `Tool calls: ${stats.toolCalls}`,
      ].join("\n");
    }

    case "export": {
      const file = await client.exportSession(args.trim() || undefined);
      return `Exported to ${file}`;
    }

    default:
      throw new Error(`'${name}' is not a server-side command`);
  }
}
