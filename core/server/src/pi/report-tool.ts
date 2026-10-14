import { Type } from "typebox";
import { getDb, getDefaultReportTo, type ReportTo } from "../db.js";
import { channelSupervisor } from "../channels/supervisor.js";
import type { RoutineRow } from "../routines/supervisor.js";
import { fail, say } from "./tool-result.js";

/**
 * Reporting back from a routine.
 *
 * A routine runs with nobody watching: its account of what it did lands in
 * `last_output`, which is only seen by someone who goes looking. This is the
 * way out — the agent decides a run is worth telling you about and says so
 * through a channel you already use.
 *
 * The agent chooses *whether* and *what*; it does not choose *where*. The
 * destination is configuration, so a routine cannot start messaging somewhere
 * it was never pointed at.
 */

/**
 * A routine's own destination, or the portal default.
 *
 * NULL inherits. An empty string is an explicit "this one never reports", which
 * is why it is distinguished from NULL rather than treated as unset.
 */
export function reportToFor(slug: string | null | undefined): ReportTo | null {
  if (!slug) return getDefaultReportTo();
  const row = getDb().prepare("SELECT * FROM routines WHERE slug = ?").get(slug) as
    | RoutineRow
    | undefined;
  if (!row) return getDefaultReportTo();
  if (row.report_channel === "") return null;
  if (row.report_channel && row.report_target) {
    return { channel: row.report_channel, target: row.report_target };
  }
  return getDefaultReportTo();
}

/**
 * What the routine prompt says about reporting, or nothing when it cannot.
 *
 * The first version of this sat next to "finish with a short account of what you
 * did", and the model kept satisfying that by writing the account as text and
 * never calling the tool — it had no way to know that text is stored and read by
 * nobody. Saying so explicitly is the difference between the tool being used and
 * being ignored.
 */
export function reportFraming(to: ReportTo | null): string {
  if (!to) return "";
  return [
    "That account is filed and read by nobody. Calling the report tool is the only",
    `way anything reaches a person — it sends to the "${to.channel}" channel.`,
    "So: if this run turned up something worth knowing — what you found, what you",
    "changed, anything that needs a decision — end by calling report. Writing it out",
    "instead is the same as saying nothing.",
    "Skip the call when the run really was uneventful: a report that says nothing",
    "happened trains people to ignore the next one.",
  ].join("\n");
}

/** An ExtensionFactory — see pi's InlineExtension. */
export function reportTool(routineSlug: string | null) {
  return (pi: any): void => {
    pi.registerTool({
      name: "report",
      label: "Report back",
      description:
        "Message the person who set up this routine, through its report channel: what you found or changed, or a decision you need. " +
        "One-way: no reply comes, so ask nothing.",
      promptSnippet: "tell the person something worth knowing about this run",
      parameters: Type.Object({
        message: Type.String({ description: "For someone who was not here" }),
      }),
      async execute(_id: string, p: any) {
        const to = reportToFor(routineSlug);
        if (!to) return fail("Nowhere to report to — no destination is configured.");
        const message = String(p.message ?? "").trim();
        if (!message) return fail("Nothing to send.");
        try {
          await channelSupervisor.send(to.channel, to.target, message);
          if (routineSlug) {
            getDb()
              .prepare("UPDATE routines SET last_report_at = ? WHERE slug = ?")
              .run(new Date().toISOString(), routineSlug);
          }
          return say(`Sent to ${to.channel}.`);
        } catch (e) {
          return fail(`Could not send: ${(e as Error).message}`);
        }
      },
    });
  };
}
