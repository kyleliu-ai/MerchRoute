import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from './store.js';

describe('StateStore observers', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('notifies active observers only after a persisted update', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-state-observer-'));
    roots.push(root);
    const store = new StateStore(root);
    await store.initialize();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => { notifications += 1; });

    await store.update((db) => { db.appEvents = []; });
    expect(notifications).toBe(1);

    unsubscribe();
    await store.update((db) => { db.appEvents = []; });
    expect(notifications).toBe(1);
  });
});
