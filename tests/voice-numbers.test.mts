import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenNumbers, NUMBER_PACK_LANGUAGES } from '../server/src/voice-numbers.js';

test('numbers are written out per language, identifiers are left alone', () => {
  assert.equal(spokenNumbers('Die RTX 4070 hat 12 GB.', 'de'), 'Die RTX viertausendsiebzig hat zwölf GB.');
  assert.equal(spokenNumbers('Etwa 3,5 Sekunden und 21 Prozent.', 'de'), 'Etwa drei Komma fünf Sekunden und einundzwanzig Prozent.');
  assert.equal(spokenNumbers('The RTX 4070 has 12 GB.', 'en'), 'The RTX four thousand seventy has twelve GB.');
  assert.equal(spokenNumbers('Around 3.5 seconds and 21%.', 'en'), 'Around three point five seconds and twenty-one percent.');
  // Glued to letters, so an identifier rather than a quantity.
  assert.equal(spokenNumbers('Quantised to Q8_0 in v2.', 'en'), 'Quantised to Q8_0 in v2.');
  // Beyond the packs' range the digits stay readable as they are.
  assert.equal(spokenNumbers('Es sind 1234567 Tokens.', 'de'), 'Es sind 1234567 Tokens.');
});

test('each pack reads its own thousands separator as grouping, not as a decimal', () => {
  assert.equal(spokenNumbers('Das kostet 100.000 Euro.', 'de'), 'Das kostet einhunderttausend Euro.');
  assert.equal(spokenNumbers('Preis: 1.999,99 Euro.', 'de'), 'Preis: eintausendneunhundertneunundneunzig Komma neun neun Euro.');
  assert.equal(spokenNumbers('It costs 1,234 dollars.', 'en'), 'It costs one thousand two hundred thirty-four dollars.');
  assert.equal(spokenNumbers('It costs 100.000 dollars.', 'en'), 'It costs one hundred point zero zero zero dollars.');
});

test('dates, clock times, ranges and versions keep their digits', () => {
  assert.equal(spokenNumbers('Am 16.09.2026 um 10:30 Uhr.', 'de'), 'Am 16.09.2026 um 10:30 Uhr.');
  assert.equal(spokenNumbers('Der Build 1.2.3 läuft von 2024-2026.', 'de'), 'Der Build 1.2.3 läuft von 2024-2026.');
  assert.equal(spokenNumbers('Release 1.2.3 on 16/09/2026 at 10:30.', 'en'), 'Release 1.2.3 on 16/09/2026 at 10:30.');
  // A leading zero marks a label rather than a count.
  assert.equal(spokenNumbers('Zimmer 007 bitte.', 'de'), 'Zimmer 007 bitte.');
  assert.equal(spokenNumbers('Es sind 0,5 Sekunden.', 'de'), 'Es sind null Komma fünf Sekunden.');
});

test('a language without a pack keeps its text unchanged', () => {
  assert.deepEqual(NUMBER_PACK_LANGUAGES, ['de', 'en']);
  assert.equal(spokenNumbers('Tokeni 4070 hapa.', 'sw'), 'Tokeni 4070 hapa.');
  assert.equal(spokenNumbers('Tokens 4070 here.', 'auto'), 'Tokens 4070 here.');
});
