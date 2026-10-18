/**
 * What an extension's browser half is given: the `portal` its module's
 * default export is called with, and what the portal's slots hand the
 * components drawn in them. The portal implements exactly this, and is
 * checked against it when it is built.
 *
 * See docs/guide/extension-ui.md, "Building an extension".
 */
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent, LazyExoticComponent, ReactNode, Ref } from "react";
import type * as ReactNamespace from "react";

// --- the chat, and what is drawn in it ---

/** The chat an entry is drawn in. */
export interface Chat {
  id: string;
  title: string;
  /** The folder the chat works in. */
  workspace: string;
}

/** To and from the package's own pi extension in the chat. */
export interface Channel {
  /** Rejects when the extension cannot be reached: this chat's agent does not run its extensions in the portal. */
  send(data: unknown): Promise<void>;
  /** Returns the unsubscribe. */
  on(handler: (data: unknown) => void): () => void;
}

/** The panels beside the conversation, by name: the extension's own by the id each was registered with. */
export interface Panels {
  isOpen(id: string): boolean;
  /** `params` is the panel's to read: what it is opened to show. */
  open(id: string, params?: unknown): void;
  close(id: string): void;
}

export interface ChatProps {
  chat: Chat;
  channel: Channel;
  /** The extension's own panels in this chat. */
  panels: Panels;
}

/** A panel's own say over itself, the same for its body, its head and its button. */
export interface PanelHandle {
  /** What it was last opened with: `panels.open(id, params)`. */
  params: unknown;
  /** Shared by its body and what it draws in its head, and kept while it is open: which tab is shown, a count. */
  state: unknown;
  setState(state: unknown): void;
  /** While true it is not the one closed to make room when a third panel opens: there is something in it that would be lost. */
  keep(keep: boolean): void;
  /** Asked before it is closed by hand, and it stays open on false: "Discard your changes?". Null to stop asking. */
  guardClose(guard: (() => boolean | Promise<boolean>) | null): void;
  /** Opens another panel from this one (a file it lists, in Files): this one is not the one closed to make room for it. */
  open(name: string, params?: unknown): void;
}

export type PanelProps = ChatProps & { close(): void; panel: PanelHandle };

/** A file the agent has just read or changed in a chat's folder: see `chats.files.latestActivity`. */
export interface FileActivity {
  /** The event it was noticed at; a newer one means "look again", even at the same file. */
  seq: number;
  /** Relative to the chat's folder. */
  path: string;
  tool: "read" | "write" | "edit";
}

/** A call of a tool, as its row in the conversation has it. */
export interface ToolCallView {
  /** The tool's name. */
  name: string;
  callId?: string;
  /** `writing` while the model is still writing the call (`ChatFeed.calls`): it has not run yet, and may never. */
  status: "writing" | "running" | "done" | "error";
  /** What it was called with: of a call being written, as far as the model has written it, a string cut where it has come to. */
  input: Record<string, unknown>;
  /** What it has returned so far, as text: its end, of a long one. */
  output?: string;
  /** What it reported about itself beside its text: a tool result's `details`. */
  details?: unknown;
  /**
   * The files it gave the person, once it ended: what its `details.files`
   * named, as the portal found them in the chat's folder by their bytes. `url`
   * is where the page fetches each: drawn, played, or saved for a `file`.
   * The portal's card draws them; an extension's own card that leaves out
   * `card` draws them its own way.
   */
  files?: CallFile[];
}

/** A file a call gave the person, in the chat's folder: see ToolCallView.files. */
export interface CallFile {
  /** Relative to the chat's folder. */
  path: string;
  kind: "picture" | "video" | "file";
  title?: string;
  /** The files it was made from, relative to the chat's folder. */
  from?: string[];
  url: string;
}

