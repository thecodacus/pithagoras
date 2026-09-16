import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import express, { type Router } from "express";

/**
 * Read/write/download access to a workspace's files from the browser.
 *
 * A workspace is a folder pi already has full filesystem access to — this
 * just gives the browser the same view, scoped to one workspace and with path
 * traversal blocked, rather than requiring an SSH session or the host shell to
 * see what the agent produced.
 *
 * Lexical checks (`..`, absolute overrides) alone don't stop a symlink inside
 * a workspace from pointing outside it — `path.resolve` never looks at the
 * filesystem, so `<workspace>/escape -> /etc` would sail through them. Every
 * boundary check below also canonicalizes with `realpath` and re-checks the
 * resolved target against the canonical root.
 */

const WORKSPACE_ROOT = canonicalize(path.resolve(process.env.WORKSPACE_ROOT || "/workspaces"));

/** Excluded from "download whole workspace" — regenerable or huge, not the work itself. */
const ARCHIVE_EXCLUDES = ["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"];

/** Above this, a file is offered as a download only — not decoded into a JSON body. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** realpath(p), or p itself if it doesn't exist yet (e.g. at process startup). */
function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** True when a filesystem entry exists at `p`, including a dangling symlink. */
function existsLexically(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * realpath of `target`, resolving symlinks in whichever leading portion of it
 * already exists. `target` itself may not exist yet — a PUT creating a new
 * file resolves through its (existing) parent directory instead, per CWE-59
 * guidance: canonicalize the existing ancestor, keep the not-yet-created tail
 * literal.
 *
 * The walk uses `lstatSync`, not `existsSync`: `existsSync` follows symlinks,
 * so it reports `false` for a *dangling* symlink and the loop would treat the
 * link's own name as an ordinary missing path component — reconstructing a
 * workspace-relative-looking path that passes the boundary check while
 * `writeFileSync` follows the link itself to wherever it actually points.
 * `lstatSync` sees the link as an existing entry regardless of where (or
 * whether) its target exists, so it stops the walk there and `realpathSync`
 * below is what gets to decide: dangling links throw and are rejected.
 */
function realpathThroughExistingAncestor(target: string): string {
  let current = target;
  const missingTail: string[] = [];
  while (!existsLexically(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Path does not exist");
    missingTail.unshift(path.basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    throw new Error("Path escapes the workspace"); // dangling symlink
  }
  return missingTail.length ? path.join(real, ...missingTail) : real;
}

/** True when `p` is `root` or lexically nested inside it. */
function isWithin(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/** The workspace's absolute, canonical directory, or throws for a name that isn't one. */
function workspaceDir(name: string): string {
  const dir = path.join(WORKSPACE_ROOT, name);
  if (path.resolve(dir) !== dir || !isWithin(WORKSPACE_ROOT, dir)) {
    throw new Error("Invalid workspace name");
  }
  if (!existsSync(dir)) throw new Error(`Workspace "${name}" not found`);
  const real = realpathSync(dir);
  if (!isWithin(WORKSPACE_ROOT, real)) {
    // The workspace entry itself is a symlink pointing outside the root —
    // treat it the same as a workspace that doesn't exist.
    throw new Error(`Workspace "${name}" not found`);
  }
  return real;
}

/**
 * A path within a workspace, rejecting anything that escapes it via `..`, an
 * absolute override, or a symlink resolving outside — `base` must already be
 * canonical (as returned by workspaceDir).
 */
function resolveSafe(base: string, relPath: string): string {
  const rel = String(relPath ?? "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(base, rel);
  if (!isWithin(base, resolved)) {
    throw new Error("Path escapes the workspace");
  }
  if (!isWithin(base, realpathThroughExistingAncestor(resolved))) {
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
