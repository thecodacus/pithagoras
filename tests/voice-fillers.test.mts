import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimSilence } from '../web/src/voice-fillers.js';
import { PHRASES, fillerPhrases, phraseLanguage } from '../server/src/voice-phrases.js';
import { slowFiller, toolKind } from '../web/src/tool-kind.js';

test('fillers lose TTS padding but keep a short natural onset and tail', () => {
  const samples = new Float32Array(1000); samples.fill(0.5, 400, 600);
  const trimmed = trimSilence(samples, 1000, 0.01, 50);
  assert.equal(trimmed.length, 300);
  assert.equal(trimmed[50], 0.5); assert.equal(trimmed[0], 0);
  assert.equal(trimSilence(new Float32Array(100), 1000).length, 0);
});

test('every phrase language covers every filler and notice', () => {
  const kinds = ['ackQuestion', 'ackRequest', 'slowCommand', 'slowTests', 'slowInstall', 'slowBuild', 'slowBrowser', 'slowSearch', 'slow', 'toolFailed', 'toolDone', 'still'];
  for (const [language, table] of Object.entries(PHRASES)) {
    const clips = fillerPhrases(language);
    assert.deepEqual(new Set(clips.map(clip => clip.kind)), new Set(kinds), language);
    assert.ok(clips.every(clip => clip.text.trim() && clip.text.length <= 60), language);
    // Chatterbox says a lone word such as "Okay." twice.
    assert.ok(clips.every(clip => !/^\p{L}+[.!。]$/u.test(clip.text) || !/\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Arabic}/u.test(clip.text)), language);
    assert.ok(table.think.length && table.compacting.length && table.compactionWait && table.compactionDone && table.compactionStopped, language);
  }
  // Acknowledgements render first: they play in every turn.
  assert.deepEqual(fillerPhrases('de').slice(0, 2).map(clip => clip.kind), ['ackRequest', 'ackQuestion']);
});

test('filler language: configured first, then the client, never guessed wording', () => {
  assert.equal(phraseLanguage('fr', ['de-DE']), 'fr');
  assert.equal(phraseLanguage('auto', ['xx', 'de-AT', 'en']), 'de');
  assert.equal(phraseLanguage(undefined, []), 'en');
  assert.deepEqual(fillerPhrases('ta'), []);
});

test('tool calls are grouped by what a listener hears about', () => {
  assert.equal(toolKind({ toolName: 'bash' }), 'command');
  assert.equal(toolKind({ toolName: 'mcp', input: { tool: 'browser_click' } }), 'browser');
  assert.equal(toolKind({ toolName: 'read' }), 'read');
  assert.equal(toolKind({ toolName: 'edit' }), 'edit');
  assert.equal(toolKind({ toolName: 'todo' }), 'tool');
  assert.equal(slowFiller({ toolName: 'bash', input: { command: 'npm test -- --watch=false' } }), 'slowTests');
  assert.equal(slowFiller({ toolName: 'bash', input: { command: 'pnpm add zod' } }), 'slowInstall');
  assert.equal(slowFiller({ toolName: 'bash', input: { command: 'cargo build --release' } }), 'slowBuild');
  assert.equal(slowFiller({ toolName: 'bash', input: { command: 'sleep 10' } }), 'slowCommand');
  assert.equal(slowFiller({ toolName: 'browser_navigate' }), 'slowBrowser');
  assert.equal(slowFiller({ toolName: 'edit' }), 'slow');
});