export interface SlotMap {
  /**
   * A panel beside the conversation, docked, floated and sized like the
   * portal's own. The chat's header has its button. `header` is drawn in its
   * head in place of its title (tabs, a count), `actions` before its close
   * button. `useButton` is a hook, called as the chat's header is drawn: how
   * its button is for this chat. `name` is a name of its own that
   * `portal.panels.open(name, params)` reaches it by, from anywhere: the
   * portal's own panels go by "browser" and "agents", and while
   * one of those is the portal's, it is the one.
   * Of two extensions that name a panel alike, the one first in the slot's
   * order has it (a lower `order`, then the one whose extension is first in the list of installed extensions).
   */
  "chat.panel": {
    entry: {
      title: string;
      name?: string;
      icon?: ComponentType;
      header?: ComponentType<PanelProps>;
      actions?: ComponentType<PanelProps>;
      useButton?: (props: ChatProps) => { hidden?: boolean; live?: boolean; title?: string };
    };
    props: PanelProps;
  };
  /** A control in the chat's header, before the panels' buttons. */
  "chat.header.action": { entry: {}; props: ChatProps };
  /** There for as long as the chat is on screen, drawing nothing: it listens, and opens a panel when there is something to see. */
  "chat.background": { entry: {}; props: ChatProps };
  /** Over the chat, placed by the extension itself: a window in a corner, a dialog. */
  "chat.overlay": { entry: {}; props: ChatProps };
  /** Above the message box: what is running, what waits. */
  "chat.composer.above": { entry: {}; props: ChatProps };
  /** How a call of one tool is drawn in the conversation, in place of the portal's card for it. `card` is that card. */
  "chat.tool": { entry: { tool: string }; props: ChatProps & { call: ToolCallView; card: ReactNode } };
  /**
   * Something to do with a call of a tool, drawn on the portal's card for it
   * when it is opened, under what the call returned: "Open in the terminal".
   * `tool` is the tool's name, or a pattern of names; without it, every call.
   * `cut` is whether the card shows only the end of the output. `chat` is
   * the chat whose conversation the card is in; a card elsewhere, such as a
   * subagent's run, has none. The component draws nothing for a call it has
   * nothing for. `ui.ToolLink` is the portal's own look for it.
   */
  "chat.tool.action": { entry: { tool?: string | RegExp }; props: { call: ToolCallView; cut: boolean; panels: Panels; chat?: Chat } };
  /**
   * A window in voice mode, placed and sized like the portal's own. `place`
   * is where it goes when it has the choice: at the side, or in the middle.
   * `useAutoOpen` is a hook, called while voice mode is on in a chat: a count
   * that opens the window each time it grows (the agent ran a command). A
   * card of a call in voice mode that `opensFor` says yes to opens it when
   * tapped, for calls the portal's own windows are not for. Its own shortcut
   * is `portal.shortcuts`.
   *
   * `maximizable` gives its head a Maximize button: the window then fills the
   * stage, over the others and above the dock, until it is restored by its
   * button, by Escape, by being minimized, or by another window opening.
   * `maximized` says which it is, and `maximize()` and `restore()` change it.
   * Escape pressed in a frame of its own never reaches the stage: listen for
   * it there and call `restore()`. `keepLoaded` keeps it, once opened, while
   * it is minimized, hidden: what it holds (a frame, a stream) is not loaded
   * again each time it opens.
   */
  "voice.window": {
    entry: {
      title: string;
      icon?: ComponentType;
      place?: "side" | "middle";
      maximizable?: boolean;
      keepLoaded?: boolean;
      useAutoOpen?: (props: ChatProps) => number;
      /** `chat` is the chat on screen: its `workspace` tells a path in its folder from one elsewhere. */
      opensFor?: (call: ToolCallView, chat: Chat) => boolean;
      /** What the card of a call it opens for says, in place of the portal's words for a tool it does not know ("Using canvas write"). */
      describe?: (call: ToolCallView, chat: Chat) => { label: string; detail?: string } | undefined;
    };
    props: ChatProps & { close(): void; opened: VoiceWindowOpened; maximized: boolean; maximize(): void; restore(): void };
  };
  /**
   * A page of the portal, at /x/<extension>/<id>, with an entry in the
   * sidebar. `useShown` is a hook, called as the sidebar is drawn: whether the
   * entry is listed now (not while the service the page is for is not set
   * up). Until it says yes, it is not. The page is at its address either way.
   */
  "nav.page": { entry: { title: string; icon?: ComponentType; useShown?: () => boolean }; props: {} };
  /** The extension's page in Settings, above the fields the portal found for it. */
  "settings.page": { entry: {}; props: {} };
}
export type SlotName = keyof SlotMap;

