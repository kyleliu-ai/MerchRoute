import { createHash } from 'node:crypto';
import type {
  OzonListingDraft,
  OzonProductMapping,
  OzonPublishJob
} from '@n8n-media-review/shared';
import type { OzonRuntimeUpdateInput } from '../../repositories/ozon.js';

export const OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID = 'g3KK68BLXX7eShqa';
export const OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT = 'OZON_RFBS_STOCK_READBACK_NORMALIZED';

export type OzonRfbsStockReadbackAttestation = {
  schemaVersion: 1;
  kind: 'OZON_P002_RFBS_STOCK_READBACK';
  workflowId: typeof OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID;
  executionId: string;
  executionStatus: 'running' | 'success';
  executionStartedAt: string;
  checkedAt: string;
  jobId: string;
  jobRowVersion: number;
  leaseOwner: string;
  leaseToken: string;
  offerContractHash: string;
  callbackHash: string;
  readAt: string;
  offers: Array<{
    offerId: string;
    ozonProductId: string;
    ozonSku: string;
    stock: number;
  }>;
  sourceInput: OzonRuntimeUpdateInput;
};

export type OzonRfbsNormalizationAuthority = {
  job: OzonPublishJob;
  listing: OzonListingDraft;
  mappings: OzonProductMapping[];
};

