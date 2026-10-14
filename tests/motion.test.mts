import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { animationsChosen, fancy, plays, switchIs } from "../core/web/src/motion.ts";

const CSS = fs.readFileSync(path.resolve(import.meta.dirname, "../core/web/src/styles/motion.css"), "utf8");

test("the animations are on until switched off, and the system's reduced motion wins over the switch", () => {
  assert.equal(plays(true, false), true);
  assert.equal(plays(false, false), false);
  // Whatever the switch says.
  assert.equal(plays(true, true), false);
  assert.equal(plays(false, true), false);
});

test("storage that cannot be read reads as on, and nothing plays where there is no page", () => {
  assert.equal(animationsChosen(), true);
  assert.equal(fancy(), false);
});

test("what was chosen on the page holds where storage cannot keep it", () => {
  // Turned off with storage that took nothing: it is off, for as long as the page is.
  assert.equal(switchIs(false, null), false);
  assert.equal(switchIs(true, "off"), true);
  // Nothing chosen here: what storage has, and on where it has nothing.
  assert.equal(switchIs(null, "off"), false);
  assert.equal(switchIs(null, "on"), true);
  assert.equal(switchIs(null, null), true);
});

/** The rules of a style sheet, nested ones (a media query's) with the at-rule they are in. */
function rules(css: string, within = ""): { selector: string; body: string; within: string }[] {
  const out: { selector: string; body: string; within: string }[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (depth > 0 && j < text.length) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0, j++;
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith("@media") || head.startsWith("@supports")) out.push(...rules(body, head));
    else out.push({ selector: head, body, within });
    i = j;
  }
  return out;
}

/** A selector list split at its commas, those inside :is( ) and the like left alone. */
const selectors = (list: string): string[] => {
  const parts: string[] = [];
  let depth = 0, from = 0;
  [...list].forEach((c, i) => {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (c === "," && depth === 0) parts.push(list.slice(from, i)), (from = i + 1);
  });
  return [...parts, list.slice(from)].map((s) => s.trim());
};

test("everything in the extra animations' style sheet waits for the page to say so", () => {
  // The intro and the pictures are only ever put on the page while it does, and `:root` only holds the curves.
  const free = /^(:root|\.app-intro|\[data-ghost\])/;
  const loose = rules(CSS)
    .filter((r) => !r.selector.startsWith("@keyframes"))
    .flatMap((r) => selectors(r.selector))
    .filter((s) => !s.startsWith('[data-motion="fancy"]') && !free.test(s));
  assert.deepEqual(loose, [], "these would move the portal with the animations off");
});

test("what is animated moves things about and never changes how much room they take", () => {
  const room = /^\s*(width|height|min-|max-|top|left|right|bottom|margin|padding|border|font|line-height|gap|flex|grid|inset)/;
  const bad = rules(CSS)
    .filter((r) => r.selector.startsWith("@keyframes"))
    .flatMap((r) => r.body.match(/\{[^}]*\}/g) ?? [])
    .flatMap((step) => step.slice(1, -1).split(";").filter((d) => room.test(d)));
  assert.deepEqual(bad, []);
});

test("every animation the style sheet starts is one it defines", () => {
  const defined = new Set([...CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  // Names from the other sheets are used here too (aside-panel-in): only this file's own are told apart by their prefix.
  const used = [...CSS.matchAll(/animation(?:-name)?:\s*([^;}]*)/g)].flatMap((m) => [...m[1].matchAll(/(?:^|\s)(fx-[\w-]+)/g)].map((n) => n[1]));
  assert.ok(used.length > 20);
  assert.deepEqual([...new Set(used)].filter((n) => !defined.has(n)), []);
});