/** An entry of a slot. A `title` it has is said in the page's language as the extension's own `t` says it: in its texts, by the English. */
export type Entry<S extends SlotName> = SlotMap[S]["entry"] & {
  /** Its name among the extension's entries in the slot. */
  id: string;
  /** Lower first; entries without one come after, in the order of the list of installed extensions, then as they were registered. */
  order?: number;
  component: ComponentType<SlotMap[S]["props"]>;
};

// --- what the portal knows of a chat ---

/** Something a chat's pi said, or the portal said of the chat, as the chat's event stream carries it. */
export interface PortalEvent {
  seq: number;
  type: string;
  /** When the server recorded it, epoch ms. */
  at?: number;
  payload: any;
}

/** A command the agent left running in a chat (`nohup`, `&`, a dev server), as the portal follows it. */
export interface BackgroundJob {
  key: string;
  sid: number;
  pids: number[];
  command: string;
  startedAt: number;
  state: "running" | "stopped" | "exited";
  exitedAt?: number;
  /** Its output goes to a file the portal can follow: `GET /api/sessions/<chat>/background/<key>/output?from=`. */
  hasOutput: boolean;
  /** A tool call the conversation is showing already. */
  attached: boolean;
}

/** What runs in a chat besides the conversation, and what its pi extensions say of themselves in pi's footer. */
export interface BackgroundState {
  /** Jobs can be followed: pi runs on the host. */
  supported: boolean;
  jobs: BackgroundJob[];
  statuses: { key: string; text: string }[];
  widgets: { key: string; lines: string[] }[];
}

/** A chat as the page has it. */
export interface ChatFeed {
  events: readonly PortalEvent[];
  /** The conversation as the portal draws it: messages, tool calls with their output, notices. Read `kind`; the rest is the portal's own and may change. */
  items: readonly { kind: string; [key: string]: unknown }[];
  /**
   * The tool calls that have not ended, oldest first: the ones the model is writing now (`status: "writing"`, `input` as far as
   * it has come, read again a few times a second, not with every token) and the ones it has written that are running. Only in a
   * page that has the chat open: nothing of it is done where nobody looks.
   */
  calls: readonly ToolCallView[];
  /** A call of the conversation by its id, ended or not: to follow one from `calls` to how it came out. Nothing for one the page does not have. */
  call(callId: string): ToolCallView | undefined;
  /** The agent is at work. */
  running: boolean;
  /** How the chat stands: at work, waiting, or stopped by an error or by hand. After those two, a call that has not ended will not. */
  status: "idle" | "running" | "error" | "interrupted";
  /** The conversation is still being fetched. */
  loading: boolean;
  /** Its background jobs and what extensions say of themselves, asked of the portal while the chat is on screen. */
  background: BackgroundState;
  /** Asks for `background` again at once: after a job was stopped, or the finished ones cleared. */
  refreshBackground(): void;
}

/** The panels of the chat on screen, any of them, by name. */
export interface PanelController {
  isOpen(key: string): boolean;
  open(key: string, params?: unknown): void;
  /** As by hand: what the panel asks before it is closed (`guardClose`) is asked. */
  close(key: string): void;
  /** Whether there is a panel by this name or key, the portal's or an installed extension's: an "Open in Files" only where there is a Files. */
  has(key: string): boolean;
  /** The same as a hook: the component is drawn again when an extension with such a panel comes or goes. */
  useHas(key: string): boolean;
}

/** A theme an extension brings: colours in place of the portal's own. */
export interface ThemeGiven {
  /** Its name among the package's themes. */
  id: string;
  /** What it is called where themes are chosen. */
  name: string;
  /** Each colour by the portal's name for it, as "#rrggbb" or as three numbers: "27 22 38". */
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

/** A request the portal's server refused: what it said, and with which status. */
export interface ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

// --- the portal's own building blocks ---

export interface SafeStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** What the button says. */
  confirmLabel?: string;
  /** Destructive: the button is red, and focus starts on Cancel. */
  danger?: boolean;
  /** Removes something, so the question can be switched off in Settings. */
  deletes?: boolean;
}

