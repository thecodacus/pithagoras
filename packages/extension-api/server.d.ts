/**
 * What an extension's server half is given: the `portal` its module's
 * default export is called with, in the portal's own process. The portal
 * implements exactly this, and is checked against it when it is built.
 *
 * See docs/guide/extension-ui.md, "The server half".
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Router, json, raw, text } from "express";

/** A chat, as an extension's server half is told of it. */
export interface Chat {
  id: string;
  title: string;
  /** The folder the chat works in, as the chat names it. */
  workspace: string;
  status: "idle" | "running" | "error" | "interrupted";
}

export type ChatLife = "started" | "stopped" | "deleted";
export type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
export type Ran = { code: number | null; stdout: Buffer; stderr: string };

/** What a git or gh step printed. `cut`: it printed more than `max`, and the rest was not read. */
export type GitRan = { stdout: string; stderr: string; code: number; cut: boolean };

/** One thing in a folder. "link" is a link that could not be followed to something inside it. */
export interface FileEntry {
  name: string;
  type: "dir" | "file" | "link";
  /** A link, whatever `type` says: one to a folder inside is listed as a "dir", but removing it removes the link. */
  link?: boolean;
  size: number;
  mtime: number;
}

/** A file's text, or the fact that it is not text or is over 1 MB. */
export type FileContent = { binary: true; size: number; mtime: number } | { binary: false; size: number; mtime: number; content: string };

/** What removing a folder would lose that nothing else has: git work only it holds. */
export interface Unsaved {
  /** Changes that are not committed. */
  changed: number;
  /** Commits that no remote has. */
  unpushed: number;
  stashes: number;
  /** Not everything could be read, so there may be more. */
  unknown?: true;
}

/**
 * Why `portal.files` refused, on the error it throws (`code`): a path that is
 * not one (`invalid`), nothing there (`missing`), a save over a file that
 * changed since it was read (`conflict`), a name that is taken (`exists`),
 * too large (`too_large`), the system refusing (`failed`), and a folder that
 * holds git work nothing else has (`unsaved`, with `unsaved` on the error).
 * For `failed`, `errno` on the error is the system's own code (`ENOSPC`,
 * `EACCES`, `EROFS`…) and `cause` the error it gave.
 */
export type FileRefusal = "invalid" | "missing" | "conflict" | "exists" | "too_large" | "failed" | "unsaved";

/** What opens a file for `files.open` and `files.readBytes`, beyond the checks every path gets. */
export interface FileOpenOptions {
  /**
   * `rel` must be a name in `base` itself, reached through no link: refused (`invalid`) when following links led it
   * anywhere else, even to another file in the folder. For a file that is to be only what its name says.
   */
  direct?: boolean;
  /** A file with a second name (a hard link, which may be outside the folder) is refused (`invalid`). */
  alone?: boolean;
}

/**
 * A file read, with what tells it changed. `change` is an opaque text that differs whenever the file was written
 * (in place: its times; or put in place by a rename: its inode), so a caller that keeps it can tell a changed
 * file from an unchanged one without reading it; compare it for equality only.
 */
export interface FileBytes {
  bytes: Buffer;
  /** The whole file's size, also when only its start was read. */
  size: number;
  mtime: number;
  change: string;
}

export interface GitStepOptions {
  /** What the step reads on its standard input. */
  input?: string;
  /** How long it may take, in ms: by default 20 seconds for reading, 3 minutes for a step that writes. */
  timeout?: number;
  /** Stop reading after this many bytes of output: by default 16 MB. */
  max?: number;
  /** Exit codes that are answers rather than failures (`diff --no-index` says 1 for "they differ"). */
  ok?: number[];
  /** A step that changes the repository: it may take the index lock and run a hook, as `git` typed in a terminal does. */
  writes?: boolean;
}

/**
 * git and gh in one folder. A step that fails rejects with an Error that has a
 * `status`: 409 with git's own words, 504 for one stopped for taking too long,
 * 501 where git (or gh) is not installed.
 */
export interface GitHandle {
  run(args: string[], options?: GitStepOptions): Promise<GitRan>;
  gh(args: string[], options?: GitStepOptions): Promise<GitRan>;
}

