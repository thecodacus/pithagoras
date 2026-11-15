import { api } from "../api";
import { confirmDialog } from "../components/ConfirmDialog";
import { drafts } from "../drafts";
import { pending } from "../attachments";
import { fillFrom } from "../editor-fills";
import { extensionMessage } from "../extensions/channel";
import { followInstalled } from "../extensions/loader";
import { serverPush, setChatOnScreen } from "../extensions/server-feed";
import { onLanguageChange } from "../i18n";
import { notifyIfAway, notifyState } from "../notify";
import { pollWhileVisible } from "../poll";
import { local } from "../safe-storage";
import { onUpdate, updateSnapshot } from "../update";
import { createAlerts } from "./alerts";
import { createChats, type StreamSource } from "./chats";
import { createComposer } from "./composer";
import { createMe } from "./me";
import { createModels } from "./models";
import { createPrefs } from "./prefs";
import { createSessions } from "./sessions";
import { createSettings } from "./settings";
import { createStatus } from "./status";
import { createViewport, DESK_QUERY } from "./viewport";

/**
 * The kernel's data layer, wired to this page: the real portal API, the confirm dialog, the page's event streams, the
 * extensions' side of the page. One of each for the whole page. The stores themselves know none of that (they take it
 * as `deps`, and are tested with fakes), and an interface reads them through the hooks in `use.ts`.
 */

const ask = confirmDialog;

/** The next frame, or a little later where frames are not drawn (a tab nobody sees): whichever comes first, once. */
const frame = (run: () => void): (() => void) => {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    run();
  };
  const raf = requestAnimationFrame(once);
  const timer = setTimeout(once, 120);
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
};

export const sessions = createSessions({ api, ask, installed: (revision) => followInstalled(revision), poll: pollWhileVisible });

export const chats = createChats({
  api,
  ask,
  open: (url) => new EventSource(url) as unknown as StreamSource,
  poll: pollWhileVisible,
  frame,
  sessions,
  // Lambdas: the extensions' side of the page imports this module, so these are read when called, not when it loads.
  fanOut: {
    serverPush: (chat, extension, data) => serverPush(chat, extension, data),
    extensionMessage: (chat, extension, data) => extensionMessage(chat, extension, data),
    fill: (chat, event) => fillFrom(chat, event),
    onScreen: (chat) => setChatOnScreen(chat),
  },
});

/** Where a click on a notification goes: the app's router, once it is there (see `setOpener`). */
let openChat: (id: string) => void = () => {};
export const setOpener = (open: (id: string) => void): void => {
  openChat = open;
};

export const alerts = createAlerts({
  sessions,
  chats,
  setTitle: (title) => void (document.title = title),
  notify: notifyIfAway,
  open: (id) => openChat(id),
  watchingHidden: () => document.hidden && notifyState() === "on",
  onLanguage: onLanguageChange,
});

export const composer = createComposer({ api, drafts, pending, chat: (id) => chats.controller(id) });
export const models = createModels(api);
export const settings = createSettings(api);
export const me = createMe(api);
export const status = createStatus({ sessions, chats, update: { snapshot: () => updateSnapshot(), subscribe: (listener) => onUpdate(listener) } });
/** The stock interface's preferences, under the keys the portal has always kept. */
export const prefs = createPrefs(local);
export const viewport = createViewport(
  typeof matchMedia === "function"
    ? matchMedia(DESK_QUERY)
    : { matches: true, addEventListener: () => {}, removeEventListener: () => {} },
);
