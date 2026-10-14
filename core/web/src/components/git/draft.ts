import { useCallback, useState } from "react";
import { gitDrafts } from "../../drafts";

/**
 * A piece of text the panel keeps while something is opened over it, or the
 * panel is closed, or the page reloaded: the tab and its forms are unmounted
 * each time, and what was typed went with them. `key` names it, with the chat in
 * it. Empty, it is forgotten.
 */
export function useGitDraft(key: string): [string, (text: string) => void] {
  const [held, setHeld] = useState<{ key: string; text: string }>(() => ({ key, text: gitDrafts.get(key) }));
  // A key that came to be another (another chat, another pull request) is read afresh.
  const text = held.key === key ? held.text : gitDrafts.get(key);
  const set = useCallback(
    (next: string) => {
      gitDrafts.set(key, next);
      setHeld({ key, text: next });
    },
    [key],
  );
  return [text, set];
}