export interface ServerPortal {
  /** Of this interface: raised when something an extension relies on changes. */
  version: 1;
  /** The package's name. */
  extension: string;
  /** How pi is run here: "host" is in the portal's own process, where a chat's pi and this module can reach each other. */
  executor: string;
  log(text: string): void;
  /**
   * What this extension gives the extensions that build on it, those that name it in `pithagoras.requires` or
   * `pithagoras.optional` in their package.json. `factory` is called once for each of them, with its name, when it first
   * asks (`extensions.use`), and what it returns is what that one gets: one for each lets an extension keep apart what each
   * does with it. Those that build on it start after it, and are stopped before it and started again whenever it is.
   */
  provide(factory: (consumer: { name: string }) => unknown): void;
  extensions: {
    /**
     * What an extension this one builds on gives it (see `provide`): one its package.json names in `pithagoras.requires`,
     * which is always there (without it this one does not start, and Settings → Extensions says why), or in
     * `pithagoras.optional`, which may not be: nothing then, or while it is not in a version this one takes. This one is
     * started again when such an extension comes or goes. Naming one that is in neither is an error.
     */
    use<T = unknown>(name: string): T | undefined;
  };
  /**
   * The package's own routes, at /api/x/<package>/…, behind the portal's
   * login. No body is read for them: a route that takes JSON says so with
   * `portal.http.json()`, and one that takes a file reads the request itself.
   */
  router: Router;
  http: {
    json: typeof json;
    raw: typeof raw;
    text: typeof text;
    /** WebSocket upgrades under /api/x/<package>/…, already checked for the login and for the page they come from. */
    upgrade(handler: Upgrade): void;
    /**
     * Ends a long response, such as a stream, when the login it was opened
     * under ends: the password changes, or single sign-on is set up anew.
     * What it showed is not shown to whoever signs in next. Returns what
     * stops the watching, for a response that ended by itself.
     */
    endWithLogin(end: () => void): () => void;
  };
  chats: {
    get(id: string): Chat | undefined;
    list(): Chat[];
    /**
     * The folder a chat's pi works in, on this disk: where a server half reads
     * and keeps what belongs to that chat. Throws when the chat is gone or its
     * folder is.
     */
    folder(id: string): string;
    /** To what the package drew on the pages open on a chat. Nothing is stored. */
    send(chatId: string, data: unknown): void;
    /** What a page that opens a chat is told first: where things stand. Nothing, to tell it nothing. */
    onOpen(handler: (chatId: string) => unknown): void;
    /** A chat's pi was started or stopped, or the chat was deleted. */
    on(event: ChatLife, handler: (chatId: string) => void): void;
    /** Everything a chat's pi says, as it says it: messages as they stream, tool calls, and what the package's own pi extension sends. */
    onEvent(handler: (chatId: string, event: Record<string, unknown>) => void): void;
    /** To the package's own pi extension in a chat, starting its pi if need be. False where pi does not run in the portal. */
    tell(chatId: string, data: unknown): Promise<boolean>;
    /**
     * A pi extension of the package's, made here: registered in every chat's
     * pi as it starts, so its tools hold what this module holds. Only where pi
     * runs in the portal's own process. A tool registered with
     * `offByDefault: true` is off in every chat until somebody switches it on.
     */
    extend(factory: (pi: any, chat: Chat) => void): void;
    /**
     * How a chat's model is offered a tool now: by its own name ("direct"), through the `tools` tool where the
     * tool is lazy ("lazy"), or not at all: switched off, out of reach, or the chat's pi is not running here. A
     * call of a tool by a name it is not offered under is refused and never runs.
     */
    offers(chatId: string, tool: string): "direct" | "lazy" | undefined;
    /** Keeps a chat's pi from being let go while work of the package's goes on. Returns what lets it go again. */
    hold(chatId: string): () => void;
  };
  sandbox: {
    /** Whether agents run as users of their own. */
    on(): boolean;
    /** What starts a process as a chat's agent: what to put before the command, and its environment. The portal's own while the sandbox is off. */
    spawnAs(chatId: string): { argv: string[]; env: NodeJS.ProcessEnv };
    /** Runs a command as a chat's agent, in the chat's folder unless told otherwise. Never throws for a non-zero exit. */
    run(chatId: string, argv: string[], options?: { input?: Buffer | string; cwd?: string; signal?: AbortSignal }): Promise<Ran>;
    /**
     * The portal's environment as a process the person starts should have
     * it: without the mark the agent's processes carry, so that what someone
     * starts by hand (a shell, a server under it) is not listed as a job the
     * agent left running.
     */
    personEnv(): NodeJS.ProcessEnv;
  };
  /**
   * A chat's folder, read and changed safely from the portal's own process:
   * what the portal does for itself, for every server half to do the same.
   * The agent writes in that folder, links included, and the portal may run
   * with more rights than the agent does. So a path is checked as text and
   * again where every link along it leads, the folder a file is in is held open
   * (walked down from `base` without following a link, on Linux) and the file
   * is made, opened and put in place in that folder, not in whatever the path
   * leads to by then, a file is opened without following a link in its last
   * place and used through what was opened, and a save is put in place whole. `base` is a folder from `chats.folder`; `rel` a path
   * in it, as the page sent it. What is refused throws an error with a `code`
   * (see FileRefusal). Use these rather than `fs` on a chat's folder: see
   * "A chat's folder" in the guide.
   */
  files: {
    /** `rel` inside `base`, checked: throws for `..`, an absolute path, or a link that leads out. */
    inside(base: string, rel: string): string;
    /** What is directly in a folder, folders first; `.git` is left out. At most 2,000 entries, and `truncated` says when there were more. */
    list(base: string, rel: string): { path: string; entries: FileEntry[]; truncated: boolean };
    /** A file's text, or that it has none to show. */
    read(base: string, rel: string): FileContent;
    /**
     * A file's bytes as they are, at most 1 MB (`too_large`), with its `change`. With `head`, only that many bytes
     * from the start are read (0: none, to ask for `change` alone).
     */
    readBytes(base: string, rel: string, options?: FileOpenOptions & { head?: number }): FileBytes;
    /**
     * Saves a file's text or bytes, at most 1 MB, through a file beside it put in place by a rename (and the folder
     * synced after, so it lasts through a crash), keeping its mode and its owner. With `expected`, the modification
     * time it was read at, a file changed since is refused (`conflict`); with `create`, one that is there already
     * (`exists`). The answer is the written file's own, with its `change`. With `direct`, `rel` must be a name in
     * `base` itself, reached through no link (see FileOpenOptions). A file that is made, not replaced, has the
     * folder's owner and group and is writable for the folder's group where the folder is, so that the agent, which
     * may be another user than the portal, can go on editing it. Where the portal may not give a file away it stays
     * in the portal's group, and is not writable for that group.
     */
    write(
      base: string,
      rel: string,
      content: string | Uint8Array,
      options?: { expected?: number; create?: boolean; direct?: boolean },
    ): { size: number; mtime: number; change: string };
    /** Another name in the same folder, never over something there; a link is renamed as the link. The new path, from `base`. */
    rename(base: string, rel: string, name: string): string;
    /** What removing `rel` would lose that nothing else has, or null for nothing. */
    unsaved(base: string, rel: string): Promise<Unsaved | null>;
    /** Removes a file, or a folder and all in it, a link as the link. A folder holding git work only it has is refused (`unsaved`) unless `discard`. */
    remove(base: string, rel: string, options?: { discard?: boolean }): Promise<void>;
    /**
     * Takes away one plain file, and nothing else: a link or a folder is refused (`invalid`), where `remove` takes the link
     * or all of the folder. For a server half that deletes a file of its own that the agent can change as it runs: the
     * folder it is in is held open and the name is taken from it, so the file goes from the folder that was checked
     * whatever its path leads to by then, and what is swapped onto the name meanwhile is never followed (a link goes as the
     * link) or taken as a folder (it stays, with all in it). `direct` and `alone` as for `open`. `missing` for a file that
     * is not there.
     */
    removeFile(base: string, rel: string, options?: FileOpenOptions): void;
    /**
     * Another name for one plain file in the folder it is in, never over something there, and a link or a folder is
     * refused (`invalid`). The folder is held as for `removeFile`, and the new name is made as a second name of the file
     * (a hard link, which the system refuses in the call itself for a name that is taken: `exists`, whatever an agent
     * made there since the look) before the old one is removed, so a crash between leaves the file with both names, never
     * with none; its owner, mode and content stay, and its `change` does not. A name the agent swapped for another thing
     * meanwhile is `conflict`, and nothing is renamed. Where hard links are not possible it is a rename after a look.
     * `direct` and `alone` as for `open`; the new path, from `base`.
     */
    renameFile(base: string, rel: string, name: string, options?: FileOpenOptions): string;
    /** A new folder `name` in the folder `rel`, with the mode, owner and group of the folder it is in; its path, from `base`. */
    makeFolder(base: string, rel: string, name: string): string;
    /**
     * The checked path of a folder in `base`, for what reads the whole of it (an archive). With `direct`, a folder
     * that is a name in `base` itself and no link (`invalid` otherwise), for a half that keeps something in a
     * folder of that name.
     */
    folder(base: string, rel: string, options?: { direct?: boolean }): string;
    /**
     * Removes the temporary files that saves in the folder `rel` left behind when they were cut off, and returns
     * their names. Only those older than `olderThanMs` (by default a minute): a save of the portal's own or of
     * another half that is under way has such a file for a moment, and it is not removed under it.
     */
    sweepTemp(base: string, rel: string, options?: { olderThanMs?: number }): string[];
    /**
     * A plain file opened once, to read or send: read from `fd`, not from the path again, and with its `mtime` and
     * `change` as they were when it was opened. A file kept open this way is the file the name had then, whatever
     * is put in its place after. The caller closes it.
     */
    open(base: string, rel: string, options?: FileOpenOptions): { fd: number; size: number; name: string; mtime: number; change: string };
  };
  git: {
    /**
     * git in a folder an agent can write, run as the portal runs its own: no
     * prompt, editor or pager, no colour, and nothing the repository's config
     * would run while it is only read (a filter, an fsmonitor hook, a
     * signature's gpg). A step that writes is `git` as someone would type it,
     * hooks and filters included. What reading turns off is looked up once
     * for the handle: make one for each request rather than keeping it.
     */
    at(folder: string): GitHandle;
  };
  /**
   * A folder of the package's own in the portal's data folder, made (closed to
   * everyone but the portal, 0700) when it is asked for: for what the portal
   * runs as itself on and an agent must not shape, such as a git repository
   * or a database.
   */
  dataDir(): string;
}

/** An extension's server half: the default export of its module. It may return what stops it. */
export type ServerHalf = (portal: ServerPortal) => void | (() => unknown) | Promise<void | (() => unknown)>;
