/**
 * The look beyond colour: type, shape, spacing and layout, as CSS variables (index.css), which a theme may set and
 * the person may scale. Colours are theme.tsx's; this is the rest, with the same rule for both: a value is
 * checked before it is painted, and one that is not what its variable holds is refused whole, so that a theme is
 * only ever data and cannot carry a rule of CSS.
 *
 * theme-init.js paints the same before the app, with the same checks written out again (it is a plain script and
 * cannot import); tests/theme-tokens.test.mts runs it against this file.
 */

/** What a variable holds: a length between two sizes (in rem; px is one sixteenth of one), or a stack of font names. */
type Rule = { length: [least: number, most: number] } | "font";

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
  pad: space,
  gap: space,
  "chat-max": { length: [24, 90] },
  "nav-width": { length: [12, 24] },
} as const satisfies Record<string, Rule>;

export type TokenName = keyof typeof TOKEN_RULES;
export const TOKEN_NAMES = Object.keys(TOKEN_RULES) as TokenName[];
export type Tokens = Partial<Record<TokenName, string>>;

/** What the portal ships for the variables the person's choices scale (index.css). */
const STOCK = { "text-base": "1rem", pad: "0.25rem", gap: "0.25rem" } as const;

const LENGTH = /^(\d{1,3}(?:\.\d{1,3})?)(px|rem)$/;
/** Letters, digits, spaces, commas, quotes, dots and hyphens: no `(`, so no `url(...)`, and no `;`, `{` or `\`. */
const FONT = /^[\p{L}\p{N}_ "',.-]{1,200}$/u;

/** A value as the variable takes it: the length or the font stack as it was given, or null for anything that is not one. */
export function tokenValue(name: string, value: unknown): string | null {
  const rule = (TOKEN_RULES as Record<string, Rule>)[name];
  if (!rule || typeof value !== "string") return null;
  const text = value.trim();
  if (rule === "font") return FONT.test(text) ? text : null;
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

/** What each variable is set to, theme first and then the person's controls over it: only those that differ from the portal's own. */
export function tokenStyles(tokens: Tokens = {}, appearance: Appearance = STOCK_APPEARANCE): Tokens {
  const out: Tokens = { ...tokens };
  const scale = (name: keyof typeof STOCK, percent: number) => {
    if (percent !== 100) out[name] = `calc(${tokens[name] ?? STOCK[name]} * ${percent / 100})`;
  };
  scale("text-base", appearance.text);
  scale("pad", appearance.density);
  scale("gap", appearance.density);
  return out;
}
