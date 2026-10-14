import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addLocale, labelOf, setLanguage } from '../core/web/src/i18n.js';
import { shellOutcome } from '../core/web/src/components/ChatActivity.tsx';
import { VoiceProfile } from '../core/web/src/components/VoiceProfile.tsx';
import { speechChunks } from '../core/web/src/voice.js';
import { TRACE_STATUS } from '../core/web/src/voice-profile.js';

// Words the code puts on the page or into speech itself: each goes through the language the portal is in.
// tsx draws the components' JSX the classic way, which finds React as a global; the web build does not need that.
(globalThis as any).React = React;

/** Runs `body` in a language that says every one of `texts` with `xx: ` before it, and puts the language back. */
async function inTestLanguage(texts: string[], body: () => void | Promise<void>) {
  addLocale({ code: 'xx', name: 'Test', strings: Object.fromEntries(texts.map((text) => [text, `xx: ${text}`])) });
  setLanguage('xx');
  try {
    await body();
  } finally {
    setLanguage('system');
  }
}

test('a call that was cut off says so in the language of the page', async () => {
  assert.deepEqual(shellOutcome('error', '', true), { label: 'interrupted', tone: 'warn' });
  await inTestLanguage(['interrupted'], () => assert.deepEqual(shellOutcome('error', '', true), { label: 'xx: interrupted', tone: 'warn' }));
});

test('the sentence that stands for a code block is said in the language of the page', async () => {
  const text = 'Before. ```js\nsecret()\n``` After.';
  assert.deepEqual(speechChunks(text), ['Before. Code is shown in the transcript. After.']);
  await inTestLanguage(['Code is shown in the transcript.'], () => assert.deepEqual(speechChunks(text), ['Before. xx: Code is shown in the transcript. After.']));
});

test('the profiler says how a turn ended in words, and one it does not know as it was recorded', async () => {
  const panel = (status: string) => renderToStaticMarkup(React.createElement(VoiceProfile, { profiler: { traces: [{ id: 3, started: 0, marks: [], status }] } as any, onClose: () => {} }));
  assert.match(panel('vad_misfire'), /Turn 3 · voice detection misfired/);
  assert.match(panel('from_a_newer_portal'), /Turn 3 · from_a_newer_portal/);
  await inTestLanguage(Object.values(TRACE_STATUS), () => {
    assert.match(panel('vad_misfire'), /Turn 3 · xx: voice detection misfired/);
    assert.equal(labelOf(TRACE_STATUS, 'interrupted'), 'xx: interrupted');
  });
});
