import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asksToRepeat, couldAskToRepeat } from '../core/web/src/voice-commands.js';

test('asking to hear it again, in English or German, is recognised', () => {
  for (const said of ['Say that again.', 'Could you repeat that, please?', 'Repeat.', 'What did you just say?', 'Pardon?', 'Once more',
    'Sag das nochmal.', 'Sag das bitte noch einmal!', 'Kannst du das bitte wiederholen?', 'Könntest du das noch mal sagen?', 'Wiederhole das.', 'Wie bitte?', 'Was hast du gerade gesagt?', 'Nochmal bitte.', 'Wiederholen, bitte.']) {
    assert.equal(asksToRepeat(said), true, said);
  }
});

test('a request that only contains those words is for the agent', () => {
  for (const said of ['Say that again but shorter.', 'Repeat the last command in the terminal.', 'Kannst du das nochmal kürzer sagen?', 'Wiederhole den Test.', 'Was hast du gerade im Terminal gesagt, war das ein Fehler?', 'Mach das nochmal.', '', 'Okay.']) {
    assert.equal(asksToRepeat(said), false, said);
  }
});

test('the start of a request to hear it again could still be one; anything else is for the agent at once', () => {
  for (const said of ['Say that again.', 'Could you repeat that, please?', 'Repeat.', 'What did you just say?', 'Pardon?', 'Once more', 'One more time', 'Come again?',
    'Sag das nochmal.', 'Sag das bitte noch einmal!', 'Kannst du das bitte wiederholen?', 'Könntest du das noch mal sagen?', 'Wiederhole das.', 'Wie bitte?', 'Was hast du gerade gesagt?', 'Nochmal bitte.', 'Wiederholen, bitte.',
    'Could you', 'Sag das', '', '...']) {
    assert.equal(couldAskToRepeat(said), true, said);
  }
  for (const said of ['Stop', "Stop, don't touch that file.", 'Say that again but shorter.', 'Wiederhole den Test.', 'Okay.', 'please please please please please please please please please please']) {
    assert.equal(couldAskToRepeat(said), false, said);
  }
});
