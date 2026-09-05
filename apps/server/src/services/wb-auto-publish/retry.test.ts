import { describe, expect, it } from 'vitest';
import { buildWbRetryPlan } from './retry.js';
import { retryStateToken } from '../../repositories/wb-auto-retry.js';

export function retryFixture() {
  const task = 'default__0000172__r4';
  const intent = { taskId: task, publicationId: 'publication', revision: 4, idempotencyKey: 'original-key',
    logicalIntentId: 'intent', attemptNo: 1, frozenPayloadHash: 'sha256:frozen',
    frozenPayload: [{ subjectID: 7, variants: [{ vendorCode: '0000172-01', sizes: [{ skus: ['barcode-1'] }] }] }] };
  const snapshot = {
    auto: { id: 'auto', store_id: 'store', sku: '0000172', run_id: 'run', n8n_task_id: task, publication_id: 'publication', state: 'FAILED' },
    publication: { id: 'publication', store_id: 'store', task_id: task, generated_version_id: 'frozen-version', status: 'FAILED' },
    runtime: { task_id: task, publication_id: 'publication', store_id: 'store', product_code: '0000172',
      revision: 4, idempotency_key: 'original-key', payload_signature: 'original-signature', partial_effects: false,
      row_version: 8, state: 'FAILED', result_json: {
        automationRunId: 'run', cardCreateIntent: intent, cards: [] as any[],
        product: { productCode: '0000172', revision: 4, category: { subjectId: 7 }, variants: [{ vendorCode: '0000172-01', sizes: [{ barcode: 'barcode-1' }] }] },
        audit: [{ event: 'HTTP_RESPONSE', stage: 'CARD_WRITE', requestRef: 'first', status: 400 }]
      } as any }
  };
  const receipts = [{ request_ref: 'first', operation: 'CARD_UPLOAD', completed_at: new Date().toISOString(), status_code: 400,
    response_json: { errorText: 'Internal server error' }, logical_intent_id: 'intent', attempt_no: 1, delivery_state: 'RESPONDED', retry_class: 'PERMANENT' }];
  const readback = { complete: true, checkedAt: new Date().toISOString(), active: [] as any[], trash: [] as any[], errors: [] as any[] };
  return { snapshot, receipts, readback };
}

