import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { nanoid } from "nanoid";
import {
  createSession,
  deleteSession,
  eventsBefore,
  eventsSince,
  replayStart,
  getSession,
  listAgentSessions,
  listSessions,
  updateSession,
} from "./db.js";
import { agentHome, resolveChannelSession } from "./agent.js";
import {
  agentFileStatus,
  runWizard,
  writeAgentFile,
  type WizardInput,
} from "./agent-setup.js";
import { sessions, EXECUTOR_KIND } from "./session-manager.js";
import { authEnabled, checkPassword, isAuthed, issueCookie, requireAuth } from "./auth.js";
import { packagesRouter } from "./api/packages.js";
import { extensionsRouter } from "./api/extensions.js";
import { channelsRouter } from "./api/channels.js";
import { routinesRouter } from "./api/routines.js";
import { skillsRouter } from "./api/skills.js";
import { mcpRouter } from "./api/mcp.js";
import { peopleRouter } from "./api/people.js";
import { browserRouter } from "./api/browser.js";
import { terminalRouter } from "./api/terminal.js";
import { attachBrowserUpgrade, mountBrowserProxy } from "./browser-proxy.js";
import { watchBrowserFrames } from "./extensions/browser-frames.js";
import { startLlamaProxy } from "./llama-progress.js";
import { pinConnection } from "./api/browser.js";
import { routineSupervisor } from "./routines/supervisor.js";
import { channelSupervisor } from "./channels/supervisor.js";
import { piSettingsPath } from "./pi-settings.js";
import { eventTime, getDb } from "./db.js";
import { getBuiltinCommands } from "./pi/builtins.js";
import { isValidSlug, slugify } from "./slug.js";
import { getSettingDefaults, getSettings, getStoredSettings, setSettings } from "./db.js";

// WORKSPACE_ROOT is the new name; WORKSPACE_ROOT still works for existing deploys.
const WORKSPACE_ROOT = path.resolve(
  process.env.WORKSPACE_ROOT || process.env.WORKSPACE_ROOT || "/workspaces"
);
const PORT = Number(process.env.PORT || 4100);
/**
 * How much of a long conversation a fresh page load replays.
 *
 * Small on purpose. Not a correctness limit — a reconnect with a cursor still
 * receives everything it missed, and older events are fetched on demand as you
 * scroll back. Replaying twenty thousand meant a refresh rendered the entire
 * history and then visibly scrolled through it.
 */
const REPLAY_EVENTS = 1_200;
/** Persistent place for CLIs, kept on PATH so pi and its tools can reach them. */
const BIN_DIR = path.resolve(process.env.BIN_DIR || "/data/bin");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// --- auth ---

app.get("/api/auth/status", (req, res) => {
  res.json({ authRequired: authEnabled, authed: isAuthed(req) });
});

app.post("/api/auth/login", (req, res) => {
  if (!authEnabled) return res.json({ ok: true });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: "Wrong password" });
  }
  issueCookie(res);
  res.json({ ok: true });
});

app.use("/api", requireAuth);

// --- global settings (defaults for every new session) ---

app.get("/api/settings", (_req, res) => {
  // `stored` and `defaults` are separated so the UI can show an empty field
  // with the inherited value as a placeholder, instead of pre-filling it and
  // turning the next Save into a permanent pin.
  res.json({
    settings: getSettings(),
    stored: getStoredSettings(),
    defaults: getSettingDefaults(),
    piSettingsPath: piSettingsPath(),
    executor: EXECUTOR_KIND,
    workspaceRoot: WORKSPACE_ROOT,
  });
});

app.put("/api/settings", (req, res) => {
  const { provider, model, thinkingLevel } = req.body ?? {};
  const patch: Record<string, string> = {};
  if (typeof provider === "string") patch.provider = provider.trim();
  if (typeof model === "string") patch.model = model.trim();
  if (typeof thinkingLevel === "string") patch.thinkingLevel = thinkingLevel.trim();
  const settings = setSettings(patch);
  // Existing sessions keep their own settings; this applies to sessions started
  // from here on, which matches how the TUI treats a changed default.
  res.json({ settings, note: "Applies to newly started sessions" });
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

app.post("/api/workspaces", (req, res) => {
  const raw = req.body?.name;
  if (typeof raw !== "string" || !raw.trim()) {
    return res.status(400).json({ error: "name required" });
  }
  // "Cool Project" becomes the directory "cool-project", and that same slug
  // becomes the session title — one name drives both.
  const name = slugify(raw);
  if (!isValidSlug(name)) {
    return res.status(400).json({ error: `"${raw}" does not produce a usable folder name` });
  }

  const target = path.join(WORKSPACE_ROOT, name);
  if (path.resolve(target) !== target || !target.startsWith(WORKSPACE_ROOT + path.sep)) {
    return res.status(400).json({ error: "Invalid workspace name" });
  }
  if (existsSync(target)) return res.status(409).json({ error: `Workspace "${name}" already exists` });

  try {
    mkdirSync(target, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
  res.json({ name, path: target, isGit: false });
});

// --- sessions ---

/** SQLite stores pinned as 0/1; the API speaks booleans. */
const toApi = (s: ReturnType<typeof getSession> & {}) => ({
  ...s,
  pinned: Boolean(s.pinned),
  live: sessions.isRunning(s.id),
});

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listSessions().map(toApi), executor: EXECUTOR_KIND });
});

