import type { ModeParams } from "../chat-modes.js";

/** The part of a pi-ai model the temperature looks at. */
interface ParamModel {
  samplingParams?: { temperature?: unknown };
  samplingParamsByThinkingLevel?: Record<string, { temperature?: unknown } | undefined>;
}

/**
 * The temperature of a chat's mode (Settings → Modes), put on the requests the chat's agent makes.
 *
 * pi's agent builds the options of a request without a temperature, and its stream function is a field the portal may
 * wrap, so the value is added there, to pi-ai's own options. That leaves each API's adapter to put it where its request
 * has it and to keep it out where its provider refuses it (Anthropic takes no temperature while it thinks). A mode
 * that sets none, and a chat in no mode of the person's, send what they sent before: the request carries nothing and
 * the server's own default applies.
 *
 * The temperature is also put in `samplingParams`, but only where the model's own entry in models.json has a
 * `temperature` to beat (pi-ai applies those last). Elsewhere the adapter's own guard decides: the Responses adapter
 * leaves `temperature` out of a ChatGPT sign-in's requests, which that service rejects, and a copy in `samplingParams`
 * would bypass that.
 */
export function withModeParams<A extends unknown[], R>(
  next: (model: ParamModel, context: unknown, options?: Record<string, unknown>, ...rest: A) => R,
  params: () => ModeParams | undefined,
): (model: ParamModel, context: unknown, options?: Record<string, unknown>, ...rest: A) => R {
  return (model, context, options, ...rest) => {
    const temperature = params()?.temperature;
    // A request that names its own maxTokens is one of pi's own: a compaction or a summary. They are not the chat's
    // answers and keep the model's settings.
    if (temperature === undefined || options?.maxTokens !== undefined) return next(model, context, options, ...rest);
    return next(model, context, withTemperature(temperature, model, options), ...rest);
  };
}

/** Does the model's own entry set a temperature, for all requests or for a thinking level? */
function hasOwnTemperature(model: ParamModel): boolean {
  return model.samplingParams?.temperature !== undefined
    || Object.values(model.samplingParamsByThinkingLevel ?? {}).some((p) => p?.temperature !== undefined);
}

/** `options` with the mode's temperature in them. */
export function withTemperature(temperature: number, model: ParamModel, options: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...options, temperature };
  if (hasOwnTemperature(model)) out.samplingParams = { ...(options.samplingParams as Record<string, unknown> | undefined), temperature };
  return out;
}
