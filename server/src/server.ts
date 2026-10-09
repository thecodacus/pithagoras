import { bindHost, loginThrottle, portalSecurityHeaders, tlsFiles } from "./http-security.js";
import { canvasesRouter } from "./api/canvases.js";
import { interruptCanvasWrites } from "./canvases.js";
import { eventsRouter } from "./api/events.js";
import { serveWeb } from "./web-static.js";
import { clampLevel } from "./pi/model-runtime.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";
import {
  BROWSER_CHANNEL,
  clearProjectTools,
  chatModel,
  contextLimitProblem,
  createSession,
  deleteSession,
  getContextLimit,
  getDb,
  getDefaultContextLimit,
  getSession,
  recordAudit,
  trustedResults,
  getSettingDefaults,
  getSettings,
  listAgentSessions,
  listChatSessions,
  listHeartbeatSessions,
  listRoutineSessions,
  listSessions,
  projectTools,
  projectsWithTools,
  agentTools,
  setAgentTools,
  clearAgentTools,
  routineTools,
  setRoutineTools,
  setRoutineBrowserSwitch,
  seenBrowserTools,
  toolDefaultsFor,
  setContextLimit,
  setDefaultContextLimit,
  setProjectTools,
  setSettings,
  setToolDefaultsOff,
  setToolGroupNames,
  shownStoredSettings,
  shownTools,
  toolDefaultsOff,
  toolGroupNames,
  updateSession,
} from "./db.js";
import { checkWorkspace, workspaceRoot } from "./workspaces.js";
import { insideReal, isWithinText } from "./within.js";
import { agentHome, agentHomePath } from "./agent-home.js";
import { dataFolder } from "./data-dir.js";
import { resolveChannelSession } from "./agent.js";
import { AgentError, agentOf, agentsRoot, chatsOf, defaultAgent, deletable, deleteAgent, getAgent, listAgents, orbOf } from "./agents.js";
import { sweepRemoved } from "./folder-removal.js";
import { agentsRouter } from "./api/agents.js";
import { heartbeat } from "./heartbeat.js";
import { deleteNotesOf } from "./activity.js";
import { EXECUTOR_KIND } from "./executor-kind.js";
import { sessions, CommandFailed, IMAGE_ROOT } from "./session-manager.js";
import { ImageError, MAX_IMAGE_BYTES, MAX_IMAGES, imagePath, mimeOf, parseImages, saveImages } from "./prompt-images.js";
import { defaultsFor, exceptionsFor, heldOffUnshown, toolEnabled, toolSource } from "./tool-policy.js";
import { mcpRouter, mcpServerNames, onMcpWritten } from "./api/mcp.js";
import { authEnabled, checkPassword, isAuthed, issueCookie, keptShortPassword, requireAuth, signOut } from "./auth.js";
import { packagesRouter } from "./api/packages.js";
import { extensionsRouter } from "./api/extensions.js";
import { channelsRouter } from "./api/channels.js";
import { removeRoutines, routinesIn, routinesRouter, switchOffRoutines } from "./api/routines.js";
import { filesRouter } from "./api/files.js";
import { gitRouter } from "./api/git.js";
import { holdsWork, unsavedRefusal, unsavedWork } from "./git.js";
import { skillsRouter } from "./api/skills.js";
import { featuresRouter } from "./api/features.js";
import { imagesRouter } from "./api/images.js";
import { forgetPicturesIn } from "./image-gallery.js";
import { memoryRouter } from "./api/memory.js";
import { memoryLlmRouter } from "./memory-llm.js";
import { modelLevels, modelRuntime, providersRouter } from "./api/providers.js";
import { peopleRouter } from "./api/people.js";
import { voiceRouter } from "./api/voice.js";
import { adoptPortalBrowser, browserRouter, pinConnection } from "./api/browser.js";
import { endAllTerminals, terminalRouter } from "./api/terminal.js";
import { BACKGROUND_SUPPORTED, MARKER, clearFinished, listJobs, readOutput, stopJob, stopJobsIn } from "./background.js";
import { attachBrowserUpgrade, mountBrowserProxy } from "./browser-proxy.js";
import { watchBrowserFrames } from "./extensions/browser-frames.js";
import { startLlamaProxy } from "./llama-progress.js";
import { applyOnStart } from "./sandbox/apply.js";
import { trustFlagged } from "./pi/guard.js";
import { sandboxPolicy, sandboxSupport } from "./sandbox/policy.js";
import { sandboxRouter } from "./api/sandbox.js";
import { scheduleDreams } from "./extensions/understory-service.js";
import { routineSupervisor } from "./routines/supervisor.js";
import { channelSupervisor } from "./channels/supervisor.js";
import {
  COMPACTION_DEFAULTS,
  piSettingsPath,
  readCompactionSettings,
  writeCompactionSettings,
} from "./pi-settings.js";
import { getBuiltinCommands, picturesRefused } from "./pi/builtins.js";
import { SessionEditError } from "./pi/session-edit.js";
import {
  NEW_CHAT_TITLE,
  ProjectError,
  createProject,
  deleteProjectFolder,
  describeProject,
  getProject,
  listProjects,
  readInstructions,
  titleFrom,
  writeInstructions,
} from "./projects.js";

const WORKSPACE_ROOT = workspaceRoot();
const PORT = Number(process.env.PORT || 4100);
/** Persistent place for CLIs, kept on PATH so pi and its tools can reach them. */
const BIN_DIR = dataFolder("BIN_DIR", "bin");

// Everything the portal starts carries this, and keeps it when it is detached:
// it is how a background job is known to be the agent's. See background.ts.
{
  const [name, value] = MARKER.split("=");
  process.env[name] = value;
}

const app = express();
// A message can carry pictures, which do not fit in what every other request is
// allowed. Only that route gets the room, and only once the password has been
// checked, so nobody can make the server read a body that size without it.
const PROMPT_ROUTE = /^\/api\/sessions\/[^/]+\/prompt$/;
const promptJson = express.json({ limit: `${Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3 / 1024 / 1024) + 2}mb` });
// An upload is the file itself, streamed to disk by its route, whatever type
// the browser gave it — a .json file must not be read as a request.
const UPLOAD_ROUTE = /^\/api\/sessions\/[^/]+\/upload$/;
// An edit on the Images page may carry a mask, a picture: its route reads its own, after the login too.
const IMAGE_EDIT_ROUTE = "/api/images/edit";
const smallJson = express.json({ limit: "2mb" });
app.use((req, res, next) => {
  // Understory's requests for a model carry whole conversations: its route reads its own.
  if (UPLOAD_ROUTE.test(req.path) || PROMPT_ROUTE.test(req.path) || req.path === IMAGE_EDIT_ROUTE || req.path.startsWith("/understory-llm/")) return next();
  smallJson(req, res, next);
});
app.use(cookieParser());

// --- auth ---

app.get("/api/auth/status", (req, res) => {
  const authed = isAuthed(req);
  // Said to a login only: to anyone else it would say which password to guess.
  res.json({ authRequired: authEnabled, authed, ...(authed && keptShortPassword ? { shortPassword: true } : {}) });
});

app.post("/api/auth/login", loginThrottle(), (req, res) => {
  if (!authEnabled) return res.json({ ok: true });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  issueCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  signOut(req, res);
  res.json({ ok: true });
});

// Understory's model server, in "the chat's" mode: its own token, not a portal login.
app.use(memoryLlmRouter((id) => sessions.currentModel(id)));
app.use("/api", requireAuth);

// --- global settings (defaults for every new session) ---

app.get("/api/settings", (_req, res) => {
  // `stored` and `defaults` are separated so the UI can show an empty field
  // with the inherited value as a placeholder, instead of pre-filling it and
  // turning the next Save into a permanent pin.
  res.json({
    settings: getSettings(),
    stored: shownStoredSettings(),
    defaults: getSettingDefaults(),
    piSettingsPath: piSettingsPath(),
    // pi's own, not the portal's — kept separate in the response so the UI can
    // say which file a value lives in.
    compaction: readCompactionSettings(),
    compactionDefaults: COMPACTION_DEFAULTS,
    contextDefault: getDefaultContextLimit() ?? null,
    executor: EXECUTOR_KIND,
    workspaceRoot: WORKSPACE_ROOT,
  });
});

