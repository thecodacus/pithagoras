import { createContext, useContext, type ReactNode } from "react";
import type { Chats } from "./chats";
import type { Composer } from "./composer";
import type { Me } from "./me";
import type { Media } from "./media";
import type { Models } from "./models";
import type { Prefs } from "./prefs";
import type { Sessions } from "./sessions";
import type { Settings } from "./settings";
import type { Status } from "./status";
import type { ViewportStore } from "./viewport";
import * as wired from "./wire";

/**
 * The kernel's stores, as one object that a part of the page reads through (`useKernel`) rather than importing the
 * page's own instances: the page has one of each (`wire.ts`), and a test, or a host that is not this page, gives its
 * own with a `KernelProvider`. The chat's stores need no provider in the app.
 */
export interface Kernel {
  sessions: Sessions;
  /** What a chat view needs of the chats store: its state, its stream, and what is done to it. */
  chats: Pick<Chats, "acquire" | "open" | "peek" | "stateOf" | "controller" | "dismissDialog">;
  composer: Composer;
  models: Models;
  settings: Settings;
  me: Me;
  status: Status;
  prefs: Prefs;
  viewport: ViewportStore;
  media: Media;
}

// Read when asked for, not when this module loads: the extensions' side of the page imports `use.ts`, and `wire.ts` the extensions' side.
export const pageKernel: Kernel = {
  get sessions() { return wired.sessions; },
  get chats() { return wired.chats; },
  get composer() { return wired.composer; },
  get models() { return wired.models; },
  get settings() { return wired.settings; },
  get me() { return wired.me; },
  get status() { return wired.status; },
  get prefs() { return wired.prefs; },
  get viewport() { return wired.viewport; },
  get media() { return wired.media; },
};

const KernelContext = createContext<Kernel>(pageKernel);

/** Gives what is drawn inside it these stores in place of the page's own. */
export function KernelProvider({ kernel, children }: { kernel: Kernel; children: ReactNode }) {
  return <KernelContext.Provider value={kernel}>{children}</KernelContext.Provider>;
}

export const useKernel = (): Kernel => useContext(KernelContext);
