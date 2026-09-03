import pLimit from 'p-limit';
import type { SubmissionRecord } from '@n8n-media-review/shared';
import type { StateStore } from '../repositories/store.js';
import { stableHash } from './review-operations.js';
const replayLimit = pLimit(1);
export class DeliveryReplayService {
  constructor(private readonly store: StateStore) {}
  get paused(): boolean { return this.store.operations(true).some((row) => row.status === 'RUNNING'); }
  async run(platform: string, records: SubmissionRecord[], epoch: string, handle: (row: SubmissionRecord) => Promise<boolean>): Promise<void> {
    await replayLimit(async () => {
      if (this.paused || !records.length) return;
      const old = this.store.section('reviewReplay')?.[platform];
      const state = old?.cursor === epoch ? old : { cursor: epoch, resolved: [], scanAfter: '', unresolved: {} };
      const resolved = new Set(state.resolved);
      const unresolved = { ...state.unresolved };
      const keyOf = (row: SubmissionRecord) => stableHash([row.submissionId, row.completedAt, row.selectedRelativePaths, row.resolvedOutputRoot]);
      const candidates = records.filter((row) => !resolved.has(keyOf(row))).sort((a, b) => a.submissionId.localeCompare(b.submissionId));
      const after = candidates.findIndex((row) => row.submissionId > (state.scanAfter || ''));
      const rotated = after < 0 ? candidates : [...candidates.slice(after), ...candidates.slice(0, after)];
      let count = 0;
      let changed = old?.cursor !== epoch;
      for (const row of rotated) {
        if (this.paused || count >= 20) break;
        const key = keyOf(row);
        if (unresolved[key] && Date.parse(unresolved[key]!.nextAttemptAt) > Date.now()) continue;
        count += 1; changed = true; state.scanAfter = row.submissionId;
        let complete = false;
        try { complete = await handle(row); } catch { /* handler reports failure; retain identity and bounded backoff */ }
        if (complete) { resolved.add(key); delete unresolved[key]; }
        else {
          const attempts = (unresolved[key]?.attempts || 0) + 1;
          unresolved[key] = { attempts, nextAttemptAt: new Date(Date.now() + Math.min(600_000, 30_000 * 2 ** Math.min(attempts, 5))).toISOString() };
        }
      }
      if (changed) await this.store.updateSections(['reviewReplay'], (db) => {
        (db.reviewReplay ||= {})[platform] = { ...state, resolved: [...resolved], unresolved };
      });
    });
  }
}