export async function readOzonP002Execution(
  executionId: string,
  fetchImplementation: typeof fetch = fetch
): Promise<Record<string, unknown> | undefined> {
  const apiKey = String(process.env.N8N_API_KEY || '').trim();
  const rawBase = String(process.env.N8N_API_URL || 'http://127.0.0.1:5678').trim();
  if (!apiKey || !/^\d+$/.test(executionId) || !rawBase) return undefined;
  const apiRoot = `${rawBase.replace(/\/+$/, '').replace(/\/api\/v1$/i, '')}/api/v1`;
  try {
    const response = await fetchImplementation(`${apiRoot}/executions/${encodeURIComponent(executionId)}?includeData=true`, {
      headers: { 'X-N8N-API-KEY': apiKey },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return recordValue(value);
  } catch {
    return undefined;
  }
}

export function normalizeOzonRfbsStockMismatchCallback(
  authority: OzonRfbsNormalizationAuthority,
  sourceInput: OzonRuntimeUpdateInput,
  execution: Record<string, unknown>,
  now = new Date()
): OzonRuntimeUpdateInput | undefined {
  const attestation = createAttestation(authority, sourceInput, execution, now);
  if (!attestation) return undefined;
  return normalizedInput(sourceInput, attestation);
}

export function assertOzonRfbsStockNormalizationAttestation(
  authority: OzonRfbsNormalizationAuthority,
  input: OzonRuntimeUpdateInput,
  now = new Date()
): void {
  const attestation = input.rfbsStockReadbackAttestation;
  if (!attestation) {
    throw new Error('OZON_RFBS_STOCK_READBACK_ATTESTATION_INVALID');
  }
  if (!validateAuthority(authority, attestation.sourceInput, attestation, now)) {
    throw new Error('OZON_RFBS_STOCK_READBACK_ATTESTATION_INVALID');
  }
  const expected = normalizedInput(attestation.sourceInput, attestation);
  const expectedArchived = expectedArchivedInput(authority, input, expected, attestation, now);
  if (!expectedArchived
    || stableJson(stripAttestation(input)) !== stableJson(stripAttestation(expectedArchived))) {
    throw new Error('OZON_RFBS_STOCK_READBACK_NORMALIZATION_DRIFT');
  }
}

function expectedArchivedInput(
  authority: OzonRfbsNormalizationAuthority,
  input: OzonRuntimeUpdateInput,
  expected: OzonRuntimeUpdateInput,
  attestation: OzonRfbsStockReadbackAttestation,
  now: Date
): OzonRuntimeUpdateInput | undefined {
  const revision = authority.job.revision;
  const taskFolder = String(authority.job.taskFolder || '');
  const directorySignature = String(authority.job.directorySignature || '');
  const workRelPath = String(input.workRelPath || '');
  const pathMatch = /^success\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/.exec(workRelPath);
  const successDate = pathMatch?.[1] || '';
  const createdDate = shanghaiDate(authority.job.createdAt);
  const checkedDate = shanghaiDate(attestation.checkedAt);
  if (!Number.isInteger(revision) || Number(revision) <= 0
    || input.revision !== revision
    || !taskFolder || input.taskFolder !== taskFolder
    || !directorySignature || input.directorySignature !== directorySignature
    || input.directoryStage !== 'SUCCESS'
    || !pathMatch || pathMatch[2] !== taskFolder
    || !isCalendarDate(successDate)
    || !createdDate || !checkedDate
    || successDate < createdDate || successDate > checkedDate) return undefined;

  const jobPayload = recordValue(input.jobPayload);
  if (jobPayload.revision !== input.revision
    || jobPayload.taskFolder !== input.taskFolder
    || jobPayload.workRelPath !== input.workRelPath
    || jobPayload.directoryStage !== input.directoryStage
    || jobPayload.directorySignature !== input.directorySignature) return undefined;

  const videoCacheCleanedAt = jobPayload.videoCacheCleanedAt;
  const canonicalVideoCacheCleanedAt = canonicalDate(videoCacheCleanedAt);
  const checkedAt = Date.parse(attestation.checkedAt);
  const cleanedAt = Date.parse(String(videoCacheCleanedAt || ''));
  if (typeof videoCacheCleanedAt !== 'string'
    || canonicalVideoCacheCleanedAt !== videoCacheCleanedAt
    || !Number.isFinite(checkedAt) || !Number.isFinite(cleanedAt)
    || cleanedAt < checkedAt - 5_000
    || cleanedAt > now.getTime() + 5_000) return undefined;

  return {
    ...expected,
    revision,
    taskFolder,
    workRelPath,
    directoryStage: 'SUCCESS',
    directorySignature,
    jobPayload: {
      ...recordValue(expected.jobPayload),
      videoCacheCleanedAt,
      revision,
      taskFolder,
      workRelPath,
      directoryStage: 'SUCCESS',
      directorySignature
    }
  };
}

function createAttestation(
  authority: OzonRfbsNormalizationAuthority,
  sourceInput: OzonRuntimeUpdateInput,
  execution: Record<string, unknown>,
  now: Date
): OzonRfbsStockReadbackAttestation | undefined {
  const leaseMatch = /^n8n:ozon:p002:(\d+)$/.exec(String(authority.job.leaseOwner || ''));
  const executionId = leaseMatch?.[1] || '';
  const status = String(execution.status || '');
  const startedAt = canonicalDate(execution.startedAt);
  if (!executionId
    || String(execution.id || '') !== executionId
    || String(execution.workflowId || '') !== OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID
    || !['running', 'success'].includes(status)
    || !startedAt) return undefined;
  const prepared = executionNodeItems(execution, '准备平台最终校验');
  const responses = executionNodeItems(execution, '调用 OZON-A001 最终读回');
  const operations = ['infoList', 'attributesInfo', 'pricesRead', 'stocksRead', 'picturesInfo'];
  if (prepared.length !== operations.length || responses.length !== operations.length) return undefined;
  const preparedByOperation = exactOperationMap(prepared, operations, 'verifyOperation');
  const responsesByOperation = exactOperationMap(responses, operations, 'operation');
  if (!preparedByOperation || !responsesByOperation) return undefined;

  const contract = frozenContract(authority.job);
  if (!contract) return undefined;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    const request = preparedByOperation.get(operation)!;
    const response = responsesByOperation.get(operation)!;
    if (String(request.jobId || '') !== authority.job.id
      || Number(request.rowVersion) !== authority.job.rowVersion
      || String(request.sku || '') !== authority.job.sku
      || String(request.storeAlias || '') !== authority.job.storeAlias
      || String(request.leaseOwner || '') !== authority.job.leaseOwner
      || String(request.leaseToken || '') !== authority.job.leaseToken
      || stableJson(strictStringArray(request.offerIds)) !== stableJson(contract.expectedOfferIds)
      || !sameContract(recordValue(request.jobPayload), authority.job.payload || {})
      || !samePreparedContract(request, authority.job.payload || {})
      || String(request.currentState || '') !== authority.job.state
      || String(request.importTaskId || '') !== String(authority.job.importTaskId || '')
      || Number(recordValue(request.jobPayload).revision) !== Number(authority.job.revision)
      || !sameOptionalJobBinding(request.directoryStage, authority.job.directoryStage)
      || !sameOptionalJobBinding(request.workRelPath, authority.job.workRelPath)
      || !sameOptionalJobBinding(request.taskFolder, authority.job.taskFolder)
      || !sameOptionalJobBinding(request.directorySignature, authority.job.directorySignature)
      || String(request.operation || '') !== operation
      || String(request.requestId || '') !== `${authority.job.id}:${operation}`
      || response.ok !== true
      || Number(response.statusCode) !== 200
      || response.isWrite === true
      || String(response.deliveryState || '') !== 'RESPONDED'
      || String(response.operation || '') !== operation
      || String(response.requestId || '') !== `${authority.job.id}:${operation}`
      || Number(response.inputIndex) !== index) return undefined;
  }

  const expectedMappings = callbackMappings(authority, sourceInput, contract.expectedOfferIds);
  if (!expectedMappings) return undefined;
  const stocks = exactOfferItems(recordValue(responsesByOperation.get('stocksRead')!.body), contract.expectedOfferIds, 'offer_id');
  const info = exactOfferItems(recordValue(responsesByOperation.get('infoList')!.body), contract.expectedOfferIds, 'offer_id');
  const attributes = exactOfferItems(recordValue(responsesByOperation.get('attributesInfo')!.body), contract.expectedOfferIds, 'offer_id');
  const prices = exactOfferItems(recordValue(responsesByOperation.get('pricesRead')!.body), contract.expectedOfferIds, 'offer_id');
  const pictures = exactOfferItems(
    recordValue(responsesByOperation.get('picturesInfo')!.body),
    expectedMappings.map((mapping) => mapping.ozonProductId),
    'product_id'
  );
  if (!stocks || !info || !attributes || !prices || !pictures) return undefined;
  const snapshots = contract.expectedOfferSnapshots;
  const provenOffers: OzonRfbsStockReadbackAttestation['offers'] = [];
  for (const offerId of contract.expectedOfferIds) {
    const expected = snapshots.find((snapshot) => String(snapshot.offerId || '') === offerId)!;
    const mapping = expectedMappings.find((entry) => entry.offerId === offerId)!;
    const item = stocks.get(offerId)!;
    const rows = Array.isArray(item.stocks) ? item.stocks : [];
    const row = recordValue(rows[0]);
    if (rows.length !== 1
      || String(item.product_id || '') !== mapping.ozonProductId
      || String(row.type || '') !== 'rfbs'
      || !Object.prototype.hasOwnProperty.call(row, 'present')
      || !Number.isInteger(Number(row.present))
      || Number(row.present) < 0
      || Number(row.present) !== Number(expected.stock)
      || String(row.sku || '') !== mapping.ozonSku
      || hasSingleWarehouseIdentity(row)
      || !Object.prototype.hasOwnProperty.call(row, 'warehouse_ids')
      || !Array.isArray(row.warehouse_ids)
      || row.warehouse_ids.length !== 0
      || Object.prototype.hasOwnProperty.call(row, 'warehouseIds')) return undefined;
    provenOffers.push({ offerId, ozonProductId: mapping.ozonProductId, ozonSku: mapping.ozonSku, stock: Number(row.present) });
  }
  const readAt = canonicalDate(recordValue(sourceInput.payload).readAt);
  const checkedAt = now.toISOString();
  if (!readAt || Date.parse(readAt) < Date.parse(startedAt) - 5_000 || Date.parse(readAt) > now.getTime() + 30_000) return undefined;
  const attestation: OzonRfbsStockReadbackAttestation = {
    schemaVersion: 1,
    kind: 'OZON_P002_RFBS_STOCK_READBACK',
    workflowId: OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID,
    executionId,
    executionStatus: status as 'running' | 'success',
    executionStartedAt: startedAt,
    checkedAt,
    jobId: authority.job.id,
    jobRowVersion: authority.job.rowVersion,
    leaseOwner: String(authority.job.leaseOwner),
    leaseToken: String(authority.job.leaseToken),
    offerContractHash: contract.offerContractHash,
    callbackHash: callbackHash(sourceInput),
    readAt,
    offers: provenOffers,
    sourceInput
  };
  return validateAuthority(authority, sourceInput, attestation, now) ? attestation : undefined;
}

function validateAuthority(
  authority: OzonRfbsNormalizationAuthority,
  sourceInput: OzonRuntimeUpdateInput,
  attestation: OzonRfbsStockReadbackAttestation,
  now: Date
): boolean {
  const contract = frozenContract(authority.job);
  if (!contract
    || authority.listing.data.fulfillmentMode !== 'RFBS'
    || recordValue(recordValue(authority.job.payload?.materialSnapshot).store).fulfillmentMode !== 'RFBS'
    || sourceInput.state !== 'NEEDS_ATTENTION'
    || sourceInput.errorCode !== 'OZON_FINAL_READBACK_MISMATCH'
    || sourceInput.eventType !== 'OZON_FINAL_READBACK_MISMATCH'
    || sourceInput.rowVersion !== authority.job.rowVersion
    || sourceInput.leaseOwner !== authority.job.leaseOwner
    || sourceInput.leaseToken !== authority.job.leaseToken
    || sourceInput.clearLease !== true
    || !authority.job.leaseToken
    || !authority.job.leaseExpiresAt
    || Date.parse(authority.job.leaseExpiresAt) <= now.getTime()
    || attestation.jobId !== authority.job.id
    || attestation.jobRowVersion !== authority.job.rowVersion
    || attestation.leaseOwner !== authority.job.leaseOwner
    || attestation.leaseToken !== authority.job.leaseToken
    || attestation.offerContractHash !== contract.offerContractHash
    || attestation.callbackHash !== callbackHash(sourceInput)
    || stableJson(attestation.offers.map((offer) => offer.offerId)) !== stableJson(contract.expectedOfferIds)
    || Date.parse(attestation.checkedAt) < now.getTime() - 5 * 60_000) return false;

  const stages = sourceInput.stageStates || {};
  if (stages.import !== 'SUCCESS' || stages.moderation !== 'SUCCESS' || stages.images !== 'VERIFIED'
    || stages.price !== 'VERIFIED' || stages.stock !== 'DIFFERENCE'
    || !['VERIFIED', 'NOT_REQUIRED'].includes(stages.video || '')
    || !['VERIFIED', 'NOT_REQUIRED'].includes(stages.productVideo || '')
    || !['VERIFIED', 'NOT_REQUIRED'].includes(stages.videoCover || '')) return false;
  const expectedStageKeys = ['images', 'import', 'moderation', 'price', 'productVideo', 'stock', 'video', 'videoCover'];
  if (stableJson(Object.keys(stages).sort()) !== stableJson(expectedStageKeys)) return false;

  const payload = recordValue(sourceInput.payload);
  if (stableJson(strictStringArray(payload.verifiedOfferIds)) !== stableJson(contract.expectedOfferIds)) return false;
  const descriptions = recordArray(payload.descriptionVerificationByOffer);
  if (descriptions.length !== contract.expectedOfferIds.length
    || descriptions.some((entry, index) => String(entry.offerId || '') !== contract.expectedOfferIds[index]
      || entry.present !== true || entry.matches !== true)) return false;
  const warnings = recordArray(payload.warnings);
  if (warnings.length !== contract.expectedOfferIds.length
    || warnings.some((warning, index) => String(warning.code || '') !== 'OZON_STOCK_DIFFERENCE'
      || String(warning.offerId || '') !== contract.expectedOfferIds[index]
      || Number(warning.expected) !== Number(contract.expectedOfferSnapshots[index]?.stock)
      || Number(warning.actual) !== 0)) return false;

  const jobPayload = recordValue(sourceInput.jobPayload);
  const final = recordValue(jobPayload.finalConsistencyRecovery);
  const affected = recordArray(final.affectedOffers);
  const imageRecovery = recordValue(jobPayload.imageRecovery);
  if (final.schemaVersion !== 1 || final.phase !== 'FAILED' || Number(final.confirmationCount) < 3
    || affected.length !== contract.expectedOfferIds.length
    || imageRecovery.phase !== 'VERIFIED'
    || recordArray(imageRecovery.affectedOffers).length !== 0
    || Number(imageRecovery.expectedImageCount) !== Number(imageRecovery.actualImageCount)) return false;
  for (let index = 0; index < affected.length; index += 1) {
    const entry = affected[index]!;
    const differences = recordValue(entry.differences);
    const stock = recordValue(differences.stock);
    if (String(entry.offerId || '') !== contract.expectedOfferIds[index]
      || stableJson(Object.keys(differences)) !== stableJson(['stock'])
      || Number(stock.expected) !== Number(contract.expectedOfferSnapshots[index]?.stock)
      || Number(stock.actual) !== 0
      || stock.valid !== true
      || !Array.isArray(stock.reasons)
      || stock.reasons.length !== 0) return false;
  }
  return Boolean(callbackMappings(authority, sourceInput, contract.expectedOfferIds));
}

function callbackMappings(
  authority: OzonRfbsNormalizationAuthority,
  input: OzonRuntimeUpdateInput,
  expectedOfferIds: string[]
): Array<{ offerId: string; ozonProductId: string; ozonSku: string }> | undefined {
  const incoming = Array.isArray(input.productMappings) ? input.productMappings : [];
  if (incoming.length !== expectedOfferIds.length || authority.mappings.length !== expectedOfferIds.length
    || authority.job.ozonProductLinks.length !== expectedOfferIds.length) return undefined;
  const contract = frozenContract(authority.job);
  if (!contract) return undefined;
  const readAt = String(recordValue(input.payload).readAt || '');
  const output: Array<{ offerId: string; ozonProductId: string; ozonSku: string }> = [];
  for (let index = 0; index < expectedOfferIds.length; index += 1) {
    const offerId = expectedOfferIds[index]!;
    const candidate = incoming[index];
    const persisted = authority.mappings.find((mapping) => mapping.offerId === offerId);
    const link = authority.job.ozonProductLinks.find((entry) => entry.offerId === offerId);
    const snapshot = recordValue(candidate?.statusSnapshot);
    const persistedSnapshot = recordValue(persisted?.statusSnapshot);
    const expectedStock = Number(contract.expectedOfferSnapshots[index]?.stock);
    if (!candidate || candidate.offerId !== offerId || !persisted || !link
      || candidate.ozonProductId !== persisted.ozonProductId || candidate.ozonProductId !== link.ozonProductId
      || String(candidate.ozonSku || '') !== String(persisted.ozonSku || '')
      || String(candidate.ozonSku || '') !== String(link.ozonSku || '')
      || persisted.storeAlias !== authority.job.storeAlias || persisted.sku !== authority.job.sku
      || persisted.lastAppliedRevision !== Number(authority.job.revision || 0)
      || candidate.platformStatus !== 'ON_SALE' || persisted.status !== 'ON_SALE'
      || snapshot.displayState !== 'ON_SALE' || snapshot.businessState !== 'PUBLISHED'
      || snapshot.hasStock !== true || Number(snapshot.stockPresent) !== expectedStock
      || String(snapshot.readAt || '') !== readAt
      || persistedSnapshot.displayState !== 'ON_SALE' || persistedSnapshot.businessState !== 'PUBLISHED'
      || persistedSnapshot.hasStock !== true || Number(persistedSnapshot.stockPresent) !== expectedStock
      || !Number.isInteger(expectedStock) || expectedStock < 0) return undefined;
    output.push({ offerId, ozonProductId: candidate.ozonProductId, ozonSku: String(candidate.ozonSku) });
  }
  return output;
}

function normalizedInput(
  source: OzonRuntimeUpdateInput,
  attestation: OzonRfbsStockReadbackAttestation
): OzonRuntimeUpdateInput {
  const readAt = attestation.readAt;
  const payload = recordValue(source.payload);
  const jobPayload = recordValue(source.jobPayload);
  const final = recordValue(jobPayload.finalConsistencyRecovery);
  const stripStockWarnings = (value: unknown) => Array.isArray(value)
    ? value.filter((entry) => {
        const warning = typeof entry === 'string' ? entry : String(recordValue(entry).code || '');
        return !warning.startsWith('OZON_STOCK_DIFFERENCE');
      })
    : [];
  return {
    ...source,
    state: 'SUCCEEDED',
    eventType: OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT,
    message: 'OZON rFBS 权威库存读回已复验，已修正旧解析器仓库过滤误判',
    errorCode: undefined,
    errorMessage: undefined,
    platformStatus: 'PUBLISHED',
    nextAttemptAt: null,
    offerIds: attestation.offers.map((offer) => offer.offerId),
    stageStates: { ...(source.stageStates || {}), stock: 'VERIFIED' },
    payload: {
      ...payload,
      warnings: [],
      rfbsStockReadbackNormalized: true,
      rfbsStockReadbackExecutionId: attestation.executionId
    },
    jobPayload: {
      ...jobPayload,
      platformStatusWarnings: stripStockWarnings(jobPayload.platformStatusWarnings),
      finalConsistencyRecovery: {
        ...final,
        phase: 'VERIFIED',
        confirmationCount: 0,
        nextConfirmAt: null,
        fingerprint: '',
        affectedOffers: [],
        verifiedAt: readAt,
        lastReadback: { readAt, consistent: true }
      },
      rfbsStockReadbackNormalization: {
        schemaVersion: 1,
        workflowId: attestation.workflowId,
        executionId: attestation.executionId,
        checkedAt: attestation.checkedAt,
        callbackHash: attestation.callbackHash,
        offerIds: attestation.offers.map((offer) => offer.offerId)
      }
    },
    productMappings: (source.productMappings || []).map((mapping) => ({
      ...mapping,
      platformStatus: 'ON_SALE',
      statusSnapshot: {
        ...recordValue(mapping.statusSnapshot),
        warnings: stripStockWarnings(recordValue(mapping.statusSnapshot).warnings)
      }
    })),
    rfbsStockReadbackAttestation: attestation
  };
}

function frozenContract(job: OzonPublishJob): {
  offerContractHash: string;
  expectedOfferIds: string[];
  expectedOfferSnapshots: Record<string, unknown>[];
} | undefined {
  const payload = recordValue(job.payload);
  const expectedOfferIds = strictStringArray(payload.expectedOfferIds);
  const submittedOfferIds = strictStringArray(payload.submittedOfferIds);
  const publishOfferIds = strictStringArray(payload.publishOfferIds);
  const snapshots = recordArray(payload.expectedOfferSnapshots);
  if (payload.offerContractVersion !== 1 || !expectedOfferIds.length || !submittedOfferIds.length
    || stableJson(submittedOfferIds) !== stableJson(publishOfferIds)
    || stableJson(job.offerIds) !== stableJson(expectedOfferIds)
    || snapshots.length !== expectedOfferIds.length
    || snapshots.some((snapshot, index) => String(snapshot.offerId || '') !== expectedOfferIds[index])) return undefined;
  const body = {
    offerContractVersion: 1,
    expectedOfferIds,
    submittedOfferIds,
    publishOfferIds,
    expectedOfferSnapshots: snapshots
  };
  const hash = `sha256:${createHash('sha256').update(stableJson(body)).digest('hex')}`;
  if (String(payload.offerContractHash || '') !== hash) return undefined;
  return { offerContractHash: hash, expectedOfferIds, expectedOfferSnapshots: snapshots };
}

function sameContract(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return ['offerContractVersion', 'offerContractHash', 'expectedOfferIds', 'submittedOfferIds', 'publishOfferIds', 'expectedOfferSnapshots']
    .every((key) => stableJson(left[key]) === stableJson(right[key]));
}

function samePreparedContract(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return ['expectedOfferIds', 'submittedOfferIds', 'publishOfferIds', 'expectedOfferSnapshots']
    .every((key) => stableJson(left[key]) === stableJson(right[key]));
}

function sameOptionalJobBinding(actual: unknown, expected: unknown): boolean {
  return String(actual || '') === String(expected || '');
}

function executionNodeItems(execution: Record<string, unknown>, nodeName: string): Record<string, unknown>[] {
  const runData = recordValue(recordValue(recordValue(execution.data).resultData).runData);
  const runs = Array.isArray(runData[nodeName]) ? runData[nodeName] : [];
  return runs.flatMap((run) => {
    const branches = recordValue(recordValue(run).data).main;
    return Array.isArray(branches)
      ? branches.flatMap((branch) => Array.isArray(branch)
        ? branch.map((item) => recordValue(recordValue(item).json)).filter((item) => Object.keys(item).length)
        : [])
      : [];
  });
}

function exactOperationMap(
  items: Record<string, unknown>[],
  operations: string[],
  field: string
): Map<string, Record<string, unknown>> | undefined {
  const output = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const operation = String(item[field] || '');
    if (!operations.includes(operation) || output.has(operation)) return undefined;
    output.set(operation, item);
  }
  return output.size === operations.length ? output : undefined;
}

