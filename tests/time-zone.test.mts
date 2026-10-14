import test from 'node:test';
import assert from 'node:assert/strict';
import { serverTimeZone } from '../core/server/src/time-zone.ts';

const withTz = (tz: string | undefined, fn: () => void) => {
  const had = process.env.TZ;
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (had === undefined) delete process.env.TZ;
    else process.env.TZ = had;
  }
};

test('the zone of the server clock is the one TZ names', () => {
  withTz('Europe/Berlin', () => assert.equal(serverTimeZone(), 'Europe/Berlin'));
  withTz('America/New_York', () => assert.equal(serverTimeZone(), 'America/New_York'));
});

test('a clock with no zone is UTC, as the hours on it are, and not "Etc/Unknown"', () => {
  // Compose passes `TZ=` through as an empty string when nobody set one.
  withTz('', () => {
    assert.equal(new Date('2026-10-04T12:00:00Z').getHours(), 12);
    assert.equal(serverTimeZone(), 'UTC');
  });
  withTz('UTC', () => assert.equal(serverTimeZone(), 'UTC'));
});
