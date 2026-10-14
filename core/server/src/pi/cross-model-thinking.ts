/**
 * Earlier answers by another model, as the model about to answer should see them.
 *
 * pi-ai keeps a thinking block only for the model that wrote it. For any other
 * it becomes plain answer text with nothing around it, so after a switch the
 * new model read the old one's reasoning and answer run together as one reply,
 * copied that shape, and wrote its whole answer as reasoning: llama.cpp then
 * put all of it in `reasoning_content` and the chat showed it inside "Thought
 * for" (thecodacus/pithagoras#60).
 *
 * So before every call, an earlier answer by another model loses its thinking:
 * the answer stands on its own, as the model's own template would leave an
 * earlier turn anyway. One that was nothing but thinking — it ended inside it —
 * keeps it, closed in `<think>` tags, so it reads as reasoning that ended and
 * not as an answer to copy. Answers by the model itself are left alone: their
 * thinking goes back as thinking.
 */
export function closeForeignThinking(messages: any[], model: { provider?: string; api?: string; id?: string } | undefined): any[] {
  if (!model) return messages;
  let changed = false;
  const out = messages.map((message) => {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
    // pi-ai's own test of whether a block can go back as thinking.
    if (message.provider === model.provider && message.api === model.api && message.model === model.id) return message;
    const thinking = message.content.filter((b: any) => b?.type === "thinking" && !b.redacted && typeof b.thinking === "string" && b.thinking.trim());
    if (!thinking.length) return message;
    changed = true;
    const rest = message.content.filter((b: any) => b?.type !== "thinking");
    const answered = rest.some((b: any) => (b?.type === "text" && typeof b.text === "string" && b.text.trim()) || b?.type === "toolCall");
    if (answered) return { ...message, content: rest };
    const text = thinking.map((b: any) => b.thinking.trim()).join("\n\n");
    return { ...message, content: [{ type: "text", text: `<think>\n${text}\n</think>` }, ...rest] };
  });
  return changed ? out : messages;
}

/** The extension: the history of every call, after a switch, as above. */
export function crossModelThinkingExtension(pi: any): void {
  pi.on("context", (event: { messages: any[] }, ctx: { model?: { provider?: string; api?: string; id?: string } }) => {
    const messages = closeForeignThinking(event.messages, ctx?.model);
    return messages === event.messages ? undefined : { messages };
  });
}