function exactOfferItems(
  body: Record<string, unknown>,
  expectedIds: string[],
  idField: string
): Map<string, Record<string, unknown>> | undefined {
  const result = recordValue(body.result);
  const candidates = [body.items, result.items, body.result].filter(Array.isArray) as unknown[][];
  if (candidates.length !== 1) return undefined;
  const items = candidates[0]!.map(recordValue);
  const ids = items.map((item) => String(item[idField] || ''));
  if (items.some((item) => !Object.keys(item).length)
    || new Set(ids).size !== ids.length
    || stableJson([...ids].sort()) !== stableJson([...expectedIds].sort())) return undefined;
  return new Map(items.map((item) => [String(item[idField]), item]));
}

function hasSingleWarehouseIdentity(row: Record<string, unknown>): boolean {
  return [row.warehouse_id, row.warehouseId, recordValue(row.source).warehouse_id]
    .some((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function callbackHash(input: OzonRuntimeUpdateInput): string {
  return `sha256:${createHash('sha256').update(stableJson(stripAttestation(input))).digest('hex')}`;
}

function stripAttestation(input: OzonRuntimeUpdateInput): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...input };
  delete rest.rfbsStockReadbackAttestation;
  return rest;
}

function canonicalDate(value: unknown): string | undefined {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function shanghaiDate(value: unknown): string | undefined {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp)
    ? new Date(timestamp + 8 * 60 * 60_000).toISOString().slice(0, 10)
    : undefined;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(timestamp).toISOString().slice(0, 10) === value;
}

function strictStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values = value.map((entry) => String(entry || '').trim());
  return values.length && values.every(Boolean) && new Set(values).size === values.length ? values : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((entry) => Object.keys(entry).length) : [];
}

function recordValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
