/**
 * What an extension's server half is given: the `portal` its module's
 * default export is called with, in the portal's own process. The portal
 * implements exactly this, and is checked against it when it is built.
 *
 * An error of its code that nothing catches, a promise of its that rejects with
 * nobody to hear it, and a call of `process.exit()` from it, are its crash: it is
 * stopped and held off until another version is installed or it is switched off
 * and on, and the portal goes on.
 *
 * Or in a process of its own: `"isolated": true` beside `"server"` in its
 * package.json, and always for a package installed from an extension's data
 * folder. The same `portal`, its calls made in the portal's process; a loop
 * that never yields (10 s), a heap over 512 MB, memory over 1 GB (Linux), a
 * native crash or an exit end that process, as its crash. What it cannot have
 * there is said on the members it touches: `provide`, `extensions.use`,
 * `voice`, `chats.extend`.
 *
 * See "The server half", "A server half in a process of its own" and "When the
 * server half crashes" in "Building an extension":
 * https://thecodacus.github.io/pithagoras/guide/extension-ui
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
  /** What kind of chat it is. Not there for a task, a chat made on the portal's pages. */
  kind?: Exclude<ChatKind, "task">;
  /**
   * The mode it was started in, as it stores it: "<package>/<id>" for an extension's (`modes.provide`), "custom/<id>"
   * for one the person made, the portal's own by name ("code"). Not there for Standard.
   */
  mode?: string;
  /**
   * A child chat's (`chats.create`): the chat it was made for. A child is deleted with its parent, and has no children
   * of its own.
   */
  parent?: string;
  /**
   * A chat a server half made's (`chats.create`, `chats.start`): whether it shows in the chat lists, a child under its
   * parent. One that does not is found by its id alone.
   */
  listed?: boolean;
  /** Made for nobody to attend (`ChildChatOptions.unattended`). */
  unattended?: true;
}

/** What a child chat is made with: see `chats.create`. */
export interface ChildChatOptions {
  /** The chat it works for: its folder is the child's, and so are its role, its last speaker and (see `tools`) its tool switches. */
  parent: string;
  title: string;
  /**
   * A mode the child may be put in, as a chat stores it (see `Chat.mode`). Left out, it is in its parent's, so a mode
   * that took tools away does not stop at a child; "standard" puts it in none, and the tools its parent's mode took
   * away stay off for it. Naming its parent's own mode is the same as leaving it out, but is refused if that mode is
   * not there for a child.
   */
  mode?: string;
  /** The model it runs on; the model of a mode that is named, else its parent's, when left out. */
  model?: ModelRef;
  /**
   * Whether it shows in the chat lists, under its parent (the default), or is found by its id alone. A child of a chat
   * that is not listed is not listed either, whatever this says: it would stand in the lists on its own.
   */
  listed?: boolean;
  /**
   * A chat nobody attends, wherever its parent is: for work the person does not watch, such as an answer an extension
   * posts elsewhere. It is not offered `ask_question`; every dialog an extension opens in it is answered at once with
   * its no-answer value (a confirm with false, a select or an input with nothing), as in a routine run; and a call the
   * guard holds after a suspected prompt injection is refused rather than put to the person. The agent gets each
   * refusal as the tool's result and goes on. It has no routine tools either (in an agent's home, where a chat has
   * them), as a routine run has none. Kept with the chat, so it holds after the portal restarts. Its tools are the
   * folder's `"defaults"` unless `tools` says otherwise. A child of an unattended chat is unattended itself, whoever
   * makes it and whether or not it says so: its parent's page, where its dialogs would go, is one nobody opens.
   */
  unattended?: true;
  /**
   * Which tools it has: `"parent"` (the default, except for an unattended child) the tools the person switched off or
   * on in its parent, and the ones its parent's mode took away where it is in another mode; it is held to its parent's
   * switches as they are before each message. `"defaults"` the tools a new chat of the folder has in its mode, as
   * Settings → Tools, its agent and its project say, with none of its parent's switches: for work of the package's that
   * is not the conversation the person switched them for.
   */
  tools?: "parent" | "defaults";
}

/** What a chat a package starts in a folder is made with: see `chats.start`. */
export interface StartChatOptions {
  /** The folder of an agent or a project, by its path as `folders.list()` gives it (where it really is). */
  folder: string;
  title: string;
  /**
   * Whether it shows in the chat lists (the default), or is found by its id alone. One that does not is refused unless
   * it is `unattended` too: with no parent, it has no row to say it waits on the person, nor a page anybody finds.
   */
  listed?: boolean;
  /** A chat nobody attends: see `ChildChatOptions.unattended`. */
  unattended?: true;
}

