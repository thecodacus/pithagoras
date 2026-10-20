import { randomInt } from "node:crypto";

/**
 * Ids short enough for an agent to type and a person to read out: a prefix for what it is (`b-` a board, `col-` a
 * column, `c-` a card) and four characters from letters and digits that are not mistaken for one another (no 0, 1, i,
 * l or o). A card's id is unique across all boards, so that it names its card wherever it is moved.
 */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const LENGTH = 4;

export type IdKind = "board" | "column" | "card";
const PREFIX: Record<IdKind, string> = { board: "b-", column: "col-", card: "c-" };

/** A new id of the kind, one `taken` says no to. */
export function newId(kind: IdKind, taken: (id: string) => boolean): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    const id = PREFIX[kind] + code;
    if (!taken(id)) return id;
  }
}

/** Whether a text is an id of the kind: what the store asks before it reads a board's file by its id. */
export const isId = (kind: IdKind, text: string) => new RegExp(`^${PREFIX[kind]}[${ALPHABET}]{${LENGTH}}$`).test(text);
