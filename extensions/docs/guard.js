/**
 * The store's own folder (`<folder>/.pithagoras-docs`), held and watched: the
 * portal, which with the sandbox on runs as root, runs git and SQLite on what
 * is in it, so nothing else may change it.
 *
 * It lies in a folder the agents' group may write to, and a folder that may be
 * written to can have its entries renamed, so the folder is opened once, here
 * (never through a link), and every later step goes through that open
 * descriptor, not through the path again: git is given `/proc/self/fd/<n>` and
 * the descriptor itself (Linux; elsewhere the path, checked before each use).
 * The store must be the portal's own and closed to everyone else (0700); that
 * is checked before every git run, so a store that was replaced, or that
 * something (a recursive chmod of the sandbox, an administrator) opened to
 * others, is refused until it is opened again, which puts it right.
 *
 * A store that was open to others for a while and is closed again looks as it
 * did (owner, mode), and whoever could write in it meanwhile may have left
 * what git reads and the portal's root must not follow. So the walk over it
 * (`audit`) leaves a file that only the sandbox's closing of the store takes
 * away (server/src/sandbox/apply.ts, closeDocsStores), and a held store
 * without it is opened again and walked again: once per such time, not per
 * request.
 */
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, chmodSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DocError } from "./errors.js";

const isOurs = (stat) => !process.getuid || stat.uid === process.getuid();

/** The file in the store that says it has been walked over since it was last open to others (the sandbox's closing of it removes it). */
const AUDITED = ".audited";

/** What git trusts in a repository besides its objects, that could send it elsewhere or make it run something: gone or written new. */
const MISTRUSTED = ["commondir", "config.worktree", "shallow", "hooks", "info/grafts", "info/attributes", "objects/info/alternates", "objects/info/http-alternates"];
/** What `git init` makes of `config`, without the work tree it names: the one every run names itself. */
const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n";

export class Guard {
  /** Whether descriptors can be named as paths, for git to be given the held folder itself. */
  static pinning = process.platform === "linux";

