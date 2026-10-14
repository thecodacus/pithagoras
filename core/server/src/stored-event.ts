/**
 * An event as the transcript keeps it.
 *
 * pi says the same thing several times over: a tool's result in the end of its
 * call, again as a message when it starts and ends, again in the turn's end and
 * in the run's end — and the person's own message, pictures and all, in the
 * message events as well. Nothing draws those copies: the page reads a call's
 * result from its end, and the person's words from what the portal logged when
 * it sent them. Kept, each of thirty screenshots was stored three to five times,
 * and a page loading the chat read and sent every copy.
 */
const isImage = (block: any) => block?.type === "image";

export function forTranscript(event: any): any {
  switch (event?.type) {
    case "agent_end":
      return { type: event.type, willRetry: event.willRetry };
    case "turn_end":
      return { type: event.type };
    case "message_start":
    case "message_end": {
      const message = event.message;
      if (message?.role === "toolResult") return { ...event, message: { role: message.role } };
      if (message?.role === "user" && Array.isArray(message.content) && message.content.some(isImage)) {
        const content = message.content.map((block: any) => (isImage(block) ? { type: "image", mimeType: block.mimeType } : block));
        return { ...event, message: { ...message, content } };
      }
      return event;
    }
    default:
      return event;
  }
}
