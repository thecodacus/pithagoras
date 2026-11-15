import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { CONTRACT_VERSION, FEATURES, has, refusal, takes } from '../core/web/src/extensions/contract.ts';
import { addLocale, setLanguage } from '../core/web/src/i18n.ts';
import de from '../core/web/src/locales/de.ts';

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

test('a range is read whole before it is matched: an alternative that takes the version does not hide one that is not a range', () => {
  for (const range of ['^1.0 || not-a-range', '>=2 nonsense', '^1.0 || >=2 nonsense', '* || ~']) {
    assert.equal(takes(range, '1.0.0'), null, range);
    assert.equal(semver.validRange(range), null, `semver reads "${range}"`);
  }
  // What the server passes on of a declaration over 100 characters: cut, and marked so that it is not read.
  const long = `^1.0 || ${'^2.0 || '.repeat(20)}`;
  const cut = `${long.slice(0, 100)}…`;
  assert.equal(takes(cut, '1.0.0'), null);
  assert.match(refusal(cut, '1.0.0')!, /not a version range this portal reads/);
});

test('an extension that needs a newer contract is refused with the numbers, and one that needs nothing or what there is is not', () => {
  assert.equal(refusal(undefined), undefined);
  assert.equal(refusal('^1.0'), undefined);
  assert.equal(refusal(`^${CONTRACT_VERSION}`), undefined);
  assert.equal(refusal('^1.2', '1.0.0'), 'Needs interface API ^1.2; this portal has 1.0.0');
  assert.equal(refusal('^2.0', '1.4.0'), 'Needs interface API ^2.0; this portal has 1.4.0');
  assert.match(refusal('latest')!, /not a version range this portal reads/);
});

test('an extension that declares nothing is taken as ^1.0: a contract that breaks it refuses it, with the numbers', () => {
  assert.equal(refusal(undefined, '1.7.0'), undefined);
  assert.equal(refusal(undefined, '2.0.0'), 'Needs interface API ^1.0; this portal has 2.0.0');
  assert.equal(refusal(undefined, '0.9.0'), 'Needs interface API ^1.0; this portal has 0.9.0');
});

test('the reason an extension is refused is said in the page\'s language', () => {
  addLocale(de);
  setLanguage('de');
  try {
    assert.equal(refusal('^2.0', '1.0.0'), 'Benötigt die Oberflächen-API ^2.0; dieses Portal hat 1.0.0');
    assert.match(refusal('latest')!, /^Die package\.json nennt die benötigte Oberflächen-API als "latest"/);
  } finally {
    setLanguage('en');
  }
  assert.equal(refusal('^2.0', '1.0.0'), 'Needs interface API ^2.0; this portal has 1.0.0');
});

test('every action the contract names is in the guide, with what it resolves where that is not obvious', () => {
  const types = readFileSync(path.resolve(import.meta.dirname, '../packages/extension-api/index.d.ts'), 'utf8');
  for (const name of ['SessionActions', 'ChatController', 'ComposerActions']) {
    const body = types.match(new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
    assert.ok(body, `${name} is in the types`);
    // Members at the interface's own level: `  name(` or `  readonly name`.
    for (const [, member] of body.matchAll(/^ {2}(?:readonly )?(\w+)[(:]/gm)) {
      assert.ok(guide.includes(member), `${name}.${member} is not in the guide`);
    }
  }
});
