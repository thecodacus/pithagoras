/**
 * What an extension's server half is given: the `portal` its module's
 * default export is called with, in the portal's own process. The portal
 * implements exactly this, and is checked against it when it is built.
 *
 * See docs/guide/extension-ui.md, "The server half".
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Request, Response, Router, json, raw, text } from "express";

/** What kind of session a chat is: one made in the portal (`task`), one reached through a channel (`agent`), a routine's run, or a heartbeat. */
export type ChatKind = "task" | "agent" | "routine" | "heartbeat";

/** A chat, as an extension's server half is told of it. */
export interface Chat {
  id: string;
  title: string;
  /** The folder the chat works in, as the chat names it. */
  workspace: string;
  status: "idle" | "running" | "error" | "interrupted";
}

/**
 * What happened to a chat's pi: it was `started` or `stopped` (for a reload, for being left idle, or with the
 * portal); the chat was `deleted`; or it is `finished`: the run it was started for is over, and the portal stopped
 * its pi for good, as for a routine run in a session of its own. A person who goes on with the chat starts its pi
 * again (`started`). One stopped for being idle is not finished: it starts again with the next message.
 */
export type ChatLife = "started" | "stopped" | "deleted" | "finished";
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
/** A folder the agents work in: see `folders`. */
export interface AgentFolder {
  path: string;
  /** Its agent's name for an agent's home, else its place under the workspace root. */
  name: string;
  kind: "agent" | "project" | "chat";
  /** The first agent's home, which the sidebar calls Home. */
  home?: true;
}

/**
 * A file opened by `files.open`, to read from `fd` and send. `mimeType` is what
 * its first bytes say it is where it is a picture (PNG, JPEG, GIF, WebP) or a
 * clip a browser plays (WebM, MP4), whatever it is called; absent for any other.
 */
export type OpenedFile = { fd: number; size: number; name: string; mtime: number; change: string; mimeType?: string };

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
  /** As for `FolderUse.likeParent`, and the file as well: one the agents could not read themselves is refused. */
  likeParent?: boolean;
  /** The chats whose agents work in the folder: see `FolderUse.chats`. */
  chats?: readonly string[];
}

/**
 * For what the portal reads or writes as root in a folder that an agent can write next to and so rename things into.
 * The sandbox closes a folder the agent may not enter to root alone (`root:root` mode 0700, a file 0600), and the agent
 * can rename it to the name of a folder the portal reads on its behalf (`documents`), or move such a file into it: then
 * the portal hands the agent what it could not read itself. And it closes a subtree by its top folder only: what is
 * inside keeps the rights the wider rule gave it, so a folder below a closed one is as closed as that one.
 *
 * With `likeParent` the folder, and a file in it, are told as the kernel would for the agents themselves, for the user
 * and the groups the sandbox runs each as: the owner's bits if the agent's user owns it, else the group's if the group
 * is one of the agent's (its own, or the sandbox group), else everyone's. Who owns a folder says nothing (a project is
 * root's, with the sandbox's group set on it, and the closed folder in it is root's too). Every folder of the path from
 * `/` down to the folder must be one they may search, as the kernel needs for a path, the folder itself, as it is held,
 * one they may read and search for what is read from it (`list`, `read`, `readBytes`, `open`, `folder`), write in and search
 * for what is changed in it (`write`, `makeFolder`, `removeFile`, `renameFile`, `sweepTemp`), or both for a folder that is held to
 * (`identity`), and a file one they may read. In a sticky folder (mode 1777) what is taken away, renamed or replaced must
 * be one of their own, as for the kernel. Refused (`invalid`) otherwise. Where the sandbox is off the agent is the
 * portal's own user, and nothing is refused. POSIX ACLs are not read: the mode bits are what is asked, and the
 * sandbox sets no ACL.
 */
export interface FolderUse {
  likeParent?: boolean;
  /**
   * The chats whose agents work in the folder (their ids): every one of them must be able to use it, as what is read in it for one is
   * handed to the others. Those that `chats.inFolder` gives (sessions of every kind, not the tasks of `chats.list` alone), and the session
   * that makes the call, which a call made for an agent always names: where its folder leads is not for it to decide. The agent is not taken from the folder's path, which a link can lead into another
   * agent's home: the sandbox runs a chat's agent by the workspace stored for that chat, and so does this. With `likeParent`
   * and the sandbox on, none named, or one that is not known, is a refusal.
   */
  chats?: readonly string[];
}

