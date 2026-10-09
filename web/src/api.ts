import { t } from "./i18n";
import { samplesWav } from "./voice";
import type { Host, VoiceChoice } from "../../server/src/voice-engines";
import type { OrbStyle } from "../../server/src/orb-style";
import type { OutputFormat } from "../../server/src/image-settings";
export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface Session {
  id: string;
  /** Results flagged as a suspected prompt injection that the person trusted (see FlaggedNotice). */
  trustedResults?: string[];
  title: string;
  workspace: string;
  executor: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  pinned: boolean;
  live?: boolean;
  /** Per-session overrides, used to paint the composer pills before any fetch. */
  provider: string | null;
  model: string | null;
  thinking_level: string | null;
  /** How the session came to exist. */
  kind?: "task" | "agent" | "routine" | "heartbeat";
}

/** A set of instructions the agent pulls in when the description matches. */
export interface Skill {
  name: string;
  description: string;
  path: string;
  scope: string;
  /** Only skills under the agent directory can be changed here. */
  editable: boolean;
  /** Invocable as /skill:name, never chosen by the model itself. */
  manualOnly: boolean;
  /** On disk but unparseable — pi is not loading it. */
  broken: boolean;
  /** Off means pi is not loading it at all — not merely hidden here. */
  enabled: boolean;
  /** Set when it was imported rather than written here. */
  source: SkillSource | null;
  content: string;
}

/** Where an imported skill came from, so it can be updated later. */
export interface SkillSource {
  spec: string;
  url: string;
  ref?: string;
  subpath?: string;
  importedAt: string;
}

/** A skill sitting in a repository, before you decide to take it. */
export interface FoundSkill {
  name: string;
  description: string;
  installed: boolean;
  from: string;
}

/** A skill of a repository that was not taken, and why. */
export interface SkippedSkill {
  name: string;
  reason: string;
}

export interface SkillDiagnostic {
  type: string;
  message: string;
  path?: string;
}

/** Work the agent does on a schedule. */
export interface Routine {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  /** Five-field cron, or an @shorthand. Empty for a one-off. */
  schedule: string;
  /** ISO instant for a one-off, instead of a schedule. */
  runAt: string | null;
  mode: "once" | "repeats";
  /** A one-off that has already happened. */
  done: boolean;
  instructions: string;
  freshSession: boolean;
  /** False lets this routine act on what it read — see the guard. */
  guard: boolean;
  /** True lets this routine's runs drive the agent's browser. */
  browser: boolean;
  /** Where its runs happen: null for Home, else a project's directory. */
  workspace: string | null;
  /** Why that place cannot be used now, such as a project that was deleted; null when it can. */
  workspaceProblem?: string | null;
  /** null inherits the portal default; "" means this one never reports. */
  reportChannel: string | null;
  reportTarget: string | null;
  /** When a run last reached a person through the report tool. */
  lastReportAt: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  lastOutput: string | null;
  lastMs: number | null;
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The agent's home directory and the files that define it. */
export interface AgentSetup {
  home: string;
  initialised: boolean;
  /** `mtime`: when the file last changed, 0 where there is none. A save sends it back, so the agent's own writes are not lost. `link`: it is a link, which is left alone: not shown, not written. */
  files: { name: string; exists: boolean; content: string; mtime: number; link?: boolean }[];
  /** Where the agent's memory is kept: while it is Understory, MEMORY.md is not read. */
  memory?: "file" | "understory";
}

/** An agent: a home of its own, with its own SOUL.md, PrimaryUser.md and memory. */
export interface Agent {
  id: string;
  name: string;
  home: string;
  /** The user it runs as when the sandbox is on. */
  sandboxUser: string;
  /** The Home there always was: the one chats go to when none is named, which cannot be deleted. */
  first: boolean;
  initialised: boolean;
  chats: number;
  /** The channels that talk as it. */
  channels: { slug: string; name: string }[];
  /** Its avatar. */
  orb: OrbStyle;
  /** The voice it speaks with: "design", a voice library id, or "" for the one in the voice settings. */
  voice: string;
  /** How it looks around on its own. */
  heartbeat: {
    /** 0 is never. */
    minutes: number;
    /** "HH:MM", both or neither. */
    quietStart: string;
    quietEnd: string;
    /** The time zone of the server's clock, which the quiet hours are read on. */
    timeZone: string;
    last: string | null;
    status: string | null;
    running: boolean;
    /** Whether its WATCH.md says anything. */
    watching: boolean;
    /** False under the container executor, where nothing would hold a look to reading. */
    available: boolean;
  };
  /** Its notes nobody has read yet. */
  unread: number;
}

/** Something an agent noticed on its own. */
export interface ActivityNote {
  id: string;
  /** The look it was noted in. */
  session_id: string | null;
  title: string;
  detail: string;
  at: string;
  read_at: string | null;
}

export type AgentWizard = {
  agentName: string;
  vibe?: string;
  userName: string;
  userAbout?: string;
  userPrefers?: string;
};

/** A conversation that reached the agent through a channel. */
export interface AgentSession extends Session {
  /** The package-supplied conversation key, prefixed with the channel id. */
  channel_key: string;
  channel: { slug: string; name: string; kind: string | null; present: boolean } | null;
}

export interface Workspace {
  name: string;
  path: string;
  isGit: boolean;
}

/** A folder made on purpose for chats to work in. Home, where "New" starts one, is not a project. */
export interface Project {
  name: string;
  path: string;
  isGit: boolean;
  /** Whether the folder has an AGENTS.md — the project's instructions. */
  hasInstructions: boolean;
  /** Whether the project switches tools differently from the portal-wide default. */
  hasTools?: boolean;
  /** How many chats work in it, and when one last moved. */
  sessions: number;
  lastActive: string | null;
}

/** What a delete would lose that only the folder holds: nothing else has a copy of these. */
export interface Unsaved {
  /** Changes that are not committed. */
  changed: number;
  /** Commits that no remote has. */
  unpushed: number;
  stashes: number;
  /** Not everything could be read, so there may be more than this says. */
  unknown?: true;
}

/** What deleting a project would take with it. */
export interface ProjectContents extends Project {
  files: number;
  bytes: number;
  /** False when the count stopped early on a very large folder. */
  complete: boolean;
  /** The routines that run here and are on, by name. Deleting the project switches them off. */
  routines?: string[];
  /** Set when the folder is a git repository: what only the folder holds, and so what deleting it loses. */
  unsaved?: Unsaved;
}

export interface CompactionSettings {
  enabled: boolean;
  /** The floor a compaction cannot go below — kept verbatim, never summarised. */
  keepRecentTokens: number;
}

/** One thing in a chat's folder. "link" leads out of it, or nowhere, and is left alone. */
export interface FileEntry {
  name: string;
  type: "dir" | "file" | "link";
  /** A link, whatever `type` says: one to a folder in this one is a "dir", but deleting it removes only the link. */
  link?: boolean;
  size: number;
  mtime: number;
}

/** A file as the Files panel shows it: its text, or the fact that it has none to show. */
export type FileContent =
  | { binary: true; size: number; mtime: number }
  | { binary: false; size: number; mtime: number; content: string };

/** A tool a conversation could use, and whether it is switched on for it. */
export interface PortalTool {
  name: string;
  description?: string;
  /** The package or MCP server that registered it, for grouping. */
  source: string;
  enabled: boolean;
  /** Whether it is on by default, so a chat can show where it disagrees. */
  defaultOn?: boolean;
  /** One of the portal's own, not an extension's of the same name: the list groups its picture tools. */
  inline?: true;
  /** An MCP server's tool listed from the adapter's cache: the server starts when one of its tools is first used. */
  cached?: true;
}

/** A picture going with a message: a data: URL, which the box also shows it from. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface PromptOptions {
  voice?: boolean;
  images?: PromptImage[];
  /** Sent mid-run, go into that run instead of waiting for it to end. */
  steer?: boolean;
}

/** A job the agent left running — see server/src/background.ts. */
export interface BackgroundJob {
  key: string;
  sid: number;
  pids: number[];
  command: string;
  startedAt: number;
  state: "running" | "stopped" | "exited";
  exitedAt?: number;
  hasOutput: boolean;
  /** A tool call the chat is already showing. */
  attached: boolean;
}

export interface BackgroundState {
  supported: boolean;
  jobs: BackgroundJob[];
  statuses: { key: string; text: string }[];
  widgets: { key: string; lines: string[] }[];
  /** Whether the chat's pi is up, for the chat box's text to be worth telling it. */
  piRunning?: boolean;
}