app.put("/api/settings", async (req, res) => {
  const { provider, model, thinkingLevel } = req.body ?? {};
  const patch: Record<string, string> = {};
  if (typeof provider === "string") patch.provider = provider.trim();
  if (typeof model === "string") patch.model = model.trim();
  if (typeof thinkingLevel === "string") patch.thinkingLevel = thinkingLevel.trim();
  // Checked before anything is written. Rejecting half way through left the
  // provider changed on a request that answered 400, which is a worse outcome
  // than either accepting or refusing the lot. Rejected rather than clamped
  // too: a number that silently becomes a different number is worse than being
  // told it was wrong.
  const keep = req.body?.keepRecentTokens;

  // The two live in different stores — the portal's database and pi's own
  // settings file — and there is no way to write both or neither. Committing
  // one and failing the other would answer with an error after half the change
  // had landed, so a request is not allowed to ask for both. Nothing sends
  // one: the sliders save on release, on their own, and Save defaults carries
  // only the fields above it.
  const wantsDefaults = ["provider", "model", "thinkingLevel"].some(
    (k) => typeof req.body?.[k] === "string",
  );
  if (keep !== undefined && wantsDefaults) {
    return res.status(400).json({
      error: "Save the session defaults and the compaction setting separately — they are stored in different files",
    });
  }

  let tokens: number | undefined;
  if (keep !== undefined) {
    tokens = Number(keep);
    if (!Number.isFinite(tokens) || tokens < 1000 || tokens > 500_000) {
      return res.status(400).json({ error: "Keep recent must be between 1,000 and 500,000 tokens" });
    }
    tokens = Math.round(tokens);
  }

  const settings = setSettings(patch);

  // Compaction lives in pi's file rather than the portal's, because pi is what
  // reads it.
  const compaction =
    tokens !== undefined
      ? await writeCompactionSettings({ keepRecentTokens: tokens })
      : readCompactionSettings();

  // The provider and model defaults apply to sessions started from here on,
  // which matches how the TUI treats a changed default. Compaction is pushed
  // into open sessions as well — the session you are looking at when you
  // change it is the one you meant it for.
  const refreshed = tokens !== undefined ? await sessions.refreshSettings() : 0;
  res.json({
    settings,
    compaction,
    refreshed,
    note:
      tokens !== undefined
        ? `Compaction applied to ${refreshed} open session${refreshed === 1 ? "" : "s"}. Model and effort apply to newly started sessions.`
        : "Applies to newly started sessions",
  });
});

// --- workspaces ---

/** Directories pi can be pointed at. Anything directly under WORKSPACE_ROOT. */
app.get("/api/workspaces", (_req, res) => {
  if (!existsSync(WORKSPACE_ROOT)) return res.json({ root: WORKSPACE_ROOT, workspaces: [] });
  const workspaces = readdirSync(WORKSPACE_ROOT)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(path.join(WORKSPACE_ROOT, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({
      name,
      path: path.join(WORKSPACE_ROOT, name),
      isGit: existsSync(path.join(WORKSPACE_ROOT, name, ".git")),
    }));
  res.json({ root: WORKSPACE_ROOT, workspaces });
});

// --- projects ---

const projectStatus = { invalid: 400, missing: 404, exists: 409, conflict: 409 } as const;

const projectFailure = (res: express.Response, e: unknown) => {
  if (e instanceof ProjectError) return res.status(projectStatus[e.code]).json({ error: e.message });
  res.status(500).json({ error: (e as Error).message });
};

/**
 * Chats that work in this folder, or in one below it — a chat may be started
 * in a subfolder, and it belongs to the project all the same.
 */
const chatsIn = (dir: string, all = listSessions()) =>
  all.filter((s) => isWithinText(dir, s.workspace));

/**
 * The same, and those that reach the folder through a link too: what deleting
 * it would take from under them. Each place is looked at once, since many
 * chats share one, and only this one project's are followed.
 */
function workingIn<T extends { workspace: string }>(dir: string, rows: T[]): T[] {
  const seen = new Map<string, boolean>();
  const reaches = insideReal(dir);
  return rows.filter((row) => {
    let inside = seen.get(row.workspace);
    if (inside === undefined) seen.set(row.workspace, (inside = reaches(row.workspace)));
    return inside;
  });
}

/**
 * The projects, each with how many chats it has and when one last moved — and
 * where Home is, so that the chats can be told apart by the folder they are in.
 * `?bare=1` leaves out the counts, which read every chat: the chat list asks
 * this every half minute only to know which folders there are.
 */
app.get("/api/projects", (req, res) => {
  const home = agentHomePath();
  // Each agent's home is a folder of chats of its own, named after the agent.
  const agents = listAgents().map((a) => ({ id: a.id, name: a.name, home: a.home }));
  try {
    if (!existsSync(WORKSPACE_ROOT)) return res.json({ root: WORKSPACE_ROOT, home, agents, projects: [] });
    if (req.query.bare === "1") {
      return res.json({ root: WORKSPACE_ROOT, home, agents, projects: listProjects(WORKSPACE_ROOT).map((p) => ({ name: p.name, path: p.path })) });
    }
    // Read once, not once per project.
    const all = listSessions();
    const withTools = projectsWithTools();
    const projects = listProjects(WORKSPACE_ROOT).map((p) => {
      const chats = chatsIn(p.path, all);
      return {
        ...p,
        hasTools: withTools.has(p.name),
        sessions: chats.length,
        lastActive: chats.reduce((latest, s) => (s.updated_at > latest ? s.updated_at : latest), "") || null,
      };
    });
    res.json({ root: WORKSPACE_ROOT, home, agents, projects });
  } catch (e) {
    projectFailure(res, e);
  }
});

/** Whether a request's list of tools to switch off is one: a list of names. */
const isToolList = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === "string");

/**
 * Stores what a project's chats start with, given the tools it wants off: the
 * difference from what the layers under it leave (the portal-wide default, and
 * an agent whose home it were in), which is all that is kept.
 */
function saveProjectTools(project: { name: string; path: string }, off: string[]) {
  const below = toolDefaultsFor(project.path, null, "project");
  return setProjectTools(project.name, layerExceptions(project.path, below, projectTools(project.name), off));
}

/**
 * `toolsOff`, when given, is the tools the new project's chats start with off,
 * as for PUT .../tools. It is checked before the folder is made, like the
 * instructions, so that a refusal leaves no project behind.
 */
app.post("/api/projects", (req, res) => {
  const { name, instructions, toolsOff } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) return res.status(400).json({ error: "name required" });
  if (instructions !== undefined && typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions must be text" });
  }
  if (toolsOff !== undefined) {
    if (!isToolList(toolsOff)) return res.status(400).json({ error: "toolsOff must be a list of tool names" });
    if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  }
  try {
    const project = createProject(WORKSPACE_ROOT, name, instructions);
    // A new project says nothing about tools: whatever an earlier folder of this
    // name left behind, such as one removed outside the portal, is not its.
    // The folder exists by now, and it stays whatever happens to its tools: the
    // project is made, only its tools are not. Said in the answer rather than as
    // a failure, so that the page can tell the two apart and offer them again.
    try {
      clearProjectTools(project.name);
      if (toolsOff !== undefined) saveProjectTools(project, toolsOff);
    } catch (e) {
      return res.json({ ...project, toolsError: (e as Error).message });
    }
    res.json(project);
  } catch (e) {
    projectFailure(res, e);
  }
});

