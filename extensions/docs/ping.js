/**
 * Asking the agent in a comment: the person writes `@agent` in a comment, and
 * the agent of a chat is woken with the thread to answer it, through the
 * phase-5 tools (tools.js) and with no more rights than they give it.
 *
 * Waking a chat is the portal's own: `portal.chats.tell` starts the chat's pi
 * if it was let go and rings a bell on its event bus, which the pi extension
 * made here (`hearPings`, registered in every chat's pi by the server half)
 * answers by putting the message into the conversation. The bell carries
 * nothing: any page may ring it (`channel.send` reaches every extension's bus),
 * so what is said to the agent is kept by the server half, which queues it when
 * the wake is due (a few seconds after the person last changed the comment, in
 * the background), and the bell only has it handed over.
 */
import { clip } from "./tools.js";

/** The bus channel a page, or the server half, reaches the package's pi extension on (see the portal's extension-ui). */
export const UI_RECEIVE = "pithagoras:v1:ui:receive";
/** The kind of message the agent is woken with, as the conversation draws it. */
export const PING_TYPE = "document-ping";
/** How much of a comment the message to the agent holds: the rest is in the thread, which doc_read gives whole. */
const COMMENT_CHARS = 1000;

/** What the agent is told when it is asked: where the comment is and what it says, and how to answer it. */
export function wakeMessage({ title, name, id, thread, comment }) {
  return [
    `The person asked you in a comment on the shared document "${title}" (id ${id}, documents/${name}), thread ${thread}:`,
    ...clip(comment, COMMENT_CHARS).split("\n").map((line) => `> ${line}`),
    "Read the thread with doc_read and answer it there: with doc_reply, or with doc_edit given this thread if the answer is a change to the passage it is on. Resolving the thread with doc_resolve, saying what you did, is an answer too: the person is told that you answered either way.",
  ].join("\n");
}

/**
 * Registers in a chat's pi what answers the bell. `extension` is the package's
 * name, `take()` hands over what the server half has queued for this chat (each
 * entry `{ text, details }`, to which the answer is written: `state` is "sent",
 * or "failed" with `error`).
 */
export function hearPings(pi, { extension, take }) {
  const off = pi.events.on(UI_RECEIVE, (message) => {
    if (message?.extension !== extension || message.data?.type !== "ping") return;
    for (const entry of take()) {
      try {
        // Run after the turn that is going on, if one is; started if the agent is idle. Shown to the person as a notice.
        pi.sendMessage({ customType: PING_TYPE, content: entry.text, display: true, details: entry.details }, { deliverAs: "followUp", triggerTurn: true });
        entry.state = "sent";
      } catch (e) {
        entry.state = "failed";
        entry.error = e?.message ?? String(e);
      }
    }
  });
  // A reloaded pi has the bus still: the handler of the one that went is not left on it.
  pi.on?.("session_shutdown", () => off?.());
}
