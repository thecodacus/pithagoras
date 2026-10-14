import { Type } from "typebox";
import { getAgent } from "../agents.js";
import { addNote } from "../activity.js";
import { getDefaultReportTo } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { NOTE_TOOL } from "./heartbeat-names.js";
import { fail, say } from "./tool-result.js";

/**
 * The one thing a heartbeat can do besides read: leave a note.
 *
 * A heartbeat turn runs as HEARTBEAT_ROLE, which the guard holds to reading (see
 * READ_ONLY there) plus whatever standing rules allow that role. This tool is
 * how what it found reaches anybody: a note in the agent's Activity, and with
 * `urgent`, a message through the channel reports go to as well.
 */

/** An ExtensionFactory — see pi's InlineExtension. */
export function heartbeatTool(agentId: string, sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: NOTE_TOOL,
      label: "Leave a note",
      description: "Leave a note in your Activity for the person you work for: one thing worth their attention, one note per thing.",
      promptSnippet: "tell the person you work for about something you noticed",
      parameters: Type.Object({
        title: Type.String({ description: "One line: what you noticed" }),
        detail: Type.String({ description: "What, why it matters, where to look; for someone who was not here" }),
        urgent: Type.Optional(Type.Boolean({ description: "Also message them now; only for what cannot wait" })),
      }),
      async execute(_id: string, p: any) {
        const title = String(p.title ?? "").trim();
        const detail = String(p.detail ?? "").trim();
        if (!title) return fail("A note needs a title.");
        addNote(agentId, sessionId, title, detail);
        if (!p.urgent) return say("Noted.");
        const to = getDefaultReportTo();
        if (!to) return say("Noted. There is no channel to message them through, so it waits in Activity.");
        try {
          const name = getAgent(agentId)?.name ?? "Your agent";
          await channelSupervisor.send(to.channel, to.target, `${name}: ${title}${detail ? `\n\n${detail}` : ""}`);
          return say(`Noted, and sent through ${to.channel}.`);
        } catch (e) {
          return say(`Noted, but the message could not be sent: ${(e as Error).message}`);
        }
      },
    });
  };
}
