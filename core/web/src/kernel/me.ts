import type { api as realApi } from "../api";
import { createStore } from "./store";

/**
 * Who is using the portal. Every login is its owner's for now (see Who is behind a request in the extension guide):
 * the name is the person People marks primary, and "Owner" while nobody is, as the server says it to an extension.
 */
export interface MeState {
  name: string;
  role: "owner";
  status: "loading" | "ready" | "offline";
}

export type MeApi = Pick<typeof realApi, "people">;

export function createMe(api: MeApi) {
  const store = createStore<MeState>({ name: "Owner", role: "owner", status: "loading" });
  return {
    store,
    /** Asks who it is; what cannot be asked leaves the name as it was. */
    async load(): Promise<void> {
      try {
        const { people } = await api.people();
        const primary = people.find((p) => p.role === "primary");
        store.update((s) => ({ ...s, name: primary?.name.trim() || "Owner", status: "ready" }));
      } catch {
        store.update((s) => ({ ...s, status: "offline" }));
      }
    },
  };
}
