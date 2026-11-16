import type { api as realApi } from "../api";
import { createStore, shared } from "./store";

/**
 * The few settings an interface may read: how new chats start, and where they run. Read-only, by a short list of keys:
 * the provider keys, tokens and passwords Settings holds are in no view model (rule 4 of the data contract), and a
 * setting that is changed is changed in Settings, which an interface links to.
 */
export interface PublicSettings {
  /** The provider new chats use, "" where none is chosen. */
  provider: string;
  /** The model new chats use. */
  model: string;
  /** The effort new chats think at. */
  thinkingLevel: string;
  /** Where the chats run: "host" or "container". */
  executor: string;
}

export const PUBLIC_SETTING_KEYS = ["provider", "model", "thinkingLevel", "executor"] as const satisfies readonly (keyof PublicSettings)[];

export interface SettingsState {
  values: PublicSettings;
  status: "loading" | "ready" | "offline";
}

export type SettingsApi = Pick<typeof realApi, "settings">;

export function createSettings(api: SettingsApi) {
  const store = createStore<SettingsState>({ values: { provider: "", model: "", thinkingLevel: "", executor: "host" }, status: "loading" });
  return {
    store,
    /** Asks for them, once however many ask at the same time; what cannot be asked leaves them as they were. */
    load: shared(async (): Promise<void> => {
      try {
        const r = await api.settings();
        store.set({
          values: { provider: r.settings.provider ?? "", model: r.settings.model ?? "", thinkingLevel: r.settings.thinkingLevel ?? "", executor: r.executor },
          status: "ready",
        });
      } catch {
        store.update((s) => ({ ...s, status: "offline" }));
      }
    }),
  };
}
export type Settings = ReturnType<typeof createSettings>;
