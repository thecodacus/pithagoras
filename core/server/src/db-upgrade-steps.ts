import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * What upgrading the database does, step by step, apart from the page shown
 * meanwhile (see db-upgrade.ts): check it is whole, back it up, then let
 * getDb() change it. Kept apart so each step can be tested on a file.
 */

/** A database that cannot be upgraded because it is damaged. The page says how to repair it. */
export class DamagedDatabase extends Error {
  readonly damaged = true;
}

/**
 * What SQLite finds wrong with the file, or nothing. `quick_check` reads every
 * page, which is what an upgrade that touches a whole table would do; finding
 * the damage here means finding it before anything has changed.
 */
export function integrityProblems(file: string): string[] {
  let d: Database.Database | undefined;
  try {
    d = new Database(file, { fileMustExist: true });
    const rows = d.pragma("quick_check(20)") as { quick_check: string }[];
    return rows.map((r) => r.quick_check).filter((r) => r !== "ok");
  } catch (e) {
    return [(e as Error).message];
  } finally {
    d?.close();
  }
}

/** The file and its write-ahead log: what a copy of it has to hold. */
export function databaseBytes(file: string): number {
  return [file, `${file}-wal`].reduce((sum, f) => sum + (existsSync(f) ? statSync(f).size : 0), 0);
}

export function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** Backups this keeps, newest first, by the name it gives them. */
export function backupsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^portal-v\d+-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** Keeps the newest `keep` of this module's backups and removes the rest. Nothing else in the folder is touched. */
export function pruneBackups(dir: string, keep: number): void {
  for (const old of backupsIn(dir).slice(keep)) unlinkSync(old);
}

/** What a backup is called while it is being written: it is no backup until it is whole, and nothing counts or keeps it as one. */
const PARTIAL = ".partial";

/** Removes what an upgrade that stopped halfway left of its backup; the space it holds is what the next one needs. */
export function removePartialBackups(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (/^portal-v\d+-\d{8}-\d{6}\.db\.partial(-journal)?$/.test(f)) rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * A copy of the database through SQLite's own backup, which is consistent
 * while it is read and leaves out nothing the log still holds. `progress`
 * hears the share done, 0 to 100. It is written beside its name and renamed
 * once it is whole, so a full disk or a stop in the middle leaves no file that
 * could be taken for a backup, or pushes a good one out when old ones go.
 */
export async function backupTo(file: string, dest: string, progress: (percent: number) => void = () => {}): Promise<void> {
  const partial = dest + PARTIAL;
  const d = new Database(file, { fileMustExist: true });
  try {
    await d.backup(partial, {
      progress({ totalPages, remainingPages }) {
        progress(totalPages ? Math.round((1 - remainingPages / totalPages) * 100) : 100);
        return 2000;
      },
    });
    progress(100);
    renameSync(partial, dest);
  } catch (e) {
    rmSync(partial, { force: true });
    rmSync(partial + "-journal", { force: true });
    throw e;
  } finally {
    d.close();
  }
}

export interface UpgradeOptions {
  file: string;
  /** The version it is at, for the backup's name. */
  from: number;
  backupDir: string;
  /** How many backups to keep. */
  keep?: number;
  /** Upgrade without a backup: for a disk that cannot hold one, when somebody has decided that. */
  skipBackup?: boolean;
  /** Replaced in tests. */
  free?: (dir: string) => number;
  /** Changes the database: getDb() and its migrations, unless a test gives another. */
  migrate?: () => Promise<void>;
}

/**
 * Checks, backs up, and upgrades. Throws DamagedDatabase where the file is
 * damaged, and refuses where there is no room for the backup; in both cases
 * nothing has been changed.
 */
export async function runUpgrade(o: UpgradeOptions, progress: (message: string) => void): Promise<string | undefined> {
  // What an earlier try left of its backup: it holds the room this one needs, and is none.
  removePartialBackups(o.backupDir);
  progress("Checking the database. A large one can take a few minutes.");
  const problems = integrityProblems(o.file);
  if (problems.length) throw new DamagedDatabase(`The database is damaged: ${problems.slice(0, 3).join("; ")}`);

  let backup: string | undefined;
  if (!o.skipBackup) {
    mkdirSync(o.backupDir, { recursive: true });
    const need = databaseBytes(o.file) * 1.1;
    const free = (o.free ?? freeBytes)(o.backupDir);
    if (free < need) {
      throw new Error(
        `There is not room to back up the database before upgrading it: about ${gb(need)} is needed and ${gb(free)} is free. ` +
          "Free some space, or start with PORTAL_UPGRADE_BACKUP=skip to upgrade without a backup."
      );
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    backup = path.join(o.backupDir, `portal-v${o.from}-${stamp}.db`);
    await backupTo(o.file, backup, (p) => progress(`Backing up the database: ${p}%`));
    pruneBackups(o.backupDir, o.keep ?? 2);
  }

  progress("Upgrading the database.");
  await (o.migrate ?? (async () => { (await import("./db.js")).getDb(); }))();
  return backup;
}
