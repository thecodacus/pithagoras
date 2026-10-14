/**
 * `note`: pin a short note to the chat, where the person keeps it beside the
 * conversation — and can pin one of their own, or take one off.
 *
 * The reference for an extension that draws in the portal
 * (core/server/src/extension-ui.ts there), in three halves:
 *
 * - This file is the one pi loads, one per chat: it holds the notes and keeps
 *   them with the conversation.
 * - `web/` is the one the portal's page loads: a panel, a button in the chat's
 *   header, how a call of `note` is drawn, a window in voice mode and a page.
 * - `server.js` is the one the portal itself loads, once: every chat's notes,
 *   for the page, with no chat's pi started for it.
 *
 * This half and the page talk over pi's event bus, so outside the portal
 * nobody listens and this is simply a tool that keeps notes.
 *
 * What the browser half sends:  { type: "ready" } · { type: "add", text } ·
 *                               { type: "remove", id } · { type: "pin-last" }
 * What it is sent:              { type: "notes", notes } · { type: "nothing-to-pin" }
 */
import { Type } from "typebox";

const NAME = "pithagoras-notes";
const SEND = "pithagoras:v1:ui:send";
const RECEIVE = "pithagoras:v1:ui:receive";
const LONGEST = 2000;

interface Note {
  id: number;
  text: string;
  by: "agent" | "you";
}

export default function (pi: any) {
  let notes: Note[] = [];
  /** The conversation as it is now, for the last reply when asked to pin it. */
  let branch: () => any[] = () => [];

  const tell = (data: unknown) => pi.events.emit(SEND, { extension: NAME, data });
  const changed = () => {
    // Kept with the conversation and never sent to the model.
    pi.appendEntry(NAME, { notes });
    tell({ type: "notes", notes });
  };
  const add = (text: string, by: Note["by"]): Note => {
    const note = { id: Math.max(0, ...notes.map((n) => n.id)) + 1, text: text.trim().slice(0, LONGEST), by };
    notes = [...notes, note];
    changed();
    return note;
  };

  /** The notes as the conversation last kept them, on the branch it is on. */
  const restore = (ctx: any) => {
    branch = () => ctx.sessionManager.getBranch();
    notes = [];
    for (const entry of branch()) {
      if (entry.type === "custom" && entry.customType === NAME && Array.isArray(entry.data?.notes)) notes = entry.data.notes;
    }
    tell({ type: "notes", notes });
  };
  pi.on("session_start", async (_event: unknown, ctx: any) => restore(ctx));
  pi.on("session_tree", async (_event: unknown, ctx: any) => restore(ctx));

  const lastReply = (): string => {
    for (const entry of [...branch()].reverse()) {
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      const text = entry.message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n").trim();
      if (text) return text;
    }
    return "";
  };

  pi.events.on(RECEIVE, (message: any) => {
    if (message?.extension !== NAME) return;
    const data = message.data ?? {};
    if (data.type === "ready") tell({ type: "notes", notes });
    else if (data.type === "add" && typeof data.text === "string" && data.text.trim()) add(data.text, "you");
    else if (data.type === "remove" && notes.some((note) => note.id === data.id)) {
      notes = notes.filter((note) => note.id !== data.id);
      changed();
    } else if (data.type === "pin-last") {
      const text = lastReply();
      if (text) add(text, "you");
      else tell({ type: "nothing-to-pin" });
    }
  });

  pi.registerTool({
    name: "note",
    label: "Note",
    description: "Pin a short note (a sentence or two) to this chat for the person: a decision, a result, something to come back to.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_toolCallId: string, params: { text: string }) {
      if (!params.text.trim()) throw new Error("A note needs some text");
      const note = add(params.text, "agent");
      return { content: [{ type: "text", text: `Pinned note #${note.id}` }], details: { note } };
    },
  });
}
