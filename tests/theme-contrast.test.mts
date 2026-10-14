import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * The text tones and the colour of the focus mark, read from index.css, against the surfaces they are drawn on:
 * WCAG asks 4.5:1 of text and 3:1 of the mark that shows where the focus is.
 */

const css = fs.readFileSync(path.resolve(import.meta.dirname, "../core/web/src/index.css"), "utf8");

/** The tokens of one theme: `--name: r g b;` inside the block that starts at `open`. */
function tokens(open: RegExp): Record<string, [number, number, number]> {
  const start = css.search(open);
  assert.ok(start >= 0, `no block for ${open}`);
  const block = css.slice(start, css.indexOf("}", start));
  const found: Record<string, [number, number, number]> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(\d+) (\d+) (\d+);/g)) found[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return found;
}

const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `over` laid on `under` at `alpha`: a row's hover tint (bg-fg/5 and bg-fg/10), which a hint on it is read against. */
const tint = (over: number[], under: number[], alpha: number) => under.map((u, i) => Math.round(over[i] * alpha + u * (1 - alpha)));

const themes = { dark: tokens(/\[data-theme="dark"\]\s*\{/), light: tokens(/\[data-theme="light"\]\s*\{/) };
/** The first block is `:root, [data-theme="dark"]`, which has the dark tokens too. */
assert.ok(themes.dark["fg-faint"] && themes.light["fg-faint"]);

for (const [name, t] of Object.entries(themes)) {
  const surfaces: Record<string, number[]> = {
    canvas: t.canvas,
    surface: t.surface,
    raised: t.raised,
    // A hovered row: the text colour laid over a raised surface at a twentieth.
    "a hovered row": tint(t.fg, t.raised, 0.05),
  };
  for (const tone of ["fg-muted", "fg-subtle", "fg-faint"]) {
    test(`${name}: ${tone} text is at least 4.5:1 on every surface`, () => {
      for (const [on, bg] of Object.entries(surfaces)) {
        const got = ratio(t[tone], bg);
        assert.ok(got >= 4.5, `${tone} on ${on} is ${got.toFixed(2)}:1`);
      }
    });
  }
  test(`${name}: the tones keep their order, the quietest still the faintest`, () => {
    const against = (tone: string) => ratio(t[tone], t.surface);
    assert.ok(against("fg") > against("fg-muted") && against("fg-muted") > against("fg-subtle") && against("fg-subtle") > against("fg-faint"));
  });
  test(`${name}: the focus mark, the accent in full, is at least 3:1 on every surface`, () => {
    for (const [on, bg] of Object.entries(surfaces)) assert.ok(ratio(t.accent, bg) >= 3, `the accent on ${on} is ${ratio(t.accent, bg).toFixed(2)}:1`);
  });
}

test("the focus ring is the accent in full, not a tint of it", () => {
  const rule = css.match(/:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /outline:\s*2px solid rgb\(var\(--accent\)\)\s*;/);
});
