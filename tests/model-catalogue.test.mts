import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
const { CATALOGUE_TTL_MS, cacheModels, cachedModels, catalogueFresh, forgetModels } = await import('../core/web/src/model-catalogue.ts');

const models = [{ id: 'qwen', name: 'Qwen', provider: 'llama-swap' }] as any[];

test('the cached list is kept until it expires, then it is as if nothing were cached', () => {
  store.clear();
  const at = 1_000_000;
  cacheModels(models, at);
  assert.deepEqual(cachedModels(at + 1000), models);
  assert.equal(catalogueFresh(at + CATALOGUE_TTL_MS - 1), true);
  assert.equal(catalogueFresh(at + CATALOGUE_TTL_MS), false);
  assert.deepEqual(cachedModels(at + CATALOGUE_TTL_MS), [], 'an expired list is not drawn as if it were current');
});

test('a provider changed forgets the list, so the next menu fetches it again', () => {
  store.clear();
  cacheModels(models);
  assert.equal(catalogueFresh(), true);
  forgetModels();
  assert.equal(catalogueFresh(), false);
  assert.deepEqual(cachedModels(), []);
});

test('an empty answer is not cached over a list, and the cache from before expiry existed is removed', () => {
  store.clear();
  store.set('modelCatalogue.v1', JSON.stringify(models));
  assert.deepEqual(cachedModels(), [], 'the old list carries no time, so it could be any age');
  assert.equal(store.has('modelCatalogue.v1'), false);
  cacheModels(models);
  cacheModels([]);
  assert.deepEqual(cachedModels(), models);
  // A cache that cannot be read is no cache, not an error.
  store.set('modelCatalogue.v2', '{not json');
  assert.deepEqual(cachedModels(), []);
});
