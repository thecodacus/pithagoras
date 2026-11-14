/**
 * The look beyond colour: type, shape, spacing, elevation, motion and layout, as CSS variables (index.css), which a theme may set and
 * the person may scale. Colours are theme.tsx's; this is the rest, with the same rule for both: a value is
 * checked before it is painted, and one that is not what its variable holds is refused whole, so that a theme is
 * only ever data and cannot carry a rule of CSS.
 *
 * theme-init.js paints the same before the app, with the same checks written out again (it is a plain script and
 * cannot import); tests/theme-tokens.test.mts runs it against this file.
 */

/**
 * What a variable holds: a length between two sizes (in rem; px is one sixteenth of one), a stack of font names, a
 * shadow, a time (ms) up to a most, or an easing curve.
 */
type Rule = { length: [least: number, most: number] } | "font" | "shadow" | { time: number } | "easing";

const radius: Rule = { length: [0, 2] };
const space: Rule = { length: [0.1, 0.6] };

/** The variables a theme may set, and what each takes. The layers (`--z-*`) are not here: whose window is over whose is not a theme's to say. */
export const TOKEN_RULES = {
  "font-sans": "font",
  "font-mono": "font",
  "text-base": { length: [0.75, 1.5] },
  "radius-sm": radius,
  "radius-md": radius,
  "radius-lg": radius,
  "radius-xl": radius,
  "radius-2xl": radius,
  "border-width": { length: [0, 0.25] },
  pad: space,
  gap: space,
  "shadow-sm": "shadow",
  "shadow-pop": "shadow",
  "dur-fast": { time: 1000 },
  "dur-base": { time: 1000 },
  "ease-out": "easing",
  "ease-spring": "easing",
  "chat-max": { length: [24, 90] },
  "nav-width": { length: [12, 24] },
} as const satisfies Record<string, Rule>;

export type TokenName = keyof typeof TOKEN_RULES;
export const TOKEN_NAMES = Object.keys(TOKEN_RULES) as TokenName[];
export type Tokens = Partial<Record<TokenName, string>>;

/**
 * What is painted for a theme's tokens: the tokens, and the font of the chat's technical rows (tool names, commands,
 * outputs), which has a shorter stack of its own as the portal ships it (index.css) and follows a theme's `font-mono`.
 */
export const PAINTED_NAMES = [...TOKEN_NAMES, "font-mono-chat"] as const;
export type Painted = Partial<Record<(typeof PAINTED_NAMES)[number], string>>;

/** What the portal ships for the variables the person's choices scale (index.css). */
const STOCK = { "text-base": "1rem", pad: "0.25rem", gap: "0.25rem" } as const;

const LENGTH = /^(\d{1,3}(?:\.\d{1,3})?)(px|rem)$/;
/**
 * One name of a font stack: quoted, with no quote of its kind and no comma inside, or words that each start with a
 * letter or `_` (or a `-` and one of those) and go on in letters, digits, `_` and `-`. Nothing else, so no `(` (no
 * `url(...)`), no `;`, `{`, `}`, `\`, `/`, `:`, `@` or `!`, and no empty name: a stack the browser cannot read would
 * leave the page in its default serif, not in the portal's own font.
 */
const FONT_NAME = /^(?:"[\p{L}\p{N}_ '.-]{1,100}"|'[\p{L}\p{N}_ ".-]{1,100}'|-?[\p{L}_][\p{L}\p{N}_-]*(?: +-?[\p{L}_][\p{L}\p{N}_-]*)*)$/u;
const fontStack = (text: string) => text.length <= 200 && text.split(",").every((name) => FONT_NAME.test(name.trim()));
/**
 * One shadow: `inset` or not, two to four lengths (px or rem, or 0), and a colour as `rgb(0 0 0 / 0.2)`, `#hex` or
 * `transparent`. An `rgb()` of three numbers and an alpha is the one bracket a token may have.
 */
