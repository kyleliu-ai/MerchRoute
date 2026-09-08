import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register(new URL('./helpers/stub-loader.mjs', import.meta.url), {
  data: { sourceRoot: new URL('../src/', import.meta.url).href, stubs: {
    'fixture-harness': 'export const read = () => globalThis.__loaderHarness.value;',
  } },
});
test('Node 20 loader preserves TypeScript chaining and main-thread mutable harness', async () => {
  (globalThis as any).__loaderHarness = { value: 4 };
  const specifier = 'fixture-harness';
  const fixture = await import(specifier);
  assert.equal(fixture.read(), 4);
  (globalThis as any).__loaderHarness.value = 7;
  assert.equal(fixture.read(), 7);
  const service = '@/api/services/image-task-ledger.ts';
  const ledger = await import(service);
  assert.equal(ledger.MAX_IMAGE_BATCH_TASKS, 7);
  assert.equal(ledger.MAX_GENERATION_CONCURRENCY, 5);
  delete (globalThis as any).__loaderHarness;
});
