import fs from 'node:fs';
import path from 'node:path';
import taskArchive from '../../src/api/services/image-task-archive.mjs';
import { fingerprintToken } from '../../src/api/services/image-task-ledger.ts';

export function seedArchive(storeDir: string, execute = true) {
  fs.mkdirSync(storeDir, { recursive: true });
  const storeFile = path.join(storeDir, 'image-task-store.json');
  const store = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : { schemaVersion: 2, records: [] };
  const records = ['submission_unknown', 'submission_unknown', 'processing'].map((status, index) => ({
    taskId: 'old-' + index, idempotencyKey: `E002:v1:SUB-archived:${index}:attempt-0`,
    requestHash: 'original-request-' + index, tokenFingerprint: fingerprintToken('token-archive'),
    historyId: status === 'processing' ? 'original-history' : '', status,
    rawStatus: status === 'processing' ? 45 : 0, count: status === 'processing' ? 2 : 0,
    imageUrls: status === 'processing' ? ['https://fixture.invalid/1.png', 'https://fixture.invalid/2.png'] : [],
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:01:00.000Z',
    context: { uploadKey: 'archive-upload', nested: { preserved: '原始记录' } }, legacyExtra: { untouched: true },
  }));
  store.records.push(...records);
  fs.writeFileSync(storeFile, JSON.stringify(store), { mode: 0o600 });
  const approval = { schemaVersion: 1, operation: 'archived_no_replay', preserveRecords: true, forbidReplay: true,
    approvalReference: 'offline synthetic test only', reason: '人工关闭，远端结果未确认',
    approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
    storeSha256: taskArchive.sha(fs.readFileSync(storeFile)),
    records: records.map(record => ({ keyHash: taskArchive.keyDigest(record.idempotencyKey), recordHash: taskArchive.recordDigest(record) })) };
  if (execute) taskArchive.archiveTasks({ storeDir, approval, execute: true });
  return { records, approval, storeFile };
}
