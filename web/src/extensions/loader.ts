import * as React from "react";
import { useSyncExternalStore } from "react";
import { api, EXTENSIONS_CHANGED, type ExtensionUi } from "../api";
import { register, type Entry, type SlotName } from "./slots";

/**
 * Loads the browser halves of the installed extensions into the page, and
 * takes one out again when its package is removed, switched off or changed.
 *
 * A browser half is a JavaScript module whose default export is called with
 * the portal, as it is for that extension:
 *
 *   export default function (portal) {
 *     const { React } = portal;
 *     portal.slots.register("chat.panel", { id: "notes", title: "Notes", component: Notes });
 *   }
 *
 * It may return a function, called when the extension is taken out. What it
 * registered goes with it either way.
 */
export interface Portal {
  /** Of this interface: raised when something an extension relies on changes. */
  version: 1;
  /** The package's name, which its entries and its messages go by. */
  extension: string;
  /** The portal's own React: what a component drawn in a slot has to be made with, for its hooks to work. */
  React: typeof React;
  slots: { register<S extends SlotName>(slot: S, entry: Entry<S>): () => void };
  /** Go to a page of the portal: "/s/<chat id>", "/x/<extension>/<page id>". */
  navigate(path: string): void;
}

type Loaded = { entry: string; leave: () => void };

const loaded = new Map<string, Loaded>();
/** Why an extension's browser half is not in the page, by its package's name. */
let failures: Readonly<Record<string, string>> = {};
/** Whether the list has been gone through once: before that, an entry not there may only not be there yet. */
let settled = false;
const watchers = new Set<() => void>();
const changed = () => { for (const watcher of [...watchers]) watcher(); };

let go: (path: string) => void = () => {};
/** How `portal.navigate` goes somewhere: the app's own router, once it is there. */
export function setNavigate(navigate: (path: string) => void): void {
  go = navigate;
}

const quietly = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    console.error("[extensions]", e);
  }
};

async function activate(ext: ExtensionUi): Promise<void> {
  const undo: (() => void)[] = [];
  const leave = () => undo.reverse().forEach(quietly);
  try {
    if (ext.style) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = ext.style;
      link.dataset.extension = ext.name;
      document.head.append(link);
      undo.push(() => link.remove());
    }
    const module = await import(/* @vite-ignore */ ext.entry);
    if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
    const portal: Portal = {
      version: 1,
      extension: ext.name,
      React,
      slots: {
        register: (slot, entry) => {
          const off = register(ext.name, slot, entry);
          undo.push(off);
          return off;
        },
      },
      navigate: (path) => go(path),
    };
    const left = await module.default(portal);
    if (typeof left === "function") undo.push(left);
    loaded.set(ext.name, { entry: ext.entry, leave });
  } catch (e) {
    // What it managed to register before it failed is taken out: half an extension is not shown.
    leave();
    failures = { ...failures, [ext.name]: (e as Error)?.message || String(e) };
    console.error(`[extensions] ${ext.name} could not be loaded:`, e);
  }
}

async function sync(): Promise<void> {
  try {
    const { extensions } = await api.extensionUi();
    // Gone, or its module changed: the address of a module carries its revision.
    for (const [name, was] of [...loaded]) {
      if (extensions.some((ext) => ext.name === name && ext.entry === was.entry)) continue;
      was.leave();
      loaded.delete(name);
    }
    failures = {};
    for (const ext of extensions) if (!loaded.has(ext.name)) await activate(ext);
  } catch (e) {
    // The list could not be read: what is loaded stays, and the next change asks again.
    console.error("[extensions] could not read which extensions have an interface:", e);
  } finally {
    settled = true;
    changed();
  }
}

let queue: Promise<void> = Promise.resolve();
/** Bring what is in the page in line with what is installed. One at a time: a second ask waits for the first. */
export function loadExtensions(): Promise<void> {
  return (queue = queue.then(sync));
}

let started = false;
/**
 * Load them, and from then on follow what is installed. Once per page load:
 * the app's shell is drawn again on every route.
 */
export function startExtensions(): void {
  if (started) return;
  started = true;
  void loadExtensions();
  const again = () => void loadExtensions();
  window.addEventListener(EXTENSIONS_CHANGED, again);
  // An add-on of the portal's can be a package too: the subagents are.
  window.addEventListener("features-changed", again);
}

function watch(watcher: () => void) {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

/** Whether the installed extensions have been gone through, and why any of them is not in the page. */
export function useExtensions(): { settled: boolean; failures: Readonly<Record<string, string>> } {
  return { settled: useSyncExternalStore(watch, () => settled), failures: useSyncExternalStore(watch, () => failures) };
}
