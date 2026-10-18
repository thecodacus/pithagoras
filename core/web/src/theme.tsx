import { useEffect, useState, useSyncExternalStore } from "react";
import { local } from "./safe-storage";

/**
 * Light, dark, or whatever the machine is set to.
 *
 * "system" is the default and a real option rather than a one-off starting
 * guess: someone whose desktop flips at sunset expects this to follow, and a
 * portal that decided once at first load would not.
 */
export type Theme = "light" | "dark" | "system";

const KEY = "pithagoras.theme";
const media = () => window.matchMedia("(prefers-color-scheme: light)");

export const resolve = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (media().matches ? "light" : "dark") : theme;

/**
 * The colours a theme may set: the portal's own names for what a colour is for
 * (see index.css), each the three numbers of a colour, "34 211 238".
 */
export const TOKENS = ["canvas", "surface", "raised", "line", "fg", "fg-muted", "fg-subtle", "fg-faint", "accent", "accent-fg", "ok", "warn", "danger", "terminal", "terminal-fg"] as const;
export type Token = (typeof TOKENS)[number];
export type Colours = Partial<Record<Token, string>>;

/**
 * Colours in place of the portal's own, for light, for dark, or for both: a
 * theme an extension brought (see extensions/themes.ts). What a mode does not
 * say stays the portal's.
 */
export interface Palette {
  /** Which theme it is: "<package>/<id>". */
  id: string;
  name: string;
  light?: Colours;
  dark?: Colours;
}

const PALETTE_KEY = "pithagoras.palette";

/**
 * Themes that came with the portal as packages of their own and now are in another. A browser that chose one of them
 * before has the old id kept: it is the same theme under the new one.
 */
const MOVED_THEMES = new Map([
  ["pithagoras-theme-dusk/dusk", "pithagoras-themes/dusk"],
  ["pithagoras-theme-warm/warm", "pithagoras-themes/warm"],
]);

/** A theme's id as it is now: the one given, or where the theme went if its package was folded into another. */
export const themeIdNow = (id: string): string => MOVED_THEMES.get(id) ?? id;

const TRIPLET = /^\d{1,3} \d{1,3} \d{1,3}$/;

/** A colour as the portal's variables hold one, from that form or from "#rgb" / "#rrggbb". Null for anything else. */
export function toTriplet(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (TRIPLET.test(text)) return text.split(" ").every((n) => Number(n) <= 255) ? text : null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)).join(" ");
}

/** A mode's colours with only what is a colour of the portal's, each in the variables' own form. Null when something in it is not. */
export function coloursOf(given: unknown): Colours | null {
  if (given === undefined) return {};
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  const out: Colours = {};
  for (const [token, value] of Object.entries(given)) {
    const colour = toTriplet(value);
    if (!TOKENS.includes(token as Token) || !colour) return null;
    out[token as Token] = colour;
  }
  return out;
}

/** The theme chosen in this browser, with its colours: kept whole, so that it is painted before any extension is loaded. */
export function storedPalette(): Palette | null {
  try {
    const kept = JSON.parse(local.get(PALETTE_KEY) ?? "null");
    const light = coloursOf(kept?.light), dark = coloursOf(kept?.dark);
    if (typeof kept?.id !== "string" || typeof kept.name !== "string" || !light || !dark) return null;
    const now = { id: themeIdNow(kept.id), name: kept.name, light, dark };
    // Kept under the new id from now on, or the old one would be mapped at every start.
    if (now.id !== kept.id) local.set(PALETTE_KEY, JSON.stringify(now));
    return now;
  } catch {
    return null;
  }
}

let palette: Palette | null = storedPalette();
const paletteWatchers = new Set<() => void>();

/** The chosen theme's colours for the mode in effect, set over the portal's own; the portal's own given back where it says none. */
function paint(root: HTMLElement) {
  const colours = palette?.[root.dataset.theme === "light" ? "light" : "dark"] ?? {};
  for (const token of TOKENS) {
    if (colours[token]) root.style.setProperty(`--${token}`, colours[token]!);
    else root.style.removeProperty(`--${token}`);
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  // Transitions are enabled only for the moment of the change, so the whole app
  // does not fade every time something re-renders.
  root.classList.add("theme-switching");
  root.dataset.theme = resolve(theme);
  paint(root);
  // The installed app's title bar follows the page, not only the machine.
  const canvas = getComputedStyle(root).getPropertyValue("--canvas").trim().split(/\s+/).join(", ");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", `rgb(${canvas})`);
  window.setTimeout(() => root.classList.remove("theme-switching"), 200);
}

/** The theme in effect beyond light and dark: one an extension brought, or null for the portal's own. */
export const chosenPalette = (): Palette | null => palette;

/** Choose a theme's colours, or the portal's own with null. Kept in this browser, and painted at once. */
export function choosePalette(next: Palette | null): void {
  palette = next;
  if (next) local.set(PALETTE_KEY, JSON.stringify(next));
  else local.remove(PALETTE_KEY);
  apply(stored());
  for (const watcher of [...paletteWatchers]) watcher();
}

/** The chosen theme, drawn again when another is chosen. */
export function usePalette(): Palette | null {
  return useSyncExternalStore(
    (watcher) => {
      paletteWatchers.add(watcher);
      return () => void paletteWatchers.delete(watcher);
    },
    chosenPalette,
  );
}

function stored(): Theme {
  const value = local.get(KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    apply(theme);
    // Not kept in private mode; the theme still applies for this session.
    local.set(KEY, theme);
    if (theme !== "system") return;
    const mq = media();
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, resolved: resolve(theme) };
}

/**
 * The theme in effect, for the rare thing that needs the value rather than the
 * CSS variables — mermaid draws an SVG with baked-in colours, so it has to be
 * told. Read off the attribute `apply()` writes, so there is still one source
 * of truth and no second copy of the preference to keep in step.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setResolved(root.dataset.theme === "light" ? "light" : "dark");
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    read();
    return () => observer.disconnect();
  }, []);
  return resolved;
}
