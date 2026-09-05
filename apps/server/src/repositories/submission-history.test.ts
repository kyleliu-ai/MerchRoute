import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import type { ReviewOperation, SubmissionRecord } from '@n8n-media-review/shared';
import { StateStore } from './store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(status: ReviewOperation['status'], historyStatus?: SubmissionRecord['status']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-history-view-'));
  roots.push(root);
  const store = new StateStore(root);
  await store.initialize();
  const record: SubmissionRecord = { submissionId: 'stable-id', pendingSubmissionId: 'pending', taskId: 'task', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '/source', selectedImageCount: 2, status: 'FAILED', startedAt: '2026-09-05T00:00:00.000Z' };
  await store.updateSections(['reviewOperations', 'deliveryCheckpoints', 'submissionHistory'], (db) => {
    db.reviewOperations!.push({ operationId: 'owner', kind: 'BATCH', subjectKeys: ['task:task'], requestKey: 'key', requestHash: 'hash', input: {}, attempt: 1, status, createdAt: record.startedAt, updatedAt: record.startedAt });
    db.deliveryCheckpoints!.push({ submissionId: record.submissionId, pendingSubmissionId: 'pending', operationId: 'owner', taskId: 'task', phase: 'NEEDS_ATTENTION', revision: 1, targetTemp: '/staging', targetFinal: '/target', files: [], record, updatedAt: record.startedAt });
    if (historyStatus) db.submissionHistory.push({ ...record, status: historyStatus });
  });
  return { root, store };
}

it.each(['QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED'] as const)('does not present an active or completed %s operation as an uncertain failure', async (status) => {
  const { store } = await fixture(status);
  expect(store.selectSubmissionHistory((rows) => rows)).toEqual([]);
});

it.each(['SUCCESS', 'PARTIAL_SUCCESS'] as const)('preserves an acknowledged %s leg even if its batch needs attention', async (status) => {
  const { store } = await fixture('NEEDS_ATTENTION', status);
  expect(store.selectSubmissionHistory((rows) => rows)).toHaveLength(1);
  expect(store.getSubmissionView('stable-id')).toMatchObject({ status });
  expect(store.getSubmissionView('stable-id')?.errorCode).toBeUndefined();
});

it.each([undefined, 'FAILED'] as const)('projects and deduplicates uncertain results without changing persisted history (%s)', async (historyStatus) => {
  const { root, store } = await fixture('NEEDS_ATTENTION', historyStatus);
  const before = await readFile(path.join(root, 'db.json'), 'utf8');
  const page = store.selectSubmissionHistory((rows) => ({ total: rows.length, items: rows.slice(0, 20) }));
  expect(page).toMatchObject({ total: 1, items: [{ submissionId: 'stable-id', status: 'FAILED', errorCode: 'DELIVERY_OUTCOME_UNKNOWN' }] });
  page.items[0]!.sourceFolder = '/mutated-client-copy';
  expect(store.getSubmissionView('stable-id')?.sourceFolder).toBe('/source');
  expect(await readFile(path.join(root, 'db.json'), 'utf8')).toBe(before);
  expect(store.getSubmission('stable-id')?.errorCode).toBeUndefined();
});
