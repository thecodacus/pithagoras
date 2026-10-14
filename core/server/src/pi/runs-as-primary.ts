/**
 * The tools that run what a person writes as the primary user, or in a pi without
 * the guard, and the reason for each. Nothing opens them for anybody else — not
 * a rule, not an approval — for the guard cannot follow what they go on to do:
 * a routine is run with no role at all, which is the primary user's, and a
 * subagent is a pi of its own. Said once here: unrunnable (guard.ts) holds them,
 * which is what a rule, an approval and the question to the primary user all ask,
 * the API refuses a rule for them, and the database drops the ones an earlier
 * version made. In a module of its own, as the database reads it as it starts.
 */
export const RUNS_AS_PRIMARY: Record<string, string> = {
  subagent: "a subagent works without this guard, so it would do what they ask of it with the agent's own rights",
  routine_create: "a routine runs as the primary user, so one made, changed or run for them would act with the agent's own rights, and its report goes back to them",
  routine_update: "a routine runs as the primary user, so one made, changed or run for them would act with the agent's own rights, and its report goes back to them",
  routine_run: "a routine runs as the primary user, so one made, changed or run for them would act with the agent's own rights, and its report goes back to them",
};

/** Why a rule for this tool would hand somebody who is not the primary user the primary user's rights, or undefined: see RUNS_AS_PRIMARY. */
export const runsAsPrimary = (toolName: string): string | undefined => RUNS_AS_PRIMARY[toolName];
