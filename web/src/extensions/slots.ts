import { memo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

/**
 * Where an extension's browser half puts what it draws: the portal's slots.
 *
 * A slot is a place in the portal's own page, with a name. An extension
 * registers an entry in it, and the portal draws every entry a slot has, where
 * the slot is. Nothing here knows any extension.
 *
 * A place becomes a slot by being named in SlotMap, with what an entry says of
 * itself and what its component is given, and by the part of the portal that
 * owns the place drawing useSlot's entries there.
 */

/** The chat an entry is drawn in. */
export interface Chat {
  id: string;
  title: string;
  /** The folder the chat works in. */
  workspace: string;
}

/** To and from the package's own pi extension in the chat: see extension-ui.ts on the server. */
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
   * its button is for this chat.
   */
  "chat.panel": {
    entry: {
      title: string;
      icon?: ComponentType;
      header?: ComponentType<PanelProps>;
      actions?: ComponentType<PanelProps>;
      useButton?: (props: ChatProps) => { hidden?: boolean; live?: boolean; title?: string };
    };
    props: PanelProps;
  };
  /** A control in the chat's header, before the panels' buttons. */
  "chat.header.action": { entry: {}; props: ChatProps };
  /**
   * Something of the extension's that is there for as long as the chat is on
   * screen and draws nothing: it listens, and opens a panel when there is
   * something to see.
   */
  "chat.background": { entry: {}; props: ChatProps };
  /** Over the chat, placed by the extension itself: a window in a corner, a dialog. */
  "chat.overlay": { entry: {}; props: ChatProps };
  /** Above the message box: what is running, what waits. */
  "chat.composer.above": { entry: {}; props: ChatProps };
  /**
   * How a call of one tool is drawn in the conversation, in place of the
   * portal's card for it. `card` is that card, to draw as it is or beside
   * something of the extension's own.
   */
  "chat.tool": { entry: { tool: string }; props: ChatProps & { call: ToolCallView; card: ReactNode } };
  /** A window in voice mode, placed and sized like the portal's own. */
  "voice.window": { entry: { title: string; icon?: ComponentType }; props: ChatProps & { close(): void } };
  /** A page of the portal, at /x/<extension>/<id>, with an entry in the sidebar. */
  "nav.page": { entry: { title: string; icon?: ComponentType }; props: {} };
  /** The extension's page in Settings, above the fields the portal found for it. */
  "settings.page": { entry: {}; props: {} };
}
export type SlotName = keyof SlotMap;

const SLOTS: readonly SlotName[] = ["chat.panel", "chat.header.action", "chat.background", "chat.overlay", "chat.composer.above", "chat.tool", "voice.window", "nav.page", "settings.page"];

export type Entry<S extends SlotName> = SlotMap[S]["entry"] & {
  /** Its name among the extension's entries in the slot. */
  id: string;
  /** Lower first; entries without one come after, in the order they were registered. */
  order?: number;
  component: ComponentType<SlotMap[S]["props"]>;
};

/** An entry as the portal holds it. `key` is its name among all the slot's entries. */
export type Registered<S extends SlotName> = Entry<S> & { extension: string; key: string };

// Each slot's list is replaced when it changes, never changed in place: a list is what useSlot hands React to compare.
const held = new Map<SlotName, readonly Registered<SlotName>[]>();
const watchers = new Set<() => void>();
const NONE: readonly never[] = [];

function put(slot: SlotName, entries: readonly Registered<SlotName>[]) {
  held.set(slot, entries);
  for (const watcher of [...watchers]) watcher();
}

const ordered = (entries: Registered<SlotName>[]) =>
  entries
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => {
      if (a.entry.order === undefined || b.entry.order === undefined) return a.entry.order === b.entry.order ? a.at - b.at : a.entry.order === undefined ? 1 : -1;
      return a.entry.order - b.entry.order || a.at - b.at;
    })
    .map(({ entry }) => entry);

/**
 * Put `entry` into `slot` for `extension`. Returns what takes it out again.
 * Throws for a slot there is none of, an entry without an id or a component,
 * and a second entry of the extension's under one id.
 */
export function register<S extends SlotName>(extension: string, slot: S, entry: Entry<S>): () => void {
  if (!SLOTS.includes(slot)) throw new Error(`There is no slot called "${slot}". The slots are: ${SLOTS.join(", ")}`);
  if (typeof entry?.id !== "string" || !entry.id || !entry.component) throw new Error(`An entry in ${slot} needs an id and a component`);
  const key = `${extension}/${entry.id}`;
  const before = held.get(slot) ?? NONE;
  if (before.some((e) => e.key === key)) throw new Error(`${extension} already has an entry called "${entry.id}" in ${slot}`);
  // Each of its components is drawn again only when what it is given changes: the chat around it is drawn again
  // with every token of a reply, and an extension's part of it must not be.
  const parts = entry as { header?: ComponentType<any>; actions?: ComponentType<any> };
  const row = {
    ...entry,
    component: memo(entry.component as ComponentType<any>),
    ...(parts.header ? { header: memo(parts.header) } : {}),
    ...(parts.actions ? { actions: memo(parts.actions) } : {}),
    extension,
    key,
  } as unknown as Registered<SlotName>;
  put(slot, ordered([...before, row]));
  return () => {
    const now = held.get(slot) ?? NONE;
    if (now.includes(row)) put(slot, now.filter((e) => e !== row));
  };
}

/** What a slot holds now, in the order it is drawn. */
export const slotEntries = <S extends SlotName>(slot: S) => (held.get(slot) ?? NONE) as unknown as readonly Registered<S>[];

function watch(watcher: () => void) {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

/** A slot's entries, drawn again when they change. */
export function useSlot<S extends SlotName>(slot: S): readonly Registered<S>[] {
  return useSyncExternalStore(watch, () => slotEntries(slot));
}
