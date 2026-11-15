import { t, tp } from "../i18n";

/**
 * The questions the kernel asks before an action that destroys something or raises what the agent may do (rule 8 of
 * the data contract), with the words each is asked in. The stores ask them through `Ask`, which is the portal's own
 * confirm dialog where the page has one (`wire.ts`) and anything at all in a test: a UI that calls the action cannot
 * leave the question out, and cannot make it easy to answer without reading it.
 */

/** What the confirm dialog takes (see components/ConfirmDialog.tsx). */
export interface Question {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** Destructive: the button is red, and focus starts on Cancel. */
  danger?: boolean;
  /** Removes something, so Settings → This browser can switch the question off. */
  deletes?: boolean;
}

export type Ask = (question: Question) => Promise<boolean>;

/** How many sub-chats a delete names before it stops naming them. */
const NAMED = 5;

/**
 * What a person is asked before a chat is deleted. One that arrived through a channel does not block the chat: the
 * next message in it simply starts a new conversation, which is the reason to say so first. Its sub-chats (see
 * sub-chats.ts) go with it, and are named, since they are not on screen while they are shut.
 */
export function deleteChat(title: string, channel = false, subChats: readonly { title: string }[] = []): Question {
  const named = subChats.slice(0, NAMED).map((c) => `"${c.title}"`);
  const names = subChats.length > named.length ? [...named, "…"].join(", ") : named.join(", ");
  return {
    title: t("Delete \"{name}\"?", { name: title }),
    message: channel
      ? t("The agent forgets this conversation, and the next message in that chat starts a new one.")
      : [
          t("It is stopped if it is running, and its transcript is removed."),
          subChats.length ? tp(subChats.length, "Its sub-chat {names} is deleted with it.", "Its {n} sub-chats are deleted with it: {names}.", { names }) : "",
        ].filter(Boolean).join("\n\n"),
    confirmLabel: t("Delete"),
    danger: true,
    deletes: true,
  };
}

/**
 * What a person is asked before several chats are deleted at once: the first few by name, how many sub-chats go with
 * them, and that those at work are stopped. One question for all, never one each.
 */
export function deleteChats(chats: readonly { title: string; busy: boolean }[], subChats: number): Question {
  const named = chats.slice(0, NAMED).map((c) => `"${c.title}"`);
  const names = chats.length > named.length ? [...named, "…"].join(", ") : named.join(", ");
  const busy = chats.filter((c) => c.busy).length;
  return {
    title: tp(chats.length, "Delete {n} chat?", "Delete {n} chats?"),
    message: [
      names,
      t("They are stopped if they are running, and their transcripts are removed."),
      subChats ? tp(subChats, "One sub-chat is deleted with them.", "Their {n} sub-chats are deleted with them.") : "",
      busy ? tp(busy, "{n} of them is running or waiting for you.", "{n} of them are running or waiting for you.") : "",
    ].filter(Boolean).join("\n\n"),
    confirmLabel: t("Delete"),
    danger: true,
    deletes: true,
  };
}

/** What a question about something in a chat names: the chat, where it is not the one on screen. */
const where = (chat: string | undefined) => (chat ? t("In the chat \"{name}\", not the one on screen.", { name: chat }) : "");

/**
 * A sent message removed, with the agent's answer to it: also what "Remove the turn" under a flagged result does. The
 * question quotes the start of the message, and names the chat where it is not the one on screen: a part may ask it for
 * any chat, and the person checks it against what they meant.
 */
export function deleteMessage(about: { text?: string; chat?: string } = {}): Question {
  return {
    title: t("Delete this message?"),
    message: [about.text ? `"${about.text}"` : "", where(about.chat), t("The agent's reply to it goes too, and the agent forgets both.")].filter(Boolean).join("\n\n"),
    confirmLabel: t("Delete"),
    danger: true,
    deletes: true,
  };
}

/** A result the guard flagged as a suspected prompt injection, trusted: the chat is no longer held back for it. Names the tool it came from, and the chat where it is not the one on screen. */
export function trustFlagged(about: { tool?: string; chat?: string } = {}): Question {
  return {
    title: t("Trust this result?"),
    message: [
      about.tool ? t("What {tool} returned.", { tool: about.tool }) : "",
      where(about.chat),
      t("The chat is no longer held back for it: the agent may push, upload, read keys, start subagents and set up what runs later without asking. Trust it only if you read it and it is fine."),
    ].filter(Boolean).join("\n\n"),
    confirmLabel: t("Trust it"),
    danger: true,
  };
}

/** A chat put in a mode that asks first (an extension's `confirm`), in the words the mode brings, translated by the caller. */
export function useMode(label: string, message: string): Question {
  return {
    title: t("Use {mode}?", { mode: label }),
    message,
    confirmLabel: t("Use {mode}", { mode: label }),
    danger: true,
  };
}
