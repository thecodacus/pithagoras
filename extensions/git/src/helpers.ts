import { session } from "./portal";

/** A link from GitHub, when it goes to a web page: never one that runs script. */
export function webLink(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
}

const DRAFT = "pithagoras.git-draft.";
const drafts = new Map<string, string>();

/**
 * What is typed in the panel and not yet used (a commit message, a pull
 * request's body), by what it is for: held in memory, and in the tab's session
 * storage so a reload keeps it. The portal kept these under the same names.
 */
export const gitDrafts = {
  get: (key: string): string => drafts.get(key) ?? session.get(DRAFT + key) ?? "",
  set(key: string, text: string): void {
    if (text) {
      drafts.set(key, text);
      session.set(DRAFT + key, text);
    } else {
      drafts.delete(key);
      session.remove(DRAFT + key);
    }
  },
};
