import test from "node:test";
import assert from "node:assert/strict";
import { diffViews, findNodes, pinned, renderView, sectionText, textPage } from "../dist/browser/view.js";
import { cleanRef, keyCombo } from "../dist/browser/tools.js";

const vp = { width: 1280, height: 720, scrollY: 0, scrollHeight: 3000 };
const meta = { title: "Test", url: "https://example.test/page" };
const box = (y, height = 20) => ({ x: 0, y, width: 600, height });
const render = (tree, options) => renderView(tree, vp, meta, options);

test("only the viewport and its margin are shown, with what is above and below counted", () => {
  const tree = [
    { role: "main", ref: "e1", box: box(-2000, 5000), children: [
      { role: "heading", name: "Far above", ref: "e2", level: 2, box: box(-1500) },
      { role: "heading", name: "In view", ref: "e3", level: 2, box: box(100) },
      { role: "link", name: "Also in view", ref: "e4", cursor: "pointer", box: box(300) },
      { role: "heading", name: "Far below", ref: "e5", level: 2, box: box(2500) },
      { role: "button", name: "Below too", ref: "e6", box: box(2600) },
    ] },
  ];
  const view = render(tree);
  assert.match(view.text, /^Page: Test — https:\/\/example\.test\/page/);
  assert.match(view.text, /View: 0–720 of 3,000 px/);
  assert.match(view.text, /heading "In view" \[e3\] level=2/);
  assert.match(view.text, /link "Also in view" \[e4\]/);
  assert.doesNotMatch(view.text, /Far above|Far below|Below too/);
  assert.equal(view.above, 1);
  assert.equal(view.below, 2);
  assert.match(view.text, /↓ 2 more below/);
});

test("wrappers that mean nothing are dropped, and a link's URL is shown only when it has no name", () => {
  const tree = [
    { role: "generic", ref: "e1", box: box(0, 200), children: [
      { role: "generic", ref: "e2", box: box(0, 100), children: [
        { role: "link", name: "Pricing", ref: "e3", cursor: "pointer", url: "/pricing?utm=x", box: box(10) },
        { role: "link", ref: "e4", cursor: "pointer", url: "https://cdn.example.test/logo?track=1", box: box(40) },
      ] },
    ] },
  ];
  const view = render(tree);
  assert.doesNotMatch(view.text, /generic/);
  assert.match(view.text, /^link "Pricing" \[e3\]$/m);
  assert.match(view.text, /^link \[e4\] → cdn\.example\.test\/logo$/m);
});

test("links inside a sentence are read in place, spaced as text, without footnote markers", () => {
  const tree = [
    { role: "paragraph", ref: "e1", box: box(0, 60), children: [
      "Before",
      { role: "link", name: "transformer", ref: "e2", cursor: "pointer", box: box(0), children: ["transformer"] },
      "-based models, some",
      { role: "link", name: "language models", ref: "e3", cursor: "pointer", box: box(0), children: ["language models"] },
      "were large",
      { role: "superscript", ref: "e4", box: box(0), children: [{ role: "link", name: "[12]", ref: "e5", cursor: "pointer", box: box(0), children: ["[12]"] }] },
      "(RAG), fine-tuning.",
    ] },
  ];
  const view = render(tree);
  assert.match(view.text, /paragraph: Before transformer\[e2\]-based models, some language models\[e3\] were large \(RAG\), fine-tuning\. \[e1\]/);
  assert.doesNotMatch(view.text, /\[12\]|superscript/);
});

test("long text is cut with a pointer to get_text, and the whole view is capped", () => {
  const long = "word ".repeat(200).trim();
  const many = Array.from({ length: 400 }, (_, i) => ({ role: "button", name: `Button number ${i}`, ref: `e${i + 10}`, box: box(100) }));
  const view = render([{ role: "paragraph", ref: "e1", box: box(0, 40), children: [long] }, ...many], { maxChars: 2000 });
  assert.match(view.text, /\(\+[\d,]+ chars: get_text e1\) \[e1\]/);
  assert.ok(view.text.length < 2600, `capped, got ${view.text.length}`);
  assert.match(view.text, /more in view not shown \(capped\)/);
});

test("a line that only repeats its parent is dropped", () => {
  const tree = [
    { role: "link", name: "100 Go to comments", ref: "e1", cursor: "pointer", box: box(0), children: [
      { role: "generic", ref: "e2", box: box(0), children: ["100"] },
      { role: "generic", ref: "e3", box: box(0), children: ["Go to comments"] },
    ] },
  ];
  const view = render(tree);
  assert.match(view.text, /link "100 Go to comments" \[e1\]/);
  assert.doesNotMatch(view.text, /\[e2\]|\[e3\]/);
});

test("index mode lists only what can be clicked or typed into", () => {
  const tree = [
    { role: "heading", name: "Sign up", ref: "e1", level: 1, box: box(0) },
    { role: "paragraph", ref: "e2", box: box(30), children: ["Tell us about yourself."] },
    { role: "textbox", name: "Name", ref: "e3", box: box(60) },
    { role: "button", name: "Save", ref: "e4", box: box(90) },
  ];
  const view = render(tree, { mode: "index" });
  assert.match(view.text, /textbox "Name" \[e3\]/);
  assert.match(view.text, /button "Save" \[e4\]/);
  assert.doesNotMatch(view.text, /Sign up|Tell us/);
});

