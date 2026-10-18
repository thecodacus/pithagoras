/**
 * A portal to test an extension's server half against: see testing.mjs.
 */
import type { ServerHalf, ServerPortal, Chat } from "./server";

/** A chat's pi as far as an extension uses it. */
export interface MockPi {
  /** The pi extension API an extension's `chats.extend` factory is called with. */
  pi: any;
  /** The tools registered in it, by name. */
  tools: Map<string, any>;
  /** What it was given to say, by `sendMessage`: `{ message, options }`. */
  sent: { message: any; options: any }[];
  /** How many handlers listen on a channel of its bus. */
  handlers(channel: string): number;
  /** Rings the bell that `portal.chats.tell` rings: what the package's pi extension hears. */
  tell(data: unknown): void;
  /** A tool called as pi calls it: its text and details, or the error it threw. */
  call(name: string, params: unknown): Promise<{ text: string; details?: unknown; error: string | null }>;
  /** The pi is shut down: what it registered for that is called. */
  stop(): void;
}

/** A page of the portal that listens to the package's topics. */
export interface MockPage {
  events: { name: string; data: any }[];
  /** What it has heard of pushes, in order, as `[topic, data]`. */
  heard(): [string, unknown][];
  /** The topics it was told it lost (the server half stopped). */
  lost(): string[];
  listen(topic: string, extension?: string): Promise<"listening" | "refused" | "no-stream" | "too-many" | "lost">;
  leave(topic: string, extension?: string): void;
  /** Waits until `done()`, up to `ms` (two seconds by default). */
  until(done: () => boolean, what?: string, ms?: number): Promise<void>;
  close(): void;
}

export interface MockPortalOptions {
  /** The package's name, `portal.extension`. */
  extension?: string;
  /** `portal.executor`: "host" (the default) is where tools and pis run in the portal's process. */
  executor?: string;
  /** Chats by id, with the folder each works in. */
  chats?: Record<string, string | { folder: string; title?: string }>;
  /** `portal.dataDir()`; a folder of the mock's own by default. */
  dataDir?: string;
  /** `portal.sandbox.on()`. */
  sandbox?: boolean;
  /** `portal.files`; the portal's own by default. */
  files?: ServerPortal["files"];
  /** Without `portal.git`. */
  git?: false;
  /** What `portal.extensions.use(name)` gives, by name. */
  extensions?: Record<string, unknown>;
  /** Called before `chats.tell` starts the chat's pi and rings its bell: false says the chat cannot be reached, a throw fails, anything else goes on. It may hold the answer. */
  tell?: (chat: string, data: unknown) => Promise<boolean | void> | boolean | void;
  /** The same for `chats.followUp`, which starts the chat's pi and has it say the message. */
  followUp?: (chat: string, message: { text: string; details?: unknown; type?: string }) => Promise<boolean | void> | boolean | void;
  /** `pi.sendMessage` of every chat's pi throws this. */
  sendThrows?: string;
}

export interface MockPortal {
  options: MockPortalOptions;
  /** The `portal` to call the server half with. */
  portal: ServerPortal;
  /** What the server half logged. */
  logged: string[];
  /** What it said to the pages open on a chat (`chats.send`). */
  sent: { chat: string; data: unknown }[];
  /** What it said to the package's pi extension (`chats.tell`). */
  told: { chat: string; data: unknown }[];
  /** What it said to the agent (`chats.followUp`). */
  followedUp: { chat: string; text: string; details?: unknown; type?: string }[];
  /** A new folder of the mock's own, removed when it stops. */
  temp(prefix?: string): string;
  addChat(id: string, folder: string, title?: string): void;
  /** The chat is deleted: the server half hears so, and its pi is shut down. */
  removeChat(id: string): void;
  /** A chat's pi, started the first time it is asked for: the tool factories of `chats.extend` are run for it. */
  pi(chat: string): MockPi;
  /** What a chat's pi was given to say (`pi.sendMessage`), also before its pi is started. */
  said(chat: string): { message: any; options: any }[];
  /** Which chats `chats.list()` gives, and in what order (by default all of them, as they were added). A chat left out is gone from the list, and still has its folder. */
  order(ids: string[]): void;
  /** The chats whose pi is started now, by id. */
  running: Map<string, MockPi>;
  /** The pi extensions the server half asked to add to every chat's pi (`chats.extend`). */
  factories: ((pi: any, chat: Chat) => void)[];
  /** What the server half gave the extensions that build on it, once one asked (`provide`). */
  provided(consumer?: string): unknown;
  upgrade(req: unknown, socket: unknown, head: unknown): void;
  /** Ends what the server half asked to be ended with the login, as a change of the password does. */
  endLogins(): void;
  /** How many `chats.hold`s a chat has now. */
  holds(chat: string): number;
  /** What the server half tells a page that opens the chat (`chats.onOpen`). */
  opening(chat: string): unknown[];
  /** Something a chat's pi said, as `chats.onEvent` hears it. */
  event(chat: string, event: Record<string, unknown>): void;
  /** Calls the server half with the mock's portal and whatever else it takes; resolves with what stops it. */
  start(half: ServerHalf | ((portal: ServerPortal, ...rest: any[]) => unknown), ...rest: unknown[]): Promise<() => Promise<void>>;
  /** The package's routes in a server of their own, at `/x`. */
  serve(): Promise<{ base: string; call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> }>;
  /** A page that listens to the package's topics, through the portal's own hub. */
  page(): MockPage;
  /** Stops the server half, closes the servers and pages, removes the folders made with `temp`. */
  stop(): Promise<void>;
}

export function mockPortal(options?: MockPortalOptions): Promise<MockPortal>;

/** The portal's own `portal.files`, for a test that calls a server half by hand and needs no more of a portal than that. */
export function portalFiles(): Promise<ServerPortal["files"]>;

/** The portal's own `portal.proc` (`/proc` of the host), for a test that calls a server half by hand and needs no more of a portal than that. */
export function portalProc(): Promise<ServerPortal["proc"]>;

/** A new folder (its real path) in the system's temp directory, removed when the process ends. */
export function scratch(prefix?: string): string;
