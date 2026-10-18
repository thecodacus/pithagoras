import { useSyncExternalStore } from "react";
import { choosePalette, chosenPalette, coloursOf, themeIdNow, type Colours, type Palette } from "../theme";
import { byRank, onRanked } from "./rank";

/**
 * The themes the installed extensions brought: each a set of colours in place
 * of the portal's own, for light, for dark, or for both.
 *
 * A package names its themes in its package.json, with no code at all:
 *
 *   "pithagoras": { "themes": [{ "id": "dusk", "name": "Dusk", "dark": { "canvas": "#1b1626", "accent": "#ff79c6" } }] }
 *
 * or its browser half registers one (`portal.theme.register`). Either way it
 * is one of those a person chooses from in Settings, and one an extension can
 * switch to (`portal.theme.set`).
 *
 * The one chosen is kept in the browser with its colours (theme.tsx), so it is
 * painted before anything here is loaded. What is here keeps that copy true:
 * a theme registered again with other colours repaints, and one whose
 * extension is gone gives way to the portal's own.
 */
import type { ThemeGiven } from "@pithagoras/extension-api";
export type { ThemeGiven } from "@pithagoras/extension-api";

export interface Theme extends Palette {
  extension: string;
}

let held: readonly Theme[] = [];
const inOrder = (list: Theme[]): Theme[] => list.map((theme, at) => ({ theme, at })).sort((a, b) => byRank(a.theme.extension, b.theme.extension) || a.at - b.at).map(({ theme }) => theme);
onRanked(() => {
  const again = inOrder([...held]);
  if (again.some((theme, at) => theme !== held[at])) {
    held = again;
    changed();
  }
});
const watchers = new Set<() => void>();
const changed = () => { for (const watcher of [...watchers]) watcher(); };

const same = (a: Colours = {}, b: Colours = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * A theme of `extension`'s. Returns what takes it out again. Throws for one
 * without an id and a name, with a colour the portal has no name for or that
 * is not a colour, with no colours at all, or under an id the extension has
 * used already.
 */
export function registerTheme(extension: string, given: ThemeGiven): () => void {
  if (typeof given?.id !== "string" || !given.id || typeof given.name !== "string" || !given.name) throw new Error("A theme needs an id and a name");
  const light = coloursOf(given.light), dark = coloursOf(given.dark);
  if (!light || !dark) throw new Error(`The theme "${given.id}" has a colour the portal has no name for, or one that is not "#rrggbb" or three numbers`);
  if (!Object.keys(light).length && !Object.keys(dark).length) throw new Error(`The theme "${given.id}" sets no colours`);
  const theme: Theme = { id: `${extension}/${given.id}`, name: given.name, light, dark, extension };
  if (held.some((t) => t.id === theme.id)) throw new Error(`${extension} already has a theme called "${given.id}"`);
  held = inOrder([...held, theme]);
  // The one in effect, as it is now: the copy kept in the browser may be an older version's.
  const chosen = chosenPalette();
  if (chosen?.id === theme.id && (chosen.name !== theme.name || !same(chosen.light, light) || !same(chosen.dark, dark))) choose(theme.id);
  changed();
  return () => {
    if (!held.includes(theme)) return;
    held = held.filter((t) => t !== theme);
    changed();
  };
}

/** The themes there are, by their extension's place among the installed (not by whose module came first), then in the order they came. */
export const themes = (): readonly Theme[] => held;

/** The themes there are, drawn again when one comes or goes. */
export function useThemes(): readonly Theme[] {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
    themes,
  );
}

/** Choose a theme by its id ("<package>/<id>"), or the portal's own with null. Throws for one there is none of. */
export function choose(requested: string | null): void {
  if (requested === null) return choosePalette(null);
  const id = themeIdNow(requested);
  const theme = held.find((t) => t.id === id);
  if (!theme) throw new Error(`There is no theme called "${requested}"`);
  choosePalette({ id: theme.id, name: theme.name, light: theme.light, dark: theme.dark });
}

/**
 * The installed extensions have been gone through: the one chosen is still
 * there, or its extension was removed or switched off and the portal's own
 * colours are back. `failed` are the extensions that are installed and could
 * not be loaded this time: a theme of one of those is kept as it was painted.
 */
export function themesSettled(failed: readonly string[] = []): void {
  const chosen = chosenPalette();
  if (!chosen || held.some((t) => t.id === chosen.id) || failed.some((name) => chosen.id.startsWith(`${name}/`))) return;
  choosePalette(null);
}
