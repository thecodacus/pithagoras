import express, { type Router } from "express";
import { forgetPerson, getPerson, listPeople, setRole, type Role } from "../people.js";
import { addToolRule, deleteToolRule, getDb, listToolRules } from "../db.js";
import { nanoid } from "nanoid";

/**
 * The roster.
 *
 * Everyone who has ever spoken to the agent, including the ones it turned away
 * — that is the point. A stranger's id is recorded so you can promote them from
 * a list, rather than having to go and find their id on the platform.
 */

const ROLES: Role[] = ["primary", "colleague", "guest", "unknown"];

export function peopleRouter(): Router {
  const router = express.Router();

  router.get("/people", (_req, res) => {
    res.json({ people: listPeople() });
  });

  router.patch("/people/:key", (req, res) => {
    const key = req.params.key;
    if (!getPerson(key)) return res.status(404).json({ error: "Not found" });

    const { role, name, notes } = req.body ?? {};
    if (role !== undefined && !ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of ${ROLES.join(", ")}` });
    }
    // One primary. Promoting somebody demotes whoever held it, rather than
    // leaving two people the agent treats as its owner.
    if (role === "primary") {
      getDb().prepare("UPDATE people SET role = 'colleague' WHERE role = 'primary' AND key != ?").run(key);
    }
    if (typeof notes === "string") {
      getDb().prepare("UPDATE people SET notes = ? WHERE key = ?").run(notes.trim(), key);
    }
    if (role) setRole(key, role, typeof name === "string" ? name : undefined);
    else if (typeof name === "string" && name.trim()) {
      getDb().prepare("UPDATE people SET name = ? WHERE key = ?").run(name.trim(), key);
    }
    res.json({ person: getPerson(key) });
  });

  /** Exceptions: what a non-primary role is allowed to run despite the default. */
  router.get("/tool-rules", (_req, res) => {
    // Names come from the roster: a rule showing a raw key is a rule nobody can
    // decide about.
    const people = new Map(listPeople().map((p) => [p.key, p.name]));
    res.json({
      rules: listToolRules().map((r) => ({
        ...r,
        person_name: r.person_key ? (people.get(r.person_key) ?? r.person_key) : null,
      })),
    });
  });

  router.post("/tool-rules", (req, res) => {
    const { role, tool, pattern, note } = req.body ?? {};
    if (!["colleague", "guest", "all"].includes(role)) {
      return res.status(400).json({ error: "Role must be colleague, guest or all" });
    }
    if (typeof tool !== "string" || !/^[a-z_][a-z0-9_]*$/i.test(tool)) {
      return res.status(400).json({ error: "Tool must be a tool name, e.g. bash" });
    }
    if (typeof pattern !== "string" || !pattern.trim()) {
      return res.status(400).json({ error: "A pattern is required" });
    }
    // A bare "*" is not a rule, it is switching the whole thing off by accident.
    if (pattern.trim() === "*") {
      return res.status(400).json({
        error: "That allows everything — write the command you mean, with * only where it varies",
      });
    }
    addToolRule({
      id: nanoid(10),
      role,
      tool,
      pattern: pattern.trim(),
      note: typeof note === "string" ? note.trim() : "",
      person_key: typeof req.body?.personKey === "string" ? req.body.personKey : null,
    });
    res.json({ rules: listToolRules() });
  });

  router.delete("/tool-rules/:id", (req, res) => {
    deleteToolRule(req.params.id);
    res.json({ rules: listToolRules() });
  });

  /**
   * Forgetting somebody is not the same as blocking them: the next message
   * makes them unknown again, which is refused and announced. Blocking is what
   * "unknown" already does.
   */
  router.delete("/people/:key", (req, res) => {
    forgetPerson(req.params.key);
    res.json({ ok: true });
  });

  return router;
}
