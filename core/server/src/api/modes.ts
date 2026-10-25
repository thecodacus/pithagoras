import express, { type Router } from "express";
import { CUSTOM, STANDARD } from "../chat-modes.js";
import {
  chatSaid,
  createCustomMode,
  customMode,
  customModeTools,
  customModes,
  deleteCustomMode,
  getSession,
  modeOf,
  modesFor,
  recordAudit,
  setCustomModeTools,
  toolDefaultsOff,
  updateCustomMode,
  updateSession,
  type ChatModeRow,
} from "../db.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { SessionEditError } from "../pi/session-edit.js";
import { sessions } from "../session-manager.js";
import { isToolList, layerExceptions, layerTools, toolsUnsupported } from "../tool-layers.js";
import { defaultsFor, toolEnabled } from "../tool-policy.js";
import { CODEMODE_TOOL } from "../pi/codemode.js";

const STARTED = "This chat has started, and its mode is fixed: start a new chat for another one.";

/**
 * A chat's mode: the ones it may be put in, and putting it in one before it has said anything (see chat-modes.ts);
 * and the modes the person makes, in Settings → Modes.
 */
export function modesRouter(): Router {
  const router = express.Router();

  /** What the chat may be put in. Whether or not it has started: the header looks its stored mode up here. Never starts pi. */
  router.get("/sessions/:id/modes", (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json({
      modes: modesFor(session).map(({ id, label, description, confirm, extension }) => ({ id, label, description, ...(confirm ? { confirm } : {}), ...(extension ? { extension } : {}) })),
    });
  });

  /** Puts a chat that has said nothing yet in a mode; its pi, where one is up, is let go, to start again in it. */
  router.put("/sessions/:id/modes", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const offered = modesFor(session);
    if (!offered.length) {
      return res.status(409).json({ error: "Modes are for the chats you start on the portal's pages, where pi runs in the portal's own process." });
    }
    if (chatSaid(session.id) || sessions.isBusy(session.id)) return res.status(409).json({ error: STARTED });
    const mode = req.body?.mode;
    const entry = offered.find((one) => one.id === mode);
    if (!entry) return res.status(400).json({ error: `There is no mode "${String(mode)}" for this chat.` });
    // A mode that asks first is put only where the caller says the person said yes to its text.
    if (entry.confirm && req.body?.confirmed !== true) {
      return res.status(409).json({ error: "This mode asks first: send confirmed: true once the person has said yes to its text.", confirm: entry.confirm });
    }
    try {
      const done = await sessions.stopUnstarted(session.id, () => {
        // What the mode starts its chats on is written into the chat; leaving a mode for another before the chat has
        // said anything puts back what it wrote, unless the person changed it since.
        const before = modeOf(session.mode);
        const fields: Parameters<typeof updateSession>[1] = { mode: entry.id === STANDARD ? null : entry.id };
        if (entry.model) Object.assign(fields, { provider: entry.provider ?? null, model: entry.model });
        else if (before?.model && session.provider === (before.provider ?? null) && session.model === before.model) Object.assign(fields, { provider: null, model: null });
        if (entry.thinkingLevel) fields.thinking_level = entry.thinkingLevel;
        else if (before?.thinkingLevel && session.thinking_level === before.thinkingLevel) fields.thinking_level = null;
        updateSession(session.id, fields);
      });
      if (!done) return res.status(409).json({ error: STARTED });
    } catch (e) {
      // Held while an edit or a reload of its pi holds the chat: said as the edit routes say it.
      if (e instanceof SessionEditError) return res.status(409).json({ error: e.message });
      return res.status(500).json({ error: (e as Error).message });
    }
    if (entry.confirm) recordAudit({ kind: "mode", subject: entry.label, reason: entry.id, sessionId: session.id });
    res.json({ mode: entry.id });
  });

  // The modes the person made (Settings → Modes). Refused where tools cannot be switched, as every tool layer's
  // routes are: a mode is carried out where the portal starts a chat's pi.
  router.use("/chat-modes", (_req, res, next) => (EXECUTOR_KIND === "container" ? res.status(400).json(toolsUnsupported) : next()));

  router.get("/chat-modes", (_req, res) => res.json({ modes: customModes().map(modeToApi) }));

  router.post("/chat-modes", (req, res) => {
    const fields = modeFields({ label: req.body?.label ?? "", description: req.body?.description ?? "" });
    if ("error" in fields) return res.status(400).json(fields);
    res.json(modeToApi(createCustomMode({ label: fields.label!, description: fields.description! })));
  });

  /** Changes what a mode says. Its chats have its instructions at once, with its tools; see applyToolDefaults. */
  router.put("/chat-modes/:id", async (req, res) => {
    const id = req.params.id;
    if (!customMode(id)) return res.status(404).json({ error: "Not found" });
    const fields = modeFields(req.body ?? {});
    if ("error" in fields) return res.status(400).json(fields);
    const row = updateCustomMode(id, fields)!;
    await sessions.applyToolDefaults({ mode: CUSTOM + id });
    res.json(modeToApi(row));
  });

  /** Deletes a mode. Its chats keep it, shown as not available, and lose its tools and instructions at once. */
  router.delete("/chat-modes/:id", async (req, res) => {
    const id = req.params.id;
    if (!deleteCustomMode(id)) return res.status(404).json({ error: "Not found" });
    await sessions.applyToolDefaults({ mode: CUSTOM + id });
    res.json({ ok: true });
  });

  /**
   * A mode's tools, as Settings → Tools lists them: held against the portal-wide default. Its layer comes above a
   * chat's agent, project and routine, so a tool it leaves as the default is still theirs to decide.
   */
  router.get("/chat-modes/:id/tools", (req, res) => {
    const row = customMode(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const below = toolDefaultsOff();
    const tools = customModeTools(row.id);
    // The lazy marks as a chat in the mode shows them (see getTools): none where it works through the code tool.
    res.json(layerTools(undefined, below, tools, false, row.codemode === 1 && toolEnabled(CODEMODE_TOOL, below, tools)));
  });

  /** Says which tools the mode's chats start with: what is not named is on. Chats running in it are told at once. */
  router.put("/chat-modes/:id/tools", async (req, res) => {
    const off = req.body?.off;
    if (!isToolList(off)) return res.status(400).json({ error: "off must be a list of tool names" });
    const id = req.params.id;
    if (!customMode(id)) return res.status(404).json({ error: "Not found" });
    const below = toolDefaultsOff();
    const stored = setCustomModeTools(id, layerExceptions(undefined, below, customModeTools(id), off));
    const applied = await sessions.applyToolDefaults({ mode: CUSTOM + id });
    res.json({ off: defaultsFor(below, stored), applied });
  });

  return router;
}