const SHADOW = /^(?:inset\s+)?((?:-?\d{1,3}(?:\.\d{1,3})?(?:px|rem)|0)(?:\s+(?:-?\d{1,3}(?:\.\d{1,3})?(?:px|rem)|0)){1,3})(?:\s+(?:rgb\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(?:\/\s*(?:0|1|0?\.\d{1,3})\s*)?\)|#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent))?$/i;
/** `none`, or one to four shadows, each length at most 4rem either way and each colour's numbers at most 255. */
function shadow(text: string): boolean {
  if (text === "none") return true;
  const shadows = text.split(",");
  return shadows.length <= 4 && shadows.every((one) => {
    const parts = SHADOW.exec(one.trim());
    if (!parts) return false;
    const rem = (length: string) => Math.abs(parseFloat(length)) / (length.endsWith("px") ? 16 : 1);
    return parts[1].split(/\s+/).every((length) => rem(length) <= 4) && parts.slice(2).every((n) => n === undefined || Number(n) <= 255);
  });
}
const TIME = /^(\d{1,4}(?:\.\d{1,3})?)(ms|s)$/;
const BEZIER = /^cubic-bezier\(\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*,\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*,\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*,\s*(-?\d{0,2}(?:\.\d{1,3})?)\s*\)$/;
/** A keyword the browser has, or a cubic-bezier of four numbers: x between 0 and 1, as CSS wants, and y between -2 and 3. */
function easing(text: string): boolean {
  if (["linear", "ease", "ease-in", "ease-out", "ease-in-out"].includes(text)) return true;
  const curve = BEZIER.exec(text);
  if (!curve) return false;
  const [x1, y1, x2, y2] = curve.slice(1).map((n) => (/\d/.test(n) ? Number(n) : NaN));
  return [x1, x2].every((x) => x >= 0 && x <= 1) && [y1, y2].every((y) => y >= -2 && y <= 3);
}

/** A value as the variable takes it: as it was given, trimmed, or null for anything that is not one. */
export function tokenValue(name: string, value: unknown): string | null {
  // Own names only: `constructor` and `__proto__` are on every object.
  const rule = Object.hasOwn(TOKEN_RULES, name) ? (TOKEN_RULES as Record<string, Rule>)[name] : undefined;
  if (!rule || typeof value !== "string") return null;
  const text = value.trim();
  if (rule === "font") return fontStack(text) ? text : null;
  if (rule === "shadow") return shadow(text) ? text : null;
  if (rule === "easing") return easing(text) ? text : null;
  if ("time" in rule) {
    const time = TIME.exec(text);
    return time && Number(time[1]) * (time[2] === "s" ? 1000 : 1) <= rule.time ? text : null;
  }
  const length = LENGTH.exec(text);
  if (!length) return null;
  const rem = Number(length[1]) / (length[2] === "px" ? 16 : 1);
  return rem >= rule.length[0] && rem <= rule.length[1] ? text : null;
}

/** A theme's tokens with only what is a variable of the portal's and a value it takes. Null when something in it is not. */
export function tokensOf(given: unknown): Tokens | null {
  if (given === undefined) return {};
  if (!given || typeof given !== "object" || Array.isArray(given)) return null;
  const out: Tokens = {};
  for (const [name, value] of Object.entries(given)) {
    const clean = tokenValue(name, value);
    if (clean === null) return null;
    out[name as TokenName] = clean;
  }
  return out;
}

/**
 * The person's own two controls, as percent of what the theme (or the portal) has: how big the text is, and how
 * much room there is between and inside things. A hundred is no change.
 */
export interface Appearance {
  text: number;
  density: number;
}
export const APPEARANCE_RANGE = { text: [80, 140], density: [70, 140] } as const;
export const STOCK_APPEARANCE: Appearance = { text: 100, density: 100 };

/** The controls as given, or the stock ones for anything that is not two whole numbers within range. */
export function appearanceOf(given: unknown): Appearance {
  const kept = given && typeof given === "object" ? (given as Record<string, unknown>) : {};
  const pick = (key: keyof Appearance) => {
    const value = kept[key], [least, most] = APPEARANCE_RANGE[key];
    return typeof value === "number" && Number.isInteger(value) && value >= least && value <= most ? value : 100;
  };
  return { text: pick("text"), density: pick("density") };
}

/**
 * What each variable is set to, theme first and then the person's controls over it: only those that differ from the
 * portal's own. A theme's `font-mono` is the chat's technical rows' font too.
 */
export function tokenStyles(tokens: Tokens = {}, appearance: Appearance = STOCK_APPEARANCE): Painted {
  const out: Painted = { ...tokens };
  if (tokens["font-mono"]) out["font-mono-chat"] = tokens["font-mono"];
  const scale = (name: keyof typeof STOCK, percent: number) => {
    if (percent !== 100) out[name] = `calc(${tokens[name] ?? STOCK[name]} * ${percent / 100})`;
  };
  scale("text-base", appearance.text);
  scale("pad", appearance.density);
  scale("gap", appearance.density);
  return out;
}
