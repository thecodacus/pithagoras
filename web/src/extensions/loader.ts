import * as React from "react";
import { useSyncExternalStore } from "react";
import { api, ApiError, EXTENSIONS_CHANGED, json, type ExtensionUi } from "../api";
import { useLanguage } from "../i18n";
import { onChatFeed, useChatFeed, type ChatFeed } from "./chat-feed";
import { hasCommand, registerCommand, runCommand } from "./commands";
import { ui, type Ui } from "./kit";
import { panels, type PanelController } from "./panels";
import { extensionGone, extensionHere, onlyWaitFor, onServerPush } from "./server-feed";
import { register, type Entry, type SlotName } from "./slots";
import { addStrings, forgetStrings, translate } from "./strings";

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
  /** The portal's own building blocks: see kit.ts. */
  ui: Ui;
  api: {
    /** A request as the portal's own are made: JSON back, an ApiError with what was said for one refused, and a login that is gone told to the page. */
    json<T = unknown>(url: string, init?: RequestInit): Promise<T>;
    /** The address of a route of the package's own server half: `url("/notes")`. Throws when it has none running. */
    url(path: string): string;
    ApiError: typeof ApiError;
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
    /** Say what can be asked of the package by name, by another extension or the portal. Start the name with the package's. */
    register(name: string, run: (...args: any[]) => unknown): () => void;
    /** Ask for it. Throws when nothing answers to the name. */
    run(name: string, ...args: unknown[]): unknown;
    has(name: string): boolean;
  };
  /** The panels of the chat on screen, any of them: the portal's ("files", "terminal", …) and an extension's ("<package>/<id>"). */
  panels: PanelController;
  chats: {
    /**
     * A hook: a chat as the page has it (its events, the conversation, whether
     * the agent is at work). Give it `pick` to say what of it the component
     * uses: a chat changes with every token, and the component is then drawn
     * again only when what it picked has changed.
     */
    use<T = ChatFeed>(chatId: string, pick?: (feed: ChatFeed) => T, same?: (a: T, b: T) => boolean): T;
    /** The same outside a component: told each time the chat changes. Returns the unsubscribe. */
    on(chatId: string, handler: (feed: ChatFeed) => void): () => void;
  };
  server: {
    /** What the package's server half says to the pages open on a chat, whichever chat. Listened for as the module is called, nothing is missed. */
    on(handler: (chatId: string, data: unknown) => void): () => void;
  };
}

type Loaded = { entry: string; server?: string; leave: () => void };

const loaded = new Map<string, Loaded>();
/** Why an extension's browser half is not in the page, by its package's name. */
let failures: Readonly<Record<string, string>> = {};
/** Why an extension's server half is not running, as the portal says. */
let serverFailures: Readonly<Record<string, string>> = {};
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

async function activate(ext: ExtensionUi, entry: string): Promise<void> {
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
    const module = await import(/* @vite-ignore */ entry);
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
      ui,
      api: {
        json,
        url: (path) => {
          if (!ext.server) throw new Error(`${ext.name} has no server half running`);
          return `${ext.server}${path.startsWith("/") ? "" : "/"}${path}`;
        },
        ApiError,
      },
      t: (text, vars) => translate(ext.name, text, vars),
      locale: { add: (code, strings) => addStrings(ext.name, code, strings), use: useLanguage },
      commands: {
        register: (name, run) => {
          const off = registerCommand(name, run);
          undo.push(off);
          return off;
        },
        run: runCommand,
        has: hasCommand,
      },
      panels,
      chats: {
        use: useChatFeed,
        on: (chatId, handler) => {
          const off = onChatFeed(chatId, handler);
          undo.push(off);
          return off;
        },
      },
      server: {
        on: (handler) => {
          const off = onServerPush(ext.name, handler);
          undo.push(off);
          return off;
        },
      },
    };
    undo.push(() => {
      extensionGone(ext.name);
      forgetStrings(ext.name);
    });
    const left = await module.default(portal);
    if (typeof left === "function") undo.push(left);
    loaded.set(ext.name, { entry, server: ext.server, leave });
    // What its server half said before it was here is handed over now.
    extensionHere(ext.name);
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
    // Or its server half came or went: the module is told where its routes are as it is called.
    for (const [name, was] of [...loaded]) {
      if (extensions.some((ext) => ext.name === name && ext.entry === was.entry && ext.server === was.server)) continue;
      was.leave();
      loaded.delete(name);
    }
    failures = {};
    serverFailures = Object.fromEntries(extensions.filter((ext) => ext.serverError).map((ext) => [ext.name, ext.serverError!]));
    onlyWaitFor(extensions.filter((ext) => ext.entry).map((ext) => ext.name));
    for (const ext of extensions) if (ext.entry && !loaded.has(ext.name)) await activate(ext, ext.entry);
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
export function useExtensions(): { settled: boolean; failures: Readonly<Record<string, string>>; serverFailures: Readonly<Record<string, string>> } {
  return {
    settled: useSyncExternalStore(watch, () => settled),
    failures: useSyncExternalStore(watch, () => failures),
    serverFailures: useSyncExternalStore(watch, () => serverFailures),
  };
}
