import test from 'node:test';
import assert from 'node:assert/strict';
import { micError } from '../core/web/src/mic-error.ts';

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

test('a refused, missing or busy microphone says what to do, not what the browser calls it', () => {
  assert.match(micError(named('NotAllowedError', 'Permission denied')), /blocked for this site.*site settings/);
  assert.match(micError(named('NotFoundError', 'Requested device not found')), /No microphone was found/);
  assert.match(micError(named('NotReadableError', 'Could not start audio source')), /another program/);
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError']) {
    assert.doesNotMatch(micError(named(name, 'Permission denied')), /Permission denied|Requested device|Could not start/);
  }
});

test('anything else is shown as it is, and a thing with no words gets some', () => {
  assert.equal(micError(new Error('Transcription failed')), 'Transcription failed');
  assert.match(micError(undefined), /could not be opened/);
  assert.match(micError({}), /could not be opened/);
});
