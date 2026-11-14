import test from "node:test";
import assert from "node:assert/strict";
import { choose, registerTheme, setThemeAs, setUiDefaultTheme, themesSettled } from "../core/web/src/extensions/themes.ts";
import { chosenPalette, paletteSetBy } from "../core/web/src/theme.tsx";

/**
 * Whose theme is in effect when an extension switches to its own without asking: not the person's. In a file of its own,
 * because it starts where nobody has chosen, and there is no way back to that within one page (tests/theme-data.test.mts).
 */

function page() {
  const kept = new Map<string, string>();
  const root = { dataset: { theme: "dark" } as Record<string, string>, classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } };
  Object.assign(globalThis, {
    document: { documentElement: root, querySelector: () => null },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 0 },
    getComputedStyle: () => ({ getPropertyValue: () => "10 10 12" }),
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) },
  });
  return { kept };
}
const away = () => { for (const name of ["document", "window", "getComputedStyle", "localStorage"]) delete (globalThis as any)[name]; };

test("an extension's switch to its own theme is not the person's choice: the interface's default comes back with another interface", async () => {
  const { kept } = page();
  const unasked = async () => { throw new Error("asked"); };
  try {
    registerTheme("ext-pkg", { id: "own", name: "Own", dark: { accent: "#ff0000" } });
    registerTheme("ui-a", { id: "look", name: "Look A", dark: { accent: "#00ff00" } });
    registerTheme("ui-b", { id: "look", name: "Look B", dark: { accent: "#0000ff" } });

    // Nobody has chosen: the extension switches to its own, and it stands while nothing else is declared.
    assert.equal(await setThemeAs("ext-pkg", "ext-pkg/own", unasked), true);
    assert.equal(paletteSetBy(), "extension");
    assert.equal(kept.get("pithagoras.palette.by"), "extension");
    themesSettled();
    assert.equal(chosenPalette()?.id, "ext-pkg/own");

    // An interface with a default of its own is put in use: its default is in effect, not the extension's.
    setUiDefaultTheme("ui-a/look");
    assert.equal(chosenPalette()?.id, "ui-a/look");
    assert.equal(paletteSetBy(), "ui");

    // Under that interface the extension switches again: its switch stands over the same interface's default, at the
    // next start as well (the default is declared again there).
    assert.equal(await setThemeAs("ext-pkg", "ext-pkg/own", unasked), true);
    setUiDefaultTheme("ui-a/look");
    themesSettled();
    assert.equal(chosenPalette()?.id, "ext-pkg/own");
    // Another interface: its default.
    setUiDefaultTheme("ui-b/look");
    assert.equal(chosenPalette()?.id, "ui-b/look");

    // What the person said yes to is theirs, and stays over any interface's default.
    assert.equal(await setThemeAs("ext-pkg", "ui-a/look", async () => true), true);
    assert.equal(paletteSetBy(), "person");
    setUiDefaultTheme("ui-b/look");
    assert.equal(chosenPalette()?.id, "ui-a/look");
    // And an extension that switches to its own over the person's choice does not make it nobody's.
    assert.equal(await setThemeAs("ext-pkg", "ext-pkg/own", unasked), true);
    assert.equal(paletteSetBy(), "person");
  } finally {
    setUiDefaultTheme(null);
    choose(null);
    away();
  }
});
