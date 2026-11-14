import { useSyncExternalStore } from "react";
import { local } from "../safe-storage";
import { choosePalette, chosenPalette, coloursOf, paletteSetBy, themeIdNow, type Colours, type Palette, type SetBy } from "../theme";
import { tokensOf, type Tokens } from "../tokens";
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
 * switch to (`portal.theme.set`). Beside its colours it may set the look
 * beyond them (`tokens`: type, rounding, space, width), checked as the colours
 * are (tokens.ts).
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

const same = (a: Colours | Tokens = {}, b: Colours | Tokens = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

const NAME_MOST = 60;

/**
 * A theme of `extension`'s. Returns what takes it out again. Throws for one
 * without an id and a name (or with a name of more than 60 characters), with a colour the portal has no name for or that
 * is not a colour, with a token it has none of or a value its variable does not
 * take, with neither colours nor tokens, or under an id the extension has used
 * already.
 */
export function registerTheme(extension: string, given: ThemeGiven): () => void {
  if (typeof given?.id !== "string" || !given.id || typeof given.name !== "string" || !given.name.trim()) throw new Error("A theme needs an id and a name");
  // The name is what the person reads when another extension asks to switch to it: a name, not a message.
  if (given.name.length > NAME_MOST) throw new Error(`The theme "${given.id}" has a name longer than ${NAME_MOST} characters`);
  const light = coloursOf(given.light), dark = coloursOf(given.dark);
  if (!light || !dark) throw new Error(`The theme "${given.id}" has a colour the portal has no name for, or one that is not "#rrggbb" or three numbers`);
  const tokens = tokensOf(given.tokens);
  if (!tokens) throw new Error(`The theme "${given.id}" has a token the portal has none of, or a value that its variable does not take`);
  if (!Object.keys(light).length && !Object.keys(dark).length && !Object.keys(tokens).length) throw new Error(`The theme "${given.id}" sets no colours or tokens`);
  const theme: Theme = { id: `${extension}/${given.id}`, name: given.name, light, dark, ...(Object.keys(tokens).length ? { tokens } : {}), extension };
  if (held.some((t) => t.id === theme.id)) throw new Error(`${extension} already has a theme called "${given.id}"`);
  held = inOrder([...held, theme]);
  // The one in effect, as it is now: the copy kept in the browser may be an older version's.
  const chosen = chosenPalette();
  if (chosen?.id === theme.id && (chosen.name !== theme.name || !same(chosen.light, light) || !same(chosen.dark, dark) || !same(chosen.tokens, tokens))) choosePalette(paletteOf(theme), paletteSetBy() ?? "person");
  settleDefault();
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

/** Choose a theme by its id ("<package>/<id>"), or the portal's own with null; the person's choice unless `by` says whose. Throws for one there is none of. */
export function choose(requested: string | null, by: SetBy = "person"): void {
  if (requested === null) return choosePalette(null, by);
  const id = themeIdNow(requested);
  const theme = held.find((t) => t.id === id);
  if (!theme) throw new Error(`There is no theme called "${requested}"`);
  choosePalette(paletteOf(theme), by);
}

const paletteOf = ({ id, name, light, dark, tokens }: Theme): Palette => ({ id, name, light, dark, ...(tokens ? { tokens } : {}) });

/**
 * The theme the interface in use declares as its own look (an interface's manifest, once there are others than the
 * portal's), as "<package>/<id>", or null for none. It is in effect only where nobody has chosen: the person's own choice,
 * even the portal's own colours, stays over it. What it set is the interface's, and goes when the interface does not
 * declare it any more; the person's change in Settings makes it theirs.
 */
let declared: string | null = null;
export function setUiDefaultTheme(id: string | null): void {
  declared = id === null ? null : themeIdNow(id);
  settleDefault();
}

/**
 * The interface's default that was declared when an extension last switched to a theme of its own unasked ("" for none).
 * That switch stands over the default it was made over, across starts; an interface that declares another default (the
 * person chose another interface) puts its own in effect again.
 */
const OVER_KEY = "pithagoras.palette.over";

/** Puts the interface's default in effect, or takes away what an earlier interface's default left, where the person has not chosen. */
function settleDefault(failed: readonly string[] = [], final = false): void {
  const by = paletteSetBy();
  if (by === "person") return;
  if (by === "extension" && (declared ?? "") === (local.get(OVER_KEY) ?? "")) return;
  const chosen = chosenPalette();
  const wanted = declared === null ? undefined : held.find((t) => t.id === declared);
  if (wanted) {
    if (chosen?.id !== wanted.id || chosen.name !== wanted.name || !same(chosen.light, wanted.light) || !same(chosen.dark, wanted.dark) || !same(chosen.tokens, wanted.tokens)) choosePalette(paletteOf(wanted), "ui");
    return;
  }
  // The default's own package may still be on its way, and a kept theme is painted as it was when its package failed.
  if (chosen && (declared === null || final) && !failed.some((name) => chosen.id.startsWith(`${name}/`))) choosePalette(null, "ui");
}

/**
 * What `portal.theme.set` does for `extension`: a theme of its own is switched to at once; another's, or going back to the
 * portal's own colours from another's, is asked of the person first (`ask`, told whose theme it is), because a package that
 * restyles the whole portal unasked is one that can make an approval hard to read. Resolves whether the theme was switched.
 * Rejects for one there is none of.
 *
 * What the person said yes to is their choice. A switch nobody was asked about is the extension's: it does not take the
 * place of the person's choice, so the interface's default can still come back (settleDefault).
 */
export async function setThemeAs(extension: string, requested: string | null, ask: (question: { extension: string; theme: string | null; owner: string | null }) => Promise<boolean>): Promise<boolean> {
  const id = requested === null ? null : themeIdNow(requested);
  const theme = id === null ? undefined : held.find((t) => t.id === id);
  if (id !== null && !theme) throw new Error(`There is no theme called "${requested}"`);
  const now = chosenPalette()?.id;
  const own = id === null ? now === undefined || now.startsWith(`${extension}/`) : id.startsWith(`${extension}/`);
  if (!own && !(await ask({ extension, theme: theme?.name ?? null, owner: theme?.extension ?? null }))) return false;
  // Asked a moment ago, it may have gone since.
  if (id !== null && !held.includes(theme!)) throw new Error(`There is no theme called "${requested}"`);
  const by: SetBy = !own || paletteSetBy() === "person" ? "person" : "extension";
  if (by === "extension") local.set(OVER_KEY, declared ?? "");
  choose(id, by);
  return true;
}

/**
 * The installed extensions have been gone through: the one chosen is still
 * there, or its extension was removed or switched off and the portal's own
 * colours are back. `failed` are the extensions that are installed and could
 * not be loaded this time: a theme of one of those is kept as it was painted.
 */
export function themesSettled(failed: readonly string[] = []): void {
  const chosen = chosenPalette();
  if (chosen && !held.some((t) => t.id === chosen.id) && !failed.some((name) => chosen.id.startsWith(`${name}/`))) choosePalette(null, paletteSetBy() ?? "person");
  settleDefault(failed, true);
}
