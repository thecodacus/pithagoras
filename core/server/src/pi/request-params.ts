import type { ModeParams } from "../chat-modes.js";

/**
 * The model parameters of a chat's mode (Settings → Modes), put on the requests the chat's agent makes.
 *
 * pi's agent builds the options of a request without sampling parameters, and its stream function is a field the
 * portal may wrap, so the values are added there, to pi-ai's own options. That leaves each API's adapter to put them
 * where its request has them (`max_tokens`, `max_completion_tokens`, `max_output_tokens`, `maxOutputTokens`) and to
 * keep what its provider refuses out (Anthropic takes no temperature while it thinks), and pi-ai itself merges them
 * over the model's own `samplingParams` of models.json and its thinking-level ones, key by key. What the mode does not
 * set is left as it was.
 *
 * `temperature` and `maxTokens` are options every adapter reads. `top_p`, `top_k` and `min_p` go as `samplingParams`,
 * which only the OpenAI-compatible adapters (completions, responses, Azure) send: the others leave them out. The
 * temperature goes there too, so that a `temperature` in the model's own `samplingParams`, which pi-ai applies last,
 * does not beat the mode.
 */
export function withModeParams<A extends unknown[], R>(
  next: (model: { maxTokens?: number }, context: unknown, options?: Record<string, unknown>, ...rest: A) => R,
  params: () => ModeParams | undefined,
): (model: { maxTokens?: number }, context: unknown, options?: Record<string, unknown>, ...rest: A) => R {
  return (model, context, options, ...rest) => {
    const set = params();
    // A request that names its own maxTokens is one of pi's own: a compaction or a summary, which size theirs to what
    // they write. They are not the chat's answers and keep the model's settings.
    if (!set || options?.maxTokens !== undefined) return next(model, context, options, ...rest);
    return next(model, context, withParams(set, model, options), ...rest);
  };
}

/** `options` with the mode's values in them, `maxTokens` held to what the model can write at most. */
export function withParams(set: ModeParams, model: { maxTokens?: number }, options: Record<string, unknown> = {}): Record<string, unknown> {
  const sampling: Record<string, unknown> = { ...(options.samplingParams as Record<string, unknown> | undefined) };
  if (set.temperature !== undefined) sampling.temperature = set.temperature;
  if (set.topP !== undefined) sampling.top_p = set.topP;
  if (set.topK !== undefined) sampling.top_k = set.topK;
  if (set.minP !== undefined) sampling.min_p = set.minP;
  const out: Record<string, unknown> = { ...options };
  if (set.temperature !== undefined) out.temperature = set.temperature;
  if (Object.keys(sampling).length) out.samplingParams = sampling;
  if (set.maxTokens !== undefined) {
    // A model that is not known to have a limit takes the number as it is.
    out.maxTokens = model.maxTokens && model.maxTokens > 0 ? Math.min(set.maxTokens, model.maxTokens) : set.maxTokens;
  }
  return out;
}
