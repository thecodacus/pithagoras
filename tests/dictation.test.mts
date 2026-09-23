import assert from "node:assert/strict";
import test from "node:test";
import { cleanTranscript, insertAtCaret } from "../web/src/dictation.ts";

test("silence notes from Whisper are not text", () => {
  for (const note of ["[BLANK_AUDIO]", " (silence) ", "[Music]", "[BLANK_AUDIO] [BLANK_AUDIO]", "(laughs) [applause]"]) {
    assert.equal(cleanTranscript(note), "", note);
  }
});

test("words are kept, brackets inside a sentence included", () => {
  assert.equal(cleanTranscript("  hello there "), "hello there");
  assert.equal(cleanTranscript("see (a) below"), "see (a) below");
  assert.equal(cleanTranscript("[BLANK_AUDIO] and then"), "[BLANK_AUDIO] and then");
});

test("dictating into an empty box adds no spaces", () => {
  assert.deepEqual(insertAtCaret("", 0, 0, "hello"), { value: "hello", caret: 5 });
});

test("a phrase after a word gets a space, and the next one continues after it", () => {
  const first = insertAtCaret("write a test", 12, 12, "for the parser");
  assert.equal(first.value, "write a test for the parser");
  const second = insertAtCaret(first.value, first.caret, first.caret, "please");
  assert.equal(second.value, "write a test for the parser please");
});

test("no space is added after a newline or before one", () => {
  assert.equal(insertAtCaret("line one\n", 9, 9, "line two").value, "line one\nline two");
  assert.equal(insertAtCaret("a\nb", 1, 1, "x").value, "a x\nb");
});

test("in the middle of a sentence the caret follows the words and the existing space stays after it", () => {
  const out = insertAtCaret("fix the bug", 7, 7, "annoying");
  assert.equal(out.value, "fix the annoying bug");
  assert.equal(out.caret, "fix the annoying".length);
});

test("a selection is replaced", () => {
  assert.equal(insertAtCaret("fix the old bug", 8, 11, "new").value, "fix the new bug");
});

test("a caret outside the text is pulled back to it", () => {
  assert.deepEqual(insertAtCaret("ab", 40, 50, "c"), { value: "ab c", caret: 4 });
});