/** One choice of a `ui.Menu`. */
export interface MenuItem {
  /** Tells the choices apart. */
  key: string;
  label: string;
  icon?: ReactNode;
  /** What a button does when it is chosen. */
  onSelect?: () => void;
  /** Makes the choice a link; with `download`, it saves what it leads to (under that name, "" for the name it has). */
  href?: string;
  download?: string;
  /** For a menu that goes between pages: the one showing is marked, and the arrows start there. */
  current?: boolean;
}

export interface SelectOption<T> {
  value: T;
  label: ReactNode;
  /** A second, quieter line under the label. */
  hint?: ReactNode;
  disabled?: boolean;
  /** What typing a letter matches against, when the label is not plain text. */
  text?: string;
}

/** What `useFollowBottom` gives a scrolling box: `attach` as its ref, `onScroll` and `onWheel` on it. */
export interface FollowBottom<T extends HTMLElement> {
  ref: { current: T | null };
  attach: (el: T | null) => void;
  onScroll(): void;
  onWheel(event: { deltaY: number; deltaX: number; ctrlKey: boolean; target: EventTarget | null }): void;
  /** On a press inside the box: a control that opens something there stops the following while it is open. */
  hold(event: { target: EventTarget | null }): void;
  /** Call after the content changed; `force` to go to the end whatever the person was doing. */
  follow(force?: boolean): void;
  /** Call after the box itself moved or changed size. */
  settle(): void;
  isFollowing(): boolean;
  /** The person has scrolled away from the end. */
  away: boolean;
}

/**
 * The portal's own building blocks, handed over as `portal.ui`, so that what
 * an extension draws is made of what the portal's pages are made of.
 */