export interface PortalEvent {
  seq: number;
  type: string;
  /** When the server recorded it, epoch ms. Absent on anything older than the field. */
  at?: number;
  payload: any;
}

/**
 * Fired when the server stops accepting this browser's login — it expired, or
 * the portal restarted without PORTAL_SECRET — so the page can ask for the
 * password again instead of failing every request with "Unauthorized".
 */
export const SIGNED_OUT = "pithagoras:signed-out";

/**
 * A request, as every one the page makes is: the portal being away is said in words
 * (what the browser says of it is "Failed to fetch", "Load failed" or
 * "NetworkError…", in English, whatever language is shown), and a login that is
 * gone is told to the page.
 */
async function send(url: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Aborting is the caller's own doing, and says so itself.
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(t("Cannot reach the portal"), 0, {});
  }
  if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event(SIGNED_OUT));
  return res;
}

export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await send(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body);
  }
  return res.json();
}

/** A request the server refused, with what it said besides the message: some refusals carry what to ask next. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** A file's bytes as they are, always a plain stream: what the file calls itself is not how it is sent. */
async function uploadBytes(url: string, file: File, name: string): Promise<any> {
  const res = await send(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || t("Could not upload {name} ({status})", { name, status: res.status }), res.status, body);
  return body;
}

export const DEFAULT_VAD = { positiveSpeechThreshold: 0.65, negativeSpeechThreshold: 0.35, minSpeechMs: 256, preSpeechPadMs: 320, redemptionMs: 1000 };
export interface VoiceConfig {
  sentenceChunks?: boolean;
  ttsPrefetch?: boolean;
  comparison?: boolean;
  statusSpeech?: boolean;
  // The speaking instructions in use, the built-in ones to go back to, and whether the portal sends none at all.
  responseInstructions?: string;
  defaultResponseInstructions?: string;
  responseInstructionsOff?: boolean;
  // The providers whose first call of a spoken turn goes without thinking, and the built-in list to go back to.
  skipThinkingProviders?: string[];
  defaultSkipThinkingProviders?: string[];
  pipelineMode?: "parallel" | "sequential";
  // False with no speech synthesis (runtime "none"): the page can listen, but replies are not spoken.
  speech?: boolean;
  vad?: typeof DEFAULT_VAD;
  enabled: boolean; lazyLoad?: boolean; managed?: boolean; whisperUrl: string; breezeUrl: string; instruction: string; voice?: string; language?: string; cfgScale?: number; runtime?: "breeze" | "audio-cpp" | "chatterbox" | "kokoro" | "none"; sttModel?: string; exaggeration?: number; kokoroVoice?: string; speed?: number;
}

