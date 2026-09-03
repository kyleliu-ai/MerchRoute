import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../repositories/store.js';
import { VariantMediaDeliveryService } from './index.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('merchroute-terminal-fault-')) throw Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-terminal-fault-')); roots.push(root);
  const source = path.join(root, 'source'), archive = path.join(root, 'archive');
  await Promise.all([source, archive].map((folder) => mkdir(folder)));
  await writeFile(path.join(source, 'second.png'), Buffer.alloc(2048, 2));
  await writeFile(path.join(source, 'first.png'), Buffer.alloc(2048, 1));
  const images = await Promise.all(['second.png', 'first.png'].map(async (name) => {
    const info = await stat(path.join(source, name));
    return { relativePath: name, fileName: name, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString() };
  }));
  const stage: any = { id: 'E005', enabled: true, approvedArchiveRoot: archive, outputRoot: path.join(root, 'wb', 'inbox', '<SKU>', 'variants') };
  const input: any = { submissionId: 'stable-terminal-id', platform: 'WB', stage, task: { taskId: 'task', stageId: 'E005', sourceFolder: source, sourceFolderName: 'fixture', images }, selectedRelativePaths: ['second.png', 'first.png'], productSku: '0000001', productName: 'fixture', variantId: 'variant', variantName: 'black' };
  const store = new StateStore(path.join(root, 'data')); await store.initialize();
  const service = new VariantMediaDeliveryService({} as any, undefined, store);
  return { root, input, store, service };
}
describe('terminal manifest recovery', () => {
  it('reconciles a directory renamed before manifest save without changing submission identity', async () => {
    const f = await fixture();
    const original = (f.service as any).updateManifest.bind(f.service);
    (f.service as any).updateManifest = async () => { throw Error('manifest interrupted'); };
    await expect(f.service.deliver(f.input)).rejects.toThrow('manifest interrupted');
    expect(f.store.section('deliveryCheckpoints')![0]!.phase).toBe('NEEDS_ATTENTION');
    (f.service as any).updateManifest = original;
    await rm(f.input.task.sourceFolder, { recursive: true, force: true });
    const result = await f.service.deliver(f.input);
    expect(result).toMatchObject({ submissionId: 'stable-terminal-id', status: 'SUCCESS' });
    const manifest = JSON.parse(await readFile(result.mediaManifestPath!, 'utf8'));
    expect(manifest.assets.map((row: any) => [row.submissionId, row.sortOrder])).toEqual([['stable-terminal-id', 0], ['stable-terminal-id', 1]]);
    expect(f.store.section('deliveryOutbox')).toHaveLength(1);
    expect((await f.service.deliver(f.input)).submissionId).toBe(result.submissionId);
    expect(f.store.section('submissionHistory')).toHaveLength(1);
  });
  it('does not recreate files when both staging and unacknowledged target disappeared', async () => {
    const f = await fixture();
    (f.service as any).updateManifest = async () => { throw Error('before manifest'); };
    await expect(f.service.deliver(f.input)).rejects.toThrow();
    const checkpoint = f.store.section('deliveryCheckpoints')![0]!;
    await rename(checkpoint.targetFinal, path.join(f.root, 'consumed'));
    const next = new VariantMediaDeliveryService({} as any, undefined, f.store);
    await expect(next.deliver(f.input)).rejects.toMatchObject({ record: { errorCode: 'DELIVERY_OUTCOME_UNKNOWN' } });
    expect(await stat(checkpoint.targetFinal).catch(() => null)).toBeNull();
  });
});
