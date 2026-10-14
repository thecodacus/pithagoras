import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DATA_DIR as DATA_SETTING } from "../data-dir.js";

/**
 * While the sandbox is on, the folder a chat works in is the agent's to write,
 * and pi and the MCP adapter run inside the portal, as root. So what either
 * would take from that folder and run is not taken from it: pi's project
 * extensions, packages and settings (pi's own "untrusted project"), and the MCP
 * servers named in the folder's `.mcp.json` or `.pi/mcp.json`, or imported by
 * them. The folder's skills are text the model reads, and are kept.
 */

/** pi's settings for a chat in `cwd`, with the folder untrusted: its settings, extensions and packages left out. */
export function untrustedSettings(pi: any, cwd: string): unknown {
  return pi.SettingsManager.create(cwd, pi.getAgentDir(), { projectTrusted: false });
}

/** The folder of the repository `dir` is in, as pi finds it: the nearest above with a `.git`. */
function repositoryRoot(dir: string): string | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, ".git"))) return at;
    if (path.dirname(at) === at) return null;
  }
}

/**
 * The folder's skills, which pi leaves out of an untrusted project, found as pi
 * finds them: `.pi/skills` in it, and `.agents/skills` in it and in each folder
 * above, up to its repository's root. Only those there: pi reports a skill path
 * that is not there as an error.
 */
export function projectSkillPaths(cwd: string): string[] {
  const start = path.resolve(cwd);
  const root = repositoryRoot(start);
  const own = path.join(homedir(), ".agents", "skills");
  const found = [path.join(start, ".pi", "skills")];
  for (let at = start; ; at = path.dirname(at)) {
    found.push(path.join(at, ".agents", "skills"));
    if (at === root || path.dirname(at) === at) break;
  }
  return found.filter((dir) => dir !== own && existsSync(dir));
}

/** Where the MCP adapter is told it works: a folder of the portal's with nothing in it. */
const MCP_FOLDER = path.join(path.resolve(DATA_SETTING), "sandbox", "mcp");

const isMcpAdapter = (extension: { resolvedPath?: string }) => /[\\/]pi-mcp-adapter[\\/]/.test(extension.resolvedPath ?? "");

/**
 * pi's extensions as loaded, with the MCP adapter's handlers given a context
 * whose folder is MCP_FOLDER instead of the chat's. The adapter reads a
 * project's config, and starts its servers, from the folder its context names,
 * so it finds the user's own config and no project's. The servers it starts
 * work in that folder too.
 */
export function withoutFolderMcp<T extends { extensions: any[] }>(result: T): T {
  mkdirSync(MCP_FOLDER, { recursive: true, mode: 0o755 });
  for (const extension of result.extensions.filter(isMcpAdapter)) {
    for (const [event, handlers] of extension.handlers as Map<string, ((event: unknown, ctx: any) => unknown)[]>) {
      extension.handlers.set(event, handlers.map((handler) => (event: unknown, ctx: any) => handler(event, elsewhere(ctx))));
    }
    // `/mcp`, which reloads the config and writes a server's switch into the folder it is given.
    for (const command of (extension.commands as Map<string, { handler?: (args: unknown, ctx: any) => unknown }>).values()) {
      const handler = command.handler;
      if (handler) command.handler = (args, ctx) => handler(args, elsewhere(ctx));
    }
  }
  return result;
}

/** The context, with its folder MCP_FOLDER. */
function elsewhere(ctx: any): any {
  if (!ctx || typeof ctx !== "object") return ctx;
  return new Proxy(ctx, {
    get: (target, key) => {
      if (key === "cwd") return MCP_FOLDER;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
