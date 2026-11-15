import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { CONTRACT_VERSION, FEATURES, has, refusal, takes } from '../core/web/src/extensions/contract.ts';

const guide = readFileSync(path.resolve(import.meta.dirname, '../docs/guide/data-contract.md'), 'utf8');

test('the contract version is a plain semver number, and the guide has a row for it', () => {
  assert.ok(semver.valid(CONTRACT_VERSION) && semver.clean(CONTRACT_VERSION) === CONTRACT_VERSION && !semver.prerelease(CONTRACT_VERSION));
  assert.match(guide, new RegExp(`^\\| ${CONTRACT_VERSION.replaceAll('.', '\\.')} \\|`, 'm'));
});

test('every feature the portal names is in the guide, and `has` knows exactly those', () => {
  for (const feature of FEATURES) {
    assert.ok(has(feature));
    assert.ok(guide.includes(`\`${feature}\``), `${feature} is not in the guide`);
  }
  assert.ok(!has('data.nothing') && !has('') && !has('parts.wrap'));
  assert.equal(new Set(FEATURES).size, FEATURES.length);
});

test('a range is read as the semver package reads it, for the ranges an extension names the API by', () => {
  const ranges = [
    '^1.0', '^1.0.0', '^1.2', '^1.2.3', '^1', '^0.2.3', '^0.0.3', '^0.0', '^0', '~1.0', '~1.0.0', '~1.2.3', '~1', '1', '1.x', '1.0.x', '1.*', '*', 'x', '',
    '1.0.0', '=1.0.0', '1.0', '>=1.0', '>=1.0.0', '>=1.1', '>1.0', '>1.0.0', '>1', '<2', '<1', '<=1.0', '<=1', '<1.0.1', '>=1.0 <2', '>=1.1 <2', '>= 1.0', '^1.0 || ^2.0', '^2 || ^3', '^1.1 || ^0.5', '1.1.x', '^1.0.0 ',
  ];
  const versions = ['0.0.3', '0.1.0', '0.2.3', '0.5.0', '0.9.9', '1.0.0', '1.0.1', '1.0.9', '1.1.0', '1.2.3', '1.9.0', '2.0.0', '2.1.0', '3.0.0'];
  for (const range of ranges) {
    for (const version of versions) {
      assert.equal(takes(range, version), semver.satisfies(version, range), `${version} against "${range}"`);
    }
  }
});

test('what is not a range is told apart from a range that takes nothing', () => {
  for (const range of ['latest', '^', '1.0.0 - 2.0.0', '>=1.0.0-beta', 'one', '1.0.0.0', '~', '>>1']) assert.equal(takes(range, '1.0.0'), null, range);
  assert.equal(takes('^2.0', '1.0.0'), false);
  // A prerelease of the contract is not a version it has.
  assert.equal(takes('^1.0', '1.0.0-beta'), null);
});

test('an extension that needs a newer contract is refused with the numbers, and one that needs nothing or what there is is not', () => {
  assert.equal(refusal(undefined), undefined);
  assert.equal(refusal('^1.0'), undefined);
  assert.equal(refusal(`^${CONTRACT_VERSION}`), undefined);
  assert.equal(refusal('^1.2', '1.0.0'), 'Needs interface API ^1.2; this portal has 1.0.0');
  assert.equal(refusal('^2.0', '1.4.0'), 'Needs interface API ^2.0; this portal has 1.4.0');
  assert.match(refusal('latest')!, /not a version range this portal reads/);
});
