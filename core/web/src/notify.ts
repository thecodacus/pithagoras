import { useState } from "react";
import { local } from "./safe-storage";

const KEY = "notifyWhenAway";

/**
 * `unsupported`: no Notification API, or a page that is not a secure context —
 * browsers refuse them over plain HTTP, which is how a portal on a home server
 * is often reached. `denied`: the browser was told no, and only its own site
 * settings can undo that.
 */
export type NotifyState = "unsupported" | "denied" | "off" | "on";

export function notifyState(): NotifyState {
  if (typeof Notification === "undefined" || !window.isSecureContext) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && local.get(KEY) === "on" ? "on" : "off";
}

/** Asks the browser for permission, which needs a click — this is called from one. */
async function enableNotifications(): Promise<NotifyState> {
  if (notifyState() === "unsupported") return "unsupported";
  try {
    if (Notification.permission !== "granted") await Notification.requestPermission();
  } catch {
    // Older browsers take a callback instead; the state below says what happened.
  }
  if (Notification.permission === "granted") local.set(KEY, "on");
  return notifyState();
}

function disableNotifications(): void {
  local.set(KEY, "off");
}

export function useNotifyState() {
  const [state, setState] = useState<NotifyState>(notifyState);
  return [
    state,
    async (on: boolean) => {
      if (on) setState(await enableNotifications());
      else {
        disableNotifications();
        setState(notifyState());
      }
    },
  ] as const;
}

/** Whether the person is somewhere else: another tab, another window, another app. */
const away = () => document.hidden || !document.hasFocus();

/**
 * A notification, but only if they asked for them and are not looking.
 *
 * Someone reading the chat that just finished does not need to be told.
 */
export function notifyIfAway(title: string, body: string, tag: string, onOpen: () => void): void {
  if (notifyState() !== "on" || !away()) return;
  try {
    // One per chat: a second replaces the first instead of stacking.
    const n = new Notification(title, { body, tag, icon: "/icon-192.png" });
    n.onclick = () => {
      window.focus();
      onOpen();
      n.close();
    };
  } catch {
    // Some mobile browsers only allow them from a service worker.
  }
}
