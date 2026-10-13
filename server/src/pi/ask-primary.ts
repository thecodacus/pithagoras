import { Type } from "typebox";
import { getDefaultReportTo, getSession } from "../db.js";
import { unscopeKey } from "../agent.js";
import { askQuestion, dropQuestion, offerOf } from "../questions.js";
import { channelSupervisor } from "../channels/supervisor.js";
import { sessions } from "../session-manager.js";
import { getPerson } from "../people.js";
import { debugLog } from "../logs.js";
import { approvalCannotHelp } from "./guard.js";
import { fail, say } from "./tool-result.js";

/**
 * Reaching the primary user from a conversation that is not theirs.
 *
 * A colleague hits a wall at every action; the agent can only say "that needs
 * Sam". This turns that into a message they actually receive, and their reply
 * comes back to the colleague who asked — see readAnswer for the return leg.
 *
 * The destination is the same one routines report to. The agent picks neither
 * the recipient nor the route, which is the property worth keeping: a session
 * serving someone else must not be able to choose who hears from it.
 */
export function askPrimaryTool(sessionId: string) {
  return (pi: any): void => {
    pi.registerTool({
      name: "ask_primary",
      label: "Ask the primary user",
      description:
        "Put a question to your primary user on behalf of the person you are talking to. Use it " +
        "when they need something you are not allowed to do, or a decision that is not yours. " +
        "The answer comes back into this conversation later — it does not arrive during this " +
        "turn, so tell them you have asked and leave it there.",
      promptSnippet: "ask_primary — pass a request to your primary user and get an answer back",
      parameters: Type.Object({
        question: Type.String({
          description:
            "The question, written for someone who cannot see this conversation: who is asking, " +
            "what they want, and what you would do if they said yes.",
        }),
        action: Type.Optional(
          Type.String({
            description:
              "When you are asking permission to do one specific thing, the exact thing — the " +
              "shell command verbatim, or the path you would write; for edit_image the path of " +
              "each picture, one to a line, in the order of the call; for any other tool the " +
              "refusal says what to write. Approving authorises this " +
              "and nothing else, so it must be exactly what you intend to run, once. Leave it " +
              "out when you are asking for a decision rather than permission.",
          })
        ),
        actionTool: Type.Optional(
          Type.String({ description: "The tool the action belongs to. Defaults to bash." })
        ),
      }),
      async execute(_id: string, p: any) {
        const question = String(p.question ?? "").trim();
        if (!question) return fail("Nothing to ask.");

        const to = getDefaultReportTo();
        if (!to) {
          return fail(
            "There is no way to reach the primary user — no report destination is configured. " +
              "Tell the person you cannot get hold of them.",
          );
        }

        const session = getSession(sessionId);
        if (!session?.channel_slug || !session.channel_key) {
          return fail("This conversation has nowhere to send an answer back to.");
        }
        // An approval opens what a rule could open, not what the guard keeps from
        // everybody who is not the primary user, and not what it refuses once this
        // conversation has read something untrusted: asked anyway, they would be
        // told that something could be done once, and it could not.
        const wanted = typeof p.actionTool === "string" ? p.actionTool : "bash";
        const never = typeof p.action === "string" && p.action.trim() ? approvalCannotHelp(wanted, p.action.trim(), session.workspace, sessionId) : undefined;
        if (never) {
          return fail(
            `That cannot be approved: ${never}. Not even the primary user can allow it for somebody else, ` +
              `so do not ask. Tell the person plainly that it is not something you can do for them.`,
          );
        }
        // Whether it arrives the moment it is written, or waits for them to
        // speak again. Either way it arrives, so neither the question nor the
        // promise changes — only the timing does.
        const immediate = channelSupervisor.canSend(session.channel_slug);

        const who =
          sessions.currentSpeaker(sessionId) ??
          (session.last_person_key ? getPerson(session.last_person_key) : undefined);
        const row = askQuestion({
          sessionId,
          personKey: who?.key ?? "unknown",
          personName: who?.name ?? "Someone",
          channelSlug: session.channel_slug,
          channelKey: unscopeKey(session.channel_slug, session.channel_key),
          question,
          actionTool: wanted,
          action: typeof p.action === "string" && p.action.trim() ? p.action.trim() : null,
        });

        try {
          await channelSupervisor.send(
            to.channel,
            to.target,
            // The key beside the name: a name is whatever somebody called themselves, the key is who the platform says they are.
            `${row.person_name} (${row.person_key}) is asking (via ${session.channel_slug}):\n\n${question}\n\n` +
              offerOf(row) +
              (immediate ? "" : ` That channel cannot be messaged out of the blue, so they will see it the next time they write.`),
            // Only where there is something to approve. A question wanting an
            // opinion needs words, and two buttons would be pretending it does not.
            row.action
              ? [
                  { label: "Approve once", reply: `#${row.id} approve` },
                  { label: "Always allow", reply: `#${row.id} always` },
                  { label: "Deny", reply: `#${row.id} no` },
                ]
              : undefined,
            // The asker's words in the primary user's own conversation would taint it for good,
            // and the answer is read before the agent sees the message.
            false
          );
        } catch (e) {
          // Nobody was told of it, so nothing is waiting for an answer, and the id of a question nobody has seen
          // is not one to leave answerable.
          dropQuestion(row.id);
          debugLog("approval", "not delivered", { question: row.id, tool: row.action ? row.action_tool : undefined, session: sessionId });
          return fail(`Could not reach them: ${(e as Error).message}`);
        }
        // The kind of question and where it stands, not its words or the action: those can hold anything.
        debugLog("approval", "asked", { question: row.id, tool: row.action ? row.action_tool : undefined, session: sessionId, immediate });

        return say(
          `Asked. Tell ${row.person_name} you have passed it on and that you will come back ` +
            `to them — do not guess at the answer in the meantime.`,
        );
      },
    });
  };
}
