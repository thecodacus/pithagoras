/**
 * What an extension's browser half is given: the `portal` its module's
 * default export is called with, and what the portal's slots hand the
 * components drawn in them. The portal implements exactly this, and is
 * checked against it when it is built.
 *
 * See "Building an extension": https://thecodacus.github.io/pithagoras/guide/extension-ui
 */
import type { ComponentType, KeyboardEvent, LazyExoticComponent, ReactNode } from "react";
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
  /**
   * Shows the panel, its head and its body, on the whole screen, where the browser lets a page: the panel beside it
   * stays where it is. Closed, it leaves the screen. Escape gives it its place back. Called from something the person
   * did (a click), while the panel is open; otherwise nothing happens.
   */
  fullscreen(): void;
}

export type PanelProps = ChatProps & { close(): void; panel: PanelHandle };

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
  /** When it started running, in milliseconds as `Date.now()` counts them: for how long it has been going. */
  since?: number;
  /** Set when the run ended with the call still open: it never said how it came out. */
  interrupted?: true;
  /**
   * The files it gave the person, once it ended: what its `details.files`
   * named, as the portal found them in the chat's folder by their bytes. `url`
   * is where the page fetches each: drawn, played, or saved for a `file`.
   * The portal's card draws them; an extension's own card that leaves out
   * `card` draws them its own way.
   */
  files?: CallFile[];
}

/** A model the chat's model menu lists: see `chat.model.menu`. */
export interface MenuModel {
  provider: string;
  id: string;
  /** What it is called, where its provider says. */
  name?: string;
}

/** A picture for `ui.ImageViewer`. */
export interface ViewerPicture {
  /** Tells it from the others in the list, and is what `from` of another points at. */
  id: string;
  /** Where the picture is, as an <img> takes it. Also what Open in a new tab and Download go to. */
  src: string;
  /** What it shows, for those who cannot see it. */
  alt: string;
  /** Shown under it, when there is something to say: its title. */
  caption?: string;
  /** What Download names the file, when the address does not say. */
  fileName?: string;
  /** The `id` of the picture this one was edited from, where that is known. */
  from?: string;
}

/**
 * How something goes, for `ui.useLeaveRef`: as a dialog does (the dimming lets go and what is in it sinks), a menu,
 * a panel (out through the edge it is docked at, its `data-dock`), a deleted row, a message, a page, or something that
 * no longer exists.
 */
export type Leave = "dialog" | "menu" | "panel" | "row" | "message" | "page" | "gone";

/** A file a call gave the person, in the chat's folder: see ToolCallView.files. */
export interface CallFile {
  /** Relative to the chat's folder. */
  path: string;
  kind: "picture" | "video" | "file";
  title?: string;
  /** The files it was made from, relative to the chat's folder. */
  from?: string[];
  url: string;
  /**
   * For a picture in a chat's conversation: opens the chat's picture viewer
   * at it, with the conversation's other pictures to step through.
   * `ui.ImagePreview` given the file does this when it is clicked.
   */
  open?(): void;
}

/** How loud each side of a voice conversation is now, from 0 to 1: what the microphone hears, and what is played. */
export interface AvatarLevels {
  input: number;
  output: number;
}

/**
 * What voice mode is doing, as an avatar shows it: the person is heard
 * (`input`); the reply is played (`output`); the agent is at work on what to
 * say and nothing is played (`thinking`, while the stage says Transcribing,
 * Thinking, Preparing your reply or Compacting context); the microphone is
 * off and nothing else is going on (`muted`); or none of these (`idle`).
 */
export type AvatarMode = "idle" | "input" | "output" | "thinking" | "muted";

/** What an entry of `voice.avatar` is drawn with. */
export interface AvatarProps {
  /** The agent it is drawn for. */
  agent: { id: string; name: string };
  mode: AvatarMode;
  /**
   * The levels now. They change many times a second and the component is not
   * drawn again for them: read `levels.current.input` and
   * `levels.current.output` in an animation frame of your own. The object in
   * `current` is replaced at times, so read it through `levels` each time
   * rather than keeping it.
   */
  levels: { readonly current: AvatarLevels };
  /**
   * A picture of the agent, not voice mode: its card on the Agents page, and
   * the avatar on its page. `mode` is "idle" and the levels stay 0. Draw it
   * once and keep nothing running for it: a page can show many.
   */
  still: boolean;
  /**
   * The portal's orb for the same agent, in the same mode and with the same
   * levels: to draw while there is nothing of your own to draw yet (a model
   * still loading, a drawing context that was lost).
   */
  orb: ReactNode;
}

