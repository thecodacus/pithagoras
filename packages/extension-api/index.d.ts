/**
 * What an extension's browser half is given: the `portal` its module's
 * default export is called with, and what the portal's slots hand the
 * components drawn in them. The portal implements exactly this, and is
 * checked against it when it is built.
 *
 * See docs/guide/extension-ui.md, "Building an extension".
 */
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
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
}

export type PanelProps = ChatProps & { close(): void; panel: PanelHandle };

/** A call of a tool, as its row in the conversation has it. */
export interface ToolCallView {
  /** The tool's name. */
  name: string;
  callId?: string;
  status: "running" | "done" | "error";
  /** What it was called with. */
  input: Record<string, unknown>;
  /** What it has returned so far, as text: its end, of a long one. */
  output?: string;
  /** What it reported about itself beside its text: a tool result's `details`. */
  details?: unknown;
}

export interface SlotMap {
  /**
   * A panel beside the conversation, docked, floated and sized like the
   * portal's own. The chat's header has its button. `header` is drawn in its
   * head in place of its title (tabs, a count), `actions` before its close
   * button. `useButton` is a hook, called as the chat's header is drawn: how
   * its button is for this chat. `name` is a name of its own that
   * `portal.panels.open(name, params)` reaches it by, from anywhere: the
   * portal's own panels go by "files", "git", "terminal", "browser", "agents"
   * and "canvas", and while one of those is the portal's, it is the one.
   * Of two extensions that name a panel alike, the first loaded has it.
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
   * `cut` is whether the card shows only the end of the output. The
   * component draws nothing for a call it has nothing for. `ui.ToolLink` is
   * the portal's own look for it.
   */
  "chat.tool.action": { entry: { tool?: string | RegExp }; props: { call: ToolCallView; cut: boolean; panels: Panels } };
  /**
   * A window in voice mode, placed and sized like the portal's own. `place`
   * is where it goes when it has the choice: at the side, or in the middle.
   * `useAutoOpen` is a hook, called while voice mode is on in a chat: a count
   * that opens the window each time it grows (the agent ran a command). A
   * card of a call in voice mode that `opensFor` says yes to opens it when
   * tapped. Its own shortcut is `portal.shortcuts`.
   */
  "voice.window": {
    entry: {
      title: string;
      icon?: ComponentType;
      place?: "side" | "middle";
      useAutoOpen?: (props: ChatProps) => number;
      opensFor?: (call: ToolCallView) => boolean;
    };
    props: ChatProps & { close(): void };
  };
  /** A page of the portal, at /x/<extension>/<id>, with an entry in the sidebar. */
  "nav.page": { entry: { title: string; icon?: ComponentType }; props: {} };
  /** The extension's page in Settings, above the fields the portal found for it. */
  "settings.page": { entry: {}; props: {} };
}
export type SlotName = keyof SlotMap;

export type Entry<S extends SlotName> = SlotMap[S]["entry"] & {
  /** Its name among the extension's entries in the slot. */
  id: string;
  /** Lower first; entries without one come after, in the order they were registered. */
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

/** A chat as the page has it. */
export interface ChatFeed {
  events: readonly PortalEvent[];
  /** The conversation as the portal draws it: messages, tool calls with their output, notices. Read `kind`; the rest is the portal's own and may change. */
  items: readonly { kind: string; [key: string]: unknown }[];
  /** The agent is at work. */
  running: boolean;
  /** The conversation is still being fetched. */
  loading: boolean;
}

/** The panels of the chat on screen, any of them, by name. */
export interface PanelController {
  isOpen(key: string): boolean;
  open(key: string, params?: unknown): void;
  close(key: string): void;
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
  RowsSkeleton: ComponentType<{ rows?: number; label?: string }>;
  SkeletonGroup: ComponentType<{ label: string; className?: string; children: ReactNode }>;
  /** Draws `fallback` in place of what it holds when that fails to draw, until `resetKey` changes. */
  ErrorBoundary: ComponentType<{ resetKey: string; fallback?: (error: Error) => ReactNode; children: ReactNode }>;
  PartFailed: ComponentType<{ error: Error }>;
  /** A link on a tool call's card, as the portal's own are drawn: for `chat.tool.action`. */
  ToolLink: ComponentType<{ icon?: ComponentType<{ "aria-hidden"?: boolean }>; onClick: () => void; children: ReactNode }>;
  /** A question with two answers, asked over the page: resolves true for yes. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The look of the portal's own fields and buttons, as class names for a `className`. */
  classes: { input: string; inputSmall: string; codeArea: string; button: string; primary: string; primarySmall: string; ghost: string };
  /** Copies text, where the page is served over plain HTTP as well. Resolves false when it could not. */
  copyText(text: string): Promise<boolean>;
  /** The browser's storage, which never throws: kept across reloads, and kept for the tab. */
  storage: { local: SafeStorage; session: SafeStorage };
  /** Keeps a scrolling box at its end while more comes, until the person scrolls away. */
  useFollowBottom<T extends HTMLElement>(options?: { paused?: () => boolean; nested?: boolean }): FollowBottom<T>;
  /** The time now, drawn again every `every` ms while `on`. */
  useNow(on: boolean, every?: number): number;
  /** Arrow keys for a row of tabs: on the element with `role="tablist"`. */
  tabKeys(event: KeyboardEvent<HTMLElement>): void;
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
  open(id: string): void;
  close(id: string): void;
}

/**
 * A keyboard shortcut of the extension's, listed in Settings → Shortcuts with
 * the portal's own and changed there the same way. `default` is the key it
 * has until someone chooses another, or null for none: a key the portal or
 * another extension has already is not taken from it. `run` returns false
 * when it had nothing to do, and the key goes on to whatever else wants it.
 * Voice-mode shortcuts work while voice mode is on, except while typing.
 */
export interface Shortcut {
  id: string;
  label: string;
  scope: "voice";
  default: KeyBinding | null;
  run(context: { chat: Chat; windows: VoiceWindows }): boolean | void;
}

// --- the portal ---

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
  /** A text in the language in effect: the package's own where it added one, as written otherwise. */
  t(text: string, vars?: Record<string, string | number>): string;
  locale: {
    /** The package's texts in a language ("de"), each by what the code says in English. */
    add(code: string, strings: Record<string, string>): () => void;
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
  /** The panels of the chat on screen, any of them: the portal's ("files", "terminal", …) and an extension's ("<package>/<id>"). */
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
  };
  shortcuts: {
    /** A shortcut of the extension's: see `Shortcut`. Its label is translated as the extension's own texts are. */
    register(shortcut: Shortcut): () => void;
  };
  server: {
    /** What the package's server half says to the pages open on a chat, whichever chat. */
    on(handler: (chatId: string, data: unknown) => void): () => void;
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
