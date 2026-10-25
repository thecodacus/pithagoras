import { t } from "./i18n";
import { samplesWav } from "./voice";
import type { OrbStyle } from "../../server/src/orb-style";
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
  /** The mode it was started in; null is Standard. */
  mode: string | null;
}

/** A mode a chat can be put in, as the portal offers it to that chat. */
export interface ChatMode {
  id: string;
  label: string;
  description: string;
  /** Asked, with a yes or no, before a chat is put in it. */
  confirm?: string;
  /** The package that offers it, whose translations its texts are shown through. */
  extension?: string;
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
  /** False lets this routine act on what it read against at least one of the guard's rules — see `exempt`. */
  guard: boolean;
  /** The guard's rules its runs are exempt from, by name: set in Settings → Guard. */
  exempt: string[];
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
  /** Where the agent's memory is kept: while something holds it (`by` names it), MEMORY.md is not read. */
  memory?: "file" | "extension";
  by: string | null;
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
  /** Whether the New button starts a chat with it. */
  newChats: boolean;
  initialised: boolean;
  chats: number;
  /** The channels that talk as it. */
  channels: { slug: string; name: string }[];
  /** Its avatar. */
  orb: OrbStyle;
  /** The voice it speaks with: an id from the voices voice mode's source offers, or "" for its own choice. */
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
  /** The agent whose soul, user and memory its chats carry: its id. Left out for a blank slate, which has only the instructions. */
  agent?: string;
  /** Set where the project does without the memory an extension holds, and its chats read the agent's MEMORY.md. */
  memoryOff?: boolean;
  /** How many chats work in it, and when one last moved. */
  sessions: number;
  lastActive: string | null;
}

