import { AUDIO_MESSAGE_PREFIX } from "./voice-first.js";

/**
 * Taking a message back out of pi's own record of the conversation.
 *
 * The portal's transcript is its own log, so trimming that is easy — and does
 * nothing for the model, which reads pi's session file. A message deleted from
 * the screen but still in the file is one the agent goes on answering to, which
 * is worse than not offering delete at all. So the file is edited too.
 *
 * pi's file is a tree: every entry names its parent, and the conversation is
 * the path from the last entry back to the root. Removing entries means
 * removing them from that path and stitching the rest together, which is all
 * this does. It works on the text of the file and touches nothing else, so it
 * can be checked against a copy without a live session.
 */

export type SessionEditCode =
  | "busy"
  | "missing"
  | "unsupported"
  | "unmatched"
  | "branched"
  | "compacted";

export class SessionEditError extends Error {
  constructor(
    readonly code: SessionEditCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `turn`: this message and what the agent did about it, and nothing else.
 * `tail`: this message and everything after it — what editing does, since a
 * conversation cannot keep answers to a question that is no longer the same.
 */
export type Scope = "turn" | "tail";

interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string; content?: unknown };
  targetId?: string;
  [key: string]: unknown;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c?.type === "text" ? (c.text ?? "") : "")).join("")
      : "";

const isUser = (e: Entry) => e.type === "message" && e.message?.role === "user";

/** Root to leaf, following parent links from the last entry. */
function pathTo(byId: Map<string, Entry>, leaf: string): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (let id: string | null | undefined = leaf; id && !seen.has(id); ) {
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    out.push(entry);
    id = entry.parentId;
  }
  return out.reverse();
}

/**
 * Which of pi's user entries a message the portal sent corresponds to.
 *
 * Matched by text, in order, and only exactly — or with the one prefix the
 * portal adds to a voice turn. A looser match would take a message pi never
 * received for a later one that merely contains its words, and remove the wrong
 * turn from the file. The portal logs every message it sends and pi stores every
 * one it receives, but they are not the same list: a slash command is not a chat
 * message to the portal and can expand into one for pi, and a message that
 * failed before reaching pi has no entry at all. So each sent message looks
 * forward from the last one matched, and one that finds nothing is skipped
 * rather than stopping the count — only the message being asked about has to be
 * found.
 */
function locate(path: Entry[], sent: string[], ordinal: number): string {
  const users = path.filter(isUser).map((e) => ({ id: e.id!, text: textOf(e.message?.content) }));
  let from = 0;
  let found = -1;
  for (let i = 0; i <= ordinal; i++) {
    const want = sent[i] ?? "";
    const hit = users.findIndex(
      (u, j) => j >= from && (u.text === want || u.text === AUDIO_MESSAGE_PREFIX + want),
    );
    if (hit < 0) {
      if (i === ordinal) {
        throw new SessionEditError(
          "unmatched",
          "This message could not be found in the agent's history, so nothing was changed.",
        );
      }
      continue;
    }
    from = hit + 1;
    found = i === ordinal ? hit : found;
  }
  return users[found].id;
}

/**
 * The session file with one message taken out.
 *
 * Refuses rather than guesses. If the tree has branches this cannot reason
 * about, or the message sits inside a summary the agent has already written,
 * the honest answer is that it cannot be done cleanly — a file left half-edited
 * would corrupt every later turn, and a refusal costs nothing.
 *
 * @param sent every message the portal sent up to and including this one, oldest first
 * @param ordinal which of them this is
 */
export function dropMessage(raw: string, sent: string[], ordinal: number, scope: Scope): string {
  const rows = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ line, entry: JSON.parse(line) as Entry }));
  const header = rows.filter((r) => r.entry.type === "session");
  const body = rows.filter((r) => r.entry.type !== "session");
  const byId = new Map(body.map((r) => [r.entry.id!, r.entry]));

  // pi opens a file with its last entry as the leaf.
  const leaf = body.at(-1)?.entry.id;
  if (!leaf) throw new SessionEditError("unmatched", "The agent has no history to edit.");
  const path = pathTo(byId, leaf);
  const onPath = new Set(path.map((e) => e.id!));

  const target = locate(path, sent, ordinal);
  const at = path.findIndex((e) => e.id === target);

  const removed = new Set<string>();
  if (scope === "tail") {
    for (const e of path.slice(at)) removed.add(e.id!);
  } else {
    // Up to the next thing the person said. What lies between is the agent's
    // answer: its replies, its tool calls, and their results.
    const next = path.findIndex((e, i) => i > at && isUser(e));
    const span = path.slice(at, next < 0 ? path.length : next);

    // A summary already stands in for these messages. Deleting them leaves the
    // summary describing something that never happened.
    if (path.slice(at).some((e) => e.type === "compaction")) {
      throw new SessionEditError(
        "compacted",
        "This message was already folded into a compacted summary and can no longer be removed on its own.",
      );
    }
    // Only messages. A model or thinking-level change that fell in between is
    // still true of the conversation, so it stays.
    for (const e of span) if (e.type === "message" || e.type === "custom_message") removed.add(e.id!);
  }

  // Whatever hangs off a removed entry off the main path goes with it.
  for (const { entry } of body) {
    if (entry.parentId && removed.has(entry.parentId) && !onPath.has(entry.id!)) removed.add(entry.id!);
  }
  // A label on something that no longer exists.
  for (const { entry } of body) {
    if (entry.type === "label" && entry.targetId && removed.has(entry.targetId)) removed.add(entry.id!);
  }

  const parentOf = (id: string | null | undefined): string | null => {
    let cur = id ?? null;
    while (cur && removed.has(cur)) cur = byId.get(cur)?.parentId ?? null;
    return cur;
  };

  const kept = body
    .filter((r) => !removed.has(r.entry.id!))
    .map((r) => {
      const parent = parentOf(r.entry.parentId);
      return parent === (r.entry.parentId ?? null)
        ? r
        : { line: JSON.stringify({ ...r.entry, parentId: parent }), entry: { ...r.entry, parentId: parent } };
    });

  // The result must be the old conversation minus exactly what was removed.
  // If a side branch made the last entry something else, opening the file
  // would silently land on a different conversation — so check before writing.
  const after = new Map(kept.map((r) => [r.entry.id!, r.entry]));
  const newLeaf = kept.at(-1)?.entry.id;
  const actual = newLeaf ? pathTo(after, newLeaf).map((e) => e.id) : [];
  const expected = (scope === "tail" ? path.slice(0, at) : path.filter((e) => !removed.has(e.id!))).map(
    (e) => e.id,
  );
  if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i])) {
    throw new SessionEditError(
      "branched",
      "This conversation has branches, so a message cannot be removed cleanly. Nothing was changed.",
    );
  }

  return [...header, ...kept].map((r) => r.line).join("\n") + "\n";
}