/** A mode the person made, as the page sees it: `id` is what follows "custom/" on a chat in it. */
const modeToApi = (row: ChatModeRow) => ({
  id: row.id,
  label: row.label,
  description: row.description,
  codemode: row.codemode === 1,
  instructions: row.instructions,
  provider: row.provider,
  model: row.model,
  thinkingLevel: row.thinking_level,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const MAX_LABEL = 60;
const MAX_DESCRIPTION = 200;
const MAX_INSTRUCTIONS = 8000;

/** A line of a mode's, as it is kept: one line, each run of white space one space, and at most `max` characters. */
function line(raw: unknown, what: string, max: number): string | { error: string } {
  if (typeof raw !== "string" || /[\r\n]/.test(raw)) return { error: `${what} must be one line of text.` };
  const text = raw.replace(/\s+/g, " ").trim();
  return Array.from(text).length > max ? { error: `${what} can be at most ${max} characters.` } : text;
}

type ModeFields = NonNullable<Parameters<typeof updateCustomMode>[1]>;

/** What a request says of a mode, checked: the fields it names, as they are stored, or why it is refused. */
function modeFields(body: Record<string, unknown>): ModeFields | { error: string } {
  const fields: ModeFields = {};
  if (body.label !== undefined) {
    const label = line(body.label, "A mode's name", MAX_LABEL);
    if (typeof label !== "string") return label;
    if (!label) return { error: "A mode needs a name." };
    fields.label = label;
  }
  if (body.description !== undefined) {
    const description = line(body.description, "A mode's description", MAX_DESCRIPTION);
    if (typeof description !== "string") return description;
    fields.description = description;
  }
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") return { error: "A mode's instructions must be text." };
    const instructions = body.instructions.trim();
    if (Array.from(instructions).length > MAX_INSTRUCTIONS) return { error: `A mode's instructions can be at most ${MAX_INSTRUCTIONS} characters.` };
    fields.instructions = instructions;
  }
  if (body.codemode !== undefined) {
    if (typeof body.codemode !== "boolean") return { error: "codemode must be true or false." };
    fields.codemode = body.codemode ? 1 : 0;
  }
  // As Settings → Defaults takes them: empty is none, which leaves the chat as it would be.
  for (const [key, column] of [["provider", "provider"], ["model", "model"], ["thinkingLevel", "thinking_level"]] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") return { error: `${key} must be text or null.` };
    fields[column] = value?.trim() || null;
  }
  return fields;
}
