import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import express, { type Router } from "express";

/**
 * Read/write/download access to a workspace's files from the browser.
 *
 * A workspace is a folder pi already has full filesystem access to — this
 * just gives the browser the same view, scoped to one workspace and with path
 * traversal blocked, rather than requiring an SSH session or the host shell to
 * see what the agent produced.
 */

const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "/workspaces");

/** Excluded from "download whole workspace" — regenerable or huge, not the work itself. */
const ARCHIVE_EXCLUDES = ["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"];

/** Above this, a file is offered as a download only — not decoded into a JSON body. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** The workspace's absolute directory, or throws for a name that isn't one. */
function workspaceDir(name: string): string {
  const dir = path.join(WORKSPACE_ROOT, name);
  if (path.resolve(dir) !== dir || !dir.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error("Invalid workspace name");
  }
  if (!existsSync(dir)) throw new Error(`Workspace "${name}" not found`);
  return dir;
}

/**
 * A path within a workspace, rejecting anything that escapes it via `..` or
 * an absolute override — the query string is client-controlled.
 */
function resolveSafe(base: string, relPath: string): string {
  const rel = String(relPath ?? "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Path escapes the workspace");
  }
  return resolved;
}

/** Null bytes in the first few KB are the cheap, reliable "not text" signal. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function filesRouter(): Router {
  const router = express.Router();

  router.get("/workspaces/:name/files", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      const stat = statSync(target);
      if (!stat.isDirectory()) return res.status(400).json({ error: "Not a directory" });

      const entries = readdirSync(target, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => {
          const st = statSync(path.join(target, e.name));
          return {
            name: e.name,
            type: e.isDirectory() ? ("dir" as const) : ("file" as const),
            size: st.size,
            mtime: st.mtimeMs,
          };
        })
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
        );

      res.json({ path: path.relative(dir, target), entries });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/workspaces/:name/file", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      const stat = statSync(target);
      if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });

      if (req.query.download === "1") {
        return res.download(target, path.basename(target));
      }

      const buffer = readFileSync(target);
      if (looksBinary(buffer) || stat.size > MAX_EDIT_BYTES) {
        return res.json({ binary: true, size: stat.size });
      }
      res.json({ binary: false, size: stat.size, content: buffer.toString("utf8") });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.put("/workspaces/:name/file", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      const { content } = req.body ?? {};
      if (typeof content !== "string") return res.status(400).json({ error: "content required" });
      writeFileSync(target, content, "utf8");
      const stat = statSync(target);
      res.json({ ok: true, size: stat.size, mtime: stat.mtimeMs });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * Removes a file or a whole folder (recursively). The workspace root itself
   * is refused — that would be deleting the workspace, not something in it.
   */
  router.delete("/workspaces/:name/file", (req, res) => {
    try {
      const dir = workspaceDir(req.params.name);
      const target = resolveSafe(dir, String(req.query.path ?? ""));
      if (target === dir) return res.status(400).json({ error: "Cannot delete the workspace root" });
      if (!existsSync(target)) return res.status(404).json({ error: "Not found" });
      rmSync(target, { recursive: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  /**
   * The whole workspace as a .tar.gz. Streamed straight from `tar` rather than
   * staged on disk first — a big repo would otherwise need double the space
   * and a cleanup step.
   */
  router.get("/workspaces/:name/archive", (req, res) => {
    let dir: string;
    try {
      dir = workspaceDir(req.params.name);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.tar.gz"`
    );

    const args = [
      "-czf",
      "-",
      ...ARCHIVE_EXCLUDES.map((d) => `--exclude=${d}`),
      "-C",
      dir,
      ".",
    ];
    const tar = spawn("tar", args);
    tar.stdout.pipe(res);
    // tar exits non-zero on excluded-but-vanished files etc.; the stream
    // itself already carries whatever it managed to read, so ignore stderr.
    tar.stderr.resume();
    tar.on("error", () => res.end());
  });

  return router;
}
