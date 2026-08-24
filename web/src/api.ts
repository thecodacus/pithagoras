export type SessionStatus = "idle" | "running" | "error" | "interrupted";

export interface Session {
  id: string;
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
  kind?: "task" | "agent" | "routine";
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
  files: { name: string; exists: boolean; content: string }[];
}

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

export interface CompactionSettings {
  enabled: boolean;
  /** The floor a compaction cannot go below — kept verbatim, never summarised. */
  keepRecentTokens: number;
}

export interface PortalEvent {
  seq: number;
  type: string;
  /** When the server recorded it, epoch ms. Absent on anything older than the field. */
  at?: number;
  payload: any;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  authStatus: () => json<{ authRequired: boolean; authed: boolean }>("/api/auth/status"),
  login: (password: string) =>
    json<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  workspaces: () => json<{ root: string; workspaces: Workspace[] }>("/api/workspaces"),
  createWorkspace: (name: string) =>
    json<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  sessions: () => json<{ sessions: Session[]; executor: string }>("/api/sessions"),
  createSession: (workspace: string, title?: string) =>
    json<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspace, title }),
    }),
  renameSession: (id: string, title: string) =>
    json<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteSession: (id: string) => json<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  prompt: (id: string, message: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  respondUi: (sessionId: string, id: string, payload: { value?: unknown; cancelled?: boolean }) =>
    json<{ ok: boolean }>(`/api/sessions/${sessionId}/ui-response`, {
      method: "POST",
      body: JSON.stringify({ id, ...payload }),
    }),

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
    json<{ spec: string; found: FoundSkill[] }>("/api/skills/preview-import", {
      method: "POST",
      body: JSON.stringify({ spec }),
    }),
  importSkills: (spec: string, only: string[], overwrite: boolean) =>
    json<{ ok: true; imported: string[]; skipped: { name: string; reason: string }[] }>(
      "/api/skills/import",
      { method: "POST", body: JSON.stringify({ spec, only, overwrite }) }
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
  connectBrowser: () =>
    json<{ connectedAs: string | null }>("/api/browser/connect", { method: "POST" }),
  disconnectBrowser: () =>
    json<{ connectedAs: string | null }>("/api/browser/connect", { method: "DELETE" }),
  setBrowserAllowlist: (domains: string) =>
    json<{ allowlist: string }>("/api/browser/allowlist", {
      method: "PUT",
      body: JSON.stringify({ domains }),
    }),
  setSessionBrowser: (id: string, enabled: boolean) =>
    json<{ enabled: boolean }>(`/api/sessions/${id}/browser`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  audit: (limit = 200) => json<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`),
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
  updatePerson: (key: string, patch: { name?: string; role?: Role; notes?: string }) =>
    json<{ person: Person }>(`/api/people/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  forgetPerson: (key: string) =>
    json<{ ok: true }>(`/api/people/${encodeURIComponent(key)}`, { method: "DELETE" }),

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

  agentSetup: () => json<AgentSetup>("/api/agent/setup"),
  runAgentWizard: (input: {
    agentName: string;
    vibe?: string;
    userName: string;
    userAbout?: string;
    userPrefers?: string;
  }) => json<AgentSetup>("/api/agent/setup", { method: "POST", body: JSON.stringify(input) }),
  saveAgentFile: (name: string, content: string) =>
    json<AgentSetup>(`/api/agent/files/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  /** Any session by id, including agent and routine ones the task list omits. */
  olderEvents: (id: string, before: number, limit = 1200) =>
    json<{ events: PortalEvent[]; more: boolean }>(
      `/api/sessions/${id}/events/before?before=${before}&limit=${limit}`
    ),
  session: (id: string) => json<Session>(`/api/sessions/${id}`),
  startAgentChat: (title?: string) =>
    json<Session>("/api/agent/sessions", { method: "POST", body: JSON.stringify({ title }) }),

  agentSessions: () =>
    json<{ sessions: AgentSession[]; agentHome: string }>("/api/agent/sessions"),

  pinSession: (id: string, pinned: boolean) =>
    json<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned }),
    }),

  abort: (id: string) => json<{ ok: true }>(`/api/sessions/${id}/abort`, { method: "POST" }),

  /** Cheap: never starts pi. Stats are null when the session is not live. */
  config: (id: string) => json<PiConfig>(`/api/sessions/${id}/config`),
  /** Starts pi if needed — only called when the model picker is opened. */
  models: (id: string) => json<PiConfig>(`/api/sessions/${id}/models`),
  setConfig: (id: string, patch: ConfigPatch) =>
    json<{ ok: true; applied: string[]; state: PiState }>(`/api/sessions/${id}/config`, {
      method: "POST",
      body: JSON.stringify(patch),
    }),
  compact: (id: string) =>
    json<{ ok: true }>(`/api/sessions/${id}/compact`, { method: "POST" }),

  commands: (id: string) => json<{ commands: PiCommand[] }>(`/api/sessions/${id}/commands`),
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
  stats: null | {
    tokens: { input: number; output: number; total: number };
    cost: number;
    contextUsage: { tokens: number; contextWindow: number; percent: number };
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
  /** Appended to the agent's system prompt for messages arriving here. */
  instructions: string;
  /** Relay what the agent says between tool calls, not just the final answer. */
  relayProgress: boolean;
  /** Relay the name of each tool as it runs. */
  relayTools: boolean;
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
  person_name: string | null;
  note: string;
  created_at: string;
}

/** One decision the guard made, for the audit view. */
export interface AuditEntry {
  id: number;
  at: string;
  kind: "refused" | "allowed-by-rule" | "allowed-by-approval" | "stranger" | "answered" | string;
  tool: string;
  subject: string;
  reason: string;
  person_key: string | null;
  person_name: string | null;
  session_id: string | null;
}

/** The agent's browser, and who may drive it. */
export interface BrowserStatus {
  running: boolean;
  /** Running with no password on its web UI. */
  unprotected: boolean;
  /** The MCP server wiring the agent to this browser, if any. */
  connectedAs: string | null;
  /** How and whether a browser can run here at all. */
  install: {
    available: boolean;
    mode?: "docker" | "local";
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
  sessions: { id: string; title: string; kind: string }[];
  routines: { slug: string; name: string }[];
}