/**
 * How a run of a child chat ended (`chats.prompt`): `done`, `stopped` (by `chats.abort`, by the person, or because the
 * chat was deleted), or `error`, with what went wrong. `answer` is the last thing it said, which may be nothing.
 */
export interface ChildRun {
  status: "done" | "stopped" | "error";
  answer: string;
  /**
   * Set when the child had read outside content that holds a chat back (the guard marked it). The portal has marked its
   * parent with it already, so its rules for a marked chat hold what the parent does with this answer. That mark is in
   * the guard that runs now: an answer handed on is written in the form of a flagged result for it to be found again
   * when the guard is made again (see "Child chats" in the guide).
   */
  marked?: true;
  error?: string;
}

/**
 * Where the last run of a chat a package made stands (`chats.lastAnswer`), from what the portal keeps: `running` while
 * it goes on, else how it ended as for `ChildRun` (a run the portal's restart cut off is `stopped`, with an `error`
 * that says so). `answer` is the last thing it said in that run, which may be nothing (and, while it runs, the last
 * message it finished). `marked` is there while the guard holds the chat as marked: it read something that looked like
 * a prompt injection that the person has not trusted.
 */
export interface ChatAnswer {
  status: "running" | ChildRun["status"];
  answer: string;
  marked?: true;
  error?: string;
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

/** The role of a person the agents work with, as People sets it: see "People" in the guide. */
export type PersonRole = "primary" | "colleague" | "guest" | "unknown";

/**
 * Who is behind a request to the package's routes (`http.person`). Every login to the portal is its owner's for now:
 * `{ id: "owner", name, role: "primary" }`, with the name People gives the person marked primary ("Owner" while nobody
 * is). Check `role` where what a request asks the agents to do depends on who asks: logins with fewer rights would say
 * theirs here.
 */
export interface RequestPerson {
  id: string;
  name: string;
  role: PersonRole;
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
  /**
   * The first agent's home: the default agent, the one a chat, a channel or a routine goes to when none is named, and
   * whose user the sandbox runs a chat as that is in no agent's home. It cannot be deleted, so one folder of `list` has
   * it as long as its home is there.
   */
  home?: true;
  /**
   * The home of the agent the New button starts the person's chats with: the first agent's (`home`) unless the person
   * picked another on its Agent page ("New chats start here"). Where something new of the person's goes that belongs to
   * no chat, such as a document made from a tab; the sidebar's house icon marks it.
   */
  newChats?: true;
}

/** Whose a chat is: see `chats.owner`. An agent's home or a project's folder, as `folders.list()` gives it. */
export type ChatOwner = AgentFolder & { kind: "agent" | "project" };

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
 * outside content, and of the rules after a suspected prompt injection only `read-credentials` holds it, as it holds
 * every tool, where its `path` or `file_path` argument names a place secrets are kept. A name like a browser's
 * (`browser_` at the start, or after `_` or `.`) holds a tool to the browser's rules, declared or not. See "What the
 * guard holds a tool to" in the guide.
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

/** A model, by its provider and its id, as pi names them (`provider/id`). */
export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * The subagent protocol: how a pi extension that runs an agent of its own lets the portal show it beside the chat, and
 * lets the person talk to it and stop it. It rides on the chat's event bus (`pi.events`, given to `chats.extend`'s
 * factory and to any pi extension in a chat whose pi runs in the portal's own process), so a pi extension that speaks it
 * needs nothing of the portal and does nothing different where nobody listens. Each channel by its name, with what is
 * sent on it: the portal's own copy of the names is checked against these. See "The subagent protocol" in the guide.
 */
export interface SubagentProtocol {
  /** Extension → portal: one has started, or waits for its turn to. */
  "subagent:v1:start": SubagentStart;
  /** Extension → portal: one of its child's pi events, as `pi --mode json` or `--mode rpc` print them. */
  "subagent:v1:event": SubagentEvent;
  /** Extension → portal: it is over. */
  "subagent:v1:end": SubagentEnd;
  /** Portal → extension, only where `start` said `input: true`: a message for it (an RPC `steer`, say). */
  "subagent:v1:input": SubagentInput;
  /** Portal → extension, only where `start` said `stop: true`. */
  "subagent:v1:stop": SubagentStop;
  /**
   * Asked by the extension, answered at once, as the bus is synchronous. The portal answers `{}`: what a chat's
   * subagents run on is the extension's own to keep (the bundled subagent extension keeps it per chat).
   */
  "subagent:v1:config": SubagentConfig;
}

export interface SubagentStart {
  /** Its id, the same on every channel, until its `end`. */
  id: string;
  /** What the person calls it: "Research: vector DBs". */
  label: string;
  /** The tool call that started it, whose card gets a Watch button. */
  toolCallId?: string;
  /** It takes `subagent:v1:input`. */
  input?: boolean;
  /** It takes `subagent:v1:stop`. */
  stop?: boolean;
  /** What it is doing, until its child says: "Starting on provider/model", "Waiting for a free slot". */
  detail?: string;
  /** It runs on after the tool call that started it has returned (in the background), so the end of that call is not its end. */
  detached?: boolean;
  /**
   * It works in a chat of the portal's (a child chat, `chats.create`), by that chat's id: its run is that chat's own
   * transcript, which a page draws from there and opens at `/s/<chat>`, so it sends no `subagent:v1:event` of its own.
   */
  chat?: string;
}

export interface SubagentEvent {
  id: string;
  /** The child's event, with its `type`: drawn as the chat's own are. */
  event: { type: string; [key: string]: unknown };
}

export interface SubagentEnd {
  id: string;
  status: "done" | "error" | "stopped";
  /** Why it failed, where it did. */
  error?: string;
}

export interface SubagentInput {
  id: string;
  text: string;
}

export interface SubagentStop {
  id: string;
}

export interface SubagentConfig {
  /** Called at once: `model` is "provider/model" or "auto" where whoever answers says one, and not there otherwise (the portal says none). */
  reply(config: { model?: string }): void;
}

/** Where a model is asked, and how a request signs in there: see `models.endpoint`. */
export interface ModelEndpoint {
  /** What it speaks, as pi says it: "openai-completions", "anthropic-messages"… */
  api: string;
  /** Its address, with no slash at the end, or "" where pi has none: for "openai-completions", where `/chat/completions` is. */
  baseUrl: string;
  /** The headers its provider adds to a request. The key is not among them: see `key`. */
  headers: Record<string, string>;
  /**
   * The provider's key, where it has one. A request carries it as `api` takes a key: for "openai-completions", as
   * `authorization: Bearer <key>`.
   */
  key?: string;
  /**
   * The provider's key is a command pi runs (`!…`), whose answer is `key`: fit for a request now, not for keeping
   * where it outlives the request, such as a container's environment.
   */
  keyFromCommand: boolean;
}

/** A provider set up by its address (pi's models.json), with its models: see `models.list`. */
export interface ModelProvider {
  provider: string;
  /** What it speaks, where models.json says it for the provider. */
  api?: string;
  baseUrl?: string;
  /** Its models' ids. */
  models: string[];
}

/** One server of pi's mcp.json, in the shape pi-mcp-adapter reads: `url`, `command` or `socket`, and what else the adapter takes. */
export type McpEntry = Record<string, unknown>;

/** What holds the agent's memory in place of MEMORY.md: see `memory.hold`. */
export interface MemoryHolder {
  /** What the portal calls it where it says what holds the memory. */
  label: string;
  /** Said to the agent in a chat with the person, in place of MEMORY.md: how to reach the memory, and when. */
  rule: string;
  /** Whether it holds the memory now. Asked each time a chat's prompt is built: keep it quick, and give a boolean, not a promise. */
  on(): boolean;
}

/** A voice a voice provider speaks with: what an agent's voice is chosen from (see `VoiceProvider.state`). */
export interface ProvidedVoice {
  /** What `speak` is given, and what an agent keeps as its voice. */
  id: string;
  /** What the Agents page calls it: shown as it is, unless `builtIn`. */
  name: string;
  /**
   * True for a voice the provider has of itself, whose name is its own text in English: the portal shows that name
   * through the extension's translations. A voice the person added is shown by the name they gave it.
   */
  builtIn?: boolean;
}

/** What an extension offers voice mode: speech recognition, speech synthesis, and the voices it speaks with. */
export interface VoiceProvider {
  /** What the portal calls it where it names voice mode's source, in English: shown through the extension's own translations. */
  label: string;
  /**
   * What it offers now; nothing while it cannot be used, and voice mode then says that it is not running. `speaks`
   * false: it recognises speech alone, so dictation works and replies are not spoken. `voices` is what an agent's voice
   * is chosen from. Asked at each request and as each prompt is built: keep it quick, and give a value, not a promise.
   */
  state(): { speaks: boolean; voices: ProvidedVoice[] } | undefined;
  /**
   * The words said in `wav`: one recording, a 16 kHz mono 16-bit WAV of at most 12 MB. `purpose` is "dictation" for the
   * message box's microphone and "voice" for voice mode. `signal` ends when the page gives up, or after two minutes.
   * Throws with what the page should say.
   */
  transcribe(wav: Buffer, options: { purpose: "voice" | "dictation"; signal: AbortSignal }): Promise<string>;
  /**
   * One phrase of at most 600 characters, spoken in `voice`: an id from `state().voices`; undefined, or an id it no
   * longer has, is its own choice. Answers an ok Response whose body is `audio/pcm` (mono, 24 kHz, signed 16-bit
   * little-endian, passed on to the page as it arrives; an `x-sample-rate` header, where there is one, says 24000) or
   * `audio/wav` (mono, 24 kHz, 16-bit PCM, read whole and checked). `signal` as for `transcribe`. Throws with what the
   * page should say.
   */
  speak(text: string, options: { voice?: string; signal: AbortSignal }): Promise<globalThis.Response>;
  /**
   * Voice mode began (true) or stopped (false) being used anywhere. Awaited when it begins; a throw is the page's error.
   * Given 120 seconds: one that has not settled by then counts as failed.
   */
  use?(inUse: boolean): Promise<void>;
}

/** A mode a chat can be started in, which an extension offers: see `modes.provide`. */
export interface ChatMode {
  /**
   * Its name among the package's modes: lower-case letters, digits and "-", starting with a letter or a digit. A chat
   * in it stores "<package>/<id>".
   */
  id: string;
  /** What the picker above the message box calls it, in English: shown through the extension's own translations. */
  label: string;
  /** The line under the label, in English, translated the same way. */
  description: string;
  /**
   * Shown, with a yes or no, before a chat is put in it, in English, translated the same way. A yes is in the audit
   * log. It warns the person; it is no gate against code that has their login, such as a browser half.
   */
  confirm?: string;
}

/** Where an installed extension stands: see `extensions.status`. */
export interface ExtensionStatus {
  name: string;
  version?: string;
  /** What it is installed by, as Settings → Extensions lists it. */
  spec: string;
  /** Whether it is switched on. One the person switched off stays off, installed again or not. */
  enabled: boolean;
  /**
   * The extension whose own `dataDir()` it was installed from; and the note that extension gave and when (an ISO
   * time), where it installed it with `extensions.install` (not where the person installed that folder in Settings).
   */
  installedFrom?: { extension: string; note?: string; at?: string };
  /**
   * Its server half, where it declares one: whether it runs, why not, the crash it is held off for, and its latest
   * lines (up to 200, oldest first, after `since` where that was given), with what looks like a secret taken out.
   */
  server?: {
    running: boolean;
    failure?: string;
    crash?: { rev: string; at: string; error: string; stack?: string };
    lines: { id: number; at: string; level: "debug" | "info" | "warn" | "error"; text: string }[];
  };
  /** What a page said last failed of its browser half, at the revision installed now. */
  client?: { error: string; stack?: string };
  /**
   * Where `chatId` was asked: what that chat could not load of it at its last load (a factory of its server half that
   * threw, a tool whose name another had). Empty while the chat's pi is not running.
   */
  loadErrors?: { error: string }[];
}

/** What `extensions.install` answers: where the extension stands once installed, and the open chats given it. */
export type ExtensionInstalled = ExtensionStatus & { reloaded: number; waiting: number };

export interface ServerPortal {
  /** Of this interface: raised when something an extension relies on changes. */
  version: 1;
  /** The package's name. */
  extension: string;
  /** How pi is run here: "host" is in the portal's own process, where a chat's pi and this module can reach each other. */
  executor: string;
  /** A line in the portal's log, kept with the extension's own lines: what Settings → Extensions shows of it should it crash. */
  log(text: string): void;
  audit: {
    /**
     * A row in Settings → Audit, of the kind "Extension", under this extension's name: `subject` what it was done to
     * (a name, a path: shown as it is), `reason` a short text in English, shown through the extension's own translations,
     * and `chatId` the chat it was done for, kept as given (a chat deleted since is still named by its id, as the guard's
     * rows are). Throws a TypeError for an empty subject.
     */
    record(entry: { subject: string; reason?: string; chatId?: string }): void;
  };
  /**
   * What this extension gives the extensions that build on it, those that name it in `pithagoras.requires` or
   * `pithagoras.optional` in their package.json. `factory` is called once for each of them, with its name, when it first
   * asks (`extensions.use`), and what it returns is what that one gets: one for each lets an extension keep apart what each
   * does with it. Those that build on it start after it, and are stopped before it and started again whenever it is.
   * Throws in a server half in a process of its own: nothing builds on that (one that requires it does not start).
   */
  provide(factory: (consumer: { name: string }) => unknown): void;
  /**
   * The folders the agents work in, each by its real path: what a server half
   * that keeps something for what the agents made there (a gallery) looks
   * through, and hears of when one goes.
   */
  folders: {
    /**
     * Every agent's home, every project, and every folder a chat of any kind works in, each once, with what the person
     * calls it. One that is gone is not listed. The default agent's home is the one with `home`, the home of the agent
     * New starts chats with the one with `newChats` (see AgentFolder).
     */
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
     * agent's home (`home` for the first, `newChats` for the one New starts chats with, as in `AgentFolder`), its place
     * under the workspace root for a folder inside it, its last part otherwise. For a folder something was kept for
     * after the last chat in it went.
     */
    label(folder: string): { name: string; home?: true; newChats?: true };
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
     * switches or by their agent's, project's or mode's (newest first), each the opposite of `byDefault`; and the
     * routines whose own switches give their runs another answer than a routine that sets nothing would have in the
     * same place (by name), each with its runs' answer (`allowed`). A routine that sets nothing has each tool as a
     * chat in its place has it. For a page that says who may use them.
     */
    exceptions(names: string[]): { byDefault: boolean; chats: { id: string; title: string; kind: ChatKind }[]; routines: { slug: string; name: string; allowed: boolean }[] };
  };
  extensions: {
    /**
     * What an extension this one builds on gives it (see `provide`): one its package.json names in `pithagoras.requires`,
     * which is always there (without it this one does not start, and Settings → Extensions says why), or in
     * `pithagoras.optional`, which may not be: nothing then, or while it is not in a version this one takes. This one is
     * started again when such an extension comes or goes. Naming one that is in neither is an error. In a server half in
     * a process of its own, of an extension in the portal's process: the same object, its data copied, each of its
     * functions one that returns a promise and runs as that extension's code; a function given to one (a callback) is
     * called across, and one in what it answers cannot cross. One in a process of its own gives nothing to use.
     */
    use<T = unknown>(name: string): T | undefined;
    /**
     * Installs the package in `folder`, a folder in this extension's own `dataDir()`, which no agent can write, and loads it
     * as an install in Settings does: its server half started, the pages given its browser half, the open chats loaded
     * again (an idle one at once, a working one at its next step). The same folder installed again is loaded again in
     * place, every half at its new revision. Settings → Extensions shows that it came from this extension, with `note`.
     * Its server half runs in a process of its own, as every package from an extension's data folder does.
     * Rejects for a folder outside `dataDir()`, one with no package.json or no valid name, and a name that one of the
     * portal's own extensions has (those it comes with, and those it gives every chat's pi, such as `sandbox` and
     * `guard`) or that a package installed from elsewhere has. Installs and removals of every extension
     * run one at a time. Rejects at once while this half is starting, or once it stopped: the server halves follow an
     * install, and they would wait for this one.
     */
    install(folder: string, options?: { note?: string }): Promise<ExtensionInstalled>;
    /**
     * Uninstalls a package installed from this extension's `dataDir()`, as Remove in Settings does, and loads the open
     * chats again. Its files are left: they are this extension's, in its own folder. Rejects for a package from anywhere
     * else, and as `install` does while this half is not running.
     */
    remove(name: string): Promise<{ reloaded: number; waiting: number }>;
    /** Where an installed extension stands now (see ExtensionStatus); nothing for a name that is not installed. */
    status(name: string, options?: { chatId?: string; since?: number }): Promise<ExtensionStatus | undefined>;
  };
  /**
   * The models the chats use, and how to reach them: for a server half that asks a model itself, such as the one the
   * chat asking it is on.
   */
  models: {
    /**
     * The model a chat is on now: the one its pi has, where it runs, else the one stored for it. Without a chat, the
     * one new chats start on. Nothing for a chat that is not known, or where no model is chosen.
     */
    of(chatId?: string): Promise<ModelRef | undefined>;
    /**
     * Where a model pi knows is asked, with the provider's key: rejects for one it does not know. The key is the
     * person's, for that model's own address.
     */
    endpoint(provider: string, id: string): Promise<ModelEndpoint>;
    /** The providers set up by their address (pi's models.json), with their models. Services pi has built in are not listed. */
    list(): ModelProvider[];
  };
  /**
   * MCP servers, as pi-mcp-adapter makes them the chats' tools: named `<server>_<tool>`, and switched in Settings → MCP
   * and Settings → Tools as any other server's are.
   */
  mcp: {
    /**
     * The server of that name in pi's mcp.json, and whether the chats have its tools now (`on`): it is there, not
     * switched off, and pi-mcp-adapter, which makes its tools, is installed and on. The file is read again only when
     * it, or pi's settings, changed. Nothing where there is no such server, or the file cannot be read.
     */
    get(name: string): { entry: McpEntry; on: boolean } | undefined;
    /**
     * Writes the server of that name into pi's mcp.json (a file for the portal's user alone), in place of what was
     * there under that name, or removes it (`undefined`). Writing one installs pi-mcp-adapter where it is not
     * installed, and switches it on where it is off, which waits for the server halves to follow: not while this
     * half starts. `trusted`: the person counts what its tools return as their own, not outside content; the name
     * is added to Settings → Guard's trusted servers, where they can take it out. Removing the server takes the name
     * out of them again, so a server given that name later is not trusted unasked. Then the open chats are loaded
     * again, as `chats.reload` does, and what that answers is answered. Rejects while the file cannot be read, which
     * is the person's to fix in Settings → MCP, and for a name or a server the adapter would not take.
     */
    set(name: string, entry: McpEntry | undefined, options?: { trusted?: boolean }): Promise<{ reloaded: number; waiting: number }>;
  };
  memory: {
    /**
     * Says that this extension holds the agent's memory, while its server half runs and `on()` says so: a chat with
     * the person then does not read the agent's MEMORY.md, and is told `rule` in its place. A project linked to an
     * agent can do without it, and a blank one never has it. One extension holds it: the first that asks. One that
     * asks while another does is refused, with a line in the log.
     */
    hold(holder: MemoryHolder): void;
  };
  /**
   * Voice mode's source: the extension it listens and speaks through, chosen on that extension's own page. Voice mode
   * is on while it has one; the person can stop using it in Settings → Defaults → Voice mode. Not in a server half in a
   * process of its own: each member throws there.
   */
  voice: {
    /**
     * Offers voice mode speech recognition and synthesis. One for each package, the last given; it goes when this
     * server half stops. While this one is the source and `state` answers nothing, voice mode says that it is not
     * running, and uses nothing else.
     */
    provide(provider: VoiceProvider): void;
    /**
     * Makes this extension voice mode's source, or, with false, stops it being that where it is now. For what the
     * person asks for on the extension's own page: the source decides where the person's voice goes.
     */
    choose(chosen: boolean): void;
    /** Whether this extension is voice mode's source now. */
    chosen(): boolean;
  };
  /**
   * Chat modes: how a chat works, chosen above the message box before its first message and fixed once it has one.
   * Offered to the chats with the person on the portal's pages, where pi runs in the portal's own process.
   */
  modes: {
    /**
     * Offers a mode. Returns what a chat in it stores, "<package>/<id>", which this package's `chats.extend` factory
     * finds as `chat.mode`: what the mode does is the extension's to do there. It goes when this server half stops; a
     * chat started in it keeps it, and has it again when the extension does. Throws a TypeError for a wrong shape, an
     * id this extension offers already, or a package named `custom` (its modes would read as the person's own,
     * "custom/<id>"). Called after this server half has stopped, it offers nothing, with a line in the log, and still
     * returns what a chat in the mode would store.
     */
    provide(mode: ChatMode): string;
  };
  /**
   * The package's own routes, at /api/x/<package>/…, behind the portal's
   * login. No body is read for them: a route that takes JSON says so with
   * `portal.http.json()`, and one that takes a file reads the request itself.
   * In a server half in a process of its own, a request's `originalUrl` is the
   * path below /api/x/<package> and its `baseUrl` is "", and `socket`, `ip`,
   * `secure` and `protocol` are of the local connection it is handed on by.
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
     * Who is behind a request to the package's routes, or an upgrade under them, from the login it came with: nothing
     * for one that is not signed in. The same in a server half in a process of its own, where the portal says it on
     * the request it hands on (a header of that name the request came with is dropped).
     */
    person(req: IncomingMessage): RequestPerson | undefined;
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
    /**
     * The task chats, as the sidebar lists them: pinned first, then the most recently active first (a run that starts or
     * ends, a new title). Not those kept out of the lists (`listed: false`), and no other kind of session (see `inFolder`).
     */
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
    /**
     * Whose a chat is, for any chat (a person's, a child, a routine run, a channel conversation): the agent whose home
     * it works in (`kind: "agent"`), by the same rule the sandbox picks the user a chat runs as by (the workspace
     * stored for the chat; a link in it that leads elsewhere changes nothing), else the project it works in, a folder
     * of it included, by where its folder really leads, as the project's settings are found (`kind: "project"`). The
     * folder is given as `folders.list()` gives it: its real path, its name, and `home` or `newChats` on an agent's. A
     * chat in a project is the project's, whichever agent the project is linked to. Nothing for a chat that is in
     * neither (the workspace root itself, the folder kept from a deleted agent: the sandbox runs it as the first
     * agent), for one whose agent's home or project folder is gone, and for no such chat.
     */
    owner(id: string): ChatOwner | undefined;
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
     * Loads every chat's pi again, as switching a package on or off does: each
     * then has what the server halves add to it now. An idle one at once. One
     * that is working is counted as `waiting`, and loaded again at its next
     * step, between two requests of its run, so the model's next request has
     * the tools as they are then. Where a subagent works in the background or
     * an extension holds the chat (`hold`), it is loaded again once neither
     * does: at a later step, as its run ends, or before the next message starts
     * a run.
     */
    reload(): Promise<{ reloaded: number; waiting: number }>;
    /**
     * A pi extension of the package's, made here: registered in every chat's
     * pi as it starts, so its tools hold what this module holds. Only where pi
     * runs in the portal's own process. A tool registered with
     * `offByDefault: true` is off in every chat until somebody switches it on,
     * and one with `guard` is held to what it declares: see ToolGuard. A
     * factory that throws is that chat's load error: nothing the package adds
     * to that chat's pi is there, and the chat says why. One whose promise
     * fails later is only logged. Should this server half crash while a
     * tool's call, a handler (`pi.on`) or a command of it is running, that
     * ends at once with an error that says so, with the half's last lines;
     * its handlers are not called after that. A turn it asks the chat's pi
     * for (`pi.sendMessage`, `pi.sendUserMessage`) is the chat's, not this
     * module's code. In a server half in a process of its own, `pi` has
     * `registerTool`, `on`, `registerCommand`, `sendMessage` and
     * `sendUserMessage` alone, taken while the factory runs, whose promise is
     * waited for (five seconds at most); a tool's `execute`, a handler and a
     * command are given no `ctx`, `renderCall` and `renderResult` are left
     * out, and a tool with any other function in it is refused, as is one
     * named as one of pi's own tools (`read`, `bash`…).
     */
    extend(factory: (pi: any, chat: Chat) => void): void;
    /**
     * How a chat's model is offered a tool now: by its own name ("direct"), through the `tools` tool where the
     * tool is lazy ("lazy"), or not at all: switched off, out of reach, or the chat's pi is not running here. A
     * call of a tool by a name it is not offered under is refused and never runs. In a chat whose mode works through
     * the code tool (Code mode), "direct" means that a script calls the tool by its name, with no streamed arguments
     * of its own.
     */
    offers(chatId: string, tool: string): "direct" | "lazy" | undefined;
    /** Keeps a chat's pi from being let go, or reloaded, while work of the package's goes on. Returns what lets it go again. */
    hold(chatId: string): () => void;
    /**
     * Makes a child chat of a chat, to give part of its work to: a chat like any other, in its parent's folder, whose
     * pi the portal starts with the guard, the sandbox, the tool layers and its mode, and with a transcript of its own
     * that the person opens at `/s/<id>`. It takes its parent's role and last speaker, so it is held to the person who
     * asked, its parent's mode unless it is given one, and the tools the person switched off or on in the parent unless
     * it is to start from the folder's (`tools: "defaults"`). A
     * dialog it opens, and a question the guard asks, go where its parent's would: where nobody can answer on the
     * portal's pages (a channel conversation, a routine run) the guard refuses for the child too, and so it does in a
     * child made `unattended`, which asks nobody anything. One level only:
     * refused for a parent that is a child itself, and for a heartbeat, which is held to reading by a role of its own.
     * Deleted with its parent, and each child's `deleted` is heard as the parent's is. Throws for options that cannot
     * be one: no such parent, no title, a model that is not a provider and an id, or a mode the child may not be put in
     * (one that asks the person first only where the parent is in it).
     */
    create(options: ChildChatOptions): Chat;
    /**
     * Starts a chat of an agent's or a project's folder for this package: a task chat with no parent, as one the person
     * starts there with "+", in the primary role, in Standard mode on the default model, with the tools a new chat
     * there has. For work of the package's own that belongs to no chat of the person's, such as the answer to a
     * comment in a document. It is this package's as a child chat is: only it prompts, stops or removes it
     * (`prompt`, `abort`, `remove`), and a message it sends is the primary user's. It goes with the folder's other chats
     * when the project or the agent is deleted, listed or not, and each delete is heard as `deleted`; an unlisted one
     * that is working is stopped then, where a listed one keeps the delete from going through until the person stops
     * it. Throws for options that cannot be one: a folder that is not an agent's or a project's (one inside them
     * included), no title, or `listed: false` without `unattended: true`. Keep its id: an unlisted one is in no list,
     * and `children` finds children only, so the id is how the half reaches it again after a restart (`lastAnswer`).
     *
     * A message it is sent is the primary user's own words, and the chat is not marked by them: words from a document or
     * from another person are outside content, which the agent reads through a tool with `guard: { outside: true }`
     * rather than in the message. A pi tool that starts or prompts a chat declares `guard: { acts: ["delegate"] }`, as
     * the subagent tool does, so that a marked chat cannot hand its work to a fresh one the guard holds nothing in.
     */
    start(options: StartChatOptions): Chat;
    /**
     * The child chats of a chat that this package made, listed or not, oldest first: `chats.list` leaves the unlisted
     * out, so this is how a half finds the ones it made once it has lost its own record of them, to stop or remove them.
     */
    children(parent: string): Chat[];
    /**
     * Sends a chat this package made (a child, or one it started) a message, and resolves once the run that takes it in
     * has ended. A chat that is working takes it after the run it is on, as a person's message does; with `steer`, after
     * the step it is on. A child's is sent as the person its parent last heard from, a started chat's as the primary user. A run that fails resolves as an `error`, and so does a
     * command its speaker may not run; a command it may run is no message of the chat, and resolves as `done` at
     * once when it started no run (with no answer), or when the run it started ends. This throws only for a chat this package
     * did not make, one that is not there (any more: "There is no chat <id>"), or a message with no words.
     */
    prompt(chatId: string, message: string, options?: { steer?: boolean }): Promise<ChildRun>;
    /**
     * Where the last run of a chat this package made (a child, or one it started) stands, from what the portal keeps of
     * the chat, so it holds across a restart of the server half or of the portal: for a half that lost a `prompt` it
     * was waiting on, to tell a run that goes on from one that ended while it was away, and to have its answer.
     * Nothing for a chat that has never run. Throws for a chat this package did not make, and for one that is not
     * there any more, deleted by the person or with its project or agent ("There is no chat <id>"). `marked` says the answer is
     * to be held like outside content. For a child, its parent is marked with it as `prompt` marks it, in the guard that
     * runs for the parent now: none does after a restart, until the parent's pi starts again, and that mark is not kept.
     * Hand a marked answer on in the flagged form (see `ChildRun.marked`), which the parent's guard finds again.
     */
    lastAnswer(chatId: string): ChatAnswer | undefined;
    /** Stops the run of a chat this package made, as the person's Stop does: its `prompt` resolves as `stopped`. */
    abort(chatId: string): Promise<void>;
    /**
     * Deletes a chat this package made (a child, or one it started), stopping its run first: its transcript and files
     * go, and `deleted` is heard once. Throws while a child's parent is being deleted, which takes the child with it.
     */
    remove(chatId: string): Promise<void>;
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
