import type { ConfigPatch, api as realApi } from "../api";
import { createStore } from "./store";

/**
 * The models there are, and which one a chat uses and how hard it thinks. What the chat's pills draw: where the
 * models come from is Settings → Providers, which an interface links to.
 */
export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
  /** The window, in tokens, where the provider says. */
  contextWindow?: number;
  /** It takes an effort level. */
  reasoning: boolean;
  /** It reads pictures. */
  images: boolean;
}

export interface ModelsState {
  models: readonly ModelChoice[];
  status: "loading" | "ready" | "offline";
}

/** What a chat uses now. */
export interface ChatModel {
  /** Null while the chat follows the default and the portal has not started it. */
  model: { provider: string; id: string } | null;
  /** The level the chat thinks at, "" where none. */
  thinking: string;
  /** The levels the model offers. */
  levels: readonly string[];
}

export type ModelsApi = Pick<typeof realApi, "allModels" | "models" | "setConfig">;

const FOLLOWING: ChatModel = { model: null, thinking: "", levels: [] };

export function createModels(api: ModelsApi) {
  const store = createStore<ModelsState>({ models: [], status: "loading" });
  /** What each chat uses, by its id, once asked. */
  const chats = createStore<Readonly<Record<string, ChatModel>>>({});

  async function load(): Promise<void> {
    try {
      const r = await api.allModels();
      store.set({
        models: r.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning, images: Boolean(m.input?.includes("image")) })),
        status: "ready",
      });
    } catch {
      store.update((s) => ({ ...s, status: "offline" }));
    }
  }

  /** What the chat uses, asked of the portal; `current` after. A chat the portal cannot answer for keeps what it had. */
  async function loadChat(id: string): Promise<ChatModel> {
    try {
      const c = await api.models(id);
      const named = c.named?.model ? { provider: c.named.provider ?? c.state.model.provider, id: c.named.model } : null;
      const model = named ?? { provider: c.state.model.provider, id: c.state.model.id };
      const next: ChatModel = { model, thinking: c.state.thinkingLevel, levels: c.thinking.levels };
      chats.update((all) => ({ ...all, [id]: next }));
      return next;
    } catch {
      return current(id);
    }
  }

  const current = (id: string): ChatModel => chats.get()[id] ?? FOLLOWING;

  return {
    store,
    chats,
    load,
    loadChat,
    current,
    /** Changes how the chat is set (its model, its effort, whether it compacts by itself). Rejects where the portal refuses. */
    async change(id: string, choice: ConfigPatch): Promise<void> {
      await api.setConfig(id, choice);
    },
    /** `change`, and reads what the chat uses now. */
    async set(id: string, choice: ConfigPatch): Promise<ChatModel> {
      await api.setConfig(id, choice);
      return loadChat(id);
    },
  };
}
export type Models = ReturnType<typeof createModels>;