test("a diff tells what changed, pairs a renamed element as one change, and gives up when too much did", () => {
  const before = render([
    { role: "textbox", name: "Name", ref: "e1", box: box(0) },
    { role: "button", name: "Save", ref: "e2", box: box(30) },
    { role: "paragraph", ref: "e3", box: box(60), children: ["temporary"] },
  ]);
  const after = render([
    { role: "textbox", name: "Name", ref: "e1", value: "Ada", box: box(0) },
    { role: "button", name: "Saved", ref: "e9", disabled: true, box: box(30) },
    { role: "alert", ref: "e10", box: box(90), children: ["Thanks"] },
  ]);
  const changes = diffViews(before, after);
  assert.ok(changes.some((l) => l.startsWith('~ textbox "Name" [e1]') && l.includes('value="Ada"')), changes.join("\n"));
  assert.ok(changes.some((l) => l === '~ button "Save" [e2]  →  button "Saved" [e9] disabled'), changes.join("\n"));
  assert.ok(changes.includes("+ alert: Thanks [e10]"), changes.join("\n"));
  assert.ok(changes.includes("- paragraph: temporary [e3]"), changes.join("\n"));
  assert.deepEqual(diffViews(after, after), []);
  const huge = render(Array.from({ length: 60 }, (_, i) => ({ role: "button", name: `B${i}`, ref: `e${100 + i}`, box: box(i * 10) })));
  assert.equal(diffViews(before, huge), null);
});

test("what stays pinned through a scroll is not shown again", () => {
  const sidebar = { role: "navigation", name: "Contents", ref: "e1", box: { x: 0, y: 0, width: 200, height: 700 }, children: [
    { role: "link", name: "History", ref: "e2", cursor: "pointer", box: { x: 0, y: 20, width: 100, height: 20 } },
  ] };
  const first = render([sidebar, { role: "paragraph", ref: "e3", box: box(100), children: ["First screen"] }]);
  const second = render([sidebar, { role: "paragraph", ref: "e4", box: box(100), children: ["Second screen"] }]);
  const skip = pinned(first, second, 720);
  assert.deepEqual([...skip], ["e1"]);
  const shown = render([sidebar, { role: "paragraph", ref: "e4", box: box(100), children: ["Second screen"] }], { skip });
  assert.doesNotMatch(shown.text, /History/);
  assert.match(shown.text, /Still on screen and unchanged, not repeated: Contents/);
  assert.match(shown.text, /Second screen/);
  assert.equal(pinned(first, second, 0).size, 0, "nothing is pinned when nothing moved");
});

test("find reaches the whole page and says where each match is", () => {
  const tree = [
    { role: "link", name: "Pricing", ref: "e1", cursor: "pointer", box: box(2000) },
    { role: "heading", name: "Pricing plans", ref: "e2", level: 2, box: box(100) },
    { role: "button", name: "Sign in", ref: "e3", box: box(-500) },
  ];
  const hits = findNodes(tree, "pricing", vp);
  assert.equal(hits.length, 2);
  assert.match(hits[0], /heading "Pricing plans" \[e2\].* — in view$/);
  assert.match(hits[1], /link "Pricing" \[e1\] — 1,280 px below$/);
  assert.match(findNodes(tree, "sign in", vp)[0], /500 px above|480 px above/);
  assert.deepEqual(findNodes(tree, "nothing like this", vp), []);
});

test("a section's text reads as prose and pages with where to continue", () => {
  const section = { role: "article", ref: "e1", children: [
    { role: "heading", name: "Title", level: 2, ref: "e2", children: ["Title"] },
    { role: "paragraph", ref: "e3", children: ["First ", { role: "link", name: "linked", ref: "e4", children: ["linked"] }, " words."] },
    { role: "list", ref: "e5", children: [{ role: "listitem", ref: "e6", children: ["one"] }, { role: "listitem", ref: "e7", children: ["two"] }] },
  ] };
  const text = sectionText(section);
  assert.match(text, /## Title/);
  assert.match(text, /First linked words\./);
  assert.match(text, /- one\n+- two/);
  const page = textPage("x".repeat(5000), "e1", 0, 2000);
  assert.match(page, /\(chars 0–2,000 of 5,000; get_text e1 offset=2000 for more\)$/);
  assert.match(textPage("x".repeat(5000), "e1", 4000, 2000), /end of text\)$/);
  assert.equal(textPage("short", "e1"), "short");
});

test("refs are read however they are written, and nothing else is taken for one", () => {
  for (const raw of ["e12", "[e12]", "ref=e12", " aria-ref=e12 "]) assert.equal(cleanRef(raw), "e12");
  assert.equal(cleanRef("f1e7"), "f1e7");
  assert.throws(() => cleanRef("#submit"), /not a ref/);
  assert.throws(() => cleanRef("button.primary"), /not a ref/);
});

test("key combinations are spelled as Playwright wants them", () => {
  assert.equal(keyCombo("cmd+l"), "Meta+l");
  assert.equal(keyCombo("ctrl+shift+T"), "Control+Shift+T");
  assert.equal(keyCombo("enter"), "Enter");
  assert.equal(keyCombo("Escape"), "Escape");
});
