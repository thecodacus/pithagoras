import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displaySpeechText, speechChunks, StreamingSpeech } from '../core/web/src/voice.js';
import { buildTranscript } from '../core/web/src/transcript.js';
test('speech cues stay in TTS input but disappear from display including partial streamed tags', () => {
 const text = '(laugh) Hello. (cough) Excuse me. (clears throat) Ready. (sigh) Yes.';
 assert.equal(displaySpeechText(text, true), 'Hello. Excuse me. Ready. Yes.');
 assert.ok(speechChunks(text)[0].includes('(laugh)'));
 assert.equal(displaySpeechText('Hello. (cle', false), 'Hello.');
 assert.equal(displaySpeechText('Hello (for now)', true), 'Hello (for now)');
});
test('only responses to audio-marked requests get display filtering', () => {
 const events = [
  {seq:1,type:'portal_prompt',payload:{message:'Hello',voice:true}},
  {seq:2,type:'message_update',payload:{assistantMessageEvent:{type:'text_delta',delta:'(laugh) Hi.'}}},
  {seq:3,type:'portal_prompt',payload:{message:'Explain the tag'}},
  {seq:4,type:'message_update',payload:{assistantMessageEvent:{type:'text_delta',delta:'Use (laugh).'}}},
 ] as any;
 const items = buildTranscript(events);
 assert.equal(items[1].audio, true); assert.equal(items[3].audio, false);
 assert.equal(items[1].text, '(laugh) Hi.');
});

/** What the TTS is sent for `text` as one reply, delivered whole or `step` characters at a time. */
function phrases(text: string, step = 0): string[] {
 const speech = new StreamingSpeech(0), spoken: string[] = [];
 const reply = (part: string, done: boolean) => [{ kind: 'assistant' as const, id: 'a1', text: part, thinking: '', done }];
 if (step) for (let n = step; n < text.length; n += step) spoken.push(...speech.observe(reply(text.slice(0, n), false)));
 spoken.push(...speech.observe(reply(text, true)));
 return spoken;
}
test('German and English abbreviations and ordinals do not end a spoken phrase', () => {
 for (const step of [0, 5]) {
  const sentences = [
   'Das kostet ca. 20 Euro, bzw. etwa so viel wie vorher.',
   'Wir brauchen z. B. Äpfel und z.B. Birnen, d. h. Obst, Nüsse u. a. Dinge.',
   'Siehe Nr. 5 und vgl. Abb. 3, ggf. evtl. inkl. Versand.',
   'Das Treffen ist am 3. November um zehn Uhr, danach gibt es Essen.',
   'Er kam am 1. dann am 2. und wieder am 3. mit dem Zug an.',
   'Mr. Smith and Dr. Meyer said so, e.g. in the first half of the year.',
  ];
  assert.deepEqual(phrases(sentences.join(' '), step), sentences);
 }
});
test('words that only end like an abbreviation, and real sentence ends, still cut', () => {
 const text = 'Das ist ein Gebiet. Er mag die Oma. Wir haben 3 Äpfel. Danach gehen wir heim.';
 assert.deepEqual(phrases(text), ['Das ist ein Gebiet.', 'Er mag die Oma.', 'Wir haben 3 Äpfel.', 'Danach gehen wir heim.']);
 assert.deepEqual(phrases('I have 3 apples. Then I leave now. Is that really so? Yes, it is so.', 4), ['I have 3 apples.', 'Then I leave now.', 'Is that really so?', 'Yes, it is so.']);
});
test('a long sentence is cut at its last comma before 220 characters', () => {
 const head = 'Das ist ein sehr langer Satz mit vielen Wörtern, der immer weiter geht und kein Ende findet, weil er einfach nicht aufhört';
 const text = `${head}, während wir noch mehr Wörter hinzufügen um die Grenze zu überschreiten, und noch ein paar mehr Wörter am Ende ohne Punkt`;
 const cut = text.indexOf('überschreiten,') + 'überschreiten,'.length;
 assert.ok(cut < 220 && text.indexOf(' ', 220) > cut);
 for (const step of [0, 9]) assert.deepEqual(phrases(text, step), [text.slice(0, cut), text.slice(cut + 1)]);
 // Without any comma or colon it falls back to the first space past the limit, as before.
 const plain = 'wort '.repeat(60).trim();
 const space = plain.indexOf(' ', 220);
 assert.deepEqual(phrases(plain), [plain.slice(0, space), plain.slice(space + 1)]);
 // A semicolon and a colon pause like a comma; a colon inside a time does not.
 const colon = `${'wort '.repeat(30)}um 12:30 Uhr sagte er: ${'noch '.repeat(30)}`.trim();
 assert.equal(phrases(colon)[0], `${'wort '.repeat(30)}um 12:30 Uhr sagte er:`);
});
