import { nanoid } from "nanoid";
import { addGrant, addToolRule, approvalFilesOf } from "./db.js";
import { debugLog } from "./logs.js";
import { literalPattern, rulePatterns } from "./pi/guard.js";
import { runsAsPrimary } from "./pi/runs-as-primary.js";
import type { QuestionRow } from "./questions.js";

/**
 * What the primary user's answer to a question permits, written down.
 *
 * `asking` is the conversation that asked, which a one-off approval is bound to.
 * What was approved is the question's `action`, matched against the call the way
 * the guard names it (see callSubject and rulePatterns there): for most tools the
 * command or the path, and for a tool that declares its files (see
 * declaredFiles there) the path of each.
 */
export function recordApproval(question: QuestionRow, asking: { id: string } | undefined, approves: boolean, always: boolean): void {
  const tool = question.action_tool || "bash";
  // Which tool, what the answer was and how long the person waited for it; never the action or the words, which can hold anything.
  const asked = Date.parse(`${question.asked_at.replace(" ", "T")}Z`);
  debugLog("approval", "answered", {
    question: question.id,
    tool: question.action ? tool : undefined,
    outcome: !question.action ? "answered" : always ? "always" : approves ? "once" : "denied",
    waited_ms: Number.isFinite(asked) ? Math.max(0, Date.now() - asked) : undefined,
    session: asking?.id ?? question.session_id,
  });
  // Nothing opens these for anybody but the primary user, so there is nothing to write down: a rule would be listed as
  // working and never apply (ask_primary does not offer them, a question from before that was added may still be open).
  if (runsAsPrimary(tool)) return;
  // An approval is a permission, not a sentence. Bound to the exact action
  // that was shown, the conversation that asked, one use, fifteen minutes
  // — so "yes" cannot be stretched into a standing role change.
  if (approves && question.action && asking) addGrant(nanoid(10), asking.id, tool, question.action);
  // Standing permission, narrowed to the person who asked. Recorded as an
  // ordinary rule so it shows up in Settings → People beside the ones
  // written by hand, and is revoked the same way. What was shown is what is
  // permitted, to the letter: a `*` in a command is a star, not a wildcard.
  if (always && question.action) {
    for (const pattern of rulePatterns(question.action, approvalFilesOf(tool) !== undefined)) {
      addToolRule({
        id: nanoid(10),
        // Whatever their role becomes: a rule naming a person applies to them (see ruleApplies).
        role: "all",
        tool,
        pattern: literalPattern(pattern),
        person_key: question.person_key,
        note: `Approved for ${question.person_name}`,
      });
    }
  }
}
