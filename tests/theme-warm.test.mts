import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { packageKinds, packageThemes } from "../server/src/extension-ui.ts";
import { coloursOf, TOKENS } from "../web/src/theme.tsx";

/**
 * The Warm theme, a package with nothing but colours: that the portal takes it whole, in light and in dark, and
 * that its text is readable on every surface it sits on. WCAG asks 4.5:1 of text and 3:1 of a mark such as the focus ring.
 */

const dir = path.resolve(import.meta.dirname, "../extensions/theme-warm");
const warm = packageThemes(dir)!;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** A row's hover tint (the text colour over a raised surface at a twentieth), which a hint on it is read against. */
const tint = (over: Rgb, under: Rgb): Rgb => under.map((u, i) => Math.round(over[i] * 0.05 + u * 0.95)) as Rgb;

test("the package loads as a theme and brings a light and a dark variant", () => {
  assert.equal(warm.name, "pithagoras-theme-warm");
  assert.deepEqual(warm.themes.map((t) => [t.id, t.name]), [["warm", "Warm"]]);
  assert.deepEqual(packageKinds(dir), ["themes"], "no code, so nothing for pi");
  const [theme] = warm.themes;
  assert.ok(coloursOf(theme.dark) && coloursOf(theme.light), "every colour is one the portal has a name for");
  assert.deepEqual(Object.keys(theme.dark!).sort(), [...TOKENS].sort(), "every colour of the portal's, in dark");
  for (const token of TOKENS.filter((t) => !t.startsWith("terminal"))) assert.ok(theme.light![token], `${token} in light`);
});

for (const variant of ["dark", "light"] as const) {
  const t = Object.fromEntries(Object.entries(warm.themes[0][variant]!).map(([k, v]) => [k, rgb(v)])) as Record<string, Rgb>;
  const surfaces: Record<string, Rgb> = { canvas: t.canvas, surface: t.surface, raised: t.raised, "a hovered row": tint(t.fg, t.raised) };
  const plain = { canvas: t.canvas, surface: t.surface, raised: t.raised };

  test(`${variant}: text tones are at least 4.5:1 on every surface and a hovered row`, () => {
    for (const tone of ["fg", "fg-muted", "fg-subtle", "fg-faint"]) {
      for (const [on, bg] of Object.entries(surfaces)) assert.ok(ratio(t[tone], bg) >= 4.5, `${tone} on ${on} is ${ratio(t[tone], bg).toFixed(2)}:1`);
    }
  });
  test(`${variant}: the tones keep their order, the quietest still the faintest`, () => {
    const against = (tone: string) => ratio(t[tone], t.surface);
    assert.ok(against("fg") > against("fg-muted") && against("fg-muted") > against("fg-subtle") && against("fg-subtle") > against("fg-faint"));
  });
  test(`${variant}: ok, warn and danger read as text on the surfaces`, () => {
    for (const tone of ["ok", "warn", "danger"]) {
      for (const [on, bg] of Object.entries(plain)) assert.ok(ratio(t[tone], bg) >= 4.5, `${tone} on ${on} is ${ratio(t[tone], bg).toFixed(2)}:1`);
    }
  });
  test(`${variant}: the accent is a focus mark of 3:1 on every surface, text of 4.5:1 on the page, and carries its own text`, () => {
    for (const [on, bg] of Object.entries(surfaces)) assert.ok(ratio(t.accent, bg) >= 3, `the accent on ${on} is ${ratio(t.accent, bg).toFixed(2)}:1`);
    for (const on of ["canvas", "surface"]) assert.ok(ratio(t.accent, t[on]) >= 4.5, `the accent on ${on} is ${ratio(t.accent, t[on]).toFixed(2)}:1`);
    assert.ok(ratio(t["accent-fg"], t.accent) >= 4.5, `accent-fg on the accent is ${ratio(t["accent-fg"], t.accent).toFixed(2)}:1`);
  });
}

test("the terminal's text is readable on the terminal", () => {
  const dark = warm.themes[0].dark!;
  assert.ok(ratio(rgb(dark["terminal-fg"]), rgb(dark.terminal)) >= 4.5);
});