export interface Ui {
  /** Markdown as the conversation draws it: code, tables, diagrams, and no picture from another site. */
  Markdown: ComponentType<{ children: string; animated?: boolean; className?: string }>;
  Select<T extends string | number = string>(props: {
    value: T;
    onChange: (value: T) => void;
    options: SelectOption<T>[];
    placeholder?: ReactNode;
    disabled?: boolean;
    className?: string;
    size?: "sm" | "md";
    "aria-label"?: string;
    id?: string;
  }): ReactNode;
  /** The card at the top of a page, and a number in it. */
  PageHeader: ComponentType<{ icon: ReactNode; media?: ReactNode; title: ReactNode; description: ReactNode; action?: ReactNode; children?: ReactNode; className?: string }>;
  Stat: ComponentType<{ value: ReactNode; label: string; tone?: string }>;
  StatusDot: ComponentType<{ status: "idle" | "running" | "error" | "interrupted"; className?: string; bare?: boolean }>;
  Section: ComponentType<{ title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }>;
  CollapsibleSection: ComponentType<{
    title: string;
    hint: ReactNode;
    summary: ReactNode;
    open: boolean;
    onToggle: () => void;
    locked?: boolean;
    controls?: ReactNode;
    whileClosed?: ReactNode;
    children: ReactNode;
  }>;
  Empty: ComponentType<{ children: ReactNode }>;
  ErrorBanner: ComponentType<{ children: ReactNode; onClose?: () => void; className?: string }>;
  WarnBanner: ComponentType<{ children: ReactNode; onClose?: () => void; className?: string }>;
  /** Why something could not be fetched, with a button to try again. */
  LoadFailed: ComponentType<{ error: string | Error; onRetry: () => unknown }>;
  Field: ComponentType<{ label: string; hint?: ReactNode; children: ReactNode; className?: string }>;
  Switch: ComponentType<{ on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; title?: string; className?: string }>;
  SwitchRow: ComponentType<{ title: ReactNode; detail?: ReactNode; on: boolean; onChange: (on: boolean) => void; disabled?: boolean; note?: ReactNode }>;
  Segments<T extends string>(props: {
    label: string;
    value: T;
    options: { id: T; label: string }[];
    onChange: (id: T) => void;
    showLabel?: boolean;
    size?: "sm" | "cell" | "md";
    className?: string;
  }): ReactNode;
  /**
   * A button that opens a list of choices, drawn over the page: arrows move through it, Enter picks, Escape shuts it and gives the
   * focus back. `children` is what the button holds and `className` styles it; the list opens under it (`below`, above where there is
   * no room) or beside it (`beside`). A choice is a button (`onSelect`) or a link (`href`, with `download` to save the target).
   */
  Menu: ComponentType<{
    label: string;
    children: ReactNode;
    items: MenuItem[];
    className?: string;
    disabled?: boolean;
    placement?: "below" | "beside";
    /** The button, for a caller that gives the focus back to it. */
    buttonRef?: Ref<HTMLButtonElement>;
  }>;
  /** A small button with an icon in it, named by `label` (its hover text and its name for a screen reader). `onClick` does not reach the row it is in. */
  IconButton: ComponentType<{ label: string; onClick: () => void; children: ReactNode; disabled?: boolean; danger?: boolean; className?: string }>;
  /** A labelled button for a bar of small controls: plain, `primary` for the one that does the job, `danger` for one that destroys. */
  TextButton: ComponentType<{ onClick?: () => void; children: ReactNode; disabled?: boolean; title?: string; primary?: boolean; danger?: boolean; type?: "button" | "submit" }>;
  RowsSkeleton: ComponentType<{ rows?: number; label?: string }>;
  SkeletonGroup: ComponentType<{ label: string; className?: string; children: ReactNode }>;
  /** Draws `fallback` in place of what it holds when that fails to draw, until `resetKey` changes. */
  ErrorBoundary: ComponentType<{ resetKey: string; fallback?: (error: Error) => ReactNode; children: ReactNode }>;
  PartFailed: ComponentType<{ error: Error }>;
  /**
   * A component fetched when it is first drawn, from a chunk of the
   * extension's own that exports it by name: `ui.lazy(() => import("./Shell"),
   * "Shell")`, drawn in `Suspense`. A chunk that cannot be fetched (the
   * extension was updated after the page was opened) is said so by
   * `PartFailed` with a way to reload, as the portal's own parts are.
   */
  lazy<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K): LazyExoticComponent<M[K]>;
  /** A link on a tool call's card, as the portal's own are drawn: for `chat.tool.action`. */
  ToolLink: ComponentType<{ icon?: ComponentType<{ "aria-hidden"?: boolean }>; onClick: () => void; children: ReactNode }>;
  /** A question with two answers, asked over the page: resolves true for yes. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The look of the portal's own fields and buttons, as class names for a `className`. */
  classes: { input: string; inputSmall: string; codeArea: string; button: string; primary: string; primarySmall: string; ghost: string };
  /** Copies text, where the page is served over plain HTTP as well. Resolves false when it could not. */
  copyText(text: string): Promise<boolean>;
  /** Whether the person wants to be asked before something is deleted (Settings → This browser): ask first when true. */
  asksBeforeDeleting(): boolean;
  /** The browser's storage, which never throws: kept across reloads, and kept for the tab. */
  storage: { local: SafeStorage; session: SafeStorage };
  /** Keeps a scrolling box at its end while more comes, until the person scrolls away. */
  useFollowBottom<T extends HTMLElement>(options?: { paused?: () => boolean; nested?: boolean }): FollowBottom<T>;
  /** The time now, drawn again every `every` ms while `on`. */
  useNow(on: boolean, every?: number): number;
  /** Arrow keys for a row of tabs: on the element with `role="tablist"`. */
  tabKeys(event: ReactKeyboardEvent<HTMLElement>): void;
  /**
   * Whether `target`, of a press, is inside something the portal draws over the page in a layer of its own: the list of a
   * `Select` (drawn at the body, though it belongs to the popover it is in) or the question `confirm` asks. A popover of
   * the extension's own that closes on a press outside it counts these as inside: `if (box.contains(e.target) ||
   * ui.inOverlay(e.target)) return;`.
   */
  inOverlay(target: EventTarget | null): boolean;
  /** Enter that means "done", not Enter that picks a word with an input method (Japanese, Chinese, Korean): for a key handler's `if`. */
  isEnter(event: { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean }): boolean;
  /** Escape that means "never mind", not Escape that dismisses an input method's candidates. */
  isEscape(event: { key: string; keyCode?: number; nativeEvent?: { isComposing?: boolean }; isComposing?: boolean }): boolean;
}

