import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { HOSTILE_TOKENS } from "./helpers.mts";
import { appearanceOf, PAINTED_NAMES, tokensOf, tokenStyles, tokenValue } from "../core/web/src/tokens.ts";
import { storedPalette } from "../core/web/src/theme.tsx";

/**
 * The look beyond colour: what a theme may set and what the person may scale, and that the script that paints it before
 * the app (core/web/public/theme-init.js) takes the same and refuses the same as the app does.
 */

test("a theme's tokens are lengths and font stacks the variables can hold, and nothing else", () => {
  assert.deepEqual(tokensOf(undefined), {});
  assert.deepEqual(tokensOf({ "radius-lg": "0.75rem", pad: "4px", "font-sans": 'Inter, "Segoe UI", sans-serif', "chat-max": " 60rem " }), { "radius-lg": "0.75rem", pad: "4px", "font-sans": 'Inter, "Segoe UI", sans-serif', "chat-max": "60rem" });
  for (const bad of [
    { "radius-lg": "url(x)" }, { "radius-lg": "12" }, { "radius-lg": "3rem" }, { pad: "0" }, { pad: "1rem" }, { "text-base": "40px" },
    { "font-sans": "x; background: red" }, { "font-sans": "url(https://example.test/a.woff2)" }, { "font-sans": "a}b" }, { "font-sans": "" },
    { "z-confirm": "1" }, { nothing: "1rem" }, { "radius-lg": 8 }, [], "radius-lg", null,
  ]) assert.equal(tokensOf(bad), null, JSON.stringify(bad));
  assert.equal(tokenValue("font-mono", "ui-monospace, Menlo, monospace"), "ui-monospace, Menlo, monospace");
  // Every stack the portal ships is one a theme may write.
  assert.ok(tokenValue("font-sans", 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'));
  assert.ok(tokenValue("font-mono", 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'));
  assert.ok(tokenValue("font-sans", "-apple-system, 'Segoe UI', sans-serif"));
});

test("a theme's shadows, line width, durations and easings are the forms the portal's own are written in, and nothing else", () => {
  assert.deepEqual(tokensOf({
    "shadow-sm": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    "shadow-pop": "0 10px 30px -12px rgb(0 0 0 / 0.35), 0 2px 8px -4px rgb(0 0 0 / 0.2)",
    "border-width": "2px",
    "dur-fast": "100ms",
    "dur-base": "0.4s",
    "ease-out": "cubic-bezier(.22, 1, .36, 1)",
    "ease-spring": "cubic-bezier(.34, 1.56, .64, 1)",
  }), {
    "shadow-sm": "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    "shadow-pop": "0 10px 30px -12px rgb(0 0 0 / 0.35), 0 2px 8px -4px rgb(0 0 0 / 0.2)",
    "border-width": "2px",
    "dur-fast": "100ms",
    "dur-base": "0.4s",
    "ease-out": "cubic-bezier(.22, 1, .36, 1)",
    "ease-spring": "cubic-bezier(.34, 1.56, .64, 1)",
  });
  for (const fine of [["shadow-pop", "none"], ["shadow-sm", "inset 0 1px 0 #ffffff1a"], ["shadow-sm", "0 0 0 1px transparent"], ["border-width", "0px"], ["dur-fast", "0ms"], ["ease-out", "ease-in-out"], ["ease-out", "linear"]]) {
    assert.ok(tokenValue(fine[0], fine[1]), fine.join(": "));
  }
});

test("a theme's font-mono is the font of the chat's technical rows too, which otherwise keep their own shorter stack", () => {
  assert.deepEqual(tokenStyles({ "font-mono": '"JetBrains Mono", monospace' }), { "font-mono": '"JetBrains Mono", monospace', "font-mono-chat": '"JetBrains Mono", monospace' });
  assert.deepEqual(tokenStyles({ "font-sans": "Inter, sans-serif" }), { "font-sans": "Inter, sans-serif" });
  const css = (file: string) => readFileSync(path.resolve(import.meta.dirname, "../core/web/src", file), "utf8");
  assert.doesNotMatch(css("styles/chat.css"), /ui-monospace/, "every technical row reads the variable");
  assert.match(css("index.css"), /--font-mono-chat: ui-monospace, SFMono-Regular, Menlo, monospace;/, "and the portal's own value is the stack the rows had");
});

test("the person's text size and density are whole percents within range, and a hundred is no change", () => {
  assert.deepEqual(appearanceOf(null), { text: 100, density: 100 });
  assert.deepEqual(appearanceOf({ text: 115, density: 80 }), { text: 115, density: 80 });
  assert.deepEqual(appearanceOf({ text: 300, density: "80" }), { text: 100, density: 100 });
  assert.deepEqual(appearanceOf({ text: 112.5, density: 69 }), { text: 100, density: 100 });
  assert.deepEqual(tokenStyles({}, { text: 100, density: 100 }), {});
  // The person's size is over the theme's, and over the portal's where the theme says none.
  assert.deepEqual(tokenStyles({ pad: "0.2rem" }, { text: 110, density: 90 }), { "text-base": "calc(1rem * 1.1)", pad: "calc(0.2rem * 0.9)", gap: "calc(0.25rem * 0.9)" });
});

/** What theme-init.js sets on <html> for what the browser has kept, with a name for each thing it touched. */
function painted(kept: Record<string, unknown>) {
  const set: Record<string, string> = {};
  const storage = new Map(Object.entries(kept).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  const root = { dataset: {} as Record<string, string>, style: { setProperty: (name: string, value: string) => void (set[name] = value) } };
  vm.runInNewContext(readFileSync(path.resolve(import.meta.dirname, "../core/web/public/theme-init.js"), "utf8"), {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    matchMedia: () => ({ matches: false }),
    document: { documentElement: root, querySelector: () => null },
    JSON, Object, Number,
  });
  return { set, theme: root.dataset.theme };
}

const palette = (tokens: unknown) => ({ "pithagoras.palette": { id: "x/y", name: "Y", dark: { accent: "1 2 3" }, tokens } });
const CASES: Record<string, Record<string, unknown>> = {
  "no choice": {},
  "a theme's tokens": palette({ "radius-lg": "0.75rem", "radius-xl": "1rem", "font-sans": '"Inter", sans-serif', pad: "0.2rem", "chat-max": "60rem" }),
  "a theme's code font, shadows, line width and motion": palette({ "font-mono": '"JetBrains Mono", monospace', "shadow-pop": "0 4px 12px rgb(0 0 0 / 0.5)", "border-width": "2px", "dur-fast": "80ms", "ease-out": "ease-in" }),
  "a theme with a value that is not one": palette({ "radius-lg": "0.75rem", "font-sans": "x; background: red" }),
  "a theme with a token the portal has none of": palette({ "radius-lg": "0.75rem", "z-confirm": "1" }),
  "the person's size and density": { "pithagoras.appearance": { text: 115, density: 80 } },
  "a theme and the person": { ...palette({ pad: "0.2rem", "text-base": "1.125rem" }), "pithagoras.appearance": { text: 90, density: 110 } },
  "the person's values out of range": { "pithagoras.appearance": { text: 400, density: 5 } },
};

for (const [name, kept] of Object.entries(CASES)) {
  test(`before the app: ${name} is painted as the app paints it`, () => {
    const stored = kept["pithagoras.palette"] as { tokens?: unknown } | undefined;
    const tokens = tokensOf(stored?.tokens) ?? {};
    const expected = Object.fromEntries(Object.entries(tokenStyles(tokens, appearanceOf(kept["pithagoras.appearance"]))).map(([key, value]) => [`--${key}`, value]));
    const { set } = painted(kept);
    assert.deepEqual(Object.fromEntries(Object.entries(set).filter(([key]) => PAINTED_NAMES.includes(key.slice(2) as never))), expected);
  });
}

test("before the app: a stored value that cannot be read does not take the chosen theme's colours with it", () => {
  const { set, theme } = painted({ "pithagoras.theme": "dark", ...palette({ "radius-lg": "0.75rem" }), "pithagoras.appearance": "{" });
  assert.equal(theme, "dark");
  assert.equal(set["--accent"], "1 2 3");
});

test("before the app: a theme that carries a rule of CSS, a url or a way out of its declaration is not painted, as in the app", () => {
  for (const [name, value] of HOSTILE_TOKENS) {
    const kept = palette({ "radius-md": "0.5rem" });
    // Written as JSON, as the browser keeps it: `__proto__` is an own name there.
    kept["pithagoras.palette"] = JSON.parse(`{"id":"x/y","name":"Y","dark":{"accent":"1 2 3"},"tokens":{"radius-md":"0.5rem",${JSON.stringify(name)}:${JSON.stringify(value)}}}`);
    assert.equal(tokensOf((kept["pithagoras.palette"] as { tokens: unknown }).tokens), null, `${name}: ${value}`);
    const { set } = painted(kept);
    // Refused whole, as the app refuses it (storedPalette): its colours are not painted either, or they would be taken
    // away again the moment the app starts.
    assert.deepEqual(set, {}, `${name}: ${value}`);
  }
});

/** What the app paints for what the browser has kept, in dark: the kept theme as storedPalette reads it, and the person's controls. */
function paintedByApp(kept: Record<string, unknown>): Record<string, string> {
  const storage = new Map(Object.entries(kept).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  try {
    const theme = storedPalette();
    const looks = tokenStyles(theme?.tokens, appearanceOf(kept["pithagoras.appearance"]));
    return Object.fromEntries([...Object.entries(theme?.dark ?? {}), ...Object.entries(looks)].map(([key, value]) => [`--${key}`, value!]));
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test("before the app: a kept theme is painted whole or not at all, as the app reads it", () => {
  const theme = (given: Record<string, unknown>) => ({ "pithagoras.palette": { id: "x/y", name: "Y", ...given } });
  const kept: Record<string, Record<string, unknown>> = {
    "colours and tokens": theme({ dark: { accent: "1 2 3", canvas: "#0a0a0c" }, light: { accent: "#fff" }, tokens: { "radius-lg": "1rem" } }),
    // Names that are not colours reach the variables of the layers, the spacing and the text: not one of them is painted.
    "a colour under a layer's name": theme({ dark: { accent: "1 2 3", "z-confirm": "0 0 0", pad: "1 2 3" } }),
    "a colour that is not one": theme({ dark: { accent: "1 2 3", canvas: "300 0 0" } }),
    "a bad colour in the other mode": theme({ dark: { accent: "1 2 3" }, light: { accent: "red" } }),
    "tokens that are null": theme({ dark: { accent: "1 2 3" }, tokens: null }),
    "a token that is refused": theme({ dark: { accent: "1 2 3" }, tokens: { "radius-lg": "1rem", "font-sans": "Inter," } }),
    "no name": { "pithagoras.palette": { id: "x/y", dark: { accent: "1 2 3" } } },
    "not JSON": { "pithagoras.palette": "{", "pithagoras.appearance": { text: 110, density: 100 } },
    "a refused theme and the person's size": { ...theme({ dark: { "z-dialog": "0 0 0" } }), "pithagoras.appearance": { text: 120, density: 90 } },
  };
  for (const [name, stored] of Object.entries(kept)) {
    assert.deepEqual(painted({ "pithagoras.theme": "dark", ...stored }).set, paintedByApp(stored), name);
  }
  assert.deepEqual(painted(kept["a colour under a layer's name"]).set, {});
  assert.deepEqual(painted(kept["colours and tokens"]).set, { "--accent": "1 2 3", "--canvas": "10 10 12", "--radius-lg": "1rem" });
});