export interface SlotMap {
  /**
   * A panel beside the conversation, docked, floated and sized like the
   * portal's own. The chat's header has its button. `header` is drawn in its
   * head in place of its title (tabs, a count), `actions` before its close
   * button. `useButton` is a hook, called as the chat's header is drawn: how
   * its button is for this chat. `name` is a name of its own that
   * `portal.panels.open(name, params)` reaches it by, from anywhere: the
   * subagent extension's goes by "agents", the terminal's by "terminal".
   * Of two extensions that name a panel alike, the one first in the slot's
   * order has it (a lower `order`, then the one whose extension is first in the list of installed extensions).
   * `bleed` makes its body black from edge to edge, and not a box that
   * scrolls: for what fills it by itself, a frame or another program's screen.
   */
  "chat.panel": {
    entry: {
      title: string;
      name?: string;
      icon?: ComponentType;
      header?: ComponentType<PanelProps>;
      actions?: ComponentType<PanelProps>;
      useButton?: (props: ChatProps) => { hidden?: boolean; live?: boolean; title?: string };
      bleed?: boolean;
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
  /**
   * Chips in the running tray, just above the message box, before the
   * chat's background jobs and the statuses extensions set: what the
   * extension has going in this chat, each a way into where it is shown
   * (`ui.TrayChip`). The component draws nothing while nothing is going; the
   * tray shows only while something in it is drawn.
   */
  "chat.tray": { entry: {}; props: ChatProps };
  /**
   * A row in the chat's model menu, under its models: something else of the
   * chat's that runs on a model (what its subagents run on). `models` are
   * those the menu lists. It is drawn as the menu opens, so what it shows is
   * best fetched with the chat (`chat.background`), not then: a row that
   * arrives a moment later pushes the rest of the menu down.
   */
  "chat.model.menu": { entry: {}; props: { chat: Chat; models: readonly MenuModel[] } };
  /**
   * How a call of one tool is drawn in the conversation, in place of the
   * portal's card for it. `card` is that card.
   *
   * `tile`, where given, is drawn small on the call's card in voice mode, in
   * place of the mark that says how it stands: a picture being made, say.
   * `describe` is what that card says of the call, in place of the portal's
   * words for a tool it does not know ("Using make picture").
   */
  "chat.tool": {
    entry: {
      tool: string;
      tile?: ComponentType<{ call: ToolCallView; chat: Chat }>;
      describe?: (call: ToolCallView, chat: Chat) => { label: string; detail?: string } | undefined;
    };
    props: ChatProps & { call: ToolCallView; card: ReactNode };
  };
  /**
   * Something to do with a call of a tool, drawn on the portal's card for it
   * when it is opened, under what the call returned: "Open in the terminal".
   * `tool` is the tool's name, or a pattern of names; without it, every call.
   * `cut` is whether the card shows only the end of the output. `chat` is
   * the chat whose conversation the card is in; a card elsewhere, such as a
   * subagent's run, has none. The component draws nothing for a call it has
   * nothing for. `ui.ToolLink` is the portal's own look for it. With `head`
   * it is drawn beside the card's head instead, where it shows while the card
   * is folded too: a way in that should not wait for the card to be opened
   * (Watch, on a call that started a subagent).
   */
  "chat.tool.action": { entry: { tool?: string | RegExp; head?: boolean }; props: { call: ToolCallView; cut: boolean; panels: Panels; chat?: Chat } };
  /**
   * A window in voice mode, placed and sized like the portal's own. `place`
   * is where it goes when it has the choice: at the side, or in the middle.
   * `useAutoOpen` is a hook, called while voice mode is on in a chat: a count
   * that opens the window each time it grows (the agent ran a command). A
   * card of a call in voice mode that `opensFor` says yes to opens it when
   * tapped, for calls the portal's own windows are not for. Its own shortcut
   * is `portal.shortcuts`. `useButton` is a hook, called as voice mode's
   * toolbar is drawn, while the window is open too (it has no button then):
   * how the window's button there is for this chat, as a panel's is in the
   * chat's header.
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
      /** `hidden`: no button while it is closed (it still opens for work, a card and a shortcut). `live`: a dot that says something in it is running. `title`: what the button says when pointed at. */
      useButton?: (props: ChatProps) => { hidden?: boolean; live?: boolean; title?: string };
      /** `chat` is the chat on screen: its `workspace` tells a path in its folder from one elsewhere. */
      opensFor?: (call: ToolCallView, chat: Chat) => boolean;
      /** What the card of a call it opens for says, in place of the portal's words for a tool it does not know ("Using canvas write"). */
      describe?: (call: ToolCallView, chat: Chat) => { label: string; detail?: string } | undefined;
    };
    props: ChatProps & { close(): void; opened: VoiceWindowOpened; maximized: boolean; maximize(): void; restore(): void };
  };
  /**
   * The agent, drawn where voice mode draws its orb, for an agent whose
   * avatar it was chosen as. The agent's Avatar dialog lists every entry
   * beside the orb, by its `title` and `description` (translated as `title`
   * is), and what is chosen is kept as "<package>/<id>": an id kept the same
   * across versions keeps the agents that chose it, and the two together must
   * stay within 256 characters.
   *
   * It is drawn in the orb's box, which is square and changes size without
   * the component being made again (from 380 pixels in the middle of the
   * stage to 64 in its dock on a phone), and may draw past it as the orb's
   * glow does, by 3/14 of its size on each side. It is drawn too in the
   * dialog's preview, with a made-up voice, and `still` on the Agents page;
   * there the box is the whole square it is drawn on, and what is past it is
   * cut.
   * Where it is not in the page (its extension is not, or has not registered
   * it yet) or fails to draw, the orb is drawn in its place.
   */
  "voice.avatar": { entry: { title: string; description?: string }; props: AvatarProps };
  /**
   * A page of the portal, at /x/<extension>/<id>, with an entry in the
   * sidebar. `useShown` is a hook, called as the sidebar is drawn: whether the
   * entry is listed now (not while the service the page is for is not set
   * up). Until it says yes, it is not. The page is at its address either way.
   */
  "nav.page": { entry: { title: string; icon?: ComponentType; useShown?: () => boolean }; props: {} };
  /**
   * The extension's page in Settings, above the fields the portal found for
   * it, at /settings/x/<extension>. `title` and `icon` are its entry in
   * Settings' list, in place of the extension's name and the mark every
   * extension has. `search` is what Settings' search finds on the page,
   * beside the extension's name: each a `title`, the heading on the page it is
   * under (`section`, scrolled to), and other `words` someone might type for
   * it. Titles and headings are said in the page's language as the
   * extension's own `t` says them, so a heading is found as the page shows it.
   */
  "settings.page": { entry: { title?: string; icon?: ComponentType; search?: { title: string; section?: string; words?: string }[] }; props: {} };
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
  /**
   * Markdown as the conversation draws it: code, tables, diagrams, and no picture from another site. A link is a
   * button that asks before it opens the address in a new tab; `components.a`, where given, draws the links instead
   * (one to a page of the extension's own, opened there).
   */
  Markdown: ComponentType<{ children: string; animated?: boolean; className?: string; components?: { a?: ComponentType<{ href?: string; children?: ReactNode }> } }>;
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
  /**
   * A conversation as the chat draws its own, from its events (`PortalEvent`s, as a chat's stream carries them: pi's,
   * and `portal_prompt` for what was asked): what was asked, the replies with their thinking, each tool call on its
   * card, compactions and notices. A call of a tool an extension draws (`chat.tool`) is drawn by that extension, as in
   * `chat`, where one is given. A question asked of the person is left out: only a chat's own agent asks one. `running`:
   * it is still being written, and its last reply streams in. `empty` is drawn while there is nothing yet to show. The
   * rows are drawn one under the other; the box that scrolls them is the caller's.
   */
  Transcript: ComponentType<{ events: readonly PortalEvent[]; running?: boolean; chat?: Chat; empty?: ReactNode }>;
  /**
   * A chip for `chat.tray`, as the portal draws a background job there: a ring that spins, `icon`, `label`, `detail`
   * in a quieter colour, and how long it has run since `since` (ms since the epoch), counting. `onClick` opens where
   * it is shown; without it the chip is only a label.
   */
  TrayChip: ComponentType<{ icon?: ComponentType<{ "aria-hidden"?: boolean; className?: string }>; label: string; detail?: string; since?: number; title?: string; onClick?: () => void }>;
  /** The small ring that spins beside what is running, as on a tool call's card; given a fraction from 0 to 1, it fills instead. */
  Ring: ComponentType<{ value?: number; className?: string }>;
  /** Text that shimmers, as "Thinking" does while the agent thinks: for what is going on now. */
  Shimmer: ComponentType<{ children: ReactNode }>;
  /**
   * A picture as the conversation shows one a tool makes: the place it will
   * be in while it is made (`making`, with how long it has taken), the picture
   * once it is there (`done`), or why it is not (`failed`, `reason`). An edit
   * shows its original (`before`) until the new one arrives over it. A clip
   * (`kind: "video"`) shows its poster, or its first frame, with a mark that it
   * plays. `file`, a picture a call gave, is the picture shown, and a click
   * opens the chat's viewer at it; `onOpen` is a click otherwise. `compact` is
   * the small tile voice mode's cards show, and `actions` what goes under it.
   * `pictureId` marks it (`data-picture-id`) for a viewer's `anchor` to find.
   */
  ImagePreview: ComponentType<{
    state: "making" | "done" | "failed";
    file?: CallFile;
    kind?: "picture" | "video";
    src?: string;
    video?: string;
    before?: string;
    edit?: boolean;
    ratio?: number;
    title?: string;
    detail?: string;
    reason?: string;
    elapsed?: number;
    compact?: boolean;
    onOpen?: () => void;
    actions?: ReactNode;
    pictureId?: string;
  }>;
  /**
   * The portal's picture viewer, over the page: the pictures to step through,
   * opened at `startId`, with zoom, Open in a new tab and Download. `anchor` is
   * where focus goes when it closes, for the picture shown last; `actions` are
   * more buttons beside Close, for the picture shown.
   */
  ImageViewer: ComponentType<{
    pictures: ViewerPicture[];
    startId: string;
    onClose: () => void;
    anchor?: (id: string) => HTMLElement | null | undefined;
    actions?: (picture: ViewerPicture) => ReactNode;
  }>;
  /**
   * A dialog over the page, as the portal's own: Escape and a click beside it
   * close it, after asking when `unsaved` says something typed in it is not
   * saved (or a part of it says so with `useUnsavedDraft`).
   */
  Modal: ComponentType<{ title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; unsaved?: boolean }>;
  /**
   * A group of settings that folds, as Settings' own: its `title` and a
   * `summary` of what is set in it while it is folded. Settings' search opens
   * it when what it finds is in it.
   */
  DetailsGroup: ComponentType<{ title: string; summary: ReactNode; defaultOpen?: boolean; children: ReactNode }>;
  /**
   * A hook: this part of a dialog (a page in Settings, a `Modal`) holds
   * something typed in that is not saved, so closing the dialog asks first.
   */
  useUnsavedDraft(unsaved: boolean): void;
  /** A question with two answers, asked over the page: resolves true for yes. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /**
   * The look of the portal's own fields and buttons, as class names for a
   * `className`; `viewerButton` and `iconButton` are the buttons over a
   * picture and in a viewer's head (`aria-pressed` drawn as chosen).
   */
  classes: { input: string; inputSmall: string; codeArea: string; button: string; primary: string; primarySmall: string; ghost: string; viewerButton: string; iconButton: string };
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
  tabKeys(event: KeyboardEvent<HTMLElement>): void;
  /**
   * A hook: the ref for the one element a part draws (a viewer of its own over
   * the page, say), so that when it goes, a picture of it leaves as the
   * portal's own do, where the animations are on (Settings → This browser)
   * and the system does not ask for less motion. `how` may be a function,
   * asked as it goes, that says null for "not this time".
   */
  useLeaveRef<T extends HTMLElement>(how: Leave | (() => Leave | null)): (element: T | null) => void;
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
  /**
   * Go to a page of the portal: "/s/<chat id>", "/x/<extension>/<page id>",
   * "/settings/x/<extension>". With `replace`, in place of the page shown in
   * the browser's history (a page that keeps what it shows in its address).
   */
  navigate(path: string, options?: { replace?: boolean }): void;
  /** A hook: the page's address, drawn again when it changes, Back and Forward included. */
  useLocation(): { path: string; search: string };
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
    /** How long something has run, in whole seconds, as the chat says it: "42s", "3m 05s". */
    elapsed(seconds: number): string;
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
  /** The panels of the chat on screen, any of them: an extension's, by "<package>/<id>" or by the name it gave itself, as Files' is "files". */
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
