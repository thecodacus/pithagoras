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

/** A folder held open by `files.hold`: it stays the folder that was checked, whatever is done to its path after. */
export interface HeldFolder {
  /** Where this process names it: through the open descriptor on Linux, else the checked path. */
  path: string;
  /** The open descriptor (Linux), to be given to a child process in its `stdio`; none where the system cannot name descriptors. */
  fd?: number;
  /** The folder's own name, for a file made of it (`site` for `site.tar.gz`); empty for the chat's folder. */
  name: string;
  /** Where a child process that was given `fd` as its stdio number `n` names the folder: `spawn("tar", ["-C", held.inChild(3), "."], { stdio: ["ignore", "pipe", "pipe", held.fd] })`. */
  inChild(n: number): string;
  /** The caller closes it, also when the child failed to start. */
  close(): void;
}

/** What `files.watch` tells: something in the folder may have changed, or (`gone`) the folder itself was removed, renamed or replaced, and the watch has ended. */
export interface FolderChange {
  gone?: true;
}

/** A watch on a folder, from `files.watch`. */
export interface FolderWatch {
  /** Whether the folder at its place is still the one that is watched: a folder deleted and made again at the same path is another. */
  current(): boolean;
  /** Stops the watch. Safe to call again. */
  close(): void;
}

/** What opens a file for `files.open` and `files.readBytes`, beyond the checks every path gets. */
export interface FileOpenOptions {
  /**
   * `rel` must be a name in `base` itself, reached through no link: refused (`invalid`) when following links led it
   * anywhere else, even to another file in the folder. For a file that is to be only what its name says.
   */
  direct?: boolean;
  /** A file with a second name (a hard link, which may be outside the folder) is refused (`invalid`). */
  alone?: boolean;
  /** As for `FolderUse.likeParent`, and the file as well: one the agent could not read itself is refused. */
  likeParent?: boolean;
}

/**
 * For what the portal reads or writes as root in a folder that an agent can write next to and so rename things into.
 * The sandbox closes a folder the agent may not enter to root alone (mode 0700, or 0750 for its tools' group), and the
 * agent can rename it to the name of a folder the portal reads on its behalf (`documents`): then the portal hands the
 * agent what it could not read itself. With `likeParent`, the folder (`base`; for `folder` the folder it names) is
 * refused (`invalid`) unless the agent that works in the folder it is in could use it: it is owned by the same user,
 * or its group is that folder's and may read it, or everyone may. Where the sandbox is off nothing is closed, and
 * nothing is refused that the portal's own user could not read.
 */
