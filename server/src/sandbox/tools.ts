import { readPiSettings } from "../pi-settings.js";
import { agentOf, defaultAgent } from "../agents.js";
import { bashSpawnHook, fileOperations, runToolAsAgent } from "./exec.js";
import { prepareFolder } from "./apply.js";
import { identityOf } from "./identity.js";
import { sandboxOn, sandboxPolicy, sandboxSupport } from "./policy.js";

/**
 * pi's own tools again, under the same names, with what they do to the system
 * done as the chat's agent's own user: bash through its spawn hook, read,
 * write, edit and ls through their pluggable operations, grep and find run
 * whole by a process of that user's. A tool of an extension with a built-in's
 * name takes the built-in's place, so the agent sees the same tools it always
 * had. A chat in an agent's home is that agent's; a chat in a project, the
 * first agent's.
 *
 * The options pi gives its built-ins come from its settings, so a shell, a
 * command prefix or the image resizing set there still apply.
 *
 * The chat's folder is made writable for the sandbox first, where a rule says
 * so: see prepareFolder.
 *
 * Whether to is decided each time the extension is loaded, not when the chat
 * started: switching the sandbox on or off reloads the open chats, and each
 * then gets the tools that fit (the built-ins come back where nothing takes
 * their place).
 */
export async function sandboxTools(pi: any, cwd: string): Promise<(ext: any) => void> {
  if (sandboxOn()) await prepareFolder(sandboxPolicy(), sandboxSupport(), cwd);
  return (ext: any) => {
    if (!sandboxOn()) return;
    const agent = agentOf(cwd) ?? defaultAgent();
    const who = identityOf(agent, sandboxSupport());
    const ops = fileOperations(who);
    const settings = readPiSettings() as { shellCommandPrefix?: string; shellPath?: string; images?: { autoResize?: boolean } };
    ext.registerTool(pi.createBashToolDefinition(cwd, {
      spawnHook: bashSpawnHook(who),
      ...(settings.shellCommandPrefix ? { commandPrefix: settings.shellCommandPrefix } : {}),
      ...(settings.shellPath ? { shellPath: settings.shellPath } : {}),
    }));
    ext.registerTool(pi.createReadToolDefinition(cwd, { operations: ops.read, autoResizeImages: settings.images?.autoResize ?? true }));
    ext.registerTool(pi.createWriteToolDefinition(cwd, { operations: ops.write }));
    ext.registerTool(pi.createEditToolDefinition(cwd, { operations: ops.edit }));
    ext.registerTool(pi.createLsToolDefinition(cwd, { operations: ops.ls }));
    // pi's own definitions, for how they are described and shown; what they do, done by the agent's own process.
    for (const [name, make] of [["grep", pi.createGrepToolDefinition], ["find", pi.createFindToolDefinition]] as const) {
      const definition = make(cwd);
      ext.registerTool({ ...definition, execute: (_id: string, params: unknown, signal?: AbortSignal) => runToolAsAgent(who, name, cwd, params, signal) });
    }
  };
}
