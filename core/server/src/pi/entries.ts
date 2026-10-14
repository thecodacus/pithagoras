/** Reading pi's session entries, the same way wherever they are read. */

/** A message's text, its text parts joined. */
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (c?.type === "text" ? (c.text ?? "") : "")).join("")
      : "";

export const isUser = (e: { type?: string; message?: { role?: string } }) => e.type === "message" && e.message?.role === "user";