/** What deleting a project would take with it, for the confirmation. */
app.get("/api/projects/:name", async (req, res) => {
  try {
    const project = getProject(WORKSPACE_ROOT, req.params.name);
    const unsaved = await unsavedWork(project.path);
    res.json({
      ...project,
      ...(unsaved ? { unsaved } : {}),
      sessions: workingIn(project.path, listSessions()).length,
      // The ones a delete would switch off: one already off is not changed by it.
      routines: routinesIn(project.path).filter((r) => r.enabled).map((r) => r.name),
      ...describeProject(WORKSPACE_ROOT, project.name),
    });
  } catch (e) {
    projectFailure(res, e);
  }
});

app.get("/api/projects/:name/instructions", (req, res) => {
  try {
    res.json(readInstructions(WORKSPACE_ROOT, req.params.name));
  } catch (e) {
    projectFailure(res, e);
  }
});

app.put("/api/projects/:name/instructions", (req, res) => {
  const { text, mtime } = req.body ?? {};
  if (typeof text !== "string") return res.status(400).json({ error: "text required" });
  if (mtime !== undefined && typeof mtime !== "number") return res.status(400).json({ error: "mtime must be a number" });
  try {
    writeInstructions(WORKSPACE_ROOT, req.params.name, text, mtime);
    res.json({ ok: true });
  } catch (e) {
    projectFailure(res, e);
  }
});

/**
 * The tools a chat in this project starts with, and whether each is on: what
 * the layers under it leave (layerTools), bent by what the project says. No pi
 * is running for a project, so what is listed is what the portal has seen
 * registered.
 */
app.get("/api/projects/:name/tools", (req, res) => {
  try {
    const project = getProject(WORKSPACE_ROOT, req.params.name);
    if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
    res.json(layerTools(project.path, toolDefaultsFor(project.path, null, "project"), projectTools(project.name)));
  } catch (e) {
    projectFailure(res, e);
  }
});

/**
 * Say which tools chats in this project start with: what is not named is on.
 * What is stored is the difference from the layers under it, as for a chat,
 * so a change to the default still reaches every tool the project never
 * disagreed about. Chats running in the project are told at once; what a chat
 * itself switched stays as it was.
 */
app.put("/api/projects/:name/tools", async (req, res) => {
  const off = req.body?.off;
  if (!isToolList(off)) return res.status(400).json({ error: "off must be a list of tool names" });
  try {
    const project = getProject(WORKSPACE_ROOT, req.params.name);
    if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
    const stored = saveProjectTools(project, off);
    const applied = await sessions.applyToolDefaults(project.name);
    res.json({ off: defaultsFor(toolDefaultsFor(project.path, null, "project"), stored), applied });
  } catch (e) {
    projectFailure(res, e);
  }
});

/**
 * A layer's tools as its page shows them: what the portal has seen registered
 * where the layer's chats and runs work (`folder`), on or off by `below` — every
 * layer under this one — bent by what this one says. `defaultOn` is what the
 * layers under it say, which is what this one disagrees with. Shaped like a
 * project's and a chat's, so the page draws them all the same way.
 */
function layerTools(folder: string, below: string[], exceptions: { off: string[]; on: string[] }) {
  const servers = mcpServerNames();
  return {
    tools: shownTools(folder).map((tool) => ({
      ...tool,
      source: toolSource(tool.name, tool.source, servers),
      enabled: toolEnabled(tool.name, below, exceptions),
      defaultOn: !below.includes(tool.name),
    })),
    live: false,
    names: toolGroupNames(),
    off: defaultsFor(below, exceptions),
  };
}

/** The exceptions to store for a layer, given what it wants off: as for a project. */
function layerExceptions(folder: string, below: string[], held: { off: string[]; on: string[] }, off: string[]) {
  const shown = shownTools(folder).map((t) => t.name);
  const answered = [...shown, ...held.off, ...held.on];
  return exceptionsFor(heldOffUnshown(off, shown, held), below, answered, held);
}

/**
 * An agent's tools: its exceptions to the portal-wide default, for every chat in
 * its home and every run it does on its own (its heartbeat, the routines that
 * run in its home). Its chats in a project are not in its home, and follow the
 * project.
 */
app.get("/api/agents/:id/tools", (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "No such agent" });
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  res.json(layerTools(agent.home, toolDefaultsFor(agent.home, null, "agent"), agentTools(agent.id)));
});

