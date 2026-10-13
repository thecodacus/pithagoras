import * as React from "react";
import { useSyncExternalStore } from "react";
import { api, ApiError, EXTENSIONS_CHANGED, json, type ExtensionUi } from "../api";
import { useLanguage } from "../i18n";
import { onChatFeed, useChatFeed, type ChatFeed } from "./chat-feed";
import { hasCommand, registerCommand, runCommand } from "./commands";
import { ui, type Ui } from "./kit";
import { panels, type PanelController } from "./panels";
import { chatOnScreen, extensionGone, extensionHere, onlyWaitFor, onServerPush, serverPush } from "./server-feed";
import { register, type Entry, type SlotName } from "./slots";
import { addStrings, forgetStrings, translate } from "./strings";
import { choose, registerTheme, themes, themesSettled, type ThemeGiven } from "./themes";
import { chosenPalette, usePalette, useResolvedTheme } from "../theme";

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
  theme: {
    /** A theme of the package's: colours in place of the portal's own, chosen in Settings like any other. */
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

type Loaded = { stamp: string; leave: () => void };

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

/** The hook behind `portal.theme.use`. */
function useThemeNow(): { mode: "light" | "dark"; theme: string | null } {
  return { mode: useResolvedTheme(), theme: usePalette()?.id ?? null };
}

/** What of an extension the page holds: by these it is known whether what is installed is what is loaded. */
const stamp = (ext: ExtensionUi) => JSON.stringify([ext.entry ?? null, ext.server ?? null, ext.themes ?? null]);

/** How long an extension's module may take to be fetched and called: one that hangs must not keep the others, or the page, waiting. */
const LOAD_MS = 15_000;

function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`It had not finished ${what} after ${ms / 1000} seconds`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function activate(ext: ExtensionUi): Promise<void> {
  // What its module put into the page, to take out again; and its themes, which need no module and are kept whatever becomes of it.
  const undo: (() => void)[] = [];
  const themesOff: (() => void)[] = [];
  let gone = false;
  /**
   * Something the module registered: undone when the extension goes, and
   * forgotten once it has undone it itself, so that a component that listens
   * and stops many times leaves nothing behind. Asked for after the extension
   * has gone (a module still at work when it was given up on), it is undone at once.
   */
  const kept = (off: () => void): (() => void) => {
    if (gone) return quietly(off), () => {};
    const once = () => {
      const at = undo.indexOf(once);
      if (at === -1) return;
      undo.splice(at, 1);
      off();
    };
    undo.push(once);
    return once;
  };
  const leaveModule = () => {
    gone = true;
    for (const fn of [...undo].reverse()) quietly(fn);
    undo.length = 0;
  };
  const leave = () => {
    leaveModule();
    themesOff.forEach(quietly);
  };
  const entry = ext.entry;
  const load = async (entry: string) => {
    if (ext.style) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = ext.style;
      link.dataset.extension = ext.name;
      document.head.append(link);
      kept(() => link.remove());
    }
    const module = await import(/* @vite-ignore */ entry);
    if (typeof module.default !== "function") throw new Error("Its module has no default export to call");
    const portal: Portal = {
      version: 1,
      extension: ext.name,
      React,
      slots: { register: (slot, entry) => kept(register(ext.name, slot, entry)) },
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
      commands: { register: (name, run) => kept(registerCommand(name, run)), run: runCommand, has: hasCommand },
      panels,
      chats: { use: useChatFeed, on: (chatId, handler) => kept(onChatFeed(chatId, handler)) },
      server: { on: (handler) => kept(onServerPush(ext.name, handler)) },
      theme: {
        register: (theme) => kept(registerTheme(ext.name, theme)),
        list: () => themes().map((theme) => ({ id: theme.id, name: theme.name, extension: theme.extension })),
        current: () => chosenPalette()?.id ?? null,
        set: choose,
        use: useThemeNow,
      },
    };
    kept(() => {
      extensionGone(ext.name);
      forgetStrings(ext.name);
    });
    const left = await module.default(portal);
    if (typeof left === "function") kept(left);
  };
  try {
    // The themes its package.json names need no module: a package may be nothing but themes.
    for (const theme of ext.themes ?? []) themesOff.push(registerTheme(ext.name, theme));
    if (entry) await within(LOAD_MS, load(entry), "loading");
    loaded.set(ext.name, { stamp: stamp(ext), leave });
    if (!entry) return;
    // What its server half said before it was here is handed over now.
    extensionHere(ext.name);
    if (ext.server) await catchUp(ext.name);
  } catch (e) {
    // What its module managed to register before it failed is taken out: half an extension is not shown.
    leaveModule();
    failures = { ...failures, [ext.name]: (e as Error)?.message || String(e) };
    console.error(`[extensions] ${ext.name} could not be loaded:`, e);
    // Held as failed, under a stamp nothing has: its themes are still there to choose, and it is tried again the next time what is installed is gone through.
    loaded.set(ext.name, { stamp: "", leave });
  }
}

/**
 * A module that came into the page after the chat's stream had opened was not
 * there to be told where things stand: it is told now, as its server half
 * would say it now. Not on the page's first load, when what the stream said
 * waited for it.
 */
async function catchUp(name: string): Promise<void> {
  const chatId = chatOnScreen();
  if (!settled || !chatId) return;
  try {
    const { pushes } = await api.extensionOpening(chatId, name);
    for (const data of pushes) serverPush(chatId, name, data);
  } catch (e) {
    console.error(`[extensions] ${name} could not be told where its server half stands:`, e);
  }
}

async function sync(): Promise<void> {
  try {
    const { extensions } = await api.extensionUi();
    // Gone, or its module changed: the address of a module carries its revision.
    // Or its server half came or went, or its themes changed: the module is told where its routes are as it is called.
    // Or it failed last time: it is tried again.
    for (const [name, was] of [...loaded]) {
      if (extensions.some((ext) => ext.name === name && stamp(ext) === was.stamp)) continue;
      was.leave();
      loaded.delete(name);
    }
    failures = {};
    serverFailures = Object.fromEntries(extensions.filter((ext) => ext.serverError).map((ext) => [ext.name, ext.serverError!]));
    onlyWaitFor(extensions.filter((ext) => ext.entry).map((ext) => ext.name));
    for (const ext of extensions) if (!loaded.has(ext.name)) await activate(ext);
    // Only now is it known which themes there are: one chosen that is gone gives way. Not one whose
    // extension is installed and failed to load just now: that is not the person's choice undone.
    themesSettled(Object.keys(failures));
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
