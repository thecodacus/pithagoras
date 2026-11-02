import { lstatSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";
import { agentSkillsDir, listAgentSkills, readAgentSkill } from "../agent-skills.js";
import { AgentError, DEFAULT_AGENT, agentOf, channelsOf, createAgent, defaultAgent, getAgent, listAgents, newChatAgent, orbOf, renameAgent, setNewChatAgent, setOrb, setVoice, type Agent } from "../agents.js";
import { agentFileStatus, isInitialised, runWizard, writeAgentFile, type WizardInput } from "../agent-setup.js";
import { listAgentSessions, listSessions } from "../db.js";
import { deleteNote, listNotes, markNoteRead, markNotesRead, unreadNotes } from "../activity.js";
import { heartbeat, setHeartbeat, watchList } from "../heartbeat.js";
import { serverTimeZone } from "../time-zone.js";
import { EXECUTOR_KIND } from "../executor-kind.js";
import { FileError } from "../workspace-files.js";
import { CONTEXT_FILES } from "../pi/context-files.js";
import { fail } from "./files.js";
import { userFor } from "../sandbox/identity.js";
import { sourceVoices } from "./voice.js";

/**
 * The agents: listing them, making one, naming it, and its own files and setup.
 * Deleting one is in server.ts, beside deleting a project: both have to stop
 * the chats working there first.
 */

const failed = (res: express.Response, e: unknown) =>
  res.status(e instanceof AgentError ? e.status : 400).json({ error: (e as Error).message });

/** An agent as the page sees it: what it is, whether it is set up, and what uses it. */
export function agentToApi(a: Agent, chats = 0, newChats = newChatAgent().id === a.id) {
  return {
    id: a.id,
    name: a.name,
    home: a.home,
    sandboxUser: userFor(a.id),
    first: a.id === DEFAULT_AGENT,
    // Whether the New button starts its chats with it.
    newChats,
    initialised: isInitialised(a.home),
    chats,
    channels: channelsOf(a.id),
    orb: orbOf(a),
    voice: a.voice ?? "",
    heartbeat: {
      minutes: a.heartbeat_minutes ?? 0,
      quietStart: a.quiet_start ?? "",
      quietEnd: a.quiet_end ?? "",
      // What those hours are read on: the server's clock, which is UTC in a container unless TZ says otherwise.
      timeZone: serverTimeZone(),
      last: a.last_heartbeat,
      status: a.heartbeat_status,
      running: heartbeat.isRunning(a.id),
      // Whether there is anything to look at, and whether looks can happen here at all.
      watching: Boolean(watchList(a)),
      available: EXECUTOR_KIND === "host",
    },
    unread: unreadNotes(a.id),
  };
}

export function agentsRouter(): Router {
  const router = express.Router();

  router.get("/agents", (_req, res) => {
    // Read once, then counted per agent: every chat is read either way.
    const agents = listAgents();
    const counts = new Map<string, number>();
    for (const s of [...listSessions(), ...listAgentSessions()]) {
      // A child chat is part of its parent's work, not a chat of the agent's of its own.
      if (s.parent_id) continue;
      const a = agentOf(s.workspace, agents);
      if (a) counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
    }
    const picked = newChatAgent(agents).id;
    res.json({ agents: agents.map((a) => agentToApi(a, counts.get(a.id) ?? 0, a.id === picked)) });
  });

  /** A new agent, with its home. Given the wizard's answers, it is set up as well. */
  router.post("/agents", (req, res) => {
    try {
      const agent = createAgent({ name: req.body?.name });
      // `kept`: the agent's own files that its folder had already, as a folder kept from an agent of the same
      // name does. The new agent takes them up as its own, with or without the wizard, which does not replace them.
      // lstat, as the wizard does: a link that leads nowhere is something there.
      const kept = CONTEXT_FILES.filter((name) => lstatSync(path.join(agent.home, name), { throwIfNoEntry: false }));
      const wizard = req.body?.setup as WizardInput | undefined;
      if (wizard && typeof wizard === "object") runWizard({ ...wizard, agentName: wizard.agentName || agent.name }, agent.home);
      res.json({ ...agentToApi(agent), kept });
    } catch (e) {
      failed(res, e);
    }
  });

  router.patch("/agents/:id", (req, res) => {
    try {
      res.json(agentToApi(renameAgent(req.params.id, req.body?.name)));
    } catch (e) {
      failed(res, e);
    }
  });

  const agentOr404 = (id: string, res: express.Response) => {
    const agent = getAgent(id);
    if (!agent) res.status(404).json({ error: "No such agent" });
    return agent;
  };

  /** `{ on }`: whether the New button starts a chat with it. Off hands that back to the first agent. */
  router.put("/agents/:id/new-chats", (req, res) => {
    try {
      const on = req.body?.on;
      if (typeof on !== "boolean") return res.status(400).json({ error: "on must be a boolean" });
      const off = !on;
      // Off only matters for the agent that has it: another's pick stays.
      if (!off || newChatAgent().id === req.params.id) setNewChatAgent(off ? DEFAULT_AGENT : req.params.id);
      else if (!getAgent(req.params.id)) throw new AgentError("No such agent", 404);
      res.json(agentToApi(getAgent(req.params.id)!));
    } catch (e) {
      failed(res, e);
    }
  });

  /** Its avatar: the voice-mode orb's look and personality, the same on every device. */
  router.put("/agents/:id/orb", (req, res) => {
    try {
      res.json(setOrb(req.params.id, req.body));
    } catch (e) {
      failed(res, e);
    }
  });

  /** `{ voice }`: an id from the voices voice mode's source offers, or "" for its own choice. */
  router.put("/agents/:id/voice", (req, res) => {
    try {
      res.json(agentToApi(setVoice(req.params.id, req.body?.voice, sourceVoices()?.map((v) => v.id))));
    } catch (e) {
      failed(res, e);
    }
  });

  /** `{ minutes, quietStart, quietEnd }`: how often it looks around on its own; 0 never. */
  router.put("/agents/:id/heartbeat", (req, res) => {
    try {
      res.json(agentToApi(setHeartbeat(req.params.id, req.body ?? {})));
    } catch (e) {
      failed(res, e);
    }
  });

  /** A look now, whatever the interval says. Answers at once; the page follows the status. */
  router.post("/agents/:id/heartbeat/run", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    if (heartbeat.isRunning(agent.id)) return res.status(409).json({ error: `${agent.name} is already looking` });
    // As a look on its schedule waits: the model is one, and a chat or another look has it.
    if (heartbeat.isBusy()) return res.status(409).json({ error: "A chat, a routine or another agent's look is using the model. Try again when it is done." });
    void heartbeat.run(agent, "manual").catch(() => {});
    res.json(agentToApi(getAgent(agent.id)!));
  });

  router.get("/agents/:id/activity", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) res.json({ notes: listNotes(agent.id), unread: unreadNotes(agent.id) });
  });

  router.post("/agents/:id/activity/read", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    markNotesRead(agent.id);
    res.json({ unread: 0 });
  });

  router.post("/agents/:id/activity/:note/read", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    if (!markNoteRead(agent.id, req.params.note)) return res.status(404).json({ error: "No such note" });
    res.json({ unread: unreadNotes(agent.id) });
  });

  router.delete("/agents/:id/activity/:note", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    if (!deleteNote(agent.id, req.params.note)) return res.status(404).json({ error: "No such note" });
    res.json({ ok: true });
  });

  /** The skills the agent wrote for itself, for its Skills tab. */
  router.get("/agents/:id/skills", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) res.json({ folder: agentSkillsDir(agent), skills: listAgentSkills(agent) });
  });

  router.get("/agents/:id/skills/:skill", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (!agent) return;
    const content = readAgentSkill(agent, req.params.skill);
    if (content === null) return res.status(404).json({ error: "No such skill" });
    res.json({ content });
  });

  router.get("/agents/:id/setup", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) res.json(agentFileStatus(agent.home));
  });

  const setUp = (agent: Agent, req: express.Request, res: express.Response) => {
    const body = (req.body ?? {}) as WizardInput;
    if (typeof body.agentName !== "string" || !body.agentName.trim()) return res.status(400).json({ error: "The agent needs a name" });
    if (typeof body.userName !== "string" || !body.userName.trim()) return res.status(400).json({ error: "Who is it working for?" });
    try {
      const { kept } = runWizard(body, agent.home);
      res.json({ ...agentFileStatus(agent.home), kept });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  };

  const saveFile = (agent: Agent, name: string, req: express.Request, res: express.Response) => {
    const { content, mtime } = req.body ?? {};
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    if (mtime !== undefined && typeof mtime !== "number") return res.status(400).json({ error: "mtime must be a number" });
    try {
      writeAgentFile(name, content, agent.home, mtime);
      res.json(agentFileStatus(agent.home));
    } catch (e) {
      if (e instanceof FileError) return fail(res, e);
      res.status(400).json({ error: (e as Error).message });
    }
  };

  /** The setup wizard, for this agent's home. Writes the files that are not there and leaves the others, `kept` in the answer. */
  router.post("/agents/:id/setup", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) setUp(agent, req, res);
  });

  /** `{ content, mtime }`: `mtime` is the file's as the page read it; a file the agent has written since is not overwritten (409). */
  router.put("/agents/:id/files/:name", (req, res) => {
    const agent = agentOr404(req.params.id, res);
    if (agent) saveFile(agent, req.params.name, req, res);
  });

  // The first agent's, at the addresses from before there were several: the same handlers, so the same answers.
  router.get("/agent/setup", (_req, res) => res.json(agentFileStatus(defaultAgent().home)));
  router.post("/agent/setup", (req, res) => setUp(defaultAgent(), req, res));
  router.put("/agent/files/:name", (req, res) => saveFile(defaultAgent(), req.params.name, req, res));

  return router;
}