app.put("/api/agents/:id/tools", async (req, res) => {
  const off = req.body?.off;
  if (!isToolList(off)) return res.status(400).json({ error: "off must be a list of tool names" });
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "No such agent" });
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  try {
    const below = toolDefaultsFor(agent.home, null, "agent");
    const stored = setAgentTools(agent.id, layerExceptions(agent.home, below, agentTools(agent.id), off));
    const applied = await sessions.applyToolDefaults({ agent: agent.id });
    res.json({ off: defaultsFor(below, stored), applied });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/** A routine, and where its runs happen: its project, or Home. */
function routineFor(id: string): { slug: string; folder: string } | { slug: string; error: string } | undefined {
  const row = getDb().prepare("SELECT slug, workspace FROM routines WHERE id = ?").get(id) as { slug: string; workspace: string | null } | undefined;
  if (!row) return undefined;
  // Where its runs work, found as the supervisor finds it: the layers under the routine are that place's.
  const where = row.workspace ? checkWorkspace(row.workspace) : { path: agentHome() };
  return "error" in where ? { slug: row.slug, error: `Its project ${row.workspace} cannot be used (${where.error}).` } : { slug: row.slug, folder: where.path };
}

/**
 * A routine's tools: its exceptions to what its agent and project leave, for
 * every run of it. A run's own chat can still switch a tool for itself.
 */
app.get("/api/routines/:id/tools", (req, res) => {
  const routine = routineFor(req.params.id);
  if (!routine) return res.status(404).json({ error: "Not found" });
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  if ("error" in routine) return res.status(409).json({ error: routine.error });
  res.json(layerTools(routine.folder, toolDefaultsFor(routine.folder, null, "routine"), routineTools(routine.slug)));
});

app.put("/api/routines/:id/tools", async (req, res) => {
  const off = req.body?.off;
  if (!isToolList(off)) return res.status(400).json({ error: "off must be a list of tool names" });
  const routine = routineFor(req.params.id);
  if (!routine) return res.status(404).json({ error: "Not found" });
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  if ("error" in routine) return res.status(409).json({ error: routine.error });
  try {
    const below = toolDefaultsFor(routine.folder, null, "routine");
    const browser = seenBrowserTools();
    const wanted = layerExceptions(routine.folder, below, routineTools(routine.slug, browser), off);
    // The browser's tools its lists do not name follow its old switch (routineTools). So what the page said of each
    // is written down, even where the layers under it agree: left out, a browser switched on here would go back to
    // what the switch says.
    const shown = new Set(shownTools(routine.folder).map((t) => t.name));
    for (const name of browser) {
      if (!shown.has(name) || wanted.off.includes(name) || wanted.on.includes(name)) continue;
      (off.includes(name) ? wanted.off : wanted.on).push(name);
    }
    const stored = setRoutineTools(routine.slug, wanted);
    // And the switch says what a browser tool that turns up later starts with: what the browser has here now.
    if (browser.length) setRoutineBrowserSwitch(routine.slug, browser.some((name) => toolEnabled(name, below, stored)));
    const applied = await sessions.applyToolDefaults({ routine: routine.slug });
    res.json({ off: defaultsFor(below, stored), applied });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * The project, its chats and its folder. Refused while any chat or routine run
 * in it is working, and while its folder holds repositories — itself, submodules,
 * clones in subfolders — with work that only the folder has — uncommitted
 * changes, commits no remote has, stashes —
 * unless `?discard=1` says that is meant. Folders here can be repositories the
 * portal never made, and nothing brings one back.
 *
 * A routine that runs here keeps its sessions, the record of what it did, as
 * deleting the routine itself does. It is switched off once the folder is gone:
 * every run would fail there, until it is given another place.
 */
app.delete("/api/projects/:name", async (req, res) => {
  try {
    const project = getProject(WORKSPACE_ROOT, req.params.name);
    // First, before the checks below: git can take seconds, and a chat or a
    // routine may start in that time, which is what those checks are for. Not
    // asked at all once ?discard=1 says the answer does not matter.
    if (req.query.discard !== "1") {
      const unsaved = await unsavedWork(project.path);
      if (unsaved && holdsWork(unsaved)) return res.status(409).json(unsavedRefusal(unsaved));
    }
    const chats = workingIn(project.path, listSessions());
    if (chats.some((s) => sessions.isBusy(s.id) || sessions.backgroundWork(s.id))) {
      return res.status(409).json({ error: "A chat in this project is still working. Stop it first." });
    }
    const routines = routinesIn(project.path);
    // Only the ones with a process to stop, looked for among those first: a
    // routine that ran here every hour has a session for each run.
    const runs = workingIn(project.path, listRoutineSessions().filter((s) => sessions.isLoaded(s.id)));
    if (routines.some((r) => routineSupervisor.isRunning(r.slug)) || runs.some((s) => sessions.isBusy(s.id))) {
      return res.status(409).json({ error: "A routine is running in this project. Wait for it to finish, or stop it." });
    }
    // Held with nothing awaited since the check: from here no run of theirs can
    // start, by schedule or by hand, and have the folder removed from under it.
    const release = routineSupervisor.hold(routines.map((r) => r.slug));
    try {
      // In an order in which a failure leaves nothing half done. Stopping is
      // first and destroys nothing. The folder is next, the part most likely to
      // fail (a busy mount, a file that is not ours), and before anything that
      // cannot come back — the chats' transcripts — and before the routines are
      // switched off, which a project that stays would not want. The chats' rows
      // go last, together, so that either all are removed or none.
      for (const run of runs) await sessions.discard(run.id);
      for (const chat of chats) await sessions.discard(chat.id);
      // The jobs they started go with them: nothing would be left to list or stop them.
      const jobsStopped = await stopJobsIn(project.path);
      // A routine can have been given this place while those were stopped. It
      // was not held, so it is looked for again, with nothing awaited from here
      // until the folder is gone.
      const late = routinesIn(project.path).filter((r) => !routines.some((known) => known.id === r.id));
      if (late.some((r) => routineSupervisor.isRunning(r.slug))) {
        return res.status(409).json({ error: "A routine started running in this project meanwhile. Wait for it to finish, or stop it." });
      }
      deleteProjectFolder(WORKSPACE_ROOT, project.name);
      // The pictures of every chat that worked there, the routine runs the folder's removal leaves behind too: no file of them is left to show.
      forgetPicturesIn(project.path);
      clearProjectTools(project.name);
      const switchedOff = switchOffRoutines([...routines, ...late]);
      getDb().transaction(() => {
        for (const chat of chats) deleteSession(chat.id);
      })();
      for (const chat of chats) sessions.removeFiles(chat.id);
      res.json({ ok: true, sessionsDeleted: chats.length, routinesSwitchedOff: switchedOff, jobsStopped });
    } finally {
      // The chats that were not deleted take messages again.
      sessions.reopen([...runs, ...chats].map((s) => s.id));
      release();
    }
  } catch (e) {
    projectFailure(res, e);
  }
});

// --- agents ---

/**
 * The agent, its chats, and its folder if `?folder=delete` says so; kept
 * otherwise, and taken up again by an agent made under the same name. Refused
 * for the first agent, for one a channel talks as, and while any of its chats
 * or a routine running as it is working. Its routines are switched off, as a
 * deleted project's are, and keep their sessions; with `?folder=delete` they are
 * deleted, since the folder they ran in is gone.
 */
app.delete("/api/agents/:id", async (req, res) => {
  try {
    // Checked before anything is stopped; deleteAgent checks again once they are.
    const agent = deletable(req.params.id);
    // Its chats and its conversations — those started on the Agent page and
    // through channels — and the one its heartbeat looks around in.
    const chats = workingIn(agent.home, [...listSessions(), ...listAgentSessions(), ...listHeartbeatSessions()]);
    if (chats.some((s) => sessions.isBusy(s.id) || sessions.backgroundWork(s.id))) {
      return res.status(409).json({ error: "A chat with this agent is still working. Stop it first." });
    }
    if (heartbeat.isRunning(agent.id)) {
      return res.status(409).json({ error: "This agent is looking around right now. Wait for it to finish." });
    }
    const routines = routinesIn(agent.home);
    const runs = workingIn(agent.home, listRoutineSessions().filter((s) => sessions.isLoaded(s.id)));
    if (routines.some((r) => routineSupervisor.isRunning(r.slug)) || runs.some((s) => sessions.isBusy(s.id))) {
      return res.status(409).json({ error: "A routine is running as this agent. Wait for it to finish, or stop it." });
    }
    const release = routineSupervisor.hold(routines.map((r) => r.slug));
    try {
      for (const run of runs) await sessions.discard(run.id);
      for (const chat of chats) await sessions.discard(chat.id);
      // The jobs they started go with them, in a folder that is kept as well: nothing would be left to list or stop them.
      const jobsStopped = await stopJobsIn(agent.home);
      deleteAgent(agent.id, { deleteFolder: req.query.folder === "delete" });
      // What it said about tools: an agent made later under the same name starts from the default.
      clearAgentTools(agent.id);
      // The pictures of every chat that worked there, the routine runs the folder's removal leaves behind too: no file of them is left to show.
      if (req.query.folder === "delete") forgetPicturesIn(agent.home);
      deleteNotesOf(agent.id);
      // With its folder they have nowhere left to run, and an agent made under the
      // same name must not take them over. Kept with the folder, they stay, switched off.
      const deleted = req.query.folder === "delete";
      const switchedOff = deleted ? [] : switchOffRoutines(routines);
      const removed = deleted ? removeRoutines(routines) : [];
      getDb().transaction(() => {
        for (const chat of chats) deleteSession(chat.id);
      })();
      for (const chat of chats) sessions.removeFiles(chat.id);
      res.json({ ok: true, sessionsDeleted: chats.length, routinesSwitchedOff: switchedOff, routinesDeleted: removed, jobsStopped });
    } finally {
      sessions.reopen([...runs, ...chats].map((s) => s.id));
      release();
    }
  } catch (e) {
    res.status(e instanceof AgentError ? e.status : 500).json({ error: (e as Error).message });
  }
});

// --- sessions ---

/** The longest name a chat can be given: what the rename field takes. */
const MAX_TITLE = 120;

/**
 * A name as it is kept: on one line and no longer than the field allows, however
 * it came in — the rename field, /name, or a chat made through the API. By
 * character, so an emoji at the cut is not left in halves. Empty when there is
 * no name in it.
 */
const cleanTitle = (raw: unknown): string =>
  typeof raw === "string"
    ? Array.from(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_TITLE).join("").trimEnd()
    : "";

/** SQLite stores pinned as 0/1; the API speaks booleans. */
const toApi = (s: ReturnType<typeof getSession> & {}) => ({
  ...s,
  pinned: Boolean(s.pinned),
  live: sessions.isRunning(s.id),
  // The results flagged as a suspected prompt injection that the person trusted, for the chat to say so.
  trustedResults: [...trustedResults(s.id)],
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listChatSessions().map(toApi), executor: EXECUTOR_KIND });
});

/**
 * Conversations reached through a channel. Each is a real session — same
 * transcript, same replay, same model handling — so the Agent tab opens them
 * with the ordinary chat view rather than a parallel implementation.
 */
app.get("/api/agent/sessions", (req, res) => {
  // One agent's, given `?agent=`; the first agent's otherwise.
  const agent = typeof req.query.agent === "string" ? getAgent(req.query.agent) : defaultAgent();
  if (!agent) return res.status(404).json({ error: "No such agent" });
  const channels = getDb()
    .prepare("SELECT id, slug, name, kind FROM channels")
    .all() as { id: string; slug: string; name: string; kind: string }[];
  const bySlug = new Map(channels.map((c) => [c.slug, c]));

  res.json({
    agentHome: agent.home,
    sessions: chatsOf(agent, listAgentSessions()).map((s) => ({
      ...toApi(s),
      // Matched on the slug, so a channel deleted and recreated under the same
      // one still owns its conversations.
      channel: s.channel_slug
        ? {
            slug: s.channel_slug,
            name: bySlug.get(s.channel_slug)?.name ?? s.channel_slug,
            kind: bySlug.get(s.channel_slug)?.kind ?? null,
            present: bySlug.has(s.channel_slug),
          }
        : null,
    })),
  });
});

/**
 * A new agent conversation started from the browser.
 *
 * Not a channel: the portal's own UI is a better client than any channel could
 * be — it streams the transcript, shows tool calls and answers extension
 * dialogs — so it talks to the agent directly rather than relaying text.
 * "browser" is a reserved slug so these group together on the Agent tab.
 */
app.post("/api/agent/sessions", (req, res) => {
  const title = cleanTitle(req.body?.title);
  const agentId = req.body?.agent;
  if (agentId !== undefined && (typeof agentId !== "string" || !getAgent(agentId))) return res.status(404).json({ error: "No such agent" });
  try {
    const { session } = resolveChannelSession({
      channelSlug: BROWSER_CHANNEL,
      key: nanoid(8),
      title: title || `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      executor: EXECUTOR_KIND,
      agentId,
    });
    res.json(toApi(session));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- the agent's home directory ---

/**
 * The avatar voice mode shows for a chat (`?session=`): its agent's, and the
 * first agent's for a chat in a project, or without one.
 */
app.get("/api/agent/orb", (req, res) => {
  const session = typeof req.query.session === "string" ? getSession(req.query.session) : undefined;
  res.json(orbOf(agentOf(session?.workspace) ?? defaultAgent()));
});

app.post("/api/sessions", (req, res) => {
  const { workspace, agent: agentId } = req.body ?? {};
  const title = cleanTitle(req.body?.title);
  if (workspace !== undefined && (typeof workspace !== "string" || !workspace)) {
    return res.status(400).json({ error: "workspace must be a path" });
  }
  // `agent` starts it in that agent's home.
  const agent = agentId === undefined ? undefined : typeof agentId === "string" ? getAgent(agentId) : undefined;
  if (agentId !== undefined && !agent) return res.status(404).json({ error: "No such agent" });
  // Without either, a chat starts in Home: the first agent's own directory,
  // where its SOUL.md, PrimaryUser.md and MEMORY.md are. Agents' homes are the
  // only places outside the workspace root a chat may start.
  const where = agent ? { path: agentHome(agent.home) } : workspace === undefined ? { path: agentHome() } : checkWorkspace(workspace);
  if ("error" in where) return res.status(400).json({ error: where.error });
  const resolved = where.path;

  const id = nanoid(12);
  createSession({
    id,
    // Named after its first message once there is one; see the prompt route.
    title: title || NEW_CHAT_TITLE,
    workspace: resolved,
    executor: EXECUTOR_KIND,
    // Only a chat that was not given a name is named later.
    auto_title: title ? 0 : 1,
  });
  res.json(toApi(getSession(id)!));
});

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json(toApi(session));
});

app.patch("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { title, pinned } = req.body ?? {};
  // A name somebody chose stays, whatever it says — up to the length the field
  // allows, which /name and the API are held to as well.
  const name = cleanTitle(title);
  if (name) updateSession(session.id, { title: name, auto_title: 0 });
  if (typeof pinned === "boolean") updateSession(session.id, { pinned: pinned ? 1 : 0 });
  res.json(toApi(getSession(session.id)!));
});

app.delete("/api/sessions/:id", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    await sessions.discard(session.id);
    deleteSession(session.id);
  } catch (e) {
    // The chat stays: it takes messages again.
    sessions.reopen([session.id]);
    throw e;
  }
  sessions.removeFiles(session.id);
  res.json({ ok: true });
});

// --- prompting ---

app.post("/api/sessions/:id/prompt", promptJson, async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const message = req.body?.message ?? "";
  let parsed;
  try {
    parsed = parseImages(req.body?.images);
  } catch (e) {
    if (e instanceof ImageError) return res.status(400).json({ error: e.message });
    throw e;
  }
  // A picture on its own is a message too.
  if (typeof message !== "string" || (!message.trim() && !parsed.length)) {
    return res.status(400).json({ error: "message required" });
  }
  // Refused before they are saved: the browser puts them back in the box.
  const refused = parsed.length ? await picturesRefused(message) : undefined;
  if (refused) return res.status(400).json({ error: refused });
  try {
    const images = saveImages(IMAGE_ROOT, session.id, parsed);
    // Returns as soon as pi accepts the prompt. The run continues server-side
    // regardless of what this browser does next.
    const sent = await sessions.prompt(session.id, message, { voice: req.body?.voice === true, images, steer: req.body?.steer === true });
    // A Stop got there first: the words are back with the person, as not sent,
    // and a chat they were the start of is not named after them.
    if (!sent) return res.json({ ok: true, unsent: true });
    // A chat that has no name yet is named after what it starts with — once pi
    // has taken the message, so one that never got there does not keep its name.
    // Read again: a rename that came in meanwhile is not overwritten.
    const title = titleFrom(message);
    if (title && getSession(session.id)?.auto_title) updateSession(session.id, { title, auto_title: 0 });
    res.json({ ok: true, status: "running" });
  } catch (e) {
    // Sent, and failed where it is shown: on the command's line in the chat.
    // An error here as well was the same words in a banner, and the command
    // put back in the box.
    if (e instanceof CommandFailed) return res.json({ ok: true, failed: e.message });
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- editing the conversation ---

const editStatus = { busy: 409, missing: 404, empty: 400 } as const;

const editFailure = (res: express.Response, e: unknown) => {
  if (!(e instanceof SessionEditError)) return res.status(500).json({ error: (e as Error).message });
  res.status(editStatus[e.code as keyof typeof editStatus] ?? 422).json({ error: e.message });
};

/**
 * The person trusts a result the guard flagged as a suspected prompt injection
 * in this conversation: it no longer holds the conversation back. Removing the
 * turn it is in, the other way out, is the message removal below.
 */
app.post("/api/sessions/:id/flagged/:result/trust", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "No such conversation" });
  if (!/^[0-9a-f]{16}$/.test(req.params.result)) return res.status(400).json({ error: "That is not a flagged result" });
  trustFlagged(session.id, req.params.result);
  recordAudit({ kind: "trusted", reason: "You looked at a result flagged as a suspected prompt injection and trusted it", sessionId: session.id });
  res.json({ ok: true });
});

/** Removes a message and the agent's answer to it. */
app.delete("/api/sessions/:id/messages/:seq", async (req, res) => {
  try {
    await sessions.removeMessage(req.params.id, Number(req.params.seq), "turn");
    res.json({ ok: true });
  } catch (e) {
    editFailure(res, e);
  }
});

/** Replaces a message: it and everything after it are dropped, and the new text is sent. */
app.post("/api/sessions/:id/messages/:seq/edit", async (req, res) => {
  const message = req.body?.message;
  // Empty is allowed here: a message that was only a picture is retried as one.
  // Whether it has one is for editMessage to say.
  if (typeof message !== "string") {
    return res.status(400).json({ error: "message required" });
  }
  try {
    await sessions.editMessage(req.params.id, Number(req.params.seq), message);
    res.json({ ok: true, status: "running" });
  } catch (e) {
    editFailure(res, e);
  }
});

/** Shows another version of a message, and what followed it then. */
app.post("/api/sessions/:id/messages/:seq/version", async (req, res) => {
  const to = Number(req.body?.to);
  if (!Number.isInteger(to) || to <= 0) return res.status(400).json({ error: "to required" });
  try {
    await sessions.switchVersion(req.params.id, Number(req.params.seq), to);
    res.json({ ok: true });
  } catch (e) {
    editFailure(res, e);
  }
});

/** A picture sent with a message, for the transcript to show. */
app.get("/api/sessions/:id/images/:name", (req, res) => {
  // A chat that is gone serves no pictures, whatever a removal that failed left behind.
  const file = getSession(req.params.id) ? imagePath(IMAGE_ROOT, req.params.id, req.params.name) : undefined;
  if (!file) return res.status(404).json({ error: "Not found" });
  // Named by a random id and never rewritten, so it can be kept as long as a
  // browser likes. The type is the one its bytes were checked against.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(mimeOf(req.params.name)!);
  // The name was checked and the file looked at above, so a dot folder further up
  // (`~/.local/share`) is no reason for Express to treat it as hidden and answer 404.
  res.sendFile(file, { dotfiles: "allow" });
});

/** The browser answering a dialog an extension is waiting on. */
app.post("/api/sessions/:id/ui-response", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { id, value, cancelled } = req.body ?? {};
  if (typeof id !== "string") return res.status(400).json({ error: "id required" });
  const delivered = sessions.respondUi(session.id, id, { value, cancelled: Boolean(cancelled) });
  res.json({ ok: delivered, note: delivered ? undefined : "Request already resolved or expired" });
});

/** What is in the chat box, which an extension can ask for. Kept by the portal; starts nothing. */
app.put("/api/sessions/:id/draft", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { text, caret } = req.body ?? {};
  if (typeof text !== "string") return res.status(400).json({ error: "text required" });
  const at = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= text.length ? (n as number) : undefined);
  const start = at(caret?.start);
  const end = at(caret?.end);
  sessions.setDraft(session.id, text, start !== undefined && end !== undefined && start <= end ? { start, end } : undefined);
  res.json({ ok: true });
});

/**
 * A container session reaches pi over RPC, which has no tool registry to ask
 * and nothing to tell. Said plainly rather than answered with an empty list
 * and a switch that does nothing.
 */
const TOOLS_UNSUPPORTED =
  "Tools cannot be switched with EXECUTOR=container: pi runs inside the container and the portal never sees what it registered";
/** With a `code`, so that the page tells this answer from any other failure of the same request by it, not by the sentence. */
const toolsUnsupported = { error: TOOLS_UNSUPPORTED, code: "tools-unsupported" };

/**
 * The tools this conversation could use, and which of them are on.
 *
 * A running session answers from pi's registry. One that is not running —
 * not started yet, or gone idle — from what the portal has seen registered,
 * marked `live: false`: what is switched there is kept for when it starts.
 */
app.get("/api/sessions/:id/tools", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  const { tools, live } = await sessions.getTools(session.id);
  const names = toolGroupNames();
  // The whole off list, not only the tools loaded right now: the page sends
  // this back on the next flip, and anything missing from it would read as
  // "switch that one on again".
  res.json({ tools, live, names, off: sessions.offFor(session.id) });
});

/** Switch tools off for this conversation. Everything not named is on. */
app.put("/api/sessions/:id/tools", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  const off = req.body?.off;
  if (!isToolList(off)) return res.status(400).json({ error: "off must be a list of tool names" });
  res.json({ off: await sessions.setTools(session.id, off) });
});

/**
 * Tools the portal has ever seen registered, and whether each is on by default.
 *
 * Remembered rather than asked, so a default can be set without opening a
 * conversation: pi builds its registry when a session starts, and nobody
 * should have to start a chat to say that a tool should be off in all of them.
 */
app.get("/api/tools", (_req, res) => {
  // Refused here as well as on the PUT: a list of checkboxes that draws fine
  // and answers every flip with an error is the switch that looks like it works.
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  const off = new Set(toolDefaultsOff());
  const servers = mcpServerNames();
  res.json({
    tools: shownTools().map((tool) => ({
      ...tool,
      source: toolSource(tool.name, tool.source, servers),
      defaultOn: !off.has(tool.name),
    })),
    off: [...off].sort(),
    names: toolGroupNames(),
  });
});

/** What each package is called here. Everything not named keeps its own name. */
app.get("/api/tool-names", (_req, res) => res.json({ names: toolGroupNames() }));

app.put("/api/tool-names", (req, res) => {
  const names = req.body?.names;
  if (!names || typeof names !== "object" || Array.isArray(names)) {
    return res.status(400).json({ error: "names must be an object" });
  }
  res.json({ names: setToolGroupNames(names as Record<string, unknown>) });
});

/**
 * Which tools are off unless a conversation says otherwise.
 *
 * Applied to the conversations running right now as well: a default that only
 * meant anything to chats started afterwards would be a setting you could not
 * see working.
 */
app.put("/api/tools", async (req, res) => {
  if (EXECUTOR_KIND === "container") return res.status(400).json(toolsUnsupported);
  const off = req.body?.off;
  if (!isToolList(off)) return res.status(400).json({ error: "off must be a list of tool names" });
  const stored = setToolDefaultsOff(off);
  const applied = await sessions.applyToolDefaults();
  res.json({ off: stored, applied });
});

app.post("/api/sessions/:id/abort", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.abort(session.id);
  res.json({ ok: true });
});

// --- what runs beside the conversation: background jobs, extension status, subagents ---

app.get("/api/sessions/:id/background", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const jobs = BACKGROUND_SUPPORTED ? await listJobs(session.workspace, sessions.callsRunning(session.id)) : [];
  // piRunning: whether an extension could ask what is in the chat box — the page
  // tells the portal only then.
  res.json({ supported: BACKGROUND_SUPPORTED, jobs, ...sessions.extensionState(session.id), piRunning: sessions.isLoaded(session.id) });
});

app.get("/api/sessions/:id/background/:key/output", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const from = req.query.from === undefined ? undefined : Number(req.query.from);
  const out = await readOutput(session.workspace, req.params.key, Number.isFinite(from) ? from : undefined);
  if (!out) return res.status(404).json({ error: "This job's output is not in a file the portal can follow" });
  res.json(out);
});

app.post("/api/sessions/:id/background/:key/stop", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (!(await stopJob(session.workspace, req.params.key))) {
    return res.status(409).json({ error: "That job is not running any more" });
  }
  res.json({ ok: true });
});

app.post("/api/sessions/:id/background/clear", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  clearFinished(session.workspace);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/subagents/:agent/input", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "Nothing to send" });
  if (!sessions.subagentInput(session.id, req.params.agent, text)) {
    return res.status(409).json({ error: "The subagent cannot be reached: it is not running any more, or the chat is not running here" });
  }
  res.json({ ok: true });
});

app.post("/api/sessions/:id/subagents/:agent/stop", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (!sessions.subagentStop(session.id, req.params.agent)) {
    return res.status(409).json({ error: "The subagent cannot be reached: it is not running any more, or the chat is not running here" });
  }
  res.json({ ok: true });
});

// --- per-session config (the web equivalent of the TUI's slash commands) ---

/**
 * Why the window cannot be changed, when it cannot. With EXECUTOR=container pi
 * runs in the container behind an RPC client, and the model it measures against
 * is out of the portal's reach — so a value stored here would change nothing
 * while the pill claimed it had.
 */
const CONTEXT_UNSUPPORTED =
  "The context window cannot be changed with EXECUTOR=container: pi runs inside the container, where the portal has no hold on its model";

/**
 * The model a chat's row names, as it is now — what the page looks a chat's
 * levels up by before anything has answered. A row naming none follows the
 * default: the page keeps what it learns for such a chat under what the row
 * names, for the next like it to draw first. Its own copy of the row still
 * named none just after a model was picked, and kept the picked one's levels
 * as the default's.
 */
const named = (session: { provider: string | null; model: string | null }) => ({ provider: session.provider, model: session.model });

/**
 * A running chat's config, with what its row names — read after pi has
 * answered, and said only when pi is on the model the row comes to now. The
 * row read before could be older than the model pi reports: one picked while
 * pi was starting, and the page kept its levels as the default's. So could
 * the default, changed in Settings while this chat's pi still ran the last.
 */
async function liveAnswer(id: string) {
  const config = await liveConfig(await sessions.client(id));
  const row = getSession(id);
  if (!row) return config;
  const want = chatModel(row);
  const on = config.state.model;
  return on.provider === want.provider && on.id === want.model ? { ...config, named: named(row) } : config;
}

/** Everything the pills under the composer show, from a running pi. */
async function liveConfig(client: Awaited<ReturnType<typeof sessions.client>>) {
  const [state, levels, models, stats] = await Promise.all([
    client.getState(),
    client.getThinkingLevels(),
    client.getModels(),
    client.getStats(),
  ]);
  // A window is kept per model, so it needs one: pi reports "unknown" when none
  // is selected, and a number stored against that would never be read by anything.
  const noModel = state.model.id === "unknown" || state.model.provider === "unknown";
  const supported = typeof client.applyContextLimit === "function" && !noModel;
  return {
    live: true,
    state,
    thinking: { levels },
    models: { models },
    stats,
    contextLimit: noModel ? null : (getContextLimit(state.model.provider, state.model.id) ?? null),
    contextDefault: getDefaultContextLimit() ?? null,
    contextLimitSupported: supported,
    ...(supported
      ? {}
      : {
          contextLimitNote: noModel
            ? "Choose a model first: the context window is kept per model."
            : "The context window is the one in the model's entry: with the container executor it cannot be changed here.",
        }),
  };
}

app.get("/api/sessions/:id/config", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });

  // Deliberately does not start pi. Opening a session used to boot a model
  // runtime just to draw the pills under the composer — around 600ms for
  // whichever session got there first, before anything had been asked of it.
  // The stored model and effort are what those pills need, and they are right
  // here on the row.
  if (!sessions.isRunning(session.id)) {
    const defaults = getSettings();
    // What pi would be started on: the same halves, from the same places.
    const { provider, model } = chatModel(session, defaults);
    // From pi's catalogue, which is kept outside any conversation: a page
    // that had never seen the model otherwise drew the full slider until
    // the chat was next run.
    const levels = await modelLevels(provider, model);
    const asked = session.thinking_level || defaults.thinkingLevel;
    return res.json({
      live: false,
      state: {
        model: {
          id: model || "default",
          name: model || "pi's default",
          provider,
        },
        // The one pi would start on: a level the model does not offer is
        // moved to the nearest it does, and the pill named one the slider
        // could not show.
        thinkingLevel: levels.length ? clampLevel(levels, asked) : asked,
      },
      // Unknowable without the session open, and a made-up zero reads as
      // "empty context" rather than "not measured yet".
      stats: null,
      thinking: { levels },
      models: { models: [] },
      named: named(session),
    });
  }

  try {
    res.json(await liveAnswer(session.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Only the token and context figures, for keeping the pill current during a run.
 *
 * Not the config: that asks for the model catalogue too, and pi works the
 * catalogue out afresh on every request — a check of each provider's
 * credentials — which is too much to do after every turn of a long run.
 */
app.get("/api/sessions/:id/stats", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  if (!sessions.isRunning(session.id)) return res.json({ live: false, stats: null });
  try {
    res.json({ live: true, stats: await (await sessions.client(session.id)).getStats() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * The model catalogue and effort levels, which do need pi running.
 *
 * Split out so the cost lands when the picker is opened rather than on every
 * session you glance at.
 */
app.get("/api/sessions/:id/models", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    res.json(await liveAnswer(session.id));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions/:id/config", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const { provider, modelId, thinkingLevel, autoCompaction, autoRetry } = req.body ?? {};
  const applied: string[] = [];
  try {
    const client = await sessions.client(session.id);
    if (typeof modelId === "string" && modelId) {
      await client.setModel(provider || session.provider || getSettings().provider, modelId);
      applied.push("model");
    }
    if (typeof thinkingLevel === "string" && thinkingLevel) {
      await client.setThinkingLevel(thinkingLevel);
      applied.push("thinkingLevel");
    }
    if (typeof autoCompaction === "boolean") {
      await client.setAutoCompaction(autoCompaction);
      applied.push("autoCompaction");
    }
    if (typeof autoRetry === "boolean") {
      await client.setAutoRetry(autoRetry);
      applied.push("autoRetry");
    }
    const state = await client.getState();
    // Recorded so the choice survives a restart, not just this pi process.
    // Taken from the resolved state rather than the request: pi coerces the
    // thinking level on a non-reasoning model, and storing what was asked for
    // would reapply the rejected value on every relaunch.
    //
    // Only the fields actually changed are written. Persisting all of them on
    // any change meant that adjusting the effort while pi was sitting on a
    // fallback model wrote that fallback in as the session's chosen model.
    const patch: Parameters<typeof updateSession>[1] = {};
    if (applied.includes("model")) {
      patch.provider = state.model.provider;
      patch.model = state.model.id;
    }
    if (applied.includes("thinkingLevel")) patch.thinking_level = state.thinkingLevel;
    if (Object.keys(patch).length) updateSession(session.id, patch);

    res.json({ ok: true, applied, state });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, applied });
  }
});

/**
 * What a model's context window really is on this server — see getContextLimit.
 *
 * Its own route, not part of a session's config: the number belongs to the
 * model, so it holds for every chat that uses it, and it can be set before pi
 * has been started for the one you are looking at.
 */
app.put("/api/context-limit", (req, res) => {
  if (EXECUTOR_KIND === "container") return res.status(400).json({ error: CONTEXT_UNSUPPORTED });
  const { provider, model, tokens } = req.body ?? {};
  if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) {
    return res.status(400).json({ error: "provider and model required" });
  }
  // What pi reports for a session with no model, and not one that can be looked up.
  if (provider === "unknown" || model === "unknown") {
    return res.status(400).json({ error: "Choose a model first: the context window is kept per model" });
  }
  // Refused rather than rounded or clamped: a window quietly different from the
  // one typed would be found out when a chat overflowed.
  const problem = tokens === null ? undefined : contextLimitProblem(tokens);
  if (problem) return res.status(400).json({ error: problem });
  setContextLimit(provider, model, tokens);
  sessions.applyContextLimits();
  res.json({ ok: true, contextLimit: tokens });
});

/** The window every chat is held to unless its model has one of its own; a ceiling, see contextWindowFor. */
app.put("/api/context-default", (req, res) => {
  if (EXECUTOR_KIND === "container") return res.status(400).json({ error: CONTEXT_UNSUPPORTED });
  // Asked for outright, so that a request without it does not clear the setting.
  if (!req.body || !("tokens" in req.body)) return res.status(400).json({ error: "tokens required" });
  const tokens = req.body.tokens;
  const problem = tokens === null ? undefined : contextLimitProblem(tokens);
  if (problem) return res.status(400).json({ error: problem });
  setDefaultContextLimit(tokens);
  sessions.applyContextLimits();
  res.json({ ok: true, contextDefault: tokens });
});

app.post("/api/sessions/:id/compact", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  try {
    await sessions.compact(session.id);
    res.json({ ok: true });
  } catch (e) {
    // The message alone reaches the browser, and "Cannot read properties of
    // undefined" says nothing about where. The stack stays here.
    console.error(`[portal] compaction failed for ${session.id}:`, e);
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Commands available in this session: built-ins plus anything contributed by
 * installed packages. Discovered at runtime, so installing a package makes its
 * commands available immediately.
 */
app.get("/api/sessions/:id/commands", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  // Only if pi is up: a status line naming a command asks this way, and
  // asking must not start pi for a chat that has none.
  if (req.query.ifRunning && !sessions.isLoaded(session.id)) return res.json({ commands: [], notRunning: true });
  try {
    const client = await sessions.client(session.id);
    // Builtins first: they are the ones people reach for most.
    const [builtins, discovered] = await Promise.all([
      getBuiltinCommands(),
      client.getCommands(),
    ]);
    res.json({ commands: [...builtins, ...discovered] });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- pi packages (extensions, skills, prompts, themes) ---
app.use("/api", packagesRouter());
app.use("/api", extensionsRouter());
app.use("/api", featuresRouter());
app.use("/api", imagesRouter());
app.use("/api", memoryRouter());
app.use("/api", channelsRouter());
app.use("/api", agentsRouter());
app.use(
  "/api",
  routinesRouter((routine) => {
    sessions.applyToolDefaults({ routine }).catch((e) => console.error(`[portal] could not apply a routine's tools to its runs: ${(e as Error).message}`));
  })
);
app.use("/api", skillsRouter());
app.use("/api", filesRouter());
app.use("/api", gitRouter());
// What the configuration offers is what a running chat may use: told at once, as a default is.
onMcpWritten(() => {
  sessions.applyToolDefaults().catch((e) => console.error(`[portal] could not apply the MCP configuration to running chats: ${(e as Error).message}`));
});
app.use("/api", mcpRouter());
app.use("/api", providersRouter());
app.use("/api", peopleRouter());
app.use("/api", browserRouter());
app.use("/api", sandboxRouter(sessions));
app.use("/api", voiceRouter());
app.use("/api", terminalRouter());
app.use("/api", canvasesRouter());
// Before the SPA fallback, which answers everything that is not /api.
mountBrowserProxy(app);

// --- event stream ---

app.use("/api", eventsRouter());

/**
 * Anything under /api that no route took. Answered in JSON, like every other
 * API reply — Express's own page is HTML, and the page could only show
 * "HTTP 404" for it, not which address was wrong.
 */
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl.split("?")[0]}` });
});

// --- static web UI ---

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(portalSecurityHeaders);
  serveWeb(app, webDist);
}

/**
 * What a route did not catch, in JSON with its message.
 *
 * Express answers a thrown error, and a body it could not read, with an HTML
 * page, and all the page could make of that was "HTTP 500" or "HTTP 413". A
 * body that is too big or not JSON is said in words; the rest keeps its own
 * message, as the routes' own catches already give it.
 */
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  // Half an answer is already on its way — an event stream, a download.
  if (res.headersSent) return next(err);
  const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
  const status = Number(e.status ?? e.statusCode) || 500;
  const error =
    e.type === "entity.too.large"
      ? PROMPT_ROUTE.test(req.path)
        ? "The message and its pictures are more than the server takes in one go"
        : "That is more than the server takes in one request"
      : e.type === "entity.parse.failed"
        ? "The request was not valid JSON"
        : e.message || "Something went wrong on the server";
  if (status >= 500) console.error(`[portal] ${req.method} ${req.path} failed:`, err);
  res.status(status).json({ error });
});

// On PATH via the image, but a volume that predates it has no such directory —
// docker only seeds a volume that is empty, so an existing deploy would carry a
// PATH entry pointing at nothing.
mkdirSync(BIN_DIR, { recursive: true });

/**
 * TLS when a certificate is supplied, plain HTTP otherwise.
 *
 * Optional because most deployments sit on a LAN or a tailnet and do not want
 * to think about certificates. Needed for the embedded browser, which refuses
 * to run unless every page above it is a secure context.
 */
const tlsAt = tlsFiles();
const tls =
  tlsAt
    ? { cert: readFileSync(tlsAt.cert), key: readFileSync(tlsAt.key) }
    : null;

const host = bindHost(process.env.PORTAL_PASSWORD, process.env.ALLOW_OPEN);
// Before anything can start a run: a catch-up routine marked running in the same
// moment would be taken for one the last server left.
const cutOff = sessions.recoverOrphans();
const server = (tls ? createHttpsServer(tls, app) : createHttpServer(app)).listen(
  PORT,
  host,
  () => {
  console.log(`pithagoras listening on :${PORT}${tls ? " (https)" : ""}`);
  console.log(`  local bin: ${BIN_DIR}`);
  console.log(`  executor: ${EXECUTOR_KIND}`);
  console.log(`  workspaces: ${WORKSPACE_ROOT}`);
  console.log(`  auth:     ${authEnabled ? "password" : "DISABLED"}`);

  // Recurring schedules wait for their next slot; overdue one-off routines catch up.
  routineSupervisor.start();
  // Agents with a heartbeat look around on their own, when nothing else is using the model.
  heartbeat.start();

  // pi's catalogue, built now rather than when the first chat is opened:
  // that chat's effort pill waits for it to say which levels its model has.
  // Not for the container executor, whose pi runs inside the container: here
  // it would load every extension's code on the host for no chat.
  if (EXECUTOR_KIND !== "container") {
    modelRuntime().catch((e) => console.error(`[portal] pi's model catalogue could not be built: ${(e as Error).message}`));
  }

  // Enabled channels come up with the server, so a restart does not silently
  // leave the agent unreachable.
  channelSupervisor
    .sync()
    .then(() => console.log(`  channels: ${channelSupervisor.summary()}`))
    // Once they are up: the person whose request the restart cut off is told.
    .then(() => channelSupervisor.tellRestart(cutOff))
    .catch((e) => console.error(`[portal] channel startup failed: ${e.message}`));
  }
);

