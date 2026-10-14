import express, { type Router } from "express";
import { forgetPerson, getPerson, isOnlyPrimary, listPeople, rename, setRole, type Role } from "../people.js";
import { AUDIT_KEEP, addToolRule, clearAudit, deleteToolRule, getDb, listAudit, listToolRules } from "../db.js";
import { nanoid } from "nanoid";
import { runsAsPrimary } from "../pi/runs-as-primary.js";

/**
 * The roster.
 *
 * Everyone who has ever spoken to the agent, including the ones it turned away
 * — that is the point. A stranger's id is recorded so you can promote them from
 * a list, rather than having to go and find their id on the platform.
 */

const ROLES: Role[] = ["primary", "colleague", "guest", "unknown"];

const LAST_PRIMARY =
  "This is the only primary user. Without one, every channel lets anybody in with a primary user's rights " +
  "until another is named.";

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
    // The agent treats everybody as a stranger only once somebody is named its
    // primary user: with none, every channel lets anybody in, with the rights of
    // one. Taking the last away is allowed, but only when it was asked for as that.
    if (role !== undefined && role !== "primary" && isOnlyPrimary(key) && req.body?.force !== true) {
      return res.status(409).json({ error: `${LAST_PRIMARY} Send force: true to do it anyway.`, code: "last-primary" });
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
    else if (typeof name === "string") rename(key, name);
    res.json({ person: getPerson(key) });
  });

  /**
   * What the guard has been deciding.
   *
   * Names are joined in rather than stored, so renaming somebody in the roster
   * renames them through the history too — the log records who, not what they
   * were called that week.
   */
  router.get("/audit", (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), AUDIT_KEEP) : 200;
    const people = new Map(listPeople().map((p) => [p.key, p.name]));
    res.json({
      entries: listAudit(limit).map((e) => ({
        ...e,
        person_name: e.person_key ? (people.get(e.person_key) ?? e.person_key) : null,
      })),
    });
  });

  /**
   * Wipes the history, up to `?through=<id>` when given: the web sends the
   * newest entry it showed, so a decision recorded while the question was open
   * survives. A `through` that is not an id is refused rather than read as
   * "everything". The web asks first; here it is the caller's word.
   */
  router.delete("/audit", (req, res) => {
    const through = req.query.through;
    if (through !== undefined && !(typeof through === "string" && /^\d+$/.test(through))) {
      return res.status(400).json({ error: "through must be an entry id" });
    }
    res.json({ removed: clearAudit(through === undefined ? undefined : Number(through)) });
  });

  /** Exceptions: what a non-primary role is allowed to run despite the default. */
  router.get("/tool-rules", (_req, res) => {
    res.json({ rules: listToolRules() });
  });

  router.post("/tool-rules", (req, res) => {
    const { role, tool, pattern, note } = req.body ?? {};
    // "heartbeat" is an agent looking around on its own: see heartbeat.ts.
    if (!["colleague", "guest", "heartbeat", "all"].includes(role)) {
      return res.status(400).json({ error: "Role must be colleague, guest, heartbeat or all" });
    }
    if (typeof tool !== "string" || !/^[a-z_][a-z0-9_]*$/i.test(tool)) {
      return res.status(400).json({ error: "Tool must be a tool name, e.g. bash" });
    }
    // A rule for these would look like it worked and never apply: the guard keeps them from everybody who is not
    // the primary user, whatever is allowed, as they would run with the primary user's rights. A heartbeat's
    // rules are its own.
    const asPrimary = role === "heartbeat" ? undefined : runsAsPrimary(tool);
    if (asPrimary) {
      return res.status(400).json({ error: `A rule cannot allow ${tool}: ${asPrimary}` });
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
    if (isOnlyPrimary(req.params.key) && req.query.force !== "1") {
      return res.status(409).json({ error: `${LAST_PRIMARY} Add ?force=1 to do it anyway.`, code: "last-primary" });
    }
    forgetPerson(req.params.key);
    res.json({ ok: true });
  });

  return router;
}