/** What `removeFile` and `renameFile` take beyond `FileOpenOptions`. */
export interface FileChangeOptions extends FileOpenOptions {
  /**
   * The folder the file is in must be this one, by its device and inode as `stat` gives them (numbers, text or bigint): another
   * folder at that path, one swapped in since the caller looked, is refused (`conflict`) before anything is touched. It is told
   * from the descriptor of the folder the call then works in, so the folder that was checked is the folder that is changed.
   */
  expect?: { dev: string | number | bigint; ino: string | number | bigint };
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

/**
 * What the guard holds a tool to, as its definition says it: `pi.registerTool({ name, …, guard: { … } })`. Read at
 * each call, for a tool of `chats.extend` and of any package's pi extension, in a chat whose pi runs in the portal's
 * own process. A tool that declares no `guard` is trusted as its extension is: what it returns is not marked as
 * outside content, and no rule after a suspected prompt injection is about it. See "What the guard holds a tool to"
 * in the guide.
 */
export interface ToolGuard {
  /**
   * What it returns is outside content: wrapped as data between markers the content cannot close, and flagged where
   * it tries to instruct the agent, which holds the conversation to the rules after a suspected prompt injection. The
   * paragraph that says such content is data is the portal's, said once in the prompt while such a tool is on.
   */
  outside?: boolean;
  /**
   * The names of its parameters that hold an address the agent chose, a URL or a host. Each value a call has in them
   * (text, or each text of a list) is held to the list of sites in Settings → Guard, where an empty list is any site,
   * and recorded in Audit.
   */
  reaches?: string[];
  /**
   * The rules after a suspected prompt injection that every call of it is the shape of: once the conversation has read
   * a flagged result, a call is held as a command that rule catches. A name that is no rule's is left out.
   */
  acts?: ("pipe-to-shell" | "write-to-path" | "upload" | "read-credentials" | "publish" | "persist" | "delegate")[];
  /**
   * The names of its parameters that hold files (text, or a list of text): a call is approved for each of those files,
   * and for nothing else of it. `approvalFiles` on the definition is the older spelling.
   */
  files?: string[];
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
  /**
   * The folders the agents work in, each by its real path: what a server half
   * that keeps something for what the agents made there (a gallery) looks
   * through, and hears of when one goes.
   */
  folders: {
    /** Every agent's home, every project, and every folder a chat of any kind works in, each once, with what the person calls it. One that is gone is not listed. */
    list(): AgentFolder[];
    /** Whether a folder, by its real path, is one the agents may work in: an agent's home, or one inside the workspace root. Only from one of these is what the agents made there to be served. */
    allowed(folder: string): boolean;
    /**
     * The portal deleted one: a project with its folder, or an agent with its home. `folder` is where it really was, as
     * `list` named it. One deleted while this server half was not running (switched off, removed, or failing to start)
     * it is told of once, when it next starts, as soon as its default export is done; of none deleted before the
     * package first started.
     */
    on(event: "removed", handler: (folder: string) => void): void;
    /**
     * What the person calls a folder, by its real path, whether or not `list` has it now: its agent's name for an
     * agent's home (`home` for the first), its place under the workspace root for a folder inside it, its last part
     * otherwise. For a folder something was kept for after the last chat in it went.
     */
    label(folder: string): { name: string; home?: true };
  };
  /**
   * What an earlier version of the portal kept for something it did itself and an extension now does: when a
   * feature of the portal's own becomes an extension's, the upgrade leaves what it had (its records, its settings,
   * its files) in the portal's data folder under a name for what it was, for whichever extension takes it up, and
   * nothing of it is lost while none does.
   */
  handoffs: {
    /**
     * The folder of what was left under `name`, moved into this package's own folder (`dataDir()`), and nothing when
     * nothing was. The first that asks has it, whole. It stays there until `done`, so a start that stopped half way
     * through reading it finds it again: read it so that reading it twice does no harm.
     */
    take(name: string): string | undefined;
    /** Read: removes what `take` gave. */
    done(name: string): void;
  };
  tools: {
    /**
     * Says which of the tools its pi extension registers (`chats.extend`) it
     * offers now, where that follows its settings: image generation, say,
     * once somebody has set up where pictures are made. Settings → Tools then
     * lists those before any chat has reported them, and leaves out the ones
     * it remembers that are not offered. Asked each time a list is drawn, so
     * keep it quick. After a change, `chats.reload()` gives it to the chats
     * that are open.
     */
    offer(tools: () => { name: string; description?: string }[]): void;
    /**
     * Where these tools are not what the default says, as the portal works it out now: `byDefault`, whether a chat
     * that has never said anything about them has any of them on; the chats that have them otherwise, by their own
     * switches or by their agent's or project's (newest first), each the opposite of `byDefault`; and the routines
     * whose own switches give their runs another answer than a routine that sets nothing would have in the same place
     * (by name), each with its runs' answer (`allowed`). A routine that sets nothing has the browser's tools off until
     * its Browser switch is on, and every other tool as a chat in its place has it. For a page that says who may use
     * them.
     */
    exceptions(names: string[]): { byDefault: boolean; chats: { id: string; title: string; kind: ChatKind }[]; routines: { slug: string; name: string; allowed: boolean }[] };
  };
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
    /**
     * Sends a file opened by `files.open` as the portal sends its own: with
     * its type, a policy that keeps it from running anything, a version a
     * browser revalidates (304), and the part a player asks for (`Range`).
     * A file with no `mimeType` is sent to be saved, under its name, and never
     * shown. `cache` is the Cache-Control (default `private, no-cache`); with
     * `download`, a file name, any file is sent to be saved. Closes the file
     * once sent, or at once when the response is gone already.
     */
    send(req: Request, res: Response, file: Pick<OpenedFile, "fd" | "size" | "name" | "mimeType">, options?: { cache?: string; download?: string }): void;
  };
  chats: {
    get(id: string): Chat | undefined;
    list(): Chat[];
    /**
     * The sessions that work in a folder, of every kind: the tasks `list` gives, and also routine runs, conversations on the Agent page
     * and in channels, and heartbeats, which `list` leaves out and which have the package's tools in their pi as the tasks do. Those
     * whose workspace, stored for them and resolved as `folder` resolves it, is `folder` (a path from `folder(id)`). One session for each
     * agent that has some there, not each session or each stored path: sessions are never removed (a routine that makes a fresh session
     * for each run keeps every one), a stored path can be a link and an agent can make many of them, and what an agent can reach is the
     * same from each of its sessions (the sandbox runs a session as the agent its stored workspace belongs to), so one stands for them all. For what is read
     * or changed in a folder for every agent that works in it (`files.*` with `likeParent`: see `FolderUse.chats`).
     */
    inFolder(folder: string): Chat[];
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
    /** A chat's pi was started or stopped, the chat was deleted, or the run it was started for is over (`finished`, see ChatLife). */
    on(event: ChatLife, handler: (chatId: string) => void): void;
    /** Everything a chat's pi says, as it says it: messages as they stream, tool calls, and what the package's own pi extension sends. */
    onEvent(handler: (chatId: string, event: Record<string, unknown>) => void): void;
    /** To the package's own pi extension in a chat, starting its pi if need be. False where pi does not run in the portal. */
    tell(chatId: string, data: unknown): Promise<boolean>;
    /**
     * Loads every chat's pi that is idle again, as switching a package on or
     * off does: each then has what the server halves add to it now. A chat
     * that is working, compacting or being edited is left as it is until then,
     * and counted as `waiting`.
     */
    reload(): Promise<{ reloaded: number; waiting: number }>;
    /**
     * A pi extension of the package's, made here: registered in every chat's
     * pi as it starts, so its tools hold what this module holds. Only where pi
     * runs in the portal's own process. A tool registered with
     * `offByDefault: true` is off in every chat until somebody switches it on,
     * and one with `guard` is held to what it declares: see ToolGuard.
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
      options?: FolderUse & { expected?: number; create?: boolean; direct?: boolean },
    ): { size: number; mtime: number; change: string };
    /**
     * Another name in the same folder, never over something there; a link is renamed as the link. Done in the folder as it is held, not by
     * its path. The new path, from `base`.
     */
    rename(base: string, rel: string, name: string): string;
    /** What removing `rel` would lose that nothing else has, or null for nothing. */
    unsaved(base: string, rel: string): Promise<Unsaved | null>;
    /**
     * Removes a file, or a folder and all in it, a link as the link: in the folder as it is held once git has answered, and each folder in it
     * through what was opened, so a link put where a folder was goes as the link. A folder holding git work only it has is refused
     * (`unsaved`) unless `discard`; one that is turned into something else while it is removed is `conflict`.
     */
    remove(base: string, rel: string, options?: { discard?: boolean }): Promise<void>;
    /**
     * Takes away one plain file, and nothing else: a link or a folder is refused (`invalid`), where `remove` takes the link
     * or all of the folder. For a server half that deletes a file of its own that the agent can change as it runs: the
     * folder it is in is held open and the name is taken from it, so the file goes from the folder that was checked
     * whatever its path leads to by then, and what is swapped onto the name meanwhile is never followed (a link goes as the
     * link) or taken as a folder (it stays, with all in it). `direct` and `alone` as for `open`; with `likeParent` the folder
     * `base` must be one the agent could use (`invalid` otherwise, see `FolderUse`). `missing` for a file that is not
     * there. `expect`: the folder must be that one (`conflict` otherwise).
     */
    removeFile(base: string, rel: string, options?: FileChangeOptions): void;
    /**
     * Another name for one plain file in the folder it is in, never over something there, and a link or a folder is
     * refused (`invalid`). The folder is held as for `removeFile`, and the new name is made as a second name of the file
     * (a hard link, which the system refuses in the call itself for a name that is taken: `exists`, whatever an agent
     * made there since the look) before the old one is removed, so a crash between leaves the file with both names, never
     * with none; its owner, mode and content stay, and its `change` does not. A name the agent swapped for another thing
     * meanwhile is `conflict`, and nothing is renamed. If the old name cannot be removed the new one is given up again, but
     * never when it is the file's only name (a folder took the old name), where the rename stands. A name the file system does
     * not tell from the old one (capitals, or the form of a letter, on macOS, Windows or a casefold folder) is the old name
     * itself: `exists`. Where hard links are not possible it is a rename after a look. `direct` and `alone` as for `open`,
     * `likeParent` and `expect` as for `removeFile`; the new path, from `base`.
     */
    renameFile(base: string, rel: string, name: string, options?: FileChangeOptions): string;
    /**
     * A new folder `name` in the folder `rel`, with the mode, owner and group of the folder it is in; its path, from `base`. With `likeParent`
     * (and `chats`) the folder it is made in must be one the agents could write in and reach, else it is refused (`invalid`) and nothing is made.
     */
    makeFolder(base: string, rel: string, name: string, options?: FolderUse): string;
    /**
     * The checked path of a folder in `base`, for what reads the whole of it (an archive). With `direct`, a folder
     * that is a name in `base` itself and no link (`invalid` otherwise), for a half that keeps something in a
     * folder of that name.
     */
    folder(base: string, rel: string, options?: FolderUse & { direct?: boolean }): string;
    /**
     * Which folder `rel` is, on this system: its device and inode as text, read from the folder as it is held, so that it is
     * the folder the checks were made on and not what its path leads to by then. No two folders have the same pair at once, a
     * folder that is moved keeps it and one that is deleted and made again does not: for a server half that holds to a folder
     * and must tell it from another at the same path. A number can be given to the next folder made, so it says that a
     * folder is the one it was while it exists, not for ever. `direct` and `likeParent` as for `folder`; with `likeParent` the
     * folder that is given an identity is the one that passed (a closed folder is `invalid`, also when it was swapped in
     * between a look at the path and this call).
     */
    identity(base: string, rel: string, options?: FolderUse & { direct?: boolean }): { dev: string; ino: string };
    /**
     * Removes the temporary files that saves in the folder `rel` left behind when they were cut off, and returns
     * their names. Only those older than `olderThanMs` (by default a minute): a save of the portal's own or of
     * another half that is under way has such a file for a moment, and it is not removed under it.
     */
    sweepTemp(base: string, rel: string, options?: FolderUse & { olderThanMs?: number }): string[];
    /**
     * A plain file opened once, to read or send: read from `fd`, not from the path again, and with its `mtime` and
     * `change` as they were when it was opened. A file kept open this way is the file the name had then, whatever
     * is put in its place after. `mimeType` says what it is by its first bytes, for a picture or a clip; what it may
     * be is the caller's to decide. The caller closes it.
     */
    open(base: string, rel: string, options?: FileOpenOptions): OpenedFile;
    /**
     * Keeps `data` as a new file called `name` in the folder `rel`: what a
     * server half makes for the person, a picture say. Written beside its place
     * and put there whole, never over something that is there: a name that is
     * taken gets a number ("cat (2).png"). Returns its path, from `base`.
     */
    create(base: string, rel: string, name: string, data: Buffer): string;
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
   * or a database. Its real path, so it can be given to `files` as a `base`.
   */
  dataDir(): string;
}

/** An extension's server half: the default export of its module. It may return what stops it. */
export type ServerHalf = (portal: ServerPortal) => void | (() => unknown) | Promise<void | (() => unknown)>;