// Said in a line, not a stack trace: a port in use, one below 1024 without the
// right, an address this machine does not have. Only while it is starting; what
// goes wrong once it is up is not about where it listens.
const cannotListen = (e: Error) => {
  console.error(`pithagoras could not listen on ${host}:${PORT}: ${e.message}`);
  process.exit(1);
};
server.once("error", cannotListen);
server.once("listening", () => server.off("error", cannotListen));
attachBrowserUpgrade(server);
// Keeps the agent's browser rendering when nobody has the panel open.
watchBrowserFrames();
// Reports how far llama.cpp has got through a prompt, which is otherwise a
// silent minute or two before the first token.
startLlamaProxy(
  (sessionId, prefill) => sessions.reportPrefill(sessionId, prefill),
  (sessionId, load) => sessions.reportModelLoad(sessionId, load),
  (sessionId, timings) => sessions.reportTimings(sessionId, timings),
);
sessions.startReaper();
// Folders put aside for removal that a stop cut short: see folder-removal.ts.
sweepRemoved(WORKSPACE_ROOT);
sweepRemoved(agentsRoot());
interruptCanvasWrites();
pinConnection();
adoptPortalBrowser();
// The sandbox's sudo rules live outside the data volume, so a new container needs them put back.
void applyOnStart(sandboxPolicy(), sandboxSupport()).then((r) => {
  if (sandboxPolicy().enabled) console.log(`[sandbox] ${r.ok ? "on" : "not applied"}${r.warnings.length ? `: ${r.warnings.join("; ")}` : ""}`);
});
// The memory tidied up at its set time, when the portal runs Understory.
scheduleDreams();

/**
 * The stop is one, however many signals ask for it: a second Ctrl-C does, and so
 * does a package that ends its own children on SIGTERM and raises the signal
 * again, as pi-lens does. A second run found the shells already taken out of the
 * list, had nothing to wait for, and ended the portal before the first run's two
 * seconds were up, with whatever the shells' jobs ignoring a hangup left running.
 */
let stopping: Promise<void> | undefined;
function shutdown(signal: string): Promise<void> {
  if (stopping) {
    console.log(`${signal} received — already stopping`);
    return stopping;
  }
  return (stopping = stop(signal));
}

async function stop(signal: string) {
  console.log(`${signal} received — stopping running sessions`);
  // However long the rest takes, and no longer than docker waits before it kills.
  setTimeout(() => process.exit(0), 10_000).unref();
  routineSupervisor.stop();
  // Alongside the rest: their shells are given a moment to wind down.
  const shells = endAllTerminals();
  await channelSupervisor.shutdown();
  await sessions.shutdown();
  await shells;
  server.close(() => process.exit(0));
  // Every open page holds an event stream that never ends by itself, and
  // close() waits for them — so a restart always sat out the full ten seconds
  // of the timer above.
  server.closeAllConnections();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
