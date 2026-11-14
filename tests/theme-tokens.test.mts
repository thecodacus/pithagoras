import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { HOSTILE_TOKENS } from "./helpers.mts";
import { appearanceOf, tokensOf, tokenStyles, tokenValue, TOKEN_NAMES } from "../core/web/src/tokens.ts";

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
    assert.deepEqual(Object.fromEntries(Object.entries(set).filter(([key]) => TOKEN_NAMES.includes(key.slice(2) as never))), expected);
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
    assert.deepEqual(Object.keys(set).filter((key) => TOKEN_NAMES.includes(key.slice(2) as never)), [], `${name}: ${value}`);
    assert.equal(set["--accent"], "1 2 3", "the colours are still painted");
  }
});
