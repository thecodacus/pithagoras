import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesLabel, slugify } from '../core/web/src/projects.js';
import { slugify as serverSlugify } from '../core/server/src/slug.js';

test('the New project preview is made by the server\'s own slugify, not a copy that can drift', () => {
  assert.equal(slugify, serverSlugify);
});

test('a size reads in B, KB, MB or GB', () => {
  assert.equal(bytesLabel(0), '0 B');
  assert.equal(bytesLabel(1023), '1023 B');
  assert.equal(bytesLabel(1536), '1.5 KB');
  assert.equal(bytesLabel(5 * 1024 ** 2), '5.0 MB');
  assert.equal(bytesLabel(3 * 1024 ** 3), '3.0 GB');
});
