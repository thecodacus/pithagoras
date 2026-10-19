/**
 * The names of the guard's rules after a suspected prompt injection (RULES in guard.ts), in a module of their own:
 * the database reads them for a routine's exemptions, and must not wait on everything the guard needs. guard.ts
 * holds what each one refuses; a test holds the two lists to each other.
 */
export const GUARD_RULE_NAMES = ["pipe-to-shell", "write-to-path", "upload", "read-credentials", "publish", "persist", "delegate"] as const;

export type GuardRuleName = (typeof GUARD_RULE_NAMES)[number];