export interface FolderUse {
  likeParent?: boolean;
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

/** One page that asked to listen to a topic of the package's, as `onListen` is handed it. */
export interface PageListener {
  /** To this page alone: where things stand, the first thing it hears. */
  send(data: unknown): void;
}

/**
 * Whether a page may listen to a topic, and what to do when it stops. Return `false` (or throw) to refuse; return a
 * function to be called once when the page stops listening (it left, its tab closed, its login ended, or this half
 * stopped), to undo what was started for it. May be async: a page waits for the answer, and one that takes over ten
 * seconds is refused.
 */
export type ListenHandler = (topic: string, page: PageListener) => void | false | (() => void) | Promise<void | false | (() => void)>;

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
  /**
   * To the pages that listen to `topic` of the package's (`portal.server.on(topic, …)` in the browser half), on
   * whichever page of the portal: one with no chat open, as well as one that has. A topic is a name of at most 200
   * characters, the package's own: another package's page does not hear it, and it cannot send under another's name.
   * `data` must be JSON. Nothing is stored: a page that was not listening misses it, so tell where things stand in
   * `onListen` as a page begins to listen. Pages open on a chat are told with `chats.send`.
   */
  push(topic: string, data: unknown): void;
  /**
   * The rule for who may listen to a topic of the package's, and what a page that does is told first. Called for each
   * page that asks, with the topic as it wrote it: check that it names something the package has (a folder a chat works in,
   * a document that is there) and refuse otherwise, so that a page cannot listen to what it could not otherwise see; and
   * tell `page` where things stand, which it hears before anything pushed after. Whatever is pushed while the handler is
   * still working reaches the page after it has answered, and not at all if it refuses, so tell the state, not an event
   * that may repeat it. The portal has one login, so every page that is signed in is the same person: with no handler,
   * any page may listen to any topic of the package's.
   */
  onListen(handler: ListenHandler): void;
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
     * Says something to a chat's agent as a message of the package's: it is put in the conversation, where the person
     * reads it as a notice, after the turn that is going on, or at once (a turn starts) when the agent is idle. The
     * chat's pi is started if it was let go. Resolves true once pi has taken it (the run it starts is not waited for),
     * false where pi does not run in the portal's own process; rejects where the chat is gone or its pi could not
     * start. `details` is kept with the message for the package's own tools and cards; `type` names the kind of
     * message when the package has several (the message is the package's `<name>:<type>`).
     */
    followUp(chatId: string, message: { text: string; details?: unknown; type?: string }): Promise<boolean>;
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
    list(base: string, rel: string, options?: FolderUse): { path: string; entries: FileEntry[]; truncated: boolean };
    /** A file's text, or that it has none to show. */
    read(base: string, rel: string, options?: FolderUse): FileContent;
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
      options?: { expected?: number; create?: boolean; direct?: boolean; likeParent?: boolean },
    ): { size: number; mtime: number; change: string };
    /** Another name in the same folder, never over something there; a link is renamed as the link. The new path, from `base`. */
    rename(base: string, rel: string, name: string): string;
    /** What removing `rel` would lose that nothing else has, or null for nothing. */
    unsaved(base: string, rel: string): Promise<Unsaved | null>;
    /** Removes a file, or a folder and all in it, a link as the link. A folder holding git work only it has is refused (`unsaved`) unless `discard`. */
    remove(base: string, rel: string, options?: { discard?: boolean }): Promise<void>;
    /** A new folder `name` in the folder `rel`, with the mode, owner and group of the folder it is in; its path, from `base`. */
    makeFolder(base: string, rel: string, name: string): string;
    /**
     * The checked path of a folder in `base`, for what reads the whole of it (an archive). With `direct`, a folder
     * that is a name in `base` itself and no link (`invalid` otherwise), for a half that keeps something in a
     * folder of that name.
     */
    folder(base: string, rel: string, options?: { direct?: boolean; likeParent?: boolean }): string;
    /**
     * A folder opened once and held, for a child process that reads all of it (an archive by `tar`): `folder` gives a
     * path, and a child started with it reads whatever a link put on the way leads to by then. The folder is opened
     * without following a link in any place on the way, from `base` down, and the child names it through the
     * descriptor it is given. The caller closes it. Refuses what `folder` refuses, and a folder the portal may not read.
     */
    hold(base: string, rel: string, options?: { direct?: boolean }): HeldFolder;
    /**
     * A file that arrives as a stream, put in the folder `rel` under `name`: written to disk as it comes (a big file is
     * never held in memory) and put in place only once all of it has, never over something there: a taken name gets a
     * number (`report (2).pdf`). `body` is a request, or anything iterable in chunks. Resolves with the path from `base`
     * and the size. More than `maxBytes` (by default 2 GB) is refused (`too_large`) as soon as it is crossed; a
     * sender that went away is `failed`; nothing is left behind by a file that did not arrive whole. Nothing is done
     * to `body` here, so an answer can still be sent on the request after a refusal.
     */
    upload(base: string, rel: string, name: string, body: AsyncIterable<Uint8Array>, options?: { maxBytes?: number }): Promise<{ path: string; size: number }>;
    /**
     * Tells `onChange` when something in the folder `rel` may have changed (a file made, written, renamed or removed in
     * it), once the burst of changes is over (`debounceMs`, by default 100); it says no more than that, so look at what
     * changed through `files.list` or `readBytes`. The watch is on the folder as it is held when this is called, not on
     * what its path leads to later: a link put in its place does not lead it elsewhere. When the folder itself is
     * removed, renamed or replaced the watch ends by itself, after `onChange({ gone: true })`: watch the folder that is
     * there now. A system that cannot watch (too many watches, a file system that has none) is `failed`, with its code
     * in `errno`: look at the folder every so often instead. `direct` as for `folder`.
     */
    watch(base: string, rel: string, onChange: (change: FolderChange) => void, options?: { direct?: boolean; debounceMs?: number }): FolderWatch;
    /**
     * Removes the temporary files that saves in the folder `rel` left behind when they were cut off, and returns
     * their names. Only those older than `olderThanMs` (by default a minute): a save of the portal's own or of
     * another half that is under way has such a file for a moment, and it is not removed under it.
     */
    sweepTemp(base: string, rel: string, options?: { olderThanMs?: number; likeParent?: boolean }): string[];
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
   * The processes of the host, read from `/proc` (Linux; elsewhere `stat` finds nothing and `signalSession` signals
   * nobody). For a package that runs a shell or a job of its own and must find, and end, what that started.
   */
  proc: {
    /**
     * The fields of `/proc/<pid>/stat` after the command's name, which may hold spaces: `[0]` is the state, `[1]` the
     * parent, `[2]` the process group and `[3]` the session. Undefined when there is no such process.
     */
    stat(pid: number | string): string[] | undefined;
    /**
     * Signals every process of a session and says which they were. It walks `/proc`, every process of the host, a batch at
     * a time so that the portal's other work is not held up while it does; a process that is gone already, or is not the
     * portal's to signal, is left out.
     */
    signalSession(session: number, signal: NodeJS.Signals): Promise<number[]>;
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
