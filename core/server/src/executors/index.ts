import { executorLimits } from "./limits.js";
import { mkdirSync, accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import { hostMountPath, type DockerMount } from "./host-mounts.js";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { removeStoppedRunner } from "./stale-container.js";
import { PiRpcClient } from "../pi/rpc-client.js";
import { SdkPiClient } from "../pi/sdk-client.js";
import type { PiClient } from "../pi/types.js";

export type ExecutorKind = "host" | "container";

export interface LaunchOptions {
  sessionId: string;
  /** Absolute path of the workspace pi should work in (as seen by this process). */
  workspacePath: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /** A previous run's pi session file, reopened so the conversation continues. */
  sessionFile?: string;
  /** Give this session the routine tools: conversations with the agent, not a routine run or a task in a repository. */
  routineTools?: boolean;
  /** Give this session the ask_question tool. Chats a person talks to in the portal's pages only. */
  questions?: boolean;
  /** Whether a dialog an extension opens is shown to a person. Off for a routine, a heartbeat and a channel's chat, where it is answered at once with its no-answer value. */
  dialogs?: boolean;
  /** The routine being run, when this is a routine session. Enables reporting. */
  routineSlug?: string | null;
  /** Lowest role the conversation serves; decides which context files load. */
  role?: string;
  /** Whoever is speaking, read at each tool call. */
  whoNow?: () => { role: string; key?: string };
  /** The guard's taint rules this session is exempt from, by name, read at each tool call. */
  exemptNow?: () => ReadonlySet<string>;
  /** The sites the agent's tools may reach, read at each tool call, so a change takes effect without a restart. */
  allowlistNow?: () => string[];
  /** Tools this conversation has switched off, by name. */
  toolsOff?: string[];
  /** The tools the portal has seen, for one that says it is off until switched on. */
  toolsSeen?: () => ReadonlySet<string>;
  /** The tools that are on and lazy: found through the `tools` tool, not offered one by one. */
  toolsLazy?: string[];
  /** What those tools are called as sets, for the hint to the model. */
  lazySets?: string[];
  /** The code tool's presentation in a chat whose mode works through it: see codemode.ts. */
  codemode?: "only";
  /** Said after the portal's rules each time the prompt is built: the chat's mode's instructions. */
  modeLines?: () => string[];
  /** The agent whose heartbeat this session is, when it is one: gives it the note tool. */
  heartbeatAgent?: string;
  /** Told the chat's model when a spoken turn is about to run on another. */
  rememberChatModel?: (provider: string, modelId: string) => void;
  /** Whether a reload that is due may happen now, between two requests of a run: nothing goes on beside the run that it would cut off. */
  canReloadNow?: () => boolean;
}

export interface Executor {
  readonly kind: ExecutorKind;
  launch(opts: LaunchOptions): Promise<PiClient>;
  /** Best-effort cleanup of anything left behind outside the child process. */
  cleanup?(sessionId: string): Promise<void>;
  /**
   * Whether a pi launched again carries on the conversation it had. The host's
   * does, from the conversation's file. A container's does not yet (it starts
   * with `--session-dir` alone, and so with a new, empty conversation), so
   * nothing is to make one start again that the person is still talking to.
   */
  readonly resumes?: boolean;
}

/** The environment variable each cloud provider's key is in, as pi reads it. */
const PROVIDER_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

function piArgs(opts: LaunchOptions, sessionDir: string): string[] {
  const args = ["--mode", "rpc", "--session-dir", sessionDir];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  return args;
}

/**
 * Runs pi in the portal's own process (through the SDK), working directly on
 * mounted workspace directories. Fast and simple; pi has the portal's own
 * permissions, so this assumes you trust the tasks you submit.
 */
export class HostExecutor implements Executor {
  readonly kind = "host" as const;

  constructor(private readonly sessionRoot: string) {}

  /** In-process via the SDK — see SdkPiClient for why this beats a subprocess. */
  launch(opts: LaunchOptions): Promise<PiClient> {
    return SdkPiClient.create({
      cwd: opts.workspacePath,
      sessionDir: path.join(this.sessionRoot, opts.sessionId),
      sessionFile: opts.sessionFile,
      routineTools: opts.routineTools,
      questions: opts.questions,
      dialogs: opts.dialogs,
      routineSlug: opts.routineSlug,
      role: opts.role,
      sessionId: opts.sessionId,
      whoNow: opts.whoNow,
      exemptNow: opts.exemptNow,
      allowlistNow: opts.allowlistNow,
      toolsOff: opts.toolsOff,
      toolsSeen: opts.toolsSeen,
      toolsLazy: opts.toolsLazy,
      lazySets: opts.lazySets,
      codemode: opts.codemode,
      modeLines: opts.modeLines,
      heartbeatAgent: opts.heartbeatAgent,
      rememberChatModel: opts.rememberChatModel,
      canReloadNow: opts.canReloadNow,
      provider: opts.provider,
      modelId: opts.model,
      thinkingLevel: opts.thinkingLevel,
    });
  }
}

/**
 * Runs pi inside a throwaway Docker container with only the workspace directory
 * mounted, so a task cannot reach the rest of the host.
 *
 * `docker run -i` keeps stdin open, which is what the JSONL protocol needs, and
 * the container is labelled so a crashed portal can still find and reap it.
 */
export class ContainerExecutor implements Executor {
  readonly kind = "container" as const;
  readonly resumes = false;

  constructor(
    private readonly image: string,
    private readonly sessionRoot: string,
    private readonly limits: { memoryMb: number; cpus: number; pidsLimit: number }
  ) {}

  async launch(opts: LaunchOptions): Promise<PiClient> {
    const containerName = `pithagoras-${opts.sessionId}`;
    const sessionDir = path.join(this.sessionRoot, opts.sessionId);
    // Create it as the portal user, rather than letting Docker create a root-owned bind source.
    // Before the mount translation below, so the directory exists as ours either way.
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    accessSync(sessionDir, constants.W_OK);
    if (!process.getuid || !process.getgid) throw new Error("Container executor requires a POSIX user identity");
    const runnerUser = `${process.getuid()}:${process.getgid()}`;

    let workspaceMount = opts.workspacePath;
    let sessionMount = sessionDir;
    if (process.env.PORTAL_CONTAINER_NAME) {
      const { stdout } = await promisify(execFile)("docker", ["inspect", "--format", "{{json .Mounts}}", process.env.PORTAL_CONTAINER_NAME]);
      const mounts = JSON.parse(stdout) as DockerMount[];
      workspaceMount = hostMountPath(opts.workspacePath, mounts);
      sessionMount = hostMountPath(sessionDir, mounts);
    }



    // By name only: docker copies the value from its own environment, which is
    // this one, and a value on the command line is readable by anybody on the
    // host who lists processes while the task runs. Of the provider keys, only
    // the one for the provider the chat runs on: the others are not its to have,
    // and a key in its environment is a provider pi may reach for (#15).
    const keys = opts.provider
      ? (PROVIDER_KEYS[opts.provider] ? [PROVIDER_KEYS[opts.provider]] : [])
      : Object.values(PROVIDER_KEYS);
    const passthrough = [...keys, "PI_PROVIDER", "PI_MODEL"].flatMap((key) => (process.env[key] ? ["-e", key] : []));

    const args = [
      "run",
      "-i",
      "--rm",
      // pi is not PID 1: a command's background child that outlives its shell is handed to PID 1, and
      // pi (node) never waits for it, so it stays a zombie and keeps one of the --pids-limit slots.
      "--init",
      "--user",
      runnerUser,
      "--name",
      containerName,
      "--label",
      "pithagoras.session=" + opts.sessionId,
      "--label",
      "pithagoras.managed=true",
      "-w",
      "/workspace",
      "-v",
      `${workspaceMount}:/workspace`,
      "-v",
      `${sessionMount}:/sessions`,
      // Same hardening posture as the sandboxes: no extra capabilities, no
      // privilege escalation, and hard resource ceilings.
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      `${this.limits.memoryMb}m`,
      "--memory-swap",
      `${this.limits.memoryMb}m`,
      "--cpus",
      String(this.limits.cpus),
      "--pids-limit",
      String(this.limits.pidsLimit),
      ...passthrough,
      this.image,
      "pi",
      ...piArgs({ ...opts }, "/sessions"),
    ];

    await removeStoppedRunner(opts.sessionId);
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    return new PiRpcClient(child, opts.dialogs);
  }

  async cleanup(sessionId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const rm = spawn("docker", ["rm", "-f", `pithagoras-${sessionId}`], { stdio: "ignore" });
      rm.on("exit", () => resolve());
      rm.on("error", () => resolve());
    });
  }
}

export function buildExecutor(kind: ExecutorKind, sessionRoot: string): Executor {
  if (kind === "container") {
    return new ContainerExecutor(
      process.env.PI_IMAGE || "pithagoras-runner:latest",
      sessionRoot,
      executorLimits()
    );
  }
  return new HostExecutor(sessionRoot);
}
