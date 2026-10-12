import { useSyncExternalStore, type ComponentType } from "react";

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

export interface ChatProps {
  chat: Chat;
  channel: Channel;
}

/** The extension's own panels in the chat, by the id each was registered with. */
export interface Panels {
  isOpen(id: string): boolean;
  open(id: string): void;
  close(id: string): void;
}

export interface SlotMap {
  /** A panel beside the conversation, docked, floated and sized like the portal's own. The chat's header has its button. */
  "chat.panel": { entry: { title: string; icon?: ComponentType }; props: ChatProps & { close(): void } };
  /** A control in the chat's header, before the panels' buttons. */
  "chat.header.action": { entry: {}; props: ChatProps & { panels: Panels } };
  /** A page of the portal, at /x/<extension>/<id>, with an entry in the sidebar. */
  "nav.page": { entry: { title: string; icon?: ComponentType }; props: {} };
}
export type SlotName = keyof SlotMap;

const SLOTS: readonly SlotName[] = ["chat.panel", "chat.header.action", "nav.page"];

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
  const row = { ...entry, extension, key } as unknown as Registered<SlotName>;
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
