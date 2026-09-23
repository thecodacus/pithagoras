import express, { type Router } from "express";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piAgentDir } from "../pi-settings.js";
import { agentHome } from "../agent.js";
import { builtinSkillsDir } from "../pi/sdk-client.js";
import { isValidSlug, slugify } from "../slug.js";
import { importFromGit, previewFromGit, readSource, type SkillSource } from "../skills/github.js";

/**
 * Skills are pi's, not the portal's: it discovers them, decides which are
 * offered to the model, and reports collisions between them. So the list here
 * comes from pi's own loader rather than a directory scan, which would disagree
 * with what the agent actually sees the moment a package ships one.
 *
 * Only skills under the agent directory can be edited. A skill that arrived
 * with a package belongs to that package — editing it in place would be undone
 * by the next update, silently.
 */

/**
 * How a skill is turned off.
 *
 * pi discovers a skill by finding SKILL.md in a directory, so the only way to
 * make it genuinely stop loading — rather than hiding it here while the model
 * still sees it — is for that file not to be there. Renaming keeps everything
 * else in the directory intact, so enabling it again is the same move back.
 */
const DISABLED = "SKILL.md.disabled";

const skillsRoot = () => {
  const dir = path.join(piAgentDir(), "skills");
  mkdirSync(dir, { recursive: true });
  return dir;
};

interface LoadedSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
  sourceInfo?: { scope?: string; origin?: string; path?: string };
}

/**
 * The same loader a session uses.
 *
 * Not core/skills.loadSkills directly: pi gathers the skills an installed
 * package ships into `skillPaths` and then loads with includeDefaults false, so
 * calling it directly with an empty list quietly omitted every package skill —
 * this page claimed they did not exist while the agent was using them.
 */
async function loadFromPi(): Promise<{ skills: LoadedSkill[]; diagnostics: any[] }> {
  const pi: any = await import("@earendil-works/pi-coding-agent");
  const builtin = builtinSkillsDir();
  const loader = new pi.DefaultResourceLoader({
    cwd: agentHome(),
    agentDir: pi.getAgentDir(),
    // Same list a session gets, builtins included — this page disagreeing with
    // what the model is offered is the failure it exists to prevent.
    ...(builtin ? { additionalSkillPaths: [builtin] } : {}),
  });
  await loader.reload();
  const result = loader.getSkills();
  return { skills: result?.skills ?? [], diagnostics: result?.diagnostics ?? [] };
}

const isEditable = (filePath: string) => {
  const root = skillsRoot();
  try { return realpathSync(filePath).startsWith(realpathSync(root) + path.sep); } catch { return false; }
};

/** The directory that owns a skill, which is what delete removes. */
const skillDir = (filePath: string) => path.dirname(path.resolve(filePath));

