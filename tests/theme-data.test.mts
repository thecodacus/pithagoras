import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { packageThemes } from "../core/server/src/extension-ui.ts";
import { choose, registerTheme, setThemeAs, setUiDefaultTheme, themes, themesSettled } from "../core/web/src/extensions/themes.ts";
import { chooseAppearance, chosenAppearance, chosenPalette, paletteSetBy, storedPalette } from "../core/web/src/theme.tsx";
import { HOSTILE_TOKENS as hostile, scratch } from "./helpers.mts";

/**
 * The look beyond colour in a theme's data: `tokens` beside `light` and `dark`, checked before anything is painted,
 * painted over the portal's own, and under the person's own text size and density. And who chose a theme: the person, or
 * the interface in use as its default; and whose theme an extension may switch to unasked.
 */

/** The page as far as a theme reaches into it: the variables set on the root and what the browser keeps. */
function page() {
  const set = new Map<string, string>();
  const kept = new Map<string, string>();
  const root = { dataset: { theme: "dark" } as Record<string, string>, classList: { add() {}, remove() {} }, style: { setProperty: (k: string, v: string) => set.set(k, v), removeProperty: (k: string) => set.delete(k) } };
  Object.assign(globalThis, {
    document: { documentElement: root, querySelector: () => null },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => "10 10 12" }),
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) },
  });
  return { set, kept, painted: () => Object.fromEntries(set) };
}
const away = () => { for (const name of ["document", "window", "getComputedStyle", "localStorage"]) delete (globalThis as any)[name]; };

/** Everything a theme sets that is not a colour, in the form the variables hold. */
const looks = (set: Map<string, string>) => Object.fromEntries([...set].filter(([name]) => !/^--(canvas|accent|surface)$/.test(name)));

// One test, in this order: that nobody has chosen is the state of the page before the first choice, and there is no way back to it.
test("an interface's default theme is in effect where nobody has chosen, waits for its package, and gives way to the person's choice", () => {
  const { set, kept } = page();
  try {
    assert.equal(paletteSetBy(), null, "nobody has chosen");

    // Its package is not there yet: in effect the moment it comes, and not kept when it never does.
    setUiDefaultTheme("late-pkg/late");
    assert.equal(chosenPalette(), null);
    const off = registerTheme("late-pkg", { id: "late", name: "Late", dark: { accent: "#0000ff" } });
    assert.equal(chosenPalette()?.id, "late-pkg/late");
    assert.deepEqual(Object.fromEntries(set), { "--accent": "0 0 255" });
    off();
    themesSettled(["late-pkg"]);
    assert.equal(chosenPalette()?.id, "late-pkg/late", "its package failed to load this time: kept as painted");
    themesSettled();
    assert.equal(chosenPalette(), null, "its package is not there: the colours it left are not kept");
    assert.deepEqual(Object.fromEntries(set), {});

    registerTheme("ui-pkg", { id: "calm", name: "Calm", dark: { accent: "#00ff00" }, tokens: { "radius-lg": "0.25rem" } });
    registerTheme("ui-pkg", { id: "bold", name: "Bold", dark: { accent: "#ff0000" } });
    setUiDefaultTheme("ui-pkg/calm");
    assert.equal(chosenPalette()?.id, "ui-pkg/calm");
    assert.equal(paletteSetBy(), "ui");
    assert.deepEqual(Object.fromEntries(set), { "--accent": "0 255 0", "--radius-lg": "0.25rem" });
    assert.equal(kept.get("pithagoras.palette.by"), "ui");

    // Another interface with another default, or with none: what the first left is not kept.
    setUiDefaultTheme("ui-pkg/bold");
    assert.equal(chosenPalette()?.id, "ui-pkg/bold");
    assert.deepEqual(Object.fromEntries(set), { "--accent": "255 0 0" });
    setUiDefaultTheme(null);
    assert.equal(chosenPalette(), null);
    assert.deepEqual(Object.fromEntries(set), {});

    // The person chooses: it stays theirs, whatever the interface says, and so does going back to the portal's own.
    setUiDefaultTheme("ui-pkg/calm");
    choose("ui-pkg/bold");
    assert.equal(paletteSetBy(), "person");
    setUiDefaultTheme("ui-pkg/calm");
    assert.equal(chosenPalette()?.id, "ui-pkg/bold");
    choose(null);
    setUiDefaultTheme("ui-pkg/calm");
    assert.equal(chosenPalette(), null, "the portal's own colours, chosen on purpose, are a choice");
    // A theme the browser has had from before there was a default is the person's as well.
    kept.set("pithagoras.palette", JSON.stringify({ id: "old-pkg/old", name: "Old", dark: { accent: "1 2 3" } }));
    kept.delete("pithagoras.palette.by");
    assert.equal(storedPalette()?.id, "old-pkg/old");
  } finally {
    setUiDefaultTheme(null);
    choose(null);
    away();
  }
});

