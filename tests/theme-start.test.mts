import test from "node:test";
import assert from "node:assert/strict";

/**
 * The start of a page whose browser kept an extension's switch (made over the interface's default) or the default
 * itself, with the themes registered before the interface says what its default is. In a file of its own: the page's
 * storage is filled before the modules are loaded, as the browser has it at a start.
 */

const kept = new Map<string, string>();
const root = { dataset: { theme: "dark" } as Record<string, string>, classList: { add() {}, remove() {} }, style: { setProperty() {}, removeProperty() {} } };
Object.assign(globalThis, {
  document: { documentElement: root, querySelector: () => null },
  window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout: () => 0 },
  getComputedStyle: () => ({ getPropertyValue: () => "10 10 12" }),
  localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) },
});
const palette = (id: string, name: string, accent: string) => JSON.stringify({ id, name, light: {}, dark: { accent }, });

test("a theme that registers before the interface declares its default does not take away what the browser kept", async () => {
  // An extension's own theme chosen over the interface's default, kept as such.
  kept.set("pithagoras.palette", palette("ext-pkg/own", "Own", "#ff0000"));
  kept.set("pithagoras.palette.by", "extension");
  kept.set("pithagoras.palette.over", "ui-a/look");
  const { registerTheme, setUiDefaultTheme, themesSettled } = await import("../core/web/src/extensions/themes.ts");
  const { chosenPalette, paletteSetBy } = await import("../core/web/src/theme.tsx");
  try {
    assert.equal(chosenPalette()?.id, "ext-pkg/own", "the kept theme is the one in effect at the start");
    registerTheme("ext-pkg", { id: "own", name: "Own", dark: { accent: "#ff0000" } });
    assert.equal(chosenPalette()?.id, "ext-pkg/own", "a theme registering first does not take it away");
    registerTheme("ui-a", { id: "look", name: "Look A", dark: { accent: "#00ff00" } });
    assert.equal(chosenPalette()?.id, "ext-pkg/own", "nor does the interface's own theme, before it has said it is its default");
    assert.equal(paletteSetBy(), "extension");
    setUiDefaultTheme("ui-a/look");
    themesSettled();
    assert.equal(chosenPalette()?.id, "ext-pkg/own", "the switch stands over the same default, as it was made");
    assert.equal(paletteSetBy(), "extension");
    assert.equal(kept.get("pithagoras.palette.over"), "ui-a/look");
  } finally {
    setUiDefaultTheme(null);
  }
});