function readBody(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

const toApi = (s: LoadedSkill) => ({
  name: s.name,
  description: s.description,
  path: s.filePath,
  scope: s.sourceInfo?.scope ?? s.sourceInfo?.origin ?? "agent",
  editable: isEditable(s.filePath),
  // Only invocable as /skill:name, never chosen by the model on its own.
  manualOnly: Boolean(s.disableModelInvocation),
  broken: false,
  enabled: true,
  source: isEditable(s.filePath) ? readSource(skillDir(s.filePath)) : null,
  content: isEditable(s.filePath) ? readBody(s.filePath) : "",
});

/**
 * Quoted, always.
 *
 * A description is a sentence, and sentences contain colons — "Use when cutting
 * a release: bump, tag, push" is not valid YAML unquoted, and pi drops the
 * whole skill with a parse warning. JSON string syntax is a valid YAML
 * double-quoted scalar and handles the escaping.
 */
const yaml = (value: string) => JSON.stringify(value);

const template = (name: string, description: string, body: string) =>
  `---
name: ${yaml(name)}
description: ${yaml(description)}
---

${body.trim() || `# ${name}\n\nWhat to do, step by step. The description above is what the model reads\nwhen deciding whether this applies, so make it say when to use it.`}
`;

/**
 * Skills on disk that pi could not load.
 *
 * They have to be listed: an unparseable skill is invisible to the loader, so
 * without this it could be neither repaired nor deleted from here — it would
 * just sit there producing a warning forever.
 */
function brokenSkills(loaded: LoadedSkill[]) {
  const known = new Set(loaded.map((s) => path.resolve(s.filePath)));
  const out: ReturnType<typeof toApi>[] = [];

  let entries: string[] = [];
  try {
    entries = readdirSync(skillsRoot());
  } catch {
    return out;
  }

  for (const name of entries) {
    const file = path.join(skillsRoot(), name, "SKILL.md");
    // A disabled skill has no SKILL.md by design; it is listed separately.
    if (existsSync(path.join(skillsRoot(), name, DISABLED))) continue;
    if (!existsSync(file) || known.has(path.resolve(file))) continue;
    out.push({
      name,
      description: "",
      path: file,
      scope: "agent",
      editable: true,
      manualOnly: false,
      broken: true,
      enabled: true,
      source: readSource(path.join(skillsRoot(), name)) as SkillSource | null,
      content: readBody(file),
    });
  }
  return out;
}

/** Skills switched off — invisible to pi, still here and re-enablable. */
function disabledSkills() {
  const out: ReturnType<typeof toApi>[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(skillsRoot());
  } catch {
    return out;
  }

  for (const name of entries) {
    const file = path.join(skillsRoot(), name, DISABLED);
    if (!existsSync(file)) continue;
    const content = readBody(file);
    const described = /^description\s*:\s*(.+)$/m.exec(content);
    out.push({
      name,
      description: described ? described[1].trim().replace(/^["']|["']$/g, "") : "",
      path: file,
      scope: "agent",
      editable: true,
      manualOnly: false,
      broken: false,
      enabled: false,
      source: readSource(path.join(skillsRoot(), name)) as SkillSource | null,
      content,
    });
  }
  return out;
}

export function skillsRouter(): Router {
  const router = express.Router();
  router.param("name", (req, res, next, name) => {
    if (!isValidSlug(name)) return res.status(400).json({ error: "Invalid skill name" });
    const root = skillsRoot(), dir = path.join(root, name);
    if (existsSync(dir) && !realpathSync(dir).startsWith(realpathSync(root) + path.sep)) {
      return res.status(400).json({ error: "Skill directory escapes its root" });
    }
    next();
  });

  /** By loaded name, or by directory for one pi could not parse. */
  const locate = async (name: string) => {
    const { skills } = await loadFromPi();
    const loaded = skills.find((s) => s.name === name);
    if (loaded) return { file: loaded.filePath, editable: isEditable(loaded.filePath) };
    // Not loaded means broken or disabled — both still editable and deletable.
    for (const candidate of ["SKILL.md", DISABLED]) {
      const file = path.join(skillsRoot(), name, candidate);
      if (existsSync(file)) return { file, editable: isEditable(file) };
    }
    return null;
  };

  router.get("/skills", async (_req, res) => {
    try {
      const { skills, diagnostics } = await loadFromPi();
      res.json({
        root: skillsRoot(),
        skills: [...skills.map(toApi), ...brokenSkills(skills), ...disabledSkills()],
        // Name collisions and unreadable files — pi reports them, so should we.
        diagnostics: (diagnostics ?? []).map((d: any) => ({
          type: d.type,
          message: d.message,
          path: d.path,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/skills", async (req, res) => {
    const { name, description, body } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name required" });
    }
    if (typeof description !== "string" || !description.trim()) {
      return res.status(400).json({
        error: "A description is required — it is what the model reads to decide if the skill applies",
      });
    }

    const slug = slugify(name);
    if (!isValidSlug(slug)) return res.status(400).json({ error: `"${name}" is not a usable name` });

    const dir = path.join(skillsRoot(), slug);
    if (existsSync(dir)) return res.status(409).json({ error: `"${slug}" already exists` });

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        template(slug, description.trim(), typeof body === "string" ? body : ""),
        "utf8"
      );
      res.json({ ok: true, name: slug, path: path.join(dir, "SKILL.md") });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Turn a skill on or off.
   *
   * Only skills under the agent directory: one from a package lives outside it,
   * and renaming a file inside a package would be undone by its next update.
   */
  router.post("/skills/:name/enabled", async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled required" });

    const dir = path.join(skillsRoot(), req.params.name);
    const live = path.join(dir, "SKILL.md");
    const off = path.join(dir, DISABLED);

    if (!existsSync(live) && !existsSync(off)) {
      return res.status(404).json({
        error: "Not found here — a skill from a package is switched off by removing the package",
      });
    }
    try {
      if (enabled && existsSync(off)) renameSync(off, live);
      if (!enabled && existsSync(live)) renameSync(live, off);
      res.json({ ok: true, enabled });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** What is in a repository, and which of it you already have. */
  router.post("/skills/preview-import", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !spec.trim()) {
      return res.status(400).json({ error: "spec required" });
    }
    try {
      res.json({ spec: spec.trim(), found: await previewFromGit(spec.trim(), skillsRoot()) });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * Import from a git repository.
   *
   * A repository can hold several skills, so this takes whatever it finds
   * rather than making you point at each one.
   */
  router.post("/skills/import", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !spec.trim()) {
      return res.status(400).json({ error: "spec required" });
    }
    try {
      const result = await importFromGit(spec.trim(), skillsRoot(), {
        overwrite: Boolean(req.body?.overwrite),
        only: Array.isArray(req.body?.only) ? req.body.only.map(String) : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /** Re-import an imported skill from where it came from. */
  router.post("/skills/:name/update", async (req, res) => {
    const dir = path.join(skillsRoot(), req.params.name);
    const source = readSource(dir);
    if (!source) {
      return res.status(400).json({ error: "That skill was not imported, so there is nothing to update from" });
    }
    try {
      // Scoped to this one. Without `only` the whole repository is re-imported,
      // so updating one skill quietly installed every other skill beside it.
      const result = await importFromGit(source.spec, skillsRoot(), {
        overwrite: true,
        only: [req.params.name],
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.put("/skills/:name", async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    try {
      const found = await locate(req.params.name);
      if (!found) return res.status(404).json({ error: "Not found" });
      if (!found.editable) {
        return res.status(400).json({
          error: "That skill came from a package — editing it here would be lost on its next update",
        });
      }
      writeFileSync(found.file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/skills/:name", async (req, res) => {
    try {
      const found = await locate(req.params.name);
      if (!found) return res.json({ ok: true });
      if (!found.editable) {
        return res.status(400).json({ error: "That skill belongs to a package; remove the package" });
      }
      rmSync(skillDir(found.file), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
