import { describe, expect, it, vi } from 'vitest';
import { WbPresetRepository } from './wb-presets.js';

type DraftOverrides = Partial<{
  status: string;
  latest_operation_source: string;
  latest_operation_ref: string | null;
  auto_publish_locked: boolean;
  generated_version_id: string | null;
  n8n_task_id: string | null;
}>;

const ownerRunId = '33333333-3333-4333-8333-333333333333';
const requestedRunId = '44444444-4444-4444-8444-444444444444';
const requestedJobId = '77777777-7777-4777-8777-777777777777';
const generationFence = { jobId: requestedJobId, runId: requestedRunId, rowVersion: 7 };

function repositoryHarness(overrides: DraftOverrides = {}, options: {
  frozen?: boolean;
  ownerJob?: Record<string, unknown> | null;
  generationLease?: Record<string, unknown> | null;
  generationLeaseTable?: boolean;
} = {}) {
  const row = {
    status: 'GENERATED',
    latest_operation_source: 'AUTOMATION',
    latest_operation_ref: `automation:${ownerRunId}`,
    auto_publish_locked: true,
    generated_version_id: '11111111-1111-4111-8111-111111111111',
    n8n_task_id: null,
    ...overrides
  };
  const frozen = options.frozen ?? true;
  const ownerJob = options.ownerJob === undefined ? {
    id: '55555555-5555-4555-8555-555555555555',
    store_id: '66666666-6666-4666-8666-666666666666',
    state: 'GENERATING',
    publication_id: null
  } : options.ownerJob;
  const defaultGenerationLease = {
    owner_job_id: requestedJobId,
    owner_run_id: requestedRunId,
    row_version: 7,
    lease_until: new Date(Date.now() + 60_000).toISOString()
  };
  const generationLease = options.generationLease === undefined ? defaultGenerationLease : options.generationLease;
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      if (text.startsWith('SELECT * FROM wb_listing_drafts')) return { rows: [row], rowCount: 1 };
      if (text.includes('COUNT(*)::text total')) return { rows: [{ total: '2' }], rowCount: 1 };
      if (text.includes('SELECT EXISTS(')) return { rows: [{ frozen }], rowCount: 1 };
      if (text.includes('FROM wb_auto_publish_jobs WHERE sku=$1')) {
        return { rows: ownerJob ? [ownerJob] : [], rowCount: ownerJob ? 1 : 0 };
      }
      if (text.includes("to_regclass(current_schema()||'.wb_auto_generation_leases')")) {
        return { rows: [{ available: options.generationLeaseTable ?? true }], rowCount: 1 };
      }
      if (text.includes('FROM wb_auto_generation_leases')) {
        return { rows: generationLease ? [generationLease] : [], rowCount: generationLease ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn()
  };
  const repository = new WbPresetRepository();
  (repository as any).pool = { connect: vi.fn(async () => client) };
  return { repository, queries };
}

const rebuildInput = {
  sku: '0000126',
  categoryKey: 'preset_shoes',
  categoryVersionId: '22222222-2222-4222-8222-222222222222',
  data: { variants: [] },
  operationRef: `automation:${requestedRunId}`,
  allowGeneratedStoreFanout: true,
  generationFence
};

describe('WB preset generated store fanout compatibility', () => {
  it('accepts only strict materialized automation evidence with a current generation fence', async () => {
    const { repository, queries } = repositoryHarness();

    await expect(repository.replaceInitializedListing(rebuildInput)).resolves.toBeUndefined();

    const freezeQuery = queries.find((query) => query.includes('SELECT EXISTS(')) || '';
    expect(freezeQuery).toContain("publication.source='AUTOMATION'");
    expect(freezeQuery).toContain("publication.request_key='automation:'||$2::text||':'||$3::text");
    expect(freezeQuery).toContain("publication.config_snapshot->>'sourceGeneratedVersionId'=$4::text");
    expect(freezeQuery).toContain("source_version.generation_scope='LISTING'");
    expect(freezeQuery).toContain("publication_version.generation_scope='STORE_PUBLICATION'");
    expect(freezeQuery).toContain("publication_version.materialization_hash=publication.materialization_hash");
    expect(freezeQuery).not.toContain('publication.status');
  });

  it('rejects a real manual generated draft with explicit ownership evidence', async () => {
    const { repository, queries } = repositoryHarness({ latest_operation_source: 'MANUAL' });

    await expect(repository.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'EXISTING_LOCAL_LISTING', statusCode: 409,
      details: expect.objectContaining({
        ownershipSource: 'MANUAL',
        operationRef: `automation:${ownerRunId}`,
        manualDraft: true
      })
    });
    expect(queries.some((query) => query.includes('SELECT EXISTS('))).toBe(false);
  });

  it('classifies the publication-before-insert window as AUTOMATION_BUSY instead of a manual draft', async () => {
    const { repository } = repositoryHarness({}, { frozen: false, generationLease: null });

    await expect(repository.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'AUTOMATION_BUSY', statusCode: 409,
      details: expect.objectContaining({
        ownershipSource: 'AUTOMATION',
        operationRef: `automation:${ownerRunId}`,
        ownerRunId,
        manualDraft: false
      })
    });
  });

  it('fails closed when an automatic operationRef cannot be mapped to a same-SKU job', async () => {
    const { repository } = repositoryHarness({ latest_operation_ref: 'automation:not-a-run-id' }, {
      frozen: false,
      ownerJob: null
    });

    await expect(repository.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'OWNERSHIP_AMBIGUOUS', statusCode: 409,
      details: expect.objectContaining({
        ownershipSource: 'AUTOMATION',
        operationRef: 'automation:not-a-run-id',
        manualDraft: false
      })
    });
  });

  it('lets the current fenced owner reclaim an orphan left by a terminal automation job', async () => {
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    const { repository } = repositoryHarness({}, {
      frozen: false,
      ownerJob: {
        id: '55555555-5555-4555-8555-555555555555',
        store_id: '66666666-6666-4666-8666-666666666666',
        state: 'FAILED',
        publication_id: null
      },
      generationLease: {
        owner_job_id: requestedJobId,
        owner_run_id: requestedRunId,
        row_version: 7,
        lease_until: leaseUntil
      }
    });

    await expect(repository.replaceInitializedListing(rebuildInput)).resolves.toBeUndefined();
  });
});
