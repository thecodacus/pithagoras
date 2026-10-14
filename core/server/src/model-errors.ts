/**
 * Which model failures the transcript should hear about.
 *
 * A failed model call closes its turn as an assistant message with stopReason
 * "error" and no text, and pi emits nothing else for it — without a notice the
 * transcript shows a prompt answered by silence. But pi recovers from many of
 * these on its own: a busy or overloaded provider is retried, and a prompt too
 * long for the context window is compacted and sent again. Those must not show
 * up as errors, so a failure is only reported once pi has given up on it.
 *
 * pi says so in two places. agent_end carries `willRetry`, which covers the
 * retry loop, and an overflow is decided afterwards by compaction_end. The
 * notice is therefore held until the next run starts or the session settles,
 * by which point both have had their say.
 */
export class ModelErrors {
  /** A failure pi has not recovered from, waiting to be reported. */
  private pending = new Map<string, string>();
  /** Retries pi has made for the turn in progress. */
  private retries = new Map<string, number>();

  /**
   * Feeds one pi event through. Returns the text of a notice to record, before
   * the event itself, when a failure has turned out to be final.
   */
  take(sessionId: string, msg: any): string | undefined {
    switch (msg?.type) {
      case "auto_retry_start":
        if (typeof msg.attempt === "number") this.retries.set(sessionId, msg.attempt);
        return undefined;

      // Retried to success, given up on, or cancelled during the backoff. A
      // final failure has already been noted at its agent_end, and a cancelled
      // retry is the user's own Stop, not a failure.
      case "auto_retry_end":
        this.retries.delete(sessionId);
        return undefined;

      case "agent_end": {
        const last = lastAssistant(msg.messages);
        if (last?.stopReason !== "error" || msg.willRetry === true) return undefined;
        const why = last.errorMessage || "the model failed to answer.";
        const n = this.retries.get(sessionId) ?? 0;
        this.pending.set(
          sessionId,
          n > 0 ? `Still failing after ${n} ${n === 1 ? "retry" : "retries"}: ${why}` : `Model error: ${why}`
        );
        return undefined;
      }

      // An overflow is not retried but compacted and sent again. Whether that
      // is happening is only known here.
      case "compaction_end": {
        const failed = this.pending.get(sessionId);
        if (msg.reason !== "overflow" || !failed) return undefined;
        if (msg.willRetry === true) this.pending.delete(sessionId);
        else if (msg.errorMessage) this.pending.set(sessionId, `${failed} — ${msg.errorMessage}`);
        return undefined;
      }

      // A new run means the last one's failure stood: a retry or an overflow
      // recovery would have said otherwise by now. The retry count carries on,
      // since the new run may be the retry itself.
      case "agent_start":
        return this.flush(sessionId);

      // The end of the work, retries and all.
      case "agent_settled": {
        const text = this.flush(sessionId);
        this.retries.delete(sessionId);
        return text;
      }
    }
    return undefined;
  }

  /** Drops whatever a previous client left half-told. */
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.retries.delete(sessionId);
  }

  private flush(sessionId: string): string | undefined {
    const text = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    return text;
  }
}

function lastAssistant(messages: unknown): any {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * pi's texts for a chat that has no model to answer with, said as the portal has it. They end by sending
 * the reader to pi's `/login` and to files inside node_modules, neither of which the portal has: what
 * happens when the provider of the default model was removed (pi then cannot name the model), when
 * none is set up, or when a provider has no key.
 */
export function plainFailure(text: string): string {
  if (/^No API key found for the selected model\b|^No models available\b|^No model selected\b/.test(text)) {
    return "There is no model to answer with: the provider of the model was removed, or none is set up. Pick a model in Settings → Models.";
  }
  const keyless = /^No API key found for ([^\s.]+)\./.exec(text);
  if (keyless) return `${keyless[1]} has no API key. Add one in Settings → Models, or pick another model.`;
  return text;
}
