import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DATA_DIR as DATA_SETTING } from "../data-dir.js";

/**
 * While the sandbox is on, the folder a chat works in is the agent's to write,
 * and pi runs inside the portal, as root. So what it would take from that
 * folder and run is not taken from it: pi's project extensions, packages and
 * settings (pi's own "untrusted project", which also leaves out the MCP servers
 * of the folder's `.pi/mcp.json`), and the folder as the working folder of the MCP
 * servers it starts. The folder's skills are text the model reads, and are kept.
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

/** Where pi's MCP support is told it works: a folder of the portal's with nothing in it. */
const MCP_FOLDER = path.join(path.resolve(DATA_SETTING), "sandbox", "mcp");

/** The portal's registration of pi's MCP support (see sdk-client.ts): an inline extension of that name. */
const isMcpExtension = (extension: { resolvedPath?: string }) => extension.resolvedPath === "<inline:mcp>";

/**
 * pi's extensions as loaded, with the handlers of pi's MCP support given a context
 * whose folder is MCP_FOLDER instead of the chat's. The servers it starts work in
 * the folder its context names, which is then one nobody can write to as the
 * agent: a `package.json` or a `node_modules/.bin` the agent put in its own folder
 * is not what `npx` runs.
 */
export function withoutFolderMcp<T extends { extensions: any[] }>(result: T): T {
  mkdirSync(MCP_FOLDER, { recursive: true, mode: 0o755 });
  for (const extension of result.extensions.filter(isMcpExtension)) {
    for (const [event, handlers] of extension.handlers as Map<string, ((event: unknown, ctx: any) => unknown)[]>) {
      extension.handlers.set(event, handlers.map((handler) => (event: unknown, ctx: any) => handler(event, elsewhere(ctx))));
    }
    // `/mcp`, which reloads the config and saves a server's switch to the file that defines it.
    for (const command of (extension.commands as Map<string, { handler?: (args: unknown, ctx: any) => unknown }>).values()) {
      const handler = command.handler;
      if (handler) command.handler = (args, ctx) => handler(args, elsewhere(ctx));
    }
  }
  return result;
}

/**
 * Where pi-mcp-adapter would be: a package of that name, by its source, its folder or the file of its extension. The portal
 * does not install it any more, but a project's own `.pi/settings.json` (the sandbox off) or a hand-edited settings.json can
 * still name it, and next to pi's own MCP support it would read the same mcp.json by its own rules: `enabled: false` means
 * nothing to it, and its `mcp` tool reaches servers and tools a chat has switched off, with results the guard does not know as an MCP server's.
 */
const isAdapter = (extension: { resolvedPath?: string; path?: string; sourceInfo?: { source?: string; baseDir?: string } }): boolean =>
  [extension.sourceInfo?.source, extension.sourceInfo?.baseDir, extension.resolvedPath, extension.path].some((where) => typeof where === "string" && /(^|[:/\\])pi-mcp-adapter(@[^/\\]*)?([/\\]|$)/.test(where));

/** pi's extensions as loaded, without pi-mcp-adapter (see isAdapter): its handlers and tools never reach a chat. */
export function withoutAdapter<T extends { extensions: any[] }>(result: T): T {
  return { ...result, extensions: result.extensions.filter((extension) => !isAdapter(extension)) };
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