describe('WB manual retry recovery decision', () => {
  it('recovers historical 0000172 FAILED with no partial effects using the next attempt and unchanged snapshot', () => {
    const f = retryFixture();
    const frozen = JSON.stringify(f.snapshot);
    expect(buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toMatchObject({ stage: 'CARD_CREATE_READY', cardAttempt: 2, evidence: { cardAbsent: true } });
    expect(JSON.stringify(f.snapshot)).toBe(frozen);
  });
  it('keeps UNKNOWN in readback without granting a new write', () => {
    const f = retryFixture(); f.receipts[0]!.delivery_state = 'UNKNOWN';
    expect(buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toMatchObject({ stage: 'CARD_SUBMITTING', evidence: { readbackOnly: true } });
    expect(buildWbRetryPlan(f.snapshot, f.receipts, f.readback).cardAttempt).toBeUndefined();
  });
  it('allows a known generic error batch but keeps its identity to distinguish later failures', () => {
    const f = retryFixture();
    f.readback.errors = [{ batchUUID: 'old-batch', updatedAt: new Date().toISOString(), vendorCodes: ['0000172-01'], errors: { '0000172-01': ['Internal server error'] } }];
    expect(buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toMatchObject({ cardAttempt: 2,
      evidence: { ignoredGenericFailureBatches: [{ batchUUID: 'old-batch' }] } });
    f.readback.errors[0].errors['0000172-01'].push('Invalid title');
    expect(() => buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toThrow(/字段/);
  });
  it('matches frozen custom vendor codes exactly when inspecting errors', () => {
    const f = retryFixture();
    f.snapshot.runtime.result_json.product.variants[0].vendorCode = 'custom-code';
    f.readback.errors = [{ vendorCodes: ['custom-code'], errors: { 'custom-code': ['Invalid title'] } }];
    expect(() => buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toThrow(/字段/);
    f.readback.errors = [{ vendorCodes: ['custom-code-other'], errors: ['Invalid title'] }];
    expect(buildWbRetryPlan(f.snapshot, f.receipts, f.readback).cardAttempt).toBe(2);
  });
  it('does not treat generic errorText as retryable when additionalErrors identifies invalid fields', () => {
    const f = retryFixture();
    Object.assign(f.receipts[0]!.response_json, { additionalErrors: { '0000172-01': ['Invalid title'] } });
    expect(() => buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toThrow(/具体字段/);
  });
  it.each(['MEDIA_UPLOAD', 'PRICE_WRITE', 'STOCK_WRITE', 'FINALIZING'])('resumes %s with existing card and original checkpoints', stage => {
    const f = retryFixture();
    f.snapshot.runtime.result_json.lastFailureCheckpoint = { state: stage, stage };
    f.snapshot.runtime.result_json.price = { verified: true };
    f.snapshot.runtime.result_json.stock = { verified: true };
    f.snapshot.runtime.result_json.cards = [{ vendorCode: '0000172-01', nmID: 172, photosCount: 3, acceptedMedia: ['original-image'] }];
    f.readback.active = [{ vendorCode: '0000172-01', nmID: 172, subjectID: 7, sizes: [{ skus: ['barcode-1'] }] }];
    const plan = buildWbRetryPlan(f.snapshot, f.receipts, f.readback);
    expect(plan.cardAttempt).toBeUndefined();
    expect(plan.stage).toBe(({ MEDIA_UPLOAD: 'MEDIA_RECONCILING', PRICE_WRITE: 'PRICE_RECONCILING', STOCK_WRITE: 'STOCK_RECONCILING', FINALIZING: 'FINALIZING' } as any)[stage]);
    expect(plan.evidence.cards[0].acceptedMedia).toEqual(['original-image']);
  });
  it('recognizes a created card despite the locally failed write', () => {
    const f = retryFixture();
    f.readback.active = [{ vendorCode: '0000172-01', nmID: 172, subjectID: 7, sizes: [{ skus: ['barcode-1'] }] }];
    expect(buildWbRetryPlan(f.snapshot, f.receipts, f.readback).stage).toBe('MEDIA_RECONCILING');
  });
  it.each(['incomplete', 'trash', 'ownership', 'fields', 'partial', 'identity', 'missing-receipt'])('blocks unsafe %s evidence', kind => {
    const f = retryFixture();
    if (kind === 'incomplete') f.readback.complete = false;
    if (kind === 'trash') f.readback.trash = [{ vendorCode: '0000172-01' }];
    if (kind === 'ownership') f.readback.active = [{ vendorCode: '0000172-01', nmID: 172, subjectID: 8, sizes: [] }];
    if (kind === 'fields') f.receipts[0]!.response_json.errorText = 'Invalid title field';
    if (kind === 'partial') { f.snapshot.runtime.result_json.product.variants.push({ vendorCode: '0000172-02' }); f.readback.active = [{ vendorCode: '0000172-01' }]; }
    if (kind === 'identity') f.snapshot.publication.store_id = 'another-store';
    if (kind === 'missing-receipt') f.receipts = [];
    expect(() => buildWbRetryPlan(f.snapshot, f.receipts, f.readback)).toThrow();
  });
  it('rejects tokens from an older runtime version or a different run', () => {
    const f = retryFixture(); const original = retryStateToken(f.snapshot);
    f.snapshot.runtime.row_version++;
    expect(retryStateToken(f.snapshot)).not.toBe(original);
    f.snapshot.runtime.row_version--;
    f.snapshot.auto.run_id = 'new-run';
    expect(retryStateToken(f.snapshot)).not.toBe(original);
  });
});