test("a theme's tokens are painted over the portal's own, under the person's, and go with the theme", () => {
  const { set, kept } = page();
  try {
    const off = registerTheme("look-pkg", { id: "soft", name: "Soft", dark: { accent: "#ff79c6" }, tokens: { "radius-lg": "1rem", "font-sans": '"Fixture Face", serif', pad: "0.3rem" } });
    choose("look-pkg/soft");
    assert.deepEqual(looks(set), { "--radius-lg": "1rem", "--font-sans": '"Fixture Face", serif', "--pad": "0.3rem" });
    assert.deepEqual(JSON.parse(kept.get("pithagoras.palette")!).tokens, { "radius-lg": "1rem", "font-sans": '"Fixture Face", serif', pad: "0.3rem" }, "kept whole, to be painted before the app");
    assert.deepEqual(storedPalette()?.tokens, { "radius-lg": "1rem", "font-sans": '"Fixture Face", serif', pad: "0.3rem" });

    // The person's density is over the theme's own unit, and the text size over the portal's where the theme says none.
    chooseAppearance({ text: 110, density: 90 });
    assert.deepEqual(looks(set), { "--radius-lg": "1rem", "--font-sans": '"Fixture Face", serif', "--pad": "calc(0.3rem * 0.9)", "--gap": "calc(0.25rem * 0.9)", "--text-base": "calc(1rem * 1.1)" });

    // Another theme: nothing of the first is left on the page.
    registerTheme("look-pkg", { id: "plain", name: "Plain", dark: { accent: "#00ff00" } });
    choose("look-pkg/plain");
    assert.deepEqual(looks(set), { "--gap": "calc(0.25rem * 0.9)", "--pad": "calc(0.25rem * 0.9)", "--text-base": "calc(1rem * 1.1)" });
    chooseAppearance({ text: 100, density: 100 });
    assert.deepEqual(looks(set), {});

    // A theme with tokens alone is a theme; one with nothing is not.
    registerTheme("look-pkg", { id: "only", name: "Only", tokens: { "radius-md": "0px" } });
    assert.throws(() => registerTheme("look-pkg", { id: "nothing", name: "Nothing", tokens: {} }), /sets no colours or tokens/);
    choose("look-pkg/only");
    assert.deepEqual(looks(set), { "--radius-md": "0px" });
    off();
  } finally {
    choose(null);
    chooseAppearance({ text: 100, density: 100 });
    away();
  }
});

test("a theme registered again with other tokens is painted as it is now", () => {
  const { set } = page();
  try {
    const first = registerTheme("again-pkg", { id: "t", name: "T", tokens: { "radius-lg": "1rem" } });
    choose("again-pkg/t");
    assert.deepEqual(looks(set), { "--radius-lg": "1rem" });
    first();
    registerTheme("again-pkg", { id: "t", name: "T", tokens: { "radius-lg": "0.25rem" } });
    assert.deepEqual(looks(set), { "--radius-lg": "0.25rem" }, "the update of an extension changes only its tokens");
  } finally {
    choose(null);
    away();
  }
});

test("a theme that carries a rule of CSS, a url or a way out of its declaration is refused whole, and nothing of it reaches the page", () => {
  const { set, kept } = page();
  try {
    for (const [name, value] of hostile) {
      assert.throws(() => registerTheme("evil-pkg", { id: "e", name: "E", dark: { accent: "#ff0000" }, tokens: { "radius-md": "0.5rem", [name]: value } as any }), /no theme|token the portal has none of/, `${name}: ${value}`);
      // The kept copy is checked the same: a browser's storage can be written by anything that runs in the page.
      kept.set("pithagoras.palette", JSON.stringify({ id: "evil-pkg/e", name: "E", dark: { accent: "1 2 3" }, tokens: { [name]: value } }));
      assert.equal(storedPalette(), null, `${name}: ${value}`);
    }
    for (const bad of [[], "radius-lg: 1rem", 1, null, { "radius-lg": 8 }, { "radius-lg": ["1rem"] }, { "radius-lg": { toString: () => "1rem" } }]) {
      assert.throws(() => registerTheme("evil-pkg", { id: "e", name: "E", dark: { accent: "#ff0000" }, tokens: bad as any }), /token the portal has none of/, JSON.stringify(bad));
    }
    assert.deepEqual(themes().filter((t) => t.extension === "evil-pkg"), [], "none of them was registered");
    assert.deepEqual(Object.fromEntries(set), {}, "and nothing was set on the page");
    // The family a font stack names is a name: a stack of names, quoted or not, is all it is.
    assert.doesNotThrow(() => registerTheme("fine-pkg", { id: "f", name: "F", tokens: { "font-sans": `"Atkinson Hyperlegible Next", Inter, 'Segoe UI', system-ui, sans-serif` } }));
  } finally {
    away();
  }
});

test("a package.json hands its tokens to the page as they are written, for the page to check", () => {
  const dir = scratch("theme-data-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "look-pkg", version: "1.0.0", pithagoras: { themes: [
    { id: "soft", name: "Soft", dark: { accent: "#ff79c6" }, tokens: { "radius-lg": "1rem", "font-sans": "url(x)" } },
    { id: "odd", name: "Odd", tokens: ["not a map"] },
    { id: "num", name: "Num", tokens: { pad: 3 } },
  ] } }));
  assert.deepEqual(packageThemes(dir)?.themes, [
    { id: "soft", name: "Soft", dark: { accent: "#ff79c6" }, tokens: { "radius-lg": "1rem", "font-sans": "url(x)" } },
    { id: "odd", name: "Odd" },
    { id: "num", name: "Num" },
  ]);
});

