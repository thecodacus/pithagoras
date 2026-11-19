import test from "node:test";
import assert from "node:assert/strict";

/**
 * An extension switches to a theme of its own before the interface has said what its default is (the extensions load
 * beside the manifest). The switch stands over that default, whichever it turns out to be: declaring the same default
 * afterwards does not take it away. In a file of its own: the module's state is the page's.
 */

const kept = new Map<string, string>();
const root = { dataset: { theme: "dark" } as Record<string, string>, classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } };
Object.assign(globalThis, {
  document: { documentElement: root, querySelector: () => null },
  window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 0 },
  getComputedStyle: () => ({ getPropertyValue: () => "10 10 12" }),
  localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) },
});

test("an extension's own switch made before the interface declares its default stands over it", async () => {
  const { registerTheme, setThemeAs, setUiDefaultTheme, themesSettled } = await import("../core/web/src/extensions/themes.ts");
  const { chosenPalette, paletteSetBy } = await import("../core/web/src/theme.tsx");
  registerTheme("ui-a", { id: "look", name: "Look A", dark: { accent: "#00ff00" } });
  registerTheme("ext", { id: "own", name: "Own", dark: { accent: "#ff0000" } });
  assert.equal(await setThemeAs("ext", "ext/own", async () => false), true);
  assert.equal(chosenPalette()?.id, "ext/own");
  assert.equal(paletteSetBy(), "extension");
  setUiDefaultTheme("ui-a/look");
  themesSettled();
  assert.equal(chosenPalette()?.id, "ext/own", "the default does not take the switch away");
  assert.equal(paletteSetBy(), "extension");
  assert.equal(kept.get("pithagoras.palette.over"), "ui-a/look", "it is recorded as made over the default that was declared");
  // The interface now declares another default (another interface was chosen): that one comes back.
  setUiDefaultTheme(null);
  assert.equal(chosenPalette(), null);
});