// --- shortcuts ---

/** A key, as the keyboard has it whatever the layout (`KeyboardEvent.code`), with its modifiers. */
export interface KeyBinding {
  code: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

/** The extension's own voice windows in the chat on screen, by the id each was registered with. */
export interface VoiceWindows {
  isOpen(id: string): boolean;
  /** `params` is the window's to read, as `opened.params`: what it is opened to show. */
  open(id: string, params?: unknown): void;
  close(id: string): void;
}

/**
 * What a voice window was opened for, the last time it was: a new object each
 * time. By the person, with its button; by the agent's work, as `useAutoOpen`
 * counted it; for the card of a call that was tapped, with the call; or by
 * the extension's own `windows.open(id, params)`, with what it was given.
 */
export type VoiceWindowOpened =
  | { by: "person" }
  | { by: "work" }
  | { by: "call"; call: ToolCallView }
  | { by: "open"; params?: unknown };

/** What every shortcut has. */
interface ShortcutBase {
  id: string;
  label: string;
  /** The key it has until someone chooses another, or null for none: a key the portal or another extension has already is not taken from it. */
  default: KeyBinding | null;
}

/**
 * A shortcut of the extension's for voice mode, listed in Settings → Shortcuts with the portal's own and changed there the same
 * way. It works while voice mode is on, except while typing in a field. `run` returns false when it had nothing to do, and the
 * key goes on to whatever else wants it.
 */
export interface VoiceShortcut extends ShortcutBase {
  scope: "voice";
  run(context: { chat: Chat; windows: VoiceWindows }): boolean | void;
}

/**
 * A shortcut of the extension's for anywhere in the portal, listed in Settings → Shortcuts and changed there the same way. It
 * works whatever page is shown, whether or not a chat is open, and while typing in a field only when the key has Ctrl, Alt or
 * the Windows/Command key in it (a key alone is the field's). It is not run while a dialog is open, nor for AltGr (Ctrl+Alt on
 * Windows), which types a character on some layouts. It is heard after the page's own parts: one that handled the key (and called
 * `preventDefault`) has it. `run` is given the key event and where it was pressed, to say whether it is for this extension's
 * part of the page (an editor with the focus); it returns false when it had nothing to do, and the key goes on to the browser's
 * own use of it. One key is one shortcut: the browser's own meaning of it is taken when `run` does not return false.
 */
export interface AppShortcut extends ShortcutBase {
  scope: "app";
  run(context: { target: EventTarget | null; event: KeyboardEvent }): boolean | void;
}

export type Shortcut = VoiceShortcut | AppShortcut;

// --- the portal ---

/** A count's forms in a language, by the language's plural rules: `{ one: "{n} Datei", other: "{n} Dateien" }`. */
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/**
 * What an extension's browser half is called with. Its module's default
 * export is a function taking this; it may return a function, called when the
 * extension is taken out. What it registered goes with it either way.
 */
export interface Portal {
  /** Of this interface: raised when something an extension relies on changes. */
  version: 1;
  /** The package's name, which its entries and its messages go by. */
  extension: string;
  /** The portal's own React: what a component drawn in a slot has to be made with, for its hooks to work. */
  React: typeof ReactNamespace;
  slots: { register<S extends SlotName>(slot: S, entry: Entry<S>): () => void };
  /** Go to a page of the portal: "/s/<chat id>", "/x/<extension>/<page id>". */
  navigate(path: string): void;
  ui: Ui;
  api: {
    /** A request as the portal's own are made: JSON back, an ApiError with what was said for one refused, and a login that is gone told to the page. */
    json<T = unknown>(url: string, init?: RequestInit): Promise<T>;
    /** The address of a route of the package's own server half: `url("/notes")`. Throws when it has none running. */
    url(path: string): string;
    ApiError: new (message: string, status: number, body: Record<string, unknown>) => ApiError;
  };
  /** A text in the language in effect: the package's own where it added one, as written otherwise. `{name}` is filled in from `vars`. */
  t(text: string, vars?: Record<string, string | number>): string;
  /**
   * A text with a count, `{n}` in it being the count written the language's
   * way: `tp(3, "{n} file", "{n} files")`. A language gives its forms under
   * the English plural: `"{n} files": { one: "{n} Datei", other: "{n} Dateien" }`.
   */
  tp(n: number, one: string, other: string, vars?: Record<string, string | number>): string;
  /**
   * A text whose English is the same word as another's with another meaning,
   * told apart by what it is: `tc("Open", "state")`. A language keys it as
   * `"Open\u0004state"`.
   */
  tc(text: string, context: string, vars?: Record<string, string | number>): string;
  /** A text with something drawn in it where `t` takes only words: `tx("Press {key}", { key: <kbd>Enter</kbd> })`. */
  tx(text: string, vars: Record<string, ReactNode>): ReactNode;
  /** Numbers, dates and times written the way the page's language writes them, as toLocaleString would. */
  format: {
    number(n: number, options?: Intl.NumberFormatOptions): string;
    date(d: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
    dateTime(d: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
    time(d: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
    /** A size in bytes, "1.5 MB". */
    bytes(n: number): string;
    /**
     * How long ago, "5m ago", in the language shown: of a Date, a time in ms, or a timestamp the server wrote as text (UTC, with or
     * without a zone marker; what cannot be read is shown as it is). Past `dateAfterDays` days it is the date instead (`dateFormat`).
     */
    since(then: Date | number | string, options?: { dateAfterDays?: number; dateFormat?: Intl.DateTimeFormatOptions }): string;
  };
  locale: {
    /** The package's texts in a language ("de"), each by what the code says in English: a text, or a count's forms (see `tp`). */
    add(code: string, strings: Record<string, string | Plural>): () => void;
    /** A hook: the language in effect, drawing the component again when it changes. */
    use(): string;
  };
  commands: {
    /** Say what can be asked of the package by name, by another extension or the portal. */
    register(name: string, run: (...args: any[]) => unknown): () => void;
    /** Ask for it. Throws when nothing answers to the name. */
    run(name: string, ...args: unknown[]): unknown;
    has(name: string): boolean;
  };
  /** The panels of the chat on screen, any of them: the portal's ("browser", "agents") and an extension's ("<package>/<id>", or the name it gave itself, as Files' is "files"). */
  panels: PanelController;
  chats: {
    /**
     * A hook: a chat as the page has it. Give it `pick` to say what of it the
     * component uses: a chat changes with every token, and the component is
     * then drawn again only when what it picked has changed.
     */
    use<T = ChatFeed>(chatId: string, pick?: (feed: ChatFeed) => T, same?: (a: T, b: T) => boolean): T;
    /** The same outside a component: told each time the chat changes. Returns the unsubscribe. */
    on(chatId: string, handler: (feed: ChatFeed) => void): () => void;
    /**
     * A new chat, as New chat makes one: in `workspace` (a folder, as the portal takes it for a chat: the workspace
     * root or below it, or an agent's home) or, without one, in the home of the agent that new chats go to. With a
     * `title` it keeps that name and is not named after its first message. It is not opened: `portal.navigate("/s/" +
     * chat.id)` does that. Rejects with an `ApiError` where the portal refuses the folder.
     */
    create(options?: { title?: string; workspace?: string }): Promise<Chat>;
    /**
     * The portal's own routes for the folder a chat works in, which its message box and its conversation use as well: no
     * address is built by hand. `path` is relative to the chat's folder. A picture or a clip is drawn in the page, a
     * file saved, and only what its bytes say it is is sent as that; `version` is anything that changes when the file does
     * (the agent rewrites files in place), so that the browser asks again.
     */
    files: {
      /** The address of a picture in the chat's folder (PNG, JPEG, GIF, WebP) to draw: for an `<img>`. */
      pictureUrl(chatId: string, path: string, version?: string | number): string;
      /** The address of a clip (WebM, MP4), played in parts as the player asks. */
      videoUrl(chatId: string, path: string, version?: string | number): string;
      /** The address of any file, to be saved and never shown. */
      fileUrl(chatId: string, path: string, version?: string | number): string;
      /** A file from this computer into the folder `dir` of the chat's, as it is; a taken name gets a number. The answer says what it is called. */
      upload(chatId: string, dir: string, file: File, name?: string): Promise<{ path: string; size: number }>;
      /**
       * `given`, as the agent wrote it (relative to where it works in `folder`, or absolute), as a path relative to `folder`;
       * undefined when it is somewhere else, or is the folder itself. By the text of the paths: `..` is followed, links are not.
       */
      inside(folder: string, given: string): string | undefined;
      /** `where` as a path under the folder `dir`, "" for `dir` itself, or undefined when it is somewhere else: by the text of the paths. */
      below(dir: string, where: string): string | undefined;
      /**
       * The file the agent most recently read or changed in the chat's folder (`chat.workspace`), if any, from `ChatFeed.events`.
       * A read is noticed when it starts, since the file is there to be shown; a write or an edit when it ends, with the path of the
       * call that began it, and one that failed is not. Somewhere else is somebody else's file.
       */
      latestActivity(events: readonly PortalEvent[], folder: string): FileActivity | null;
      /** The file in the chat's folder a call of the agent's reads or changes (`read`, `write`, `edit`), by its path there; undefined for any other call. */
      ofCall(call: ToolCallView, folder: string): string | undefined;
      /**
       * Markdown with the pictures the agent wrote as paths in the chat's folder (`![chart](plots/chart.png)`) turned into the
       * addresses `url(path)` gives, which is what makes them draw: the Markdown renderer blocks a relative image. An address
       * that already is one (a web picture, a data: URL, the portal's own) is left alone, and so is a path outside `folder`.
       * `base` is the folder the Markdown itself lies in, relative to the chat's folder: a relative path is read from there.
       */
      pictures(markdown: string, folder: string, url: (path: string) => string, base?: string): string;
    };
    /** The jobs the agent left running in a chat (`ChatFeed.background` lists them). */
    background: {
      stop(chatId: string, key: string): Promise<void>;
      /** Forgets the jobs that have finished. */
      clear(chatId: string): Promise<void>;
      /** What the job wrote to its output file from byte `from` on, and the file's length now (the `from` to ask with next). */
      output(chatId: string, key: string, from?: number): Promise<{ text: string; from: number; size: number }>;
    };
  };
  shortcuts: {
    /** A shortcut of the extension's: see `Shortcut`. Its label is translated as the extension's own texts are. */
    register(shortcut: Shortcut): () => void;
  };
  server: {
    /** What the package's server half says to the pages open on a chat, whichever chat. */
    on(handler: (chatId: string, data: unknown) => void): () => void;
    /**
     * What the package's server half pushes to `topic` (`portal.push(topic, data)`), on any page: one with no chat
     * open as well. The server half decides who may listen (`onListen`) and tells the page where things stand as it
     * begins to, so a handler hears that first, then each change. A page that loses its connection asks again by
     * itself, and is told where things stand again; a topic the server refuses is not heard. Returns the unsubscribe.
     */
    on(topic: string, handler: (data: unknown) => void): () => void;
  };
  theme: {
    /** A theme of the package's, chosen in Settings like any other. */
    register(theme: ThemeGiven): () => void;
    /** The themes there are, any extension's: `id` is "<package>/<id>". */
    list(): { id: string; name: string; extension: string }[];
    /** The theme in effect, or null for the portal's own colours. */
    current(): string | null;
    /** Switch to a theme by its id, or to the portal's own with null. Kept in this browser. */
    set(id: string | null): void;
    /** A hook: light or dark, and the theme in effect, drawn again when either changes. */
    use(): { mode: "light" | "dark"; theme: string | null };
  };
}

/** An extension's browser half: the default export of its module. */
export type BrowserHalf = (portal: Portal) => void | (() => void);