/**
 * Conversations reached through a channel. Each is a real session — same
 * transcript, same replay, same model handling — so the Agent tab opens them
 * with the ordinary chat view rather than a parallel implementation.
 */
app.get("/api/agent/sessions", (_req, res) => {
  const channels = getDb()
    .prepare("SELECT id, slug, name, kind FROM channels")
    .all() as { id: string; slug: string; name: string; kind: string }[];
  const bySlug = new Map(channels.map((c) => [c.slug, c]));

  res.json({
    agentHome: agentHome(),
    sessions: listAgentSessions().map((s) => ({
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
  const title = typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim() : "";
  try {
    const { session } = resolveChannelSession({
      channelSlug: "browser",
      key: nanoid(8),
      title: title || `Chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      executor: EXECUTOR_KIND,
    });
    res.json(toApi(session));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- the agent's home directory ---

app.get("/api/agent/setup", (_req, res) => {
  res.json(agentFileStatus());
});

/** Run the wizard. Refuses to overwrite an existing MEMORY.md. */
app.post("/api/agent/setup", (req, res) => {
  const body = (req.body ?? {}) as WizardInput;
  if (typeof body.agentName !== "string" || !body.agentName.trim()) {
    return res.status(400).json({ error: "The agent needs a name" });
  }
  if (typeof body.userName !== "string" || !body.userName.trim()) {
    return res.status(400).json({ error: "Who is it working for?" });
  }
  try {
    runWizard(body);
    res.json(agentFileStatus());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.put("/api/agent/files/:name", (req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    writeAgentFile(req.params.name, content);
    res.json(agentFileStatus());
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/sessions", (req, res) => {
  const { title, workspace } = req.body ?? {};
  if (typeof workspace !== "string" || !workspace) {
    return res.status(400).json({ error: "workspace required" });
  }
  // Keep pi inside the mounted workspace area — no escaping to the rest of the FS.
  const resolved = path.resolve(workspace);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    return res.status(400).json({ error: "workspace must be inside the workspace root" });
  }
  if (!existsSync(resolved)) return res.status(400).json({ error: "workspace does not exist" });

  const id = nanoid(12);
  createSession({
    id,
    // Default the session name to the workspace folder name.
    title: (typeof title === "string" && title.trim()) || path.basename(resolved),
    workspace: resolved,
    executor: EXECUTOR_KIND,
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
  if (typeof title === "string" && title.trim()) updateSession(session.id, { title: title.trim() });
  if (typeof pinned === "boolean") updateSession(session.id, { pinned: pinned ? 1 : 0 });
  res.json(toApi(getSession(session.id)!));
});

app.delete("/api/sessions/:id", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.stop(session.id);
  deleteSession(session.id);
  res.json({ ok: true });
});

// --- prompting ---

app.post("/api/sessions/:id/prompt", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const message = req.body?.message;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message required" });
  }
  try {
    // Returns as soon as pi accepts the prompt. The run continues server-side
    // regardless of what this browser does next.
    await sessions.prompt(session.id, message);
    res.json({ ok: true, status: "running" });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
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

app.post("/api/sessions/:id/abort", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  await sessions.abort(session.id);
  res.json({ ok: true });
});

// --- per-session config (the web equivalent of the TUI's slash commands) ---

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
    return res.json({
      live: false,
      state: {
        model: {
          id: session.model || defaults.model || "default",
          name: session.model || defaults.model || "pi's default",
          provider: session.provider || defaults.provider,
        },
        thinkingLevel: session.thinking_level || defaults.thinkingLevel,
      },
      // Unknowable without the session open, and a made-up zero reads as
      // "empty context" rather than "not measured yet".
      stats: null,
      thinking: { levels: [] },
      models: { models: [] },
    });
  }

  try {
    const client = await sessions.client(session.id);
    const [state, levels, models, stats] = await Promise.all([
      client.getState(),
      client.getThinkingLevels(),
      client.getModels(),
      client.getStats(),
    ]);
    res.json({ live: true, state, thinking: { levels }, models: { models }, stats });
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
    const client = await sessions.client(session.id);
    const [state, levels, models, stats] = await Promise.all([
      client.getState(),
      client.getThinkingLevels(),
      client.getModels(),
      client.getStats(),
    ]);
    res.json({ live: true, state, thinking: { levels }, models: { models }, stats });
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
      await client.setModel(provider || getSettings().provider, modelId);
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
app.use("/api", channelsRouter());
app.use("/api", routinesRouter());
app.use("/api", skillsRouter());
app.use("/api", mcpRouter());
app.use("/api", peopleRouter());
app.use("/api", browserRouter());
app.use("/api", terminalRouter());
// Before the SPA fallback, which answers everything that is not /api.
mountBrowserProxy(app);

// --- event stream ---

/**
 * Replay-then-tail. The client passes the last seq it saw, so reconnecting
 * after minutes or days delivers exactly what was missed and then continues
 * live — no gap, no duplicates.
 */
/** What came before a cursor: the transcript scrolling back rather than forward. */
app.get("/api/sessions/:id/events/before", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });
  const before = Number(req.query.before ?? 0) || 0;
  const limit = Math.min(Number(req.query.limit) || 1200, 3000);
  const rows = eventsBefore(session.id, before, limit);
  res.json({
    events: rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      at: eventTime(r.created_at),
      payload: JSON.parse(r.payload),
    })),
    // Whether asking again would return anything, so the UI knows to stop.
    more: rows.length === limit,
  });
});

app.get("/api/sessions/:id/events", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Not found" });

  const since = Number(req.query.since ?? 0) || 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const write = (row: { seq: number; type: string; payload: string; created_at?: string }) => {
    res.write(`id: ${row.seq}\ndata: ${JSON.stringify({
      seq: row.seq,
      type: row.type,
      // What the activity line counts from, so a refresh mid-run still knows
      // how long the agent has been on this rather than starting from zero.
      at: eventTime(row.created_at),
      payload: JSON.parse(row.payload),
    })}\n\n`);
  };

  // A fresh load gets the end of the conversation, not the beginning. Replaying
  // from zero and stopping at the batch limit is how a long session came back
  // from a refresh showing its first few thousand events and nothing since —
  // the transcript ended mid-turn, on whatever the cap happened to land on.
  const cursor = since === 0 ? replayStart(session.id, REPLAY_EVENTS) : since;

  // Paged to the end rather than one batch: a reconnect after a long run has
  // more to catch up on than a single query returns, and stopping early loses
  // exactly the part it was reconnecting for.
  let lastSent = cursor;
  for (;;) {
    const batch = eventsSince(session.id, lastSent);
    if (!batch.length) break;
    for (const row of batch) {
      write(row);
      lastSent = row.seq;
    }
    if (batch.length < 5000) break;
  }
  res.write(`event: caught-up\ndata: ${JSON.stringify({ seq: lastSent })}\n\n`);

  const onEvent = (row: { seq: number; type: string; payload: string; created_at?: string }) => {
    // Live-only events carry a negative seq: deliver them, but never let one
    // move the replay cursor, or a reconnect would skip stored history.
    if (row.seq < 0) {
      write(row);
      return;
    }
    // Guard against double-sending anything the replay already covered.
    if (row.seq <= lastSent) return;
    lastSent = row.seq;
    write(row);
  };
  sessions.on(`session:${session.id}`, onEvent);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sessions.off(`session:${session.id}`, onEvent);
  });
});

// --- static web UI ---

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

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
const tlsCert = process.env.PORTAL_TLS_CERT;
const tlsKey = process.env.PORTAL_TLS_KEY;
const tls =
  tlsCert && tlsKey && existsSync(tlsCert) && existsSync(tlsKey)
    ? { cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }
    : null;

const server = (tls ? createHttpsServer(tls, app) : createHttpServer(app)).listen(
  PORT,
  "0.0.0.0",
  () => {
  console.log(`pithagoras listening on :${PORT}${tls ? " (https)" : ""}`);
  console.log(`  local bin: ${BIN_DIR}`);
  console.log(`  executor: ${EXECUTOR_KIND}`);
  console.log(`  workspaces: ${WORKSPACE_ROOT}`);
  console.log(`  auth:     ${authEnabled ? "password" : "DISABLED"}`);

  // Enabled channels come up with the server, so a restart does not silently
  // leave the agent unreachable.
  // Schedules resume with the server; a routine due while it was down does not
  // fire retroactively, it simply waits for its next slot.
  routineSupervisor.start();

  channelSupervisor
    .sync()
    .then(() => console.log(`  channels: ${channelSupervisor.summary()}`))
    .catch((e) => console.error(`[portal] channel startup failed: ${e.message}`));
  }
);

attachBrowserUpgrade(server);
// Keeps the agent's browser rendering when nobody has the panel open.
watchBrowserFrames();
// Reports how far llama.cpp has got through a prompt, which is otherwise a
// silent minute or two before the first token.
startLlamaProxy((sessionId, prefill) => sessions.reportPrefill(sessionId, prefill));
pinConnection();

async function shutdown(signal: string) {
  console.log(`${signal} received — stopping running sessions`);
  routineSupervisor.stop();
  await channelSupervisor.shutdown();
  await sessions.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
