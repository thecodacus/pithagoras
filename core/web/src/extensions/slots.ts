import { createElement, memo, useSyncExternalStore, type ComponentType } from "react";

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

// What a slot's entry says of itself and what its component is given are the public contract,
// @pithagoras/extension-api: the portal draws exactly that.
import type { Entry, SlotName } from "@pithagoras/extension-api";
export type { Channel, Chat, ChatProps, Entry, PanelHandle, PanelProps, Panels, SlotMap, SlotName, ToolCallView } from "@pithagoras/extension-api";

const SLOTS: readonly SlotName[] = ["chat.panel", "chat.header.action", "chat.background", "chat.overlay", "chat.composer.above", "chat.tool", "chat.tool.action", "voice.window", "nav.page", "settings.page"];

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
 * An extension's part, drawn inside an element that says whose it is
 * (`data-extension`) and that is laid out as if it were not there. What an
 * extension's stylesheet scopes to that, as the utilities `buildExtension`
 * makes are, reaches its own parts and nothing of the portal's or another
 * extension's.
 */
const marked = (extension: string, Part: ComponentType<any>) =>
  memo(function ExtensionPart(props: object) {
    return createElement("div", { "data-extension": extension, style: { display: "contents" } }, createElement(Part, props));
  });

/**
 * Put `entry` into `slot` for `extension`. Returns what takes it out again.
 * Throws for a slot there is none of, an entry without an id or a component,
 * and a second entry of the extension's under one id.
 */
export function register<S extends SlotName>(extension: string, slot: S, entry: Entry<S>): () => void {
  if (!SLOTS.includes(slot)) throw new Error(`There is no slot called "${slot}". The slots are: ${SLOTS.join(", ")}`);
  if (typeof entry?.id !== "string" || !entry.id || !entry.component) throw new Error(`An entry in ${slot} needs an id and a component`);
  const tool = (entry as { tool?: unknown }).tool;
  if (slot === "chat.tool.action" && tool !== undefined && typeof tool !== "string" && !(tool instanceof RegExp)) {
    throw new Error(`An entry in ${slot} names its tool by a name or a pattern, or leaves it out for every call`);
  }
  const key = `${extension}/${entry.id}`;
  const before = held.get(slot) ?? NONE;
  if (before.some((e) => e.key === key)) throw new Error(`${extension} already has an entry called "${entry.id}" in ${slot}`);
  // Each of its components is drawn again only when what it is given changes: the chat around it is drawn again
  // with every token of a reply, and an extension's part of it must not be.
  const parts = entry as { header?: ComponentType<any>; actions?: ComponentType<any> };
  const row = {
    ...entry,
    component: marked(extension, entry.component as ComponentType<any>),
    ...(parts.header ? { header: marked(extension, parts.header) } : {}),
    ...(parts.actions ? { actions: marked(extension, parts.actions) } : {}),
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