export interface VoiceInstallStatus { available: boolean; state: string; busy: boolean; progress: string; error: string; choice?: VoiceChoice; /** The saved settings point at the managed service, whether or not its container is there. */ connected?: boolean; }
/** The GPUs the voice container can use, as nvidia-smi reports them, and the combination that fits the one it would take. */
export interface VoiceHardware { gpus: { index: number; uuid?: string; name: string; totalMiB: number | null; freeMiB: number | null }[]; source: string; error: string; /** False while nothing could be asked yet, so that no GPU is not yet the same as none. */ checked: boolean; /** The check found there is no GPU: what is suggested is speech recognition alone, on the CPU. */ cpuOnly: boolean; /** Cards the host lists that Docker cannot hand to a container: for voice there are none. */ unusable?: string[]; /** What recognition on the CPU has to run on. */ host: Host; selected: number | null; /** The UUID of the GPU chosen on the page, empty where none is, or the one chosen is no longer there. */ chosen: string; reserveMiB: number; suggestion: VoiceChoice; }
export const api = {
  listFiles: (sessionId: string, dir: string) =>
    json<{ path: string; entries: FileEntry[]; truncated: boolean }>(
      `/api/sessions/${sessionId}/files?path=${encodeURIComponent(dir)}`
    ),
  readFile: (sessionId: string, file: string) =>
    json<FileContent>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(file)}`),
  /** `mtime` is the time the text on screen was read at; the save is refused if the file has changed since. */
  saveFile: (sessionId: string, file: string, content: string, mtime?: number) =>
    json<{ ok: true; size: number; mtime: number }>(
      `/api/sessions/${sessionId}/file?path=${encodeURIComponent(file)}`,
      { method: "PUT", body: JSON.stringify({ content, mtime }) }
    ),
  /** Gives a file or folder another name in the same folder; answers with its new path. */
  renameFile: (sessionId: string, file: string, name: string) =>
    json<{ ok: true; path: string }>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(file)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  /** A new, empty file; refused if something already has the name. */
  createFile: (sessionId: string, file: string) =>
    json<{ ok: true; size: number; mtime: number }>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(file)}`, {
      method: "PUT",
      body: JSON.stringify({ content: "", create: true }),
    }),
  createFolder: (sessionId: string, dir: string, name: string) =>
    json<{ ok: true; path: string }>(`/api/sessions/${sessionId}/folder?path=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  /**
   * A file from this computer into the chat's folder. A taken name gets a
   * number rather than replacing anything; the answer says what it is called.
   */
  uploadFile: (sessionId: string, dir: string, file: File, name = file.name): Promise<{ path: string; size: number }> =>
    uploadBytes(`/api/sessions/${sessionId}/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, file, name),
  /** What deleting `file` would lose that nothing else has (see Unsaved), null for nothing. */
  fileUnsaved: (sessionId: string, file: string) =>
    json<{ unsaved: Unsaved | null }>(`/api/sessions/${sessionId}/unsaved?path=${encodeURIComponent(file)}`),
  /** `discard` says that git work in a folder, which nothing else has, may go with it; without it the server refuses, with code "unsaved-work". */
  deleteFile: (sessionId: string, file: string, discard = false) =>
    json<{ ok: true }>(`/api/sessions/${sessionId}/file?path=${encodeURIComponent(file)}${discard ? "&discard=1" : ""}`, { method: "DELETE" }),
  fileDownloadUrl: (sessionId: string, file: string) =>
    `/api/sessions/${sessionId}/file?path=${encodeURIComponent(file)}&download=1`,
  /** The whole folder, or a folder in it. */
  archiveDownloadUrl: (sessionId: string, dir = "") =>
    `/api/sessions/${sessionId}/archive${dir ? `?path=${encodeURIComponent(dir)}` : ""}`,
  voiceInstallStatus: () => json<VoiceInstallStatus>('/api/voice/install'),
  // `choice` is for install: the engines to build for. Without it an install keeps what is installed, or picks for the GPU.
  voiceAction: (action: 'install' | 'start' | 'stop', choice?: VoiceChoice) => json<{ok:boolean}>(`/api/voice/${action}`, {method:'POST', ...(choice ? {body: JSON.stringify(choice)} : {})}),
  voiceHardware: () => json<VoiceHardware>('/api/voice/hardware'),
  /** Removes the voice container and puts the settings back; `removeData` deletes the downloaded engines and models too. */
  uninstallVoice: (removeData: boolean) => json<{ok:boolean}>('/api/voice/uninstall', {method:'POST', body: JSON.stringify({removeData})}),
  connectVoice: () => json<VoiceConfig>('/api/voice/connect', {method:'POST'}),
  /** What was said in `samples` (16 kHz mono), in words, and how long the speech server says it took. */
  transcribe: async (sessionId: string, samples: Float32Array, signal?: AbortSignal): Promise<{ text: string; serverTiming: string }> => {
    const res = await send(`/api/sessions/${sessionId}/voice/transcribe`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: samplesWav(samples), signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error || t("Transcription failed"), res.status, body);
    return { text: String(body.text ?? ""), serverTiming: res.headers.get("server-timing") ?? "" };
  },
  setVoiceGpu: (gpu: string) => json<{ selected: string; restarting: boolean }>('/api/voice/gpu', { method: 'PUT', body: JSON.stringify({ gpu }) }),
  voice: () => json<VoiceConfig>("/api/voice"),
  setVoice: (value: VoiceConfig) => json<VoiceConfig>("/api/voice", { method: "PUT", body: JSON.stringify(value) }),
  authStatus: () => json<{ authRequired: boolean; authed: boolean; shortPassword?: boolean }>("/api/auth/status"),
  login: (password: string) =>
    json<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => json<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  workspaces: () => json<{ root: string; workspaces: Workspace[] }>("/api/workspaces"),
  sessions: () => json<{ sessions: Session[]; executor: string }>("/api/sessions"),
  /** Without a workspace the chat starts in Home. */
  createSession: (workspace?: string, title?: string) =>
    json<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace, title }),
    }),
  projects: () => json<{ root: string; home: string; projects: Project[] }>("/api/projects"),
  /** Only where Home is and which projects there are, without their counts: see /api/projects. */
  places: () => json<{ root: string; home: string; agents?: { id: string; name: string; home: string }[]; projects: { name: string; path: string }[] }>("/api/projects?bare=1"),
  /** `toolsOff`: the tools its chats start with off, as for setProjectTools. `toolsError` says the project was made without them. */
  createProject: (name: string, instructions?: string, toolsOff?: string[]) =>
    json<Project & { toolsError?: string }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, instructions, toolsOff }),
    }),
  projectContents: (name: string) => json<ProjectContents>(`/api/projects/${encodeURIComponent(name)}`),
  projectInstructions: (name: string) =>
    json<{ text: string; mtime: number }>(`/api/projects/${encodeURIComponent(name)}/instructions`),
  /** `mtime` is the file's as it was read; a file the agent has written since is refused (409). Without it the save replaces what is there. */
  setProjectInstructions: (name: string, text: string, mtime?: number) =>
    json<{ ok: true }>(`/api/projects/${encodeURIComponent(name)}/instructions`, {
      method: "PUT",
      body: JSON.stringify({ text, mtime }),
    }),
  /** What chats in the project start with: the same list as a chat's, `live` always false. */
  projectTools: (name: string) =>
    json<{ tools: PortalTool[]; live: boolean; off: string[]; names: Record<string, string> }>(
      `/api/projects/${encodeURIComponent(name)}/tools`
    ),
  /** Switch tools off for the project's chats by name; everything not named is on. */
  setProjectTools: (name: string, off: string[]) =>
    json<{ off: string[]; applied: number }>(`/api/projects/${encodeURIComponent(name)}/tools`, {
      method: "PUT",
      body: JSON.stringify({ off }),
    }),
  /** What an agent's chats and own runs start with: its exceptions to the portal-wide default, `live` always false. */
  agentTools: (id: string) =>
    json<{ tools: PortalTool[]; live: boolean; off: string[]; names: Record<string, string> }>(
      `/api/agents/${encodeURIComponent(id)}/tools`
    ),
  setAgentTools: (id: string, off: string[]) =>
    json<{ off: string[]; applied: number }>(`/api/agents/${encodeURIComponent(id)}/tools`, {
      method: "PUT",
      body: JSON.stringify({ off }),
    }),
  /** What every run of a routine starts with: its exceptions to what its agent and project leave. */
  routineTools: (id: string) =>
    json<{ tools: PortalTool[]; live: boolean; off: string[]; names: Record<string, string> }>(
      `/api/routines/${encodeURIComponent(id)}/tools`
    ),
  setRoutineTools: (id: string, off: string[]) =>
    json<{ off: string[]; applied: number }>(`/api/routines/${encodeURIComponent(id)}/tools`, {
      method: "PUT",
      body: JSON.stringify({ off }),
    }),
  /** `discard` says that unsaved work in the folder (see ProjectContents) may go with it; without it the server refuses. */
  deleteProject: (name: string, discard = false) =>
    json<{ ok: true; sessionsDeleted: number; jobsStopped: number }>(`/api/projects/${encodeURIComponent(name)}${discard ? "?discard=1" : ""}`, {
      method: "DELETE",
    }),
  renameSession: (id: string, title: string) =>
    json<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => json<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  prompt: (id: string, message: string, options?: PromptOptions) =>
    json<{ ok: true }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(options?.voice ? { voice: true } : {}),
        ...(options?.images?.length ? { images: options.images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}),
        ...(options?.steer ? { steer: true } : {}),
      }),
    }),
  /** A picture sent with a message, as the transcript shows it. */
  imageUrl: (id: string, name: string) => `/api/sessions/${id}/images/${encodeURIComponent(name)}`,
  /**
   * A picture in the chat's folder, by its path there. `version` is anything
   * that changes when the file does — the agent rewrites pictures in place.
   */
  pictureUrl: (id: string, path: string, version?: string | number) =>
    `/api/sessions/${id}/picture?path=${encodeURIComponent(path)}${version === undefined ? "" : `&v=${encodeURIComponent(String(version))}`}`,
  /** Removes a message and the agent's answer to it — from the agent's memory too. */
  /** Trusts a result flagged as a suspected prompt injection: it no longer holds the chat back. */
  trustFlagged: (id: string, result: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/flagged/${result}/trust`, { method: "POST" }),
  deleteMessage: (id: string, seq: number) =>
    json<{ ok: true }>(`/api/sessions/${id}/messages/${seq}`, { method: "DELETE" }),
  /** Replaces a message: it and everything after it are dropped, and the new text is sent. */
  editMessage: (id: string, seq: number, message: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/messages/${seq}/edit`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  /** Shows another version of a message, and what followed it then. */
  switchVersion: (id: string, seq: number, to: number) =>
    json<{ ok: true }>(`/api/sessions/${id}/messages/${seq}/version`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
  /** Every tool the portal has seen, for setting a default without opening a chat. */
  toolDefaults: () =>
    json<{
      tools: { name: string; source: string; defaultOn: boolean; inline?: true }[];
      off: string[];
      names: Record<string, string>;
    }>("/api/tools"),
  /** Which tools are off unless a conversation says otherwise. */
  setToolDefaults: (off: string[]) =>
    json<{ off: string[]; applied: number }>("/api/tools", { method: "PUT", body: JSON.stringify({ off }) }),
  /** What this conversation could use. `live` is false when pi is not running to ask. */
  tools: (sessionId: string) =>
    json<{ tools: PortalTool[]; live: boolean; off: string[]; names: Record<string, string> }>(
      `/api/sessions/${sessionId}/tools`
    ),
  /** What each package is called here; everything unnamed keeps its own name. */
  toolNames: () => json<{ names: Record<string, string> }>("/api/tool-names"),
  setToolNames: (names: Record<string, string>) =>
    json<{ names: Record<string, string> }>("/api/tool-names", {
      method: "PUT",
      body: JSON.stringify({ names }),
    }),
  /** Switch tools off by name; everything not named is on. */
  setTools: (sessionId: string, off: string[]) =>
    json<{ off: string[] }>(`/api/sessions/${sessionId}/tools`, {
      method: "PUT",
      body: JSON.stringify({ off }),
    }),
  respondUi: (sessionId: string, id: string, payload: { value?: unknown; cancelled?: boolean }) =>
    json<{ ok: boolean; note?: string }>(`/api/sessions/${sessionId}/ui-response`, {
      method: "POST",
      body: JSON.stringify({ id, ...payload }),
    }),

  /** Where models come from: servers in pi's models.json, keys in its auth.json. */
  providers: () => json<ProvidersView>("/api/providers"),
  probeProvider: (body: { kind: ProviderKind; baseUrl: string; apiKey?: string; id?: string }) =>
    json<{ baseUrl: string; models: ProviderModel[] }>("/api/providers/probe", { method: "POST", body: JSON.stringify(body) }),
  saveProvider: (id: string, body: { kind: ProviderKind; adding?: boolean; baseUrl?: string; api?: string; apiKey?: string; models?: ProviderModel[] }) =>
    json<{ ok: true; note?: string }>(`/api/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  /** `note` says what else came of it: a copy kept of a models.json whose comments were dropped. */
  removeProvider: (id: string) => json<{ ok: true; note?: string }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Whether each server answers now. */
  providerStatus: () => json<{ status: Record<string, ProviderStatus> }>("/api/providers/status"),
  /** Every model pi can use now, outside any chat — for the defaults. */
  allModels: () => json<{ models: AvailableModel[]; providers: Record<string, string> }>("/api/models"),
  mcp: () => json<McpConfigView>("/api/mcp"),
  saveMcpServer: (name: string, entry: McpServerEntry, from?: string) =>
    json<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ entry, from }),
    }),
  deleteMcpServer: (name: string) =>
    json<{ ok: true }>(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" }),
  saveMcpSettings: (settings: Record<string, unknown>) =>
    json<{ ok: true }>("/api/mcp/settings", {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),
  importMcp: (text: string) =>
    json<{ ok: true; added: string[]; skipped: { name: string; reason: string }[] }>(
      "/api/mcp/import",
      { method: "POST", body: JSON.stringify({ text }) }
    ),
  saveMcpRaw: (content: string) =>
    json<{ ok: true }>("/api/mcp/raw", { method: "PUT", body: JSON.stringify({ content }) }),

  skills: () =>
    json<{ root: string; skills: Skill[]; diagnostics: SkillDiagnostic[] }>("/api/skills"),
  previewSkillImport: (spec: string) =>
    json<{ spec: string; sha: string; found: FoundSkill[]; skipped: SkippedSkill[] }>("/api/skills/preview-import", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  // `sha` is the commit the look saw, so that what is installed is what was shown.
  importSkills: (spec: string, only: string[], overwrite: boolean, sha?: string) =>
    json<{ ok: true; imported: string[]; skipped: SkippedSkill[] }>(
      "/api/skills/import",
      { method: "POST", body: JSON.stringify({ spec, only, overwrite, sha }) }
    ),
  updateSkill: (name: string) =>
    json<{ ok: true; imported: string[] }>(`/api/skills/${encodeURIComponent(name)}/update`, {
      method: "POST",
    }),

  createSkill: (name: string, description: string, body?: string) =>
    json<{ ok: true; name: string; path: string }>("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body }),
    }),
  saveSkill: (name: string, content: string) =>
    json<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  setSkillEnabled: (name: string, enabled: boolean) =>
    json<{ ok: true; enabled: boolean }>(`/api/skills/${encodeURIComponent(name)}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  deleteSkill: (name: string) =>
    json<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),

  people: () => json<{ people: Person[] }>("/api/people"),
  browser: () => json<BrowserStatus>("/api/browser"),
  openTerminal: (sessionId?: string) =>
    json<{ id: string; cwd: string }>("/api/terminal", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    }),
  terminalInput: (id: string, data: string) =>
    json<{ ok: true }>(`/api/terminal/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  terminalResize: (id: string, rows: number, cols: number) =>
    json<{ ok: true }>(`/api/terminal/${id}/resize`, {
      method: "POST",
      body: JSON.stringify({ rows, cols }),
    }),
  closeTerminal: (id: string) => json<{ ok: true }>(`/api/terminal/${id}`, { method: "DELETE" }),
  installBrowser: () => json<{ ok: true }>("/api/browser/install", { method: "POST" }),
  startBrowser: () => json<{ ok: true }>("/api/browser/start", { method: "POST" }),
  stopBrowser: () => json<{ ok: true }>("/api/browser/stop", { method: "POST" }),
  removeBrowser: (forgetProfile = false) =>
    json<{ ok: true }>(`/api/browser/install${forgetProfile ? "?profile=forget" : ""}`, {
      method: "DELETE",
    }),
  setBrowserConfig: (patch: { user?: string; password?: string }) =>
    json<{ user: string; hasPassword: boolean }>("/api/browser/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  suggestBrowserPassword: () =>
    json<{ password: string }>("/api/browser/suggest-password"),
  features: () => json<Features>("/api/features"),
  /** The subagent tool alone: nothing of Understory or Docker asked for. */
  subagentFeature: () => json<{ subagent: SubagentFeature }>("/api/features/subagent"),
  /** Image generation alone: nothing of Understory or Docker asked for. */
  imagesFeature: () => json<{ images: ImagesFeature }>("/api/features/images"),
  /**
   * Only whether each is on — cheap, for the sidebar and the chat's menus.
   * `images`: image generation is on and has an address, which is when the Images page is in the sidebar.
   */
  featureFlags: () => json<{ subagent: { enabled: boolean }; understory: { enabled: boolean }; images?: { enabled: boolean } }>("/api/features/flags"),
  /** What a chat's subagents run on: its own choice (null follows `default`). */
  subagentModel: (id: string) => json<{ model: string | null; default: string }>(`/api/sessions/${id}/subagent-model`),
  setSubagentModel: (id: string, model: string | null) =>
    json<{ model: string | null; default: string }>(`/api/sessions/${id}/subagent-model`, { method: "PUT", body: JSON.stringify({ model }) }),
  memoryTree: () => json<MemoryNode>("/api/memory/tree"),
  memoryConcept: (path: string) => json<MemoryConcept>(`/api/memory/concept?${new URLSearchParams({ path })}`),
  memorySearch: (q: string) => json<MemoryHit[]>(`/api/memory/search?${new URLSearchParams({ q })}`),
  memoryLog: () => json<MemoryChange[]>("/api/memory/log"),
  memoryGraph: () => json<MemoryGraph>("/api/memory/graph"),
  memoryTraces: () => json<MemoryTrace[]>("/api/memory/traces"),
  memoryValidate: () => json<MemoryValidation>("/api/memory/validate"),
  /** Whether notes can be changed here: only in the Understory the portal runs. */
  memoryHealth: () => json<{ writable: boolean; health?: MemoryHealth }>("/api/memory/health"),
  saveMemoryNote: (path: string, frontmatter: Record<string, unknown>, body: string) =>
    json<{ concept: MemoryConcept; health: MemoryHealth }>("/api/memory/concept", { method: "PUT", body: JSON.stringify({ path, frontmatter, body }) }),
  deleteMemoryNote: (path: string) =>
    json<{ health: MemoryHealth }>(`/api/memory/concept?${new URLSearchParams({ path })}`, { method: "DELETE" }),
  reindexMemory: () => json<{ pruned: string[]; reindexed: number; health: MemoryHealth }>("/api/memory/reindex", { method: "POST" }),
  /** The model mends links to nothing and wires in orphans; `ran` is false when there were none. */
  repairMemory: () =>
    json<{ ran: boolean; reason?: string; summary?: string; filesChanged?: string[]; health: MemoryHealth }>("/api/memory/repair", { method: "POST" }),
  clearMemoryLog: () => json<{ health: MemoryHealth }>("/api/memory/clear-log", { method: "POST" }),
  /** Every note gone, the index and log empty: the memory from nothing. */
  wipeMemory: () => json<{ health: MemoryHealth }>("/api/memory/wipe", { method: "POST" }),
  setSubagentFeature: (patch: { enabled?: boolean; mode?: SubagentMode; maxParallel?: number; model?: string }) =>
    json<{ subagent: SubagentFeature; reloaded: number; waiting: number }>("/api/features/subagent", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  /** `changed`: the agent got or lost a tool, which chats have from their next load. */
  setImagesFeature: (patch: ImagesFeaturePatch) =>
    json<{ images: ImagesFeature; changed: boolean; reloaded: number; waiting: number }>("/api/features/images", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  /** A page of the gallery, newest first; `before` is the `next` of the page before. */
  galleryPage: (query: { origin?: PictureOrigin; kind?: PictureKind; before?: string; limit?: number; again?: boolean } = {}) => {
    const params = new URLSearchParams();
    // `again` is a switch the server reads as 1: the page asks again for a list it has, and the files are not looked through again at once.
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== false) params.set(name, value === true ? "1" : String(value));
    return json<GalleryPage>(`/api/images${params.size ? `?${params}` : ""}`);
  },
  /** Some pictures of the gallery by their ids, as far as they are there. */
  galleryPictures: (ids: string[]) => json<{ pictures: GalleryPicture[] }>(`/api/images?ids=${ids.join(",")}`),
  /** What is being made, and what was, with the most that run at once. */
  pictureJobs: () => json<{ jobs: PictureJob[]; limit: number }>("/api/images/jobs"),
  /** Stops a picture that is being made, or clears one that is done. */
  stopPictureJob: (id: string) => json<{ ok: true }>(`/api/images/jobs/${id}`, { method: "DELETE" }),
  /** One job for each picture; answers at once. */
  makePictures: (request: PictureRequest) => json<{ jobs: PictureJob[] }>("/api/images/generate", { method: "POST", body: JSON.stringify(request) }),
  /** One job for each change; answers at once. */
  changePicture: (request: ChangeRequest) =>
    json<{ jobs: PictureJob[] }>("/api/images/edit", { method: "POST", body: JSON.stringify(request) }),
  /** A picture from this computer, into the gallery to be changed. */
  uploadPicture: async (file: File): Promise<GalleryPicture> => (await uploadBytes(`/api/images/upload?name=${encodeURIComponent(file.name)}`, file, file.name)).picture,
  /** The picture as the file it is. Its address never changes what it shows, unless it is in a chat's folder, which the browser then asks about. */
  galleryFileUrl: (id: string) => `/api/images/${id}/file`,
  /** Each as asked, files and all: what could not be deleted is said for each. */
  deletePictures: (ids: string[]) => json<{ deleted: string[]; failed: { id: string; error: string }[] }>("/api/images/delete", { method: "POST", body: JSON.stringify({ ids }) }),
  setUnderstoryConfig: (config: { llm: UnderstoryLlmChoice; dreamInterval: string; dreamAt: string }) =>
    json<{ understory: UnderstoryFeature }>("/api/features/understory/config", { method: "PUT", body: JSON.stringify(config) }),
  dreamUnderstory: () => json<{ understory: UnderstoryFeature }>("/api/features/understory/dream", { method: "POST" }),
  installUnderstory: () =>
    json<{ understory: UnderstoryFeature; reloaded: number; waiting: number }>("/api/features/understory/install", { method: "POST" }),
  understoryAction: (action: "start" | "stop") =>
    json<{ understory: UnderstoryFeature }>(`/api/features/understory/${action}`, { method: "POST" }),
  removeUnderstory: (forgetMemory = false) =>
    json<{ understory: UnderstoryFeature; reloaded: number; waiting: number }>(
      `/api/features/understory/install${forgetMemory ? "?memory=forget" : ""}`,
      { method: "DELETE" },
    ),
  setUnderstoryFeature: (patch: { enabled: boolean; url?: string }) =>
    json<{ understory: UnderstoryFeature; reloaded: number; waiting: number }>("/api/features/understory", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  connectBrowser: () =>
    json<{ connectedAs: string | null }>("/api/browser/connect", { method: "POST" }),
  disconnectBrowser: () =>
    json<{ connectedAs: string | null }>("/api/browser/connect", { method: "DELETE" }),
  sandbox: () => json<SandboxState>("/api/sandbox"),
  setSandbox: (policy: SandboxPolicy) =>
    json<{ policy: SandboxPolicy; report: SandboxReport; chats: { reloaded: number; waiting: number } }>("/api/sandbox", { method: "PUT", body: JSON.stringify(policy) }),
  setBrowserCursor: (on: boolean) =>
    json<{ cursor: boolean }>("/api/browser/cursor", { method: "PUT", body: JSON.stringify({ on }) }),
  setBrowserAllowlist: (domains: string) =>
    json<{ allowlist: string }>("/api/browser/allowlist", {
      method: "PUT",
      body: JSON.stringify({ domains }),
    }),

  audit: (limit = 200) => json<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`),
  /** Up to and including `through`, the newest entry the caller has seen. */
  clearAudit: (through: number) => json<{ removed: number }>(`/api/audit?through=${through}`, { method: "DELETE" }),
  toolRules: () => json<{ rules: ToolRule[] }>("/api/tool-rules"),
  addToolRule: (rule: {
    role: string;
    tool: string;
    pattern: string;
    note?: string;
    /** Narrows the rule to one person; omitted, it applies to the whole role. */
    personKey?: string;
  }) =>
    json<{ rules: ToolRule[] }>("/api/tool-rules", {
      method: "POST",
      body: JSON.stringify(rule),
    }),
  deleteToolRule: (id: string) =>
    json<{ rules: ToolRule[] }>(`/api/tool-rules/${id}`, { method: "DELETE" }),
  /** `force` confirms taking the last primary user's role away: see the people route. */
  updatePerson: (key: string, patch: { name?: string; role?: Role; notes?: string; force?: boolean }) =>
    json<{ person: Person }>(`/api/people/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  forgetPerson: (key: string, force = false) =>
    json<{ ok: true }>(`/api/people/${encodeURIComponent(key)}${force ? "?force=1" : ""}`, { method: "DELETE" }),

  routines: () => json<{ routines: Routine[] }>("/api/routines"),
  reportTargets: () =>
    json<{ targets: ReportTarget[]; default: ReportTo | null }>("/api/routines/report-targets"),
  setReportDefault: (to: ReportTo | null) =>
    json<{ default: ReportTo | null }>("/api/routines/report-default", {
      method: "PUT",
      body: JSON.stringify(to ?? {}),
    }),
  createRoutine: (input: {
    name: string;
    schedule?: string;
    runAt?: string;
    instructions?: string;
    reportChannel?: string | null;
    reportTarget?: string | null;
    workspace?: string | null;
  }) =>
    json<Routine>("/api/routines", { method: "POST", body: JSON.stringify(input) }),
  updateRoutine: (
    id: string,
    patch: {
      name?: string;
      slug?: string;
      schedule?: string;
      runAt?: string;
      instructions?: string;
      enabled?: boolean;
      freshSession?: boolean;
      guard?: boolean;
      browser?: boolean;
      reportChannel?: string | null;
      reportTarget?: string | null;
      workspace?: string | null;
    }
  ) => json<Routine>(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoutine: (id: string) => json<{ ok: true }>(`/api/routines/${id}`, { method: "DELETE" }),
  runRoutine: (id: string) => json<Routine>(`/api/routines/${id}/run`, { method: "POST" }),
  previewSchedule: (schedule: string) =>
    json<{ expression: string; runs: string[] }>("/api/routines/preview", {
      method: "POST",
      body: JSON.stringify({ schedule }),
    }),
  routineSessions: (id: string) =>
    json<{ sessions: Session[] }>(`/api/routines/${id}/sessions`),

  agents: () => json<{ agents: Agent[] }>("/api/agents"),
  /** A new agent, set up with the wizard's answers. */
  createAgent: (setup: AgentWizard) =>
    json<Agent & { kept: string[] }>("/api/agents", { method: "POST", body: JSON.stringify({ name: setup.agentName, setup }) }),
  renameAgent: (id: string, name: string) =>
    json<Agent>(`/api/agents/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  /** The agent and its chats; its folder too when `folder` is "delete". */
  deleteAgent: (id: string, folder: "keep" | "delete") =>
    json<{ ok: true; sessionsDeleted: number; routinesSwitchedOff: string[]; routinesDeleted: string[]; jobsStopped: number }>(
      `/api/agents/${encodeURIComponent(id)}?folder=${folder}`,
      { method: "DELETE" }
    ),
  setAgentVoice: (agent: string, voice: string) =>
    json<Agent>(`/api/agents/${encodeURIComponent(agent)}/voice`, { method: "PUT", body: JSON.stringify({ voice }) }),
  agentSkills: (agent: string) => json<{ folder: string; skills: AgentSkill[] }>(`/api/agents/${encodeURIComponent(agent)}/skills`),
  agentSkill: (agent: string, skill: string) =>
    json<{ content: string }>(`/api/agents/${encodeURIComponent(agent)}/skills/${encodeURIComponent(skill)}`),
  agentSetup: (agent: string) => json<AgentSetup>(`/api/agents/${encodeURIComponent(agent)}/setup`),
  /** The avatar voice mode shows for a chat: its agent's. */
  chatOrb: (session: string) => json<OrbStyle>(`/api/agent/orb?session=${encodeURIComponent(session)}`),
  /** An agent's avatar: the voice-mode orb's look and personality. */
  setAgentOrb: (agent: string, style: OrbStyle) =>
    json<OrbStyle>(`/api/agents/${encodeURIComponent(agent)}/orb`, { method: "PUT", body: JSON.stringify(style) }),
  runAgentWizard: (agent: string, input: AgentWizard) =>
    json<AgentSetup & { kept: string[] }>(`/api/agents/${encodeURIComponent(agent)}/setup`, { method: "POST", body: JSON.stringify(input) }),
  /** `mtime` is the file's as it was read; a file the agent has written since is refused (409). Without it the save replaces what is there. */
  saveAgentFile: (agent: string, name: string, content: string, mtime?: number) =>
    json<AgentSetup>(`/api/agents/${encodeURIComponent(agent)}/files/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content, mtime }),
    }),

  /** Any session by id, including agent and routine ones the task list omits. */
  olderEvents: (id: string, before: number, limit = 1200) =>
    json<{ events: PortalEvent[]; more: boolean }>(
      `/api/sessions/${id}/events/before?before=${before}&limit=${limit}`
    ),
  session: (id: string) => json<Session>(`/api/sessions/${id}`),
  startAgentChat: (agent: string, title?: string) =>
    json<Session>("/api/agent/sessions", { method: "POST", body: JSON.stringify({ agent, title }) }),

  setHeartbeat: (agent: string, heartbeat: { minutes: number; quietStart: string; quietEnd: string }) =>
    json<Agent>(`/api/agents/${encodeURIComponent(agent)}/heartbeat`, { method: "PUT", body: JSON.stringify(heartbeat) }),
  /** A look now; answers at once, and the agent's status follows it. */
  lookNow: (agent: string) => json<Agent>(`/api/agents/${encodeURIComponent(agent)}/heartbeat/run`, { method: "POST" }),
  activity: (agent: string) => json<{ notes: ActivityNote[]; unread: number }>(`/api/agents/${encodeURIComponent(agent)}/activity`),
  markActivityRead: (agent: string) => json<{ unread: number }>(`/api/agents/${encodeURIComponent(agent)}/activity/read`, { method: "POST" }),
  markNoteRead: (agent: string, note: string) =>
    json<{ unread: number }>(`/api/agents/${encodeURIComponent(agent)}/activity/${encodeURIComponent(note)}/read`, { method: "POST" }),
  deleteNote: (agent: string, note: string) =>
    json<{ ok: true }>(`/api/agents/${encodeURIComponent(agent)}/activity/${encodeURIComponent(note)}`, { method: "DELETE" }),

  agentSessions: (agent: string) =>
    json<{ sessions: AgentSession[]; agentHome: string }>(`/api/agent/sessions?agent=${encodeURIComponent(agent)}`),

  pinSession: (id: string, pinned: boolean) =>
    json<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),

  abort: (id: string) => json<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),

  /** Jobs the agent left running in the chat's folder, and what extensions show about themselves. */
  background: (id: string) => json<BackgroundState>(`/api/sessions/${id}/background`),
  backgroundOutput: (id: string, key: string, from?: number) =>
    json<{ text: string; from: number; size: number }>(
      `/api/sessions/${id}/background/${encodeURIComponent(key)}/output${from === undefined ? "" : `?from=${from}`}`,
    ),
  stopBackground: (id: string, key: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/background/${encodeURIComponent(key)}/stop`, { method: "POST" }),
  clearBackground: (id: string) => json<{ ok: true }>(`/api/sessions/${id}/background/clear`, { method: "POST" }),
  /** A message for a subagent that said it takes them (subagent protocol, input: true). */
  subagentInput: (id: string, agent: string, text: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/subagents/${encodeURIComponent(agent)}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  subagentStop: (id: string, agent: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/subagents/${encodeURIComponent(agent)}/stop`, { method: "POST" }),

  /** Cheap: never starts pi. Stats are null when the session is not live. */
  config: (id: string) => json<PiConfig>(`/api/sessions/${id}/config`),
  /** Only the token and context figures, which is all a run needs refreshed; does not start pi. */
  stats: (id: string) => json<{ live: boolean; stats: PiConfig["stats"] }>(`/api/sessions/${id}/stats`),
  /** Starts pi if needed — only called when the model picker is opened. */
  models: (id: string) => json<PiConfig>(`/api/sessions/${id}/models`),
  setConfig: (id: string, patch: ConfigPatch) =>
    json<{ ok: true; applied: string[]; state: PiState }>(`/api/sessions/${id}/config`, {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  /** The window a model really has on this server; `null` goes back to what its definition says. */
  setContextLimit: (provider: string, model: string, tokens: number | null) =>
    json<{ ok: true; contextLimit: number | null }>("/api/context-limit", {
      method: "PUT",
      body: JSON.stringify({ provider, model, tokens }),
    }),
  /** The window every chat is held to unless its model has its own; `null` removes it. */
  setContextDefault: (tokens: number | null) =>
    json<{ ok: true; contextDefault: number | null }>("/api/context-default", {
      method: "PUT",
      body: JSON.stringify({ tokens }),
    }),
  compact: (id: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/compact`, { method: "POST" }),

  /** `ifRunning`: only from a pi that is up, rather than starting one; `notRunning` when none was. */
  commands: (id: string, opts?: { ifRunning?: boolean }) =>
    json<{ commands: PiCommand[]; notRunning?: boolean }>(`/api/sessions/${id}/commands${opts?.ifRunning ? "?ifRunning=1" : ""}`),
  /** What is in the chat box, for an extension that asks. */
  draft: (id: string, text: string, caret?: { start: number; end: number }) =>
    json<{ ok: true }>(`/api/sessions/${id}/draft`, { method: "PUT", body: JSON.stringify({ text, caret }) }),
  piSettings: () => json<{ path: string; content: string }>("/api/pi-settings"),
  savePiSettings: (content: string) =>
    json<{ ok: true; path: string; note: string }>("/api/pi-settings", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  settings: () =>
    json<{
      /** What pi is launched with once every fallback is applied. */
      settings: GlobalSettings;
      /** Only the values the portal was explicitly given. */
      stored: Partial<GlobalSettings>;
      /** What an unset field falls back to: env, else pi's settings.json. */
      defaults: GlobalSettings;
      piSettingsPath: string;
      /** pi's own compaction tuning, which lives in its settings.json not ours. */
      compaction: CompactionSettings;
      compactionDefaults: CompactionSettings;
      contextDefault: number | null;
      executor: string;
      workspaceRoot: string;
    }>("/api/settings"),
  saveSettings: (patch: Partial<GlobalSettings> & { keepRecentTokens?: number }) =>
    json<{
      settings: GlobalSettings;
      compaction: CompactionSettings;
      /** How many open sessions took the new compaction settings. */
      refreshed: number;
      note: string;
    }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  channels: () =>
    json<{
      channels: Channel[];
      kinds: ChannelKind[];
      broken: BrokenChannelPackage[];
      agentHome: string;
      channelsDir: string;
    }>("/api/channels"),
  installChannelPackage: (spec: string) =>
    json<{ ok: true; output: string }>("/api/channel-packages", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  removeChannelPackage: (name: string) =>
    json<{ ok: true }>(`/api/channel-packages/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  createChannel: (kind: string, name: string, config: Record<string, string>) =>
    json<Channel>("/api/channels", {
      method: "POST",
      body: JSON.stringify({ kind, name, config }),
    }),
  updateChannel: (
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      config?: Record<string, string>;
      instructions?: string;
      slug?: string;
      relayProgress?: boolean;
      relayTools?: boolean;
      agentId?: string;
    }
  ) =>
    json<Channel>(`/api/channels/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteChannel: (id: string, alsoSessions = false) =>
    json<{ ok: true; stranded: number; deleted: number }>(
      `/api/channels/${id}${alsoSessions ? "?sessions=delete" : ""}`,
      { method: "DELETE" }
    ),

  extensions: () =>
    json<{ extensions: ExtensionInfo[]; settingsPath: string }>("/api/extensions"),
  setExtensionSetting: (key: string, value: unknown) =>
    json<{ ok: true }>("/api/extensions/settings", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),

  packages: () => json<{ output: string }>("/api/packages"),
  /** pi packages published on npm; `topic` "provider" for the ones that bring models. */
  catalog: (q = "", topic?: "provider") =>
    json<{ packages: CatalogPackage[] }>(`/api/packages/catalog?${new URLSearchParams({ q, ...(topic ? { topic } : {}) })}`),
  installPackage: (spec: string) =>
    json<{ ok: true; output: string }>("/api/packages", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  removePackage: (spec: string) =>
    json<{ ok: true; output: string }>("/api/packages", {
      method: "DELETE",
      body: JSON.stringify({ spec }),
    }),
  setExtensionEnabled: (spec: string, enabled: boolean) =>
    json<{ ok: true; enabled: boolean; reloaded: number; waiting: number }>("/api/extensions/enabled", {
      method: "PUT",
      body: JSON.stringify({ spec, enabled }),
    }),
  updatePackages: () =>
    json<{ ok: true; output: string }>("/api/packages/update", { method: "POST" }),
};

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number };
}

export interface PiState {
  model: PiModel;
  thinkingLevel: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
}

export interface PiConfig {
  /** False when pi is not running: model and effort are the stored ones. */
  live: boolean;
  state: PiState;
  thinking: { levels: string[] };
  models: { models: PiModel[] };
  /** The model the chat's row names, as it is now; none when it follows the default. */
  named?: { provider: string | null; model: string | null };
  /** The context window set for this model, when it differs from its definition. */
  contextLimit?: number | null;
  /** The window every chat is held to, as a ceiling; set in Settings. */
  contextDefault?: number | null;
  /** False when pi runs where the portal cannot change its window: EXECUTOR=container. */
  contextLimitSupported?: boolean;
  /** Why the window cannot be set, when `contextLimitSupported` is false. */
  contextLimitNote?: string;
  stats: null | {
    tokens: { input: number; output: number; total: number };
    cost: number;
    /** `tokens` and `percent` are null just after a compaction, until the next reply. */
    contextUsage: { tokens: number | null; contextWindow: number; percent: number | null };
    toolCalls: number;
    totalMessages: number;
  };
}

export interface ConfigPatch {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  autoCompaction?: boolean;
  autoRetry?: boolean;
}


export interface ChannelField {
  key: string;
  label: string;
  hint?: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface ChannelKind {
  id: string;
  label: string;
  blurb: string;
  fields: ChannelField[];
  /** The package providing it — builtins ship with the portal. */
  packageName: string;
  version?: string;
  builtin: boolean;
  /** False if the package has no usable start(), so it can never run. */
  runnable: boolean;
}

/** A package that failed to load, reported rather than silently skipped. */
export interface BrokenChannelPackage {
  packageName: string;
  dir: string;
  builtin: boolean;
  error: string;
}

export interface Channel {
  id: string;
  /** Stable key the agent's conversations hang off. Survives delete + recreate. */
  slug: string;
  kind: string;
  name: string;
  enabled: boolean;
  /** Non-secret values only — secrets never leave the server. */
  config: Record<string, string>;
  /** Which secret fields have a value stored. */
  secretsSet: string[];
  /** Appended to each message arriving here, in a <channel-instructions> block. */
  instructions: string;
  /** Relay what the agent says between tool calls, not just the final answer. */
  relayProgress: boolean;
  /** Relay the name of each tool as it runs. */
  relayTools: boolean;
  /** The agent it talks as. */
  agentId: string;
  /** Conversations keyed to this channel's slug. */
  sessionCount: number;
  /** What the supervisor is doing with it right now. */
  state: "running" | "stopped" | "starting" | "error";
  error?: string;
  since?: string;
  log: { at: string; text: string }[];
  created_at: string;
  updated_at: string;
}

/** One setting an extension reads, recovered from its source by the server. */
export interface DetectedSetting {
  key: string;
  value: unknown;
  configured: boolean;
}

export interface ExtensionInfo {
  spec: string;
  name: string;
  path?: string;
  scope?: string;
  description?: string;
  homepage?: string;
  version?: string;
  settings: DetectedSetting[];
  /** Whether pi loads it; absent where the portal cannot switch it. */
  enabled?: boolean;
  /** Narrowed by hand in settings.json: some of what it brings is off already. */
  filtered?: boolean;
}

export interface GlobalSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
}

export interface PiCommand {
  name: string;
  description?: string;
  source: "builtin" | "extension" | "prompt" | "skill" | string;
  /** Builtins only: "client" commands are handled here, not sent to pi. */
  where?: "server" | "client";
  /** Builtins only: does nothing without one, so choosing it leaves the box open for it. */
  needsArgument?: boolean;
  sourceInfo?: { path?: string; scope?: string; origin?: string };
}

/** One MCP server as pi-mcp-adapter reads it. Unlisted keys are kept verbatim. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  socket?: string;
  auth?: "oauth" | "bearer" | false;
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
  idleTimeout?: number;
  requestTimeoutMs?: number;
  exposeResources?: boolean;
  directTools?: boolean | string[];
  includeTools?: string[];
  excludeTools?: string[];
  debug?: boolean;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface McpServerView {
  name: string;
  entry: McpServerEntry;
  transport: "stdio" | "http" | "socket" | "unknown";
  disabled: boolean;
}

export interface McpConfigView {
  path: string;
  exists: boolean;
  /** Without the adapter installed, nothing here is read by anything. */
  adapterInstalled: boolean;
  adapterSpec: string;
  servers: McpServerView[];
  settings: Record<string, unknown>;
  raw: string;
  parseError: string | null;
}

/** A conversation a routine can report into. */
export interface ReportTarget {
  channel: string;
  target: string;
  label: string;
}

export interface ReportTo {
  channel: string;
  target: string;
}

/** Descending capability. "unknown" never reaches the agent at all. */
export type Role = "primary" | "colleague" | "guest" | "unknown";

export interface Person {
  key: string;
  name: string;
  role: Role;
  notes: string;
  first_seen: string;
  last_seen: string | null;
  announced_at: string | null;
}

/** An exception to what a non-primary role may run. */
export interface ToolRule {
  id: string;
  role: string;
  tool: string;
  pattern: string;
  /** Set when the rule is for one person rather than a whole role. */
  person_key: string | null;
  note: string;
  created_at: string;
}

/** One decision the guard made, for the audit view. */
export interface AuditEntry {
  id: number;
  at: string;
  kind: "refused" | "allowed-by-rule" | "allowed-by-approval" | "stranger" | "answered" | "cleared" | string;
  tool: string;
  subject: string;
  reason: string;
  person_key: string | null;
  person_name: string | null;
  session_id: string | null;
}

/** The agent's browser, and who may drive it. */
export type SubagentMode = "interrupt" | "background";

/** The subagent tool the portal ships, off until switched on. */
export interface SubagentFeature {
  /** This install carries it. */
  available: boolean;
  installed: boolean;
  enabled: boolean;
  /** How pi's packages list names it. */
  source: string | null;
  mode: SubagentMode;
  /** How many may run at once, across every chat. */
  maxParallel: number;
  /** The most that may be set. */
  maxParallelLimit?: number;
  /** What they run on unless a chat says: "auto", the model the chat is on, or "provider/model". */
  model: string;
}

/** Image generation as the page is told it: never the key, only whether one is set. */
export interface ImagesFeature {
  enabled: boolean;
  /** The API's base, such as https://host/v1. */
  baseUrl: string;
  model: string;
  /** "1024x1024" or empty for the endpoint's own. */
  size: string;
  keySet: boolean;
  /** Editing a picture has a switch of its own: not every endpoint that makes pictures changes them. */
  editEnabled: boolean;
  /** Where edits go; empty is the address above. */
  editBaseUrl: string;
  /** Empty sends no model: the model above is not taken for editing. */
  editModel: string;
  /** The edit endpoint takes several pictures, so edit_image has a list; off until said, and off again when edits move to another server. */
  editMultiple: boolean;
  /** "2048x2048", the most pixels a picture sent to be edited may have, or empty for no limit. */
  editMaxSize: string;
  editKeySet: boolean;
  /** How long a request for a picture, made or edited, may take, in whole seconds. */
  timeoutSeconds: number;
  /** Whether pictures can be made: switched on, and with an address to ask. The portal says it, so that the page does not work it out again. */
  ready: boolean;
  /** Whether the agent has an edit tool: switched on, and with an address to ask. */
  editReady: boolean;
  /** The endpoint is stable-diffusion.cpp's server: the page shows, and sends, the settings that only it reads. Off by default. */
  sdExtras: boolean;
}

/** Made on the page, made by the agent in a chat, or found in a folder the agent's tools write into, with no chat to name. */
export type PictureOrigin = "page" | "chat" | "folder";
/** Made from a description, changed from another picture, put in by the person to be changed, or found with nothing to tell how it was made. */
export type PictureKind = "generated" | "edited" | "uploaded" | "unknown";

/** A picture of the gallery, as the portal tells of it. */
export interface GalleryPicture {
  id: string;
  origin: PictureOrigin;
  /** The chat whose agent made it, for the agent's pictures. */
  chat: { id: string; title: string } | null;
  /** The folder it was found in, for one that was found: Home, or the project's name or the way to the folder under the workspace root. */
  folder: { name: string; home: boolean } | null;
  kind: PictureKind;
  prompt: string;
  /** What it was asked for with, as far as that is known. */
  params: {
    model?: string;
    size?: string;
    outputFormat?: OutputFormat;
    outputCompression?: number;
    /** The ones that only stable-diffusion.cpp's server reads. */
    negativePrompt?: string;
    seed?: number;
    sampleSteps?: number;
    strength?: number;
    fromNoise?: boolean;
    /** Fields an older version of the page sent as typed; shown, not sent again. */
    extra?: Record<string, string | number | boolean>;
    sources?: string[];
    masked?: boolean;
  };
  /** The picture an edit was made from, when that one is in the gallery. */
  from: string | null;
  createdAt: number;
  bytes: number;
  fileName: string;
}

export interface GalleryPage {
  pictures: GalleryPicture[];
  /** Where the next page starts, or null at the end. */
  next: string | null;
  /** How many there are with the filters, and how much of the disk the page's own take. */
  total: number;
  pageBytes: number;
}

/** A picture that is being made, was, or was not. */
export interface PictureJob {
  id: string;
  kind: "generate" | "edit";
  state: "running" | "done" | "failed";
  prompt: string;
  size?: string;
  /** An edit's first picture. */
  from?: string;
  startedAt: number;
  finishedAt?: number;
  pictureId?: string;
  error?: string;
}

/** The file formats of the OpenAI image format. */
export type { OutputFormat };

/**
 * What the page asks of the portal for one picture beyond its description, and
 * only what is set. Model, size, format and compression are fields of the
 * OpenAI image format; the rest are not, and reach only an endpoint that is
 * stable-diffusion.cpp's server, in the prompt (see image-settings.ts on the portal).
 */
export interface PictureSettingsBody {
  model?: string;
  /** `1024x1024`. */
  size?: string;
  outputFormat?: OutputFormat;
  /** With jpeg or webp. */
  outputCompression?: number;
  negativePrompt?: string;
  seed?: number;
  sampleSteps?: number;
  /** For a change only. */
  strength?: number;
  /** For a change only: from noise, with the pictures as references; no strength and no mask then. */
  fromNoise?: boolean;
}

/** What the page asks the portal to make. */
export interface PictureRequest extends PictureSettingsBody {
  prompt: string;
  count?: number;
}

/** What the page asks the portal to change: `mask` is a PNG as base64, and the transparent part is what changes. */
export interface ChangeRequest extends PictureSettingsBody {
  prompt: string;
  sources: string[];
  mask?: string;
  count?: number;
}

/** What the page may change of it. A key left out keeps the saved one; "" takes it away. */
export interface ImagesFeaturePatch {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  size?: string;
  apiKey?: string;
  editEnabled?: boolean;
  editBaseUrl?: string;
  editModel?: string;
  editApiKey?: string;
  editMultiple?: boolean;
  editMaxSize?: string;
  /** null takes a saved limit away: the default again. */
  timeoutSeconds?: number | null;
  sdExtras?: boolean;
}

/** The model that keeps Understory's memory, as the page is told it: never the key. */
export type UnderstoryLlm =
  | { source: "auto" }
  | { source: "provider"; provider: string; model: string }
  | { source: "custom"; baseUrl: string; model: string; format: "openai" | "anthropic"; hasKey?: boolean };

/** What the page sends for it: a custom key only when it is being changed. */
export type UnderstoryLlmChoice =
  | { source: "auto" }
  | { source: "provider"; provider: string; model: string }
  | { source: "custom"; baseUrl: string; model: string; format: "openai" | "anthropic"; apiKey?: string };

/** The Understory the portal runs itself, in a container of its own. */
export interface ManagedUnderstory {
  /** The portal can reach Docker. */
  available: boolean;
  image: boolean;
  /** "foreign": a container by that name the portal did not make, which it leaves alone. */
  container: "absent" | "stopped" | "running" | "foreign";
  pulling: { active: boolean; line: string; error?: string };
  url: string;
  /** `dreamAt`: once a day at this time ("03:00"), started by the portal; wins over the interval. */
  config: { llm: UnderstoryLlm; dreamInterval: string; dreamAt: string };
  /** "The chat's model" can be offered: not while the portal serves its own TLS. */
  autoPossible: boolean;
  /** Providers set up here that Understory can be pointed at. */
  providers: { id: string; models: string[] }[];
  /** A pass the portal started is running now. */
  dreaming: boolean;
  lastDream: { at: string; ok: boolean; ran?: boolean; said: string } | null;
  nextDream: string | null;
  /** The portal's time zone, which a set time is in. */
  timeZone: string;
}

/** Understory as the agent's memory, over MCP. */
export interface UnderstoryFeature {
  enabled: boolean;
  url: string;
  /** MEMORY_UNDERSTORY_AUTH_TOKEN is set for the portal. */
  tokenSet: boolean;
  adapterInstalled: boolean;
  /** Something answers at the address. */
  reachable: boolean;
  managed: ManagedUnderstory;
  configError?: string;
}

/** A folder or a note in Understory's memory bundle. `reserved` are its own index and log. */
export interface MemoryNode {
  name: string;
  path: string;
  kind: "directory" | "concept" | "reserved";
  type?: string;
  title?: string;
  description?: string;
  children?: MemoryNode[];
}

export interface MemoryConcept {
  path: string;
  frontmatter: { type?: string; title?: string; description?: string; tags?: string[]; timestamp?: string; [key: string]: unknown };
  body: string;
}

export interface MemoryHit {
  path: string;
  type?: string;
  title?: string;
  description?: string;
  snippet?: string;
}

export interface MemoryChange {
  date: string;
  action: string;
  summary: string;
}

export interface MemoryGraph {
  nodes: { path: string; title?: string; type?: string; description?: string; links: number }[];
  edges: { source: string; target: string }[];
}

/** A run of Understory's own agent over the memory: a query, or a change. */
export interface MemoryTrace {
  id: string;
  kind: string;
  input: string;
  startedAt: string;
  durationMs?: number;
  notation?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** What a change may have left behind in the memory: links to nowhere, notes nothing links to, what the format says. */
export interface MemoryHealth {
  healthy: boolean;
  orphans: { path: string; title?: string }[];
  brokenLinks: { path: string; target: string }[];
  issues: { path: string; severity: string; message: string }[];
}

export interface MemoryValidation {
  conformant: boolean;
  conceptCount?: number;
  directoryCount?: number;
  issues: { path: string; severity: "error" | "warning"; message: string }[];
}

export interface Features {
  subagent: SubagentFeature;
  understory: UnderstoryFeature;
  images: ImagesFeature;
}

export interface BrowserStatus {
  running: boolean;
  /** Running with no password on its web UI. */
  unprotected: boolean;
  /** The MCP server wiring the agent to this browser, if any. */
  connectedAs: string | null;
  /** How and whether a browser can run here at all. */
  install: {
    available: boolean;
    /** "external": a browser the deployment runs itself, which the portal only looks at. */
    mode?: "docker" | "local" | "external";
    image: boolean;
    container: "absent" | "stopped" | "running" | "unavailable";
    binary?: string | null;
    headless?: boolean;
    pulling: { active: boolean; line: string; error?: string };
  };
  config: { user: string; hasPassword: boolean };
  version: string | null;
  pages: { title: string; url: string }[];
  uiPort: string;
  allowlist: string;
  /** Whether the browser tools glide a cursor to what they act on. */
  cursor: boolean;
  /** Is the browser wired up at all, whether or not it is running right now? */
  configured: boolean;
  /** Does a conversation that has never said anything about it get the browser? */
  byDefault: boolean;
  /** Only the conversations that disagree with that — see "Who may drive it". */
  sessions: { id: string; title: string; kind: string; allowed: boolean }[];
  routines: { slug: string; name: string }[];
}

/** A skill an agent wrote for itself, in its home's skills folder. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  updatedAt: number;
  files: string[];
}

/** What the agent may do to a path in the sandbox. */
export type SandboxAccess = "none" | "read" | "write";
export interface SandboxPolicy {
  enabled: boolean;
  rules: { path: string; access: SandboxAccess; note?: string }[];
  trusted: { name: string; script: string }[];
}
export interface SandboxReport {
  ok: boolean;
  done: string[];
  warnings: string[];
}
export interface SandboxState {
  policy: SandboxPolicy;
  defaults: SandboxPolicy;
  /** Whether this portal can sandbox at all, and why not. */
  available: boolean;
  reason: string | null;
  trustedDir: string;
  secretsDir: string;
  lastReport: SandboxReport | null;
}

export type ProviderKind = "llama-cpp" | "llama-swap" | "ollama" | "openrouter" | "hosted" | "custom";

/** One kind of provider the Models page offers. */
export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  description: string;
  id: string;
  endpoint: boolean;
  baseUrl?: string;
  key: "none" | "optional" | "required";
}

/** A model as a server lists it, or as models.json keeps it. */
export interface ProviderModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
}

export interface ProviderInfo {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl?: string;
  api?: string;
  /** The key itself never leaves the server: only whether there is one, and how to tell it apart. */
  key: { set: boolean; hint?: string; source?: string };
  models: ProviderModel[];
  endpoint: boolean;
}

export interface ProvidersView {
  presets: ProviderPreset[];
  apis: string[];
  providers: ProviderInfo[];
  /** The hosted services pi knows, by its own names. */
  hosted: { id: string; name: string }[];
}

export interface ProviderStatus {
  state: "up" | "down";
  ms?: number;
  message?: string;
  listed?: number;
  /** Chosen models the server no longer lists. */
  missing?: string[];
  /** What llama-swap has loaded now. */
  loaded?: string[];
}

export interface CatalogPackage {
  name: string;
  version: string;
  description?: string;
  date?: string;
  weekly?: number;
  author?: string;
  keywords: string[];
  npm?: string;
  homepage?: string;
  provider: boolean;
}

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  input?: string[];
  reasoning: boolean;
}
