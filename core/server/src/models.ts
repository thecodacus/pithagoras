import type { ModelEndpoint, ModelProvider, ModelRef } from "@pithagoras/extension-api/server";
import { modelRuntime } from "./api/providers.js";
import { chatModel, getSession } from "./db.js";
import { readModelsJson, storedKey } from "./providers.js";

/**
 * The models the chats use, and how to reach them: for what asks a model
 * itself, outside a chat's pi. What `portal.models` gives a server half.
 */

/** The model a chat's pi is on now, where it runs here: the session manager's to say. */
export type LiveModel = (chatId: string) => Promise<ModelRef | undefined>;

/**
 * The model a chat is on now: its pi's, else the one stored for it, which is
 * the default where it names none. Without a chat, the one new chats start on.
 */
export async function modelOf(chatId: string | undefined, live: LiveModel): Promise<ModelRef | undefined> {
  if (chatId !== undefined) {
    const now = await live(chatId).catch(() => undefined);
    if (now) return now;
  }
  const row = chatId === undefined ? {} : getSession(chatId);
  if (!row) return undefined;
  const { provider, model } = chatModel(row);
  return model ? { provider, id: model } : undefined;
}

/**
 * Where a model pi knows is asked, the headers its provider adds, and its key apart from them, as pi keeps it: which
 * header a key goes in is the API's to say.
 */
export async function modelEndpoint(provider: string, id: string): Promise<ModelEndpoint> {
  const rt = await modelRuntime();
  const model = rt.getModel(provider, id);
  if (!model) throw new Error(`${provider}/${id} is not a model pi knows`);
  const auth = (await rt.getAuth(model).catch(() => undefined))?.auth ?? {};
  return {
    api: model.api,
    baseUrl: String(auth.baseUrl ?? model.baseUrl ?? "").replace(/\/+$/, ""),
    headers: { ...(model.headers ?? {}), ...(auth.headers ?? {}) },
    ...(auth.apiKey ? { key: auth.apiKey } : {}),
    keyFromCommand: storedKey(provider)?.startsWith("!") === true,
  };
}

/**
 * The providers set up by their address, with their models: those of pi's
 * models.json that list models. One without a list is an override of a
 * service pi has built in (see listProviders), not a provider of its own.
 */
export function modelProviders(): ModelProvider[] {
  const providers = readModelsJson().providers ?? {};
  return Object.entries<Record<string, any>>(providers)
    .filter(([, p]) => Array.isArray(p?.models))
    .map(([provider, p]) => ({
      provider,
      ...(typeof p.api === "string" ? { api: p.api } : {}),
      ...(typeof p.baseUrl === "string" ? { baseUrl: p.baseUrl } : {}),
      models: p.models.filter((m: any) => typeof m?.id === "string").map((m: any) => String(m.id)),
    }));
}