test("an extension switches to a theme of its own unasked, and to another's only when the person says yes", async () => {
  page();
  try {
    registerTheme("mine-pkg", { id: "m", name: "Mine", dark: { accent: "#ff79c6" } });
    registerTheme("other-pkg", { id: "o", name: "Other", dark: { accent: "#00ff00" } });
    const asked: unknown[] = [];
    let answer = false;
    const ask = async (question: unknown) => (asked.push(question), answer);

    assert.equal(await setThemeAs("mine-pkg", "mine-pkg/m", ask), true);
    assert.equal(chosenPalette()?.id, "mine-pkg/m");
    assert.deepEqual(asked, [], "its own: no question");
    assert.equal(await setThemeAs("mine-pkg", null, ask), true, "and back to the portal's own from its own");
    assert.deepEqual(asked, []);

    assert.equal(await setThemeAs("mine-pkg", "other-pkg/o", ask), false, "another's, declined");
    assert.deepEqual(asked, [{ extension: "mine-pkg", theme: "Other", owner: "other-pkg" }], "the person is told whose theme it is");
    assert.equal(chosenPalette(), null, "nothing changed");
    answer = true;
    assert.equal(await setThemeAs("mine-pkg", "other-pkg/o", ask), true);
    assert.equal(chosenPalette()?.id, "other-pkg/o");
    assert.equal(paletteSetBy(), "person");

    // Leaving another's theme for the portal's own is the same: not its own to take away.
    answer = false;
    assert.equal(await setThemeAs("mine-pkg", null, ask), false);
    assert.equal(chosenPalette()?.id, "other-pkg/o");
    assert.deepEqual(asked.at(-1), { extension: "mine-pkg", theme: null, owner: null });
    answer = true;
    assert.equal(await setThemeAs("mine-pkg", null, ask), true);
    assert.equal(chosenPalette(), null);

    // A package whose name only starts the same is not the same package.
    await setThemeAs("mine", "mine-pkg/m", async () => (asked.push("asked"), true));
    assert.equal(asked.at(-1), "asked");
    choose(null);

    await assert.rejects(() => setThemeAs("mine-pkg", "mine-pkg/none", ask), /no theme called "mine-pkg\/none"/);
    // Gone while the question was open: not switched to.
    const gone = registerTheme("gone-pkg", { id: "g", name: "G", dark: { accent: "#222222" } });
    await assert.rejects(() => setThemeAs("mine-pkg", "gone-pkg/g", async () => (gone(), themesSettled(), true)), /no theme called|There is no theme/);
    assert.equal(chosenPalette(), null);
  } finally {
    choose(null);
    chooseAppearance({ text: 100, density: 100 });
    assert.deepEqual(chosenAppearance(), { text: 100, density: 100 });
    away();
  }
});

test("a theme's name is a name: one that would make the question a wall of text is refused", () => {
  page();
  try {
    assert.throws(() => registerTheme("long-pkg", { id: "l", name: "your current colours, which you chose a while ago and which stay as they are".repeat(2), dark: { accent: "#ffffff" } }), /name longer than 60 characters/);
    assert.throws(() => registerTheme("long-pkg", { id: "b", name: "   ", dark: { accent: "#ffffff" } }), /needs an id and a name/);
    assert.doesNotThrow(() => registerTheme("long-pkg", { id: "s", name: "A".repeat(60), dark: { accent: "#ffffff" } }));
  } finally {
    away();
  }
});

test("a kept theme the app refuses is taken out of the browser, so that it is not painted again before the app at the next start", () => {
  const { kept } = page();
  try {
    for (const bad of [
      { id: "x/y", name: "Y", dark: { accent: "1 2 3", "z-confirm": "0 0 0" } },
      { id: "x/y", name: "Y", dark: { accent: "1 2 3" }, tokens: { "font-sans": "Inter," } },
      { id: "x/y", dark: { accent: "1 2 3" } },
    ]) {
      kept.set("pithagoras.palette", JSON.stringify(bad));
      assert.equal(storedPalette(), null, JSON.stringify(bad));
      assert.equal(kept.has("pithagoras.palette"), false, JSON.stringify(bad));
    }
    kept.set("pithagoras.palette", "{");
    assert.equal(storedPalette(), null);
    assert.equal(kept.has("pithagoras.palette"), false, "nor what is not JSON");
    const fine = { id: "x/y", name: "Y", dark: { accent: "1 2 3" } };
    kept.set("pithagoras.palette", JSON.stringify(fine));
    assert.deepEqual(storedPalette(), { ...fine, light: {} });
    assert.equal(kept.get("pithagoras.palette"), JSON.stringify(fine), "a theme that is one is kept as it is");
  } finally {
    away();
  }
});