/** Who a project's chats are with: see /api/projects/:name/agent. */
export interface ProjectAgent {
  agent: string | null;
  /** The memory an extension holds is the project's (see GET /api/features/flags): not where it is off, nor for a blank slate. */
  memory: boolean;
  /** An extension holds the agent's memory now. */
  memoryAvailable: boolean;
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

/** A tool a conversation could use, and whether it is switched on for it. */
export interface PortalTool {
  name: string;
  description?: string;
  /** The package or MCP server that registered it, for grouping. */
  source: string;
  enabled: boolean;
  /** Whether it is on by default, so a chat can show where it disagrees. */
  defaultOn?: boolean;
  /** A chat's only: the code tool, on, in a chat whose mode switches it on. Its switch cannot turn it off. */
  byMode?: true;
  /** One of the portal's own, not an extension's of the same name: the list groups code mode by it. */
  inline?: true;
  /** An MCP server's tool listed from the adapter's cache: the server starts when one of its tools is first used. */
  cached?: true;
  /** Not in the list the model is given one by one but found through the `tools` tool, or an MCP server's through `mcp`: on or off like any other. */
  lazy?: true;
  /** An MCP server's tool: the server, whose setting "Register tools directly" says whether the tool is lazy. */
  mcp?: string;
  /** Settings → Tools only: one of pi's own tools or the adapter's `mcp`, which cannot be made lazy. */
  noLazy?: true;
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
 * Fired when what is installed changed (a package installed, removed, updated
 * or switched), so the page loads or drops an extension's interface at once:
 * see extensions/loader.ts. By this page's own changes as they are made, and by
 * the list of chats when it says that what is installed changed elsewhere, or
 * where a server half stands: one may have crashed.
 */
export const EXTENSIONS_CHANGED = "pithagoras:extensions-changed";
const changesExtensions = <T>(request: Promise<T>): Promise<T> =>
  request.then((result) => {
    window.dispatchEvent(new Event(EXTENSIONS_CHANGED));
    return result;
  });

/** Fired when the person's own modes changed (Settings → Modes), so that a chat's picker lists them as they are now. */
export const MODES_CHANGED = "pithagoras:modes-changed";
const changesModes = <T>(request: Promise<T>): Promise<T> =>
  request.then((result) => {
    window.dispatchEvent(new Event(MODES_CHANGED));
    return result;
  });

/** A mode the person made, as Settings → Modes edits it: `id` is what follows "custom/" on a chat in it. */
export interface CustomMode {
  id: string;
  label: string;
  description: string;
  /** Its chats work through the code tool alone. */
  codemode: boolean;
  /** Said in its chats' system prompt. */
  instructions: string;
  /** What a chat is put on as it is put in the mode: none leaves it as the chat would have it. */
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How a server half crashed, with the lines it said last, as a log file has them: as GET /api/extension-ui gives it. */
export interface ServerCrash {
  name: string;
  at: string;
  rev: string;
  error: string;
  stack?: string;
  lines: string[];
}

/** An installed extension's browser half: where its module is fetched from, and its stylesheet if it has one. */
export interface ExtensionUi {
  name: string;
  version?: string;
  /** Absent for a package that has only a server half. */
  entry?: string;
  /** The revision of its browser half, which `entry` and `style` carry: what a failure of it is told to the portal under. */
  rev?: string;
  style?: string;
  /** Why its browser half failed in a page, this one or another, while that revision is the one installed: to load, to draw, or in what it runs of its own. */
  clientError?: string;
  /** Where it failed, as that page had it: the error's stack, and the components it was drawn in. */
  clientStack?: string;
  /** The files its module imports along with itself, to be asked for at once rather than one level at a time. */
  preload?: string[];
  /** Where its server half's own routes are, when it has one; why it is not running, when it could not be started. */
  server?: string;
  serverError?: string;
  /**
   * Its server half crashed (an error of its code reached the portal's process, or it called process.exit()), and is
   * off until another revision of it is installed or it is switched off and on: when, which revision, the error, and
   * the last lines it said, as a log file has them.
   */
  crash?: ServerCrash;
  /** The extensions its server half cannot start without, each with the versions it takes. */
  requires?: Record<string, string>;
  /** The themes its package.json names: colours in place of the portal's own, with no code. See extensions/themes.ts. */
  themes?: { id: string; name: string; light?: Record<string, string>; dark?: Record<string, string> }[];
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
  // The model spoken turns run on, "provider/model"; empty means the chat's own.
  voiceModel?: string;
  pipelineMode?: "parallel" | "sequential";
  // The extension voice mode listens and speaks through, by its package's name; "" for none.
  provider: string;
  // Its label, while its server half runs.
  label?: string;
  // Whether it can be used now.
  ready: boolean;
  // False where it recognises speech alone: the page can listen, but replies are not spoken.
  speech: boolean;
  // The voices it offers now, which an agent's voice is chosen from.
  voices: { id: string; name: string; builtIn?: boolean }[];
  // Voice mode is on while it has a source.
  enabled: boolean;
  // Whether voice mode, the spoken conversation, is offered: off leaves dictation, which only listens.
  conversation: boolean;
  vad?: typeof DEFAULT_VAD;
}
/** What the page saves of voice mode: whether a spoken conversation is offered and how it goes, whatever listens and speaks for it. */
export interface VoiceModeSave { vad: typeof DEFAULT_VAD; responseInstructions: string; skipThinkingProviders?: string[]; voiceModel: string; conversation: boolean }

/** Who is signed in, and how one signs in. */
export interface AuthStatus {
  authRequired: boolean;
  authed: boolean;
  setup?: boolean;
  shortPassword?: boolean;
  oidc?: SingleSignOn;
}

/** The provider the login page offers, and whether it is the only way in. */
export interface SingleSignOn {
  name: string;
  only: boolean;
}

/** Settings → Authentication as the page is shown it: the client secret never, only whether there is one. */
export interface SsoSettings {
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  redirectUrl: string;
  scopes: string;
  name: string;
  endSession: boolean;
}

/** What the page saves: a secret left out keeps the one there is, for the same provider and client. */
export type SsoInput = Omit<SsoSettings, "hasSecret"> & { clientSecret?: string | null };

export interface SsoState {
  mode: "password" | "setup" | "open";
  callbackPath: string;
  settings: SsoSettings | null;
  only: boolean;
}

export const api = {
  /**
   * A file from this computer into the chat's folder. A taken name gets a
   * number rather than replacing anything; the answer says what it is called.
   */
  uploadFile: (sessionId: string, dir: string, file: File, name = file.name): Promise<{ path: string; size: number }> =>
    uploadBytes(`/api/sessions/${sessionId}/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, file, name),
  /** What was said in `samples` (16 kHz mono), in words, and how long the speech server says it took. Dictation may be set to use another model than voice mode. */
  transcribe: async (sessionId: string, samples: Float32Array, signal?: AbortSignal, purpose?: "dictation"): Promise<{ text: string; serverTiming: string }> => {
    const res = await send(`/api/sessions/${sessionId}/voice/transcribe${purpose ? `?purpose=${purpose}` : ""}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: samplesWav(samples), signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error || t("Transcription failed"), res.status, body);
    return { text: String(body.text ?? ""), serverTiming: res.headers.get("server-timing") ?? "" };
  },
  voice: () => json<VoiceConfig>("/api/voice"),
  setVoice: (value: VoiceModeSave) => json<VoiceConfig>("/api/voice", { method: "PUT", body: JSON.stringify(value) }),
  /** Voice mode stops using its source: it is off until an extension's page chooses one again. */
  stopVoiceSource: () => json<VoiceConfig>("/api/voice/provider", { method: "DELETE" }),
  /** `setup`: no password has been chosen yet, so the page asks for one. `oidc`: a single sign-on provider is offered too. */
  authStatus: () => json<AuthStatus>("/api/auth/status"),
  login: (password: string) =>
    json<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  /** Chooses the first password of a portal that has none, and signs in with it. */
  setupPassword: (password: string) =>
    json<{ ok: true }>("/api/auth/setup", { method: "POST", body: JSON.stringify({ password }) }),
  /** Every other browser is signed out by it; this one stays signed in. */
  changePassword: (current: string, password: string) =>
    json<{ ok: true }>("/api/auth/password", { method: "POST", body: JSON.stringify({ current, password }) }),
  /** `endSession` is the provider's sign-out page, where Settings → Authentication asks for the session there to end too. */
  logout: () => json<{ ok: true; endSession?: string }>("/api/auth/logout", { method: "POST" }),
  sso: () => json<SsoState>("/api/auth/sso"),
  /** Saves Settings → Authentication, or with `settings: null` takes it out. Asks for the current password; this browser is signed in again under the change. */
  saveSso: (current: string, settings: SsoInput | null, only: boolean) =>
    json<{ settings: SsoSettings | null; only: boolean; noEndSession?: true }>("/api/auth/sso", {
      method: "PUT",
      body: JSON.stringify({ current, settings, only }),
    }),
  workspaces: () => json<{ root: string; workspaces: Workspace[] }>("/api/workspaces"),
  /** With what is installed and where its server halves stand, as a revision that changes whenever either does: see EXTENSIONS_CHANGED. */
  sessions: () => json<{ sessions: Session[]; executor: string; extensions: string }>("/api/sessions"),
  /** Without a workspace the chat starts in the home of the agent New is set to. */
  createSession: (workspace?: string, title?: string) =>
    json<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace, title }),
    }),
  projects: () => json<{ root: string; home: string; agents?: { id: string; name: string; home: string; newChats?: boolean }[]; projects: Project[] }>("/api/projects"),
  /** Only where Home is and which projects there are, without their counts: see /api/projects. */
  places: () =>
    json<{ root: string; home: string; agents?: { id: string; name: string; home: string; newChats?: boolean }[]; projects: { name: string; path: string; agent?: string }[] }>(
      "/api/projects?bare=1"
    ),
  /**
   * `toolsOff`: the tools its chats start with off, as for setProjectTools. `toolsError` says the project was made without them.
   * `link`: the agent it works with (none is a blank slate) and whether the memory an extension holds is its memory (the default where one holds it).
   */
  createProject: (name: string, instructions?: string, toolsOff?: string[], link?: { agent?: string; memory?: boolean }) =>
    json<Project & { toolsError?: string }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, instructions, toolsOff, ...link }),
    }),
  /** The agent a project works with (null: none), whether the memory an extension holds is its memory, and whether one holds it at all. */
  projectAgent: (name: string) => json<ProjectAgent>(`/api/projects/${encodeURIComponent(name)}/agent`),
  /** Either may be left out and then stays; `agent: null` makes the project a blank slate. */
  setProjectAgent: (name: string, change: { agent?: string | null; memory?: boolean }) =>
    json<ProjectAgent>(`/api/projects/${encodeURIComponent(name)}/agent`, { method: "PUT", body: JSON.stringify(change) }),
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
  /** The modes the chat may be put in: none where it may not choose one. */
  chatModes: (id: string) => json<{ modes: ChatMode[] }>(`/api/sessions/${id}/modes`),
  /** Puts a chat that has said nothing yet in a mode; `confirmed`, for one that asks first, once the person said yes. */
  setMode: (id: string, mode: string, confirmed?: boolean) =>
    json<{ mode: string }>(`/api/sessions/${id}/modes`, { method: "PUT", body: JSON.stringify({ mode, ...(confirmed ? { confirmed: true } : {}) }) }),
  /** The modes the person made, by their names. */
  customModes: () => json<{ modes: CustomMode[] }>("/api/chat-modes"),
  createMode: (fields: { label: string; description: string }) =>
    changesModes(json<CustomMode>("/api/chat-modes", { method: "POST", body: JSON.stringify(fields) })),
  /** Changes what a mode says: only what `patch` names. */
  updateMode: (id: string, patch: Partial<Omit<CustomMode, "id" | "createdAt" | "updatedAt">>) =>
    changesModes(json<CustomMode>(`/api/chat-modes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) })),
  deleteMode: (id: string) => changesModes(json<{ ok: true }>(`/api/chat-modes/${encodeURIComponent(id)}`, { method: "DELETE" })),
  /** What every chat in a mode starts with: its exceptions to Settings → Tools, `live` always false. */
  modeTools: (id: string) =>
    json<{ tools: PortalTool[]; live: boolean; off: string[]; names: Record<string, string> }>(`/api/chat-modes/${encodeURIComponent(id)}/tools`),
  setModeTools: (id: string, off: string[]) =>
    changesModes(json<{ off: string[]; applied: number }>(`/api/chat-modes/${encodeURIComponent(id)}/tools`, { method: "PUT", body: JSON.stringify({ off }) })),
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
  /** A clip in the chat's folder, by its path there, as pictureUrl is for a picture: the player asks for the parts it needs. */
  videoUrl: (id: string, path: string, version?: string | number) =>
    `/api/sessions/${id}/video?path=${encodeURIComponent(path)}${version === undefined ? "" : `&v=${encodeURIComponent(String(version))}`}`,
  /** Any file in the chat's folder, by its path there, to be saved: a file a call gave that is neither a picture nor a clip. */
  fileUrl: (id: string, path: string, version?: string | number) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}${version === undefined ? "" : `&v=${encodeURIComponent(String(version))}`}`,
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
  /** Takes back a message sent mid-run that the agent has not read yet (409 once it has). */
  takeBackQueued: (id: string, seq: number) =>
    json<{ ok: true }>(`/api/sessions/${id}/queued/${seq}`, { method: "DELETE" }),
  /** Stops the run and sends a queued message first, the others behind it in their order. */
  sendQueuedNow: (id: string, seq: number) =>
    json<{ ok: true }>(`/api/sessions/${id}/queued/${seq}/send`, { method: "POST" }),
  /** Shows another version of a message, and what followed it then. */
  switchVersion: (id: string, seq: number, to: number) =>
    json<{ ok: true }>(`/api/sessions/${id}/messages/${seq}/version`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
  /** Every tool the portal has seen, for setting a default without opening a chat. */
  toolDefaults: () =>
    json<{
      tools: { name: string; source: string; defaultOn: boolean; inline?: true; lazy?: true; mcp?: string; noLazy?: true }[];
      off: string[];
      names: Record<string, string>;
      /** What is marked lazy: tool sets, and single tools as `<tool>name`. Opt-in; nothing is lazy until somebody marks it. */
      lazy?: string[];
      /** How long ask_question waits for an answer; 0 is until it is answered. */
      questionWaitMinutes?: number;
    }>("/api/tools"),
  /** Which tool sets and single tools (`<tool>name`) are lazy: not in the model's list one by one, found through the `tools` tool. */
  setLazyToolSets: (lazy: string[]) =>
    json<{ lazy: string[]; applied: number }>("/api/tools/lazy", { method: "PUT", body: JSON.stringify({ lazy }) }),
  /** How long the agent's ask_question waits for an answer, in minutes; 0 is until it is answered. */
  setQuestionWait: (waitMinutes: number) =>
    json<{ waitMinutes: number }>("/api/ask-question", { method: "PUT", body: JSON.stringify({ waitMinutes }) }),
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
  /** An MCP server's setting "Register tools directly" on its own; off, the server's tools are lazy. */
  setMcpDirect: (name: string, direct: boolean) =>
    json<{ ok: true; direct: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}/direct`, { method: "PUT", body: JSON.stringify({ direct }) }),
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
  /** What holds the agent's memory, by its label, where something does — cheap, for the Projects page. */
  featureFlags: () => json<{ memory: { held: boolean; by: string | null } }>("/api/features/flags"),
  sandbox: () => json<SandboxState>("/api/sandbox"),
  guard: () => json<GuardState>("/api/guard"),
  setGuardServer: (name: string, trusted: boolean) =>
    json<{ name: string; trusted: boolean }>(`/api/guard/servers/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ trusted }) }),
  setGuardRoutine: (id: string, exempt: string[]) =>
    json<{ id: string; exempt: string[] }>(`/api/guard/routines/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ exempt }) }),
  revokeApproval: (id: string) => json<{ ok: true }>(`/api/guard/approvals/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** The sites the agent's tools may reach: one domain per line, empty for any site. */
  setGuardAllowlist: (domains: string) =>
    json<{ allowlist: string }>("/api/guard/allowlist", { method: "PUT", body: JSON.stringify({ domains }) }),
  untrustResult: (sessionId: string, id: string) =>
    json<{ ok: true }>(`/api/guard/trusted/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setSandbox: (policy: SandboxPolicy) =>
    json<{ policy: SandboxPolicy; report: SandboxReport; chats: { reloaded: number; waiting: number } }>("/api/sandbox", { method: "PUT", body: JSON.stringify(policy) }),

  audit: (limit = 200) => json<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`),
  /** Up to and including `through`, the newest entry the caller has seen. */
  clearAudit: (through: number) => json<{ removed: number }>(`/api/audit?through=${through}`, { method: "DELETE" }),
  /** What the server printed; with `since`, only what came after that line. */
  logs: (opts: { since?: number; level?: LogLevel; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", String(opts.since));
    if (opts.level) q.set("level", opts.level);
    if (opts.limit) q.set("limit", String(opts.limit));
    return json<LogsResponse>(`/api/logs?${q}`);
  },
  /** Where an update can be made, the commit checked out, and the update that is running; the remote is not asked. */
  update: () => json<UpdateStatus>("/api/update"),
  /** Asks the remote what is new, and says what an update would do and what stands in its way. */
  checkUpdate: () => json<UpdateCheck>("/api/update/check", { method: "POST" }),
  /** `expect` is the commit that was shown; a remote that has moved on since is refused. */
  startUpdate: (expect: string) => json<{ run: UpdateRun }>("/api/update", { method: "POST", body: JSON.stringify({ expect }) }),
  /** Whether the portal would come back after a restart, and how many chats and routines it would stop; changes nothing. */
  restartStatus: () => json<RestartStatus>("/api/restart"),
  /** Ends the portal for a supervisor to start again; `boot` is the start that is ending, which the new one differs from. */
  restartPortal: () => json<{ restarting: true; boot: string }>("/api/restart", { method: "POST", body: JSON.stringify({ confirm: true }) }),
  /** Answers without a login while the portal is up, with the token of this start of it. */
  health: () => json<{ ok: true; boot: string }>("/api/health"),
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
  /** On makes it the agent the New button starts with; off hands that back to the first agent. */
  setNewChats: (agent: string, on: boolean) =>
    json<Agent>(`/api/agents/${encodeURIComponent(agent)}/new-chats`, { method: "PUT", body: JSON.stringify({ on }) }),
  setAgentVoice: (agent: string, voice: string) =>
    json<Agent>(`/api/agents/${encodeURIComponent(agent)}/voice`, { method: "PUT", body: JSON.stringify({ voice }) }),
  agentSkills: (agent: string) => json<{ folder: string; skills: AgentSkill[] }>(`/api/agents/${encodeURIComponent(agent)}/skills`),
  agentSkill: (agent: string, skill: string) =>
    json<{ content: string }>(`/api/agents/${encodeURIComponent(agent)}/skills/${encodeURIComponent(skill)}`),
  agentSetup: (agent: string) => json<AgentSetup>(`/api/agents/${encodeURIComponent(agent)}/setup`),
  /** The agent a chat is with, and the avatar voice mode shows for it. */
  chatAvatar: (session: string) => json<{ agent: { id: string; name: string }; orb: OrbStyle }>(`/api/agent/avatar?session=${encodeURIComponent(session)}`),
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
    json<{ ok: true; path: string }>("/api/pi-settings", {
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
  /** What comes with the portal and can be installed with a click. */
  shippedExtensions: () => json<{ extensions: ShippedExtension[] }>("/api/extensions/shipped"),
  /** What installing `spec` brings with it: the extensions it requires that are not there as it needs them. */
  installPlan: (spec: string) => json<InstallPlan>(`/api/extensions/plan?${new URLSearchParams({ spec })}`),
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
    changesExtensions(json<{ ok: true; output: string }>("/api/packages", {
      method: "POST",
      body: JSON.stringify({ spec }),
    })),
  removePackage: (spec: string) =>
    changesExtensions(json<{ ok: true; output: string }>("/api/packages", {
      method: "DELETE",
      body: JSON.stringify({ spec }),
    })),
  setExtensionEnabled: (spec: string, enabled: boolean) =>
    changesExtensions(json<{ ok: true; enabled: boolean; reloaded: number; waiting: number }>("/api/extensions/enabled", {
      method: "PUT",
      body: JSON.stringify({ spec, enabled }),
    })),
  updatePackages: () =>
    changesExtensions(json<{ ok: true; output: string }>("/api/packages/update", { method: "POST" })),
  /** The installed extensions that bring an interface (see extensions/loader.ts), with what is installed as GET /api/sessions says it (`revision`), as it was when this list was made. */
  extensionUi: () => json<{ extensions: ExtensionUi[]; revision: string }>("/api/extension-ui"),
  /** Tells the portal that an extension's browser half, at revision `rev`, failed in this page, and where: its `clientError` and `clientStack` from then on. */
  extensionFailed: (name: string, rev: string, error: string, stack?: string) =>
    json<{ ok: true }>("/api/extension-ui/failures", { method: "POST", body: JSON.stringify({ name, rev, error, stack }) }),
  /** What an extension's server half would tell a page that opens the chat now: for a browser half that came into the page later. */
  extensionOpening: (id: string, extension: string) => json<{ pushes: unknown[] }>(`/api/sessions/${id}/extension-ui?extension=${encodeURIComponent(extension)}`),
  /** What an extension's browser half says to its own half in a chat: see extensions/channel.ts. */
  tellExtension: (id: string, extension: string, data: unknown) =>
    json<{ ok: true }>(`/api/sessions/${id}/extension-ui`, { method: "POST", body: JSON.stringify({ extension, data }) }),
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
  /** A code the package asks to be scanned to finish setting it up, and what to do with it. */
  pairing?: { code: string; hint: string };
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
  /** What it brings: something for pi (the agent), something the portal draws or runs, colours for the portal. */
  kinds?: PackageKind[];
  /**
   * The extension whose own data folder it is in, however it was installed; and the note that extension gave and when,
   * where it installed it itself.
   */
  installedFrom?: { extension: string; note?: string; at?: string };
}

export type PackageKind = "pi" | "pithagoras" | "themes";

/** An extension that comes with the portal, installed from its own folder (`spec`). */
export interface ShippedExtension {
  name: string;
  version?: string;
  description?: string;
  kinds: PackageKind[];
  spec: string;
  /** The extensions it cannot work without, each with the versions it takes. */
  requires?: Record<string, string>;
}

/**
 * Something an extension being installed needs that is not there as it is needed (see install-plan.ts on the
 * server): installed first by `spec`, from the portal's own folder or npm, or switched on; or said, where it is
 * nowhere in a version taken (`missing`, with `error` where npm could not be asked) or is there in a `version` not
 * taken (installed, or, with `from`, the one in the portal's own folder or the one installed from npm for another).
 */
export interface InstallNeed {
  name: string;
  range: string;
  /** The extension that needs it. */
  for: string;
  action: "install" | "switch-on" | "missing" | "version";
  spec?: string;
  from?: "shipped" | "npm";
  version?: string;
  error?: string;
}

/** What installing a spec brings with it, each need before what needs it. Without a name, nothing could be known beforehand. */
export interface InstallPlan {
  name?: string;
  version?: string;
  needs: InstallNeed[];
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

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line the server printed, for Settings → Logs. */
export interface LogLine {
  id: number;
  at: string;
  level: LogLevel;
  text: string;
}

/** `boot` changes when the server starts again, and the ids with it. */
export interface LogsResponse {
  boot: string;
  /** What the server runs at: `debug` also keeps its debug lines. Absent from a server that has no such setting. */
  level?: "info" | "debug";
  /** What the server holds at most, as lines and as characters; the page holds no more than that either. */
  keep?: number;
  chars?: number;
  last: number;
  /** Lines after `since` were let go before they were read, so `lines` does not join what the page holds. */
  gap?: boolean;
  lines: LogLine[];
}

/** A commit, as Settings → About names it. */
export interface UpdateCommit {
  sha: string;
  subject: string;
  date: string;
}

export type RestartStatus =
  | { possible: true; by: "systemd" | "container" | "manager" | "copy"; running: number; loaded: string[] | null; keepsLogins: boolean }
  | { possible: false; code: "unsupervised" | "policy" | "update"; reason: string; running: number; loaded: string[] | null; keepsLogins: boolean };

export type UpdateStep = "fetch" | "merge" | "install" | "build" | "restart";

export interface UpdateRun {
  state: "running" | "restarting" | "failed";
  steps: { id: UpdateStep; state: "pending" | "running" | "done" | "skipped" | "failed" }[];
  from: UpdateCommit;
  to: UpdateCommit;
  startedAt: string;
  /** English, from the server and from the program that failed. */
  failed?: {
    step: UpdateStep;
    message: string;
    output: string;
    /** The old node_modules and builds are in place: nothing was put aside, or what was has been put back. */
    oldFilesBack: boolean;
  };
}

/** New commits on origin/main, which the portal found on one of its looks. */
export interface UpdateNotice {
  count: number;
  target: UpdateCommit;
  since: string;
}

/** `kind` is where an update can be made: from a git checkout; not from a container's image, nor from source files under a watcher; not at all. */
export interface UpdateStatus {
  kind: "git" | "container" | "dev" | "none";
  /** Changes with each start of the portal. */
  boot: string;
  branch?: string | null;
  current?: UpdateCommit;
  notice?: UpdateNotice | null;
  /** What is built is not of the commit that is checked out (a build failed): Update builds it again. */
  rebuild?: boolean;
  run?: UpdateRun | null;
}

export interface UpdateCheck {
  branch: string | null;
  current: UpdateCommit;
  target: UpdateCommit | null;
  behind: number;
  ahead: number;
  changed: number;
  /** What is built is not of the commit that is checked out: Update builds again, with a merge or without. */
  rebuild: boolean;
  problem: { code: "fetch" | "detached" | "dirty" | "diverged" | "restart"; message: string } | null;
  /** Chats and runs going now, which the restart stops. */
  running: number;
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

/** Settings → Guard: what the guard holds the agent to, and what of it can be changed there. */
export interface GuardState {
  /** Whether pi runs with the guard here: not under the container executor. */
  running: boolean;
  sandbox: "on" | "off" | "unavailable";
  /** Whether a primary user is named. */
  primary: boolean;
  /** Whether the routine reports' chat is set, which is where approvals are asked for. */
  approvalsTo: boolean;
  rules: { name: string; why: string }[];
  /** The MCP servers, and whether each is counted as the person's own; the browser's never is. */
  servers: { name: string; trusted: boolean; browser: boolean }[];
  routines: { id: string; name: string; exempt: string[] }[];
  /** The sites the agent's tools may reach, one domain per line; empty for any site. */
  allowlist: string;
  approvals: { id: string; sessionId: string; chat: string | null; tool: string; subject: string; expiresAt: string }[];
  trusted: { sessionId: string; chat: string | null; results: { id: string; tool?: string; signals?: string[]; excerpt?: string }[] }[];
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
