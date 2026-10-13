import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { piSettingsPath, writePiSettingsText } from "../pi-settings.js";
import { packageRemoved } from "../db.js";
import express, { type Router } from "express";
import { searchCatalog } from "../catalog.js";
import { oneAtATime } from "../one-at-a-time.js";
import { followPackages } from "./extensions.js";

const run = promisify(execFile);

/**
 * pi packages (extensions, skills, prompts, themes) are managed by the pi CLI
 * rather than the RPC protocol, so these shell out.
 *
 * They install under $HOME/.pi/agent, which the image points at a persistent
 * volume — otherwise every rebuild would silently wipe installed packages.
 */
export function pi(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // What changes the package folder and pi's settings goes one at a time: two at once collide on the same npm prefix and settings.json.
  return args[0] === "list" ? runPi(args) : changing(() => runPi(args));
}
const changing = oneAtATime();

async function runPi(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("pi", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error((err.stderr || err.stdout || err.message).trim());
  }
}

// A package spec is passed to the CLI as a single argument (never a shell
// string), but keep it to shapes pi documents so typos fail fast and nothing
// odd reaches execFile.
const SPEC_RE = /^(npm:|git:|https:\/\/|\.{0,2}\/)[\w@./:+-]+$/;

export function packagesRouter(): Router {
  const router = express.Router();

  router.get("/packages", async (_req, res) => {
    try {
      const { stdout } = await pi(["list"]);
      res.json({ output: stdout.trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Packages published for pi, to pick from rather than spell out. */
  router.get("/packages/catalog", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const topic = req.query.topic === "provider" ? "provider" : undefined;
    try {
      res.json({ packages: await searchCatalog(q, topic) });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  router.post("/packages", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !SPEC_RE.test(spec)) {
      return res.status(400).json({
        error: "Spec must look like npm:pkg@1.0.0, git:github.com/user/repo, https://…, or a path",
      });
    }
    try {
      const { stdout, stderr } = await pi(["install", spec]);
      await followPackages();
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.delete("/packages", async (req, res) => {
    const spec = req.body?.spec;
    if (typeof spec !== "string" || !SPEC_RE.test(spec)) {
      return res.status(400).json({ error: "Invalid package spec" });
    }
    try {
      const { stdout, stderr } = await pi(["remove", spec]);
      await packageRemoved(spec);
      await followPackages();
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/packages/update", async (_req, res) => {
    try {
      // The packages only: `--all` updates pi as well, which it cannot do where it is the portal's own locked copy
      // (the image), and says so with an error after the packages were updated. pi comes with the portal's version.
      const { stdout, stderr } = await pi(["update", "--extensions"]);
      await followPackages();
      res.json({ ok: true, output: (stdout + stderr).trim() });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /**
   * Raw pi settings file.
   *
   * Extensions configure themselves through settings.json and pi exposes no
   * schema for that over RPC, so the honest option is to let you edit the file
   * directly rather than pretend to generate a form for it.
   */
  router.get("/pi-settings", (_req, res) => {
    const file = piSettingsPath();
    try {
      const content = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
      res.json({ path: file, content });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.put("/pi-settings", async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    // Refuse to write anything pi could not parse — a broken settings.json
    // stops every future session from starting.
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(400).json({ error: `Not valid JSON: ${(e as Error).message}` });
    }
    // An object, as every other change of the file takes it to be.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return res.status(400).json({ error: "settings.json must be a JSON object" });
    }
    try {
      await writePiSettingsText(content);
      // The file names the packages: one taken out of it, or switched in it, by hand.
      await followPackages();
      res.json({ ok: true, path: piSettingsPath(), note: "Applies to newly started sessions" });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
