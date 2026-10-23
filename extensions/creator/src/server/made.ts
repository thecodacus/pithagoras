import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServerPortal } from "@pithagoras/extension-api/server";

/**
 * What one start of the server half has: the portal it was started with, and whether it was stopped since. Kept per
 * start and handed to every part, not kept in a module: Creator runs in the portal's process, where a start at the
 * same revision (switched off and on) calls the same module's default export again. An install still going from the
 * start before would otherwise reach the new start's portal, which runs, and so be let through after its own was
 * stopped. The snapshot gives up once `stopped` is set (see snapshot.ts).
 */
export interface Run {
  portal: ServerPortal;
  stopped: boolean;
}

/** What Creator keeps of an extension it made: the chat it was made in, the draft it was copied from, and the copy's digest. */
export interface Made {
  version?: string;
  chat: string;
  draft: string;
  digest: string;
  /** When it was last installed, an ISO time. */
  at: string;
}

/** A name a made extension may have: npm's, without a scope, since its copy is one folder in `made/`. */
export const NAME = /^[\w~-][\w.~-]*$/;

/**
 * Where the copies are: `<dataDir>/made/<name>/`. The data folder is the portal's alone (0700), so the sandbox keeps
 * the agents out of it, and it is neither in pi's folder nor in a place the chats load from.
 */
export const madeDir = (run: Run) => path.join(run.portal.dataDir(), "made");
export const copyOf = (run: Run, name: string) => path.join(madeDir(run), name);

/**
 * The records, in one file beside `made/` (a file beside each copy could have the name of another package's copy,
 * one called `<name>.json`). By name. The title of a record's chat is read when it is shown, so it is not kept.
 */
const recordsFile = (run: Run) => path.join(run.portal.dataDir(), "made.json");

export function records(run: Run): Map<string, Made> {
  let text: string;
  try {
    text = readFileSync(recordsFile(run), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw e;
  }
  return new Map(Object.entries(JSON.parse(text) as Record<string, Made>));
}

/** Written whole: through a file beside it, put in place by a rename. */
export function saveRecords(run: Run, made: Map<string, Made>): void {
  const file = recordsFile(run);
  const temp = `${file}.${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, JSON.stringify(Object.fromEntries(made), null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

/** The subject of an audit row for a made extension: its name and version, its short digest, and its draft. */
export const subjectOf = (name: string, made: Pick<Made, "version" | "digest" | "draft">) =>
  `${[name, made.version].filter(Boolean).join(" ")} · ${made.digest.slice(0, 12)} · ${made.draft}`;

let line: Promise<unknown> = Promise.resolve();
/**
 * One install, reinstall, removal or Forget at a time, for every chat: two Creator chats installing one name would
 * otherwise swap folders over each other, and a Forget could delete a copy that an install of it is loading. The
 * portal keeps its own part of an install one at a time, not the copy. Shared by a start at the same revision; across
 * two revisions, the earlier start is stopped (`Run.stopped`).
 */
export function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const done = line.then(work);
  line = done.catch(() => {});
  return done;
}

/** One made extension as Creator's page and `extension_status` list it: its record, its chat now, and whether it is installed from its copy now. */
export interface Listed {
  name: string;
  version?: string;
  digest: string;
  at: string;
  /** The chat it was made in, with its title now; null for one that was deleted. */
  chat: { id: string; title: string } | null;
  draft: string;
  /** Installed from its copy in Creator's folder now, and not removed in Settings. */
  installed: boolean;
  /** Switched on, where it is installed. */
  enabled?: boolean;
}

/** Every made extension, the one installed last first. */
export async function listMade(run: Run): Promise<Listed[]> {
  const { portal } = run;
  const made = [...records(run)].sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return Promise.all(
    made.map(async ([name, one]) => {
      const status = await portal.extensions.status(name);
      // One of that name from anywhere else is not this copy.
      const installed = status?.installedFrom?.extension === portal.extension;
      const chat = portal.chats.get(one.chat);
      return {
        name,
        ...(one.version ? { version: one.version } : {}),
        digest: one.digest,
        at: one.at,
        chat: chat ? { id: chat.id, title: chat.title } : null,
        draft: one.draft,
        installed,
        ...(installed ? { enabled: status!.enabled } : {}),
      };
    }),
  );
}