  /**
   * Opens the store folder `dir`, made where it is not there yet. Refused when
   * it is a link, or anything but a folder of the portal's own. Closed to
   * everyone else from here on; `audit` then looks at what is in it.
   */
  static open(dir) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let fd;
    try {
      fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      throw new DocError(409, `${path.basename(dir)} in this folder is not the documents store's own`);
    }
    const guard = new Guard(dir, fd);
    try {
      guard.#own();
    } catch (e) {
      guard.close();
      throw e;
    }
    return guard;
  }

  constructor(dir, fd) {
    this.dir = dir;
    this.fd = fd;
    /** Whether `audit` has been through it, so that `check` looks for what it left. */
    this.audited = false;
  }

  /** Whether git is given the held descriptor (in its stdio, at 3), not the path. */
  get pinned() {
    return Guard.pinning;
  }

  /** `rel` in the store: through the held descriptor where it can be, else by path. */
  at(rel = "") {
    const root = this.pinned ? `/proc/self/fd/${this.fd}` : this.dir;
    return rel ? `${root}/${rel}` : root;
  }

  /** `rel` in the store as a git process, which is given the held folder as its descriptor 3, names it. */
  forGit(rel = "") {
    const root = this.pinned ? "/proc/self/fd/3" : this.dir;
    return rel ? `${root}/${rel}` : root;
  }

  close() {
    try {
      closeSync(this.fd);
    } catch {
      // Closed already.
    }
  }

  /** The held folder is the portal's own, and closed to everyone else: before anything else is looked at, so what is below it is out of reach. */
  #own() {
    const stat = fstatSync(this.fd);
    if (!stat.isDirectory() || !isOurs(stat)) throw new DocError(409, `${path.basename(this.dir)} in this folder is not the documents store's own`);
    if (stat.mode & 0o077) fchmodSync(this.fd, 0o700);
    this.#group(this.fd, stat);
  }

  /** The group of what is ours back to the portal's, where that can be (root): a recursive chown of the sandbox had made it the agents'. */
  #group(fd, stat) {
    if (process.getgid && stat.gid !== process.getgid()) {
      try {
        fchownSync(fd, -1, process.getgid());
      } catch {
        // Not allowed: no one else has any access by mode.
      }
    }
  }

  /**
   * Before every use: the folder at the store's path is the one held (not
   * deleted, renamed or replaced since), and is still the portal's and closed
   * to everyone else. Throws, rather than carry on with what git was not
   * given to read.
   */
  check() {
    let now;
    try {
      now = lstatSync(this.dir);
    } catch {
      throw new DocError(409, "The documents store was removed while it was in use");
    }
    const held = fstatSync(this.fd);
    if (!now.isDirectory() || now.ino !== held.ino || now.dev !== held.dev) throw new DocError(409, "The documents store was replaced while it was in use");
    if (!isOurs(held) || held.mode & 0o077) throw new DocError(409, "The documents store was opened to others while it was in use");
    if (this.audited) {
      let mark = null;
      try {
        mark = lstatSync(this.at(AUDITED));
      } catch {
        // Taken away: see below.
      }
      // Gone, or not the portal's own: the sandbox had the store open to others since it was walked over, and it is closed again now.
      if (!mark?.isFile() || !isOurs(mark)) throw new DocError(409, "The documents store was open to others for a while and is looked over again");
    }
  }

  /**
   * Looks the whole store over, when it is opened: nothing in it but
   * plain files and folders of the portal's own (anything else is refused:
   * git must not follow a link or wait at a pipe in there), none writable by
   * group or others, with the portal's group. What git would read besides its
   * objects is put back as the store made it: a store that was open to others
   * for a while (the sandbox's recursive chown and chmod of a chat's folder
   * is such a time) may have had it changed.
   *
   * The file that `check` wants to find is made first, so that a closing of
   * the store by the sandbox while this walk is still on takes it away too,
   * and what was planted after the walk passed it is walked over next time.
   * It takes the whole walk, not only the control files: a link put in the
   * place of the objects folder, or a pipe, leads git elsewhere as well. That
   * is why it is done once for each time the store was open to others, not
   * on every request, when the objects are too many to walk over.
   */
  audit() {
    this.audited = false;
    this.#own();
    rmSync(this.at(AUDITED), { recursive: true, force: true });
    writeFileSync(this.at(AUDITED), "", { flag: "wx", mode: 0o600 });
    this.#walk("", 0);
    this.#control();
    this.audited = true;
  }

  /** What git reads besides its objects, gone or written new. */
  #control() {
    try {
      lstatSync(this.at("git"));
    } catch {
      return;
    }
    for (const name of MISTRUSTED) rmSync(this.at(`git/${name}`), { recursive: true, force: true });
    const temp = this.at(`git/config.${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(temp, CONFIG, { flag: "wx", mode: 0o600 });
    renameSync(temp, this.at("git/config"));
  }

  /** `rel`'s entries, and theirs below: refused unless plain and ours; closed to group and others. */
  #walk(rel, depth) {
    for (const entry of readdirSync(this.at(rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const place = this.at(name);
      const stat = lstatSync(place);
      const dir = stat.isDirectory();
      if (!(dir || stat.isFile()) || !isOurs(stat)) throw new DocError(409, "The documents store holds something that is not its own");
      // The store's own folders are closed to everyone; what is in them, to writing by anyone but the portal.
      const mode = depth === 0 && dir ? stat.mode & 0o700 : stat.mode & ~0o022;
      if ((stat.mode & 0o7777) !== (mode & 0o7777)) chmodSync(place, mode & 0o7777);
      if (process.getgid && stat.gid !== process.getgid()) {
        try {
          lchownSync(place, -1, process.getgid());
        } catch {
          // Not allowed (not root): the folder above is closed to the group.
        }
      }
      if (dir) this.#walk(name, depth + 1);
    }
  }
}
