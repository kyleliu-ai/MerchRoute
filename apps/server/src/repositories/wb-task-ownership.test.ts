import { describe, expect, it, vi } from 'vitest';
import { WbRepository } from './wb.js';

describe('WB listing task ownership', () => {
  it('falls back to immutable multi-store publication/runtime ownership when the singleton draft has no task pointer', async () => {
    const repository = new WbRepository();
    const query = vi.spyOn(repository as any, 'query')
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        sku: '0000118',
        n8n_task_id: 'default__0000118__r1',
        revision: 1,
        automation_context: { runId: 'run-0118', operationMode: 'COMPATIBLE_UPSERT' },
        subject_id: 50
      }] });

    await expect(repository.getListingTaskOwnership('default__0000118__r1')).resolves.toEqual({
      sku: '0000118',
      taskId: 'default__0000118__r1',
      revision: 1,
      automationContext: { runId: 'run-0118', operationMode: 'COMPATIBLE_UPSERT' },
      subjectId: 50
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('JOIN wb_store_publications p');
    expect(String(query.mock.calls[1]?.[0])).toContain('p.store_id=j.store_id');
    expect(query.mock.calls[1]?.[1]).toEqual(['default__0000118__r1']);
  });
});
