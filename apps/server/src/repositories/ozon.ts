import { createHash, randomUUID } from 'node:crypto';
import { validOzonPrePlanAbsenceOperations } from '../ozon-preplan-absence.js';
import { ozonPreparationGatewayBoundaryLockKey } from '../ozon-preparation-gateway-boundary.js';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import {
  AppError,
  canonicalOzonSharedMaterialJson,
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_VERSION,
  OZON_SHARED_MATERIAL_HASH_VERSION,
  hasOzonCjk,
  ozonAutoJobCanCancel,
  ozonJobHasLocalGenerationClaim,
  validateOzonDescription,
  findUncoveredOzonPresetRequiredAttributes,
  projectOzonPresetRequiredAttributeCoverage,
  ozonCategoryAttributeOrderInputSchema,
  ozonCategorySizeAttributeCandidates,
  ozonCategoryKeySchema,
  type OzonCatalogEntry,
  type OzonCatalogDictionaryName,
  type OzonCatalogDictionaryValue,
  type OzonCatalogSyncRun,
  type OzonCatalogTrigger,
  type OzonCategoryAttribute,
  ozonCategoryTemplateInputSchema,
  ozonListingDraftInputSchema,
  ozonLegacyPresetInputSchema,
  ozonPresetInputSchema,
  ozonPresetUpdateSchema,
  isOzonSequentialVariantCode,
  ozonProductUrl,
  OZON_TITLE_TRANSLATION_WORKFLOW_ID,
  stableOzonOfferId,
  synchronizeOzonListingDescriptionPolicyWarnings,
  ozonSystemSettingsInputSchema,
  projectOzonSharedMaterialDraft,
  type OzonAutoPresetBinding,
  type OzonCategoryTemplate,
  type OzonCategoryAttributeOrderInput,
  type OzonCategoryTemplateInput,
  type OzonCategoryVersion,
  type OzonGrossWeightResolution,
  type OzonListingDraft,
  type OzonListingDraftInput,
  type OzonListingManagementSource,
  type OzonNetworkRecovery,
  type OzonPreparationManualSuccessReconcileResult,
  type OzonPreparationManualSuccessReconcileTarget,
  type OzonPreset,
  type OzonPresetInput,
  type OzonPlatformBusinessState,
  type OzonPlatformOfferStatus,
  type OzonProductLink,
  type OzonProductMapping,
  type OzonProductMappingInput,
  type OzonPublishEvent,
  type OzonPublishJob,
  type OzonPublishJobState,
  type OzonTaskDirectoryStage,
  type OzonSystemSettings,
  type ProductVariant
} from '@n8n-media-review/shared';
import {
  enforceOzonProductTypeAttribute,
  enforceOzonSkuIdentity
} from '../utils/ozon-sku-identity.js';
import { readOzonGrossWeightResolution as readStoredOzonGrossWeightResolution } from '../services/ozon-gross-weight.js';
import {
  assertOzonRfbsStockNormalizationAttestation,
  OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT,
  type OzonRfbsNormalizationAuthority,
  type OzonRfbsStockReadbackAttestation
} from '../services/ozon-publishing/rfbs-stock-callback.js';

type SqlRow = Record<string, any>;
type OzonLegacyPreset = OzonPreset & {
  autoPublishEnabled: boolean;
  autoPublishMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  autoPublishActivatedAt?: string;
  fulfillmentMode: 'FBS' | 'RFBS';
  warehouseId: string;
  currency: 'RUB' | 'CNY';
  isDefault: boolean;
};

export type OzonCatalogEntryInput = Omit<OzonCatalogEntry, 'catalogEntryId' | 'active' | 'missingSyncCount' | 'updatedAt'>;
export type OzonCatalogDictionaryValueInput = Omit<OzonCatalogDictionaryValue, 'itemKey'> & { position: number };

export type OzonCatalogOverview = {
  entryCount: number;
  chineseMissingCount: number;
  dictionaryCounts: Record<OzonCatalogDictionaryName, number>;
  currentRun?: OzonCatalogSyncRun;
  latestRun?: OzonCatalogSyncRun;
  lastSuccessfulAt?: string;
};

export type OzonJobListInput = {
  page?: number;
  pageSize?: number;
  query?: string;
  state?: string;
  purchaseCreatedFrom?: string;
  purchaseCreatedTo?: string;
  source?: 'MANUAL' | 'AUTO';
  sku?: string;
  remoteOnly?: boolean;
  activeOnly?: boolean;
  businessOnly?: boolean;
};

export type OzonRuntimeJobListInput = Pick<
  OzonJobListInput,
  'page' | 'pageSize' | 'query' | 'state' | 'remoteOnly'
>;

export type OzonJobTransitionInput = {
  rowVersion: number;
  state: OzonPublishJobState;
  eventType: string;
  message: string;
  payload?: Record<string, unknown>;
  stageStates?: Record<string, string>;
  taskId?: string;
  importTaskId?: string;
  ozonProductId?: string;
  errorCode?: string;
  errorMessage?: string;
  jobPayload?: Record<string, unknown>;
  nextAttemptAt?: string | null;
  incrementRetry?: boolean;
  offerIds?: string[];
  storeAlias?: string;
  taskFolder?: string;
  workRelPath?: string;
  directoryStage?: OzonTaskDirectoryStage;
  directorySignature?: string;
  revision?: number;
  auditSuppressed?: boolean;
  leaseOwner?: string;
  leaseToken?: string;
  clearLease?: boolean;
  networkRecovery?: OzonNetworkRecovery | null;
};

export type OzonAutomaticSharedMaterialPersistenceInput = {
  jobId: string;
  jobRowVersion: number;
  sku: string;
  productName: string;
  expectedListingRowVersion?: number;
  data: OzonListingDraft['data'];
  mediaSignature: string;
  offerIds: string[];
};

export type OzonAutomaticPreparationRecoveryEvidence = {
  publicationCount: number;
  mappingCount: number;
  gatewayRequestCount: number;
  productLinkCount: number;
  importIntentPresent: boolean;
  platformWriteAttempted: boolean;
  activeLease: boolean;
  activeSlot: boolean;
  activeStatusRefresh: boolean;
};

export const OZON_AUTOMATIC_REPLAN_MEDIA_REBIND_SQL = `UPDATE ozon_media_deliveries SET
  job_id=$2::uuid,
  payload=payload || jsonb_build_object(
    'replanOwnershipHistory',
    (CASE WHEN jsonb_typeof(payload->'replanOwnershipHistory')='array'
      THEN payload->'replanOwnershipHistory' ELSE '[]'::jsonb END)
    || jsonb_build_array(jsonb_build_object(
      'schemaVersion',1,
      'fromPreparationJobId',$1::uuid::text,
      'toPreparationJobId',$2::uuid::text,
      'requestId',$4::text,
      'planHash',$5::text,
      'evidenceHash',$6::text,
      'reboundAt',$7::text
    ))
  ),
  updated_at=NOW()
  WHERE job_id=$1::uuid AND sku=$3::text
    AND COALESCE(payload->>'autoPublishDecision','') IN ('ACCEPTED','DEFERRED')`;

export type OzonAutomaticPreparationReplanEvidence = {
  safe: boolean;
  blockers: string[];
  evidenceHash: string;
  originalJobId: string;
  originalJobRowVersion: number;
  originalFanoutPlanHash: string;
  publicationIds: string[];
  publicationJobIds: string[];
  storeIds: string[];
  publicationCount: number;
  publicationJobCount: number;
  gatewayRequestCount: number;
  mappingCount: number;
  productLinkCount: number;
  mediaDeliveryCount: number;
  activeLeaseCount: number;
  activeSlotCount: number;
  activeStatusRefreshCount: number;
};

export type OzonAutomaticPreparationReplanTarget = {
  id: string;
  rowVersion: number;
  configVersion: number;
  credentialVersionId: string;
  presetId: string;
  presetRowVersion: number;
  presetDefinitionHash: string;
  presetSnapshotHash: string;
  publicationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  warehouseId: string;
  fulfillmentMode: 'FBS' | 'RFBS';
  accountCurrency: 'RUB' | 'CNY';
  expectedOfferIds: string[];
  categoryKey: string;
  expectedPublishedCategoryVersionId: string;
  /** Dry-run raw snapshot audit; r2 identity fields intentionally make the worker raw hash differ. */
  expectedProductSnapshotHash: string;
  /** Replacement-identity-neutral product contract enforced by the worker. */
  expectedProductContractHash: string;
  expectedModeEvidenceHash: string;
};

export type OzonAutomaticPreparationReplanApplyInput = {
  jobId: string;
  expectedJobRowVersion: number;
  requestId: string;
  planHash: string;
  expectedEvidenceHash: string;
  expectedFanoutPlanHash: string;
  expectedListingRowVersion: number;
  expectedListingRevision: number;
  expectedGeneratedVersionId: string;
  expectedMaterialHash: string;
  expectedDataSignature: string;
  /** Audit source only: r2 intentionally changes generatedVersionId/revision and therefore the raw plan hash. */
  expectedCurrentPlanHash: string;
  /** Identity-neutral semantic CAS enforced again by the r2 worker before freeze. */
  expectedPlanContractHash: string;
  expectedSettingsRowVersion: number;
  expectedRootDirectoryHash: string;
  expectedVariantColorAuthorityHash: string;
  targetStores: OzonAutomaticPreparationReplanTarget[];
};

export type OzonPrePlanRecoveryRearmInput = {
  jobId: string;
  expectedJobRowVersion: number;
  sku: string;
  requestId: string;
  planHash: string;
  expectedListingRowVersion: number;
  expectedListingRevision: number;
  expectedProductIdentity: {
    sku: string;
    productName: string;
    variants: ProductVariant[];
  };
  expectedMediaDeliveries: Array<{
    sourceStageId: string;
    submissionId: string;
    variantId?: string;
    jobId: string;
    deliveredAt: string;
    payloadHash: string;
    updatedAt: string;
  }>;
  expectedManifestSignature: string;
  expectedEligibilityAt: string;
  targetStores: Array<{
    id: string;
    rowVersion: number;
    configVersion: number;
    credentialVersionId: string;
    presetId: string;
    presetRowVersion: number;
    presetDefinitionHash: string;
    presetSnapshotHash: string;
    publicationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
    warehouseId: string;
    fulfillmentMode: 'FBS' | 'RFBS';
    accountCurrency: 'RUB' | 'CNY';
    expectedOfferIds: string[];
  }>;
  recoveryEvidence: Record<string, unknown>;
};

export type OzonRuntimeUpdateInput = OzonJobTransitionInput & {
  offerId?: string;
  ozonSku?: string;
  warehouseId?: string;
  lastAppliedRevision?: number;
  platformStatus?: string;
  productMappings?: OzonProductMappingInput[];
  /** Set only by OzonPublishingService after reading the bound P002 execution. */
  rfbsStockReadbackAttestation?: OzonRfbsStockReadbackAttestation;
};

export type OzonRuntimeLeaseInput = {
  leaseOwner: string;
  leaseToken: string;
  rowVersion: number;
  leaseSeconds?: number;
};

export type OzonRuntimeClaimInput = {
  leaseOwner: string;
  leaseSeconds?: number;
  remoteOnly?: boolean;
  states?: OzonPublishJobState[];
};

export type OzonAutomaticMediaDeliveryResult = {
  job: OzonPublishJob | undefined;
  becameRunnable: boolean;
  deferred: boolean;
};

export type OzonDeferredAutomaticMediaDelivery = {
  sku: string;
  sourceStageId: 'E004' | 'E005';
  submissionId: string;
  variantId: string;
  payload: Record<string, unknown>;
};

export type OzonAutomaticMediaDeliveryEvidence = {
  sourceStageId: 'E004' | 'E005';
  submissionId: string;
  variantId: string;
  deliveredAt: string;
  decision: 'ACCEPTED' | 'DEFERRED' | 'FANNED_OUT';
  jobId?: string;
  payloadHash: string;
  updatedAt: string;
};

export type OzonCompatibleAppendPreparedArtifact = {
  signature: string;
  productJsonPath: string;
  readyMarker: string;
  taskFolder: string;
  workRelPath: string;
};

export type OzonCompatibleAppendManualJobInput = {
  sku: string;
  rowVersion: number;
  listingData: Omit<OzonListingDraftInput, 'rowVersion'>;
  storeAlias?: string;
  state: 'WAITING_MEDIA';
  planHash: string;
  manifestSignature: string;
  expectedSettingsRowVersion: number;
  expectedRootDirectory: string;
  expectedStoreAlias: string;
  expectedProductIdentityHash: string;
  expectedProductName: string;
  expectedProductVariants: Array<{ variantId: string; name: string }>;
  expectedPresetId: string;
  expectedPresetRowVersion: number;
  expectedCategoryVersionId: string;
  offerContractVersion: 1;
  offerContractHash: string;
  expectedOfferSnapshots: Record<string, unknown>[];
  preservedOfferIds: string[];
  submittedOfferIds: string[];
  expectedOfferIds: string[];
  remoteAbsenceEvidence: Record<string, unknown>;
};

export type OzonCompatibleAppendReadiness = {
  activePlatformStatusRefreshLease?: { leaseOwner: string; leaseExpiresAt: string };
  activeRuntimeJobLease?: { jobId: string; leaseOwner: string; leaseExpiresAt: string };
  occupiedPublishSlot?: { jobId: string; leaseOwner: string; leaseExpiresAt: string };
};

export type OzonAcceptedMediaRecoveryDeliveryInput = {
  sourceStageId: 'E004' | 'E005';
  submissionId: string;
  variantId: string;
  payload: Record<string, unknown>;
  expectedUpdatedAt: string;
  expectedPayloadHash: string;
};

export type OzonAcceptedMediaRecoveryContract = {
  schemaVersion: 1;
  productName: string;
  settingsBinding: {
    rowVersion: number;
    defaultStoreAlias: string;
    rootDirectoryHash: string;
  };
  presetBinding: {
    presetId: string;
    presetRowVersion: number;
    definitionHash: string;
  };
  sourceJobSnapshot: {
    jobId: string;
    rowVersion: number;
    payloadHash: string;
  };
  manifestSignature: string;
  manifestContentSha256: string;
  selectedFilesSignature: string;
  variants: Array<{
    variantId: string;
    variantName: string;
    offerId: string;
    disposition: 'RETAINED' | 'CANDIDATE';
  }>;
  deliveryIdentities: Array<
    Pick<OzonAcceptedMediaRecoveryDeliveryInput, 'sourceStageId' | 'submissionId' | 'variantId'>
  >;
};

export type OzonAcceptedMediaRecoveryPrepareInput = {
  sku: string;
  expectedSettingsRowVersion: number;
  expectedPresetId: string;
  expectedPresetRowVersion: number;
  expectedListingRowVersion: number;
  expectedListingRevision: number;
  recoveredFromJobId: string;
  expectedSourceJobRowVersion: number;
  retainedMappings: Array<{ offerId: string; ozonProductId: string; ozonSku: string }>;
  candidateOfferIds: string[];
  deliveries: OzonAcceptedMediaRecoveryDeliveryInput[];
  recoveryContract: OzonAcceptedMediaRecoveryContract;
  platformPreflight: Record<string, unknown>;
};

export type OzonAcceptedMediaRecoveryWriteGuardInput = {
  jobId: string;
  expectedJobRowVersion: number;
  expectedListingRowVersion: number;
  manifestSignature: string;
};

export type OzonAcceptedMediaRecoveryLedgerRepairInput = {
  sku: string;
  jobId: string;
  expectedJobRowVersion: number;
  expectedSettingsRowVersion: number;
  expectedPresetId: string;
  expectedPresetRowVersion: number;
  expectedListingRowVersion: number;
  retainedMappings: Array<{ offerId: string; ozonProductId: string; ozonSku: string }>;
  candidateOfferIds: string[];
  recoveryContract: OzonAcceptedMediaRecoveryContract;
  platformPreflight: Record<string, unknown>;
  expectedLedgerAudit: { rowCount: number; hash: string };
};

type TargetedAcceptedMediaRecoveryTarget = Readonly<{
  sku: '0000105' | '0000106';
  recoveredFromJobId: string;
  retainedMapping: Readonly<{ offerId: string; ozonProductId: string; ozonSku: string }>;
  candidateOfferIds: readonly string[];
  variants: readonly Readonly<{
    variantId: string;
    variantName: string;
    offerId: string;
    disposition: 'RETAINED' | 'CANDIDATE';
  }>[];
  deliveryIdentities: readonly Readonly<{
    sourceStageId: 'E004' | 'E005';
    submissionId: string;
    variantId: string;
  }>[];
}>;

const OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS: Readonly<Record<'0000105' | '0000106', TargetedAcceptedMediaRecoveryTarget>> = Object.freeze({
  '0000105': Object.freeze({
    sku: '0000105',
    recoveredFromJobId: '50bff6f2-9801-4080-8183-2b37b4953d13',
    retainedMapping: Object.freeze({ offerId: '0000105-01', ozonProductId: '5874416999', ozonSku: '5395936600' }),
    candidateOfferIds: Object.freeze(['0000105-02', '0000105-03']),
    variants: Object.freeze([
      Object.freeze({ variantId: 'aeac212e-12d7-4b9f-a7b5-520eefe5769b', variantName: '黑色', offerId: '0000105-02', disposition: 'CANDIDATE' }),
      Object.freeze({ variantId: '07905c8b-ac00-4571-8856-f34ed6ac796c', variantName: '深酒红色', offerId: '0000105-03', disposition: 'CANDIDATE' }),
      Object.freeze({ variantId: 'c6da4f0b-776b-4b5d-a776-65b155d8cd0a', variantName: '卡其色', offerId: '0000105-01', disposition: 'RETAINED' })
    ]),
    deliveryIdentities: Object.freeze([
      Object.freeze({ sourceStageId: 'E004', submissionId: '61555e72-c849-4dfb-aa12-e8e0de5ad47f', variantId: 'aeac212e-12d7-4b9f-a7b5-520eefe5769b' }),
      Object.freeze({ sourceStageId: 'E005', submissionId: '091b8cdd-5ed1-4f6f-afe0-d98f2f86382a', variantId: 'aeac212e-12d7-4b9f-a7b5-520eefe5769b' }),
      Object.freeze({ sourceStageId: 'E004', submissionId: 'e2696ebe-119d-4154-b80c-7cd515db4dcd', variantId: '07905c8b-ac00-4571-8856-f34ed6ac796c' }),
      Object.freeze({ sourceStageId: 'E005', submissionId: '9df7c080-8d69-4c0b-b9d8-bbff832c5b91', variantId: '07905c8b-ac00-4571-8856-f34ed6ac796c' })
    ])
  }),
  '0000106': Object.freeze({
    sku: '0000106',
    recoveredFromJobId: 'd7938c88-500d-4b75-914c-4602e1640ca3',
    retainedMapping: Object.freeze({ offerId: '0000106-01', ozonProductId: '5875509673', ozonSku: '5396882480' }),
    candidateOfferIds: Object.freeze(['0000106-02', '0000106-03']),
    variants: Object.freeze([
      Object.freeze({ variantId: 'ccc8a28f-72b8-4288-b13b-de8a78c33762', variantName: '黑色', offerId: '0000106-02', disposition: 'CANDIDATE' }),
      Object.freeze({ variantId: 'fb622886-856d-4f0a-af67-9695346c6ba4', variantName: '红色', offerId: '0000106-01', disposition: 'RETAINED' }),
      Object.freeze({ variantId: 'fe02d646-5ee6-423d-8162-656d459c8393', variantName: '绿色', offerId: '0000106-03', disposition: 'CANDIDATE' })
    ]),
    deliveryIdentities: Object.freeze([
      Object.freeze({ sourceStageId: 'E004', submissionId: '48988890-a882-4119-96aa-efa60d1a8db2', variantId: 'ccc8a28f-72b8-4288-b13b-de8a78c33762' }),
      Object.freeze({ sourceStageId: 'E005', submissionId: 'e2722365-c719-489a-a2d2-aa98c48d42d3', variantId: 'ccc8a28f-72b8-4288-b13b-de8a78c33762' }),
      Object.freeze({ sourceStageId: 'E004', submissionId: 'afd9a501-0a5a-407f-b336-66203c1b3f79', variantId: 'fe02d646-5ee6-423d-8162-656d459c8393' }),
      Object.freeze({ sourceStageId: 'E005', submissionId: '034f27a9-cfff-4676-8704-d7f964a43d85', variantId: 'fe02d646-5ee6-423d-8162-656d459c8393' })
    ])
  })
});

export type OzonAcceptedMediaRecoveryReleaseInput = {
  sku: string;
  jobId: string;
  holdToken: string;
  expectedJobRowVersion: number;
  expectedSettingsRowVersion: number;
  expectedPresetId: string;
  expectedPresetRowVersion: number;
  expectedListingRowVersion: number;
  retainedMappings: Array<{ offerId: string; ozonProductId: string; ozonSku: string }>;
  candidateOfferIds: string[];
  deliveries: Array<Pick<
    OzonAcceptedMediaRecoveryDeliveryInput,
    'sourceStageId' | 'submissionId' | 'variantId' | 'expectedUpdatedAt' | 'expectedPayloadHash'
  >>;
  recoveryContract: OzonAcceptedMediaRecoveryContract;
  platformPreflight: Record<string, unknown>;
};

export const OZON_KNOWN_PRE_PLATFORM_FAILURE_REASONS = [
  'IMPORT_INTENT_URL_MISSING',
  'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
  'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200'
] as const;

export type OzonKnownPrePlatformFailureReason = typeof OZON_KNOWN_PRE_PLATFORM_FAILURE_REASONS[number];

export type OzonKnownPrePlatformFailureRecoveryInput = {
  reason: OzonKnownPrePlatformFailureReason;
  rowVersion: number;
  listingRowVersion?: number;
  dryRun: boolean;
};

export type OzonKnownPrePlatformFailureRecoveryChecks = {
  remoteState: {
    status: 'CONFIRMED_EMPTY' | 'NOT_APPLICABLE';
    offerIds: string[];
    checkedAt: string;
    infoItemCount?: number;
    attributeItemCount?: number;
    // Optional for historical recovery audit rows written before productStatus v2.
    contractVersion?: 2;
    requestedOfferIds?: string[];
    operations?: Array<{
      operation: 'infoList' | 'attributesInfo';
      requestId: 'productStatus:infoList' | 'productStatus:attributesInfo';
      ok: true;
      upstreamOk: boolean;
      statusCode: 200 | 404;
      outcome: 'EMPTY' | 'PRESENT' | 'NOT_FOUND';
      resultShape: 'ARRAY' | 'NOT_FOUND_ERROR';
      itemCount: number;
      errorCode?: '5';
    }>;
    absenceEvidence?: {
      method: 'BOTH_ARRAYS_EMPTY' | 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND';
      infoList: {
        statusCode: 200;
        resultShape: 'ARRAY';
        itemCount: 0;
      };
      attributesInfo: {
        statusCode: 200 | 404;
        resultShape: 'ARRAY' | 'NOT_FOUND_ERROR';
        itemCount: 0;
        errorCode?: '5';
      };
    };
  };
  productJson: {
    status: 'MATCHED' | 'NOT_APPLICABLE';
    checkedAt: string;
    expectedSignature?: string;
  };
  contentPolicy?: {
    status: 'MATCHED';
    policyVersion: 'merchroute-ozon-content-v2' | 'merchroute-ozon-content-v3';
    legacyFalsePositive: true;
  };
};

export type OzonKnownPrePlatformFailureRecoveryResult = {
  status: 'DRY_RUN' | 'RECOVERED' | 'ALREADY_RECOVERED';
  reason: OzonKnownPrePlatformFailureReason;
  dryRun: boolean;
  previous: {
    jobRowVersion: number;
    listingRowVersion?: number;
  };
  proposed: {
    jobState: OzonPublishJobState;
    listingState?: OzonListingDraft['status'];
    retryCount: number;
    titleTranslationMaxLength?: number;
    presetBindingDefinitionHash?: string;
  };
  checks?: OzonKnownPrePlatformFailureRecoveryChecks;
  job: OzonPublishJob;
  listing?: OzonListingDraft;
};

export const OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON = 'MIN_PRICE_WRITE_OMITTED_V1' as const;

export type OzonKnownPostPlatformMinPriceRecoveryInput = {
  reason: typeof OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON;
  rowVersion: number;
  listingRowVersion: number;
  dryRun: boolean;
};

export type OzonKnownPostPlatformMinPriceRecoveryChecks = {
  remoteProducts: {
    status: 'MATCHED';
    checkedAt: string;
    requestedOfferIds: string[];
    mappings: Array<{
      offerId: string;
      ozonProductId: string;
      ozonSku: string;
    }>;
  };
  pricesRead: {
    status: 'ONLY_MIN_PRICE_MISSING';
    checkedAt: string;
    offers: Array<{
      offerId: string;
      expected: { price: number; oldPrice: number | null; minPrice: number; currency: string };
      actual: { price: number; oldPrice: number | null; minPrice: 0; currency: string };
    }>;
  };
  productJson: {
    status: 'MATCHED';
    checkedAt: string;
    expectedSignature: string;
    resolvedDirectoryStage: 'PROCESSING' | 'SUCCESS';
    resolvedWorkRelPath: string;
    resolvedWorkDirectory: string;
    resolvedProductJsonPath: string;
    location: 'PERSISTED' | 'UNIQUE_ORPHAN_SUCCESS';
  };
  routing: {
    resumeState: 'IMPORTING';
    schedulerMode: 'RECONCILE_IMPORT';
    importProductReachable: false;
  };
};

export type OzonKnownPostPlatformMinPriceRecoveryResult = {
  status: 'DRY_RUN' | 'RECOVERED' | 'ALREADY_RECOVERED';
  reason: typeof OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON;
  dryRun: boolean;
  previous: {
    jobRowVersion: number;
    listingRowVersion: number;
  };
  proposed: {
    jobState: 'IMPORTING';
    listingState: 'SUBMITTING';
    schedulerMode: 'RECONCILE_IMPORT';
    pendingPriceOfferIds: string[];
    preservedStockOfferIds: string[];
    workRelPath: string;
    directoryStage: 'PROCESSING' | 'SUCCESS';
  };
  checks?: OzonKnownPostPlatformMinPriceRecoveryChecks;
  job: OzonPublishJob;
  listing: OzonListingDraft;
};

type KnownPostPlatformMinPriceTarget = {
  jobId: string;
  sku: string;
  importTaskId: string;
  revision: 2;
  directorySignature: `sha256:${string}`;
  offerIds: readonly string[];
  jobState: 'NEEDS_ATTENTION' | 'MODERATING';
  listingState: 'NEEDS_ATTENTION' | 'MODERATING';
  persistedMappings: readonly Readonly<{
    offerId: string;
    ozonProductId: string;
    ozonSku: string;
  }>[];
  finalConsistencyPhase: 'FAILED' | 'CONFIRMING' | 'ABSENT';
  finalConsistencyConfirmationCount: number;
  priceStage: 'DIFFERENCE' | 'WRITE_ACCEPTED';
};

const OZON_KNOWN_POST_PLATFORM_MIN_PRICE_TARGETS: Readonly<Record<string, KnownPostPlatformMinPriceTarget>> = Object.freeze({
  '50bff6f2-9801-4080-8183-2b37b4953d13': Object.freeze({
    jobId: '50bff6f2-9801-4080-8183-2b37b4953d13',
    sku: '0000105',
    importTaskId: '5352371389',
    revision: 2,
    directorySignature: 'sha256:bfcf86588bd3829c857a3409d4e8a9dfdd6e33d5f751f5fd04584ea92ae7b96d',
    offerIds: Object.freeze(['0000105-01']),
    jobState: 'NEEDS_ATTENTION',
    listingState: 'NEEDS_ATTENTION',
    persistedMappings: Object.freeze([Object.freeze({
      offerId: '0000105-01',
      ozonProductId: '5874416999',
      ozonSku: '5395936600'
    })]),
    finalConsistencyPhase: 'FAILED',
    finalConsistencyConfirmationCount: 3,
    priceStage: 'DIFFERENCE'
  }),
  'd7938c88-500d-4b75-914c-4602e1640ca3': Object.freeze({
    jobId: 'd7938c88-500d-4b75-914c-4602e1640ca3',
    sku: '0000106',
    importTaskId: '5353120098',
    revision: 2,
    directorySignature: 'sha256:b3f0b0c2746ced7bceaa392772a5009d4699779b29524e8ba9f4c3664bc68e05',
    offerIds: Object.freeze(['0000106-01']),
    jobState: 'MODERATING',
    listingState: 'MODERATING',
    persistedMappings: Object.freeze([Object.freeze({
      offerId: '0000106-01',
      ozonProductId: '5875509673',
      ozonSku: '5396882480'
    })]),
    finalConsistencyPhase: 'CONFIRMING',
    finalConsistencyConfirmationCount: 2,
    priceStage: 'DIFFERENCE'
  }),
  '7c525f2c-a52c-475c-b8f5-a99ab61b348f': Object.freeze({
    jobId: '7c525f2c-a52c-475c-b8f5-a99ab61b348f',
    sku: '0000107',
    importTaskId: '5353123776',
    revision: 2,
    directorySignature: 'sha256:c4f827b34bbd344370d5209e4321a10a7ec4a83b11741e2aac53a43c6091b771',
    offerIds: Object.freeze(['0000107-01', '0000107-02', '0000107-03']),
    jobState: 'MODERATING',
    listingState: 'MODERATING',
    persistedMappings: Object.freeze([]),
    finalConsistencyPhase: 'ABSENT',
    finalConsistencyConfirmationCount: 0,
    priceStage: 'WRITE_ACCEPTED'
  })
});

export type OzonPlatformStatusRefreshLease = {
  leaseToken: string;
  leaseExpiresAt: string;
  listing: OzonListingDraft;
  job?: OzonPublishJob;
  storeAlias: string;
  offerIds: string[];
  mappings: OzonProductMapping[];
};

export type OzonPlatformStatusRefreshCommit = {
  leaseToken: string;
  listingRowVersion: number;
  jobRowVersion?: number;
  readAt: string;
  businessState: OzonPlatformBusinessState;
  offers: OzonPlatformOfferStatus[];
  warnings: string[];
  stageStates: Record<string, string>;
  jobState?: OzonPublishJobState;
  errorCode?: string;
  errorMessage?: string;
  archive?: {
    revision: number;
    taskFolder: string;
    workRelPath: string;
    directorySignature: string;
    videoCacheCleanedAt: string;
  };
};

const ACTIVE_JOB_STATES: OzonPublishJobState[] = [
  'WAITING_MEDIA',
  'READY',
  'UPLOADING_MEDIA',
  'SUBMITTING',
  'IMPORTING',
  'VERIFYING_IMAGES',
  'UPDATING_PRICE',
  'UPDATING_STOCK',
  'MODERATING',
  'NEEDS_ATTENTION'
];

const RUNTIME_ADVANCEABLE_JOB_STATES: OzonPublishJobState[] = [
  'READY',
  'UPLOADING_MEDIA',
  'SUBMITTING',
  'IMPORTING',
  'VERIFYING_IMAGES',
  'UPDATING_PRICE',
  'UPDATING_STOCK',
  'MODERATING'
];

function ozonBusinessJobPredicate(alias: string): string {
  return `COALESCE(NULLIF(${alias}.task_kind,''),CASE
      WHEN COALESCE(${alias}.payload->>'multistorePreparation','false')='true' THEN 'SHARED_PREPARATION'
      WHEN ${alias}.publication_id IS NOT NULL THEN 'STORE_PUBLICATION'
      ELSE 'LEGACY' END
    )<>'SHARED_PREPARATION'`;
}

const OZON_RUNTIME_SLOT_KEY = 'OZON_WRITE';
const OZON_RUNTIME_LEASE_SECONDS = 600;
const HISTORICAL_NETWORK_ERROR_CODES = [
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
  'N8N_DISPATCH_FAILED', 'OZON_NETWORK_ERROR', 'OZON_REQUEST_TIMEOUT', 'OZON_RESPONSE_MISSING',
  'OZON_UPSTREAM_HTTP_408', 'OZON_UPSTREAM_HTTP_429', 'OZON_UPSTREAM_HTTP_500',
  'OZON_UPSTREAM_HTTP_502', 'OZON_UPSTREAM_HTTP_503', 'OZON_UPSTREAM_HTTP_504'
];

const LOCAL_ONLY_STAGE_STATES = new Set(['PENDING', 'WAITING_LOCAL', 'LOCAL_READY', 'PARTIAL']);
const PLATFORM_OFFER_DISPLAY_STATES = new Set([
  'ON_SALE', 'MODERATING', 'OUT_OF_STOCK', 'NOT_FOR_SALE', 'ERROR', 'HIDDEN', 'ARCHIVED', 'NOT_FOUND', 'UNKNOWN'
]);

export class OzonRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}

  get configured(): boolean {
    return Boolean(this.pool);
  }

  async initialize(): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 5, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await this.migrate();
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async initializeExistingSchema(): Promise<void> {
    if (!this.connectionString || this.pool) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 2, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query(`SELECT 1 FROM ozon_schema_migrations LIMIT 1`);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async getSettings(): Promise<OzonSystemSettings> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_system_settings WHERE id = $1', ['default']);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 系统配置不存在', undefined, 404);
    return toSettings(result.rows[0]);
  }

  async updateSettings(input: unknown): Promise<OzonSystemSettings> {
    const parsed = ozonSystemSettingsInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const value = parsed.data;
    const result = await this.query<SqlRow>(`
      UPDATE ozon_system_settings
      SET enabled=$2,root_directory=$3,task_api_webhook_url=$4,
          admin_api_webhook_url=$5,preflight_webhook_url=$6,image_uploader_workflow_id=$7,
          store_gateway_workflow_id=$8,image_upload_concurrency=$9,video_upload_concurrency=$10,
          video_prewarm_enabled=$11,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$12
      RETURNING *`,
    [
      'default',
      value.enabled,
      value.rootDirectory,
      value.taskApiWebhookUrl,
      value.adminApiWebhookUrl,
      value.preflightWebhookUrl,
      value.imageUploaderWorkflowId,
      value.storeGatewayWorkflowId,
      value.imageUploadConcurrency,
      value.videoUploadConcurrency,
      value.videoPrewarmEnabled,
      value.rowVersion
    ]);
    if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 系统配置已被其他操作更新，请刷新后重试', undefined, 409);
    return toSettings(result.rows[0]);
  }

  async savePreflight(input: {
    credentialReady: boolean;
    sellerId?: string;
    sellerName?: string;
    accountCurrency?: string;
    status: 'READY' | 'FAILED';
    message?: string;
  }): Promise<OzonSystemSettings> {
    void input;
    throw new AppError('CONFIG_INVALID', '全局 OZON 凭据预检已移除，请在 OZON上品设置的店铺管理中执行连接检查', undefined, 410);
  }

  async saveVideoUploadProbe(input: { ready: boolean; message?: string }): Promise<OzonSystemSettings> {
    const result = await this.query<SqlRow>(`
      UPDATE ozon_system_settings
      SET video_upload_ready=$2,video_upload_checked_at=NOW(),video_upload_message=$3,
          row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    ['default', input.ready, input.message || null]);
    return toSettings(result.rows[0]!);
  }

  async listListings(input: { page?: number; pageSize?: number; query?: string; status?: string; source?: OzonListingManagementSource | 'ALL'; purchaseCreatedFrom?: string; purchaseCreatedTo?: string }): Promise<{ items: OzonListingDraft[]; total: number; page: number; pageSize: number }> {
    const page = finitePage(input.page);
    const pageSize = finitePageSize(input.pageSize);
    const purchaseDateRange = normalizePurchaseCreatedDateRange(input);
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (input.query?.trim()) {
      values.push(`%${input.query.trim()}%`);
      predicates.push(`(d.sku ILIKE $${values.length} OR d.product_name_snapshot ILIKE $${values.length})`);
    }
    if (input.status?.trim()) {
      values.push(input.status.trim());
      predicates.push(`d.status = $${values.length}`);
    }
    if (input.source && input.source !== 'ALL') {
      values.push(input.source);
      predicates.push(`d.management_source = $${values.length}`);
    }
    if (purchaseDateRange.purchaseCreatedFrom) {
      values.push(purchaseDateRange.purchaseCreatedFrom);
      predicates.push(`p.created_at >= $${values.length}::timestamptz`);
    }
    if (purchaseDateRange.purchaseCreatedTo) {
      values.push(purchaseDateRange.purchaseCreatedTo);
      predicates.push(`p.created_at < $${values.length}::timestamptz`);
    }
    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const from = `FROM ozon_listing_drafts d
      LEFT JOIN products p ON p.sku=d.sku
      LEFT JOIN LATERAL (
        SELECT id,material_hash,material_hash_version,content_policy_version,source_media_identity_hash,snapshot FROM ozon_listing_versions
        WHERE sku=d.sku AND revision=d.revision ORDER BY created_at DESC LIMIT 1
      ) current_version ON TRUE`;
    const count = await this.query<{ count: string }>(`SELECT COUNT(*) count ${from} ${where}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`SELECT d.*,current_version.id generated_version_id,
      current_version.material_hash,current_version.material_hash_version,current_version.content_policy_version,
      current_version.source_media_identity_hash,
      current_version.snapshot generated_version_snapshot ${from} ${where}
      ORDER BY d.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    const items = rows.rows.map(toListing);
    const linksBySku = await this.productLinksBySku(items.map((item) => item.sku));
    return { items: items.map((item) => ({ ...item, ozonProductLinks: linksBySku.get(item.sku) || [] })), total: Number(count.rows[0]?.count || 0), page, pageSize };
  }

  async getListing(sku: string): Promise<OzonListingDraft> {
    const result = await this.query<SqlRow>(`SELECT d.*,v.id generated_version_id,v.material_hash,
      v.material_hash_version,v.content_policy_version,v.source_media_identity_hash,v.snapshot generated_version_snapshot
      FROM ozon_listing_drafts d LEFT JOIN LATERAL (
        SELECT id,material_hash,material_hash_version,content_policy_version,source_media_identity_hash,snapshot FROM ozon_listing_versions
        WHERE sku=d.sku AND revision=d.revision ORDER BY created_at DESC LIMIT 1
      ) v ON TRUE WHERE d.sku=$1`, [normalizeSku(sku)]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
    const listing = toListing(result.rows[0]);
    const links = await this.productLinksBySku([listing.sku]);
    return { ...listing, ozonProductLinks: links.get(listing.sku) || [] };
  }

  async acquirePlatformStatusRefresh(
    skuInput: string,
    listingRowVersion: number,
    leaseSeconds = 300
  ): Promise<OzonPlatformStatusRefreshLease> {
    const sku = normalizeSku(skuInput);
    const ttl = Math.min(600, Math.max(30, Math.floor(Number(leaseSeconds) || 300)));
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
      if (Number(listingRow.row_version) !== listingRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新页面后重试', {
          sku,
          expected: Number(listingRow.row_version),
          actual: listingRowVersion
        }, 409);
      }
      const offerIds = normalizeOfferIds(listingRow.data?.offers?.map((offer: Record<string, unknown>) => offer.offerId));
      if (!offerIds.length) throw new AppError('CONFIG_INVALID', 'OZON 草稿没有可查询的平台 offer_id', { sku }, 409);
      const taskResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs
        WHERE sku=$1
        ORDER BY
          CASE WHEN state=ANY($2::text[]) THEN 0
               WHEN id::text=COALESCE($3,'') THEN 1
               ELSE 2 END,
          updated_at DESC,id DESC
        LIMIT 1
        FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES, listingRow.last_task_id || null]);
      const jobRow = taskResult.rows[0];
      const storeAlias = requiredStoreAlias(jobRow?.store_alias || 'default');
      await client.query(`DELETE FROM ozon_platform_status_refresh_leases
        WHERE lease_expires_at<=NOW() AND (sku=$1 OR ($2::uuid IS NOT NULL AND job_id=$2::uuid))`,
      [sku, jobRow?.id || null]);
      const existing = await client.query<SqlRow>(`
        SELECT * FROM ozon_platform_status_refresh_leases
        WHERE (sku=$1 OR ($2::uuid IS NOT NULL AND job_id=$2::uuid)) AND lease_expires_at>NOW()
        ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [sku, jobRow?.id || null]);
      if (existing.rows[0]) {
        throw new AppError('OZON_STATUS_REFRESH_IN_PROGRESS', 'OZON 平台状态正在刷新，请稍后重试', {
          sku,
          jobId: existing.rows[0].job_id || undefined,
          leaseExpiresAt: iso(existing.rows[0].lease_expires_at)
        }, 409);
      }
      const leaseToken = randomUUID();
      const leaseResult = await client.query<SqlRow>(`
        INSERT INTO ozon_platform_status_refresh_leases(
          sku,job_id,lease_token,listing_row_version,job_row_version,lease_expires_at
        ) VALUES($1,$2,$3,$4,$5,NOW()+make_interval(secs=>$6))
        RETURNING *`,
      [sku, jobRow?.id || null, leaseToken, Number(listingRow.row_version), jobRow ? Number(jobRow.row_version) : null, ttl]);
      const mappingsResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_product_mappings
        WHERE store_alias=$1 AND sku=$2 AND offer_id=ANY($3::text[])
        ORDER BY offer_id`,
      [storeAlias, sku, offerIds]);
      return {
        leaseToken,
        leaseExpiresAt: iso(leaseResult.rows[0]!.lease_expires_at),
        listing: toListing(listingRow),
        ...(jobRow ? { job: toJob(jobRow) } : {}),
        storeAlias,
        offerIds,
        mappings: mappingsResult.rows.map(toProductMapping)
      };
    });
  }

  async renewPlatformStatusRefresh(leaseToken: string, leaseSeconds = 300): Promise<string> {
    const ttl = Math.min(600, Math.max(30, Math.floor(Number(leaseSeconds) || 300)));
    const result = await this.query<SqlRow>(`
      UPDATE ozon_platform_status_refresh_leases
      SET lease_expires_at=NOW()+make_interval(secs=>$2),updated_at=NOW()
      WHERE lease_token=$1::uuid AND lease_expires_at>NOW()
      RETURNING lease_expires_at`,
    [leaseToken, ttl]);
    if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 平台状态刷新租约已失效，请重新刷新', undefined, 409);
    return iso(result.rows[0].lease_expires_at);
  }

  async assertPlatformStatusRefreshNotLeased(skuInput: string, jobId?: string, allowedToken?: string): Promise<void> {
    const sku = normalizeSku(skuInput);
    const result = await this.query<SqlRow>(`
      SELECT lease_token,lease_expires_at FROM ozon_platform_status_refresh_leases
      WHERE sku=$1 AND lease_expires_at>NOW() LIMIT 1`,
    [sku]);
    const row = result.rows[0];
    if (!row || (allowedToken && String(row.lease_token) === allowedToken)) return;
    throw new AppError('OZON_STATUS_REFRESH_IN_PROGRESS', 'OZON 平台状态刷新正在占用该 SKU/任务，请稍后重试', {
      sku,
      jobId,
      leaseExpiresAt: iso(row.lease_expires_at)
    }, 409);
  }

  async releasePlatformStatusRefresh(leaseToken: string): Promise<boolean> {
    const result = await this.query('DELETE FROM ozon_platform_status_refresh_leases WHERE lease_token=$1::uuid', [leaseToken]);
    return Boolean(result.rowCount);
  }

  async failPlatformStatusRefresh(
    skuInput: string,
    leaseToken: string,
    input: { code: string; message: string }
  ): Promise<boolean> {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const leaseResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_platform_status_refresh_leases
        WHERE sku=$1 AND lease_token=$2::uuid FOR UPDATE`,
      [sku, leaseToken]);
      const lease = leaseResult.rows[0];
      if (!lease) return false;
      if (lease.job_id) {
        const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [lease.job_id]);
        const job = jobResult.rows[0];
        if (job) {
          const reasonHash = statusRefreshReasonHash('FAILED', [{ code: input.code, message: input.message }]);
          await addEventThrottled(
            client,
            String(job.id),
            'OZON_PLATFORM_STATUS_REFRESH_FAILED',
            String(job.state),
            String(job.state),
            'OZON 平台状态刷新失败，已保留原状态',
            { code: input.code, message: input.message, reasonHash },
            reasonHash
          );
        }
      }
      await client.query('DELETE FROM ozon_platform_status_refresh_leases WHERE sku=$1 AND lease_token=$2::uuid', [sku, leaseToken]);
      return true;
    });
  }

  async commitPlatformStatusRefresh(
    skuInput: string,
    input: OzonPlatformStatusRefreshCommit
  ): Promise<{ listing: OzonListingDraft; job?: OzonPublishJob; mappings: OzonProductMapping[]; changed: boolean }> {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const leaseResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_platform_status_refresh_leases
        WHERE sku=$1 AND lease_token=$2::uuid AND lease_expires_at>NOW()
        FOR UPDATE`,
      [sku, input.leaseToken]);
      const lease = leaseResult.rows[0];
      if (!lease) throw new AppError('TASK_LOCKED', 'OZON 平台状态刷新租约已失效，请重新刷新', { sku }, 409);
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
      if (Number(listingRow.row_version) !== Number(lease.listing_row_version)
        || Number(listingRow.row_version) !== input.listingRowVersion) {
        throw new AppError('TASK_LOCKED', '刷新期间 OZON 草稿已变化，平台结果未写入', {
          sku,
          expected: Number(lease.listing_row_version),
          actual: Number(listingRow.row_version)
        }, 409);
      }
      const expectedOfferIds = normalizeOfferIds(listingRow.data?.offers?.map((offer: Record<string, unknown>) => offer.offerId));
      const suppliedOfferIds = normalizeOfferIds(input.offers.map((offer) => offer.offerId));
      const missingOfferIds = expectedOfferIds.filter((offerId) => !suppliedOfferIds.includes(offerId));
      const unexpectedOfferIds = suppliedOfferIds.filter((offerId) => !expectedOfferIds.includes(offerId));
      if (!expectedOfferIds.length || missingOfferIds.length || unexpectedOfferIds.length) {
        throw new AppError('VERIFY_FAILED', 'OZON 平台状态返回的 offer_id 与当前草稿不一致', {
          sku, expectedOfferIds, missingOfferIds, unexpectedOfferIds
        }, 409);
      }
      let jobRow: SqlRow | undefined;
      if (lease.job_id) {
        const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [lease.job_id]);
        jobRow = jobResult.rows[0];
        if (!jobRow || String(jobRow.sku) !== sku) {
          throw new AppError('TASK_LOCKED', '刷新绑定的 OZON 任务已不存在或 SKU 不匹配', { sku, jobId: lease.job_id }, 409);
        }
        const expectedJobRowVersion = input.jobRowVersion ?? Number(lease.job_row_version);
        if (Number(jobRow.row_version) !== Number(lease.job_row_version)
          || Number(jobRow.row_version) !== expectedJobRowVersion) {
          throw new AppError('TASK_LOCKED', '刷新期间 OZON 任务已变化，平台结果未写入', {
            sku,
            jobId: String(jobRow.id),
            expected: Number(lease.job_row_version),
            actual: Number(jobRow.row_version)
          }, 409);
        }
        if (ACTIVE_JOB_STATES.includes(String(jobRow.state) as OzonPublishJobState) && input.jobState) {
          const stateChanged = String(input.jobState) !== String(jobRow.state);
          const stagesChanged = stableJson(input.stageStates || {}) !== stableJson(jobRow.stage_states || {});
          const errorChanged = String(input.errorCode || '') !== String(jobRow.last_error_code || '')
            || String(input.errorMessage || '') !== String(jobRow.last_error_message || '');
          if (stateChanged || stagesChanged || errorChanged || input.archive) {
            throw new AppError(
              'CONFIG_INVALID',
              'OZON 平台状态刷新只能回读映射与展示状态，活动任务必须由 P002 逐 Offer 最终验收推进',
              {
                sku,
                jobId: String(jobRow.id),
                currentState: String(jobRow.state),
                proposedState: String(input.jobState),
                stateChanged,
                stagesChanged,
                errorChanged,
                archiveRequested: Boolean(input.archive)
              },
              409
            );
          }
        }
      }
      const storeAlias = requiredStoreAlias(jobRow?.store_alias || 'default');
      const mappings: OzonProductMapping[] = [];
      let mappingChanged = false;
      for (const offer of input.offers) {
        const snapshot = platformOfferStatusSnapshot(offer);
        const previousResult = await client.query<SqlRow>(`
          SELECT * FROM ozon_product_mappings WHERE store_alias=$1 AND offer_id=$2 FOR UPDATE`,
        [storeAlias, offer.offerId]);
        const previous = previousResult.rows[0];
        if (!previous
          || String(previous.status || '') !== offer.displayState
          || String(previous.ozon_product_id || '') !== String(offer.ozonProductId || previous.ozon_product_id || '')
          || String(previous.ozon_sku || '') !== String(offer.ozonSku || previous.ozon_sku || '')
          || stableJson(platformOfferStatusMeaning(previous.status_snapshot || {}))
            !== stableJson(platformOfferStatusMeaning(snapshot))) mappingChanged = true;
        const mappingResult = await client.query<SqlRow>(`
          INSERT INTO ozon_product_mappings(
            store_alias,offer_id,sku,ozon_product_id,ozon_sku,last_applied_revision,status,status_snapshot,last_verified_at,updated_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz,NOW())
          ON CONFLICT(store_alias,offer_id) DO UPDATE SET
            sku=EXCLUDED.sku,
            ozon_product_id=COALESCE(EXCLUDED.ozon_product_id,ozon_product_mappings.ozon_product_id),
            ozon_sku=COALESCE(EXCLUDED.ozon_sku,ozon_product_mappings.ozon_sku),
            last_applied_revision=GREATEST(ozon_product_mappings.last_applied_revision,EXCLUDED.last_applied_revision),
            status=EXCLUDED.status,
            status_snapshot=EXCLUDED.status_snapshot,
            last_verified_at=EXCLUDED.last_verified_at,
            updated_at=NOW()
          RETURNING *`,
        [
          storeAlias,
          offer.offerId,
          sku,
          offer.ozonProductId || null,
          offer.ozonSku || null,
          Number(listingRow.revision || 0),
          offer.displayState,
          JSON.stringify(snapshot),
          input.readAt
        ]);
        mappings.push(toProductMapping(mappingResult.rows[0]!));
      }
      const productLinks = orderProductLinks(mappings.flatMap(productLinkFromMapping), expectedOfferIds);
      const listingErrorCode = input.businessState === 'NEEDS_ATTENTION'
        ? input.errorCode || 'OZON_PLATFORM_STATUS_NEEDS_ATTENTION'
        : null;
      const listingErrorMessage = input.businessState === 'NEEDS_ATTENTION'
        ? input.errorMessage || 'OZON 平台商品状态需要处理'
        : null;
      const listingChanged = String(listingRow.status) !== input.businessState
        || String(listingRow.last_error_code || '') !== String(listingErrorCode || '')
        || String(listingRow.last_error_message || '') !== String(listingErrorMessage || '');
      const updatedListingResult = listingChanged
        ? await client.query<SqlRow>(`
            UPDATE ozon_listing_drafts
            SET status=$2,last_error_code=$3,last_error_message=$4,row_version=row_version+1,updated_at=NOW()
            WHERE sku=$1 RETURNING *`,
          [sku, input.businessState, listingErrorCode, listingErrorMessage])
        : { rows: [listingRow] } as QueryResult<SqlRow>;
      let updatedJob: OzonPublishJob | undefined;
      let jobChanged = false;
      if (jobRow && input.jobState) {
        const terminal = input.jobState === 'SUCCEEDED';
        const payload = {
          ...(jobRow.payload || {}),
          platformStatusRefresh: {
            readAt: input.readAt,
            businessState: input.businessState,
            offers: input.offers,
            warnings: input.warnings
          },
          ...(input.archive ? { videoCacheCleanedAt: input.archive.videoCacheCleanedAt } : {})
        };
        const updatedJobResult = await client.query<SqlRow>(`
          UPDATE ozon_publish_jobs SET
            state=$2,stage_states=$3::jsonb,last_error_code=$4,last_error_message=$5,
            payload=$6::jsonb,product_links=$7::jsonb,offer_ids=$8::jsonb,
            ozon_product_id=COALESCE($9,ozon_product_id),
            finished_at=CASE WHEN $10 THEN NOW() ELSE NULL END,
            next_attempt_at=CASE WHEN $10 OR $2='NEEDS_ATTENTION' THEN NULL ELSE next_attempt_at END,
            task_folder=COALESCE($11,task_folder),work_rel_path=COALESCE($12,work_rel_path),
            directory_stage=COALESCE($13,directory_stage),directory_signature=COALESCE($14,directory_signature),
            listing_revision=GREATEST(listing_revision,$15),row_version=row_version+1,updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [
          jobRow.id,
          input.jobState,
          JSON.stringify(input.stageStates),
          input.errorCode || null,
          input.errorMessage || null,
          JSON.stringify(sanitizePersistentJobPayload(payload)),
          JSON.stringify(productLinks),
          JSON.stringify(expectedOfferIds),
          productLinks[0]?.ozonProductId || null,
          terminal,
          input.archive?.taskFolder || null,
          input.archive?.workRelPath || null,
          input.archive ? 'SUCCESS' : null,
          input.archive?.directorySignature || null,
          Math.max(0, Number(input.archive?.revision || listingRow.revision || 0))
        ]);
        const eventType = input.jobState === 'SUCCEEDED' && String(jobRow.state) !== 'SUCCEEDED'
          ? 'OZON_PLATFORM_STATUS_RECONCILED'
          : input.jobState === 'NEEDS_ATTENTION' && String(jobRow.state) !== 'NEEDS_ATTENTION'
            ? 'OZON_PLATFORM_STATUS_DOWNGRADED'
            : 'OZON_PLATFORM_STATUS_REFRESHED';
        const reasonHash = statusRefreshReasonHash(input.businessState, input.offers.map((offer) => ({
          offerId: offer.offerId,
          displayState: offer.displayState,
          missingConfirmationCount: offer.missingConfirmationCount
        })));
        await addEventThrottled(
          client,
          String(jobRow.id),
          eventType,
          String(jobRow.state),
          input.jobState,
          eventType === 'OZON_PLATFORM_STATUS_RECONCILED'
            ? 'OZON 平台状态刷新确认全部变体已发布'
            : eventType === 'OZON_PLATFORM_STATUS_DOWNGRADED'
              ? 'OZON 平台状态刷新确认商品需要处理'
              : 'OZON 平台状态刷新已完成',
          { readAt: input.readAt, businessState: input.businessState, warnings: input.warnings, reasonHash },
          reasonHash
        );
        updatedJob = toJob(updatedJobResult.rows[0]!);
        jobChanged = String(jobRow.state) !== input.jobState
          || stableJson(jobRow.stage_states || {}) !== stableJson(input.stageStates)
          || stableJson(normalizeProductLinks(jobRow.product_links)) !== stableJson(productLinks);
      } else if (jobRow) {
        const reasonHash = statusRefreshReasonHash(input.businessState, input.offers.map((offer) => ({
          offerId: offer.offerId,
          displayState: offer.displayState,
          missingConfirmationCount: offer.missingConfirmationCount
        })));
        await addEventThrottled(
          client,
          String(jobRow.id),
          'OZON_PLATFORM_STATUS_REFRESHED',
          String(jobRow.state),
          String(jobRow.state),
          'OZON 平台状态刷新已完成，历史任务状态保持不变',
          { readAt: input.readAt, businessState: input.businessState, warnings: input.warnings, reasonHash },
          reasonHash
        );
        updatedJob = toJob(jobRow);
      }
      await client.query('DELETE FROM ozon_platform_status_refresh_leases WHERE sku=$1 AND lease_token=$2::uuid', [sku, input.leaseToken]);
      return {
        listing: { ...toListing(updatedListingResult.rows[0]!), ozonProductLinks: productLinks },
        ...(updatedJob ? { job: updatedJob } : {}),
        mappings,
        changed: listingChanged || mappingChanged || jobChanged
      };
    });
  }

  async reserveSubmissionRevision(skuInput: string, rowVersion: number): Promise<OzonListingDraft> {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      await assertNoActivePlatformStatusRefreshLease(client, sku);
      const current = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
      if (Number(row.row_version) !== rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请刷新后重新生成', {
          sku,
          expected: Number(row.row_version),
          actual: rowVersion
        }, 409);
      }
      assertOzonGrossWeightLinkage(
        row.data,
        sku,
        '毛重由采购管理/上架预设联动管理；当前包装毛重或单位与联动快照不一致，不能生成 product.json'
      );
      const existingRound = await client.query<{ exists: boolean }>(`
        SELECT EXISTS(
          SELECT 1 FROM ozon_publish_jobs WHERE sku=$1 AND listing_revision=$2
        ) AS exists`,
      [sku, Number(row.revision)]);
      if (!existingRound.rows[0]?.exists) return toListing(row);
      const revision = Number(row.revision) + 1;
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_listing_drafts
        SET revision=$2,row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 RETURNING *`,
      [sku, revision]);
      const version = await insertSharedMaterialVersion(client, { ...updated.rows[0], data: row.data });
      return withSharedMaterialVersion(updated.rows[0]!, version);
    });
  }

  async createListing(
    identity: { sku: string; productName: string },
    _preset?: OzonPreset,
    initializedData: Partial<OzonListingDraft['data']> = {}
  ): Promise<OzonListingDraft> {
    const sku = normalizeSku(identity.sku);
    const productName = String(identity.productName || '').trim();
    if (!productName) throw new AppError('CONFIG_INVALID', '商品名称不能为空');
    const baseData = {
      fulfillmentMode: 'FBS' as const,
      warehouseId: '',
      vat: '0.2' as const,
      titleRu: '',
      descriptionRu: '',
      brand: '',
      sharedAttributes: [],
      offers: [],
      mediaAssets: [],
      mediaSourceRoot: '',
      videoUploadMode: 'COMPRESSED_COPY',
      ...initializedData,
      // A manual shared draft is authored in CNY. Store-specific materialization
      // still selects each store's frozen contract currency at publish time.
      currency: 'CNY' as const
    };
    const normalizedData = enforceOzonSkuIdentity(baseData as OzonListingDraft['data'], sku);
    assertOzonGrossWeightLinkage(
      normalizedData,
      sku,
      '毛重联动初始化数据无效，请重新初始化 OZON 上品资料'
    );
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const existing = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      if (existing.rows[0]) {
        const currentVersion = await client.query<SqlRow>(`SELECT id,material_hash,material_hash_version,content_policy_version,source_media_identity_hash,snapshot
          FROM ozon_listing_versions WHERE sku=$1 AND revision=$2 ORDER BY created_at DESC LIMIT 1`,
        [sku, Number(existing.rows[0].revision)]);
        if (!currentVersion.rows[0]) {
          throw new AppError('VERSION_CONFLICT', '当前 OZON 公共素材缺少可证明的稳定版本，不能补造历史 revision', {
            sku,
            revision: Number(existing.rows[0].revision),
            recovery: 'CREATE_NEXT_REAL_REVISION'
          }, 409);
        }
        if (String(existing.rows[0].product_name_snapshot) === productName) {
          return withSharedMaterialVersion(existing.rows[0], currentVersion.rows[0]);
        }
        const nextRevision = Number(existing.rows[0].revision) + 1;
        const updated = await client.query<SqlRow>(`UPDATE ozon_listing_drafts SET
          product_name_snapshot=$2,revision=$3,row_version=row_version+1,updated_at=NOW()
          WHERE sku=$1 RETURNING *`, [sku, productName, nextRevision]);
        const version = await insertSharedMaterialVersion(client, updated.rows[0]!);
        return withSharedMaterialVersion(updated.rows[0]!, version);
      }
      const created = await client.query<SqlRow>(`
        INSERT INTO ozon_listing_drafts(sku,product_name_snapshot,management_source,status,row_version,revision,data)
        VALUES($1,$2,'MANUAL','DRAFT',1,1,$3::jsonb)
        RETURNING *`,
      [sku, productName, JSON.stringify(normalizedData)]);
      const version = await insertSharedMaterialVersion(client, created.rows[0]!);
      return withSharedMaterialVersion(created.rows[0]!, version);
    });
  }

  async createListingIfAbsent(
    identity: { sku: string; productName: string },
    _preset?: OzonPreset,
    initializedData: Partial<OzonListingDraft['data']> = {}
  ): Promise<OzonListingDraft> {
    const sku = normalizeSku(identity.sku);
    const productName = String(identity.productName || '').trim();
    if (!productName) throw new AppError('CONFIG_INVALID', '商品名称不能为空');
    const baseData = {
      fulfillmentMode: 'FBS' as const,
      warehouseId: '',
      currency: 'CNY' as const,
      vat: '0.2' as const,
      titleRu: '',
      descriptionRu: '',
      brand: '',
      sharedAttributes: [],
      offers: [],
      mediaAssets: [],
      mediaSourceRoot: '',
      videoUploadMode: 'COMPRESSED_COPY',
      ...initializedData
    };
    const normalizedData = enforceOzonSkuIdentity(baseData as OzonListingDraft['data'], sku);
    assertOzonGrossWeightLinkage(
      normalizedData,
      sku,
      '毛重联动初始化数据无效，请重新初始化 OZON 上品资料'
    );
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const result = await client.query<SqlRow>(`
        INSERT INTO ozon_listing_drafts(sku,product_name_snapshot,management_source,status,row_version,revision,data)
        VALUES($1,$2,'AUTO','DRAFT',1,1,$3::jsonb)
        ON CONFLICT(sku) DO NOTHING
        RETURNING *`,
      [sku, productName, JSON.stringify(normalizedData)]);
      if (!result.rows[0]) {
        throw new AppError(
          'TASK_LOCKED',
          'OZON 草稿已被其他操作并发创建，自动流程不会覆盖',
          { sku, reasonCode: 'OZON_LISTING_CREATED_CONCURRENTLY' },
          409
        );
      }
      const version = await insertSharedMaterialVersion(client, result.rows[0]);
      return withSharedMaterialVersion(result.rows[0], version);
    });
  }

  async updateListing(
    skuInput: string,
    input: unknown,
    options: {
      preserveGeneratedSources?: boolean;
      allowGrossWeightInitialization?: boolean;
      allowGrossWeightRefresh?: boolean;
      allowPricingResolutionRefresh?: boolean;
    } = {}
  ): Promise<OzonListingDraft> {
    const parsed = ozonListingDraftInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const sku = normalizeSku(skuInput);
    const synchronizedData = synchronizeOzonListingDescriptionPolicyWarnings(parsed.data);
    const { rowVersion, ...rawParsedData } = synchronizedData;
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      await assertNoActivePlatformStatusRefreshLease(client, sku);
      const current = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
      if (Number(current.rows[0].row_version) !== rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿已被其他操作更新，请刷新后重试', { sku, expected: current.rows[0].row_version, actual: rowVersion }, 409);
      }
      const currentData = current.rows[0].data;
      const currentResolution = readOzonGrossWeightResolution(currentData, sku);
      if (currentResolution) {
        assertManagedOzonDimensionsMatch(
          jsonObject(currentData).dimensions,
          currentResolution,
          sku,
          '毛重由采购管理/上架预设联动管理；当前包装毛重或单位与联动快照不一致，请重新初始化 OZON 上品资料'
        );
      }
      const sourceAwareData = options.preserveGeneratedSources
        ? rawParsedData
        : markChangedOzonDescriptionsManual(currentData, rawParsedData);
      const protectedData = protectOzonGrossWeightLinkage(
        currentData,
        sourceAwareData,
        sku,
        options.allowGrossWeightInitialization === true,
        options.allowGrossWeightRefresh === true,
        options.allowPricingResolutionRefresh === true || options.preserveGeneratedSources === true
      );
      const parsedData = normalizeOzonListingDescriptions(protectedData);
      const categoryIdentity = await listingCategoryIdentity(client, parsedData);
      const data = enforceOzonSkuIdentity(
        parsedData,
        sku,
        categoryIdentity.attributes,
        categoryIdentity.typeId
      );
      const currentOffers = Array.isArray(current.rows[0].data?.offers) ? current.rows[0].data.offers as Array<{ variantId?: string; variantCode?: string; offerId?: string }> : [];
      const existingOffers = new Map(currentOffers.map((offer) => [offer.variantId, offer]));
      const variantCodes = new Set<string>();
      const offerIds = new Set<string>();
      for (const offer of data.offers) {
        if (variantCodes.has(offer.variantCode)) throw new AppError('CONFIG_INVALID', '同一商品的稳定变体编码不能重复', { variantCode: offer.variantCode }, 409);
        if (offerIds.has(offer.offerId)) throw new AppError('CONFIG_INVALID', '同一商品的 offer_id 不能重复', { offerId: offer.offerId }, 409);
        variantCodes.add(offer.variantCode);
        offerIds.add(offer.offerId);
        const existing = existingOffers.get(offer.variantId);
        if (existing?.offerId && offer.offerId !== existing.offerId) {
          throw new AppError('CONFIG_INVALID', 'offer_id 保存后不可修改', {
            sku,
            variantId: offer.variantId,
            expectedOfferId: existing.offerId,
            actualOfferId: offer.offerId
          }, 409);
        }
        if (existing?.variantCode && offer.variantCode !== existing.variantCode) {
          throw new AppError('CONFIG_INVALID', '稳定变体编码保存后不可修改', {
            sku,
            variantId: offer.variantId,
            expectedVariantCode: existing.variantCode,
            actualVariantCode: offer.variantCode
          }, 409);
        }
        if (!existing && !isOzonSequentialVariantCode(offer.variantCode)) {
          throw new AppError('CONFIG_INVALID', '新增变体编码必须是 01–99 的两位正整数', { sku, variantCode: offer.variantCode }, 409);
        }
        const expectedOfferId = stableOzonOfferId(sku, offer.variantCode);
        if (!existing && offer.offerId !== expectedOfferId) {
          throw new AppError('CONFIG_INVALID', 'offer_id 必须由 SKU 与稳定变体编码生成', {
            sku,
            variantId: offer.variantId,
            expectedOfferId,
            actualOfferId: offer.offerId
          }, 409);
        }
      }
      const revision = Number(current.rows[0].revision) + 1;
      const status = listingReady(data) ? 'READY' : 'DRAFT';
      const result = await client.query<SqlRow>(`
        UPDATE ozon_listing_drafts
        SET data=$2::jsonb,status=$3,row_version=row_version+1,revision=$4,last_error_code=NULL,last_error_message=NULL,updated_at=NOW()
        WHERE sku=$1 RETURNING *`,
      [sku, JSON.stringify(data), status, revision]);
      const version = await insertSharedMaterialVersion(client, { ...result.rows[0], data });
      return withSharedMaterialVersion(result.rows[0]!, version);
    });
  }

  /**
   * Persists an AUTO shared-material revision and its preparation-job marker in
   * one transaction.  The SKU advisory lock plus row-version checks make a
   * committed marker the idempotency boundary: a crash can leave either both
   * rows visible or neither, never an orphan listing version that causes the
   * next worker run to allocate another revision.
   */
  async persistAutomaticSharedMaterialRevision(
    input: OzonAutomaticSharedMaterialPersistenceInput
  ): Promise<{ listing: OzonListingDraft & { dataSignature: string }; job: OzonPublishJob }> {
    const sku = normalizeSku(input.sku);
    const productName = String(input.productName || '').trim();
    if (!productName) throw new AppError('CONFIG_INVALID', '商品名称不能为空');
    if (!/^sha256:[a-f0-9]{64}$/.test(String(input.mediaSignature || ''))) {
      throw new AppError('CONFIG_INVALID', 'OZON 自动公共素材缺少冻结媒体签名', { sku }, 409);
    }
    const parsed = ozonListingDraftInputSchema.safeParse({ ...input.data, rowVersion: input.expectedListingRowVersion || 1 });
    if (!parsed.success) throw validationError(parsed.error.issues);
    const synchronizedData = synchronizeOzonListingDescriptionPolicyWarnings(parsed.data);
    const { rowVersion: _parsedRowVersion, ...parsedData } = synchronizedData;
    void _parsedRowVersion;
    const data = enforceOzonSkuIdentity(
      normalizeOzonListingDescriptions(parsedData),
      sku
    );
    const offerIds = normalizeOfferIds(input.offerIds);
    if (offerIds.length !== input.offerIds.length
      || stableJson(offerIds) !== stableJson(data.offers.map((offer) => offer.offerId))) {
      throw new AppError('CONFIG_INVALID', 'OZON 自动公共素材的 Offer 身份不一致', {
        sku,
        expectedOfferIds: offerIds,
        actualOfferIds: data.offers.map((offer) => offer.offerId)
      }, 409);
    }
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const jobRow = jobResult.rows[0];
      if (!jobRow || String(jobRow.sku) !== sku || String(jobRow.source) !== 'AUTO'
        || String(jobRow.task_kind) !== 'SHARED_PREPARATION'
        || jsonObject(jobRow.payload).multistorePreparation !== true) {
        throw new AppError('VERSION_CONFLICT', 'OZON 自动任务不是可写入公共素材的共享准备任务', {
          jobId: input.jobId,
          sku
        }, 409);
      }
      if (Number(jobRow.row_version) !== input.jobRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务已变化，请刷新后重试', {
          jobId: input.jobId,
          expectedRowVersion: input.jobRowVersion,
          actualRowVersion: Number(jobRow.row_version)
        }, 409);
      }
      if (!['WAITING_MEDIA', 'READY'].includes(String(jobRow.state))) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务当前状态不能生成公共素材', {
          jobId: input.jobId,
          state: String(jobRow.state)
        }, 409);
      }
      if (jobRow.import_task_id || jobRow.ozon_product_id
        || jsonObject(jobRow.payload).platformWriteAttempted === true
        || ['PROCESSING', 'SUCCESS'].includes(String(jobRow.directory_stage || '').toUpperCase())) {
        throw new AppError('OZON_READBACK_REQUIRED', 'OZON 自动准备任务已有平台写入证据，禁止重生成公共素材', {
          jobId: input.jobId
        }, 409);
      }

      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const current = listingResult.rows[0];
      await assertOzonPrePlanPersistenceAuthoritiesWithClient({
        client,
        job: jobRow,
        listing: current,
        sku,
        mediaSignature: input.mediaSignature,
        proposedProductName: productName,
        proposedData: data
      });
      let persistedRow: SqlRow;
      if (current) {
        if (String(current.management_source) !== 'AUTO') {
          throw new AppError('TASK_LOCKED', 'SKU 已有人工维护的 OZON 公共素材，自动流程不会覆盖', { sku }, 409);
        }
        if (input.expectedListingRowVersion === undefined
          || Number(current.row_version) !== input.expectedListingRowVersion) {
          throw new AppError('TASK_LOCKED', 'OZON 自动公共素材已变化，请重新准备', {
            sku,
            expectedRowVersion: input.expectedListingRowVersion,
            actualRowVersion: Number(current.row_version)
          }, 409);
        }
        const updated = await client.query<SqlRow>(`UPDATE ozon_listing_drafts SET
          product_name_snapshot=$2,data=$3::jsonb,status='READY',revision=revision+1,
          row_version=row_version+1,last_error_code=NULL,last_error_message=NULL,updated_at=NOW()
          WHERE sku=$1 AND row_version=$4 RETURNING *`, [
          sku,
          productName,
          JSON.stringify(data),
          input.expectedListingRowVersion
        ]);
        if (!updated.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 自动公共素材 CAS 写入失败', { sku }, 409);
        persistedRow = updated.rows[0];
      } else {
        if (input.expectedListingRowVersion !== undefined) {
          throw new AppError('TASK_LOCKED', 'OZON 自动公共素材已被删除或替换，请重新准备', { sku }, 409);
        }
        const created = await client.query<SqlRow>(`INSERT INTO ozon_listing_drafts(
          sku,product_name_snapshot,management_source,status,row_version,revision,data
        ) VALUES($1,$2,'AUTO','READY',1,1,$3::jsonb) RETURNING *`, [sku, productName, JSON.stringify(data)]);
        persistedRow = created.rows[0]!;
      }

      const version = await insertSharedMaterialVersion(client, { ...persistedRow, data });
      const listing = withSharedMaterialVersion(persistedRow, version);
      const dataSignature = String((listing as OzonListingDraft & { dataSignature?: string }).dataSignature || '');
      if (!listing.generatedVersionId || !listing.materialHash || !dataSignature
        || listing.materialHashVersion !== OZON_SHARED_MATERIAL_HASH_VERSION
        || listing.contentPolicyVersion !== OZON_CONTENT_POLICY_VERSION) {
        throw new AppError('VERSION_CONFLICT', 'OZON 自动公共素材稳定版本合同不完整', { sku }, 409);
      }
      const job = await this.transitionJobWithClient(client, input.jobId, {
        rowVersion: input.jobRowVersion,
        state: 'READY',
        offerIds,
        eventType: 'AUTO_SHARED_MATERIAL_PREPARED',
        message: 'OZON 自动任务已原子冻结公共素材稳定版本，等待按店铺预设独立物化',
        jobPayload: {
          generatedVersionId: listing.generatedVersionId,
          materialHash: listing.materialHash,
          materialHashVersion: listing.materialHashVersion,
          contentPolicyVersion: listing.contentPolicyVersion,
          sharedMaterialPreparation: {
            schemaVersion: 1,
            preparedByJobId: input.jobId,
            listingRowVersion: listing.rowVersion,
            listingRevision: listing.revision,
            dataSignature,
            mediaSignature: input.mediaSignature
          }
        },
        revision: listing.revision,
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: null
      });
      return { listing: listing as OzonListingDraft & { dataSignature: string }, job };
    });
  }

  async getAutomaticPreparationRecoveryEvidence(jobId: string): Promise<OzonAutomaticPreparationRecoveryEvidence> {
    return getAutomaticPreparationRecoveryEvidenceWithClient(this.requirePool(), jobId);
  }

  async reconcileAutomaticPreparationToManualSuccess(input: {
    jobId: string;
    expectedJobRowVersion: number;
    expectedListingRowVersion: number;
    expectedListingRevision: number;
    eligibilityAt: string;
    planHash: string;
    requestId: string;
    targetStores: OzonPreparationManualSuccessReconcileTarget[];
  }): Promise<OzonPreparationManualSuccessReconcileResult> {
    return this.transaction(async (client) => {
      const identity = await client.query<{ sku: string }>('SELECT sku FROM ozon_publish_jobs WHERE id=$1', [input.jobId]);
      if (!identity.rows[0]) throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId: input.jobId }, 404);
      const sku = normalizeSku(identity.rows[0].sku);
      await lockSkuJob(client, sku);
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const row = jobResult.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId: input.jobId }, 404);
      const payload = jsonObject(row.payload);
      const prior = jsonObject(payload.manualSuccessReconciliation);
      if (String(prior.requestId || '') || String(prior.planHash || '')) {
        if (String(prior.requestId || '') !== input.requestId || String(prior.planHash || '') !== input.planHash) {
          throw new AppError('VERSION_CONFLICT', 'OZON 自动准备任务已经按另一份手动成功证据收口', {
            jobId: input.jobId
          }, 409);
        }
        return {
          job: toJob(row),
          reconciliation: {
            requestId: input.requestId,
            planHash: input.planHash,
            appliedAt: String(prior.appliedAt || row.updated_at),
            targetStores: Array.isArray(prior.targetStores)
              ? prior.targetStores as OzonPreparationManualSuccessReconcileTarget[]
              : input.targetStores
          }
        };
      }
      if (Number(row.row_version) !== input.expectedJobRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务已变化，请重新读取收口计划', {
          jobId: input.jobId,
          expected: input.expectedJobRowVersion,
          actual: Number(row.row_version)
        }, 409);
      }
      if (row.source !== 'AUTO'
        || String(row.task_kind || '') !== 'SHARED_PREPARATION'
        || !['NEEDS_ATTENTION', 'FAILED'].includes(String(row.state))) {
        throw new AppError('VERSION_CONFLICT', 'OZON 自动准备任务当前状态不能按手动成功收口', {
          jobId: input.jobId,
          state: row.state,
          source: row.source,
          taskKind: row.task_kind
        }, 409);
      }
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow) throw new AppError('NOT_FOUND', 'OZON 上品资料不存在', { sku }, 404);
      if (Number(listingRow.row_version) !== input.expectedListingRowVersion
        || Number(listingRow.revision) !== input.expectedListingRevision
        || String(listingRow.management_source || '') !== 'MANUAL') {
        throw new AppError('TASK_LOCKED', 'OZON 手动上品资料已变化，请重新读取收口计划', {
          sku,
          expectedListingRowVersion: input.expectedListingRowVersion,
          actualListingRowVersion: Number(listingRow.row_version),
          expectedListingRevision: input.expectedListingRevision,
          actualListingRevision: Number(listingRow.revision),
          managementSource: listingRow.management_source
        }, 409);
      }
      const listing = toListing(listingRow);
      const expectedOfferIds = [...new Set(listing.data.offers.map((offer) => offer.offerId).filter(Boolean))].sort();
      const targetStoreIds = input.targetStores.map((target) => target.storeId).sort();
      if (!expectedOfferIds.length || !targetStoreIds.length) {
        throw new AppError('CONFIG_INVALID', 'OZON 手动成功收口缺少 Offer 或目标店铺证据', { sku }, 409);
      }
      const eligibleStoreIds = await selectExactEligiblePrePlanStoreIds(client, input.eligibilityAt);
      if (stableJson(eligibleStoreIds) !== stableJson(targetStoreIds)) {
        throw new AppError('VERSION_CONFLICT', 'OZON 当前参与自动上品的店铺集合已变化', {
          expected: targetStoreIds,
          actual: eligibleStoreIds
        }, 409);
      }
      const evidence = await getAutomaticPreparationRecoveryEvidenceWithClient(client, input.jobId);
      if (evidence.publicationCount || evidence.gatewayRequestCount || evidence.productLinkCount
        || evidence.importIntentPresent || evidence.platformWriteAttempted
        || evidence.activeLease || evidence.activeSlot || evidence.activeStatusRefresh) {
        throw new AppError('OZON_READBACK_REQUIRED', '旧自动任务出现自身 publication、平台写入或活动租约证据，不能收口', {
          jobId: input.jobId,
          evidence
        }, 409);
      }
      const stores = await client.query<SqlRow>('SELECT id,store_alias,display_name FROM ozon_stores WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [targetStoreIds]);
      if (stores.rows.length !== targetStoreIds.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON 收口计划中的店铺已不存在', { targetStoreIds }, 409);
      }
      const actualTargets: OzonPreparationManualSuccessReconcileTarget[] = [];
      for (const target of [...input.targetStores].sort((left, right) => left.storeId.localeCompare(right.storeId))) {
        const publicationResult = await client.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [target.publicationId]);
        const manualJobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [target.manualJobId]);
        const publication = publicationResult.rows[0];
        const manualJobRow = manualJobResult.rows[0];
        if (!publication || !manualJobRow) {
          throw new AppError('VERSION_CONFLICT', 'OZON 手动成功 publication 或任务已不存在', {
            storeId: target.storeId,
            publicationId: target.publicationId,
            manualJobId: target.manualJobId
          }, 409);
        }
        const manualJob = toJob(manualJobRow);
        const publicationOfferIds = normalizeOfferIds(publication.offer_ids).sort();
        const publicationLinks = stringArray(publication.product_links).sort();
        const store = stores.rows.find((candidate) => String(candidate.id) === target.storeId);
        const linksComplete = manualJob.ozonProductLinks.length === expectedOfferIds.length
          && manualJob.ozonProductLinks.every((link) => Boolean(link.ozonProductId && link.url && link.lastVerifiedAt)
            && link.displayState === 'ON_SALE');
        if (!store
          || String(publication.sku) !== sku
          || String(publication.store_id) !== target.storeId
          || String(publication.source) !== 'MANUAL'
          || String(publication.status) !== 'SUCCEEDED'
          || Number(publication.row_version) !== target.publicationRowVersion
          || String(publication.planned_job_id || '') !== target.manualJobId
          || String(publication.preparation_job_id || '') === input.jobId
          || stableJson(publicationOfferIds) !== stableJson(expectedOfferIds)
          || stringArray(publication.product_ids).length !== expectedOfferIds.length
          || publicationLinks.length !== expectedOfferIds.length
          || !publication.completed_at
          || manualJob.source !== 'MANUAL'
          || manualJob.taskKind !== 'STORE_PUBLICATION'
          || manualJob.state !== 'SUCCEEDED'
          || manualJob.publicationId !== target.publicationId
          || manualJob.rowVersion !== target.manualJobRowVersion
          || stableJson([...manualJob.offerIds].sort()) !== stableJson(expectedOfferIds)
          || stableJson(manualJob.ozonProductLinks.map((link) => link.url).sort()) !== stableJson(publicationLinks)
          || !linksComplete) {
          throw new AppError('VERSION_CONFLICT', 'OZON 手动成功证据已变化或不完整', {
            storeId: target.storeId,
            publicationId: target.publicationId,
            manualJobId: target.manualJobId
          }, 409);
        }
        actualTargets.push({
          storeId: target.storeId,
          storeAlias: String(store.store_alias),
          storeDisplayName: String(store.display_name),
          publicationId: target.publicationId,
          publicationRowVersion: Number(publication.row_version),
          manualJobId: target.manualJobId,
          manualJobRowVersion: manualJob.rowVersion,
          offerIds: expectedOfferIds,
          productLinks: manualJob.ozonProductLinks,
          completedAt: iso(publication.completed_at)
        });
      }
      if (stableJson(actualTargets) !== stableJson(input.targetStores)) {
        throw new AppError('TASK_LOCKED', 'OZON 手动成功收口证据已变化，请重新读取计划', { jobId: input.jobId }, 409);
      }
      const canonical = {
        schemaVersion: 1,
        jobId: input.jobId,
        jobRowVersion: input.expectedJobRowVersion,
        listingRowVersion: input.expectedListingRowVersion,
        listingRevision: input.expectedListingRevision,
        expectedOfferIds,
        targetStores: actualTargets
      };
      const calculatedPlanHash = `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`;
      if (calculatedPlanHash !== input.planHash
        || deterministicOzonPrePlanRequestId(input.jobId, calculatedPlanHash) !== input.requestId) {
        throw new AppError('TASK_LOCKED', 'OZON 手动成功收口计划签名无效或已变化', { jobId: input.jobId }, 409);
      }
      const appliedAt = new Date().toISOString();
      const existingFanout = jsonObject(payload.fanoutSummary);
      const fanoutSummary = {
        phase: 'CANCELLED',
        targetStoreCount: Number(existingFanout.targetStoreCount || 0),
        publicationCount: Number(existingFanout.publicationCount || 0),
        failureCount: Number(existingFanout.failureCount || 0),
        canRecheck: false,
        canManualTakeover: false,
        canReconcileManualSuccess: false,
        recoveryMode: 'NONE'
      };
      const reconciliation = {
        schemaVersion: 1,
        requestId: input.requestId,
        planHash: input.planHash,
        appliedAt,
        listingRowVersion: input.expectedListingRowVersion,
        listingRevision: input.expectedListingRevision,
        eligibilityAt: input.eligibilityAt,
        targetStores: actualTargets
      };
      const nextPayload = {
        ...payload,
        fanoutSummary,
        manualSuccessReconciliation: reconciliation
      };
      const updated = await client.query<SqlRow>(`UPDATE ozon_publish_jobs SET
          state='CANCELLED',payload=$2::jsonb,row_version=row_version+1,finished_at=NOW(),next_attempt_at=NULL,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE id=$1 AND row_version=$3 RETURNING *`, [input.jobId, JSON.stringify(nextPayload), input.expectedJobRowVersion]);
      if (updated.rowCount !== 1) throw new AppError('TASK_LOCKED', 'OZON 自动准备任务在收口时发生变化', { jobId: input.jobId }, 409);
      await addEvent(
        client,
        input.jobId,
        'AUTOMATIC_PREPARATION_RECONCILED_TO_MANUAL_SUCCESS',
        String(row.state),
        'CANCELLED',
        '旧自动准备任务已按全部参与店铺的手动发布成功证据安全收口',
        reconciliation
      );
      return {
        job: toJob(updated.rows[0]!),
        reconciliation: {
          requestId: input.requestId,
          planHash: input.planHash,
          appliedAt,
          targetStores: actualTargets
        }
      };
    });
  }

  /**
   * Read-only admission evidence for replacing a frozen fan-out that stopped in
   * LOCAL_VALIDATION. Unlike PRE_PLAN recovery, linked publication rows are
   * expected here; they are admissible only when every row is a local-only
   * failed attempt and no platform, gateway, mapping, package or lease evidence
   * exists.
   */
  async getAutomaticPreparationReplanEvidence(jobId: string): Promise<OzonAutomaticPreparationReplanEvidence> {
    return getAutomaticPreparationReplanEvidenceWithClient(this.requirePool(), jobId);
  }

  /**
   * Atomically supersedes an immutable, locally failed fan-out with a new shared
   * material revision. The old preparation/publications remain as audit rows;
   * no old frozen snapshot or task identity is reused.
   */
  async replaceAutomaticPreparationWithCurrentPreset(
    input: OzonAutomaticPreparationReplanApplyInput
  ): Promise<{ job: OzonPublishJob; supersededJob: OzonPublishJob; idempotent: boolean }> {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.planHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedEvidenceHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedFanoutPlanHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedMaterialHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedDataSignature)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedCurrentPlanHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedPlanContractHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedRootDirectoryHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.expectedVariantColorAuthorityHash)
      || !Number.isSafeInteger(input.expectedSettingsRowVersion) || input.expectedSettingsRowVersion < 1
      || !/^[0-9a-f-]{36}$/i.test(input.requestId)
      || !input.targetStores.length) {
      throw new AppError('CONFIG_INVALID', 'OZON 当前预设重建合同不完整', { jobId: input.jobId }, 409);
    }
    const sku = normalizeSku((await this.getJob(input.jobId, 'AUTO')).sku);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const originalResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const original = originalResult.rows[0];
      if (!original || String(original.sku) !== sku || String(original.source) !== 'AUTO'
        || String(original.task_kind) !== 'SHARED_PREPARATION') {
        throw new AppError('VERSION_CONFLICT', 'OZON 原共享准备任务身份已变化', { jobId: input.jobId }, 409);
      }
      const originalPayload = jsonObject(original.payload);
      const priorReplacement = jsonObject(originalPayload.replanReplacement);
      if (String(priorReplacement.requestId || '') === input.requestId
        && String(priorReplacement.planHash || '') === input.planHash
        && String(priorReplacement.replacementPreparationJobId || '')) {
        const replacement = await client.query<SqlRow>(
          'SELECT * FROM ozon_publish_jobs WHERE id=$1 AND task_kind=\'SHARED_PREPARATION\'',
          [String(priorReplacement.replacementPreparationJobId)]
        );
        if (!replacement.rows[0]) {
          throw new AppError('VERSION_CONFLICT', 'OZON 重建幂等记录缺少替代任务', {
            jobId: input.jobId,
            replacementPreparationJobId: priorReplacement.replacementPreparationJobId
          }, 409);
        }
        return { job: toJob(replacement.rows[0]), supersededJob: toJob(original), idempotent: true };
      }
      if (Object.keys(priorReplacement).length) {
        throw new AppError('VERSION_CONFLICT', 'OZON 原任务已由其他重建请求替代', {
          jobId: input.jobId,
          replacementPreparationJobId: priorReplacement.replacementPreparationJobId
        }, 409);
      }
      const frozen = jsonObject(originalPayload.fanoutPlan);
      if (Number(original.row_version) !== input.expectedJobRowVersion
        || !['NEEDS_ATTENTION', 'FAILED'].includes(String(original.state))
        || originalPayload.multistorePreparation !== true
        || String(frozen.planHash || '') !== input.expectedFanoutPlanHash) {
        throw new AppError('VERSION_CONFLICT', 'OZON 原冻结准备任务在提交前已变化', { jobId: input.jobId }, 409);
      }

      // Task/publication-bound gateway intents take this same advisory before
      // locking their child rows. Recovery already owns the parent row and
      // never asks a gateway transaction to lock it, so the order is acyclic:
      // recovery parent -> advisory -> children; gateway advisory -> children.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        ozonPreparationGatewayBoundaryLockKey(input.jobId)
      ]);

      const evidence = await getAutomaticPreparationReplanEvidenceWithClient(client, input.jobId, { lock: true });
      if (!evidence.safe || evidence.evidenceHash !== input.expectedEvidenceHash) {
        throw new AppError('OZON_READBACK_REQUIRED', 'OZON 重建提交前发现远端、租约或本地身份漂移', {
          jobId: input.jobId,
          blockers: evidence.blockers,
          expectedEvidenceHash: input.expectedEvidenceHash,
          actualEvidenceHash: evidence.evidenceHash
        }, 409);
      }

      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      const versionResult = await client.query<SqlRow>(`SELECT * FROM ozon_listing_versions
        WHERE id=$1 AND sku=$2 AND revision=$3 FOR SHARE`, [
        input.expectedGeneratedVersionId, sku, input.expectedListingRevision
      ]);
      const version = versionResult.rows[0];
      const versionMetadata = jsonObject(jsonObject(version?.snapshot).sharedMaterialMetadata);
      if (!listingRow || String(listingRow.management_source) !== 'AUTO'
        || Number(listingRow.row_version) !== input.expectedListingRowVersion
        || Number(listingRow.revision) !== input.expectedListingRevision
        || !version
        || String(version.material_hash || '') !== input.expectedMaterialHash
        || String(versionMetadata.dataSignature || '') !== input.expectedDataSignature) {
        throw new AppError('VERSION_CONFLICT', 'OZON 当前公共素材版本在重建提交前已变化', { sku }, 409);
      }

      await assertAutomaticPreparationReplanTargets(client, input);
      const activeShared = await client.query<SqlRow>(`SELECT id,state FROM ozon_publish_jobs
        WHERE sku=$1 AND task_kind='SHARED_PREPARATION' AND id<>$2
          AND state=ANY($3::text[]) FOR UPDATE`, [sku, input.jobId, ACTIVE_JOB_STATES]);
      if (activeShared.rows[0]) {
        throw new AppError('TASK_LOCKED', 'OZON 当前 SKU 已有其他活动共享准备任务', {
          sku, jobId: activeShared.rows[0].id, state: activeShared.rows[0].state
        }, 409);
      }

      const supersededPublications = evidence.publicationIds.length
        ? (await client.query<SqlRow>(`SELECT id,store_id,status,row_version,error_code,error_message
            FROM ozon_store_publications WHERE id=ANY($1::uuid[]) ORDER BY id`, [evidence.publicationIds])).rows
        : [];
      const supersededPublicationJobs = evidence.publicationJobIds.length
        ? (await client.query<SqlRow>(`SELECT id,publication_id,state,row_version,last_error_code,last_error_message
            FROM ozon_publish_jobs WHERE id=ANY($1::uuid[]) ORDER BY id`, [evidence.publicationJobIds])).rows
        : [];
      const originalFailureAudit = {
        parent: {
          id: String(original.id),
          state: String(original.state),
          rowVersion: Number(original.row_version),
          errorCode: String(original.last_error_code || ''),
          errorMessage: String(original.last_error_message || '')
        },
        publications: supersededPublications.map((row) => ({
          id: String(row.id),
          storeId: String(row.store_id || ''),
          status: String(row.status),
          rowVersion: Number(row.row_version),
          errorCode: String(row.error_code || ''),
          errorMessage: String(row.error_message || '')
        })),
        publicationJobs: supersededPublicationJobs.map((row) => ({
          id: String(row.id),
          publicationId: String(row.publication_id || ''),
          state: String(row.state),
          rowVersion: Number(row.row_version),
          errorCode: String(row.last_error_code || ''),
          errorMessage: String(row.last_error_message || '')
        }))
      };

      const replacementJobId = deterministicOzonPreparationReplacementJobId(input.jobId, input.requestId);
      const replacementAt = new Date().toISOString();
      const replacementMarker = {
        schemaVersion: 1,
        recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
        requestId: input.requestId,
        planHash: input.planHash,
        evidenceHash: input.expectedEvidenceHash,
        expectedCurrentPlanHash: input.expectedCurrentPlanHash,
        expectedPlanContractHash: input.expectedPlanContractHash,
        expectedSettingsRowVersion: input.expectedSettingsRowVersion,
        expectedRootDirectoryHash: input.expectedRootDirectoryHash,
        expectedVariantColorAuthorityHash: input.expectedVariantColorAuthorityHash,
        supersededPreparationJobId: input.jobId,
        replacementPreparationJobId: replacementJobId,
        supersededPublicationIds: evidence.publicationIds,
        supersededPublicationJobIds: evidence.publicationJobIds,
        originalFailureAudit,
        replacedAt: replacementAt
      };

      await client.query(`UPDATE ozon_publish_jobs SET
        payload=payload || jsonb_build_object('replanReplacement',$2::jsonb),
        row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [input.jobId, JSON.stringify(replacementMarker)]);

      const supersededChildPayload = {
        ...replacementMarker,
        originalErrorPreserved: true
      };
      if (evidence.publicationJobIds.length) {
        await client.query(`UPDATE ozon_publish_jobs SET
          payload=payload || jsonb_build_object('replanReplacement',$2::jsonb),
          row_version=row_version+1,updated_at=NOW()
          WHERE id=ANY($1::uuid[])`, [evidence.publicationJobIds, JSON.stringify(supersededChildPayload)]);
      }
      if (evidence.publicationIds.length) {
        await client.query(`UPDATE ozon_store_publications SET
          result_json=result_json || jsonb_build_object('replanReplacement',$2::jsonb),
          row_version=row_version+1,updated_at=NOW()
          WHERE id=ANY($1::uuid[])`, [evidence.publicationIds, JSON.stringify(supersededChildPayload)]);
      }

      const updatedListingResult = await client.query<SqlRow>(`UPDATE ozon_listing_drafts SET
        status='READY',revision=revision+1,row_version=row_version+1,last_task_id=NULL,
        last_error_code=NULL,last_error_message=NULL,updated_at=NOW()
        WHERE sku=$1 AND row_version=$2 RETURNING *`, [sku, input.expectedListingRowVersion]);
      const updatedListingRow = updatedListingResult.rows[0];
      if (!updatedListingRow) throw new AppError('TASK_LOCKED', 'OZON 公共素材重建 CAS 未命中', { sku }, 409);
      const replacementVersionRow = await insertSharedMaterialVersion(client, updatedListingRow);
      const replacementListing = withSharedMaterialVersion(updatedListingRow, replacementVersionRow);
      const replacementDataSignature = String((replacementListing as OzonListingDraft & { dataSignature?: string }).dataSignature || '');
      if (!replacementListing.generatedVersionId || !replacementListing.materialHash || !replacementDataSignature) {
        throw new AppError('VERSION_CONFLICT', 'OZON 重建后的稳定公共素材合同不完整', { sku }, 409);
      }

      const replacementPayload = sanitizePersistentJobPayload({ ...originalPayload });
      for (const key of [
        'fanoutPlan', 'fanoutSummary', 'multistoreFanout', 'networkRecovery', 'prePlanRecovery',
        'recoveryHold', 'platformWriteAttempted', 'importIntent', 'importTaskId', 'gatewayRequestRef',
        'gatewayUnknown', 'priceStockWriteProgress', 'productJsonGenerated', 'productJsonPath',
        'packageSignature', 'directorySignature'
      ]) delete replacementPayload[key];
      Object.assign(replacementPayload, {
        generatedVersionId: replacementListing.generatedVersionId,
        materialHash: replacementListing.materialHash,
        materialHashVersion: replacementListing.materialHashVersion,
        contentPolicyVersion: replacementListing.contentPolicyVersion,
        sharedMaterialPreparation: {
          schemaVersion: 1,
          preparedByJobId: replacementJobId,
          listingRowVersion: replacementListing.rowVersion,
          listingRevision: replacementListing.revision,
          dataSignature: replacementDataSignature,
          mediaSignature: String(jsonObject(originalPayload.sharedMaterialPreparation).mediaSignature || originalPayload.mediaSignature || ''),
          reusedFromPreparationJobId: input.jobId
        },
        replanRecovery: {
          ...replacementMarker,
          generatedVersionId: replacementListing.generatedVersionId,
          revision: replacementListing.revision,
          targetStores: input.targetStores
        }
      });
      const offerIds = normalizeOfferIds((Array.isArray(updatedListingRow.data?.offers) ? updatedListingRow.data.offers : [])
        .map((offer: unknown) => jsonObject(offer).offerId));
      const stageStates = {
        import: 'PENDING', moderation: 'PENDING', images: 'LOCAL_READY', video: 'LOCAL_READY', price: 'PENDING', stock: 'PENDING'
      };
      const replacementJobResult = await client.query<SqlRow>(`INSERT INTO ozon_publish_jobs(
          id,sku,state,source,payload,stage_states,row_version,store_alias,offer_ids,product_links,
          directory_stage,work_rel_path,listing_revision,store_id,task_kind
        ) VALUES($1,$2,'READY','AUTO',$3::jsonb,$4::jsonb,1,$5,$6::jsonb,'[]'::jsonb,
          'INBOX',$7,$8,$9,'SHARED_PREPARATION') RETURNING *`, [
        replacementJobId, sku, JSON.stringify(replacementPayload), JSON.stringify(stageStates),
        String(original.store_alias), JSON.stringify(offerIds), portableRelPath('inbox', sku),
        replacementListing.revision, original.store_id
      ]);
      const replacementJobRow = replacementJobResult.rows[0];
      if (!replacementJobRow) throw new AppError('VERSION_CONFLICT', 'OZON 替代共享准备任务创建失败', { sku }, 409);

      const reboundMedia = await client.query(OZON_AUTOMATIC_REPLAN_MEDIA_REBIND_SQL, [
        input.jobId, replacementJobId, sku, input.requestId, input.planHash, input.expectedEvidenceHash, replacementAt
      ]);
      if (Number(reboundMedia.rowCount || 0) !== evidence.mediaDeliveryCount) {
        throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON 重建时媒体投递账本数量已变化', {
          expected: evidence.mediaDeliveryCount,
          actual: Number(reboundMedia.rowCount || 0)
        }, 409);
      }
      await addEvent(client, input.jobId, 'AUTO_PREPARATION_SUPERSEDED_BY_REPLAN', String(original.state), String(original.state),
        '原冻结 fan-out 已保留，并由当前预设创建新的共享准备 revision', replacementMarker);
      for (const childJobId of evidence.publicationJobIds) {
        await addEvent(client, childJobId, 'MULTISTORE_PUBLICATION_SUPERSEDED_BY_REPLAN', undefined, undefined,
          '本地校验失败的旧 publication 已由当前预设重建任务替代', replacementMarker);
      }
      await addEvent(client, replacementJobId, 'AUTO_PREPARATION_REPLAN_CREATED', undefined, 'READY',
        '已使用当前店铺预设创建新的共享准备 revision，旧任务与冻结快照保持可追溯', replacementMarker);

      const supersededResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1', [input.jobId]);
      return {
        job: toJob(replacementJobRow),
        supersededJob: toJob(supersededResult.rows[0]!),
        idempotent: false
      };
    });
  }

  /**
   * Final PRE_PLAN commit gate. Every mutable local authority used by the
   * read-only remote proof is locked and compared in one transaction before the
   * original preparation job is re-armed. No publication or sibling job is
   * created here.
   */
  async rearmAutomaticPrePlanRecovery(input: OzonPrePlanRecoveryRearmInput): Promise<OzonPublishJob> {
    const sku = normalizeSku(input.sku);
    const expectedEligibilityAt = new Date(input.expectedEligibilityAt);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.planHash) || !input.targetStores.length
      || !input.expectedMediaDeliveries.length || !Number.isFinite(expectedEligibilityAt.getTime())) {
      throw new AppError('CONFIG_INVALID', 'OZON PRE_PLAN 原子恢复合同不完整', { jobId: input.jobId }, 409);
    }
    assertOzonPrePlanRecoveryContract({
      jobId: input.jobId,
      sku,
      planHash: input.planHash,
      requestId: input.requestId,
      evidence: input.recoveryEvidence,
      productIdentity: input.expectedProductIdentity,
      manifestSignature: input.expectedManifestSignature,
      mediaDeliveries: input.expectedMediaDeliveries,
      targetStores: input.targetStores,
      eligibilityAt: expectedEligibilityAt.toISOString()
    });
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const job = jobResult.rows[0];
      if (!job || String(job.sku) !== sku || String(job.source) !== 'AUTO'
        || String(job.task_kind) !== 'SHARED_PREPARATION'
        || jsonObject(job.payload).multistorePreparation !== true
        || Object.keys(jsonObject(jsonObject(job.payload).networkRecovery)).length
        || job.directory_signature
        || ozonPrePlanPayloadHasWriteCheckpoint(job.payload)
        || Object.keys(jsonObject(jsonObject(job.payload).fanoutPlan)).length
        || Number(job.row_version) !== input.expectedJobRowVersion
        || !['NEEDS_ATTENTION', 'FAILED'].includes(String(job.state))) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 原任务在提交前已变化', { jobId: input.jobId }, 409);
      }
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listing = listingResult.rows[0];
      if (!listing || String(listing.management_source) !== 'AUTO'
        || Number(listing.row_version) !== input.expectedListingRowVersion
        || Number(listing.revision) !== input.expectedListingRevision) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 公共素材草稿在提交前已变化', { sku }, 409);
      }
      const productResult = await client.query<SqlRow>(
        'SELECT sku,product_name FROM products WHERE sku=$1 FOR SHARE',
        [sku]
      );
      const variantResult = await client.query<SqlRow>(`SELECT
          id,name,sort_order,created_at,
          wb_color_key,wb_color_name_ru,wb_color_name_zh,
          ozon_color_item_key,ozon_color_dictionary_id,ozon_color_value_id,
          ozon_color_name_ru,ozon_color_name_zh,ozon_color_source
        FROM product_variants WHERE sku=$1 ORDER BY sort_order ASC,created_at ASC FOR SHARE`, [sku]);
      const product = productResult.rows[0];
      const currentIdentity = product ? {
        sku: String(product.sku).trim(),
        productName: String(product.product_name),
        variants: variantResult.rows.map((variant) => ({
          variantId: String(variant.id),
          name: String(variant.name),
          ...(variant.wb_color_key && variant.wb_color_name_ru && variant.wb_color_name_zh ? {
            wbColor: {
              colorKey: String(variant.wb_color_key),
              nameRu: String(variant.wb_color_name_ru),
              nameZh: String(variant.wb_color_name_zh)
            }
          } : {}),
          ...(variant.ozon_color_item_key && variant.ozon_color_dictionary_id && variant.ozon_color_value_id
            && variant.ozon_color_name_ru && variant.ozon_color_name_zh && variant.ozon_color_source ? {
              ozonColor: {
                itemKey: String(variant.ozon_color_item_key),
                dictionaryId: Number(variant.ozon_color_dictionary_id),
                valueId: Number(variant.ozon_color_value_id),
                nameRu: String(variant.ozon_color_name_ru),
                nameZh: String(variant.ozon_color_name_zh),
                source: String(variant.ozon_color_source)
              }
            } : {})
        }))
      } : undefined;
      if (!currentIdentity || stableJson(currentIdentity) !== stableJson(input.expectedProductIdentity)) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 稳定产品变体身份在提交前已变化', { sku }, 409);
      }
      const mediaRows = await client.query<SqlRow>(`SELECT *,updated_at::text AS updated_at_exact FROM ozon_media_deliveries
        WHERE sku=$1 ORDER BY source_stage_id,submission_id,variant_id FOR UPDATE`, [sku]);
      for (const expected of input.expectedMediaDeliveries) {
        const row = mediaRows.rows.find((candidate) => String(candidate.source_stage_id) === expected.sourceStageId
          && String(candidate.submission_id) === expected.submissionId
          && String(candidate.variant_id || '') === String(expected.variantId || ''));
        const decision = String(jsonObject(row?.payload).autoPublishDecision || '').toUpperCase();
        const deliveredAt = String(jsonObject(row?.payload).deliveredAt || '').trim();
        if (!row || String(row.job_id || '') !== expected.jobId
          || !['ACCEPTED', 'DEFERRED', 'FANNED_OUT'].includes(decision)
          || !/^sha256:[a-f0-9]{64}$/.test(expected.payloadHash)
          || automaticMediaPayloadHash(row.payload) !== expected.payloadHash
          || !sameOzonPrePlanTimestamp(row.updated_at_exact || row.updated_at, expected.updatedAt)
          || !sameOzonPrePlanTimestamp(deliveredAt, expected.deliveredAt)) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON PRE_PLAN 媒体账本在提交前已变化', {
            sku,
            sourceStageId: expected.sourceStageId,
            submissionId: expected.submissionId,
            variantId: expected.variantId
          }, 409);
        }
      }
      const storeIds = input.targetStores.map((store) => store.id);
      const stores = await client.query<SqlRow>(`SELECT s.* FROM ozon_stores s
        WHERE s.id=ANY($1::uuid[]) ORDER BY s.id FOR UPDATE`, [storeIds]);
      if (stores.rows.length !== input.targetStores.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 目标店铺集合已变化', { storeIds }, 409);
      }
      const eligibleStoreIds = await selectExactEligiblePrePlanStoreIds(client, expectedEligibilityAt.toISOString());
      if (stableJson(eligibleStoreIds) !== stableJson([...storeIds].sort())) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 自动发布店铺集合在提交前已变化', { storeIds }, 409);
      }
      const presetIds = input.targetStores.map((store) => store.presetId);
      const presets = await client.query<SqlRow>(`SELECT id,row_version,definition FROM ozon_listing_presets
        WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [presetIds]);
      const credentialIds = input.targetStores.map((store) => store.credentialVersionId);
      const credentials = await client.query<SqlRow>(`SELECT id,store_id,status FROM ozon_store_credential_versions
        WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [credentialIds]);
      for (const expected of input.targetStores) {
        const store = stores.rows.find((candidate) => String(candidate.id) === expected.id);
        const preset = presets.rows.find((candidate) => String(candidate.id) === expected.presetId);
        const credential = credentials.rows.find((candidate) => String(candidate.id) === expected.credentialVersionId);
        if (!store || Number(store.row_version) !== expected.rowVersion
          || Number(store.config_version) !== expected.configVersion
          || String(store.active_credential_version_id || '') !== expected.credentialVersionId
          || String(store.credential_binding_mode || '') !== 'VAULT'
          || String(store.default_preset_id || '') !== expected.presetId
          || !preset || Number(preset.row_version) !== expected.presetRowVersion
          || `sha256:${createHash('sha256').update(stableJson(jsonObject(preset.definition))).digest('hex')}` !== expected.presetSnapshotHash
          || !credential || String(credential.store_id) !== expected.id || String(credential.status) !== 'ACTIVE'
          || String(store.auto_publish_mode || '') !== expected.publicationMode
          || String(store.warehouse_id || '') !== expected.warehouseId
          || String(store.fulfillment_mode || '') !== expected.fulfillmentMode
          || String(store.account_currency || '') !== expected.accountCurrency
          || store.enabled !== true || store.auto_publish_enabled !== true || store.archived_at) {
          throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 店铺、凭据、预设或发布模式已变化', {
            storeId: expected.id
          }, 409);
        }
      }
      const evidence = await getAutomaticPreparationRecoveryEvidenceWithClient(client, input.jobId);
      if (evidence.publicationCount || evidence.mappingCount || evidence.gatewayRequestCount
        || evidence.productLinkCount || evidence.importIntentPresent || evidence.platformWriteAttempted
        || evidence.activeLease || evidence.activeSlot || evidence.activeStatusRefresh) {
        throw new AppError('OZON_READBACK_REQUIRED', 'OZON PRE_PLAN 在提交前出现平台或活动租约证据', {
          jobId: input.jobId,
          evidence
        }, 409);
      }
      const now = new Date().toISOString();
      const frozenTargets = input.targetStores.map((store) => ({
        ...store,
        expectedOfferIds: [...store.expectedOfferIds]
      })).sort((left, right) => left.id.localeCompare(right.id));
      const payload = sanitizePersistentJobPayload({
        ...jsonObject(job.payload),
        generatedVersionId: null,
        materialHash: null,
        materialHashVersion: null,
        contentPolicyVersion: null,
        sharedMaterialPreparation: null,
        prePlanRecovery: {
          schemaVersion: 1,
          requestId: input.requestId,
          planHash: input.planHash,
          verifiedAt: now,
          manifestSignature: input.expectedManifestSignature,
          targetStores: frozenTargets,
          productIdentity: input.expectedProductIdentity,
          evidence: input.recoveryEvidence
        }
      });
      const updated = await client.query<SqlRow>(`UPDATE ozon_publish_jobs SET
          state='READY',payload=$2::jsonb,last_error_code=NULL,last_error_message=NULL,
          next_attempt_at=NULL,finished_at=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$3 RETURNING *`, [input.jobId, JSON.stringify(payload), input.expectedJobRowVersion]);
      if (!updated.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 原任务 CAS 恢复失败', { jobId: input.jobId }, 409);
      await addEvent(client, input.jobId, 'AUTO_PRE_PLAN_RECOVERY_REARMED', String(job.state), 'READY',
        '逐店 Offer 不存在证明已重新取得；原共享准备任务恢复为 READY，等待原子生成下一真实素材版本', {
          requestId: input.requestId,
          planHash: input.planHash,
          targetStoreIds: storeIds,
          nextRealRevision: Number(listing.revision) + 1
        });
      return toJob(updated.rows[0]);
    });
  }

  async repairErroneousEmptyFanoutMediaBatch(input: {
    jobId: string;
    expectedJobRowVersion: number;
    planHash: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const job = jobResult.rows[0];
      const payload = jsonObject(job?.payload);
      const fanout = jsonObject(payload.multistoreFanout);
      const frozenPlan = jsonObject(payload.fanoutPlan);
      const failures = (Array.isArray(fanout.failures) ? fanout.failures : []).map(jsonObject);
      if (!job
        || Number(job.row_version) !== input.expectedJobRowVersion
        || String(job.task_kind || '') !== 'SHARED_PREPARATION'
        || String(job.state || '') !== 'NEEDS_ATTENTION'
        || job.publication_id
        || payload.multistorePreparation !== true
        || String(frozenPlan.planHash || '') !== input.planHash
        || stringArray(fanout.publicationIds).length !== 0
        || !failures.length
        || failures.some((failure) => (
          failure.code !== 'OZON_PUBLICATION_CREATE_FAILED'
          || failure.message !== 'INSERT has more expressions than target columns'
        ))) {
        throw new AppError('VERSION_CONFLICT', 'OZON 空 publication 媒体账本恢复合同不匹配', { jobId: input.jobId }, 409);
      }
      const targetStoreIds = (Array.isArray(frozenPlan.items) ? frozenPlan.items : [])
        .map((item) => String(jsonObject(item).storeId || ''))
        .filter(Boolean)
        .sort();
      if (!targetStoreIds.length
        || stableJson(stringArray(fanout.storeIds).sort()) !== stableJson(targetStoreIds)) {
        throw new AppError('VERSION_CONFLICT', 'OZON 空 publication 媒体账本目标店铺已变化', { jobId: input.jobId }, 409);
      }
      const evidence = await getAutomaticPreparationRecoveryEvidenceWithClient(client, input.jobId);
      if (evidence.publicationCount || evidence.mappingCount || evidence.gatewayRequestCount
        || evidence.productLinkCount || evidence.importIntentPresent || evidence.platformWriteAttempted
        || evidence.activeLease || evidence.activeSlot || evidence.activeStatusRefresh) {
        throw new AppError('OZON_READBACK_REQUIRED', 'OZON 空 publication 媒体账本恢复发现平台或活动证据', {
          jobId: input.jobId,
          evidence
        }, 409);
      }
      const recovery = jsonObject(payload.prePlanRecovery);
      const recoveryEvidence = jsonObject(recovery.evidence);
      const checks = jsonObject(recoveryEvidence.checks);
      const media = jsonObject(checks.media);
      const expectedRows = (Array.isArray(media.evidence) ? media.evidence : []).map(jsonObject);
      if (!expectedRows.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON 空 publication 媒体账本缺少冻结恢复证据', { jobId: input.jobId }, 409);
      }
      const rows = await client.query<SqlRow>(`SELECT * FROM ozon_media_deliveries
        WHERE job_id=$1 AND sku=$2
        ORDER BY source_stage_id,submission_id,variant_id
        FOR UPDATE`, [input.jobId, String(job.sku)]);
      if (rows.rows.length !== expectedRows.length) {
        throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON 空 publication 媒体账本数量已变化', {
          jobId: input.jobId,
          expected: expectedRows.length,
          actual: rows.rows.length
        }, 409);
      }
      for (const row of rows.rows) {
        const expected = expectedRows.find((entry) => (
          String(entry.sourceStageId || '') === String(row.source_stage_id || '')
          && String(entry.submissionId || '') === String(row.submission_id || '')
          && String(entry.variantId || '') === String(row.variant_id || '')
        ));
        const current = jsonObject(row.payload);
        if (!expected
          || String(current.autoPublishDecision || '') !== 'FANNED_OUT'
          || stringArray(current.fanoutPublicationIds).length !== 0
          || stableJson(stringArray(current.fanoutStoreIds).sort()) !== stableJson(targetStoreIds)
          || !sameOzonPrePlanTimestamp(current.deliveredAt, expected.deliveredAt)) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON 空 publication 媒体账本状态或身份已变化', {
            jobId: input.jobId,
            sourceStageId: row.source_stage_id,
            submissionId: row.submission_id,
            variantId: row.variant_id
          }, 409);
        }
        const restored: Record<string, unknown> = { ...current, autoPublishDecision: String(expected.decision || 'ACCEPTED') };
        delete restored.fanoutPublicationIds;
        delete restored.fanoutStoreIds;
        delete restored.fanoutCompletedAt;
        if (!['ACCEPTED', 'DEFERRED'].includes(String(restored.autoPublishDecision))
          || automaticMediaPayloadHash(restored) !== String(expected.payloadHash || '')) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON 空 publication 媒体账本无法恢复为冻结前哈希', {
            jobId: input.jobId,
            sourceStageId: row.source_stage_id,
            submissionId: row.submission_id,
            variantId: row.variant_id
          }, 409);
        }
        const updated = await client.query(`UPDATE ozon_media_deliveries SET payload=$4::jsonb,updated_at=$5::timestamptz
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$6 AND job_id=$7::uuid`, [
          String(job.sku), String(row.source_stage_id), String(row.submission_id), JSON.stringify(restored),
          String(expected.updatedAt), String(row.variant_id || ''), input.jobId
        ]);
        if (updated.rowCount !== 1) {
          throw new AppError('TASK_LOCKED', 'OZON 空 publication 媒体账本恢复 CAS 未命中', {
            jobId: input.jobId,
            sourceStageId: row.source_stage_id,
            submissionId: row.submission_id
          }, 409);
        }
      }
      await addEvent(client, input.jobId, 'AUTO_EMPTY_FANOUT_MEDIA_RESTORED', String(job.state), String(job.state),
        '已原子撤销空 publication fan-out 对公共媒体账本的错误完成标记', {
          planHash: input.planHash,
          targetStoreIds,
          mediaCount: rows.rows.length
        });
    });
  }

  async markListingSubmitted(skuInput: string, jobId: string): Promise<OzonListingDraft> {
    const result = await this.query<SqlRow>(`
      UPDATE ozon_listing_drafts
      SET status='SUBMITTING',last_task_id=$2,row_version=row_version+1,updated_at=NOW()
      WHERE sku=$1 RETURNING *`,
    [normalizeSku(skuInput), jobId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku: skuInput }, 404);
    return toListing(result.rows[0]);
  }

  async listCategories(): Promise<OzonCategoryTemplate[]> {
    const result = await this.query<SqlRow>(categorySelectSql('ORDER BY c.updated_at DESC'));
    return result.rows.map(toCategory);
  }

  async getCategory(categoryKeyInput: string): Promise<OzonCategoryTemplate> {
    const categoryKey = ozonCategoryKeySchema.parse(categoryKeyInput);
    const result = await this.query<SqlRow>(categorySelectSql('WHERE c.category_key=$1'), [categoryKey]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 类目模板不存在', { categoryKey }, 404);
    const versions = await this.query<SqlRow>('SELECT * FROM ozon_category_template_versions WHERE category_key=$1 ORDER BY version_no DESC', [categoryKey]);
    return { ...toCategory(result.rows[0]), versions: versions.rows.map(toCategoryVersion) };
  }

  async createCategory(input: unknown): Promise<OzonCategoryTemplate> {
    const parsed = ozonCategoryTemplateInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const value = parsed.data;
    assertOzonCategorySizingSnapshot(value);
    return this.transaction(async (client) => {
      const versionId = randomUUID();
      try {
        await client.query(`
          INSERT INTO ozon_category_templates(category_key,name_ru,name_zh,description_category_id,type_id,row_version,draft_version_id)
          VALUES($1,$2,$3,$4,$5,1,$6)`,
        [value.categoryKey, value.nameRu, value.nameZh, value.descriptionCategoryId, value.typeId, versionId]);
      } catch (error: any) {
        if (error?.code === '23505') throw new AppError('CONFIG_INVALID', 'OZON 类目 Key 已存在', { categoryKey: value.categoryKey }, 409);
        throw error;
      }
      await client.query(`
        INSERT INTO ozon_category_template_versions(id,category_key,version_no,status,schema_hash,snapshot,confirmed_by)
        VALUES($1,$2,1,'DRAFT',$3,$4::jsonb,$5)`,
      [versionId, value.categoryKey, schemaHash(value), JSON.stringify(value), value.confirmedBy]);
      return this.getCategoryWithClient(client, value.categoryKey);
    });
  }

  async saveCategoryDraft(categoryKeyInput: string, input: unknown): Promise<OzonCategoryTemplate> {
    const categoryKey = ozonCategoryKeySchema.parse(categoryKeyInput);
    const parsed = ozonCategoryTemplateInputSchema.safeParse({ ...(input as Record<string, unknown>), categoryKey });
    if (!parsed.success) throw validationError(parsed.error.issues);
    const value = parsed.data;
    assertOzonCategorySizingSnapshot(value);
    return this.transaction(async (client) => {
      const category = await client.query<SqlRow>('SELECT * FROM ozon_category_templates WHERE category_key=$1 FOR UPDATE', [categoryKey]);
      if (!category.rows[0]) throw new AppError('NOT_FOUND', 'OZON 类目模板不存在', { categoryKey }, 404);
      let draftId = category.rows[0].draft_version_id as string | null;
      if (!draftId) {
        const max = await client.query<{ version_no: string }>('SELECT COALESCE(MAX(version_no),0) version_no FROM ozon_category_template_versions WHERE category_key=$1', [categoryKey]);
        draftId = randomUUID();
        await client.query(`
          INSERT INTO ozon_category_template_versions(id,category_key,version_no,status,schema_hash,snapshot,confirmed_by)
          VALUES($1,$2,$3,'DRAFT',$4,$5::jsonb,$6)`,
        [draftId, categoryKey, Number(max.rows[0]?.version_no || 0) + 1, schemaHash(value), JSON.stringify(value), value.confirmedBy]);
      } else {
        await client.query(`
          UPDATE ozon_category_template_versions
          SET schema_hash=$2,snapshot=$3::jsonb,confirmed_by=$4,updated_at=NOW()
          WHERE id=$1 AND status='DRAFT'`,
        [draftId, schemaHash(value), JSON.stringify(value), value.confirmedBy]);
      }
      await client.query(`
        UPDATE ozon_category_templates
        SET name_ru=$2,name_zh=$3,description_category_id=$4,type_id=$5,draft_version_id=$6,row_version=row_version+1,updated_at=NOW()
        WHERE category_key=$1`,
      [categoryKey, value.nameRu, value.nameZh, value.descriptionCategoryId, value.typeId, draftId]);
      return this.getCategoryWithClient(client, categoryKey);
    });
  }

  async saveCategoryAttributeOrder(categoryKeyInput: string, input: unknown): Promise<OzonCategoryTemplate> {
    const categoryKey = ozonCategoryKeySchema.parse(categoryKeyInput);
    const parsed = ozonCategoryAttributeOrderInputSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const order: OzonCategoryAttributeOrderInput = parsed.data;
    return this.transaction(async (client) => {
      const category = await client.query<SqlRow>('SELECT * FROM ozon_category_templates WHERE category_key=$1 FOR UPDATE', [categoryKey]);
      const row = category.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 类目模板不存在', { categoryKey }, 404);
      if (Number(row.row_version) !== order.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 类目模板已被其他操作更新，请刷新后重试', {
          categoryKey,
          expected: Number(row.row_version),
          actual: order.rowVersion
        }, 409);
      }

      let draftId = row.draft_version_id as string | null;
      const sourceVersionId = draftId || row.published_version_id as string | null;
      if (!sourceVersionId) throw new AppError('CONFIG_INVALID', 'OZON 类目模板没有可编辑的属性快照', { categoryKey }, 409);
      const source = await client.query<{ snapshot: unknown }>('SELECT snapshot FROM ozon_category_template_versions WHERE id=$1', [sourceVersionId]);
      const snapshotResult = ozonCategoryTemplateInputSchema.safeParse(source.rows[0]?.snapshot);
      if (!snapshotResult.success) throw new AppError('CONFIG_INVALID', 'OZON 类目模板属性快照无效，请先刷新模板', { categoryKey }, 409);
      const snapshot = snapshotResult.data;
      const attributesByKey = new Map(snapshot.attributes.map((attribute) => [`${attribute.id}:${attribute.complexId}`, attribute]));
      const expectedKeys = new Set(attributesByKey.keys());
      if (order.attributeKeys.length !== expectedKeys.size || order.attributeKeys.some((key) => !expectedKeys.has(key))) {
        throw new AppError('CONFIG_INVALID', '属性顺序必须完整包含当前 OZON 模板的全部属性', {
          categoryKey,
          expectedCount: expectedKeys.size,
          actualCount: order.attributeKeys.length
        }, 409);
      }
      const sizing = order.sizing || snapshot.sizing;
      if (sizing.sizeMode === 'sized') {
        const sizeCandidateKeys = new Set(ozonCategorySizeAttributeCandidates(snapshot.attributes)
          .map((attribute) => `${attribute.id}:${attribute.complexId}`));
        if (!sizing.sizeAttributeKey || !sizeCandidateKeys.has(sizing.sizeAttributeKey)) {
          throw new AppError('CONFIG_INVALID', '所选 OZON 尺码属性不是当前类目的有效尺码字段', {
            categoryKey,
            sizeAttributeKey: sizing.sizeAttributeKey,
            candidates: [...sizeCandidateKeys]
          }, 409);
        }
      }
      const value: OzonCategoryTemplateInput = {
        ...snapshot,
        categoryKey,
        media: { defaultVideoUploadMode: order.defaultVideoUploadMode },
        sizing,
        attributes: order.attributeKeys.map((key) => attributesByKey.get(key)!)
      };
      assertOzonCategorySizingSnapshot(value);

      if (!draftId) {
        const max = await client.query<{ version_no: string }>('SELECT COALESCE(MAX(version_no),0) version_no FROM ozon_category_template_versions WHERE category_key=$1', [categoryKey]);
        draftId = randomUUID();
        await client.query(`
          INSERT INTO ozon_category_template_versions(id,category_key,version_no,status,schema_hash,snapshot,confirmed_by)
          VALUES($1,$2,$3,'DRAFT',$4,$5::jsonb,'')`,
        [draftId, categoryKey, Number(max.rows[0]?.version_no || 0) + 1, schemaHash(value), JSON.stringify(value)]);
      } else {
        const updated = await client.query(`
          UPDATE ozon_category_template_versions
          SET schema_hash=$2,snapshot=$3::jsonb,updated_at=NOW()
          WHERE id=$1 AND status='DRAFT'`,
        [draftId, schemaHash(value), JSON.stringify(value)]);
        if (!updated.rowCount) throw new AppError('TASK_LOCKED', 'OZON 类目草稿状态已变化，请刷新后重试', { categoryKey }, 409);
      }
      await client.query(`
        UPDATE ozon_category_templates
        SET draft_version_id=$2,row_version=row_version+1,updated_at=NOW()
        WHERE category_key=$1`,
      [categoryKey, draftId]);
      return this.getCategoryWithClient(client, categoryKey);
    });
  }

  async publishCategory(categoryKeyInput: string, confirmedBy: string): Promise<OzonCategoryTemplate> {
    const categoryKey = ozonCategoryKeySchema.parse(categoryKeyInput);
    return this.transaction(async (client) => {
      const category = await client.query<SqlRow>('SELECT * FROM ozon_category_templates WHERE category_key=$1 FOR UPDATE', [categoryKey]);
      if (!category.rows[0]) throw new AppError('NOT_FOUND', 'OZON 类目模板不存在', { categoryKey }, 404);
      const draftId = category.rows[0].draft_version_id as string | null;
      if (!draftId) throw new AppError('CONFIG_INVALID', '没有可发布的 OZON 类目草稿', { categoryKey }, 409);
      const draft = await client.query<{ snapshot: unknown }>('SELECT snapshot FROM ozon_category_template_versions WHERE id=$1 AND status=\'DRAFT\'', [draftId]);
      const snapshot = ozonCategoryTemplateInputSchema.safeParse(draft.rows[0]?.snapshot);
      if (!snapshot.success) throw new AppError('CONFIG_INVALID', 'OZON 类目草稿快照无效，请先刷新模板', { categoryKey }, 409);
      assertOzonCategorySizingSnapshot(snapshot.data);
      await client.query(`UPDATE ozon_category_template_versions SET status='ARCHIVED',updated_at=NOW() WHERE category_key=$1 AND status='PUBLISHED'`, [categoryKey]);
      await client.query(`
        UPDATE ozon_category_template_versions
        SET status='PUBLISHED',confirmed_by=$2,published_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='DRAFT'`,
      [draftId, String(confirmedBy || '').trim()]);
      await client.query(`
        UPDATE ozon_category_templates
        SET published_version_id=$2,draft_version_id=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE category_key=$1`,
      [categoryKey, draftId]);
      return this.getCategoryWithClient(client, categoryKey);
    });
  }

  async deleteCategory(categoryKeyInput: string): Promise<{ categoryKey: string; nameRu: string }> {
    const categoryKey = ozonCategoryKeySchema.parse(categoryKeyInput);
    return this.transaction(async (client) => {
      const dependencies = await client.query<{ count: string }>(`
        SELECT (
          (SELECT COUNT(*) FROM ozon_listing_drafts WHERE data->>'categoryKey'=$1)
          +(SELECT COUNT(*) FROM ozon_listing_presets WHERE definition->>'categoryKey'=$1)
        )::text count`,
      [categoryKey]);
      if (Number(dependencies.rows[0]?.count || 0) > 0) {
        throw new AppError('CONFIG_INVALID', 'OZON 类目模板仍被草稿或预设引用，不能删除', { categoryKey }, 409);
      }
      const deleted = await client.query<{ category_key: string; name_ru: string }>('DELETE FROM ozon_category_templates WHERE category_key=$1 RETURNING category_key,name_ru', [categoryKey]);
      if (!deleted.rows[0]) throw new AppError('NOT_FOUND', 'OZON 类目模板不存在', { categoryKey }, 404);
      return { categoryKey: deleted.rows[0].category_key, nameRu: deleted.rows[0].name_ru };
    });
  }

  async recoverAbandonedCatalogRuns(): Promise<number> {
    const result = await this.query(`UPDATE ozon_catalog_sync_runs
      SET status='FAILED',error_code='SYNC_INTERRUPTED',error_message='应用重启前的 OZON 类目同步未完成',completed_at=NOW(),heartbeat_at=NOW()
      WHERE status='RUNNING'`);
    return result.rowCount || 0;
  }

  async beginCatalogRun(trigger: OzonCatalogTrigger, scheduleKey?: string): Promise<{ run: OzonCatalogSyncRun; created: boolean }> {
    const runId = randomUUID();
    try {
      const result = await this.query<SqlRow>(`INSERT INTO ozon_catalog_sync_runs(id,trigger,status,schedule_key)
        VALUES($1,$2,'RUNNING',$3) RETURNING *`, [runId, trigger, scheduleKey || null]);
      return { run: toCatalogRun(result.rows[0]!), created: true };
    } catch (error: any) {
      if (error?.code !== '23505') throw error;
      const current = await this.query<SqlRow>(scheduleKey
        ? "SELECT * FROM ozon_catalog_sync_runs WHERE status='RUNNING' OR (trigger='SCHEDULED' AND schedule_key=$1) ORDER BY status='RUNNING' DESC,started_at DESC LIMIT 1"
        : "SELECT * FROM ozon_catalog_sync_runs WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1", scheduleKey ? [scheduleKey] : []);
      if (!current.rows[0]) throw error;
      return { run: toCatalogRun(current.rows[0]), created: false };
    }
  }

  async updateCatalogRunProgress(runId: string, input: { processedEntries?: number; totalEntries?: number; chineseMissingCount?: number }): Promise<void> {
    await this.query(`UPDATE ozon_catalog_sync_runs SET
      processed_entries=COALESCE($2,processed_entries),total_entries=COALESCE($3,total_entries),
      chinese_missing_count=COALESCE($4,chinese_missing_count),heartbeat_at=NOW()
      WHERE id=$1 AND status='RUNNING'`, [runId, input.processedEntries ?? null, input.totalEntries ?? null, input.chineseMissingCount ?? null]);
  }

  async completeCatalogRun(
    runId: string,
    entries: OzonCatalogEntryInput[],
    dictionaryValues: OzonCatalogDictionaryValueInput[],
    snapshotPath: string,
    sourceHash: string,
    chineseMissingCount: number
  ): Promise<void> {
    await this.transaction(async (client) => {
      const running = await client.query<SqlRow>("SELECT * FROM ozon_catalog_sync_runs WHERE id=$1 AND status='RUNNING' FOR UPDATE", [runId]);
      if (!running.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 类目同步任务状态已变化', { runId }, 409);
      await client.query(`WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
            description_category_id BIGINT,type_id BIGINT,category_name_zh TEXT,type_name_zh TEXT,
            category_name_ru TEXT,type_name_ru TEXT,path_zh JSONB,path_ru JSONB,search_text_zh TEXT
          )
        ) INSERT INTO ozon_catalog_entries(
          description_category_id,type_id,category_name_zh,type_name_zh,category_name_ru,type_name_ru,
          path_zh,path_ru,search_text_zh,active,missing_sync_count,last_seen_run_id,updated_at
        ) SELECT description_category_id,type_id,category_name_zh,type_name_zh,category_name_ru,type_name_ru,
          path_zh,path_ru,search_text_zh,true,0,$1,NOW() FROM incoming
        ON CONFLICT(description_category_id,type_id) DO UPDATE SET
          category_name_zh=EXCLUDED.category_name_zh,type_name_zh=EXCLUDED.type_name_zh,
          category_name_ru=EXCLUDED.category_name_ru,type_name_ru=EXCLUDED.type_name_ru,
          path_zh=EXCLUDED.path_zh,path_ru=EXCLUDED.path_ru,search_text_zh=EXCLUDED.search_text_zh,
          active=true,missing_sync_count=0,last_seen_run_id=$1,updated_at=NOW()`, [
        runId,
        JSON.stringify(entries.map((entry) => ({
          description_category_id: entry.descriptionCategoryId,
          type_id: entry.typeId,
          category_name_zh: entry.categoryNameZh,
          type_name_zh: entry.typeNameZh,
          category_name_ru: entry.categoryNameRu,
          type_name_ru: entry.typeNameRu,
          path_zh: entry.pathZh,
          path_ru: entry.pathRu,
          search_text_zh: normalizeCatalogText([...entry.pathZh, entry.categoryNameZh, entry.typeNameZh].join(' '))
        })))
      ]);
      await client.query(`UPDATE ozon_catalog_entries SET missing_sync_count=missing_sync_count+1,
        active=CASE WHEN missing_sync_count+1>=2 THEN false ELSE active END,updated_at=NOW()
        WHERE last_seen_run_id IS DISTINCT FROM $1`, [runId]);
      await client.query(`WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
            directory TEXT,attribute_id BIGINT,dictionary_id BIGINT,value_id BIGINT,
            name_ru TEXT,name_zh TEXT,info_ru TEXT,info_zh TEXT,position INTEGER,search_text TEXT
          )
        ) INSERT INTO ozon_catalog_dictionary_values(
          directory,attribute_id,dictionary_id,value_id,name_ru,name_zh,info_ru,info_zh,
          position,search_text,active,missing_sync_count,last_seen_run_id,updated_at
        ) SELECT directory,attribute_id,dictionary_id,value_id,name_ru,name_zh,info_ru,info_zh,
          position,search_text,true,0,$1,NOW() FROM incoming
        ON CONFLICT(directory,dictionary_id,value_id) DO UPDATE SET
          attribute_id=EXCLUDED.attribute_id,name_ru=EXCLUDED.name_ru,name_zh=EXCLUDED.name_zh,
          info_ru=EXCLUDED.info_ru,info_zh=EXCLUDED.info_zh,position=EXCLUDED.position,
          search_text=EXCLUDED.search_text,active=true,missing_sync_count=0,last_seen_run_id=$1,updated_at=NOW()`, [
        runId,
        JSON.stringify(dictionaryValues.map((entry) => ({
          directory: entry.directory,
          attribute_id: entry.attributeId,
          dictionary_id: entry.dictionaryId,
          value_id: entry.valueId,
          name_ru: entry.nameRu,
          name_zh: entry.nameZh,
          info_ru: entry.infoRu || '',
          info_zh: entry.infoZh || '',
          position: entry.position,
          search_text: normalizeCatalogText(`${entry.nameZh} ${entry.nameRu}`)
        })))
      ]);
      await client.query(`UPDATE ozon_catalog_dictionary_values SET missing_sync_count=missing_sync_count+1,
        active=CASE WHEN missing_sync_count+1>=2 THEN false ELSE active END,updated_at=NOW()
        WHERE last_seen_run_id IS DISTINCT FROM $1`, [runId]);
      const completed = await client.query(`UPDATE ozon_catalog_sync_runs SET status='SUCCEEDED',processed_entries=$2,total_entries=$2,
        chinese_missing_count=$3,snapshot_path=$4,source_hash=$5,error_code=NULL,error_message=NULL,
        completed_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='RUNNING'`, [
        runId, entries.length, chineseMissingCount, snapshotPath, sourceHash
      ]);
      if (!completed.rowCount) throw new AppError('TASK_LOCKED', 'OZON 类目同步完成状态冲突', { runId }, 409);
    });
  }

  async failCatalogRun(runId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.query(`UPDATE ozon_catalog_sync_runs SET status='FAILED',error_code=$2,error_message=$3,
      completed_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='RUNNING'`, [runId, errorCode, errorMessage.slice(0, 4_000)]);
  }

  async catalogOverview(): Promise<OzonCatalogOverview> {
    const [counts, dictionaryRows, current, latest, successful] = await Promise.all([
      this.query<{ entry_count: string }>('SELECT COUNT(*)::text entry_count FROM ozon_catalog_entries WHERE active=true'),
      this.query<{ directory: OzonCatalogDictionaryName; count: string }>(`SELECT directory,COUNT(*)::text count
        FROM ozon_catalog_dictionary_values WHERE active=true GROUP BY directory`),
      this.query<SqlRow>("SELECT * FROM ozon_catalog_sync_runs WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1"),
      this.query<SqlRow>('SELECT * FROM ozon_catalog_sync_runs ORDER BY started_at DESC LIMIT 1'),
      this.query<SqlRow>("SELECT * FROM ozon_catalog_sync_runs WHERE status='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1")
    ]);
    return {
      entryCount: Number(counts.rows[0]?.entry_count || 0),
      chineseMissingCount: Number(successful.rows[0]?.chinese_missing_count || 0),
      dictionaryCounts: {
        countries: Number(dictionaryRows.rows.find((row) => row.directory === 'countries')?.count || 0),
        seasons: Number(dictionaryRows.rows.find((row) => row.directory === 'seasons')?.count || 0),
        kinds: Number(dictionaryRows.rows.find((row) => row.directory === 'kinds')?.count || 0),
        colors: Number(dictionaryRows.rows.find((row) => row.directory === 'colors')?.count || 0)
      },
      ...(current.rows[0] ? { currentRun: toCatalogRun(current.rows[0]) } : {}),
      ...(latest.rows[0] ? { latestRun: toCatalogRun(latest.rows[0]) } : {}),
      ...(successful.rows[0]?.completed_at ? { lastSuccessfulAt: iso(successful.rows[0].completed_at) } : {})
    };
  }

  async searchCatalogEntries(queryInput: string, limitInput = 30): Promise<OzonCatalogEntry[]> {
    const query = normalizeCatalogText(queryInput);
    const limit = Math.min(50, Math.max(1, Math.trunc(limitInput) || 30));
    const result = await this.query<SqlRow>(`SELECT * FROM ozon_catalog_entries
      WHERE active=true AND category_name_zh<>'' AND type_name_zh<>'' AND search_text_zh LIKE '%' || $1 || '%'
      ORDER BY CASE WHEN type_name_zh=$1 THEN 0 WHEN category_name_zh=$1 THEN 1
        WHEN type_name_zh LIKE $1 || '%' THEN 2 WHEN category_name_zh LIKE $1 || '%' THEN 3 ELSE 4 END,
        jsonb_array_length(path_zh),type_name_zh,description_category_id,type_id LIMIT $2`, [query, limit]);
    return result.rows.map(toCatalogEntry);
  }

  async getCatalogEntry(catalogEntryId: string): Promise<OzonCatalogEntry> {
    const [descriptionCategoryId, typeId] = parseCatalogEntryId(catalogEntryId);
    const result = await this.query<SqlRow>(`SELECT * FROM ozon_catalog_entries
      WHERE description_category_id=$1 AND type_id=$2 AND active=true AND category_name_zh<>'' AND type_name_zh<>''`, [descriptionCategoryId, typeId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 本地中文类目不存在或已停用', { catalogEntryId }, 404);
    return toCatalogEntry(result.rows[0]);
  }

  async searchCatalogDictionary(
    directory: OzonCatalogDictionaryName,
    input: { dictionaryId?: number; query?: string; limit?: number } = {}
  ): Promise<OzonCatalogDictionaryValue[]> {
    const dictionaryId = input.dictionaryId && Number.isInteger(input.dictionaryId) && input.dictionaryId > 0
      ? input.dictionaryId
      : undefined;
    const query = normalizeCatalogText(input.query || '');
    const limit = Math.min(2_000, Math.max(1, Math.trunc(input.limit || 1_000)));
    const result = await this.query<SqlRow>(`SELECT * FROM ozon_catalog_dictionary_values
      WHERE active=true AND directory=$1
        AND ($2::bigint IS NULL OR dictionary_id=$2)
        AND ($3='' OR search_text LIKE '%' || $3 || '%')
      ORDER BY dictionary_id,position,name_zh,name_ru,value_id LIMIT $4`, [
      directory, dictionaryId || null, query, limit
    ]);
    return result.rows.map(toCatalogDictionaryValue);
  }

  async getActiveCatalogDictionaryValue(
    directory: OzonCatalogDictionaryName,
    dictionaryIdInput: number,
    valueIdInput: number
  ): Promise<OzonCatalogDictionaryValue> {
    const dictionaryId = Number(dictionaryIdInput);
    const valueId = Number(valueIdInput);
    if (!Number.isSafeInteger(dictionaryId) || dictionaryId < 1
      || !Number.isSafeInteger(valueId) || valueId < 1) {
      throw new AppError('CONFIG_INVALID', 'OZON 目录值身份无效', {
        directory,
        dictionaryId: dictionaryIdInput,
        valueId: valueIdInput
      }, 400);
    }
    const result = await this.query<SqlRow>(`SELECT * FROM ozon_catalog_dictionary_values
      WHERE active=true AND directory=$1 AND dictionary_id=$2 AND value_id=$3 LIMIT 2`, [
      directory, dictionaryId, valueId
    ]);
    if (result.rows.length !== 1) {
      throw new AppError('NOT_FOUND', 'OZON 本地目录值不存在、已停用或身份不唯一', {
        directory, dictionaryId, valueId, matches: result.rows.length
      }, 404);
    }
    return toCatalogDictionaryValue(result.rows[0]!);
  }

  async listSuccessfulCatalogSnapshotPaths(limitInput = 7): Promise<string[]> {
    const limit = Math.min(100, Math.max(1, Math.trunc(limitInput) || 7));
    const result = await this.query<{ snapshot_path: string }>(`SELECT snapshot_path FROM ozon_catalog_sync_runs
      WHERE status='SUCCEEDED' AND snapshot_path IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => row.snapshot_path);
  }

  async listPresets(): Promise<OzonPreset[]> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_listing_presets ORDER BY updated_at DESC,id');
    return result.rows.map(toPreset);
  }

  async getPreset(id: string): Promise<OzonPreset> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_listing_presets WHERE id=$1', [id]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品预设不存在', { id }, 404);
    return toPreset(result.rows[0]);
  }

  async createPreset(input: unknown): Promise<OzonPreset> {
    const parsed = ozonPresetInputSchema.safeParse(normalizePresetWriteInput(input));
    if (!parsed.success) throw validationError(parsed.error.issues);
    const definition = parsed.data;
    const id = randomUUID();
    return this.transaction(async (client) => {
      await assertOzonPresetMatchesPublishedCategory(client, definition);
      const result = await client.query<SqlRow>(`
        INSERT INTO ozon_listing_presets(id,name,description,row_version,definition)
        VALUES($1,$2,$3,1,$4::jsonb) RETURNING *`,
      [id, definition.name, definition.description, JSON.stringify(definition)]);
      return toPreset(result.rows[0]!);
    });
  }

  async updatePreset(id: string, input: unknown): Promise<OzonPreset> {
    const parsed = ozonPresetUpdateSchema.safeParse(normalizePresetWriteInput(input));
    if (!parsed.success) throw validationError(parsed.error.issues);
    const { rowVersion, ...definition } = parsed.data;
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM ozon_listing_presets WHERE id=$1 FOR UPDATE', [id]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品预设不存在', { id }, 404);
      if (Number(current.rows[0].row_version) !== rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 预设已被其他操作更新，请刷新后重试', { id, expected: rowVersion, actual: Number(current.rows[0].row_version) }, 409);
      }
      await assertOzonPresetMatchesPublishedCategory(client, definition);
      const result = await client.query<SqlRow>(`
        UPDATE ozon_listing_presets
        SET name=$2,description=$3,definition=$4::jsonb,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [id, definition.name, definition.description, JSON.stringify(definition)]);
      return toPreset(result.rows[0]!);
    });
  }

  async clonePreset(id: string, name?: string): Promise<OzonPreset> {
    const source = await this.getPreset(id);
    return this.createPreset({
      ...currentPresetDefinition(source),
      name: String(name || `${source.name} 副本`).trim()
    });
  }

  async deletePreset(id: string, rowVersion: number): Promise<{ id: string; name: string }> {
    const bound = await this.query<{ id: string; store_alias: string; display_name: string }>(`
      SELECT id,store_alias,display_name FROM ozon_stores
      WHERE default_preset_id=$1 ORDER BY archived_at NULLS FIRST,store_alias`, [id]);
    if (bound.rows.length) {
      throw new AppError('OZON_PRESET_IN_USE', '该预设仍被 OZON 店铺绑定，请先在店铺设置中重新绑定', {
        id,
        stores: bound.rows.map((store) => ({ id: store.id, storeAlias: store.store_alias, displayName: store.display_name }))
      }, 409);
    }
    const result = await this.query<{ id: string; name: string }>('DELETE FROM ozon_listing_presets WHERE id=$1 AND row_version=$2 RETURNING id,name', [id, rowVersion]);
    if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 预设已被更新或不存在', { id }, 409);
    return result.rows[0];
  }

  async listJobs(input: OzonJobListInput): Promise<{ items: OzonPublishJob[]; total: number; page: number; pageSize: number }> {
    const page = finitePage(input.page);
    const pageSize = finitePageSize(input.pageSize);
    const purchaseDateRange = normalizePurchaseCreatedDateRange(input);
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (input.query?.trim()) {
      values.push(`%${input.query.trim()}%`);
      predicates.push(`(j.sku ILIKE $${values.length} OR COALESCE(j.offer_id,'') ILIKE $${values.length})`);
    }
    if (input.state?.trim()) {
      values.push(input.state.trim());
      predicates.push(`j.state=$${values.length}`);
    }
    if (input.source) {
      values.push(input.source);
      predicates.push(`j.source=$${values.length}`);
    }
    if (input.businessOnly) {
      predicates.push(ozonBusinessJobPredicate('j'));
    }
    if (input.sku?.trim()) {
      values.push(normalizeSku(input.sku));
      predicates.push(`j.sku=$${values.length}`);
    }
    if (input.remoteOnly) {
      predicates.push(`(
        NULLIF(j.task_id,'') IS NOT NULL
        OR NULLIF(j.import_task_id,'') IS NOT NULL
        OR NULLIF(j.ozon_product_id,'') IS NOT NULL
        OR j.directory_stage='PROCESSING'
        OR j.state IN ('SUBMITTING','UPLOADING_MEDIA','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
      )`);
    }
    if (input.activeOnly) {
      values.push(ACTIVE_JOB_STATES);
      predicates.push(`j.state = ANY($${values.length}::text[])`);
    }
    if (purchaseDateRange.purchaseCreatedFrom) {
      values.push(purchaseDateRange.purchaseCreatedFrom);
      predicates.push(`p.created_at >= $${values.length}::timestamptz`);
    }
    if (purchaseDateRange.purchaseCreatedTo) {
      values.push(purchaseDateRange.purchaseCreatedTo);
      predicates.push(`p.created_at < $${values.length}::timestamptz`);
    }
    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const from = `FROM ozon_publish_jobs j
      LEFT JOIN products p ON p.sku=j.sku
      LEFT JOIN ozon_store_publications publication ON publication.id=j.publication_id
      LEFT JOIN ozon_listing_presets source_preset ON source_preset.id=publication.preset_id`;
    const count = await this.query<{ count: string }>(`SELECT COUNT(*) count ${from} ${where}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`SELECT j.*,
      publication.preset_id summary_preset_id,publication.preset_row_version summary_preset_row_version,
      publication.publication_mode summary_publication_mode,
      publication.materialized_product_snapshot summary_materialized_product_snapshot,
      source_preset.id summary_source_preset_id
      ${from} ${where} ORDER BY j.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return {
      items: await this.withCurrentPlatformLinks(rows.rows),
      total: Number(count.rows[0]?.count || 0),
      page,
      pageSize
    };
  }

  async listRuntimeJobs(
    input: OzonRuntimeJobListInput = {}
  ): Promise<{ items: OzonPublishJob[]; total: number; page: number; pageSize: number }> {
    const page = finitePage(input.page);
    const pageSize = finitePageSize(input.pageSize);
    const values: unknown[] = [RUNTIME_ADVANCEABLE_JOB_STATES];
    const predicates = [
      `j.state = ANY($1::text[])`,
      `(j.next_attempt_at IS NULL OR j.next_attempt_at <= NOW())`,
      `(j.lease_expires_at IS NULL OR j.lease_expires_at <= NOW())`,
      `CASE
        WHEN COALESCE(j.payload->>'finalVerificationLeaseUntil','') ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          THEN (j.payload->>'finalVerificationLeaseUntil')::timestamptz <= NOW()
        ELSE TRUE
      END`
    ];
    if (input.query?.trim()) {
      values.push(`%${input.query.trim()}%`);
      predicates.push(`(j.sku ILIKE $${values.length} OR COALESCE(j.offer_id,'') ILIKE $${values.length})`);
    }
    if (input.state?.trim()) {
      values.push(input.state.trim());
      predicates.push(`j.state=$${values.length}`);
    }
    if (input.remoteOnly) {
      predicates.push(`(
        NULLIF(j.task_id,'') IS NOT NULL
        OR NULLIF(j.import_task_id,'') IS NOT NULL
        OR NULLIF(j.ozon_product_id,'') IS NOT NULL
        OR j.directory_stage='PROCESSING'
        OR j.state IN ('SUBMITTING','UPLOADING_MEDIA','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
      )`);
    }
    const from = 'FROM ozon_publish_jobs j';
    const where = `WHERE ${predicates.join(' AND ')}`;
    const count = await this.query<{ count: string }>(`SELECT COUNT(*) count ${from} ${where}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`
      SELECT j.* ${from} ${where}
      ORDER BY
        CASE
          WHEN j.payload ? 'networkRecovery' THEN 0
          WHEN j.state IN ('UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
            OR j.directory_stage='PROCESSING' THEN 1
          ELSE 2
        END,
        COALESCE(j.next_attempt_at,j.updated_at) ASC,j.id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values);
    return { items: rows.rows.map(toJob), total: Number(count.rows[0]?.count || 0), page, pageSize };
  }

  async claimRuntimeJob(input: OzonRuntimeClaimInput): Promise<OzonPublishJob | undefined> {
    const leaseOwner = normalizeLeaseOwner(input.leaseOwner);
    const leaseSeconds = normalizeRuntimeLeaseSeconds(input.leaseSeconds);
    const claimStates = input.states?.length
      ? RUNTIME_ADVANCEABLE_JOB_STATES.filter((state) => input.states!.includes(state))
      : RUNTIME_ADVANCEABLE_JOB_STATES;
    if (!claimStates.length) return undefined;
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['merchroute-ozon-runtime-write-slot']);
      await client.query(`DELETE FROM ozon_publish_slots WHERE slot_key=$1 AND lease_expires_at<=NOW()`, [OZON_RUNTIME_SLOT_KEY]);
      await client.query(`UPDATE ozon_publish_jobs
        SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE lease_expires_at<=NOW()`, []);
      const occupied = await client.query<SqlRow>(`
        SELECT job_id,lease_owner,lease_expires_at FROM ozon_publish_slots
        WHERE slot_key=$1 AND lease_expires_at>NOW() FOR UPDATE`,
      [OZON_RUNTIME_SLOT_KEY]);
      if (occupied.rows[0]) return undefined;
      const selected = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs j
        WHERE j.state=ANY($1::text[])
          AND NOT (j.payload @> '{"recoveryHold":{"active":true}}'::jsonb)
          AND (j.state<>'READY' OR (
            NULLIF(j.task_id,'') IS NOT NULL
            OR NULLIF(j.import_task_id,'') IS NOT NULL
            OR NULLIF(j.ozon_product_id,'') IS NOT NULL
            OR j.directory_stage='PROCESSING'
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(j.product_links)='array' THEN j.product_links ELSE '[]'::jsonb END
              ) link
              WHERE NULLIF(BTRIM(COALESCE(link->>'ozonProductId','')),'') IS NOT NULL
                 OR NULLIF(BTRIM(COALESCE(link->>'ozonSku','')),'') IS NOT NULL
                 OR NULLIF(BTRIM(COALESCE(link->>'url','')),'') IS NOT NULL
            )
          ))
          AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=NOW())
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())
          ${input.remoteOnly ? `AND (
            NULLIF(j.task_id,'') IS NOT NULL
            OR NULLIF(j.import_task_id,'') IS NOT NULL
            OR NULLIF(j.ozon_product_id,'') IS NOT NULL
            OR j.directory_stage='PROCESSING'
            OR j.state IN ('SUBMITTING','UPLOADING_MEDIA','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
          )` : ''}
          AND CASE
            WHEN COALESCE(j.payload->>'finalVerificationLeaseUntil','') ~
              '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
              THEN (j.payload->>'finalVerificationLeaseUntil')::timestamptz<=NOW()
            ELSE TRUE
          END
        ORDER BY
          CASE
            WHEN j.payload ? 'networkRecovery' THEN 0
            WHEN j.state IN ('UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
              OR j.directory_stage='PROCESSING' THEN 1
            ELSE 2
          END,
          COALESCE(j.next_attempt_at,j.updated_at) ASC,j.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [claimStates]);
      const row = selected.rows[0];
      if (!row) return undefined;
      const leaseToken = randomUUID();
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET lease_owner=$2,lease_token=$3::uuid,lease_expires_at=NOW()+make_interval(secs=>$4),
            row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$5
        RETURNING *`,
      [row.id, leaseOwner, leaseToken, leaseSeconds, Number(row.row_version)]);
      if (!updated.rows[0]) return undefined;
      await client.query(`INSERT INTO ozon_publish_slots(slot_key,job_id,lease_owner,lease_token,lease_expires_at,updated_at)
        VALUES($1,$2,$3,$4::uuid,NOW()+make_interval(secs=>$5),NOW())
        ON CONFLICT(slot_key) DO UPDATE SET
          job_id=EXCLUDED.job_id,lease_owner=EXCLUDED.lease_owner,lease_token=EXCLUDED.lease_token,
          lease_expires_at=EXCLUDED.lease_expires_at,updated_at=NOW()`,
      [OZON_RUNTIME_SLOT_KEY, row.id, leaseOwner, leaseToken, leaseSeconds]);
      await addEvent(client, String(row.id), 'RUNTIME_LEASE_CLAIMED', row.state, row.state, 'OZON 运行时已领取平台单写槽', {
        leaseOwner,
        leaseToken,
        leaseSeconds
      });
      return toJob(updated.rows[0]);
    });
  }

  async renewRuntimeLease(id: string, input: OzonRuntimeLeaseInput): Promise<OzonPublishJob> {
    const leaseOwner = normalizeLeaseOwner(input.leaseOwner);
    const leaseToken = normalizeLeaseToken(input.leaseToken);
    const leaseSeconds = normalizeRuntimeLeaseSeconds(input.leaseSeconds);
    return this.transaction(async (client) => {
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET lease_expires_at=NOW()+make_interval(secs=>$5),updated_at=NOW()
        WHERE id=$1 AND row_version=$2 AND lease_owner=$3 AND lease_token=$4::uuid AND lease_expires_at>NOW()
        RETURNING *`,
      [id, input.rowVersion, leaseOwner, leaseToken, leaseSeconds]);
      if (!updated.rows[0]) throw runtimeLeaseLost(id, input.rowVersion);
      const slot = await client.query(`UPDATE ozon_publish_slots
        SET lease_expires_at=NOW()+make_interval(secs=>$5),updated_at=NOW()
        WHERE slot_key=$1 AND job_id=$2 AND lease_owner=$3 AND lease_token=$4::uuid AND lease_expires_at>NOW()`,
      [OZON_RUNTIME_SLOT_KEY, id, leaseOwner, leaseToken, leaseSeconds]);
      if (slot.rowCount !== 1) throw runtimeLeaseLost(id, input.rowVersion);
      return toJob(updated.rows[0]);
    });
  }

  async releaseRuntimeLease(id: string, input: Omit<OzonRuntimeLeaseInput, 'leaseSeconds'>): Promise<OzonPublishJob> {
    const leaseOwner = normalizeLeaseOwner(input.leaseOwner);
    const leaseToken = normalizeLeaseToken(input.leaseToken);
    return this.transaction(async (client) => {
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$2 AND lease_owner=$3 AND lease_token=$4::uuid
        RETURNING *`,
      [id, input.rowVersion, leaseOwner, leaseToken]);
      if (!updated.rows[0]) throw runtimeLeaseLost(id, input.rowVersion);
      await client.query(`DELETE FROM ozon_publish_slots
        WHERE slot_key=$1 AND job_id=$2 AND lease_owner=$3 AND lease_token=$4::uuid`,
      [OZON_RUNTIME_SLOT_KEY, id, leaseOwner, leaseToken]);
      await addEvent(client, id, 'RUNTIME_LEASE_RELEASED', updated.rows[0].state, updated.rows[0].state, 'OZON 运行时已释放平台单写槽', {
        leaseOwner,
        leaseToken
      });
      return toJob(updated.rows[0]);
    });
  }

  async listHistoricalNetworkRecoveryCandidates(limitInput = 100): Promise<OzonPublishJob[]> {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(limitInput) || 100)));
    const result = await this.query<SqlRow>(`
      SELECT * FROM ozon_publish_jobs
      WHERE state IN ('FAILED','NEEDS_ATTENTION')
        AND (
          payload #>> '{networkRecovery,status}'='WAITING_NETWORK'
          OR UPPER(COALESCE(last_error_code,''))=ANY($1::text[])
          OR (
            last_error_code='N8N_DISPATCH_FAILED'
            AND COALESCE(last_error_message,'') ~* '(network|fetch failed|socket|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|网络|断网|连接)'
          )
        )
      ORDER BY updated_at ASC,id ASC
      LIMIT $2`,
    [HISTORICAL_NETWORK_ERROR_CODES, limit]);
    return result.rows.map(toJob);
  }

  isHistoricalNetworkRecoveryCandidate(job: OzonPublishJob): boolean {
    return isHistoricalNetworkRecoveryCandidate(job);
  }

  async recoverHistoricalNetworkJob(
    id: string,
    rowVersion: number,
    beforeCommit?: (job: OzonPublishJob) => Promise<void>
  ): Promise<OzonPublishJob> {
    return this.transaction(async (client) => {
      const identity = await client.query<SqlRow>('SELECT sku FROM ozon_publish_jobs WHERE id=$1', [id]);
      if (!identity.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      await lockSkuJob(client, normalizeSku(identity.rows[0].sku));
      const result = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      if (Number(row.row_version) !== rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id, expected: row.row_version, actual: rowVersion }, 409);
      }
      const job = toJob(row);
      if (!isHistoricalNetworkRecoveryCandidate(job)) {
        throw new AppError('CONFIG_INVALID', '该任务不是可自动原地恢复的网络失败候选', {
          id,
          state: job.state,
          errorCode: job.lastErrorCode
        }, 409);
      }
      const newerOwner = await client.query<SqlRow>(`
        SELECT id,state FROM ozon_publish_jobs
        WHERE sku=$1 AND id<>$2 AND created_at>$3
          AND (
            state=ANY($4::text[])
            OR state='SUCCEEDED'
            OR NULLIF(task_id,'') IS NOT NULL
            OR NULLIF(import_task_id,'') IS NOT NULL
            OR NULLIF(ozon_product_id,'') IS NOT NULL
            OR directory_stage IN ('PROCESSING','SUCCESS')
          )
        ORDER BY created_at DESC,id DESC
        LIMIT 1
        FOR UPDATE`,
      [job.sku, id, row.created_at, ACTIVE_JOB_STATES]);
      if (newerOwner.rows[0]) {
        throw new AppError('TASK_LOCKED', '该 SKU 已有更新的 OZON 任务或平台结果，不能恢复历史任务', {
          id,
          conflictingJobId: newerOwner.rows[0].id,
          conflictingState: newerOwner.rows[0].state
        }, 409);
      }
      const leaseActive = row.lease_expires_at && Date.parse(String(row.lease_expires_at)) > Date.now();
      if (leaseActive) throw runtimeLeaseLost(id, rowVersion);
      await assertNoActivePlatformStatusRefreshLease(client, String(row.sku), id);
      const resumeState = historicalNetworkResumeState(job);
      const now = new Date().toISOString();
      const priorRecovery = job.payload?.networkRecovery;
      const networkRecovery: OzonNetworkRecovery = {
        schemaVersion: 1,
        status: 'WAITING_NETWORK',
        phase: priorRecovery?.phase || 'HISTORICAL_RECOVERY',
        resumeState,
        deliveryState: priorRecovery?.deliveryState || 'UNKNOWN',
        attempt: Math.max(1, Number(priorRecovery?.attempt || job.retryCount || 1)),
        firstFailureAt: priorRecovery?.firstFailureAt || job.updatedAt,
        lastFailureAt: priorRecovery?.lastFailureAt || job.updatedAt,
        nextAttemptAt: now,
        errorCode: priorRecovery?.errorCode || job.lastErrorCode || 'OZON_NETWORK_ERROR',
        errorMessage: priorRecovery?.errorMessage || job.lastErrorMessage || '历史网络失败任务等待恢复',
        ...(priorRecovery?.retryAfterMs !== undefined ? { retryAfterMs: priorRecovery.retryAfterMs } : {}),
        ...(priorRecovery?.checkpoint ? { checkpoint: priorRecovery.checkpoint } : {})
      };
      const payload = { ...jsonObject(row.payload), networkRecovery, historicalNetworkRecoveredAt: now };
      if (beforeCommit) await beforeCommit(job);
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET state=$2,payload=$3::jsonb,next_attempt_at=$4,finished_at=NULL,
            lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$5
        RETURNING *`,
      [id, resumeState, JSON.stringify(payload), now, rowVersion]);
      if (!updated.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id }, 409);
      await client.query('DELETE FROM ozon_publish_slots WHERE job_id=$1', [id]);
      await addEvent(
        client,
        id,
        'HISTORICAL_NETWORK_RECOVERY_SCHEDULED',
        job.state,
        resumeState,
        '历史网络失败任务已按原 job、revision、Offer 和目录原地恢复',
        { networkRecovery }
      );
      return toJob(updated.rows[0]);
    });
  }

  async recoverKnownPrePlatformFailure(
    id: string,
    input: OzonKnownPrePlatformFailureRecoveryInput,
    beforeCommit?: (job: OzonPublishJob) => Promise<OzonKnownPrePlatformFailureRecoveryChecks>,
    runtimePathProjection?: OzonPublishJob
  ): Promise<OzonKnownPrePlatformFailureRecoveryResult> {
    return this.transaction(async (client) => {
      const identity = await client.query<SqlRow>('SELECT sku FROM ozon_publish_jobs WHERE id=$1', [id]);
      if (!identity.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      const sku = normalizeSku(identity.rows[0].sku);
      await lockSkuJob(client, sku);

      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = jobResult.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      const effectiveRow = applyRuntimePathProjection(row, runtimePathProjection);
      const job = toJob(effectiveRow);
      const listing = listingRow ? toListing(listingRow) : undefined;
      const payload = jsonObject(row.payload);
      const priorRecovery = jsonObject(payload.knownPrePlatformFailureRecovery);
      if (priorRecovery.reason === input.reason && nonBlank(priorRecovery.recoveredAt)) {
        return knownPrePlatformRecoveryResult({
          status: 'ALREADY_RECOVERED',
          reason: input.reason,
          dryRun: input.dryRun,
          job,
          listing,
          proposed: knownRecoveryProposal(input.reason, row, priorRecovery)
        });
      }
      assertKnownPrePlatformFrozenPolicy(row, input.reason);
      if (Number(row.row_version) !== input.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', {
          id,
          expected: Number(row.row_version),
          actual: input.rowVersion
        }, 409);
      }
      const lateTitleRecovery = input.reason === 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200'
        && row.state === 'SUBMITTING';
      if (row.source !== 'AUTO' || (row.state !== 'NEEDS_ATTENTION' && !lateTitleRecovery)) {
        throw new AppError('CONFIG_INVALID', '该任务不是待恢复的自动上品代码故障', {
          id,
          source: row.source,
          state: row.state
        }, 409);
      }
      if (row.lease_owner || row.lease_token || row.lease_expires_at) {
        throw new AppError('TASK_LOCKED', '任务仍带有 OZON 运行租约字段，禁止按预平台故障恢复', { id }, 409);
      }
      const runtimeSlot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE job_id=$1
      ) AS exists`, [id]);
      if (runtimeSlot.rows[0]?.exists) {
        throw new AppError('TASK_LOCKED', '任务仍占用 OZON 平台单写槽，禁止按预平台故障恢复', { id }, 409);
      }
      await assertNoActivePlatformStatusRefreshLease(client, sku, id);

      const newerJob = await client.query<SqlRow>(`
        SELECT id,state FROM ozon_publish_jobs
        WHERE sku=$1 AND id<>$2 AND created_at>$3
        ORDER BY created_at DESC,id DESC
        LIMIT 1 FOR UPDATE`,
      [sku, id, row.created_at]);
      if (newerJob.rows[0]) {
        throw new AppError('TASK_LOCKED', '该 SKU 已有更新的 OZON 任务，不能恢复旧任务', {
          id,
          conflictingJobId: newerJob.rows[0].id,
          conflictingState: newerJob.rows[0].state
        }, 409);
      }
      const mapping = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_product_mappings WHERE sku=$1
      ) AS exists`, [sku]);
      const hasRemoteProgress = Boolean(
        row.import_task_id
        || row.ozon_product_id
        || normalizeProductLinks(row.product_links).length
        || Object.keys(jsonObject(payload.importIntent)).length
        || (lateTitleRecovery && hasOzonWriteCheckpoint(payload))
        || mapping.rows[0]?.exists
      );
      if (hasRemoteProgress) {
        throw new AppError('CONFIG_INVALID', '任务已有 OZON 远端状态或商品映射，禁止按预平台代码故障恢复', { id, sku }, 409);
      }

      const importFailureHistory = input.reason === 'IMPORT_INTENT_URL_MISSING'
        && isMaskedImportIntentUrlFailure(row)
        ? (await client.query<SqlRow>(`
            SELECT id,event_type,from_state,to_state,message,payload,created_at
            FROM ozon_publish_events
            WHERE job_id=$1 AND event_type = ANY($2::text[])
            ORDER BY created_at,id`,
          [id, ['OZON_STATE_MACHINE_FAILED', 'MEDIA_DELIVERED', 'AUTOMATION_STOPPED']])).rows
        : [];
      const validated = input.reason === 'IMPORT_INTENT_URL_MISSING'
        ? validateImportIntentUrlMissingRecovery(effectiveRow, listingRow, input, importFailureHistory)
        : input.reason === 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2'
          ? validateDescriptionKeywordStuffingFalsePositiveRecovery(effectiveRow, listingRow, input)
          : validateTitleTranslationLimitRecovery(effectiveRow, listingRow, input);
      const proposed = validated.proposed;
      if (input.dryRun) {
        return knownPrePlatformRecoveryResult({
          status: 'DRY_RUN',
          reason: input.reason,
          dryRun: true,
          job,
          listing,
          proposed
        });
      }
      if (!beforeCommit) {
        throw new AppError(
          'CONFIG_INVALID',
          '已知 OZON 预平台故障 apply 必须由服务层完成远端空状态与文件签名复核',
          { id, reason: input.reason },
          409
        );
      }

      const checks = await beforeCommit(job);
      const now = new Date().toISOString();
      const recovery = {
        schemaVersion: 1,
        reason: input.reason,
        recoveredAt: now,
        previousJobState: row.state,
        previousJobRowVersion: Number(row.row_version),
        ...(listingRow ? { previousListingRowVersion: Number(listingRow.row_version) } : {}),
        targetJobState: proposed.jobState,
        ...(proposed.listingState ? { targetListingState: proposed.listingState } : {}),
        ...(checks ? { checks } : {}),
        ...(input.reason === 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2'
          ? { previousRecovery: priorRecovery }
          : {}),
        ...(validated.identityEvidence || {})
      };
      const nextPayload = {
        ...payload,
        // These three allowlisted recoveries belong to the frozen pre-v3
        // contract. Persist the explicit version so every later hand-off keeps
        // executing v2 instead of following the current policy implicitly.
        contentPolicyVersion: OZON_CONTENT_POLICY_V2,
        ...(validated.nextPresetBinding ? { presetBinding: validated.nextPresetBinding } : {}),
        knownPrePlatformFailureRecovery: recovery
      };
      const persistedNextPayload = runtimePathProjection ? nextPayload : sanitizePersistentJobPayload(nextPayload);
      const nextStageStates = isKnownPreSubmitRecoveryReason(input.reason)
        ? {
            ...(row.stage_states || {}),
            images: 'LOCAL_READY',
            video: 'LOCAL_READY',
            import: 'PENDING',
            moderation: 'PENDING'
          }
        : row.stage_states || {};
      const isLateTitleMigration = validated.identityEvidence?.recoveryMode === 'LATE_SUBMITTING_PRE_PLATFORM';
      const updatedJob = isLateTitleMigration
        ? await client.query<SqlRow>(`
            UPDATE ozon_publish_jobs
            SET payload=$2::jsonb,retry_count=$3,
                directory_stage=COALESCE($4,directory_stage),work_rel_path=COALESCE($5,work_rel_path),
                row_version=row_version+1,updated_at=NOW()
            WHERE id=$1 AND row_version=$6 AND state='SUBMITTING'
            RETURNING *`,
          [
            id,
            JSON.stringify(persistedNextPayload),
            proposed.retryCount,
            runtimePathProjection?.directoryStage || null,
            runtimePathProjection?.workRelPath || null,
            input.rowVersion
          ])
        : await client.query<SqlRow>(`
            UPDATE ozon_publish_jobs
            SET state=$2,payload=$3::jsonb,stage_states=$4::jsonb,
                last_error_code=NULL,last_error_message=NULL,next_attempt_at=$5,
                retry_count=$6,finished_at=NULL,
                lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
                directory_stage=COALESCE($7,directory_stage),work_rel_path=COALESCE($8,work_rel_path),
                row_version=row_version+1,updated_at=NOW()
            WHERE id=$1 AND row_version=$9
            RETURNING *`,
          [
            id,
            proposed.jobState,
            JSON.stringify(persistedNextPayload),
            JSON.stringify(nextStageStates),
            proposed.jobState === 'SUBMITTING' ? now : null,
            proposed.retryCount,
            runtimePathProjection?.directoryStage || null,
            runtimePathProjection?.workRelPath || null,
            input.rowVersion
          ]);
      if (!updatedJob.rows[0]) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id }, 409);
      }

      let updatedListingRow: SqlRow | undefined;
      if (listingRow && proposed.listingState) {
        const updatedListing = await client.query<SqlRow>(`
          UPDATE ozon_listing_drafts
          SET status=$2,last_task_id=$3,last_error_code=NULL,last_error_message=NULL,
              row_version=row_version+1,updated_at=NOW()
          WHERE sku=$1 AND row_version=$4
          RETURNING *`,
        [sku, proposed.listingState, id, input.listingRowVersion]);
        if (!updatedListing.rows[0]) {
          throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', { sku }, 409);
        }
        updatedListingRow = updatedListing.rows[0];
      }
      if (!isLateTitleMigration) {
        await client.query('DELETE FROM ozon_publish_slots WHERE job_id=$1', [id]);
      }
      await addEvent(
        client,
        id,
        'KNOWN_PRE_PLATFORM_CODE_FAILURE_RECOVERED',
        row.state,
        proposed.jobState,
        input.reason === 'IMPORT_INTENT_URL_MISSING'
          ? '已修复导入意图 URL 合同，原任务按原 revision 与目录恢复到提交阶段'
          : input.reason === 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2'
            ? '已确认详情词频误报已由内容策略 v2 修复，原任务按原 revision 与目录恢复到提交阶段'
            : isLateTitleMigration
              ? '已迁移晚期预平台任务绑定的标题长度快照；原提交状态、草稿、Offer 与目录保持不变'
              : '已迁移任务绑定的标题长度快照，原任务恢复到自动准备阶段',
        recovery
      );
      return knownPrePlatformRecoveryResult({
        status: 'RECOVERED',
        reason: input.reason,
        dryRun: false,
        job: toJob(updatedJob.rows[0]),
        listing: updatedListingRow
          ? toListing(updatedListingRow)
          : listingRow
            ? toListing(listingRow)
            : undefined,
        proposed,
        checks
      });
    });
  }

  async recoverKnownPostPlatformMinPriceFailure(
    id: string,
    input: OzonKnownPostPlatformMinPriceRecoveryInput,
    beforeCommit?: (locked: {
      job: OzonPublishJob;
      listing: OzonListingDraft;
      mappings: OzonProductMapping[];
    }) => Promise<OzonKnownPostPlatformMinPriceRecoveryChecks>,
    runtimePathProjection?: OzonPublishJob
  ): Promise<OzonKnownPostPlatformMinPriceRecoveryResult> {
    assertLegacyAutomaticTaskReadOnly();
    return this.transaction(async (client) => {
      const identity = await client.query<SqlRow>('SELECT sku FROM ozon_publish_jobs WHERE id=$1', [id]);
      if (!identity.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      const sku = normalizeSku(identity.rows[0].sku);
      await lockSkuJob(client, sku);

      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [id]);
      const row = jobResult.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow) {
        throw new AppError('CONFIG_INVALID', '已知 OZON 最低价漏写恢复要求原草稿仍然存在', { id, sku }, 409);
      }
      const mappingResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_product_mappings
        WHERE store_alias=$1 AND sku=$2
        ORDER BY offer_id
        FOR UPDATE`, [requiredStoreAlias(row.store_alias), sku]);
      const effectiveRow = applyRuntimePathProjection(row, runtimePathProjection);
      const job = toJob(effectiveRow);
      const listing = toListing(listingRow);
      const mappings = mappingResult.rows.map(toProductMapping);
      const payload = jsonObject(row.payload);
      const priorRecovery = jsonObject(payload.knownPostPlatformMinPriceRecovery);
      if (priorRecovery.reason === input.reason && nonBlank(priorRecovery.recoveredAt)) {
        return knownPostPlatformMinPriceRecoveryResult({
          status: 'ALREADY_RECOVERED',
          dryRun: input.dryRun,
          job,
          listing,
          proposed: knownPostPlatformMinPriceProposal(row, priorRecovery)
        });
      }
      if (input.reason !== OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON) {
        throw new AppError('CONFIG_INVALID', '不支持的 OZON 已知平台后最低价故障恢复原因', {
          id,
          reason: input.reason
        }, 400);
      }
      if (Number(row.row_version) !== input.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', {
          id,
          expected: Number(row.row_version),
          actual: input.rowVersion
        }, 409);
      }
      if (Number(listingRow.row_version) !== input.listingRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', {
          sku,
          expected: Number(listingRow.row_version),
          actual: input.listingRowVersion
        }, 409);
      }
      if (row.lease_owner || row.lease_token || row.lease_expires_at) {
        throw new AppError('TASK_LOCKED', '任务仍带有 OZON 运行租约，禁止最低价故障恢复', { id }, 409);
      }
      const runtimeSlot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE job_id=$1
      ) AS exists`, [id]);
      if (runtimeSlot.rows[0]?.exists) {
        throw new AppError('TASK_LOCKED', '任务仍占用 OZON 平台单写槽，禁止最低价故障恢复', { id }, 409);
      }
      await assertNoActivePlatformStatusRefreshLease(client, sku, id);
      const newerJob = await client.query<SqlRow>(`
        SELECT id,state FROM ozon_publish_jobs
        WHERE sku=$1 AND id<>$2 AND created_at>$3
        ORDER BY created_at DESC,id DESC
        LIMIT 1 FOR UPDATE`, [sku, id, row.created_at]);
      if (newerJob.rows[0]) {
        throw new AppError('TASK_LOCKED', '该 SKU 已有更新的 OZON 任务，不能恢复旧任务', {
          id,
          conflictingJobId: newerJob.rows[0].id,
          conflictingState: newerJob.rows[0].state
        }, 409);
      }

      const validated = validateKnownPostPlatformMinPriceFailureShape(effectiveRow, listingRow, mappingResult.rows, input);
      if (input.dryRun) {
        return knownPostPlatformMinPriceRecoveryResult({
          status: 'DRY_RUN',
          dryRun: true,
          job,
          listing,
          proposed: validated.proposed
        });
      }
      if (!beforeCommit) {
        throw new AppError(
          'CONFIG_INVALID',
          '已知 OZON 平台后最低价故障 apply 必须由服务层完成远端商品、权威价格与文件签名复核',
          { id },
          409
        );
      }
      const checks = await beforeCommit({ job, listing, mappings });
      assertKnownPostPlatformMinPriceCommitChecks(effectiveRow, checks);
      const now = new Date().toISOString();
      const resolvedStage = checks.productJson.resolvedDirectoryStage;
      const resolvedWorkRelPath = checks.productJson.resolvedWorkRelPath;
      const pathChanged = resolvedStage !== effectiveRow.directory_stage || resolvedWorkRelPath !== effectiveRow.work_rel_path;
      if (pathChanged && (id !== '50bff6f2-9801-4080-8183-2b37b4953d13'
        || effectiveRow.directory_stage !== 'PROCESSING'
        || effectiveRow.work_rel_path !== 'processing/0000105__r2'
        || resolvedStage !== 'SUCCESS'
        || !/^success\/\d{4}-\d{2}-\d{2}\/0000105__r2$/.test(resolvedWorkRelPath)
        || checks.productJson.location !== 'UNIQUE_ORPHAN_SUCCESS')) {
        throw new AppError('VERSION_CONFLICT', 'OZON 最低价恢复返回了不允许的任务目录变化', {
          id,
            previous: { directoryStage: effectiveRow.directory_stage, workRelPath: effectiveRow.work_rel_path },
          resolved: { directoryStage: resolvedStage, workRelPath: resolvedWorkRelPath }
        }, 409);
      }
      const priorPriceProgress = jsonObject(jsonObject(payload.priceStockWriteProgress).pricesWrite);
      const priorStockProgress = jsonObject(jsonObject(payload.priceStockWriteProgress).stocksWrite);
      const nextPriceStockWriteProgress = {
        pricesWrite: {
          ...priorPriceProgress,
          succeededOfferIds: [],
          pendingOfferIds: [...validated.target.offerIds],
          failedOfferIds: [],
          errorsByOffer: {}
        },
        stocksWrite: priorStockProgress
      };
      const recovery = {
        schemaVersion: 1,
        reason: input.reason,
        recoveredAt: now,
        previousJobState: row.state,
        previousJobRowVersion: Number(row.row_version),
        previousListingState: listingRow.status,
        previousListingRowVersion: Number(listingRow.row_version),
        targetJobState: 'IMPORTING',
        targetListingState: 'SUBMITTING',
        schedulerMode: 'RECONCILE_IMPORT',
        importProductReachable: false,
        importTaskId: String(row.import_task_id),
        offerIds: [...validated.target.offerIds],
        directoryBefore: {
          directoryStage: String(row.directory_stage),
          workRelPath: String(row.work_rel_path),
          productJsonPath: String(payload.productJsonPath || '')
        },
        directoryAfter: {
          directoryStage: resolvedStage,
          workRelPath: resolvedWorkRelPath,
          productJsonPath: checks.productJson.resolvedProductJsonPath
        },
        checks
      };
      const nextPayloadInput = {
        ...payload,
        ...(runtimePathProjection ? {} : {
          workRelPath: resolvedWorkRelPath,
          directoryStage: resolvedStage,
          workDirectory: checks.productJson.resolvedWorkDirectory,
          productJsonPath: checks.productJson.resolvedProductJsonPath
        }),
        priceStockWriteProgress: nextPriceStockWriteProgress,
        priceStockWriteFailures: [],
        priceStockConsistencyRetry: 0,
        priceStockRetryStartedAt: now,
        priceStockRetryDeadlineAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        priceStockLastFailureAt: null,
        networkRecovery: null,
        finalVerificationLeaseUntil: null,
        finalConsistencyRecovery: null,
        knownPostPlatformMinPriceRecovery: recovery
      };
      const nextPayload = runtimePathProjection ? nextPayloadInput : sanitizePersistentJobPayload(nextPayloadInput);
      const nextStageStates = {
        ...jsonObject(row.stage_states),
        price: 'PENDING'
      };
      const updatedJob = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET state='IMPORTING',payload=$2::jsonb,stage_states=$3::jsonb,
            directory_stage=$4,work_rel_path=$5,
            last_error_code=NULL,last_error_message=NULL,next_attempt_at=$6,
            finished_at=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$7
        RETURNING *`, [
        id,
        JSON.stringify(nextPayload),
        JSON.stringify(nextStageStates),
        resolvedStage,
        resolvedWorkRelPath,
        now,
        input.rowVersion
      ]);
      if (!updatedJob.rows[0]) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id }, 409);
      }
      const updatedListing = await client.query<SqlRow>(`
        UPDATE ozon_listing_drafts
        SET status='SUBMITTING',last_task_id=$2,last_error_code=NULL,last_error_message=NULL,
            row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 AND row_version=$3
        RETURNING *`, [sku, id, input.listingRowVersion]);
      if (!updatedListing.rows[0]) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', { sku }, 409);
      }
      await client.query('DELETE FROM ozon_publish_slots WHERE job_id=$1', [id]);
      await addEvent(
        client,
        id,
        'KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_RECOVERED',
        row.state,
        'IMPORTING',
        '已确认 OZON 仅漏写最低价；原任务保留 importTaskId 与商品映射并进入 RECONCILE_IMPORT',
        recovery
      );
      return knownPostPlatformMinPriceRecoveryResult({
        status: 'RECOVERED',
        dryRun: false,
        job: toJob(updatedJob.rows[0]),
        listing: toListing(updatedListing.rows[0]),
        proposed: {
          ...validated.proposed,
          workRelPath: resolvedWorkRelPath,
          directoryStage: resolvedStage
        },
        checks
      });
    });
  }

  async getJob(id: string, source?: 'MANUAL' | 'AUTO'): Promise<OzonPublishJob> {
    const result = await this.query<SqlRow>(
      `SELECT * FROM ozon_publish_jobs WHERE id=$1${source ? ' AND source=$2' : ''}`,
      source ? [id, source] : [id]
    );
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
    const events = await this.query<SqlRow>('SELECT * FROM ozon_publish_events WHERE job_id=$1 ORDER BY created_at,id', [id]);
    const [job] = await this.withCurrentPlatformLinks([result.rows[0]]);
    return { ...job!, events: events.rows.map(toEvent) };
  }

  private async withCurrentPlatformLinks(rows: SqlRow[]): Promise<OzonPublishJob[]> {
    const jobs = rows.map(toJob);
    const storeIds = [...new Set(jobs.map((job) => String(job.storeId || '').trim()).filter(Boolean))];
    const skus = [...new Set(jobs.map((job) => String(job.sku || '').trim()).filter(Boolean))];
    if (!skus.length) return jobs;
    const storeAliases = [...new Set(jobs.map((job) => String(job.storeAlias || '').trim()).filter(Boolean))];
    const mappings = storeIds.length
      ? await this.query<SqlRow>(`
          SELECT * FROM ozon_product_mappings
          WHERE store_id=ANY($1::uuid[]) AND sku=ANY($2::text[])
          ORDER BY store_id,sku,offer_id`, [storeIds, skus])
      : storeAliases.length
        ? await this.query<SqlRow>(`
            SELECT * FROM ozon_product_mappings
            WHERE store_alias=ANY($1::text[]) AND sku=ANY($2::text[])
            ORDER BY store_alias,sku,offer_id`, [storeAliases, skus])
        : { rows: [] as SqlRow[] };
    const byStoreSku = new Map<string, OzonProductLink[]>();
    for (const row of mappings.rows) {
      const key = `${String(storeIds.length ? row.store_id : row.store_alias)}\u0000${String(row.sku)}`;
      const current = byStoreSku.get(key) || [];
      current.push(...productLinkFromMapping(toProductMapping(row)));
      byStoreSku.set(key, current);
    }
    return jobs.map((job) => {
      const offerIds = new Set(job.offerIds);
      const storeKey = storeIds.length ? String(job.storeId || '') : String(job.storeAlias || '');
      const current = (byStoreSku.get(`${storeKey}\u0000${job.sku}`) || [])
        .filter((link) => !offerIds.size || offerIds.has(link.offerId));
      if (!current.length) return job;
      const merged = new Map(job.ozonProductLinks.map((link) => [link.offerId, link]));
      for (const link of current) merged.set(link.offerId, { ...merged.get(link.offerId), ...link });
      return { ...job, ozonProductLinks: orderProductLinks([...merged.values()], job.offerIds) };
    });
  }

  async getRfbsStockNormalizationAuthority(id: string): Promise<OzonRfbsNormalizationAuthority> {
    return this.transaction(async (client) => {
      const jobResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR SHARE',
        [id]
      );
      const jobRow = jobResult.rows[0];
      if (!jobRow) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      const listingResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR SHARE',
        [jobRow.sku]
      );
      const listingRow = listingResult.rows[0];
      if (!listingRow) throw new AppError('NOT_FOUND', 'OZON 上品资料不存在', { sku: jobRow.sku }, 404);
      const offerIds = normalizeOfferIds(jobRow.offer_ids || jobRow.payload?.expectedOfferIds);
      const mappingResult = offerIds.length
        ? await client.query<SqlRow>(`
            SELECT * FROM ozon_product_mappings
            WHERE store_alias=$1 AND offer_id=ANY($2::text[])
            ORDER BY array_position($2::text[],offer_id)
            FOR SHARE`,
          [jobRow.store_alias, offerIds])
        : { rows: [] as SqlRow[] };
      return {
        job: toJob(jobRow),
        listing: toListing(listingRow),
        mappings: mappingResult.rows.map(toProductMapping)
      };
    });
  }

  listManualJobsForSku(
    sku: string,
    input: Omit<OzonJobListInput, 'source' | 'sku'> = {}
  ): Promise<{ items: OzonPublishJob[]; total: number; page: number; pageSize: number }> {
    return this.listJobs({ ...input, sku, source: 'MANUAL', businessOnly: true });
  }

  async findActiveJobBySku(skuInput: string): Promise<OzonPublishJob | undefined> {
    const result = await this.query<SqlRow>(`
      SELECT * FROM ozon_publish_jobs
      WHERE sku=$1 AND state = ANY($2::text[])
      ORDER BY created_at DESC LIMIT 1`,
    [normalizeSku(skuInput), ACTIVE_JOB_STATES]);
    return result.rows[0] ? toJob(result.rows[0]) : undefined;
  }

  async compatibleAppendReadiness(skuInput: string): Promise<OzonCompatibleAppendReadiness> {
    const sku = normalizeSku(skuInput);
    const [refresh, runtime, slot] = await Promise.all([
      this.query<SqlRow>(`
        SELECT lease_expires_at FROM ozon_platform_status_refresh_leases
        WHERE sku=$1 AND lease_expires_at>NOW() LIMIT 1`, [sku]),
      this.query<SqlRow>(`
        SELECT id,lease_owner,lease_expires_at FROM ozon_publish_jobs
        WHERE sku=$1 AND lease_expires_at>NOW()
        ORDER BY lease_expires_at DESC LIMIT 1`, [sku]),
      this.query<SqlRow>(`
        SELECT job_id,lease_owner,lease_expires_at FROM ozon_publish_slots
        WHERE slot_key=$1 AND lease_expires_at>NOW() LIMIT 1`, [OZON_RUNTIME_SLOT_KEY])
    ]);
    return {
      ...(refresh.rows[0] ? {
        activePlatformStatusRefreshLease: {
          leaseOwner: 'PLATFORM_STATUS_REFRESH',
          leaseExpiresAt: iso(refresh.rows[0].lease_expires_at)
        }
      } : {}),
      ...(runtime.rows[0] ? {
        activeRuntimeJobLease: {
          jobId: String(runtime.rows[0].id),
          leaseOwner: String(runtime.rows[0].lease_owner || 'UNKNOWN'),
          leaseExpiresAt: iso(runtime.rows[0].lease_expires_at)
        }
      } : {}),
      ...(slot.rows[0] ? {
        occupiedPublishSlot: {
          jobId: String(slot.rows[0].job_id),
          leaseOwner: String(slot.rows[0].lease_owner || 'UNKNOWN'),
          leaseExpiresAt: iso(slot.rows[0].lease_expires_at)
        }
      } : {})
    };
  }

  async findInboxRoundJob(
    skuInput: string,
    revisionInput?: number,
    signatureInput?: string
  ): Promise<OzonPublishJob | undefined> {
    const sku = normalizeSku(skuInput);
    const revision = Math.max(0, Math.floor(Number(revisionInput) || 0));
    const signature = String(signatureInput || '').trim();
    const workRelPath = portableRelPath('inbox', sku);
    const result = await this.query<SqlRow>(`
      SELECT * FROM ozon_publish_jobs
      WHERE sku=$1
        AND (
          state = ANY($5::text[])
          OR NULLIF(task_id, '') IS NOT NULL
          OR NULLIF(import_task_id, '') IS NOT NULL
          OR NULLIF(ozon_product_id, '') IS NOT NULL
          OR directory_stage IN ('PROCESSING','SUCCESS')
        )
        AND (
          ($2 > 0 AND listing_revision=$2)
          OR (NULLIF($3, '') IS NOT NULL AND directory_signature=$3)
          OR directory_stage='INBOX'
          OR COALESCE(work_rel_path, '')=$4
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [sku, revision, signature, workRelPath, ACTIVE_JOB_STATES]);
    return result.rows[0] ? toJob(result.rows[0]) : undefined;
  }

  async recordInboxRoundReleased(
    skuInput: string,
    input: {
      existingRevision: number;
      existingSignature: string;
      replacedByRevision: number;
      replacedBySignature: string;
      archivedPath: string;
      reason: string;
    }
  ): Promise<string | undefined> {
    const sku = normalizeSku(skuInput);
    const workRelPath = portableRelPath('inbox', sku);
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs j
        WHERE j.sku=$1
          AND j.state IN ('FAILED','CANCELLED')
          AND NULLIF(j.task_id, '') IS NULL
          AND NULLIF(j.import_task_id, '') IS NULL
          AND NULLIF(j.ozon_product_id, '') IS NULL
          AND j.directory_stage='INBOX'
          AND (
            COALESCE(j.work_rel_path, '')=$2
            OR ($3 > 0 AND j.listing_revision=$3)
            OR (NULLIF($4, '') IS NOT NULL AND j.directory_signature=$4)
          )
          AND NOT EXISTS (
            SELECT 1 FROM ozon_publish_events e
            WHERE e.job_id=j.id
              AND e.event_type='INBOX_ROUND_RELEASED'
              AND e.payload->>'archivedPath'=$5
          )
        ORDER BY j.updated_at DESC,j.id DESC
        LIMIT 1
        FOR UPDATE`,
      [sku, workRelPath, input.existingRevision, input.existingSignature, input.archivedPath]);
      const job = result.rows[0];
      if (!job) return undefined;
      await addEvent(
        client,
        String(job.id),
        'INBOX_ROUND_RELEASED',
        job.state,
        job.state,
        '已释放未进入 n8n/OZON 的终态任务残留轮次，允许重新生成 product.json',
        input
      );
      return String(job.id);
    });
  }

  canManualTakeover(job: OzonPublishJob): boolean {
    return isSafeManualTakeoverJob(job);
  }

  async takeOverAutomaticPreparationForManual(input: {
    jobId: string;
    sku: string;
    expectedJobRowVersion: number;
    expectedListingRowVersion: number;
  }): Promise<{ job: OzonPublishJob; listing: OzonListingDraft }> {
    const sku = normalizeSku(input.sku);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const row = jobResult.rows[0];
      if (!row || String(row.sku) !== sku) {
        throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId: input.jobId, sku }, 404);
      }
      const payload = jsonObject(row.payload);
      const stageStates = jsonObject(row.stage_states);
      if (Number(row.row_version) !== input.expectedJobRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务已变化，请刷新后重试', {
          jobId: input.jobId,
          expected: Number(row.row_version),
          actual: input.expectedJobRowVersion
        }, 409);
      }
      const localOnly = row.source === 'AUTO'
        && payload.multistorePreparation === true
        && ['NEEDS_ATTENTION', 'FAILED'].includes(String(row.state))
        && !row.publication_id
        && !row.task_id
        && !row.import_task_id
        && !row.ozon_product_id
        && !row.task_folder
        && !row.directory_signature
        && (!row.directory_stage || row.directory_stage === 'INBOX')
        && normalizeProductLinks(row.product_links).length === 0
        && !row.lease_owner
        && !row.lease_token
        && !row.lease_expires_at
        && Object.keys(jsonObject(payload.importIntent)).length === 0
        && payload.platformWriteAttempted !== true
        && ['PENDING', 'WAITING_LOCAL', 'LOCAL_READY', 'PARTIAL'].includes(String(stageStates.images || 'PENDING'))
        && ['PENDING', 'WAITING_LOCAL', 'LOCAL_READY', 'PARTIAL'].includes(String(stageStates.video || 'PENDING'))
        && ['PENDING', ''].includes(String(stageStates.import || 'PENDING'))
        && ['PENDING', ''].includes(String(stageStates.moderation || 'PENDING'));
      if (!localOnly) {
        throw new AppError('OZON_PUBLICATION_REQUIRED', '该任务已有店铺 publication、运行租约或平台写入证据，不能转为手动资料', {
          jobId: input.jobId,
          sku,
          state: row.state
        }, 409);
      }
      const slot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE job_id=$1
      ) AS exists`, [input.jobId]);
      if (slot.rows[0]?.exists) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务仍占用运行槽，不能转为手动资料', { jobId: input.jobId }, 409);
      }
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow) throw new AppError('NOT_FOUND', 'OZON 上品资料不存在', { sku }, 404);
      if (Number(listingRow.row_version) !== input.expectedListingRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 上品资料已变化，请刷新后重试', {
          sku,
          expected: Number(listingRow.row_version),
          actual: input.expectedListingRowVersion
        }, 409);
      }
      if (String(listingRow.management_source || 'MANUAL') !== 'AUTO') {
        throw new AppError('VERSION_CONFLICT', '该上品资料已经由人工管理，无需重复接管', { sku }, 409);
      }
      if (!automaticPreparationOfferScopeMatches(row, listingRow.data)) {
        throw new AppError('VERSION_CONFLICT', '自动准备任务的 Offer 范围与当前资料不一致，不能转为手动资料', {
          jobId: input.jobId,
          sku
        }, 409);
      }
      const remoteEvidence = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_product_mappings WHERE sku=$1
      ) OR EXISTS(
        SELECT 1 FROM ozon_store_publications WHERE sku=$1
      ) OR EXISTS(
        SELECT 1 FROM ozon_gateway_requests WHERE task_id=COALESCE($2,'')
      ) AS exists`, [sku, row.task_id || null]);
      if (remoteEvidence.rows[0]?.exists) {
        throw new AppError('OZON_PUBLICATION_REQUIRED', '该 SKU 已有 publication、商品映射或网关账本，不能把自动准备任务改为手动资料', {
          jobId: input.jobId,
          sku
        }, 409);
      }
      const identities = referencedListingMediaDeliveryIdentities(listingRow.data);
      if (!identities.length) {
        throw new AppError('CONFIG_INVALID', '自动生成资料没有可核验的冻结媒体投递身份', { jobId: input.jobId, sku }, 409);
      }
      for (const identity of identities) {
        const deliveryResult = await client.query<SqlRow>(`
          SELECT * FROM ozon_media_deliveries
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
          FOR UPDATE`, [sku, identity.sourceStageId, identity.submissionId, identity.variantId]);
        const delivery = deliveryResult.rows[0];
        const deliveryPayload = jsonObject(delivery?.payload);
        const decision = String(deliveryPayload.autoPublishDecision || '').trim().toUpperCase();
        if (deliveryResult.rows.length !== 1
          || !sameMediaDeliveryIdentity(deliveryPayload, identity)
          || !['ACCEPTED', 'DEFERRED'].includes(decision)
          || (delivery?.job_id && String(delivery.job_id) !== input.jobId)) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '自动生成资料引用的媒体投递账本已变化，不能转为手动资料', {
            jobId: input.jobId,
            sku,
            identity,
            decision: decision || undefined
          }, 409);
        }
      }
      for (const identity of identities) {
        await client.query(`UPDATE ozon_media_deliveries
          SET job_id=NULL,payload=payload || $5::jsonb,updated_at=NOW()
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`, [
          sku,
          identity.sourceStageId,
          identity.submissionId,
          identity.variantId,
          JSON.stringify({
            autoPublishDecision: 'IGNORED',
            autoPublishIgnoredReason: 'MANUAL_TAKEOVER',
            autoPublishIgnoredAt: new Date().toISOString(),
            manualTakeoverJobId: input.jobId
          })
        ]);
      }
      const listingUpdated = await client.query<SqlRow>(`UPDATE ozon_listing_drafts
        SET management_source='MANUAL',row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 AND row_version=$2 RETURNING *`, [sku, input.expectedListingRowVersion]);
      const jobUpdated = await client.query<SqlRow>(`UPDATE ozon_publish_jobs
        SET state='CANCELLED',row_version=row_version+1,finished_at=NOW(),next_attempt_at=NULL,updated_at=NOW()
        WHERE id=$1 AND row_version=$2 RETURNING *`, [input.jobId, input.expectedJobRowVersion]);
      if (listingUpdated.rowCount !== 1 || jobUpdated.rowCount !== 1) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务或上品资料在接管时发生变化', { jobId: input.jobId, sku }, 409);
      }
      await addEvent(
        client,
        input.jobId,
        'AUTOMATIC_PREPARATION_TAKEN_OVER_MANUALLY',
        String(row.state),
        'CANCELLED',
        '用户已明确将自动生成资料转为手动管理',
        { sku, listingRowVersion: Number(listingUpdated.rows[0]!.row_version), deliveryCount: identities.length }
      );
      return { job: toJob(jobUpdated.rows[0]!), listing: toListing(listingUpdated.rows[0]!) };
    });
  }

  async rebindAutomaticPreparationAfterMediaRescan(input: {
    jobId: string;
    expectedJobRowVersion: number;
  }): Promise<OzonPublishJob | undefined> {
    return this.transaction(async (client) => {
      const identity = await client.query<{ sku: string }>('SELECT sku FROM ozon_publish_jobs WHERE id=$1', [input.jobId]);
      if (!identity.rows[0]) throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId: input.jobId }, 404);
      const sku = normalizeSku(identity.rows[0].sku);
      await lockSkuJob(client, sku);

      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]);
      const row = jobResult.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId: input.jobId }, 404);
      if (Number(row.row_version) !== input.expectedJobRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务已变化，请刷新后重试', {
          jobId: input.jobId,
          expected: Number(row.row_version),
          actual: input.expectedJobRowVersion
        }, 409);
      }
      if (String(row.last_error_code || '') !== 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT') return undefined;

      const payload = jsonObject(row.payload);
      const stageStates = jsonObject(row.stage_states);
      const localOnly = row.source === 'AUTO'
        && payload.multistorePreparation === true
        && row.state === 'NEEDS_ATTENTION'
        && !row.publication_id
        && !row.task_id
        && !row.import_task_id
        && !row.ozon_product_id
        && !row.task_folder
        && !row.directory_signature
        && (!row.directory_stage || row.directory_stage === 'INBOX')
        && normalizeProductLinks(row.product_links).length === 0
        && !row.lease_owner
        && !row.lease_token
        && !row.lease_expires_at
        && Object.keys(jsonObject(payload.importIntent)).length === 0
        && payload.platformWriteAttempted !== true
        && ['PENDING', 'WAITING_LOCAL', 'LOCAL_READY', 'PARTIAL'].includes(String(stageStates.images || 'PENDING'))
        && ['PENDING', 'WAITING_LOCAL', 'LOCAL_READY', 'PARTIAL'].includes(String(stageStates.video || 'PENDING'))
        && ['PENDING', ''].includes(String(stageStates.import || 'PENDING'))
        && ['PENDING', ''].includes(String(stageStates.moderation || 'PENDING'));
      if (!localOnly) {
        throw new AppError('OZON_PUBLICATION_REQUIRED', '该任务已有店铺 publication、运行租约或平台写入证据，不能按自动媒体重扫恢复', {
          jobId: input.jobId,
          sku,
          state: row.state
        }, 409);
      }
      const slot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE job_id=$1
      ) AS exists`, [input.jobId]);
      if (slot.rows[0]?.exists) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务仍占用运行槽，不能重新绑定资料', { jobId: input.jobId }, 409);
      }
      const remoteEvidence = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_product_mappings WHERE sku=$1
      ) OR EXISTS(
        SELECT 1 FROM ozon_store_publications WHERE sku=$1
      ) OR EXISTS(
        SELECT 1 FROM ozon_gateway_requests WHERE task_id=COALESCE($2,'')
      ) AS exists`, [sku, row.task_id || null]);
      if (remoteEvidence.rows[0]?.exists) {
        throw new AppError('OZON_PUBLICATION_REQUIRED', '该 SKU 已有 publication、商品映射或网关账本，不能重新绑定自动准备资料', {
          jobId: input.jobId,
          sku
        }, 409);
      }

      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow || String(listingRow.management_source || 'MANUAL') !== 'AUTO' || listingRow.status !== 'READY') {
        throw new AppError('VERSION_CONFLICT', '当前 OZON 资料不是可恢复的自动待上品资料', { jobId: input.jobId, sku }, 409);
      }
      if (!automaticPreparationOfferScopeMatches(row, listingRow.data)) {
        throw new AppError('VERSION_CONFLICT', '自动准备任务的 Offer 范围与当前资料不一致，不能重新绑定', {
          jobId: input.jobId,
          sku
        }, 409);
      }
      const expectedRevision = Number(payload.autoPreparedListingRevision);
      const expectedListingRowVersion = Number(payload.autoPreparedListingRowVersion);
      if (payload.autoPreparedByJobId !== input.jobId
        || payload.autoPreparedStartedWithoutListing !== true
        || !Number.isSafeInteger(expectedRevision)
        || !Number.isSafeInteger(expectedListingRowVersion)
        || Number(listingRow.revision) !== expectedRevision + 1
        || Number(listingRow.row_version) !== expectedListingRowVersion + 1) {
        throw new AppError('VERSION_CONFLICT', '自动资料版本不是一次可证明的媒体重扫，不能重新绑定', {
          jobId: input.jobId,
          sku,
          expectedRevision,
          actualRevision: Number(listingRow.revision),
          expectedListingRowVersion,
          actualListingRowVersion: Number(listingRow.row_version)
        }, 409);
      }
      const priorVersionResult = await client.query<SqlRow>(`
        SELECT snapshot FROM ozon_listing_versions
        WHERE sku=$1 AND revision=$2
        ORDER BY created_at DESC
        LIMIT 2
        FOR UPDATE`, [sku, expectedRevision]);
      if (priorVersionResult.rows.length !== 1) {
        throw new AppError('VERSION_CONFLICT', '自动资料缺少唯一的上一版冻结快照，不能重新绑定', {
          jobId: input.jobId,
          sku,
          expectedRevision,
          snapshotCount: priorVersionResult.rows.length
        }, 409);
      }
      const priorData = jsonObject(jsonObject(priorVersionResult.rows[0]!.snapshot).data);
      const currentData = jsonObject(listingRow.data);
      const expectedSignature = String(payload.autoPreparedListingDataSignature || '');
      const priorSignature = `sha256:${createHash('sha256').update(stableJson(priorData)).digest('hex')}`;
      if (expectedSignature !== priorSignature
        || stableJson(automaticMediaRescanComparableListingData(priorData))
          !== stableJson(automaticMediaRescanComparableListingData(currentData))) {
        throw new AppError('VERSION_CONFLICT', '自动资料除媒体重扫元数据外已经变化，不能重新绑定', {
          jobId: input.jobId,
          sku,
          expectedSignature,
          priorSignature
        }, 409);
      }

      const identities = referencedListingMediaDeliveryIdentities(currentData);
      const triggeringIdentities = (Array.isArray(payload.mediaDeliveries) ? payload.mediaDeliveries : [])
        .map((delivery) => mediaDeliveryIdentity(jsonObject(delivery)));
      const materialIdentityKeys = new Set(identities.map(mediaDeliveryIdentityKey));
      if (!identities.length || !triggeringIdentities.length
        || triggeringIdentities.some((delivery) => !materialIdentityKeys.has(mediaDeliveryIdentityKey(delivery)))) {
        throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '自动准备任务的触发媒体不属于当前冻结资料', {
          jobId: input.jobId,
          sku
        }, 409);
      }
      for (const deliveryIdentity of identities) {
        const deliveryResult = await client.query<SqlRow>(`
          SELECT * FROM ozon_media_deliveries
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
          FOR UPDATE`, [sku, deliveryIdentity.sourceStageId, deliveryIdentity.submissionId, deliveryIdentity.variantId]);
        const delivery = deliveryResult.rows[0];
        const deliveryPayload = jsonObject(delivery?.payload);
        const decision = String(deliveryPayload.autoPublishDecision || '').trim().toUpperCase();
        const triggering = triggeringIdentities.some((candidate) => (
          mediaDeliveryIdentityKey(candidate) === mediaDeliveryIdentityKey(deliveryIdentity)
        ));
        if (deliveryResult.rows.length !== 1
          || !sameMediaDeliveryIdentity(deliveryPayload, deliveryIdentity)
          || !['ACCEPTED', 'DEFERRED'].includes(decision)
          || (triggering && String(delivery?.job_id || '') !== input.jobId)
          || (!triggering && delivery?.job_id && String(delivery.job_id) !== input.jobId)) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '自动生成资料引用的媒体投递账本已变化，不能重新绑定', {
            jobId: input.jobId,
            sku,
            identity: deliveryIdentity,
            decision: decision || undefined
          }, 409);
        }
      }

      const currentSignature = `sha256:${createHash('sha256').update(stableJson(currentData)).digest('hex')}`;
      const reboundAt = new Date().toISOString();
      const updated = await client.query<SqlRow>(`UPDATE ozon_publish_jobs
        SET state='READY',payload=payload || $3::jsonb,last_error_code=NULL,last_error_message=NULL,
            next_attempt_at=NULL,finished_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$2 RETURNING *`, [
        input.jobId,
        input.expectedJobRowVersion,
        JSON.stringify({
          autoPreparedListingRevision: Number(listingRow.revision),
          autoPreparedListingRowVersion: Number(listingRow.row_version),
          autoPreparedListingDataSignature: currentSignature,
          autoPreparedMediaRescanRecovery: {
            recoveredAt: reboundAt,
            previousRevision: expectedRevision,
            previousRowVersion: expectedListingRowVersion,
            previousDataSignature: priorSignature,
            listingRevision: Number(listingRow.revision),
            listingRowVersion: Number(listingRow.row_version),
            listingDataSignature: currentSignature,
            deliveryCount: identities.length
          }
        })
      ]);
      if (updated.rowCount !== 1) {
        throw new AppError('TASK_LOCKED', 'OZON 自动准备任务在重新绑定时发生变化', { jobId: input.jobId, sku }, 409);
      }
      await addEvent(
        client,
        input.jobId,
        'AUTOMATIC_PREPARATION_REBOUND_AFTER_MEDIA_RESCAN',
        'NEEDS_ATTENTION',
        'READY',
        '已核验自动资料仅发生媒体重扫元数据变化，原准备任务重新进入自动队列',
        { sku, previousRevision: expectedRevision, listingRevision: Number(listingRow.revision), deliveryCount: identities.length }
      );
      return toJob(updated.rows[0]!);
    });
  }

  async listRunnableAutomaticJobs(limitInput = 4): Promise<OzonPublishJob[]> {
    const limit = Math.min(20, Math.max(1, Math.floor(Number(limitInput) || 4)));
    const result = await this.query<SqlRow>(`
      SELECT * FROM ozon_publish_jobs
      WHERE source='AUTO'
        AND state = ANY($1::text[])
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
        AND NOT (payload @> '{"recoveryHold":{"active":true}}'::jsonb)
      ORDER BY updated_at ASC
      LIMIT $2`,
    [['WAITING_MEDIA', 'READY'], limit]);
    return result.rows.map(toJob);
  }

  async getProductMapping(storeAliasInput: string, offerIdInput: string): Promise<OzonProductMapping> {
    const storeAlias = String(storeAliasInput || '').trim();
    const offerId = String(offerIdInput || '').trim();
    if (!storeAlias || !offerId) throw new AppError('CONFIG_INVALID', '默认店铺标识和 offerId 不能为空');
    const result = await this.query<SqlRow>('SELECT * FROM ozon_product_mappings WHERE store_alias=$1 AND offer_id=$2', [storeAlias, offerId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 平台商品映射不存在', { storeAlias, offerId }, 404);
    return toProductMapping(result.rows[0]);
  }

  async listProductMappingsForSku(storeAliasInput: string, skuInput: string): Promise<OzonProductMapping[]> {
    const storeAlias = requiredStoreAlias(storeAliasInput);
    const sku = normalizeSku(skuInput);
    const result = await this.query<SqlRow>(`
      SELECT * FROM ozon_product_mappings
      WHERE store_alias=$1 AND sku=$2
      ORDER BY offer_id`, [storeAlias, sku]);
    return result.rows.map(toProductMapping);
  }

  async hasProductMappingForSku(storeAliasInput: string, skuInput: string): Promise<boolean> {
    const storeAlias = String(storeAliasInput || '').trim();
    const sku = normalizeSku(skuInput);
    const result = await this.query<{ exists: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM ozon_product_mappings WHERE store_alias=$1 AND sku=$2
    ) AS exists`, [storeAlias, sku]);
    return Boolean(result.rows[0]?.exists);
  }

  private async productLinksBySku(skus: string[]): Promise<Map<string, OzonProductLink[]>> {
    const uniqueSkus = [...new Set(skus.map((sku) => String(sku || '').trim()).filter(Boolean))];
    const linksBySku = new Map<string, OzonProductLink[]>();
    if (!uniqueSkus.length) return linksBySku;
    const rows = await this.query<SqlRow>(`
      WITH bound_store AS (
        SELECT DISTINCT ON (sku) sku,store_alias
        FROM ozon_publish_jobs
        WHERE sku::text=ANY($1::text[])
        ORDER BY sku,updated_at DESC,id DESC
      ),
      stored_links AS (
        SELECT DISTINCT ON (sku,store_alias) sku,store_alias,product_links
        FROM ozon_publish_jobs
        WHERE sku::text=ANY($1::text[])
          AND state='SUCCEEDED'
          AND jsonb_typeof(product_links)='array'
          AND jsonb_array_length(product_links)>0
        ORDER BY sku,store_alias,updated_at DESC,id DESC
      )
      SELECT mapping.sku,mapping.offer_id,mapping.ozon_product_id,mapping.ozon_sku,
             mapping.status,mapping.status_snapshot,mapping.last_verified_at,stored_links.product_links
      FROM ozon_product_mappings mapping
      JOIN bound_store ON bound_store.sku=mapping.sku AND bound_store.store_alias=mapping.store_alias
      LEFT JOIN stored_links ON stored_links.sku=mapping.sku AND stored_links.store_alias=mapping.store_alias
      WHERE mapping.sku::text=ANY($1::text[])
        AND mapping.ozon_product_id IS NOT NULL
        AND mapping.ozon_sku IS NOT NULL
      ORDER BY mapping.sku,mapping.offer_id`,
    [uniqueSkus]);
    for (const row of rows.rows) {
      const sku = String(row.sku || '').trim();
      const offerId = String(row.offer_id || '').trim();
      const ozonProductId = String(row.ozon_product_id || '').trim();
      const ozonSku = String(row.ozon_sku || '').trim();
      const stored = normalizeProductLinks(row.product_links)
        .find((link) => link.offerId === offerId && link.ozonSku === ozonSku);
      const url = ozonProductUrl(ozonSku, stored?.url);
      if (!url) continue;
      const links = linksBySku.get(sku) || [];
      const snapshot = jsonObject(row.status_snapshot);
      const warnings = stringArray(snapshot.warnings);
      links.push({
        offerId,
        ozonProductId,
        ozonSku,
        url,
        ...(isPlatformOfferDisplayState(snapshot.displayState || row.status)
          ? { displayState: String(snapshot.displayState || row.status) as OzonProductLink['displayState'] }
          : {}),
        ...(nonBlank(snapshot.statusDescription || snapshot.platformMessage)
          ? { platformMessage: String(snapshot.statusDescription || snapshot.platformMessage).trim() }
          : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(row.last_verified_at ? { lastVerifiedAt: iso(row.last_verified_at) } : {})
      });
      linksBySku.set(sku, links);
    }
    return linksBySku;
  }

  async createJob(input: {
    sku: string;
    source: 'MANUAL' | 'AUTO';
    offerId?: string;
    offerIds?: string[];
    storeAlias?: string;
    taskFolder?: string;
    workRelPath?: string;
    directoryStage?: OzonTaskDirectoryStage;
    directorySignature?: string;
    revision?: number;
    payload: Record<string, unknown>;
    state?: OzonPublishJobState;
  }): Promise<OzonPublishJob> {
    const sku = normalizeSku(input.sku);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const existing = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs
        WHERE sku=$1 AND state = ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES]);
      if (existing.rows[0]) throw activeJobConflict(sku, existing.rows[0]);
      const storeAlias = await boundStoreAlias(client, input.storeAlias);
      return insertPublishJob(client, { ...input, storeAlias, sku, state: input.state || 'READY' });
    });
  }

  async createManualJob(input: {
    sku: string;
    offerId?: string;
    offerIds?: string[];
    storeAlias?: string;
    taskFolder?: string;
    workRelPath?: string;
    directoryStage?: OzonTaskDirectoryStage;
    directorySignature?: string;
    revision?: number;
    payload: Record<string, unknown>;
    state?: OzonPublishJobState;
  }): Promise<{ job: OzonPublishJob; supersededJobId?: string }> {
    const sku = normalizeSku(input.sku);
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const active = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs
        WHERE sku=$1 AND state = ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES]);
      const current = active.rows[0];
      const replacementJobId = randomUUID();
      const storeAlias = await boundStoreAlias(client, input.storeAlias);
      let supersededJobId: string | undefined;
      if (current) {
        if (!isSafeManualTakeoverJob(toJob(current))) throw activeJobConflict(sku, current);
        supersededJobId = String(current.id);
        const currentPayload = jsonObject(current.payload);
        await client.query(`
          UPDATE ozon_publish_jobs
          SET state='CANCELLED',payload=$2::jsonb,finished_at=NOW(),next_attempt_at=NULL,
              row_version=row_version+1,updated_at=NOW()
          WHERE id=$1`,
        [current.id, JSON.stringify({ ...currentPayload, supersededByManualJobId: replacementJobId })]);
        await addEvent(
          client,
          current.id,
          'JOB_SUPERSEDED_BY_MANUAL',
          current.state,
          'CANCELLED',
          '等待中的自动上品任务已由用户确认的手动任务替代',
          { replacementJobId }
        );
      }
      const job = await insertPublishJob(client, {
        ...input,
        storeAlias,
        id: replacementJobId,
        sku,
        source: 'MANUAL',
        state: input.state || 'READY',
        eventPayload: supersededJobId ? { supersededJobId } : {}
      });
      return { job, ...(supersededJobId ? { supersededJobId } : {}) };
    });
  }

  async createCompatibleAppendManualJob(
    input: OzonCompatibleAppendManualJobInput,
    prepare: (context: {
      listing: OzonListingDraft;
      revision: number;
      jobId: string;
    }) => Promise<OzonCompatibleAppendPreparedArtifact>
  ): Promise<{
    listing: OzonListingDraft;
    job: OzonPublishJob;
    artifact: OzonCompatibleAppendPreparedArtifact;
  }> {
    assertLegacyAutomaticTaskReadOnly();
    const sku = normalizeSku(input.sku);
    if (input.state !== 'WAITING_MEDIA') {
      throw new AppError('CONFIG_INVALID', 'OZON 兼容追加任务必须先以 WAITING_MEDIA 创建并由 P001 接管', { sku }, 409);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(String(input.planHash || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(input.manifestSignature || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(input.expectedProductIdentityHash || ''))) {
      throw new AppError('CONFIG_INVALID', 'OZON 兼容追加计划签名无效', { sku }, 409);
    }
    const expectedProductIdentity = {
      productName: String(input.expectedProductName || '').trim(),
      productVariants: input.expectedProductVariants.map((variant) => ({
        variantId: String(variant.variantId || '').trim(),
        name: String(variant.name || '').trim()
      }))
    };
    if (!expectedProductIdentity.productName
      || !expectedProductIdentity.productVariants.length
      || expectedProductIdentity.productVariants.some((variant) => !variant.variantId || !variant.name)
      || new Set(expectedProductIdentity.productVariants.map((variant) => variant.variantId)).size !== expectedProductIdentity.productVariants.length
      || `sha256:${createHash('sha256').update(stableJson(expectedProductIdentity)).digest('hex')}` !== input.expectedProductIdentityHash) {
      throw new AppError('CONFIG_INVALID', 'OZON 兼容追加产品身份冻结合同无效', { sku }, 409);
    }
    const parsed = ozonListingDraftInputSchema.safeParse({ ...input.listingData, rowVersion: input.rowVersion });
    if (!parsed.success) throw validationError(parsed.error.issues);
    const preservedOfferIds = normalizeOfferIds(input.preservedOfferIds);
    const submittedOfferIds = normalizeOfferIds(input.submittedOfferIds);
    const expectedOfferIds = normalizeOfferIds(input.expectedOfferIds);
    if (!submittedOfferIds.length
      || preservedOfferIds.length !== input.preservedOfferIds.length
      || submittedOfferIds.length !== input.submittedOfferIds.length
      || expectedOfferIds.length !== input.expectedOfferIds.length
      || stableJson(expectedOfferIds) !== stableJson([...preservedOfferIds, ...submittedOfferIds])
      || submittedOfferIds.some((offerId) => preservedOfferIds.includes(offerId))) {
      throw new AppError('CONFIG_INVALID', 'OZON 兼容追加 Offer 集合合同无效', {
        sku,
        preservedOfferIds,
        submittedOfferIds,
        expectedOfferIds
      }, 409);
    }
    const remoteAbsenceEvidence = assertCompatibleAppendRemoteAbsenceEvidence(
      input.remoteAbsenceEvidence,
      submittedOfferIds,
      requiredStoreAlias(input.expectedStoreAlias)
    );
    const offerContract = readFrozenOzonOfferContract({
      offerContractVersion: input.offerContractVersion,
      offerContractHash: input.offerContractHash,
      expectedOfferIds,
      submittedOfferIds,
      publishOfferIds: submittedOfferIds,
      expectedOfferSnapshots: input.expectedOfferSnapshots
    });
    if (!offerContract) {
      throw new AppError('CONFIG_INVALID', 'OZON 兼容追加缺少完整 Offer 合同', { sku }, 409);
    }
    const submittedSet = new Set(submittedOfferIds);
    const snapshotByOffer = new Map<string, Record<string, unknown>>();
    for (const snapshotInput of input.expectedOfferSnapshots) {
      const snapshot = jsonObject(snapshotInput);
      const offerId = String(snapshot.offerId || '').trim();
      snapshotByOffer.set(offerId, snapshot);
      const expectedDisposition = submittedSet.has(offerId) ? 'SUBMITTED' : 'PRESERVED_EXISTING';
      if (String(snapshot.disposition || '') !== expectedDisposition) {
        throw new AppError('CONFIG_INVALID', `OZON ${offerId} 的 disposition 与兼容追加提交范围不一致`, { sku }, 409);
      }
      if (expectedDisposition === 'PRESERVED_EXISTING') {
        const mapping = jsonObject(snapshot.mapping);
        if (!/^\d+$/.test(String(mapping.ozonProductId || '')) || !/^\d+$/.test(String(mapping.ozonSku || ''))) {
          throw new AppError('CONFIG_INVALID', `OZON ${offerId} 的保留平台映射无效`, { sku }, 409);
        }
      }
    }

    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      await assertNoActivePlatformStatusRefreshLease(client, sku);
      const settingsResult = await client.query<SqlRow>('SELECT * FROM ozon_system_settings WHERE id=$1 FOR SHARE', ['default']);
      const settings = settingsResult.rows[0] ? toSettings(settingsResult.rows[0]) : undefined;
      if (!settings
        || settings.rowVersion !== input.expectedSettingsRowVersion
        || settings.enabled !== true
        || settings.credentialReady !== true
        || settings.rootDirectory !== String(input.expectedRootDirectory || '').trim()
        || settings.defaultStoreAlias !== requiredStoreAlias(input.expectedStoreAlias)
        || (input.storeAlias && requiredStoreAlias(input.storeAlias) !== settings.defaultStoreAlias)) {
        throw new AppError('TASK_LOCKED', 'OZON 兼容追加绑定的系统配置已变化，请重新检测', {
          sku,
          expectedSettingsRowVersion: input.expectedSettingsRowVersion,
          actualSettingsRowVersion: settings?.rowVersion
        }, 409);
      }
      const productResult = await client.query<SqlRow>('SELECT product_name FROM products WHERE sku=$1 FOR SHARE', [sku]);
      const productVariantsResult = await client.query<SqlRow>(`
        SELECT id,name FROM product_variants
        WHERE sku=$1 AND BTRIM(name)<>'默认变体'
        ORDER BY sort_order ASC,created_at ASC
        FOR SHARE`, [sku]);
      const currentProductIdentity = {
        productName: String(productResult.rows[0]?.product_name || '').trim(),
        productVariants: productVariantsResult.rows.map((variant) => ({
          variantId: String(variant.id || '').trim(),
          name: String(variant.name || '').trim()
        }))
      };
      const currentProductIdentityHash = `sha256:${createHash('sha256').update(stableJson(currentProductIdentity)).digest('hex')}`;
      if (!productResult.rows[0]
        || stableJson(currentProductIdentity) !== stableJson(expectedProductIdentity)
        || currentProductIdentityHash !== input.expectedProductIdentityHash) {
        throw new AppError('TASK_LOCKED', 'OZON 兼容追加绑定的产品身份已变化，请重新检测', {
          sku,
          expectedProductIdentityHash: input.expectedProductIdentityHash,
          currentProductIdentityHash
        }, 409);
      }
      const currentResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const current = currentResult.rows[0];
      if (!current) throw new AppError('NOT_FOUND', 'OZON 上品资料不存在', { sku }, 404);
      if (Number(current.row_version) !== input.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 资料版本已变化，请重新检测兼容追加', {
          sku,
          expected: Number(current.row_version),
          actual: input.rowVersion
        }, 409);
      }
      if (String(current.status) !== 'PUBLISHED') {
        throw new AppError('TASK_LOCKED', '只有 PUBLISHED 的 OZON 资料可以兼容追加', {
          sku,
          status: current.status
        }, 409);
      }
      const boundPreset = await client.query<SqlRow>(`
        SELECT * FROM ozon_listing_presets
        WHERE FALSE FOR SHARE`);
      if (!boundPreset.rows[0]
        || String(boundPreset.rows[0].id) !== String(input.expectedPresetId)
        || Number(boundPreset.rows[0].row_version) !== input.expectedPresetRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 兼容追加绑定的冻结预设已变化，请重新检测', {
          sku,
          expectedPresetId: input.expectedPresetId,
          expectedPresetRowVersion: input.expectedPresetRowVersion,
          actualPresetId: boundPreset.rows[0]?.id,
          actualPresetRowVersion: Number(boundPreset.rows[0]?.row_version || 0)
        }, 409);
      }
      const categoryKey = String(current.data?.categoryKey || '').trim();
      const categoryBinding = categoryKey
        ? await client.query<SqlRow>('SELECT published_version_id FROM ozon_category_templates WHERE category_key=$1 FOR SHARE', [categoryKey])
        : undefined;
      if (!categoryBinding?.rows[0]
        || String(categoryBinding.rows[0].published_version_id || '') !== String(input.expectedCategoryVersionId)
        || String(current.data?.categoryVersionId || '') !== String(input.expectedCategoryVersionId)) {
        throw new AppError('TASK_LOCKED', 'OZON 兼容追加绑定的类目版本已变化，请重新检测', {
          sku,
          categoryKey,
          expectedCategoryVersionId: input.expectedCategoryVersionId,
          actualCategoryVersionId: categoryBinding?.rows[0]?.published_version_id
        }, 409);
      }
      const active = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs
        WHERE sku=$1 AND state=ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES]);
      if (active.rows[0]) throw activeJobConflict(sku, active.rows[0]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['merchroute-ozon-runtime-write-slot']);
      await client.query('DELETE FROM ozon_publish_slots WHERE slot_key=$1 AND lease_expires_at<=NOW()', [OZON_RUNTIME_SLOT_KEY]);
      const occupiedSlot = await client.query<SqlRow>(`
        SELECT job_id,lease_owner,lease_expires_at FROM ozon_publish_slots
        WHERE slot_key=$1 AND lease_expires_at>NOW() FOR SHARE`,
      [OZON_RUNTIME_SLOT_KEY]);
      if (occupiedSlot.rows[0]) {
        throw new AppError('TASK_LOCKED', 'OZON 平台单写槽正在执行其他任务，请稍后重试', {
          sku,
          jobId: String(occupiedSlot.rows[0].job_id || ''),
          leaseOwner: String(occupiedSlot.rows[0].lease_owner || '')
        }, 409);
      }

      const storeAlias = await boundStoreAlias(client, input.storeAlias);
      const currentOfferIds = normalizeOfferIds(
        Array.isArray(current.data?.offers) ? current.data.offers.map((offer: SqlRow) => offer.offerId) : []
      );
      if (stableJson(currentOfferIds) !== stableJson(preservedOfferIds)) {
        throw new AppError('TASK_LOCKED', '既有 OZON Offer 已变化，请重新检测兼容追加', {
          sku,
          expected: currentOfferIds,
          actual: preservedOfferIds
        }, 409);
      }
      const mappings = await client.query<SqlRow>(`
        SELECT * FROM ozon_product_mappings
        WHERE store_alias=$1 AND offer_id=ANY($2::text[])
        FOR SHARE`,
      [storeAlias, expectedOfferIds]);
      const mappingByOffer = new Map(mappings.rows.map((row) => [String(row.offer_id), row]));
      const incompletePreserved = preservedOfferIds.filter((offerId) => {
        const mapping = mappingByOffer.get(offerId);
        return !mapping
          || String(mapping.sku) !== sku
          || !String(mapping.ozon_product_id || '').trim()
          || !String(mapping.ozon_sku || '').trim();
      });
      const alreadyMappedSubmitted = submittedOfferIds.filter((offerId) => mappingByOffer.has(offerId));
      const changedPreserved = preservedOfferIds.filter((offerId) => {
        const row = mappingByOffer.get(offerId);
        const snapshotMapping = jsonObject(snapshotByOffer.get(offerId)?.mapping);
        return !row
          || String(snapshotMapping.ozonProductId || '') !== String(row.ozon_product_id || '')
          || String(snapshotMapping.ozonSku || '') !== String(row.ozon_sku || '');
      });
      if (incompletePreserved.length || alreadyMappedSubmitted.length || changedPreserved.length) {
        throw new AppError('TASK_LOCKED', 'OZON 平台映射已变化，兼容追加已停止', {
          sku,
          incompletePreserved,
          alreadyMappedSubmitted,
          changedPreserved
        }, 409);
      }

      const { rowVersion: _ignoredRowVersion, ...rawData } = parsed.data;
      void _ignoredRowVersion;
      const protectedData = protectOzonGrossWeightLinkage(current.data, rawData, sku, false, true, true);
      const normalizedDescriptions = normalizeOzonListingDescriptions(protectedData);
      const categoryIdentity = await listingCategoryIdentity(client, normalizedDescriptions);
      const data = enforceOzonSkuIdentity(
        normalizedDescriptions,
        sku,
        categoryIdentity.attributes,
        categoryIdentity.typeId
      );
      assertOzonGrossWeightLinkage(data, sku);
      if (!listingReady(data)) {
        throw new AppError('CONFIG_INVALID', 'OZON 兼容追加资料不完整，不能生成任务', { sku }, 409);
      }
      const mergedOfferIds = normalizeOfferIds(data.offers.map((offer) => offer.offerId));
      if (stableJson(mergedOfferIds) !== stableJson(expectedOfferIds)) {
        throw new AppError('CONFIG_INVALID', 'OZON 兼容追加资料与 Offer 计划不一致', {
          sku,
          expectedOfferIds,
          mergedOfferIds
        }, 409);
      }
      const existingOffers = new Map<string, { offerId?: string; variantCode?: string }>(
        (Array.isArray(current.data?.offers) ? current.data.offers : []).map((offer: SqlRow) => [
          String(offer.variantId),
          { offerId: String(offer.offerId || ''), variantCode: String(offer.variantCode || '') }
        ])
      );
      const variantCodes = new Set<string>();
      for (const offer of data.offers) {
        if (variantCodes.has(offer.variantCode)) {
          throw new AppError('CONFIG_INVALID', '同一商品的稳定变体编码不能重复', { sku, variantCode: offer.variantCode }, 409);
        }
        variantCodes.add(offer.variantCode);
        const existing = existingOffers.get(String(offer.variantId));
        if (existing && (String(existing.offerId) !== offer.offerId || String(existing.variantCode) !== offer.variantCode)) {
          throw new AppError('CONFIG_INVALID', '兼容追加不能修改既有 Offer 身份', { sku, variantId: offer.variantId }, 409);
        }
        if (!existing && (!isOzonSequentialVariantCode(offer.variantCode)
          || stableOzonOfferId(sku, offer.variantCode) !== offer.offerId)) {
          throw new AppError('CONFIG_INVALID', '新增 Offer 必须使用 SKU 与两位稳定变体编码', {
            sku,
            variantId: offer.variantId,
            offerId: offer.offerId,
            variantCode: offer.variantCode
          }, 409);
        }
      }

      // Compatible append changes the listing snapshot. Always allocate a fresh
      // revision even when a prior failed generator wrote a version without a job.
      const revision = Number(current.revision || 1) + 1;
      const jobId = randomUUID();
      const ephemeralListing = toListing({
        ...current,
        data,
        revision,
        status: 'READY'
      });

      // All version, lease, slot, mapping and Offer-contract checks are complete
      // before the callback is allowed to write its scoped artifacts.
      const artifact = await prepare({ listing: ephemeralListing, revision, jobId });
      const artifactSignature = String(artifact?.signature || '').trim();
      const productJsonPath = String(artifact?.productJsonPath || '').trim();
      const readyMarker = String(artifact?.readyMarker || '').trim();
      const taskFolder = normalizeTaskFolder(artifact?.taskFolder);
      const workRelPath = normalizeOptionalRelativePath(artifact?.workRelPath);
      if (!/^sha256:[a-f0-9]{64}$/.test(artifactSignature)
        || !productJsonPath || !readyMarker || !taskFolder || !workRelPath) {
        throw new AppError('CONFIG_INVALID', 'OZON 兼容追加产物合同无效，已停止提交', { sku, jobId }, 409);
      }

      const updatedListing = await client.query<SqlRow>(`
        UPDATE ozon_listing_drafts
        SET data=$2::jsonb,status='SUBMITTING',revision=$3,last_task_id=$4,
            last_error_code=NULL,last_error_message=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 RETURNING *`,
      [sku, JSON.stringify(data), revision, jobId]);
      await insertSharedMaterialVersion(client, { ...updatedListing.rows[0], data });
      const job = await insertPublishJob(client, {
        id: jobId,
        sku,
        source: 'MANUAL',
        state: input.state,
        storeAlias,
        offerIds: expectedOfferIds,
        taskFolder,
        workRelPath,
        directoryStage: 'INBOX',
        directorySignature: artifactSignature,
        revision,
        payload: {
          mode: 'COMPATIBLE_APPEND',
          planHash: input.planHash,
          manifestSignature: input.manifestSignature,
          preservedOfferIds,
          submittedOfferIds,
          expectedOfferIds,
          offerIds: expectedOfferIds,
          publishOfferIds: submittedOfferIds,
          offerContractVersion: offerContract.offerContractVersion,
          offerContractHash: offerContract.offerContractHash,
          expectedOfferSnapshots: offerContract.expectedOfferSnapshots,
          revision,
          productJsonPath,
          readyMarker,
          preparedArtifactSignature: artifactSignature,
          remoteAbsenceEvidence
        },
        eventPayload: {
          mode: 'COMPATIBLE_APPEND',
          planHash: input.planHash,
          preservedOfferIds,
          submittedOfferIds,
          remoteAbsenceEvidence
        }
      });
      await addEvent(
        client,
        jobId,
        'COMPATIBLE_APPEND_PREPARED',
        undefined,
        input.state,
        'OZON 兼容追加资料、产物与手动任务已原子绑定',
        { planHash: input.planHash, manifestSignature: input.manifestSignature, artifactSignature }
      );
      return { listing: toListing(updatedListing.rows[0]!), job, artifact };
    });
  }

  async enqueueAutomaticJob(input: {
    sku: string;
    media: Record<string, unknown>;
    mediaReady: boolean;
    /**
     * Internal-only admission selected from the immutable OZON store rows.
     * This lets a non-default ready store start the shared preparation round
     * without reviving the removed preset-level automatic switch.
     */
    multistoreAdmission?: {
      storeId: string;
      presetId: string;
      activatedAt: string;
      autoPublishMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
    };
  }): Promise<OzonAutomaticMediaDeliveryResult> {
    return this.transaction(async (client) => {
      const sku = normalizeSku(input.sku);
      const mediaIdentity = mediaDeliveryIdentity(input.media);
      const settingsRow = await client.query<SqlRow>(
        'SELECT * FROM ozon_system_settings WHERE id=$1 FOR SHARE',
        ['default']
      );
      if (!settingsRow.rows[0]) throw new AppError('NOT_FOUND', 'OZON 系统配置不存在', undefined, 404);
      const settings = toSettings(settingsRow.rows[0]);
      await lockSkuJob(client, sku);
      const recordedDelivery = await client.query<SqlRow>(`
        SELECT * FROM ozon_media_deliveries
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
        FOR UPDATE`,
      [sku, mediaIdentity.sourceStageId, mediaIdentity.submissionId, mediaIdentity.variantId]);
      if (!settings.enabled) {
        if (recordedDelivery.rows[0]) {
          const recorded = recordedDelivery.rows[0];
          const recordedPayload = jsonObject(recorded.payload);
          const recordedJobId = String(recorded.job_id || '').trim();
          const recordedJob = recordedJobId
            ? (await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1', [recordedJobId])).rows[0]
            : undefined;
          const legacyBinding = legacyAutomaticMediaAcceptanceBinding(recordedJob, mediaIdentity, recordedPayload);
          const previouslyAccepted = isDurablyAcceptedAutomaticMedia(recordedPayload) || Boolean(legacyBinding);
          const decision = String(recordedPayload.autoPublishDecision || '').trim().toUpperCase();
          if (decision === 'CONSUMED_REMOTE' || decision === 'FANNED_OUT'
            || (decision === 'IGNORED' && !previouslyAccepted)) {
            return { job: undefined, becameRunnable: false, deferred: false };
          }
          if (previouslyAccepted) {
            const originalSettingsRowVersion = Number(
              recordedPayload.autoPublishAcceptedSettingsRowVersion
              ?? recordedPayload.autoPublishSettingsRowVersion
            );
            const acceptedPayload = acceptedAutomaticMediaPayload(
              {
                ...recordedPayload,
                ...input.media,
                ...(!Number.isSafeInteger(originalSettingsRowVersion) ? {
                  legacyAcceptedSettingsEvidence: {
                    source: 'LEGACY_AUTO_JOB_BINDING',
                    originalSettingsRowVersion: null,
                    reconciledSettingsRowVersion: settings.rowVersion
                  }
                } : {})
              },
              {
                ...(legacyBinding || jsonObject(jsonObject(recordedJob?.payload).presetBinding)),
                settingsRowVersion: Number.isSafeInteger(originalSettingsRowVersion)
                  ? originalSettingsRowVersion
                  : settings.rowVersion
              },
              recordedJobId
            );
            await deferAcceptedMediaDelivery(client, sku, mediaIdentity, acceptedPayload, 'SYSTEM_DISABLED');
            return { job: undefined, becameRunnable: false, deferred: true };
          }
          await insertMediaDelivery(client, sku, undefined, mediaIdentity, {
            ...recordedPayload,
            ...input.media,
            autoPublishDecision: 'IGNORED',
            autoPublishIgnoredReason: 'SYSTEM_DISABLED',
            autoPublishIgnoredAt: new Date().toISOString(),
            autoPublishSettingsRowVersion: settings.rowVersion
          });
        } else {
          await insertMediaDelivery(client, sku, undefined, mediaIdentity, {
            ...input.media,
            autoPublishDecision: 'IGNORED',
            autoPublishIgnoredReason: 'SYSTEM_DISABLED',
            autoPublishIgnoredAt: new Date().toISOString(),
            autoPublishSettingsRowVersion: settings.rowVersion
          });
        }
        return { job: undefined, becameRunnable: false, deferred: false };
      }
      const multistoreAdmission = input.multistoreAdmission;
      if (!multistoreAdmission) {
        const recordedPayload = jsonObject(recordedDelivery.rows[0]?.payload);
        if (isDurablyAcceptedAutomaticMedia(recordedPayload)) {
          await deferAcceptedMediaDelivery(client, sku, mediaIdentity, recordedPayload, 'STORE_SETTINGS_REQUIRED');
          return { job: undefined, becameRunnable: false, deferred: true };
        }
        await insertMediaDelivery(client, sku, undefined, mediaIdentity, {
          ...input.media,
          autoPublishDecision: 'IGNORED',
          autoPublishIgnoredReason: 'STORE_SETTINGS_REQUIRED',
          autoPublishIgnoredAt: new Date().toISOString(),
          autoPublishSettingsRowVersion: settings.rowVersion
        });
        return { job: undefined, becameRunnable: false, deferred: false };
      }
      const presetRow = await client.query<SqlRow>('SELECT * FROM ozon_listing_presets WHERE id=$1 FOR SHARE', [multistoreAdmission.presetId]);
      const storedPreset = presetRow.rows[0] ? toLegacyPreset(presetRow.rows[0]) : undefined;
      const activationStartedAt = normalizeAutomaticDeliveryTime(multistoreAdmission.activatedAt);
      const preset = storedPreset ? {
        ...storedPreset,
        autoPublishEnabled: true,
        autoPublishMode: multistoreAdmission.autoPublishMode,
        autoPublishActivatedAt: activationStartedAt,
        fulfillmentMode: 'FBS' as const,
        warehouseId: '',
        currency: 'RUB' as const,
        isDefault: false
      } : undefined;
      const admissionEnabled = Boolean(preset);
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR SHARE', [sku]);
      const representedOfferIds: string[] = [];
      let deliveryPayload = input.media;
      let previouslyAccepted = false;
      let admissionChecked = false;
      let deliveredAt: string | undefined;
      const ensureAutomaticMediaAdmission = async (): Promise<OzonAutomaticMediaDeliveryResult | undefined> => {
        if (admissionChecked) return undefined;
        admissionChecked = true;
        if (previouslyAccepted) {
          if (!preset || !admissionEnabled || !activationStartedAt) {
            await deferAcceptedMediaDelivery(client, sku, mediaIdentity, deliveryPayload, 'DEFAULT_PRESET_DISABLED');
            return { job: undefined, becameRunnable: false, deferred: true };
          }
          deliveredAt = normalizeAutomaticDeliveryTime(deliveryPayload.deliveredAt);
          return undefined;
        }
        if (!preset || !admissionEnabled || !activationStartedAt) {
          await insertMediaDelivery(client, sku, undefined, mediaIdentity, {
            ...input.media,
            autoPublishDecision: 'IGNORED',
            autoPublishIgnoredReason: 'DEFAULT_PRESET_DISABLED',
            autoPublishIgnoredAt: new Date().toISOString(),
            autoPublishSettingsRowVersion: settings.rowVersion
          });
          return { job: undefined, becameRunnable: false, deferred: false };
        }
        deliveredAt = normalizeAutomaticDeliveryTime(deliveryPayload.deliveredAt);
        if (Date.parse(deliveredAt) < Date.parse(activationStartedAt)) {
          await insertMediaDelivery(client, sku, undefined, mediaIdentity, {
            ...input.media,
            autoPublishDecision: 'IGNORED',
            autoPublishIgnoredReason: 'BEFORE_PRESET_ACTIVATION',
            autoPublishIgnoredAt: new Date().toISOString(),
            autoPublishPresetId: preset.id,
            autoPublishActivatedAt: activationStartedAt,
            autoPublishSettingsRowVersion: settings.rowVersion
          });
          return { job: undefined, becameRunnable: false, deferred: false };
        }
        deliveryPayload = acceptedAutomaticMediaPayload(
          deliveryPayload,
          { ...createOzonAutoPresetBinding(preset, deliveredAt, activationStartedAt), settingsRowVersion: settings.rowVersion },
          ''
        );
        previouslyAccepted = true;
        return undefined;
      };
      if (recordedDelivery.rows[0]) {
        const recordedPayload = jsonObject(recordedDelivery.rows[0].payload);
        const recordedJobId = String(recordedDelivery.rows[0].job_id || '');
        const recordedJob = recordedJobId
          ? (await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1', [recordedJobId])).rows[0]
          : undefined;
        const legacyBinding = legacyAutomaticMediaAcceptanceBinding(recordedJob, mediaIdentity, recordedPayload);
        previouslyAccepted = isDurablyAcceptedAutomaticMedia(recordedPayload) || Boolean(legacyBinding);
        if (previouslyAccepted) {
          const originalSettingsRowVersion = Number(
            recordedPayload.autoPublishAcceptedSettingsRowVersion
            ?? recordedPayload.autoPublishSettingsRowVersion
          );
          deliveryPayload = acceptedAutomaticMediaPayload(
            {
              ...recordedPayload,
              ...input.media,
              ...(!Number.isSafeInteger(originalSettingsRowVersion) ? {
                legacyAcceptedSettingsEvidence: {
                  source: 'LEGACY_AUTO_JOB_BINDING',
                  originalSettingsRowVersion: null,
                  reconciledSettingsRowVersion: settings.rowVersion
                }
              } : {})
            },
            {
              ...(legacyBinding || jsonObject(jsonObject(recordedJob?.payload).presetBinding)),
              settingsRowVersion: Number.isSafeInteger(originalSettingsRowVersion)
                ? originalSettingsRowVersion
                : settings.rowVersion
            },
            recordedJobId
          );
        }
        const recordedDecision = String(recordedPayload.autoPublishDecision || '').trim().toUpperCase();
        if (recordedDecision === 'CONSUMED_REMOTE' || recordedDecision === 'FANNED_OUT'
          || (recordedDecision === 'IGNORED' && !previouslyAccepted)) {
          return { job: undefined, becameRunnable: false, deferred: false };
        }
        const admissionResult = await ensureAutomaticMediaAdmission();
        if (admissionResult) return admissionResult;
        const existing = await client.query<SqlRow>(`
          SELECT * FROM ozon_publish_jobs
          WHERE sku=$1 AND state = ANY($2::text[])
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [sku, ACTIVE_JOB_STATES]);
        const active = existing.rows[0];
        const mappingStoreAlias = String(recordedJob?.store_alias || active?.store_alias || settings.defaultStoreAlias);
        const remoteRepresentation = await hasCompleteOzonRemoteRepresentation(
          client,
          mappingStoreAlias,
          sku,
          representedOfferIds
        );
        if (recordedJob
          && !['FAILED', 'CANCELLED'].includes(String(recordedJob.state || ''))
          && isBoundDurablyAcceptedAutomaticMediaReplay(
            recordedJobId,
            recordedPayload,
            recordedJob,
            mediaIdentity
          )) {
          // A publication child can become the newest active SKU job between
          // fan-out package creation and a duplicate E004/E005 notification.
          // The durable delivery owner remains the original preparation job;
          // never clear that binding merely because the child is newer.
          return { job: toJob(recordedJob), becameRunnable: false, deferred: false };
        }
        if (active && active.source === 'AUTO' && hasActiveAutomaticRecoveryHold(active) && recordedJobId === String(active.id)) {
          return { job: toJob(active), becameRunnable: false, deferred: true };
        }
        if (active && isBoundDurablyAcceptedAutomaticMediaReplay(
          recordedJobId,
          recordedPayload,
          active,
          mediaIdentity
        )) {
          // Reconciliation may replay the same historical delivery after the bound
          // round becomes frozen/NEEDS_ATTENTION. The durable binding is ownership,
          // not a new delivery: preserve the row byte-for-byte for same-job recovery.
          return { job: toJob(active), becameRunnable: false, deferred: false };
        }
        if (active && active.source === 'AUTO' && isMutableAutomaticMediaJob(active)) {
          if (recordedJobId === String(active.id)) {
            // Continue into the mutable-job branch so legacy rows are upgraded to
            // an explicit durable acceptance without creating a second delivery.
          } else if (remoteRepresentation) {
            await markMediaDeliveryRemoteRepresented(client, sku, mediaIdentity, deliveryPayload, representedOfferIds);
            return { job: toJob(active), becameRunnable: false, deferred: false };
          } else if (representedOfferIds.length) {
            await deferMediaDelivery(client, sku, mediaIdentity, deliveryPayload, active);
            return { job: toJob(active), becameRunnable: false, deferred: true };
          }
          // The identity belongs to a prior/frozen round but has not yet been represented.
          // Fall through so it can be atomically reassigned to this mutable completion round.
        } else if (recordedJobId && remoteRepresentation) {
          // This is an idempotent replay of media proven to have a durable remote mapping.
          await markMediaDeliveryRemoteRepresented(client, sku, mediaIdentity, deliveryPayload, representedOfferIds);
          return { job: active?.source === 'AUTO' ? toJob(active) : undefined, becameRunnable: false, deferred: false };
        } else if (active) {
          await deferMediaDelivery(client, sku, mediaIdentity, deliveryPayload, active);
          return { job: active.source === 'AUTO' ? toJob(active) : undefined, becameRunnable: false, deferred: true };
        } else if (remoteRepresentation) {
          await markMediaDeliveryRemoteRepresented(client, sku, mediaIdentity, deliveryPayload, representedOfferIds);
          return { job: undefined, becameRunnable: false, deferred: false };
        } else if (representedOfferIds.length) {
          await deferMediaDeliveryForRemoteVerification(client, sku, mediaIdentity, deliveryPayload, representedOfferIds);
          return { job: undefined, becameRunnable: false, deferred: true };
        }
        // No active job and the recorded delivery still represents a missing variant:
        // continue into normal job creation and rebind this durable delivery identity.
      }
      const admissionResult = await ensureAutomaticMediaAdmission();
      if (admissionResult) return admissionResult;
      const existing = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs
        WHERE sku=$1 AND state = ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES]);
      if (existing.rows[0]) {
        const current = existing.rows[0];
        if (current.source !== 'AUTO' || !isMutableAutomaticMediaJob(current)) {
          await deferMediaDelivery(client, sku, mediaIdentity, deliveryPayload, current);
          return { job: current.source === 'AUTO' ? toJob(current) : undefined, becameRunnable: false, deferred: true };
        }
        const currentPayload = current.payload && typeof current.payload === 'object' ? current.payload : {};
        const acceptedMedia = acceptedAutomaticMediaPayload(
          deliveryPayload,
          jsonObject(currentPayload.presetBinding),
          String(current.id)
        );
        const deliveries = Array.isArray(currentPayload.mediaDeliveries)
          ? currentPayload.mediaDeliveries.filter((delivery: unknown) => delivery && typeof delivery === 'object' && !Array.isArray(delivery))
          : [];
        const matchingDelivery = deliveries.find((delivery: unknown) => sameMediaDeliveryIdentity(delivery, mediaIdentity));
        if (matchingDelivery) {
          const latestMediaNeedsUpgrade = sameMediaDeliveryIdentity(currentPayload.media, mediaIdentity)
            && !isDurablyAcceptedAutomaticMedia(currentPayload.media);
          if (isDurablyAcceptedAutomaticMedia(matchingDelivery) && !latestMediaNeedsUpgrade) {
            await insertMediaDelivery(client, sku, current.id, mediaIdentity, acceptedMedia);
            return { job: toJob(current), becameRunnable: false, deferred: false };
          }
          const normalizedDeliveries = deliveries.map((delivery: unknown) => (
            sameMediaDeliveryIdentity(delivery, mediaIdentity) ? acceptedMedia : delivery
          ));
          const normalizedPayload = {
            ...currentPayload,
            ...(sameMediaDeliveryIdentity(currentPayload.media, mediaIdentity) ? { media: acceptedMedia } : {}),
            mediaDeliveries: normalizedDeliveries
          };
          const upgraded = await client.query<SqlRow>(`
            UPDATE ozon_publish_jobs
            SET payload=$2::jsonb,row_version=row_version+1,updated_at=NOW()
            WHERE id=$1 RETURNING *`,
          [current.id, JSON.stringify(normalizedPayload)]);
          await insertMediaDelivery(client, sku, current.id, mediaIdentity, acceptedMedia);
          return { job: toJob(upgraded.rows[0]!), becameRunnable: false, deferred: false };
        }
        const mergedDeliveries = [...deliveries, acceptedMedia];
        const hasLeaseMetadata = Boolean(current.lease_owner || current.lease_token || current.lease_expires_at);
        const becameRunnable = current.state === 'WAITING_MEDIA'
          && (settings.credentialReady || Boolean(multistoreAdmission) || currentPayload.multistorePreparation === true)
          && input.mediaReady
          && !hasLeaseMetadata;
        const nextState: OzonPublishJobState = becameRunnable ? 'READY' : current.state;
        const canReplaceLatestMedia = !hasLeaseMetadata && ['WAITING_MEDIA', 'READY'].includes(String(current.state));
        const payload = {
          ...currentPayload,
          ...(canReplaceLatestMedia ? { media: acceptedMedia } : {}),
          mediaDeliveries: mergedDeliveries
        };
        const clearsMediaWait = becameRunnable
          && ['', 'MEDIA_INCOMPLETE'].includes(String(current.last_error_code || '').trim().toUpperCase());
        const updated = await client.query<SqlRow>(`
          UPDATE ozon_publish_jobs
          SET state=$2,payload=$3::jsonb,
              last_error_code=CASE WHEN $4 THEN NULL ELSE last_error_code END,
              last_error_message=CASE WHEN $4 THEN NULL ELSE last_error_message END,
              next_attempt_at=CASE WHEN $4 THEN NULL ELSE next_attempt_at END,
              row_version=row_version+1,updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [current.id, nextState, JSON.stringify(payload), clearsMediaWait]);
        await insertMediaDelivery(client, sku, current.id, mediaIdentity, acceptedMedia);
        await addEvent(
          client,
          current.id,
          'MEDIA_DELIVERED',
          current.state,
          nextState,
          becameRunnable
            ? 'OZON 共享媒体投递已合并，等待媒体任务重新进入自动检查'
            : 'OZON 共享媒体投递已合并，现有任务状态、根错误与退避保持不变',
          { ...input.media, mediaReady: input.mediaReady, becameRunnable }
        );
        return { job: toJob(updated.rows[0]!), becameRunnable, deferred: false };
      }
      if (representedOfferIds.length) {
        const remoteRepresentation = await hasCompleteOzonRemoteRepresentation(
          client,
          settings.defaultStoreAlias,
          sku,
          representedOfferIds
        );
        if (remoteRepresentation) {
          await markMediaDeliveryRemoteRepresented(client, sku, mediaIdentity, deliveryPayload, representedOfferIds);
          return { job: undefined, becameRunnable: false, deferred: false };
        }
        await deferMediaDeliveryForRemoteVerification(client, sku, mediaIdentity, deliveryPayload, representedOfferIds);
        return { job: undefined, becameRunnable: false, deferred: true };
      }
      const refreshExisting = String(listingResult.rows[0]?.status || '') === 'PUBLISHED'
        && Array.isArray(listingResult.rows[0]?.data?.offers)
        && listingResult.rows[0].data.offers.length > 0;
      const remoteMapping = multistoreAdmission
        ? { rows: [{ exists: false }] }
        : await client.query<{ exists: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM ozon_product_mappings
          WHERE store_alias=$1 AND sku=$2
            AND COALESCE(ozon_product_id,'')<>'' AND COALESCE(ozon_sku,'')<>''
        ) AS exists`, [settings.defaultStoreAlias, sku]);
      if (!multistoreAdmission && preset!.autoPublishMode === 'CREATE_ONLY' && (refreshExisting || remoteMapping.rows[0]?.exists)) {
        const acceptedMedia = acceptedAutomaticMediaPayload(
          deliveryPayload,
          { ...createOzonAutoPresetBinding(preset!, deliveredAt!, activationStartedAt), settingsRowVersion: settings.rowVersion },
          ''
        );
        await deferAcceptedMediaDelivery(client, sku, mediaIdentity, acceptedMedia, 'COMPATIBLE_MODE_REQUIRED');
        return { job: undefined, becameRunnable: false, deferred: true };
      }
      const state: OzonPublishJobState = (settings.credentialReady || Boolean(multistoreAdmission)) && input.mediaReady
        ? 'READY'
        : 'WAITING_MEDIA';
      const id = randomUUID();
      const stageStates = { import: 'PENDING', moderation: 'PENDING', images: 'WAITING_LOCAL', video: 'WAITING_LOCAL', price: 'PENDING', stock: 'PENDING' };
      const presetBinding = createOzonAutoPresetBinding(preset!, deliveredAt!, activationStartedAt);
      const acceptedMedia = acceptedAutomaticMediaPayload(
        deliveryPayload,
        { ...presetBinding, settingsRowVersion: settings.rowVersion },
        id
      );
      const payload = {
        presetId: preset!.id,
        presetBinding,
        media: acceptedMedia,
        mediaDeliveries: [acceptedMedia],
        ...(multistoreAdmission ? {
          multistorePreparation: true,
          multistoreAdmission: {
            storeId: multistoreAdmission.storeId,
            presetId: multistoreAdmission.presetId,
            activatedAt: activationStartedAt,
            autoPublishMode: multistoreAdmission.autoPublishMode
          }
        } : {})
      };
      const created = multistoreAdmission
        ? await client.query<SqlRow>(`
            INSERT INTO ozon_publish_jobs(
              id,sku,state,source,payload,stage_states,row_version,store_alias,directory_stage,
              work_rel_path,listing_revision,store_id,task_kind
            )
            SELECT $1,$2,$3,'AUTO',$4::jsonb,$5::jsonb,1,store_alias,'INBOX',$6,0,id,'SHARED_PREPARATION'
            FROM ozon_stores
            WHERE id=$7::uuid AND enabled=true AND archived_at IS NULL
            RETURNING *`, [
            id, sku, state, JSON.stringify(payload), JSON.stringify(stageStates), portableRelPath('inbox', sku),
            multistoreAdmission.storeId
          ])
        : await client.query<SqlRow>(`
            INSERT INTO ozon_publish_jobs(
              id,sku,state,source,payload,stage_states,row_version,store_alias,directory_stage,work_rel_path,listing_revision
            )
            VALUES($1,$2,$3,'AUTO',$4::jsonb,$5::jsonb,1,$6,'INBOX',$7,0) RETURNING *`,
          [id, sku, state, JSON.stringify(payload), JSON.stringify(stageStates), settings.defaultStoreAlias, portableRelPath('inbox', sku)]);
      if (!created.rows[0]) {
        throw new AppError('OZON_STORE_NOT_READY', 'OZON 自动上品准备店铺已停用或归档', {
          storeId: multistoreAdmission?.storeId
        }, 409);
      }
      await insertMediaDelivery(client, sku, id, mediaIdentity, acceptedMedia);
      await addEvent(client, id, 'JOB_CREATED', undefined, state, '自动上品任务已创建', {
        presetId: preset!.id,
        mediaReady: input.mediaReady,
        multistorePreparation: Boolean(multistoreAdmission)
      });
      return { job: toJob(created.rows[0]!), becameRunnable: state === 'READY', deferred: false };
    });
  }

  async deferAutomaticMediaDeliveryForCapability(input: {
    sku: string;
    media: Record<string, unknown>;
  }): Promise<OzonAutomaticMediaDeliveryResult> {
    return this.transaction(async (client) => {
      const sku = normalizeSku(input.sku);
      const mediaIdentity = mediaDeliveryIdentity(input.media);
      const deliveredAt = normalizeAutomaticDeliveryTime(input.media.deliveredAt);
      await lockSkuJob(client, sku);
      const recorded = await client.query<SqlRow>(`
        SELECT * FROM ozon_media_deliveries
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
        FOR UPDATE`, [sku, mediaIdentity.sourceStageId, mediaIdentity.submissionId, mediaIdentity.variantId]);
      const current = recorded.rows[0];
      if (current) {
        const decision = String(jsonObject(current.payload).autoPublishDecision || '').trim().toUpperCase();
        const terminal = ['IGNORED', 'CONSUMED_REMOTE', 'FANNED_OUT'].includes(decision);
        return { job: undefined, becameRunnable: false, deferred: !terminal };
      }
      await client.query(`
        INSERT INTO ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,job_id,payload)
        VALUES($1,$2,$3,$4,NULL,$5::jsonb)
        ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO NOTHING`, [
        sku,
        mediaIdentity.sourceStageId,
        mediaIdentity.submissionId,
        mediaIdentity.variantId,
        JSON.stringify({
          ...input.media,
          deliveredAt,
          autoPublishDecision: 'DEFERRED',
          autoPublishDeferredReason: 'OZON_MULTISTORE_FLEET_CAPABILITY_DISABLED',
          autoPublishDeferredAt: new Date().toISOString()
        })
      ]);
      return { job: undefined, becameRunnable: false, deferred: true };
    });
  }

  async prepareAcceptedAutomaticMediaRecovery(
    input: OzonAcceptedMediaRecoveryPrepareInput
  ): Promise<OzonPublishJob> {
    assertLegacyAutomaticTaskReadOnly();
    const sku = assertTargetedAcceptedMediaRecoverySku(input.sku);
    const target = OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS[sku as '0000105' | '0000106'];
    const candidateOfferIds = normalizeOfferIds(input.candidateOfferIds);
    const retainedOfferIds = normalizeOfferIds(input.retainedMappings.map((mapping) => mapping.offerId));
    const identities = input.deliveries.map((delivery) => mediaDeliveryIdentity(delivery));
    const recoveryContract = assertTargetedAcceptedMediaRecoveryContract(
      sku,
      input.recoveryContract,
      retainedOfferIds,
      candidateOfferIds,
      identities
    );
    const platformPreflight = assertTargetedRecoveryPlatformPreflight(
      sku,
      input.platformPreflight,
      input.retainedMappings,
      candidateOfferIds
    );
    if (input.deliveries.length !== 4
      || new Set(identities.map(mediaDeliveryIdentityKey)).size !== input.deliveries.length
      || retainedOfferIds.length !== 1
      || candidateOfferIds.length !== 2
      || retainedOfferIds[0] !== `${sku}-01`
      || stableJson(candidateOfferIds) !== stableJson([`${sku}-02`, `${sku}-03`])
      || input.recoveredFromJobId !== target.recoveredFromJobId
      || stableJson(input.retainedMappings) !== stableJson([target.retainedMapping])) {
      throw new AppError('CONFIG_INVALID', 'OZON 定向媒体恢复输入不符合 0000105/0000106 合同', { sku }, 409);
    }
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      await assertNoActivePlatformStatusRefreshLease(client, sku);
      await assertNoActiveTargetedRecoveryExecution(client, sku);
      const settingsResult = await client.query<SqlRow>('SELECT * FROM ozon_system_settings WHERE id=$1 FOR SHARE', ['default']);
      const settings = settingsResult.rows[0] ? toSettings(settingsResult.rows[0]) : undefined;
      if (!settings || settings.rowVersion !== input.expectedSettingsRowVersion || !settings.enabled || !settings.credentialReady) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'SYSTEM_SETTINGS_CHANGED');
      }
      const settingsRootHash = `sha256:${createHash('sha256').update(stableJson(settings.rootDirectory)).digest('hex')}`;
      if (recoveryContract.settingsBinding.rowVersion !== settings.rowVersion
        || recoveryContract.settingsBinding.defaultStoreAlias !== settings.defaultStoreAlias
        || recoveryContract.settingsBinding.rootDirectoryHash !== settingsRootHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'SYSTEM_SETTINGS_BINDING_CHANGED');
      }
      assertTargetedRecoveryPlatformPreflight(
        sku,
        input.platformPreflight,
        input.retainedMappings,
        candidateOfferIds,
        settings.defaultStoreAlias
      );
      const presetResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_listing_presets WHERE FALSE FOR SHARE`);
      const preset = presetResult.rows[0] ? toLegacyPreset(presetResult.rows[0]) : undefined;
      if (!preset
        || preset.id !== input.expectedPresetId
        || preset.rowVersion !== input.expectedPresetRowVersion
        || !preset.autoPublishEnabled
        || !preset.autoPublishActivatedAt
        || preset.autoPublishMode !== 'COMPATIBLE_UPSERT') {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'DEFAULT_PRESET_CHANGED');
      }
      const currentPresetBinding = createOzonAutoPresetBinding(preset, preset.autoPublishActivatedAt);
      if (recoveryContract.presetBinding.presetId !== currentPresetBinding.presetId
        || recoveryContract.presetBinding.presetRowVersion !== currentPresetBinding.presetRowVersion
        || recoveryContract.presetBinding.definitionHash !== currentPresetBinding.definitionHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'DEFAULT_PRESET_BINDING_CHANGED');
      }
      await assertTargetedRecoveryProductIdentity(client, sku, recoveryContract);
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listing = listingResult.rows[0];
      if (!listing
        || Number(listing.row_version) !== input.expectedListingRowVersion
        || Number(listing.revision) !== input.expectedListingRevision
        || String(listing.status) !== 'PUBLISHED') {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LISTING_CHANGED');
      }
      const listingOfferIds = normalizeOfferIds(
        Array.isArray(listing.data?.offers) ? listing.data.offers.map((offer: SqlRow) => offer.offerId) : []
      );
      if (stableJson(listingOfferIds) !== stableJson(retainedOfferIds)
        || candidateOfferIds.some((offerId) => listingOfferIds.includes(offerId))) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LISTING_OFFER_IDENTITY_CHANGED');
      }
      assertTargetedRecoveryListingBinding(sku, listing.data, recoveryContract);
      const active = await client.query<SqlRow>(`
        SELECT * FROM ozon_publish_jobs WHERE sku=$1 AND state=ANY($2::text[])
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES]);
      if (active.rows[0]) throw activeJobConflict(sku, active.rows[0]);

      const sourceResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 AND sku=$2 FOR SHARE', [
        input.recoveredFromJobId,
        sku
      ]);
      const sourceJob = sourceResult.rows[0];
      if (!sourceJob
        || String(sourceJob.source) !== 'AUTO'
        || ACTIVE_JOB_STATES.includes(String(sourceJob.state) as OzonPublishJobState)
        || Number(sourceJob.row_version) !== input.expectedSourceJobRowVersion) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'SOURCE_JOB_CHANGED');
      }
      if (recoveryContract.sourceJobSnapshot.jobId !== String(sourceJob.id)
        || recoveryContract.sourceJobSnapshot.rowVersion !== Number(sourceJob.row_version)
        || recoveryContract.sourceJobSnapshot.payloadHash !== automaticMediaPayloadHash(sourceJob.payload)) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'SOURCE_JOB_SNAPSHOT_CHANGED');
      }
      const sourcePayload = jsonObject(sourceJob.payload);
      const sourceBinding = jsonObject(sourcePayload.presetBinding);
      if (!String(sourceBinding.presetId || '').trim() || !String(sourceBinding.definitionHash || '').trim()) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'SOURCE_ACCEPTANCE_BINDING_MISSING');
      }

      await assertTargetedAcceptedMediaRecoveryMappings(
        client,
        settings.defaultStoreAlias,
        sku,
        input.retainedMappings,
        candidateOfferIds
      );
      const deliveryRows = await client.query<SqlRow>(`
        SELECT *,updated_at::text AS updated_at_exact
        FROM ozon_media_deliveries WHERE sku=$1 FOR UPDATE`, [sku]);
      const deliveryByKey = new Map(deliveryRows.rows.map((row) => [mediaDeliveryRowKey(row), row]));
      const acceptedDeliveries: Record<string, unknown>[] = [];
      for (let index = 0; index < input.deliveries.length; index += 1) {
        const expected = input.deliveries[index]!;
        const identity = identities[index]!;
        const row = deliveryByKey.get(mediaDeliveryIdentityKey(identity));
        const rowPayload = jsonObject(row?.payload);
        if (!row
          || row.job_id
          || String(row.updated_at_exact || '') !== String(expected.expectedUpdatedAt || '').trim()
          || automaticMediaPayloadHash(rowPayload) !== expected.expectedPayloadHash
          || String(rowPayload.autoPublishDecision || '').toUpperCase() !== 'IGNORED'
          || String(rowPayload.autoPublishIgnoredReason || '') !== 'BEFORE_PRESET_ACTIVATION'
          || !sameMediaDeliveryIdentity(rowPayload, identity)
          || !legacyAutomaticMediaAcceptanceBinding(sourceJob, identity, expected.payload)) {
          throw targetedAcceptedMediaRecoveryConflict(sku, 'DELIVERY_LEDGER_CHANGED', { identity });
        }
        const originalSettingsRowVersion = Number(
          rowPayload.autoPublishAcceptedSettingsRowVersion
          ?? rowPayload.autoPublishSettingsRowVersion
          ?? jsonObject(expected.payload).autoPublishSettingsRowVersion
        );
        acceptedDeliveries.push(acceptedAutomaticMediaPayload(
          {
            ...rowPayload,
            ...expected.payload,
            ...(!Number.isSafeInteger(originalSettingsRowVersion) ? {
              legacyAcceptedSettingsEvidence: {
                source: 'TARGETED_DURABLE_ACCEPTANCE_RECOVERY',
                originalSettingsRowVersion: null,
                recoverySettingsRowVersion: settings.rowVersion
              }
            } : {})
          },
          {
            ...sourceBinding,
            settingsRowVersion: Number.isSafeInteger(originalSettingsRowVersion)
              ? originalSettingsRowVersion
              : settings.rowVersion
          },
          String(sourceJob.id)
        ));
      }

      const id = randomUUID();
      const holdToken = randomUUID();
      const now = new Date().toISOString();
      const preparedDeliveries = acceptedDeliveries.map((delivery) => ({
        ...delivery,
        targetedRecoveryPreparedAt: now
      }));
      const stageStates = {
        import: 'PENDING', moderation: 'PENDING', images: 'WAITING_LOCAL',
        video: 'WAITING_LOCAL', price: 'PENDING', stock: 'PENDING'
      };
      const presetBinding = createOzonAutoPresetBinding(preset, now);
      const recovery = {
        schemaVersion: 1,
        kind: 'PREVIOUSLY_ACCEPTED_VARIANT_MEDIA',
        recoveredFromJobId: String(sourceJob.id),
        preparedAt: now,
        platformPreflight,
        contract: recoveryContract
      };
      const payload = {
        presetId: preset.id,
        presetBinding,
        media: preparedDeliveries.at(-1),
        mediaDeliveries: preparedDeliveries,
        recovery,
        recoveryHold: {
          active: true,
          token: holdToken,
          preparedAt: now,
          reason: 'TARGETED_DURABLE_ACCEPTANCE_RECOVERY'
        }
      };
      await client.query<SqlRow>(`
        INSERT INTO ozon_publish_jobs(
          id,sku,state,source,payload,stage_states,row_version,store_alias,directory_stage,work_rel_path,listing_revision
        ) VALUES($1,$2,'WAITING_MEDIA','AUTO',$3::jsonb,$4::jsonb,1,$5,'INBOX',$6,0)
        RETURNING *`,
      [id, sku, JSON.stringify(payload), JSON.stringify(stageStates), settings.defaultStoreAlias, portableRelPath('inbox', sku)]);
      const preparedDeliverySnapshots: Array<{
        sourceStageId: string;
        submissionId: string;
        variantId: string;
        updatedAt: string;
        payloadHash: string;
      }> = [];
      for (let index = 0; index < identities.length; index += 1) {
        const identity = identities[index]!;
        const updated = await client.query<SqlRow>(`
          UPDATE ozon_media_deliveries
          SET job_id=$5,payload=$6::jsonb,updated_at=NOW()
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
            AND job_id IS NULL
          RETURNING updated_at::text AS updated_at_exact,payload`,
        [
          sku,
          identity.sourceStageId,
          identity.submissionId,
          identity.variantId,
          id,
          JSON.stringify(preparedDeliveries[index])
        ]);
        if (updated.rowCount !== 1) throw targetedAcceptedMediaRecoveryConflict(sku, 'DELIVERY_CAS_CHANGED', { identity });
        preparedDeliverySnapshots.push({
          ...identity,
          updatedAt: String(updated.rows[0]!.updated_at_exact),
          payloadHash: automaticMediaPayloadHash(updated.rows[0]!.payload)
        });
      }
      const heldPayload = {
        ...payload,
        recovery: {
          ...recovery,
          deliverySnapshots: preparedDeliverySnapshots,
          ledgerAudit: await targetedRecoveryLedgerAudit(client, sku)
        }
      };
      const heldJobResult = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET payload=$2::jsonb,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [id, JSON.stringify(heldPayload)]);
      await addEvent(client, id, 'JOB_CREATED', undefined, 'WAITING_MEDIA', '定向恢复的 OZON 自动上品轮次已创建并保持锁定', {
        presetId: preset.id,
        recoveredFromJobId: String(sourceJob.id),
        recoveryHold: true
      });
      await addEvent(client, id, 'ACCEPTED_MEDIA_RECOVERY_PREPARED', undefined, 'WAITING_MEDIA', '已原子恢复曾被接受的变体媒体，尚未放行远程上品', {
        deliveryCount: acceptedDeliveries.length,
        holdToken,
        platformPreflight
      });
      return toJob(heldJobResult.rows[0]!);
    });
  }

  async releaseAcceptedAutomaticMediaRecovery(
    input: OzonAcceptedMediaRecoveryReleaseInput
  ): Promise<OzonPublishJob> {
    assertLegacyAutomaticTaskReadOnly();
    const sku = assertTargetedAcceptedMediaRecoverySku(input.sku);
    const target = OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS[sku as '0000105' | '0000106'];
    const holdToken = normalizeLeaseToken(input.holdToken);
    const recoveryContract = assertTargetedAcceptedMediaRecoveryContract(
      sku,
      input.recoveryContract,
      normalizeOfferIds(input.retainedMappings.map((mapping) => mapping.offerId)),
      normalizeOfferIds(input.candidateOfferIds),
      input.deliveries.map((delivery) => mediaDeliveryIdentity(delivery))
    );
    const platformPreflight = assertTargetedRecoveryPlatformPreflight(
      sku,
      input.platformPreflight,
      input.retainedMappings,
      normalizeOfferIds(input.candidateOfferIds)
    );
    if (stableJson(input.retainedMappings) !== stableJson([target.retainedMapping])
      || stableJson(normalizeOfferIds(input.candidateOfferIds)) !== stableJson(target.candidateOfferIds)) {
      throw targetedAcceptedMediaRecoveryConflict(sku, 'RECOVERY_TARGET_CHANGED');
    }
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      await assertNoActivePlatformStatusRefreshLease(client, sku, input.jobId);
      await assertNoActiveTargetedRecoveryExecution(client, sku);
      const settingsResult = await client.query<SqlRow>('SELECT * FROM ozon_system_settings WHERE id=$1 FOR SHARE', ['default']);
      const settings = settingsResult.rows[0] ? toSettings(settingsResult.rows[0]) : undefined;
      const presetResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_listing_presets WHERE FALSE FOR SHARE`);
      const preset = presetResult.rows[0] ? toLegacyPreset(presetResult.rows[0]) : undefined;
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR SHARE', [sku]);
      const settingsRootHash = settings
        ? `sha256:${createHash('sha256').update(stableJson(settings.rootDirectory)).digest('hex')}`
        : '';
      if (!settings || settings.rowVersion !== input.expectedSettingsRowVersion || !settings.enabled || !settings.credentialReady
        || recoveryContract.settingsBinding.rowVersion !== input.expectedSettingsRowVersion
        || recoveryContract.settingsBinding.rowVersion !== settings.rowVersion
        || recoveryContract.settingsBinding.defaultStoreAlias !== settings.defaultStoreAlias
        || recoveryContract.settingsBinding.rootDirectoryHash !== settingsRootHash
        || !preset || preset.id !== input.expectedPresetId || preset.rowVersion !== input.expectedPresetRowVersion
        || recoveryContract.presetBinding.presetId !== input.expectedPresetId
        || recoveryContract.presetBinding.presetRowVersion !== input.expectedPresetRowVersion
        || !preset.autoPublishEnabled || preset.autoPublishMode !== 'COMPATIBLE_UPSERT'
        || !listingResult.rows[0] || Number(listingResult.rows[0].row_version) !== input.expectedListingRowVersion
        || String(listingResult.rows[0].status) !== 'PUBLISHED') {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'RELEASE_PRECONDITION_CHANGED');
      }
      const currentPresetBinding = createOzonAutoPresetBinding(preset, preset.autoPublishActivatedAt!);
      if (recoveryContract.presetBinding.definitionHash !== currentPresetBinding.definitionHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'RELEASE_PRESET_BINDING_CHANGED');
      }
      assertTargetedRecoveryPlatformPreflight(
        sku,
        input.platformPreflight,
        input.retainedMappings,
        normalizeOfferIds(input.candidateOfferIds),
        settings.defaultStoreAlias
      );
      await assertTargetedRecoveryProductIdentity(client, sku, recoveryContract);
      assertTargetedRecoveryListingBinding(sku, listingResult.rows[0]!.data, recoveryContract);
      await assertTargetedAcceptedMediaRecoveryMappings(
        client,
        settings.defaultStoreAlias,
        sku,
        input.retainedMappings,
        normalizeOfferIds(input.candidateOfferIds)
      );
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 AND sku=$2 FOR UPDATE', [input.jobId, sku]);
      const job = jobResult.rows[0];
      const payload = jsonObject(job?.payload);
      const hold = jsonObject(payload.recoveryHold);
      const frozenRecovery = jsonObject(payload.recovery);
      if (!job
        || Number(job.row_version) !== input.expectedJobRowVersion
        || String(job.source) !== 'AUTO'
        || String(job.state) !== 'WAITING_MEDIA'
        || hold.active !== true
        || String(hold.token || '') !== holdToken
        || stableJson(frozenRecovery.contract) !== stableJson(recoveryContract)
        || String(job.store_alias || '') !== settings.defaultStoreAlias
        || String(jsonObject(payload.presetBinding).presetId || '') !== currentPresetBinding.presetId
        || Number(jsonObject(payload.presetBinding).presetRowVersion) !== currentPresetBinding.presetRowVersion
        || String(jsonObject(payload.presetBinding).definitionHash || '') !== currentPresetBinding.definitionHash
        || String(jsonObject(frozenRecovery).recoveredFromJobId || '') !== target.recoveredFromJobId
        || job.lease_owner || job.lease_token || job.lease_expires_at
        || job.task_id || job.import_task_id || job.ozon_product_id) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'RECOVERY_HOLD_CHANGED');
      }
      const expectedKeys = new Set(input.deliveries.map((identity) => mediaDeliveryIdentityKey(identity)));
      const allDeliveries = await client.query<SqlRow>(`
        SELECT *,updated_at::text AS updated_at_exact
        FROM ozon_media_deliveries WHERE sku=$1 FOR UPDATE`, [sku]);
      const frozenLedgerAudit = jsonObject(frozenRecovery.ledgerAudit);
      const currentLedgerAudit = targetedRecoveryLedgerAuditFromRows(allDeliveries.rows);
      if (stableJson(currentLedgerAudit) !== stableJson(frozenLedgerAudit)) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'RECOVERY_LEDGER_AUDIT_CHANGED');
      }
      const deliveries = { rows: allDeliveries.rows.filter((row) => String(row.job_id || '') === input.jobId) };
      const actualKeys = new Set(deliveries.rows.map(mediaDeliveryRowKey));
      const expectedByKey = new Map(input.deliveries.map((delivery) => [
        mediaDeliveryIdentityKey(delivery),
        delivery
      ]));
      const frozenDeliveries = Array.isArray(payload.mediaDeliveries) ? payload.mediaDeliveries : [];
      const frozenSnapshots = Array.isArray(frozenRecovery.deliverySnapshots)
        ? frozenRecovery.deliverySnapshots.map((snapshot) => jsonObject(snapshot))
        : [];
      const frozenSnapshotByKey = new Map(frozenSnapshots.map((snapshot) => [
        mediaDeliveryIdentityKey(mediaDeliveryIdentity(snapshot)),
        snapshot
      ]));
      const frozenByKey = new Map(frozenDeliveries.map((delivery) => {
        const deliveryPayload = jsonObject(delivery);
        return [mediaDeliveryIdentityKey(mediaDeliveryIdentity(deliveryPayload)), deliveryPayload];
      }));
      if (expectedKeys.size !== input.deliveries.length
        || actualKeys.size !== expectedKeys.size
        || [...expectedKeys].some((key) => !actualKeys.has(key))
        || deliveries.rows.some((row) => {
          const key = mediaDeliveryRowKey(row);
          const expected = expectedByKey.get(key);
          const frozen = frozenByKey.get(key);
          const frozenSnapshot = frozenSnapshotByKey.get(key);
          return !expected
            || !frozen
            || !frozenSnapshot
            || String(row.updated_at_exact || '') !== String(expected.expectedUpdatedAt || '').trim()
            || String(row.updated_at_exact || '') !== String(frozenSnapshot.updatedAt || '').trim()
            || automaticMediaPayloadHash(row.payload) !== expected.expectedPayloadHash
            || automaticMediaPayloadHash(row.payload) !== String(frozenSnapshot.payloadHash || '')
            || automaticMediaPayloadHash(row.payload) !== automaticMediaPayloadHash(frozen)
            || !isDurablyAcceptedAutomaticMedia(row.payload);
        })
        || frozenSnapshotByKey.size !== expectedKeys.size) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'RECOVERED_DELIVERIES_CHANGED');
      }
      const { recoveryHold: _releasedHold, ...payloadWithoutHold } = payload;
      void _releasedHold;
      const releasedAt = new Date().toISOString();
      const nextPayload = {
        ...payloadWithoutHold,
        recovery: {
          ...jsonObject(payload.recovery),
          releasedAt,
          releasePlatformPreflight: platformPreflight
        }
      };
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET payload=$2::jsonb,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [input.jobId, JSON.stringify(nextPayload)]);
      await addEvent(client, input.jobId, 'ACCEPTED_MEDIA_RECOVERY_RELEASED', 'WAITING_MEDIA', 'WAITING_MEDIA', '定向恢复轮次已通过第二次读回并放行，将进入真实 OZON 上品', {
        releasedAt,
        platformPreflight
      });
      return toJob(updated.rows[0]!);
    });
  }

  async repairReleasedAcceptedAutomaticMediaRecoveryLedger(
    input: OzonAcceptedMediaRecoveryLedgerRepairInput
  ): Promise<OzonPublishJob> {
    assertLegacyAutomaticTaskReadOnly();
    const sku = assertTargetedAcceptedMediaRecoverySku(input.sku);
    const target = OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS[sku as '0000105' | '0000106'];
    const recoveryContract = assertTargetedAcceptedMediaRecoveryContract(
      sku,
      input.recoveryContract,
      [target.retainedMapping.offerId],
      [...target.candidateOfferIds],
      target.deliveryIdentities.map((delivery) => mediaDeliveryIdentity(delivery))
    );
    if (stableJson(input.retainedMappings) !== stableJson([target.retainedMapping])
      || stableJson(normalizeOfferIds(input.candidateOfferIds)) !== stableJson(target.candidateOfferIds)
      || !Number.isSafeInteger(Number(input.expectedLedgerAudit.rowCount))
      || !/^sha256:[a-f0-9]{64}$/.test(String(input.expectedLedgerAudit.hash || ''))) {
      throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_TARGET_INVALID');
    }
    assertTargetedRecoveryPlatformPreflight(
      sku,
      input.platformPreflight,
      input.retainedMappings,
      [...target.candidateOfferIds]
    );
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      await assertNoActivePlatformStatusRefreshLease(client, sku);
      await assertNoActiveTargetedRecoveryExecution(client, sku);
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 AND sku=$2 FOR UPDATE', [input.jobId, sku]);
      const jobRow = jobResult.rows[0];
      const payload = jsonObject(jobRow?.payload);
      const recovery = jsonObject(payload.recovery);
      const hold = jsonObject(payload.recoveryHold);
      if (!jobRow
        || Number(jobRow.row_version) !== input.expectedJobRowVersion
        || String(jobRow.source) !== 'AUTO'
        || String(jobRow.state) !== 'NEEDS_ATTENTION'
        || hold.active === true
        || String(recovery.kind || '') !== 'PREVIOUSLY_ACCEPTED_VARIANT_MEDIA'
        || !String(recovery.releasedAt || '').trim()
        || stableJson(recovery.contract) !== stableJson(recoveryContract)
        || jobRow.task_id || jobRow.import_task_id || jobRow.ozon_product_id
        || jobRow.lease_owner || jobRow.lease_token || jobRow.lease_expires_at
        || String(jobRow.directory_stage || '') !== 'INBOX'
        || jobRow.directory_signature || jobRow.task_folder
        || Number(jobRow.listing_revision || 0) !== 0
        || ozonJobHasLocalGenerationClaim(toJob(jobRow))) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_JOB_INVALID');
      }
      const activeJobs = await client.query<SqlRow>(`
        SELECT id FROM ozon_publish_jobs WHERE sku=$1 AND state=ANY($2::text[]) ORDER BY created_at FOR UPDATE`,
      [sku, ACTIVE_JOB_STATES]);
      if (activeJobs.rows.length !== 1 || String(activeJobs.rows[0]?.id || '') !== input.jobId) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_ACTIVE_JOB_CHANGED');
      }

      const settingsResult = await client.query<SqlRow>('SELECT * FROM ozon_system_settings WHERE id=$1 FOR SHARE', ['default']);
      const settings = settingsResult.rows[0] ? toSettings(settingsResult.rows[0]) : undefined;
      const rootHash = settings
        ? `sha256:${createHash('sha256').update(stableJson(settings.rootDirectory)).digest('hex')}`
        : '';
      if (!settings || !settings.enabled || !settings.credentialReady
        || settings.rowVersion !== input.expectedSettingsRowVersion
        || settings.rowVersion !== recoveryContract.settingsBinding.rowVersion
        || settings.defaultStoreAlias !== recoveryContract.settingsBinding.defaultStoreAlias
        || rootHash !== recoveryContract.settingsBinding.rootDirectoryHash
        || String(jobRow.store_alias || '') !== settings.defaultStoreAlias) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_SETTINGS_CHANGED');
      }
      assertTargetedRecoveryPlatformPreflight(
        sku,
        input.platformPreflight,
        input.retainedMappings,
        [...target.candidateOfferIds],
        settings.defaultStoreAlias
      );
      assertTargetedRecoveryPlatformPreflight(
        sku,
        jsonObject(recovery.releasePlatformPreflight),
        input.retainedMappings,
        [...target.candidateOfferIds],
        settings.defaultStoreAlias,
        false
      );
      const presetResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_listing_presets WHERE FALSE FOR SHARE`);
      const preset = presetResult.rows[0] ? toLegacyPreset(presetResult.rows[0]) : undefined;
      if (!preset || preset.id !== input.expectedPresetId || preset.rowVersion !== input.expectedPresetRowVersion
        || !preset.autoPublishEnabled || preset.autoPublishMode !== 'COMPATIBLE_UPSERT') {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_PRESET_CHANGED');
      }
      const presetBinding = createOzonAutoPresetBinding(preset, preset.autoPublishActivatedAt!);
      if (presetBinding.presetId !== recoveryContract.presetBinding.presetId
        || presetBinding.presetRowVersion !== recoveryContract.presetBinding.presetRowVersion
        || presetBinding.definitionHash !== recoveryContract.presetBinding.definitionHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_PRESET_BINDING_CHANGED');
      }
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR SHARE', [sku]);
      const listing = listingResult.rows[0];
      if (!listing || String(listing.status) !== 'PUBLISHED'
        || Number(listing.row_version) !== input.expectedListingRowVersion) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_LISTING_CHANGED');
      }
      assertTargetedRecoveryListingBinding(sku, listing.data, recoveryContract);
      await assertTargetedRecoveryProductIdentity(client, sku, recoveryContract);
      await assertTargetedAcceptedMediaRecoveryMappings(
        client,
        settings.defaultStoreAlias,
        sku,
        input.retainedMappings,
        [...target.candidateOfferIds]
      );
      const sourceResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 AND sku=$2 FOR SHARE', [
        target.recoveredFromJobId,
        sku
      ]);
      const source = sourceResult.rows[0];
      if (!source
        || Number(source.row_version) !== recoveryContract.sourceJobSnapshot.rowVersion
        || automaticMediaPayloadHash(source.payload) !== recoveryContract.sourceJobSnapshot.payloadHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_SOURCE_CHANGED');
      }

      const allRows = await client.query<SqlRow>(`
        SELECT *,updated_at::text AS updated_at_exact FROM ozon_media_deliveries
        WHERE sku=$1 ORDER BY source_stage_id,submission_id,variant_id FOR UPDATE`, [sku]);
      const observedAudit = targetedRecoveryLedgerAuditFromRows(allRows.rows);
      if (stableJson(observedAudit) !== stableJson(input.expectedLedgerAudit)) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_AUDIT_CHANGED');
      }
      const rowByKey = new Map(allRows.rows.map((row) => [mediaDeliveryRowKey(row), row]));
      const frozenDeliveries = Array.isArray(payload.mediaDeliveries)
        ? payload.mediaDeliveries.map((delivery) => jsonObject(delivery))
        : [];
      const frozenByKey = new Map(frozenDeliveries.map((delivery) => [
        mediaDeliveryIdentityKey(mediaDeliveryIdentity(delivery)),
        delivery
      ]));
      const expectedKeys = target.deliveryIdentities.map(mediaDeliveryIdentityKey);
      if (frozenByKey.size !== expectedKeys.length
        || expectedKeys.some((key) => !frozenByKey.has(key) || !isDurablyAcceptedAutomaticMedia(frozenByKey.get(key)))) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_FROZEN_DELIVERIES_INVALID');
      }
      const targetRows = expectedKeys.map((key) => rowByKey.get(key));
      const alreadyRepaired = targetRows.every((row, index) => Boolean(row)
        && String(row!.job_id || '') === input.jobId
        && automaticMediaPayloadHash(row!.payload) === automaticMediaPayloadHash(frozenByKey.get(expectedKeys[index]!)!));
      if (alreadyRepaired) {
        const frozenLedgerAudit = jsonObject(recovery.ledgerAudit);
        if (stableJson(observedAudit) !== stableJson(frozenLedgerAudit)) {
          throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_IDEMPOTENCY_AUDIT_CHANGED');
        }
        return toJob(jobRow);
      }
      if (targetRows.some((row, index) => !row
        || row.job_id
        || !deferredAutomaticMediaReplayMatchesFrozen(row.payload, frozenByKey.get(expectedKeys[index]!)!, input.jobId))) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_DEFERRED_ROWS_INVALID');
      }

      const repairedSnapshots: Array<Record<string, unknown>> = [];
      for (const key of expectedKeys) {
        const identity = mediaDeliveryIdentity(frozenByKey.get(key)!);
        const frozen = frozenByKey.get(key)!;
        const repaired = await client.query<SqlRow>(`
          UPDATE ozon_media_deliveries
          SET job_id=$5,payload=$6::jsonb,updated_at=NOW()
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4 AND job_id IS NULL
          RETURNING payload,updated_at::text AS updated_at_exact`, [
          sku,
          identity.sourceStageId,
          identity.submissionId,
          identity.variantId,
          input.jobId,
          JSON.stringify(frozen)
        ]);
        if (repaired.rowCount !== 1) {
          throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_DELIVERY_CAS_CHANGED', { identity });
        }
        repairedSnapshots.push({
          ...identity,
          updatedAt: String(repaired.rows[0]!.updated_at_exact),
          payloadHash: automaticMediaPayloadHash(repaired.rows[0]!.payload)
        });
      }
      const repairedAudit = await targetedRecoveryLedgerAudit(client, sku);
      const repairedAt = new Date().toISOString();
      const nextPayload = {
        ...payload,
        recovery: {
          ...recovery,
          deliverySnapshots: repairedSnapshots,
          ledgerAudit: repairedAudit,
          ledgerRepair: {
            schemaVersion: 1,
            repairedAt,
            reason: 'RECONCILIATION_SAME_JOB_DURABLE_BINDING_REGRESSION',
            observedBrokenLedgerAudit: observedAudit,
            repairedDeliveryIdentities: target.deliveryIdentities
          }
        }
      };
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET payload=$2::jsonb,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$3 AND state='NEEDS_ATTENTION' RETURNING *`, [
        input.jobId,
        JSON.stringify(nextPayload),
        input.expectedJobRowVersion
      ]);
      if (updated.rowCount !== 1) throw targetedAcceptedMediaRecoveryConflict(sku, 'LEDGER_REPAIR_JOB_CAS_CHANGED');
      await addEvent(
        client,
        input.jobId,
        'ACCEPTED_MEDIA_RECOVERY_LEDGER_REPAIRED',
        'NEEDS_ATTENTION',
        'NEEDS_ATTENTION',
        '已恢复被 reconciliation 错误解绑的同任务 durable media ledger，任务状态保持不变',
        { repairedAt, deliveryCount: repairedSnapshots.length, ledgerAudit: repairedAudit }
      );
      return toJob(updated.rows[0]!);
    });
  }

  async verifyAcceptedAutomaticMediaRecoveryForWrite(
    input: OzonAcceptedMediaRecoveryWriteGuardInput
  ): Promise<OzonPublishJob> {
    assertLegacyAutomaticTaskReadOnly();
    const preliminary = await this.getJob(input.jobId);
    const sku = assertTargetedAcceptedMediaRecoverySku(preliminary.sku);
    const target = OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS[sku as '0000105' | '0000106'];
    return this.transaction(async (client) => {
      await lockSkuJob(client, sku);
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 AND sku=$2 FOR UPDATE', [input.jobId, sku]);
      const jobRow = jobResult.rows[0];
      const payload = jsonObject(jobRow?.payload);
      const recovery = jsonObject(payload.recovery);
      const hold = jsonObject(payload.recoveryHold);
      const contract = assertTargetedAcceptedMediaRecoveryContract(
        sku,
        jsonObject(recovery.contract) as OzonAcceptedMediaRecoveryContract,
        [target.retainedMapping.offerId],
        [...target.candidateOfferIds],
        target.deliveryIdentities.map((delivery) => mediaDeliveryIdentity(delivery))
      );
      if (!jobRow
        || Number(jobRow.row_version) !== input.expectedJobRowVersion
        || String(jobRow.source) !== 'AUTO'
        || String(jobRow.state) !== 'READY'
        || hold.active === true
        || String(recovery.kind || '') !== 'PREVIOUSLY_ACCEPTED_VARIANT_MEDIA'
        || String(input.manifestSignature || '').trim().toLowerCase() !== contract.manifestSignature
        || jobRow.lease_owner || jobRow.lease_token || jobRow.lease_expires_at
        || jobRow.task_id || jobRow.import_task_id || jobRow.ozon_product_id) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_JOB_CHANGED');
      }

      const settingsResult = await client.query<SqlRow>('SELECT * FROM ozon_system_settings WHERE id=$1 FOR SHARE', ['default']);
      const settings = settingsResult.rows[0] ? toSettings(settingsResult.rows[0]) : undefined;
      const settingsRootHash = settings
        ? `sha256:${createHash('sha256').update(stableJson(settings.rootDirectory)).digest('hex')}`
        : '';
      if (!settings || !settings.enabled || !settings.credentialReady
        || settings.rowVersion !== contract.settingsBinding.rowVersion
        || settings.defaultStoreAlias !== contract.settingsBinding.defaultStoreAlias
        || settings.rootDirectory !== settings.rootDirectory.trim()
        || settingsRootHash !== contract.settingsBinding.rootDirectoryHash
        || String(jobRow.store_alias || '') !== settings.defaultStoreAlias) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_SETTINGS_CHANGED');
      }
      const presetResult = await client.query<SqlRow>(`
        SELECT * FROM ozon_listing_presets WHERE FALSE FOR SHARE`);
      const preset = presetResult.rows[0] ? toLegacyPreset(presetResult.rows[0]) : undefined;
      if (!preset || !preset.autoPublishEnabled || preset.autoPublishMode !== 'COMPATIBLE_UPSERT') {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_PRESET_CHANGED');
      }
      const presetBinding = createOzonAutoPresetBinding(preset, preset.autoPublishActivatedAt!);
      if (presetBinding.presetId !== contract.presetBinding.presetId
        || presetBinding.presetRowVersion !== contract.presetBinding.presetRowVersion
        || presetBinding.definitionHash !== contract.presetBinding.definitionHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_PRESET_CHANGED');
      }
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR SHARE', [sku]);
      const listing = listingResult.rows[0];
      if (!listing || !['PUBLISHED', 'READY'].includes(String(listing.status))
        || Number(listing.row_version) !== input.expectedListingRowVersion) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_LISTING_CHANGED');
      }
      assertTargetedRecoveryListingBinding(sku, listing.data, contract);
      await assertTargetedRecoveryProductIdentity(client, sku, contract);
      await assertTargetedAcceptedMediaRecoveryMappings(
        client,
        settings.defaultStoreAlias,
        sku,
        [target.retainedMapping],
        [...target.candidateOfferIds]
      );
      const sourceResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 AND sku=$2 FOR SHARE', [
        target.recoveredFromJobId,
        sku
      ]);
      const source = sourceResult.rows[0];
      if (!source
        || Number(source.row_version) !== contract.sourceJobSnapshot.rowVersion
        || automaticMediaPayloadHash(source.payload) !== contract.sourceJobSnapshot.payloadHash) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_SOURCE_CHANGED');
      }

      const frozenSnapshots = Array.isArray(recovery.deliverySnapshots)
        ? recovery.deliverySnapshots.map((snapshot) => jsonObject(snapshot))
        : [];
      const frozenSnapshotByKey = new Map(frozenSnapshots.map((snapshot) => [
        mediaDeliveryIdentityKey(mediaDeliveryIdentity(snapshot)),
        snapshot
      ]));
      const frozenDeliveries = Array.isArray(payload.mediaDeliveries)
        ? payload.mediaDeliveries.map((delivery) => jsonObject(delivery))
        : [];
      const frozenDeliveryByKey = new Map(frozenDeliveries.map((delivery) => [
        mediaDeliveryIdentityKey(mediaDeliveryIdentity(delivery)),
        delivery
      ]));
      const allDeliveryRows = await client.query<SqlRow>(`
        SELECT *,updated_at::text AS updated_at_exact
        FROM ozon_media_deliveries WHERE sku=$1 FOR UPDATE`, [sku]);
      const frozenLedgerAudit = jsonObject(recovery.ledgerAudit);
      const currentLedgerAudit = targetedRecoveryLedgerAuditFromRows(allDeliveryRows.rows);
      if (stableJson(currentLedgerAudit) !== stableJson(frozenLedgerAudit)) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_LEDGER_AUDIT_CHANGED');
      }
      const deliveryRows = { rows: allDeliveryRows.rows.filter((row) => String(row.job_id || '') === input.jobId) };
      const expectedKeys = new Set(target.deliveryIdentities.map(mediaDeliveryIdentityKey));
      if (deliveryRows.rows.length !== expectedKeys.size
        || frozenSnapshotByKey.size !== expectedKeys.size
        || frozenDeliveryByKey.size !== expectedKeys.size
        || deliveryRows.rows.some((row) => {
          const key = mediaDeliveryRowKey(row);
          const snapshot = frozenSnapshotByKey.get(key);
          const frozen = frozenDeliveryByKey.get(key);
          return !expectedKeys.has(key)
            || !snapshot
            || !frozen
            || String(row.updated_at_exact || '') !== String(snapshot.updatedAt || '')
            || automaticMediaPayloadHash(row.payload) !== String(snapshot.payloadHash || '')
            || automaticMediaPayloadHash(row.payload) !== automaticMediaPayloadHash(frozen)
            || !isDurablyAcceptedAutomaticMedia(row.payload);
        })) {
        throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_DELIVERIES_CHANGED');
      }

      const existingGuard = jsonObject(recovery.writeGuard);
      const verifiedAt = new Date().toISOString();
      const nextPayload = {
        ...payload,
        recovery: {
          ...recovery,
          writeGuard: {
            verified: true,
            verifiedAt,
            sequence: Math.max(0, Number(existingGuard.sequence || 0)) + 1,
            generationFence: randomUUID(),
            expectedJobRowVersion: input.expectedJobRowVersion,
            listingRowVersion: Number(listing.row_version),
            manifestSignature: contract.manifestSignature,
            deliverySnapshotHash: automaticMediaPayloadHash(frozenSnapshots)
          }
        }
      };
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_publish_jobs
        SET payload=$2::jsonb,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$3 RETURNING *`, [input.jobId, JSON.stringify(nextPayload), input.expectedJobRowVersion]);
      if (updated.rowCount !== 1) throw targetedAcceptedMediaRecoveryConflict(sku, 'WRITE_GUARD_CAS_CHANGED');
      return toJob(updated.rows[0]!);
    });
  }

  async listDeferredAutomaticMediaDeliveries(limitInput = 200): Promise<OzonDeferredAutomaticMediaDelivery[]> {
    const limit = Math.min(1_000, Math.max(1, Math.floor(Number(limitInput) || 200)));
    const result = await this.query<SqlRow>(`
      SELECT delivery.sku,delivery.source_stage_id,delivery.submission_id,delivery.variant_id,delivery.payload
      FROM ozon_media_deliveries delivery
      LEFT JOIN ozon_publish_jobs job ON job.id=delivery.job_id
      WHERE (
        delivery.job_id IS NULL AND delivery.payload->>'autoPublishDecision' IN ('DEFERRED','ACCEPTED')
      ) OR (
        delivery.job_id IS NOT NULL
        AND COALESCE(delivery.payload->>'autoPublishDecision','') NOT IN ('IGNORED','CONSUMED_REMOTE','FANNED_OUT')
        AND (
          job.id IS NULL OR job.source<>'AUTO' OR job.state NOT IN ('WAITING_MEDIA','READY')
          OR job.lease_owner IS NOT NULL OR job.lease_token IS NOT NULL OR job.lease_expires_at IS NOT NULL
          OR job.task_id IS NOT NULL OR job.import_task_id IS NOT NULL OR job.directory_signature IS NOT NULL
          OR COALESCE(job.listing_revision,0)>0
          OR jsonb_array_length(CASE WHEN jsonb_typeof(job.offer_ids)='array' THEN job.offer_ids ELSE '[]'::jsonb END)>0
          OR COALESCE(job.payload ?| ARRAY[
            'mediaSignature','autoPreparedByJobId','autoPreparedListingRevision','autoPreparedDispatchMetadata',
            'materialSnapshot','productJsonGenerated','revision','offerIds','expectedOfferIds','submittedOfferIds',
            'publishOfferIds','importIntent','importTaskId'
          ],false)
        )
      )
      ORDER BY delivery.received_at ASC,delivery.sku ASC,delivery.source_stage_id ASC,
        delivery.submission_id ASC,delivery.variant_id ASC
      LIMIT $1`, [limit]);
    return result.rows.flatMap((row) => {
      const sourceStageId = String(row.source_stage_id || '').trim();
      if (sourceStageId !== 'E004' && sourceStageId !== 'E005') return [];
      return [{
        sku: String(row.sku || '').trim(),
        sourceStageId,
        submissionId: String(row.submission_id || '').trim(),
        variantId: String(row.variant_id || '').trim(),
        payload: jsonObject(row.payload)
      }];
    });
  }

  async resolveAutomaticMediaDeliveryEvidence(input: {
    sku: string;
    identities: Array<{ sourceStageId: string; submissionId: string; variantId?: string }>;
  }): Promise<OzonAutomaticMediaDeliveryEvidence[]> {
    const sku = normalizeSku(input.sku);
    const identities = input.identities.map((identity) => mediaDeliveryIdentity(identity));
    const identityKeys = identities.map(mediaDeliveryIdentityKey);
    if (!identities.length || new Set(identityKeys).size !== identities.length) {
      throw new AppError('CONFIG_INVALID', 'OZON 冻结媒体投递身份为空或重复', { sku }, 409);
    }
    const values: unknown[] = [sku];
    const predicates = identities.map((identity) => {
      values.push(identity.sourceStageId, identity.submissionId, identity.variantId);
      const offset = values.length - 2;
      return `(source_stage_id=$${offset} AND submission_id=$${offset + 1} AND variant_id=$${offset + 2})`;
    });
    const result = await this.query<SqlRow>(`
      SELECT source_stage_id,submission_id,variant_id,job_id,payload,updated_at
      FROM ozon_media_deliveries
      WHERE sku=$1 AND (${predicates.join(' OR ')})`, values);
    const rows = new Map(result.rows.map((row) => [mediaDeliveryRowKey(row), row]));
    return identities.map((identity) => {
      const key = mediaDeliveryIdentityKey(identity);
      const row = rows.get(key);
      const payload = jsonObject(row?.payload);
      const deliveredAtValue = String(payload.deliveredAt || '').trim();
      const deliveredAt = Date.parse(deliveredAtValue);
      const decision = String(payload.autoPublishDecision || '').trim().toUpperCase();
      if (!row
        || !sameMediaDeliveryIdentity(payload, identity)
        || !Number.isFinite(deliveredAt)
        || !['ACCEPTED', 'DEFERRED', 'FANNED_OUT'].includes(decision)) {
        throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '冻结商品资料引用的媒体投递账本缺失或已变化', {
          sku,
          sourceStageId: identity.sourceStageId,
          submissionId: identity.submissionId,
          variantId: identity.variantId,
          decision: decision || undefined
        }, 409);
      }
      return {
        sourceStageId: identity.sourceStageId as 'E004' | 'E005',
        submissionId: identity.submissionId,
        variantId: identity.variantId,
        deliveredAt: new Date(deliveredAt).toISOString(),
        decision: decision as OzonAutomaticMediaDeliveryEvidence['decision'],
        ...(row.job_id ? { jobId: String(row.job_id) } : {}),
        payloadHash: automaticMediaPayloadHash(payload),
        updatedAt: new Date(row.updated_at).toISOString()
      };
    });
  }

  async transitionJob(id: string, input: OzonJobTransitionInput): Promise<OzonPublishJob> {
    return this.transaction((client) => this.transitionJobWithClient(client, id, input));
  }

  async recordN8nUpdate(
    id: string,
    input: OzonRuntimeUpdateInput
  ): Promise<{ job: OzonPublishJob; mappings: OzonProductMapping[]; mapping?: OzonProductMapping }> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [id]);
      const current = currentResult.rows[0];
      if (!current) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      if (Number(current.row_version) !== input.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id }, 409);
      }
      const frozenRuntime = assertFrozenOzonPublicationRuntimeInput(current, input);
      if (input.eventType === OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT) {
        try {
          const listingResult = await client.query<SqlRow>(
            'SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE',
            [current.sku]
          );
          if (!listingResult.rows[0]) {
            throw new Error('OZON_RFBS_STOCK_LISTING_MISSING');
          }
          const authorityOfferIds = normalizeOfferIds(current.offer_ids || current.payload?.expectedOfferIds);
          const mappingResult = authorityOfferIds.length
            ? await client.query<SqlRow>(`
                SELECT * FROM ozon_product_mappings
                WHERE store_alias=$1 AND offer_id=ANY($2::text[])
                ORDER BY array_position($2::text[],offer_id)
                FOR SHARE`,
              [current.store_alias, authorityOfferIds])
            : { rows: [] as SqlRow[] };
          assertOzonRfbsStockNormalizationAttestation({
            job: toJob(current),
            listing: toListing(listingResult.rows[0]),
            mappings: mappingResult.rows.map(toProductMapping)
          }, input);
        } catch (error) {
          throw new AppError('CONFIG_INVALID', 'OZON RFBS 聚合库存成功回写缺少同轮 P002 原始读回证明', {
            id,
            reason: error instanceof Error ? error.message : String(error || '')
          }, 409);
        }
      } else if (input.rfbsStockReadbackAttestation !== undefined) {
        throw new AppError('CONFIG_INVALID', 'OZON RFBS 聚合库存证明只能用于受控成功事件', { id }, 409);
      }

      const legacyMapping = normalizeProductMappingInput({
        offerId: input.offerId || current.offer_id,
        ozonProductId: input.ozonProductId,
        ozonSku: input.ozonSku,
        warehouseId: input.warehouseId,
        platformStatus: input.platformStatus
      });
      const mappingInputs = dedupeProductMappingInputs([
        ...(Array.isArray(input.productMappings) ? input.productMappings : []),
        ...(legacyMapping ? [legacyMapping] : [])
      ]).map((mapping) => frozenRuntime ? { ...mapping, warehouseId: frozenRuntime.warehouseId } : mapping);
      const declaredOfferIds = normalizeOfferIds(
        input.offerIds
        || input.jobPayload?.offerIds
        || current.offer_ids
        || current.payload?.offerIds
      );
      const offerContract = assertOzonOfferContractTransition(
        jsonObject(current.payload),
        sanitizePersistentJobPayload(input.jobPayload),
        input.offerIds || input.jobPayload?.offerIds
      );
      const expectedOfferIds = offerContract?.expectedOfferIds.length
        ? offerContract.expectedOfferIds
        : declaredOfferIds.length
          ? declaredOfferIds
        : mappingInputs.map((mapping) => mapping.offerId);
      const currentPayload = jsonObject(current.payload);
      const compatibleAppend = String(current.source) === 'MANUAL'
        && String(currentPayload.mode || '') === 'COMPATIBLE_APPEND';
      const compatibleSubmittedOfferIds = compatibleAppend
        ? normalizeOfferIds(currentPayload.submittedOfferIds)
        : [];
      const compatibleSubmittedSet = new Set(compatibleSubmittedOfferIds);
      const compatiblePreservedOfferIds = compatibleAppend
        ? normalizeOfferIds(currentPayload.preservedOfferIds).length
          ? normalizeOfferIds(currentPayload.preservedOfferIds)
          : expectedOfferIds.filter((offerId) => !compatibleSubmittedSet.has(offerId))
        : [];
      if (input.state === 'SUCCEEDED') {
        const mappedOffers = new Set(mappingInputs
          .filter((mapping) => /^\d+$/.test(mapping.ozonProductId) && /^\d+$/.test(String(mapping.ozonSku || '')))
          .map((mapping) => mapping.offerId));
        const missingOfferIds = expectedOfferIds.filter((offerId) => !mappedOffers.has(offerId));
        const unexpectedOfferIds = [...mappedOffers].filter((offerId) => !expectedOfferIds.includes(offerId));
        if (!expectedOfferIds.length || missingOfferIds.length || unexpectedOfferIds.length) {
          throw new AppError(
            'CONFIG_INVALID',
            'OZON 成功状态必须同时回写全部变体的内部商品 ID 和前台 OZON SKU',
            { jobId: id, expectedOfferIds, missingOfferIds, unexpectedOfferIds },
            409
          );
        }
      }

      let automaticSuccessConsumption: {
        publishOfferIds: string[];
        deliveries: Array<{
          sourceStageId: 'E004' | 'E005';
          submissionId: string;
          variantId: string;
          representedOfferIds: string[];
          payload: Record<string, unknown>;
        }>;
      } | undefined;
      if (input.state === 'SUCCEEDED' && String(current.source) === 'AUTO') {
        const rawDeliveries = Array.isArray(currentPayload.mediaDeliveries)
          ? currentPayload.mediaDeliveries
          : [];
        if (rawDeliveries.length) {
          if (!offerContract) {
            throw new AppError('CONFIG_INVALID', 'OZON 自动任务成功回写缺少冻结 Offer 合同，媒体账本未消费', {
              jobId: id
            }, 409);
          }
          const publishOfferIds = offerContract.publishOfferIds;
          const completeMappings = new Set(mappingInputs
            .filter((mapping) => /^\d+$/.test(mapping.ozonProductId) && /^\d+$/.test(String(mapping.ozonSku || '')))
            .map((mapping) => mapping.offerId));
          const missingPublishMappings = publishOfferIds.filter((offerId) => !completeMappings.has(offerId));
          if (!publishOfferIds.length || missingPublishMappings.length) {
            throw new AppError('CONFIG_INVALID', 'OZON 自动任务成功回写缺少全部发布 Offer 映射，媒体账本未消费', {
              jobId: id,
              publishOfferIds,
              missingPublishMappings
            }, 409);
          }
          const listingResult = await client.query<SqlRow>(
            'SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE',
            [current.sku]
          );
          const listing = listingResult.rows[0];
          if (!listing) throw new AppError('NOT_FOUND', 'OZON 上品资料不存在', { sku: current.sku }, 404);
          const offers: Record<string, unknown>[] = Array.isArray(listing.data?.offers)
            ? listing.data.offers.map((offer: unknown) => jsonObject(offer))
            : [];
          const offerIdsByVariant = new Map<string, string[]>();
          for (const offerId of publishOfferIds) {
            const matches = offers.filter((offer) => String(offer.offerId || '').trim() === offerId);
            const variantId = String(matches[0]?.productVariantId || matches[0]?.variantId || '').trim();
            if (matches.length !== 1 || !variantId) {
              throw new AppError('CONFIG_INVALID', 'OZON 自动任务的发布 Offer 无法唯一反查变体，媒体账本未消费', {
                jobId: id,
                offerId,
                matchCount: matches.length
              }, 409);
            }
            const representedOfferIds = offerIdsByVariant.get(variantId) || [];
            representedOfferIds.push(offerId);
            offerIdsByVariant.set(variantId, representedOfferIds);
          }
          const deliveries = rawDeliveries.map((deliveryInput) => {
            const payload = jsonObject(deliveryInput);
            const identity = mediaDeliveryIdentity(payload);
            const representedOfferIds = offerIdsByVariant.get(identity.variantId) || [];
            if (!identity.variantId
              || !representedOfferIds.length
              || String(payload.autoPublishDecision || '') !== 'ACCEPTED'
              || !isDurablyAcceptedAutomaticMedia(payload)) {
              throw new AppError('CONFIG_INVALID', 'OZON 自动任务媒体投递与冻结发布变体或接受凭证不一致', {
                jobId: id,
                identity,
                representedOfferIds
              }, 409);
            }
            return {
              sourceStageId: identity.sourceStageId as 'E004' | 'E005',
              submissionId: identity.submissionId,
              variantId: identity.variantId,
              representedOfferIds,
              payload
            };
          });
          const deliveryKeys = deliveries.map(mediaDeliveryIdentityKey);
          if (new Set(deliveryKeys).size !== deliveries.length) {
            throw new AppError('CONFIG_INVALID', 'OZON 自动任务媒体投递四元组重复', {
              jobId: id,
              duplicateDeliveryCount: deliveries.length - new Set(deliveryKeys).size
            }, 409);
          }
          for (const delivery of deliveries) {
            const locked = await client.query<SqlRow>(`
              SELECT * FROM ozon_media_deliveries
              WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
              FOR UPDATE`,
            [current.sku, delivery.sourceStageId, delivery.submissionId, delivery.variantId]);
            const row = locked.rows[0];
            if (locked.rows.length !== 1
              || String(row?.job_id || '') !== String(current.id)
              || stableJson(jsonObject(row?.payload)) !== stableJson(delivery.payload)) {
              throw new AppError('TASK_LOCKED', 'OZON 自动任务目标媒体账本身份、归属或内容已变化', {
                jobId: id,
                delivery: {
                  sourceStageId: delivery.sourceStageId,
                  submissionId: delivery.submissionId,
                  variantId: delivery.variantId
                }
              }, 409);
            }
          }
          automaticSuccessConsumption = { publishOfferIds, deliveries };
        }
      }

      let compatibleAppendConsumption: {
        submittedOfferIds: string[];
        deliveries: Array<{
          sourceStageId: 'E004' | 'E005';
          submissionId: string;
          variantId: string;
          representedOfferIds: string[];
        }>;
      } | undefined;
      if (input.state === 'SUCCEEDED'
        && compatibleAppend) {
        const submittedOfferIds = compatibleSubmittedOfferIds;
        const completeMappings = new Map(mappingInputs
          .filter((mapping) => /^\d+$/.test(mapping.ozonProductId) && /^\d+$/.test(String(mapping.ozonSku || '')))
          .map((mapping) => [mapping.offerId, mapping]));
        const missingSubmittedMappings = submittedOfferIds.filter((offerId) => !completeMappings.has(offerId));
        if (!submittedOfferIds.length || missingSubmittedMappings.length) {
          throw new AppError('CONFIG_INVALID', 'OZON 兼容追加成功回写缺少全部新增 Offer 映射，媒体账本未消费', {
            jobId: id,
            submittedOfferIds,
            missingSubmittedMappings
          }, 409);
        }
        const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [current.sku]);
        const listing = listingResult.rows[0];
        if (!listing) throw new AppError('NOT_FOUND', 'OZON 上品资料不存在', { sku: current.sku }, 404);
        const offers: Record<string, unknown>[] = Array.isArray(listing.data?.offers)
          ? listing.data.offers.map((offer: unknown) => jsonObject(offer))
          : [];
        const mediaAssets: Record<string, unknown>[] = Array.isArray(listing.data?.mediaAssets)
          ? listing.data.mediaAssets.map((asset: unknown) => jsonObject(asset))
          : [];
        const mediaAssetById = new Map<string, Record<string, unknown>>(
          mediaAssets.map((asset): [string, Record<string, unknown>] => [String(asset.assetId || '').trim(), asset])
        );
        const deliveryByKey = new Map<string, {
          sourceStageId: 'E004' | 'E005';
          submissionId: string;
          variantId: string;
          representedOfferIds: string[];
        }>();
        for (const offerId of submittedOfferIds) {
          const matches = offers.filter((offer) => String(offer.offerId || '').trim() === offerId);
          const variantId = String(matches[0]?.productVariantId || matches[0]?.variantId || '').trim();
          if (matches.length !== 1 || !variantId) {
            throw new AppError('CONFIG_INVALID', 'OZON 兼容追加的新增 Offer 无法唯一反查变体，媒体账本未消费', {
              jobId: id,
              offerId,
              matchCount: matches.length
            }, 409);
          }
          const referencedAssetIds = Array.isArray(matches[0]?.media)
            ? (matches[0]!.media as unknown[]).map((media) => String(jsonObject(media).assetId || '').trim()).filter(Boolean)
            : [];
          const referencedDeliveries = referencedAssetIds.flatMap((assetId) => {
            const asset = mediaAssetById.get(assetId);
            const sourceStageId = String(asset?.sourceStageId || '').trim();
            const submissionId = String(asset?.sourceSubmissionId || '').trim();
            const productVariantId = String(asset?.productVariantId || '').trim();
            if (!asset || !['E004', 'E005'].includes(sourceStageId) || !submissionId || productVariantId !== variantId) return [];
            return [{
              sourceStageId: sourceStageId as 'E004' | 'E005',
              submissionId,
              variantId
            }];
          });
          const stages = new Set(referencedDeliveries.map((delivery) => delivery.sourceStageId));
          if (!referencedDeliveries.length || !stages.has('E004') || !stages.has('E005')) {
            throw new AppError('CONFIG_INVALID', 'OZON 兼容追加的新增 Offer 缺少可精确绑定的 E004/E005 媒体账本身份', {
              jobId: id,
              offerId,
              variantId
            }, 409);
          }
          for (const delivery of referencedDeliveries) {
            const key = mediaDeliveryIdentityKey(delivery);
            const currentDelivery = deliveryByKey.get(key);
            if (currentDelivery) {
              if (!currentDelivery.representedOfferIds.includes(offerId)) currentDelivery.representedOfferIds.push(offerId);
            } else {
              deliveryByKey.set(key, { ...delivery, representedOfferIds: [offerId] });
            }
          }
        }
        const deliveries = [...deliveryByKey.values()];
        for (const delivery of deliveries) {
          const locked = await client.query<SqlRow>(`
            SELECT * FROM ozon_media_deliveries
            WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
            FOR UPDATE`,
          [current.sku, delivery.sourceStageId, delivery.submissionId, delivery.variantId]);
          if (locked.rows.length !== 1) {
            throw new AppError('TASK_LOCKED', 'OZON 兼容追加的目标媒体账本身份已变化，拒绝消费历史投递', {
              jobId: id,
              delivery
            }, 409);
          }
        }
        compatibleAppendConsumption = { submittedOfferIds, deliveries };
      }

      // store_id/store_alias are one frozen DB identity. Never allow a runtime
      // callback to pair the frozen store_id with a caller-controlled alias.
      const storeId = String(current.store_id || '').trim();
      const storeAlias = String(current.store_alias || '').trim();
      if (!storeAlias) throw new AppError('CONFIG_INVALID', 'OZON 任务缺少绑定店铺标识', { jobId: id }, 409);
      const revision = frozenRuntime?.revision
        ?? Math.max(0, Number(input.lastAppliedRevision || current.payload?.revision || 0));
      const preservedMappingRows = compatibleAppend && compatiblePreservedOfferIds.length
        ? storeId
          ? await client.query<SqlRow>(`
              SELECT * FROM ozon_product_mappings
              WHERE store_id=$1 AND offer_id=ANY($2::text[])
              FOR SHARE`,
            [storeId, compatiblePreservedOfferIds])
          : await client.query<SqlRow>(`
              SELECT * FROM ozon_product_mappings
              WHERE store_alias=$1 AND offer_id=ANY($2::text[])
              FOR SHARE`,
            [storeAlias, compatiblePreservedOfferIds])
        : { rows: [] as SqlRow[] };
      if (compatibleAppend) {
        const persistedByOffer = new Map(preservedMappingRows.rows.map((row) => [String(row.offer_id), row]));
        const evidenceByOffer = new Map(mappingInputs.map((mapping) => [mapping.offerId, mapping]));
        const invalidPreservedMappings = compatiblePreservedOfferIds.filter((offerId) => {
          const persisted = persistedByOffer.get(offerId);
          const evidence = evidenceByOffer.get(offerId);
          return !persisted
            || String(persisted.sku || '') !== String(current.sku)
            || (input.state === 'SUCCEEDED' && (!evidence
              || String(evidence.ozonProductId || '') !== String(persisted.ozon_product_id || '')
              || String(evidence.ozonSku || '') !== String(persisted.ozon_sku || '')));
        });
        const unexpectedPreservedEvidence = mappingInputs
          .filter((mapping) => !compatibleSubmittedSet.has(mapping.offerId)
            && !compatiblePreservedOfferIds.includes(mapping.offerId))
          .map((mapping) => mapping.offerId);
        if (invalidPreservedMappings.length || unexpectedPreservedEvidence.length) {
          throw new AppError('TASK_LOCKED', 'OZON 兼容追加的既有平台映射已变化，拒绝合并成功回写', {
            jobId: id,
            invalidPreservedMappings,
            unexpectedPreservedEvidence
          }, 409);
        }
      }
      const mappingInputsToUpsert = compatibleAppend
        ? mappingInputs.filter((mapping) => compatibleSubmittedSet.has(mapping.offerId))
        : mappingInputs;
      const mappingByOffer = new Map<string, OzonProductMapping>(
        preservedMappingRows.rows.map((row) => [String(row.offer_id), toProductMapping(row)])
      );
      for (const mappingInput of mappingInputsToUpsert) {
        const mappingResult = storeId
          ? await client.query<SqlRow>(`
              INSERT INTO ozon_product_mappings(
                store_id,store_alias,offer_id,sku,ozon_product_id,ozon_sku,warehouse_id,last_applied_revision,status,status_snapshot,last_verified_at,updated_at
              )
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW(),NOW())
              ON CONFLICT(store_id,offer_id) DO UPDATE SET
                sku=EXCLUDED.sku,
                ozon_product_id=COALESCE(EXCLUDED.ozon_product_id,ozon_product_mappings.ozon_product_id),
                ozon_sku=COALESCE(EXCLUDED.ozon_sku,ozon_product_mappings.ozon_sku),
                warehouse_id=COALESCE(EXCLUDED.warehouse_id,ozon_product_mappings.warehouse_id),
                last_applied_revision=GREATEST(ozon_product_mappings.last_applied_revision,EXCLUDED.last_applied_revision),
                status=EXCLUDED.status,
                status_snapshot=CASE
                  WHEN $11 THEN EXCLUDED.status_snapshot
                  ELSE ozon_product_mappings.status_snapshot
                END,
                last_verified_at=NOW(),
                updated_at=NOW()
              RETURNING *`,
            [
              storeId,
              storeAlias,
              mappingInput.offerId,
              current.sku,
              mappingInput.ozonProductId,
              mappingInput.ozonSku || null,
              mappingInput.warehouseId || null,
              revision,
              mappingInput.platformStatus || input.platformStatus || input.state,
              JSON.stringify(mappingInput.statusSnapshot || {}),
              Boolean(mappingInput.statusSnapshot)
            ])
          : await client.query<SqlRow>(`
              INSERT INTO ozon_product_mappings(
                store_alias,offer_id,sku,ozon_product_id,ozon_sku,warehouse_id,last_applied_revision,status,status_snapshot,last_verified_at,updated_at
              )
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW(),NOW())
              ON CONFLICT(store_alias,offer_id) DO UPDATE SET
                sku=EXCLUDED.sku,
                ozon_product_id=COALESCE(EXCLUDED.ozon_product_id,ozon_product_mappings.ozon_product_id),
                ozon_sku=COALESCE(EXCLUDED.ozon_sku,ozon_product_mappings.ozon_sku),
                warehouse_id=COALESCE(EXCLUDED.warehouse_id,ozon_product_mappings.warehouse_id),
                last_applied_revision=GREATEST(ozon_product_mappings.last_applied_revision,EXCLUDED.last_applied_revision),
                status=EXCLUDED.status,
                status_snapshot=CASE
                  WHEN $10 THEN EXCLUDED.status_snapshot
                  ELSE ozon_product_mappings.status_snapshot
                END,
                last_verified_at=NOW(),
                updated_at=NOW()
              RETURNING *`,
            [
              storeAlias,
              mappingInput.offerId,
              current.sku,
              mappingInput.ozonProductId,
              mappingInput.ozonSku || null,
              mappingInput.warehouseId || null,
              revision,
              mappingInput.platformStatus || input.platformStatus || input.state,
              JSON.stringify(mappingInput.statusSnapshot || {}),
              Boolean(mappingInput.statusSnapshot)
            ]);
        mappingByOffer.set(mappingInput.offerId, toProductMapping(mappingResult.rows[0]!));
      }
      const mappings = expectedOfferIds
        .map((offerId) => mappingByOffer.get(offerId))
        .filter((mapping): mapping is OzonProductMapping => Boolean(mapping));
      const linkMappingInputs = compatibleAppend ? mappingInputsToUpsert : mappingInputs;
      const productLinks = orderProductLinks(normalizeProductLinks([
        ...normalizeProductLinks(current.product_links),
        ...linkMappingInputs
      ]), expectedOfferIds);
      const job = await this.transitionJobWithClient(client, id, {
        ...input,
        storeAlias,
        offerIds: expectedOfferIds.length ? expectedOfferIds : mappingInputs.map((mapping) => mapping.offerId),
        ozonProductId: input.ozonProductId || mappingInputsToUpsert[0]?.ozonProductId
      }, productLinks);
      const listingStatus = listingStatusForJob(input.state);
      if (listingStatus && !current.publication_id) {
        await client.query(`
          UPDATE ozon_listing_drafts
          SET status=$2,last_error_code=$3,last_error_message=$4,row_version=row_version+1,updated_at=NOW()
          WHERE sku=$1`,
        [job.sku, listingStatus, input.errorCode || null, input.errorMessage || null]);
      }
      if (current.publication_id) {
        const publicationStatus = input.state === 'SUCCEEDED' ? 'SUCCEEDED'
          : input.state === 'FAILED' ? 'FAILED'
            : input.state === 'CANCELLED' ? 'CANCELLED'
              : input.state === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION'
                : ['WAITING_MEDIA', 'READY'].includes(input.state) ? 'QUEUED' : 'RUNNING';
        await client.query(`UPDATE ozon_store_publications SET
          status=$2,result_json=$3::jsonb,
          product_ids=$4::jsonb,ozon_skus=$5::jsonb,product_links=$6::jsonb,
          error_code=$7,error_message=$8,
          completed_at=CASE WHEN $2=ANY(ARRAY['SUCCEEDED','FAILED','CANCELLED']::text[])
            THEN COALESCE(completed_at,NOW()) ELSE NULL END,
          row_version=row_version+1,updated_at=NOW()
          WHERE id=$1`, [
          current.publication_id, publicationStatus,
          JSON.stringify({ jobId: job.id, state: input.state, updatedBy: 'runtime-transition' }),
          JSON.stringify(normalizeOfferIds(linkMappingInputs.map((link) => link.ozonProductId))),
          JSON.stringify(normalizeOfferIds(linkMappingInputs.map((link) => link.ozonSku))),
          JSON.stringify(normalizeProductLinks(productLinks).map((link) => link.url).filter(Boolean)),
          input.errorCode || '', input.errorMessage || ''
        ]);
      }
      if (automaticSuccessConsumption) {
        const consumedAt = new Date().toISOString();
        for (const delivery of automaticSuccessConsumption.deliveries) {
          const consumed = await client.query(`
            UPDATE ozon_media_deliveries
            SET payload=(payload
                  - 'autoPublishDeferredReason' - 'autoPublishDeferredAt'
                  - 'autoPublishIgnoredReason' - 'autoPublishIgnoredAt'
                  - 'blockingJobId' - 'blockingJobState')
                || jsonb_build_object(
                  'autoPublishDecision','CONSUMED_REMOTE',
                  'autoPublishConsumedAt',$6::text,
                  'representedOfferIds',$7::jsonb,
                  'consumedByAutomaticJobId',$8::text
                ),
                updated_at=NOW()
            WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
              AND job_id=$5
              AND payload=$9::jsonb
              AND payload->>'autoPublishDecision'='ACCEPTED'
            RETURNING *`,
          [
            job.sku,
            delivery.sourceStageId,
            delivery.submissionId,
            delivery.variantId,
            job.id,
            consumedAt,
            JSON.stringify(delivery.representedOfferIds),
            job.id,
            JSON.stringify(delivery.payload)
          ]);
          if (consumed.rows.length !== 1) {
            throw new AppError('TASK_LOCKED', 'OZON 自动任务目标媒体账本在成功提交时发生变化', {
              jobId: id,
              delivery: {
                sourceStageId: delivery.sourceStageId,
                submissionId: delivery.submissionId,
                variantId: delivery.variantId
              }
            }, 409);
          }
        }
        await addEvent(
          client,
          job.id,
          'AUTO_MEDIA_CONSUMED_REMOTE',
          current.state,
          input.state,
          'OZON 自动任务成功建立完整平台映射，对应媒体账本已原子消费',
          {
            publishOfferIds: automaticSuccessConsumption.publishOfferIds,
            deliveryIdentities: automaticSuccessConsumption.deliveries.map(({ representedOfferIds: _offerIds, payload: _payload, ...delivery }) => delivery),
            consumedAt
          }
        );
      }
      if (compatibleAppendConsumption) {
        const consumedAt = new Date().toISOString();
        for (const delivery of compatibleAppendConsumption.deliveries) {
          const consumed = await client.query(`
            UPDATE ozon_media_deliveries
            SET payload=(payload
                  - 'autoPublishDeferredReason' - 'autoPublishDeferredAt'
                  - 'autoPublishIgnoredReason' - 'autoPublishIgnoredAt'
                  - 'blockingJobId' - 'blockingJobState')
                || jsonb_build_object(
                  'autoPublishDecision','CONSUMED_REMOTE',
                  'autoPublishConsumedAt',$5::text,
                  'representedOfferIds',$6::jsonb,
                  'consumedByManualJobId',$7::text
                ),
                updated_at=NOW()
            WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
              AND COALESCE(payload->>'autoPublishDecision','')<>'CONSUMED_REMOTE'
            RETURNING *`,
          [
            job.sku,
            delivery.sourceStageId,
            delivery.submissionId,
            delivery.variantId,
            consumedAt,
            JSON.stringify(delivery.representedOfferIds),
            job.id
          ]);
          if (consumed.rows.length !== 1) {
            throw new AppError('TASK_LOCKED', 'OZON 兼容追加的目标媒体账本在提交完成时发生变化', {
              jobId: id,
              delivery
            }, 409);
          }
        }
        await addEvent(client, job.id, 'COMPATIBLE_APPEND_MEDIA_CONSUMED_REMOTE', current.state, input.state, '兼容追加的新增 Offer 已完整建立平台映射，对应变体媒体账本已消费', {
          submittedOfferIds: compatibleAppendConsumption.submittedOfferIds,
          deliveryIdentities: compatibleAppendConsumption.deliveries.map(({ representedOfferIds: _offerIds, ...delivery }) => delivery),
          consumedAt
        });
      }
      return { job, mappings, ...(mappings[0] ? { mapping: mappings[0] } : {}) };
    });
  }

  private async transitionJobWithClient(
    client: PoolClient,
    id: string,
    input: OzonJobTransitionInput,
    productLinks?: OzonProductLink[]
  ): Promise<OzonPublishJob> {
    const currentResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [id]);
    const current = currentResult.rows[0];
    if (!current) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
    if (hasActiveAutomaticRecoveryHold(current)) {
      throw new AppError('TASK_LOCKED', 'OZON 定向恢复任务仍处于安全 hold，必须使用专用 release 流程', {
        id,
        sku: String(current.sku || '')
      }, 409);
    }
    if (!current.publication_id && String(current.credential_binding_mode || 'PURE_LEGACY') === 'PURE_LEGACY') {
      await assertNoActivePlatformStatusRefreshLease(client, String(current.sku), id);
    }
    const activeLease = Boolean(
      current.lease_owner
      && current.lease_token
      && current.lease_expires_at
      && Date.parse(String(current.lease_expires_at)) > Date.now()
    );
    const suppliedLeaseOwner = input.leaseOwner === undefined ? undefined : normalizeLeaseOwner(input.leaseOwner);
    const suppliedLeaseToken = input.leaseToken === undefined ? undefined : normalizeLeaseToken(input.leaseToken);
    if (activeLease) {
      if (suppliedLeaseOwner !== String(current.lease_owner) || suppliedLeaseToken !== String(current.lease_token)) {
        throw runtimeLeaseLost(id, input.rowVersion);
      }
    } else if (suppliedLeaseOwner !== undefined || suppliedLeaseToken !== undefined || input.clearLease) {
      throw runtimeLeaseLost(id, input.rowVersion);
    }
    if (Number(current.row_version) !== input.rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id }, 409);
    }
    const frozenRuntime = assertFrozenOzonPublicationRuntimeInput(current, input);
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(input.state);
    const stageStates = { ...(current.stage_states || {}), ...(input.stageStates || {}) };
    const incomingPayload = sanitizePersistentJobPayload(input.jobPayload);
    const offerContract = assertOzonOfferContractTransition(
      jsonObject(current.payload),
      incomingPayload,
      input.offerIds || input.jobPayload?.offerIds
    );
    const jobPayload = input.jobPayload
      ? { ...(current.payload || {}), ...incomingPayload }
      : current.payload || {};
    if (frozenRuntime) {
      Object.assign(jobPayload, {
        taskId: frozenRuntime.taskId,
        storeId: current.store_id,
        storeAlias: frozenRuntime.storeAlias,
        publicationId: current.publication_id,
        credentialVersionId: current.credential_version_id || null,
        credentialBindingMode: current.credential_binding_mode,
        storeConfigVersion: Number(current.store_config_version),
        warehouseId: frozenRuntime.warehouseId,
        offerContractHash: current.offer_contract_hash,
        materializationHash: current.materialization_hash,
        revision: frozenRuntime.revision
      });
    }
    if (input.networkRecovery === null || (
      input.networkRecovery === undefined
      && input.nextAttemptAt === null
      && input.eventType !== 'NETWORK_RETRY_SCHEDULED'
    )) delete jobPayload.networkRecovery;
    else if (input.networkRecovery !== undefined) jobPayload.networkRecovery = input.networkRecovery;
    const offerIds = offerContract?.expectedOfferIds
      || normalizeOfferIds(input.offerIds || input.jobPayload?.offerIds || current.offer_ids || jobPayload.offerIds);
    const storeAlias = frozenRuntime?.storeAlias
      ?? String(input.storeAlias || input.jobPayload?.storeAlias || current.store_alias || '').trim();
    if (!storeAlias) throw new AppError('CONFIG_INVALID', 'OZON 任务缺少绑定店铺标识', { jobId: id }, 409);
    const directoryStage = frozenRuntime?.directoryStage ?? normalizeDirectoryStage(
      input.directoryStage || input.jobPayload?.directoryStage || current.directory_stage
    );
    const workRelPath = frozenRuntime?.workRelPath ?? normalizeOptionalRelativePath(
      input.workRelPath || input.jobPayload?.workRelPath || current.work_rel_path
    );
    const taskFolder = frozenRuntime?.taskFolder
      ?? normalizeTaskFolder(input.taskFolder || input.jobPayload?.taskFolder || current.task_folder);
    const directorySignature = String(
      input.directorySignature
      || input.jobPayload?.directorySignature
      || input.jobPayload?.signature
      || current.directory_signature
      || ''
    ).trim() || undefined;
    const links = productLinks === undefined ? normalizeProductLinks(current.product_links) : normalizeProductLinks(productLinks);
    const releaseLease = Boolean(
      input.clearLease
      || input.nextAttemptAt
      || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_ATTENTION'].includes(input.state)
    );
    const keepLease = activeLease && !releaseLease;
    const result = await client.query<SqlRow>(`
      UPDATE ozon_publish_jobs
      SET state=$2,stage_states=$3::jsonb,task_id=COALESCE($4,task_id),import_task_id=COALESCE($5,import_task_id),
          ozon_product_id=COALESCE($6,ozon_product_id),last_error_code=$7,last_error_message=$8,
          finished_at=CASE WHEN $9 THEN NOW() ELSE NULL END,payload=$10::jsonb,next_attempt_at=$11,
          retry_count=retry_count+CASE WHEN $12 THEN 1 ELSE 0 END,row_version=row_version+1,updated_at=NOW(),
          offer_ids=$13::jsonb,store_alias=$14,task_folder=$15,work_rel_path=$16,directory_stage=$17,
          directory_signature=$18,product_links=$19::jsonb,listing_revision=$20,
          lease_owner=$21,lease_token=$22::uuid,lease_expires_at=$23
      WHERE id=$1 RETURNING *`,
    [
      id, input.state, JSON.stringify(stageStates), frozenRuntime?.taskId || input.taskId || null, input.importTaskId || null,
      input.ozonProductId || null, input.errorCode || null, input.errorMessage || null, terminal,
      JSON.stringify(jobPayload), input.nextAttemptAt === undefined ? current.next_attempt_at : input.nextAttemptAt,
      Boolean(input.incrementRetry), JSON.stringify(offerIds), storeAlias, taskFolder || null, workRelPath || null,
      directoryStage || null, directorySignature || null, JSON.stringify(links),
      frozenRuntime?.revision
        ?? Math.max(0, Number(input.revision || input.jobPayload?.revision || current.listing_revision || 0)),
      keepLease ? current.lease_owner : null,
      keepLease ? current.lease_token : null,
      keepLease ? current.lease_expires_at : null
    ]);
    if (!keepLease && current.lease_token) {
      await client.query(`DELETE FROM ozon_publish_slots
        WHERE slot_key=$1 AND job_id=$2 AND lease_token=$3::uuid`,
      [OZON_RUNTIME_SLOT_KEY, id, current.lease_token]);
    }
    if (input.state === 'SUCCEEDED' && typeof input.jobPayload?.videoCacheCleanedAt === 'string') {
      await addEvent(client, id, 'VIDEO_CACHE_CLEANED', current.state, current.state, 'OZON 任务内视频缓存已清理', {
        cleanedAt: input.jobPayload.videoCacheCleanedAt
      });
    }
    const previousVideoEvents = Array.isArray(current.payload?.videoUploadEvents)
      ? current.payload.videoUploadEvents as Array<Record<string, unknown>>
      : [];
    const previousVideoEventKeys = new Set(previousVideoEvents.map((event) => `${event.eventType}:${event.uploadKey}`));
    const incomingVideoEvents = Array.isArray(input.jobPayload?.videoUploadEvents)
      ? input.jobPayload.videoUploadEvents as Array<Record<string, unknown>>
      : [];
    for (const event of incomingVideoEvents) {
      const eventType = String(event.eventType || '');
      const uploadKey = String(event.uploadKey || '');
      if (!['VIDEO_UPLOAD_DEDUPLICATED', 'VIDEO_URL_REUSED', 'VIDEO_URL_REUPLOADED'].includes(eventType) || !uploadKey) continue;
      if (previousVideoEventKeys.has(`${eventType}:${uploadKey}`)) continue;
      const eventMessage = eventType === 'VIDEO_UPLOAD_DEDUPLICATED'
        ? '同一视频已按内容去重并共享给多个 OZON 变体'
        : eventType === 'VIDEO_URL_REUSED'
          ? '任务重试复用了仍然有效的视频 URL'
          : '共享视频 URL 失效后已整体重新上传一次';
      await addEvent(client, id, eventType, current.state, current.state, eventMessage, event);
    }
    if (!input.auditSuppressed) {
      await addEvent(client, id, input.eventType, current.state, input.state, input.message, input.payload || {});
    }
    return toJob(result.rows[0]!);
  }

  async cancel(
    id: string,
    source?: 'MANUAL' | 'AUTO',
    expectedRowVersion?: number
  ): Promise<OzonPublishJob> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>(
        `SELECT * FROM ozon_publish_jobs WHERE id=$1${source ? ' AND source=$2' : ''} FOR UPDATE`,
        source ? [id, source] : [id]
      );
      if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 上品任务不存在', { id }, 404);
      const job = toJob(result.rows[0]);
      if (expectedRowVersion !== undefined && job.rowVersion !== expectedRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', {
          id,
          expectedRowVersion,
          actualRowVersion: job.rowVersion
        }, 409);
      }
      if (hasActiveAutomaticRecoveryHold(result.rows[0])) {
        throw new AppError('TASK_LOCKED', 'OZON 定向恢复任务仍处于安全 hold，必须使用专用 release 流程', {
          id,
          sku: job.sku
        }, 409);
      }
      if (job.source === 'AUTO') {
        const executionLocks = await client.query<{ runtime_lease_active: boolean; publish_slot_active: boolean }>(`
          SELECT
            EXISTS(
              SELECT 1 FROM ozon_publish_jobs
              WHERE id=$1 AND lease_expires_at>NOW()
            ) AS runtime_lease_active,
            EXISTS(
              SELECT 1 FROM ozon_publish_slots
              WHERE slot_key=$2 AND job_id=$1 AND lease_expires_at>NOW()
            ) AS publish_slot_active`,
        [id, OZON_RUNTIME_SLOT_KEY]);
        if (executionLocks.rows[0]?.runtime_lease_active || executionLocks.rows[0]?.publish_slot_active) {
          throw new AppError('TASK_LOCKED', 'OZON 自动上品任务仍被运行时 lease 或平台单写槽占用', {
            id,
            runtimeLeaseActive: Boolean(executionLocks.rows[0]?.runtime_lease_active),
            publishSlotActive: Boolean(executionLocks.rows[0]?.publish_slot_active)
          }, 409);
        }
      }
      if (job.source === 'AUTO' && !ozonAutoJobCanCancel(job)) {
        throw new AppError('TASK_LOCKED', 'OZON 自动上品任务已进入远程阶段或当前状态不允许取消', {
          id,
          state: job.state,
          taskId: job.taskId,
          importTaskId: job.importTaskId,
          ozonProductId: job.ozonProductId,
          directoryStage: job.directoryStage
        }, 409);
      }
      if (job.source === 'MANUAL' && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) {
        throw new AppError('CONFIG_INVALID', '终态 OZON 任务不能取消', { id, state: job.state }, 409);
      }
      return this.transitionJobWithClient(client, id, {
        rowVersion: job.rowVersion,
        state: 'CANCELLED',
        eventType: 'JOB_CANCELLED',
        message: '任务已由用户取消'
      });
    });
  }

  async returnManualJobToEdit(input: {
    id: string;
    sku: string;
    jobRowVersion: number;
    listingRowVersion: number;
    recovery: Record<string, unknown>;
  }): Promise<{ job: OzonPublishJob; listing: OzonListingDraft }> {
    const sku = normalizeSku(input.sku);
    return this.transaction(async (client) => {
      const jobResult = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.id]);
      const jobRow = jobResult.rows[0];
      if (!jobRow || jobRow.source !== 'MANUAL' || jobRow.sku !== sku) {
        throw new AppError('NOT_FOUND', '该手动 OZON 任务不存在或不属于当前 SKU', { id: input.id, sku }, 404);
      }
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const listingRow = listingResult.rows[0];
      if (!listingRow) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
      if (jobRow.state === 'CANCELLED' && jobRow.payload?.returnedToEdit) {
        return { job: toJob(jobRow), listing: toListing(listingRow) };
      }
      if (!['FAILED', 'NEEDS_ATTENTION'].includes(String(jobRow.state))) {
        throw new AppError('CONFIG_INVALID', '只有失败或需要处理的手动任务才能返回编辑', { id: input.id, state: jobRow.state }, 409);
      }
      if (Number(jobRow.row_version) !== input.jobRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 任务状态已变化，请刷新后重试', { id: input.id }, 409);
      }
      if (Number(listingRow.row_version) !== input.listingRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', { sku }, 409);
      }
      const job = await this.transitionJobWithClient(client, input.id, {
        rowVersion: input.jobRowVersion,
        state: 'CANCELLED',
        eventType: 'JOB_RETURNED_TO_EDIT',
        message: '失败任务的媒体已恢复到 inbox，任务返回编辑并保留原处理目录',
        payload: input.recovery,
        jobPayload: { returnedToEdit: input.recovery }
      });
      const status = listingReady(listingRow.data || {}) ? 'READY' : 'DRAFT';
      const updated = await client.query<SqlRow>(`
        UPDATE ozon_listing_drafts
        SET status=$2,last_task_id=NULL,last_error_code=NULL,last_error_message=NULL,
            row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 RETURNING *`,
      [sku, status]);
      return { job, listing: toListing(updated.rows[0]!) };
    });
  }

  async recheck(id: string, source?: 'MANUAL' | 'AUTO', expectedRowVersion?: number): Promise<OzonPublishJob> {
    const job = await this.getJob(id, source);
    const replanReplacement = jsonObject(jsonObject(job.payload).replanReplacement);
    if (String(replanReplacement.replacementPreparationJobId || '')) {
      throw new AppError('TASK_LOCKED', 'OZON 旧任务已由当前预设重建任务替代，禁止再次重检', {
        id,
        replacementPreparationJobId: replanReplacement.replacementPreparationJobId
      }, 409);
    }
    if (jsonObject(jsonObject(job.payload).recoveryHold).active === true) {
      throw new AppError('TASK_LOCKED', 'OZON 定向恢复任务仍处于安全 hold，必须使用专用 release 流程', {
        id,
        sku: job.sku
      }, 409);
    }
    if (!['NEEDS_ATTENTION', 'FAILED', 'MODERATING', 'WAITING_MEDIA'].includes(job.state)) {
      throw new AppError('CONFIG_INVALID', '当前 OZON 任务状态不支持重新检查', { id, state: job.state }, 409);
    }
    if (expectedRowVersion !== undefined && job.rowVersion !== expectedRowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 任务状态已变化，请刷新后重试', {
        id,
        expected: job.rowVersion,
        actual: expectedRowVersion
      }, 409);
    }
    const settings = await this.getSettings();
    const payload = jsonObject(job.payload);
    const sharedPreparation = job.taskKind === 'SHARED_PREPARATION'
      && payload.multistorePreparation === true
      && !job.publicationId;
    const runtimeReady = sharedPreparation
      ? Boolean(settings.enabled)
      : Boolean(settings.credentialReady && settings.taskApiWebhookUrl);
    const nextState: OzonPublishJobState = runtimeReady && (job.source === 'MANUAL' || settings.enabled) ? 'READY' : 'WAITING_MEDIA';
    return this.transitionJob(id, {
      rowVersion: job.rowVersion,
      state: nextState,
      eventType: 'JOB_RECHECKED',
      message: nextState === 'READY'
        ? '任务已重新进入待调度队列'
        : sharedPreparation ? '共享准备任务等待系统启用' : '任务等待店铺凭据和系统配置'
    });
  }

  async stats(source?: 'MANUAL' | 'AUTO', businessOnly = false): Promise<Record<string, number>> {
    const predicates = [
      ...(source ? ['job.source=$1'] : []),
      ...(businessOnly ? [ozonBusinessJobPredicate('job')] : [])
    ];
    const groupedState = businessOnly ? `CASE
      WHEN job.state='NEEDS_ATTENTION'
      AND job.publication_id IS NOT NULL
      AND job.last_error_code IN ('OZON_PLATFORM_NEEDS_ATTENTION','OZON_PLATFORM_STATUS_ABNORMAL')
      AND jsonb_array_length(
        CASE WHEN jsonb_typeof(job.offer_ids)='array' THEN job.offer_ids ELSE '[]'::jsonb END
      ) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(job.offer_ids)='array' THEN job.offer_ids ELSE '[]'::jsonb END
        ) expected(offer_id)
        LEFT JOIN ozon_product_mappings mapping
          ON mapping.store_alias=job.store_alias
          AND mapping.sku=job.sku
          AND mapping.offer_id=expected.offer_id
        WHERE mapping.offer_id IS NULL
          OR mapping.last_verified_at IS NULL
          OR mapping.last_verified_at<job.created_at
          OR UPPER(BTRIM(COALESCE(mapping.status_snapshot->>'displayState',mapping.status,'')))<>'ARCHIVED'
      ) THEN 'ARCHIVED'
      ELSE job.state
    END` : 'job.state';
    const result = await this.query<{ state: string; count: string }>(
      `SELECT ${groupedState} state,COUNT(*) count
       FROM ozon_publish_jobs job${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''}
       GROUP BY 1`,
      source ? [source] : []
    );
    return Object.fromEntries(result.rows.map((row) => [row.state, Number(row.count)]));
  }

  private async getCategoryWithClient(client: PoolClient, categoryKey: string): Promise<OzonCategoryTemplate> {
    const result = await client.query<SqlRow>(categorySelectSql('WHERE c.category_key=$1'), [categoryKey]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 类目模板不存在', { categoryKey }, 404);
    return toCategory(result.rows[0]);
  }

  private async migrate(): Promise<void> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('merchroute-ozon-schema-v1'))`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_schema_migrations(
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_system_settings(
        id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        root_directory TEXT NOT NULL DEFAULT '',
        default_store_alias TEXT NOT NULL DEFAULT 'default',
        task_api_webhook_url TEXT NOT NULL DEFAULT '',
        admin_api_webhook_url TEXT NOT NULL DEFAULT '',
        preflight_webhook_url TEXT NOT NULL DEFAULT '',
        image_uploader_workflow_id TEXT NOT NULL DEFAULT '',
        store_gateway_workflow_id TEXT NOT NULL DEFAULT '',
        credential_ready BOOLEAN NOT NULL DEFAULT FALSE,
        seller_id TEXT,
        seller_name TEXT,
        account_currency TEXT,
        last_preflight_at TIMESTAMPTZ,
        last_preflight_status TEXT NOT NULL DEFAULT 'NOT_RUN',
        last_preflight_message TEXT,
        row_version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`INSERT INTO ozon_system_settings(id) VALUES('default') ON CONFLICT(id) DO NOTHING`);
      await client.query(`ALTER TABLE ozon_system_settings ADD COLUMN IF NOT EXISTS video_upload_ready BOOLEAN NOT NULL DEFAULT FALSE`);
      await client.query(`ALTER TABLE ozon_system_settings ADD COLUMN IF NOT EXISTS video_upload_checked_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ozon_system_settings ADD COLUMN IF NOT EXISTS video_upload_message TEXT`);
      await client.query(`ALTER TABLE ozon_system_settings ADD COLUMN IF NOT EXISTS image_upload_concurrency INTEGER NOT NULL DEFAULT 7 CHECK(image_upload_concurrency BETWEEN 1 AND 7)`);
      await client.query(`ALTER TABLE ozon_system_settings ADD COLUMN IF NOT EXISTS video_upload_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(video_upload_concurrency BETWEEN 1 AND 2)`);
      await client.query(`ALTER TABLE ozon_system_settings ADD COLUMN IF NOT EXISTS video_prewarm_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_category_templates(
        category_key TEXT PRIMARY KEY,
        name_ru TEXT NOT NULL,
        name_zh TEXT NOT NULL DEFAULT '',
        description_category_id BIGINT NOT NULL,
        type_id BIGINT NOT NULL,
        draft_version_id UUID,
        published_version_id UUID,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_category_template_versions(
        id UUID PRIMARY KEY,
        category_key TEXT NOT NULL REFERENCES ozon_category_templates(category_key) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),
        schema_hash TEXT NOT NULL,
        snapshot JSONB NOT NULL,
        confirmed_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        UNIQUE(category_key,version_no)
      )`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_category_one_draft ON ozon_category_template_versions(category_key) WHERE status='DRAFT'`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_category_one_published ON ozon_category_template_versions(category_key) WHERE status='PUBLISHED'`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_catalog_sync_runs(
        id UUID PRIMARY KEY,trigger TEXT NOT NULL CHECK(trigger IN ('MANUAL','SCHEDULED','STARTUP')),
        status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),schedule_key TEXT,
        processed_entries INTEGER NOT NULL DEFAULT 0 CHECK(processed_entries>=0),
        total_entries INTEGER NOT NULL DEFAULT 0 CHECK(total_entries>=0),
        chinese_missing_count INTEGER NOT NULL DEFAULT 0 CHECK(chinese_missing_count>=0),
        snapshot_path TEXT,source_hash TEXT,error_code TEXT,error_message TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ
      )`);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS ozon_catalog_one_running ON ozon_catalog_sync_runs((status)) WHERE status='RUNNING'");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS ozon_catalog_one_scheduled_week ON ozon_catalog_sync_runs(schedule_key) WHERE trigger='SCHEDULED' AND schedule_key IS NOT NULL");
      await client.query('CREATE INDEX IF NOT EXISTS ozon_catalog_sync_runs_started ON ozon_catalog_sync_runs(started_at DESC)');
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_catalog_entries(
        description_category_id BIGINT NOT NULL,type_id BIGINT NOT NULL,
        category_name_zh TEXT NOT NULL DEFAULT '',type_name_zh TEXT NOT NULL DEFAULT '',
        category_name_ru TEXT NOT NULL DEFAULT '',type_name_ru TEXT NOT NULL DEFAULT '',
        path_zh JSONB NOT NULL DEFAULT '[]'::jsonb,path_ru JSONB NOT NULL DEFAULT '[]'::jsonb,
        search_text_zh TEXT NOT NULL DEFAULT '',active BOOLEAN NOT NULL DEFAULT true,
        missing_sync_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_sync_count>=0),
        last_seen_run_id UUID REFERENCES ozon_catalog_sync_runs(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(description_category_id,type_id)
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS ozon_catalog_entries_search_zh ON ozon_catalog_entries(search_text_zh)');
      await client.query('CREATE INDEX IF NOT EXISTS ozon_catalog_entries_active ON ozon_catalog_entries(active,updated_at DESC)');
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_catalog_dictionary_values(
        directory TEXT NOT NULL CHECK(directory IN ('countries','seasons','kinds','colors')),
        attribute_id BIGINT NOT NULL,dictionary_id BIGINT NOT NULL,value_id BIGINT NOT NULL,
        name_ru TEXT NOT NULL,name_zh TEXT NOT NULL,info_ru TEXT NOT NULL DEFAULT '',info_zh TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,search_text TEXT NOT NULL DEFAULT '',
        active BOOLEAN NOT NULL DEFAULT true,missing_sync_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_sync_count>=0),
        last_seen_run_id UUID REFERENCES ozon_catalog_sync_runs(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(directory,dictionary_id,value_id)
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS ozon_catalog_dictionary_values_lookup ON ozon_catalog_dictionary_values(directory,dictionary_id,active,position)');
      await client.query('CREATE INDEX IF NOT EXISTS ozon_catalog_dictionary_values_search ON ozon_catalog_dictionary_values(search_text)');
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_listing_drafts(
        sku TEXT PRIMARY KEY,
        product_name_snapshot TEXT NOT NULL,
        management_source TEXT NOT NULL DEFAULT 'MANUAL' CHECK(management_source IN ('AUTO','MANUAL')),
        status TEXT NOT NULL,
        row_version INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_task_id TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`ALTER TABLE ozon_listing_drafts ADD COLUMN IF NOT EXISTS management_source TEXT DEFAULT 'MANUAL'`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_listing_drafts_updated ON ozon_listing_drafts(updated_at DESC)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_listing_versions(
        id UUID PRIMARY KEY,
        sku TEXT NOT NULL REFERENCES ozon_listing_drafts(sku) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(sku,revision)
      )`);
      await client.query(`ALTER TABLE ozon_listing_versions
        ADD COLUMN IF NOT EXISTS content_policy_version TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
        ADD COLUMN IF NOT EXISTS material_hash TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS material_hash_version TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
        ADD COLUMN IF NOT EXISTS source_media_identity_hash TEXT NOT NULL DEFAULT ''`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_listing_presets(
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_default BOOLEAN NOT NULL DEFAULT FALSE,
        auto_publish_activated_at TIMESTAMPTZ,
        row_version INTEGER NOT NULL DEFAULT 1,
        definition JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_publish_jobs(
        id UUID PRIMARY KEY,
        sku TEXT NOT NULL,
        offer_id TEXT,
        state TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('MANUAL','AUTO')),
        task_id TEXT,
        import_task_id TEXT,
        ozon_product_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        stage_states JSONB NOT NULL DEFAULT '{}'::jsonb,
        retry_count INTEGER NOT NULL DEFAULT 0,
        row_version INTEGER NOT NULL DEFAULT 1,
        last_error_code TEXT,
        last_error_message TEXT,
        next_attempt_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_publish_jobs_updated ON ozon_publish_jobs(updated_at DESC)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_publish_jobs_state_due ON ozon_publish_jobs(state,next_attempt_at)`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS store_alias TEXT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS offer_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS product_links JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS task_folder TEXT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS work_rel_path TEXT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS directory_stage TEXT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS directory_signature TEXT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS listing_revision INTEGER NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS task_kind TEXT NOT NULL DEFAULT 'LEGACY'`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ozon_publish_jobs ADD COLUMN IF NOT EXISTS lease_token UUID`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_publish_jobs_runtime_lease_due
        ON ozon_publish_jobs(state,next_attempt_at,lease_expires_at)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_publish_slots(
        slot_key TEXT PRIMARY KEY,
        job_id UUID NOT NULL REFERENCES ozon_publish_jobs(id) ON DELETE CASCADE,
        lease_owner TEXT NOT NULL,
        lease_token UUID NOT NULL,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_publish_slots_expires
        ON ozon_publish_slots(lease_expires_at)`);
      await client.query(`
        UPDATE ozon_publish_jobs
        SET store_alias=COALESCE(
          NULLIF(payload->>'storeAlias',''),
          NULLIF(store_alias,''),
          'default'
        )
        WHERE store_alias IS NULL OR store_alias='' OR NULLIF(payload->>'storeAlias','') IS NOT NULL`);
      await client.query(`ALTER TABLE ozon_publish_jobs ALTER COLUMN store_alias DROP DEFAULT`);
      await client.query(`ALTER TABLE ozon_publish_jobs ALTER COLUMN store_alias SET NOT NULL`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_publish_events(
        id UUID PRIMARY KEY,
        job_id UUID NOT NULL REFERENCES ozon_publish_jobs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        message TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        store_id UUID,
        publication_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // The legacy repository owns the event table, so it must expose the optional
      // binding fields that addEvent writes. OzonStoreRepository still owns their
      // backfill, NOT NULL rules and compound store/job/publication foreign keys.
      await client.query(`ALTER TABLE ozon_publish_events
        ADD COLUMN IF NOT EXISTS store_id UUID,
        ADD COLUMN IF NOT EXISTS publication_id UUID`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_publish_events_job_time ON ozon_publish_events(job_id,created_at)`);
      const hasStoreId = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='ozon_publish_jobs' AND column_name='store_id'
      ) AS exists`);
      if (hasStoreId.rows[0]?.exists) {
        await client.query(`DO $migration$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM ozon_publish_jobs
              WHERE task_kind='SHARED_PREPARATION'
                AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
              GROUP BY sku HAVING COUNT(*) > 1
            ) THEN
              RAISE EXCEPTION '018_ozon_shared_material_and_preparation_attempts: duplicate active shared preparations require manual resolution';
            END IF;
            IF EXISTS (
              SELECT 1 FROM ozon_publish_jobs
              WHERE task_kind IN ('STORE_PUBLICATION','LEGACY')
                AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
              GROUP BY store_id,sku HAVING COUNT(*) > 1
            ) THEN
              RAISE EXCEPTION '018_ozon_shared_material_and_preparation_attempts: duplicate active store publications require manual resolution';
            END IF;
          END
        $migration$`);
        await client.query('DROP INDEX IF EXISTS ozon_publish_jobs_one_active_per_sku');
        await client.query('DROP INDEX IF EXISTS ozon_publish_jobs_one_active_per_store_sku');
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publish_jobs_one_active_shared_preparation
          ON ozon_publish_jobs(sku)
          WHERE task_kind='SHARED_PREPARATION'
            AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publish_jobs_one_active_publication_per_store_sku
          ON ozon_publish_jobs(store_id,sku)
          WHERE task_kind IN ('STORE_PUBLICATION','LEGACY')
            AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`);
      } else {
        await client.query(`DO $migration$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM ozon_publish_jobs
              WHERE state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING','NEEDS_ATTENTION')
              GROUP BY sku HAVING COUNT(*) > 1
            ) THEN
              RAISE EXCEPTION '004_ozon_job_coordination: duplicate active OZON jobs require manual resolution before migration';
            END IF;
          END
        $migration$`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publish_jobs_one_active_per_sku
          ON ozon_publish_jobs(sku)
          WHERE state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING','NEEDS_ATTENTION')`);
      }
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_media_deliveries(
        sku TEXT NOT NULL,
        source_stage_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        variant_id TEXT NOT NULL DEFAULT '',
        job_id UUID REFERENCES ozon_publish_jobs(id) ON DELETE SET NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(sku,source_stage_id,submission_id,variant_id)
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_media_deliveries_job ON ozon_media_deliveries(job_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_media_deliveries_deferred
        ON ozon_media_deliveries(received_at,sku)
        WHERE job_id IS NULL AND payload->>'autoPublishDecision'='DEFERRED'`);
      await client.query(`WITH historical AS (
        SELECT DISTINCT ON (
          job.sku,
          COALESCE(delivery.value->>'sourceStageId',''),
          COALESCE(delivery.value->>'submissionId',''),
          COALESCE(delivery.value->>'variantId','')
        )
          job.sku,
          COALESCE(delivery.value->>'sourceStageId','') AS source_stage_id,
          COALESCE(delivery.value->>'submissionId','') AS submission_id,
          COALESCE(delivery.value->>'variantId','') AS variant_id,
          job.id AS job_id,
          delivery.value AS payload,
          job.created_at AS received_at,
          job.updated_at
        FROM ozon_publish_jobs job
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(job.payload->'mediaDeliveries')='array'
            THEN job.payload->'mediaDeliveries' ELSE '[]'::jsonb END
        ) AS delivery(value)
        WHERE jsonb_typeof(delivery.value)='object'
        ORDER BY
          job.sku,
          COALESCE(delivery.value->>'sourceStageId',''),
          COALESCE(delivery.value->>'submissionId',''),
          COALESCE(delivery.value->>'variantId',''),
          job.updated_at DESC,
          job.id DESC
      )
      INSERT INTO ozon_media_deliveries(
        sku,source_stage_id,submission_id,variant_id,job_id,payload,received_at,updated_at
      )
      SELECT sku,source_stage_id,submission_id,variant_id,job_id,payload,received_at,updated_at
      FROM historical
      ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO NOTHING`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_product_mappings(
        store_alias TEXT NOT NULL,
        offer_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        ozon_product_id TEXT,
        ozon_sku TEXT,
        warehouse_id TEXT,
        last_applied_revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'UNKNOWN',
        status_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_verified_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(store_alias,offer_id)
      )`);
      await client.query(`ALTER TABLE ozon_product_mappings
        ADD COLUMN IF NOT EXISTS status_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await client.query(`CREATE TABLE IF NOT EXISTS ozon_platform_status_refresh_leases(
        sku TEXT PRIMARY KEY,
        job_id UUID UNIQUE REFERENCES ozon_publish_jobs(id) ON DELETE SET NULL,
        lease_token UUID NOT NULL,
        listing_row_version INTEGER NOT NULL,
        job_row_version INTEGER,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS ozon_platform_status_refresh_leases_expires
        ON ozon_platform_status_refresh_leases(lease_expires_at)`);
      const migration005 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='005_ozon_task_directory_and_variant_links'`);
      if (!migration005.rows[0]) await backfillHistoricalJobMappings(client);
      const migration006 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='006_ozon_sku_model_identity'`);
      if (!migration006.rows[0]) await migrateOzonSkuModelIdentity(client);
      const migration007 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='007_ozon_platform_type_identity'`);
      if (!migration007.rows[0]) await migrateOzonPlatformTypeIdentity(client);
      const migration008 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='008_ozon_frontend_sku_links'`);
      if (!migration008.rows[0]) await backfillFrontendSkuProductLinks(client);
      // Migration 009 is retained only as a historical marker. Automation is
      // store-owned now; a preset no longer has a global activation timestamp.
      const migration011 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='011_ozon_title_translation_workflow'`);
      if (!migration011.rows[0]) {
        await client.query(`UPDATE ozon_listing_presets
          SET definition=jsonb_set(
                definition,
                '{titleTranslation,workflowId}',
                to_jsonb($2::text),
                true
              ),
              row_version=row_version+1,
              updated_at=NOW()
          WHERE definition #>> '{titleTranslation,workflowId}'=$1`,
        ['W2lSSXE3NUaLW1tD', OZON_TITLE_TRANSLATION_WORKFLOW_ID]);
      }
      const migration016 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='016_ozon_listing_management_source'`);
      if (!migration016.rows[0]) {
        await client.query(`UPDATE ozon_listing_drafts draft
          SET management_source='AUTO'
          WHERE EXISTS (
            SELECT 1 FROM ozon_publish_jobs job
            WHERE job.sku=draft.sku AND job.source='AUTO'
              AND lower(COALESCE(job.payload->>'autoPreparedStartedWithoutListing','false'))='true'
          )`);
      }
      await client.query(`UPDATE ozon_listing_drafts SET management_source='MANUAL'
        WHERE management_source IS NULL OR management_source NOT IN ('AUTO','MANUAL')`);
      await client.query(`ALTER TABLE ozon_listing_drafts ALTER COLUMN management_source SET DEFAULT 'MANUAL'`);
      await client.query(`ALTER TABLE ozon_listing_drafts ALTER COLUMN management_source SET NOT NULL`);
      await client.query(`DO $management_source$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid='ozon_listing_drafts'::regclass
              AND conname='ozon_listing_drafts_management_source_check'
          ) THEN
            ALTER TABLE ozon_listing_drafts ADD CONSTRAINT ozon_listing_drafts_management_source_check
              CHECK(management_source IN ('AUTO','MANUAL'));
          END IF;
        END
      $management_source$`);
      const migration017 = await client.query(`SELECT 1 FROM ozon_schema_migrations WHERE id='017_ozon_store_owned_presets'`);
      if (!migration017.rows[0]) {
        const storesTable = await client.query<{ table_name: string | null }>(
          `SELECT to_regclass(format('%I.ozon_stores', current_schema()))::text AS table_name`
        );
        if (storesTable.rows[0]?.table_name) {
          const invalidStores = await client.query<SqlRow>(`SELECT s.id,s.store_alias,s.display_name,s.default_preset_id,p.definition
            FROM ozon_stores s LEFT JOIN ozon_listing_presets p ON p.id=s.default_preset_id
            WHERE s.enabled=true AND s.archived_at IS NULL
              AND (s.default_preset_id IS NULL OR p.id IS NULL)
            ORDER BY s.store_alias`);
          if (invalidStores.rows.length) {
            throw new AppError('OZON_STORE_NOT_READY', '启用中的 OZON 店铺缺少有效默认预设，不能移除全局默认机制', {
              stores: invalidStores.rows.map((row) => ({
                id: String(row.id),
                storeAlias: String(row.store_alias),
                displayName: String(row.display_name || '')
              }))
            }, 409);
          }
          const activeDefinitions = await client.query<SqlRow>(`SELECT DISTINCT p.id,p.name,p.description,p.definition
            FROM ozon_stores s JOIN ozon_listing_presets p ON p.id=s.default_preset_id
            WHERE s.enabled=true AND s.archived_at IS NULL`);
          for (const row of activeDefinitions.rows) {
            try {
              currentPresetDefinition({ ...jsonObject(row.definition), name: row.name, description: row.description || '' });
            } catch (error) {
              throw new AppError('CONFIG_INVALID', '启用店铺绑定的 OZON 预设不符合店铺权威合同', {
                presetId: String(row.id),
                presetName: String(row.name),
                reason: error instanceof Error ? error.message : String(error)
              }, 409);
            }
          }
          await client.query(`CREATE TABLE IF NOT EXISTS ozon_legacy_configuration_audit(
            id TEXT PRIMARY KEY,snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`);
          await client.query(`INSERT INTO ozon_legacy_configuration_audit(id,snapshot)
            SELECT '017_ozon_store_owned_presets',jsonb_build_object(
              'presets',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.updated_at,p.id) FROM ozon_listing_presets p),'[]'::jsonb),
              'systemSettings',COALESCE((SELECT to_jsonb(s) FROM ozon_system_settings s WHERE s.id='default'),'{}'::jsonb)
            ) ON CONFLICT(id) DO NOTHING`);
          await client.query(`UPDATE ozon_listing_presets SET
            definition=definition-'isDefault'-'autoPublishEnabled'-'autoPublishMode'-'autoPublishActivatedAt'
              -'warehouseId'-'fulfillmentMode'-'currency',
            row_version=row_version+1,updated_at=NOW()
            WHERE definition ?| ARRAY['isDefault','autoPublishEnabled','autoPublishMode','autoPublishActivatedAt','warehouseId','fulfillmentMode','currency']`);
          await client.query('DROP INDEX IF EXISTS ozon_one_default_preset');
          await client.query('ALTER TABLE ozon_listing_presets DROP COLUMN IF EXISTS is_default');
          await client.query('ALTER TABLE ozon_listing_presets DROP COLUMN IF EXISTS auto_publish_activated_at');
          await client.query(`ALTER TABLE ozon_system_settings
            DROP COLUMN IF EXISTS default_store_alias,
            DROP COLUMN IF EXISTS credential_ready,
            DROP COLUMN IF EXISTS seller_id,
            DROP COLUMN IF EXISTS seller_name,
            DROP COLUMN IF EXISTS account_currency,
            DROP COLUMN IF EXISTS last_preflight_at,
            DROP COLUMN IF EXISTS last_preflight_status,
            DROP COLUMN IF EXISTS last_preflight_message`);
          await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('017_ozon_store_owned_presets') ON CONFLICT(id) DO NOTHING`);
        }
      }
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('001_initial') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('002_local_category_catalog') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('003_ozon_field_dictionaries') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('004_ozon_job_coordination') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('005_ozon_task_directory_and_variant_links') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('006_ozon_sku_model_identity') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('007_ozon_platform_type_identity') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('008_ozon_frontend_sku_links') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('009_ozon_management_and_preset_activation') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('010_ozon_platform_status_reconciliation') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('011_ozon_title_translation_workflow') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('012_ozon_network_recovery_runtime_lease') ON CONFLICT(id) DO NOTHING`);
      await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('016_ozon_listing_management_source') ON CONFLICT(id) DO NOTHING`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'OZON 上品管理尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }

  private query<T extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    return this.requirePool().query<T>(text, values);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function assertOzonCategorySizingSnapshot(snapshot: OzonCategoryTemplateInput): void {
  if (snapshot.sizing.sizeMode !== 'sized') return;
  const sizeAttributeKey = snapshot.sizing.sizeAttributeKey;
  const candidate = ozonCategorySizeAttributeCandidates(snapshot.attributes)
    .find((attribute) => `${attribute.id}:${attribute.complexId}` === sizeAttributeKey);
  if (!candidate) {
    throw new AppError('CONFIG_INVALID', '所选 OZON 尺码属性不是当前类目的有效顶层尺码字段', {
      categoryKey: snapshot.categoryKey,
      sizeAttributeKey,
      candidates: ozonCategorySizeAttributeCandidates(snapshot.attributes)
        .map((attribute) => `${attribute.id}:${attribute.complexId}`)
    }, 409);
  }
  if (!candidate.dictionaryId) return;
  const values = snapshot.dictionarySnapshot[String(candidate.id)] || [];
  const valueIds = values.map((value) => value.id);
  const lacksBilingualValue = values.some((value) => !value.valueRu?.trim() || !value.valueZh?.trim());
  if (!values.length || lacksBilingualValue
    || valueIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    || new Set(valueIds).size !== valueIds.length) {
    throw new AppError('CONFIG_INVALID', '字典型 OZON 尺码属性缺少完整、唯一的值快照，请刷新类目后重试', {
      categoryKey: snapshot.categoryKey,
      attributeId: candidate.id,
      dictionaryId: candidate.dictionaryId,
      valueCount: values.length
    }, 409);
  }
}

async function assertOzonPresetMatchesPublishedCategory(client: PoolClient, definition: OzonPresetInput): Promise<void> {
  const result = await client.query<{ snapshot: unknown }>(`
    SELECT version.snapshot
    FROM ozon_category_templates category
    JOIN ozon_category_template_versions version ON version.id=category.published_version_id
    WHERE category.category_key=$1 AND version.status='PUBLISHED'
    LIMIT 1
    FOR SHARE OF category, version`, [definition.categoryKey]);
  if (!result.rows[0]) {
    throw new AppError('CONFIG_INVALID', '所选 OZON 类目模板不存在或尚未发布', { categoryKey: definition.categoryKey }, 409);
  }
  const parsed = ozonCategoryTemplateInputSchema.safeParse(result.rows[0].snapshot);
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', '所选 OZON 类目的已发布快照无效，请刷新并重新发布类目', {
      categoryKey: definition.categoryKey
    }, 409);
  }
  assertOzonPresetDefinitionMatchesCategory(definition, parsed.data);
}

export function assertOzonPresetDefinitionMatchesCategory(
  definition: OzonPresetInput,
  snapshot: OzonCategoryTemplateInput
): void {
  if (definition.categoryKey !== snapshot.categoryKey) {
    throw new AppError('CONFIG_INVALID', 'OZON 预设与已发布类目快照的身份不一致', {
      expected: definition.categoryKey,
      actual: snapshot.categoryKey
    }, 409);
  }
  assertOzonCategorySizingSnapshot(snapshot);
  if (snapshot.sizing.sizeMode === 'sizeless') {
    if (definition.sizeAttributeKey) {
      throw new AppError('CONFIG_INVALID', '当前 OZON 类目按无尺码商品发布，预设不能保留尺码属性', {
        categoryKey: definition.categoryKey,
        sizeAttributeKey: definition.sizeAttributeKey
      }, 409);
    }
    assertOzonPresetRequiredAttributeCoverage(definition, snapshot);
    return;
  }
  const sizeAttributeKey = snapshot.sizing.sizeAttributeKey!;
  if (definition.sizeAttributeKey !== sizeAttributeKey) {
    throw new AppError('CONFIG_INVALID', 'OZON 预设的尺码属性必须与已发布类目规则一致', {
      categoryKey: definition.categoryKey,
      expected: sizeAttributeKey,
      actual: definition.sizeAttributeKey
    }, 409);
  }
  const sizeAttribute = snapshot.attributes.find((attribute) => `${attribute.id}:${attribute.complexId}` === sizeAttributeKey)!;
  const duplicated = [...definition.sharedAttributes, ...definition.variantAttributes]
    .some((attribute) => `${attribute.attributeId}:${attribute.complexId}` === sizeAttributeKey);
  if (duplicated) {
    throw new AppError('CONFIG_INVALID', 'OZON 尺码属性只能由“尺码与默认库存”管理，不能在普通目录属性中重复提交', {
      categoryKey: definition.categoryKey,
      sizeAttributeKey
    }, 409);
  }
  assertOzonPresetRequiredAttributeCoverage(definition, snapshot);
  if (!sizeAttribute.dictionaryId) {
    if (definition.sizes.some((size) => /^dict:\d+$/.test(size.value))) {
      throw new AppError('CONFIG_INVALID', '当前 OZON 尺码属性不是字典类型，请填写文本尺码值', {
        categoryKey: definition.categoryKey,
        sizeAttributeKey
      }, 409);
    }
    return;
  }
  const allowedIds = new Set((snapshot.dictionarySnapshot[String(sizeAttribute.id)] || []).map((value) => value.id));
  for (const [index, size] of definition.sizes.entries()) {
    const match = /^dict:([1-9]\d*)$/.exec(size.value);
    const valueId = match ? Number(match[1]) : 0;
    if (!valueId || !allowedIds.has(valueId)) {
      throw new AppError('CONFIG_INVALID', `OZON 尺码第 ${index + 1} 行不是当前类目快照中的有效字典值`, {
        categoryKey: definition.categoryKey,
        sizeAttributeKey,
        value: size.value
      }, 409);
    }
  }
}

function assertOzonPresetRequiredAttributeCoverage(
  definition: OzonPresetInput,
  snapshot: OzonCategoryTemplateInput
): void {
  const requiredAttributeCoverage = projectOzonPresetRequiredAttributeCoverage(snapshot, definition);
  const missingRequiredAttributes = findUncoveredOzonPresetRequiredAttributes(snapshot, definition);
  if (!missingRequiredAttributes.length) return;
  throw new AppError(
    'CONFIG_INVALID',
    `OZON 上品预设缺少必填目录属性：${missingRequiredAttributes.map((attribute) => (
      `${attribute.nameZh || attribute.nameRu || attribute.name} / ${attribute.nameRu || attribute.name} · #${attribute.attributeId}`
    )).join('；')}`,
    {
      categoryKey: definition.categoryKey,
      missingRequiredAttributes,
      requiredAttributeCoverage
    },
    409
  );
}

export function markChangedOzonDescriptionsManual<T extends Omit<OzonListingDraft['data'], never>>(
  currentInput: unknown,
  dataInput: T
): T {
  const current = currentInput && typeof currentInput === 'object' && !Array.isArray(currentInput)
    ? currentInput as OzonListingDraft['data']
    : {} as OzonListingDraft['data'];
  const next = { ...dataInput } as T;
  const titleChanged = String(next.titleRu || '').trim() !== String(current.titleRu || '').trim();
  const sharedChanged = String(next.descriptionRu || '').trim() !== String(current.descriptionRu || '').trim();
  if (sharedChanged) {
    next.descriptionSource = String(next.descriptionRu || '').trim() ? { type: 'MANUAL' } : undefined;
  }
  const currentOffers = new Map((Array.isArray(current.offers) ? current.offers : []).map((offer) => [offer.variantId, offer]));
  next.offers = next.offers.map((offer) => {
    const previous = currentOffers.get(offer.variantId);
    const changed = String(offer.descriptionRu || '').trim() !== String(previous?.descriptionRu || '').trim();
    if (!changed) return offer;
    return {
      ...offer,
      descriptionSource: String(offer.descriptionRu || '').trim() ? { type: 'MANUAL' as const } : undefined
    };
  });
  if (next.initialization) {
    const resolvedFields = new Set<string>();
    if (String(next.titleRu || '').trim()) resolvedFields.add('titleRu');
    if (String(next.descriptionRu || '').trim()) resolvedFields.add('descriptionRu');
    for (const offer of next.offers) {
      if (String(offer.descriptionRu || '').trim()) {
        resolvedFields.add(`offers.${offer.productVariantId || offer.variantId}.descriptionRu`);
      }
    }
    const issues = next.initialization.issues.filter((issue) => (
      issue.code === 'E003_DESCRIPTION_FALLBACK' || !issue.field || !resolvedFields.has(issue.field)
    ));
    const complete = Boolean(
      String(next.titleRu || '').trim()
      && String(next.descriptionRu || '').trim()
      && next.offers.every((offer) => String(offer.descriptionRu || '').trim())
    );
    next.initialization = {
      ...next.initialization,
      status: complete ? 'COMPLETE' : 'PARTIAL',
      issues,
      ...(titleChanged ? { title: undefined } : {}),
      ...(sharedChanged ? { description: undefined } : {})
    };
  }
  return next;
}

function normalizeOzonListingDescriptions<T extends Omit<OzonListingDraft['data'], never>>(dataInput: T): T {
  if (dataInput.titleRu && hasOzonCjk(dataInput.titleRu)) {
    throw new AppError('CONFIG_INVALID', 'OZON 俄文标题包含中文字符，请先修正标题', { fieldPath: 'titleRu' }, 409);
  }
  const normalize = (value: string | undefined, fieldPath: string) => {
    if (!String(value || '').trim()) return '';
    const source = String(value);
    const policy = validateOzonDescription(source);
    if (!policy.valid) {
      throw new AppError('CONFIG_INVALID', 'OZON 商品详情不符合内容合同，源值未修改', {
        fieldPath,
        issues: policy.issues,
        length: policy.length
      }, 409);
    }
    return source;
  };
  const descriptionRu = normalize(dataInput.descriptionRu, 'descriptionRu');
  const sharedAttributes = dataInput.sharedAttributes.map((attribute) => attribute.attributeId === 4191
    ? { ...attribute, values: [{ value: descriptionRu }] }
    : attribute);
  const offers = dataInput.offers.map((offer, index) => {
    const offerDescription = offer.descriptionRu === undefined
      ? undefined
      : normalize(offer.descriptionRu, `offers.${index}.descriptionRu`);
    const effective = offerDescription || descriptionRu;
    return {
      ...offer,
      ...(offer.descriptionRu === undefined ? {} : { descriptionRu: offerDescription }),
      attributes: offer.attributes.map((attribute) => attribute.attributeId === 4191
        ? { ...attribute, values: [{ value: effective }] }
        : attribute)
    };
  });
  return {
    ...dataInput,
    descriptionRu,
    sharedAttributes,
    offers
  };
}

function readOzonGrossWeightResolution(
  dataInput: unknown,
  sku: string
): OzonGrossWeightResolution | undefined {
  const data = jsonObject(dataInput);
  if (!Object.hasOwn(data, 'initialization') || data.initialization === undefined) return undefined;
  const initialization = jsonObject(data.initialization);
  try {
    return readStoredOzonGrossWeightResolution(initialization);
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError('CONFIG_INVALID', '毛重联动审计快照无效，请重新初始化 OZON 上品资料', {
        sku,
        cause: error.message
      }, 409);
    }
    throw error;
  }
}

function assertManagedOzonDimensionsMatch(
  dimensionsInput: unknown,
  resolution: OzonGrossWeightResolution,
  sku: string,
  message: string
): void {
  const dimensions = jsonObject(dimensionsInput);
  const actualWeightGrams = dimensions.weight;
  if (typeof actualWeightGrams === 'number'
    && Number.isFinite(actualWeightGrams)
    && actualWeightGrams === resolution.effectiveGrossWeightGrams
    && dimensions.weightUnit === 'g') return;
  throw new AppError('CONFIG_INVALID', message, {
    sku,
    source: resolution.source,
    expectedWeightGrams: resolution.effectiveGrossWeightGrams,
    expectedWeightUnit: 'g',
    actualWeight: actualWeightGrams ?? null,
    actualWeightUnit: dimensions.weightUnit ?? null
  }, 409);
}

export function assertOzonGrossWeightLinkage(
  dataInput: unknown,
  sku = '',
  message = '毛重联动初始化数据无效，请重新初始化 OZON 上品资料'
): void {
  const resolution = readOzonGrossWeightResolution(dataInput, sku);
  if (!resolution) return;
  assertManagedOzonDimensionsMatch(jsonObject(dataInput).dimensions, resolution, sku, message);
}

function protectOzonGrossWeightLinkage<T extends Omit<OzonListingDraft['data'], never>>(
  currentInput: unknown,
  candidateInput: T,
  sku: string,
  allowGrossWeightInitialization: boolean,
  allowGrossWeightRefresh: boolean,
  allowPricingResolutionRefresh: boolean
): T {
  const current = jsonObject(currentInput);
  const currentInitialization = jsonObject(current.initialization);
  const candidate = { ...candidateInput } as T & Record<string, unknown>;
  let candidateInitialization = jsonObject(candidate.initialization);
  const currentResolution = readOzonGrossWeightResolution(current, sku);
  const currentHasPricingResolution = Object.hasOwn(currentInitialization, 'pricingResolution');
  const candidateHasPricingResolution = Object.hasOwn(candidateInitialization, 'pricingResolution');
  const pricingResolutionChanged = candidateHasPricingResolution
    && (!currentHasPricingResolution
      || stableJson(candidateInitialization.pricingResolution) !== stableJson(currentInitialization.pricingResolution));
  if (pricingResolutionChanged && !allowPricingResolutionRefresh) {
    throw new AppError('CONFIG_INVALID', '定价与运费版本证据由服务端管理，不能覆盖', { sku }, 409);
  }
  if (!candidateHasPricingResolution && currentHasPricingResolution) {
    candidateInitialization = {
      ...candidateInitialization,
      pricingResolution: currentInitialization.pricingResolution
    };
  }

  if (currentResolution) {
    const hasCandidateResolution = Object.hasOwn(candidateInitialization, 'grossWeightResolution');
    const hasCandidatePresetSnapshot = Object.hasOwn(candidateInitialization, 'presetSnapshot');
    const resolutionChanged = hasCandidateResolution
      && stableJson(candidateInitialization.grossWeightResolution) !== stableJson(currentResolution);
    const presetSnapshotChanged = hasCandidatePresetSnapshot
      && (!Object.hasOwn(currentInitialization, 'presetSnapshot')
        || stableJson(candidateInitialization.presetSnapshot) !== stableJson(currentInitialization.presetSnapshot));
    const refreshRequested = resolutionChanged || presetSnapshotChanged;

    if (refreshRequested && allowGrossWeightRefresh) {
      if (!hasCandidateResolution || !hasCandidatePresetSnapshot) {
        throw new AppError('CONFIG_INVALID', '刷新毛重联动必须同时提供完整的毛重审计快照和上架预设快照', { sku }, 409);
      }
      const refreshedResolution = readOzonGrossWeightResolution(candidate, sku);
      if (!refreshedResolution) {
        throw new AppError('CONFIG_INVALID', '刷新毛重联动必须提供有效的毛重审计快照', { sku }, 409);
      }
      assertManagedOzonDimensionsMatch(
        candidate.dimensions,
        refreshedResolution,
        sku,
        '刷新毛重联动时，包装毛重和重量单位必须与新的毛重审计快照一致'
      );
      (candidate as Record<string, unknown>).initialization = {
        ...candidateInitialization,
        grossWeightResolution: refreshedResolution,
        presetSnapshot: candidateInitialization.presetSnapshot
      };
      (candidate as Record<string, unknown>).dimensions = {
        ...jsonObject(candidate.dimensions),
        weight: refreshedResolution.effectiveGrossWeightGrams,
        weightUnit: 'g'
      };
      return candidate;
    }

    if (resolutionChanged) {
      throw new AppError('CONFIG_INVALID', '毛重联动审计快照由服务端管理，不能覆盖', { sku }, 409);
    }
    if (presetSnapshotChanged) {
      throw new AppError('CONFIG_INVALID', '上架预设初始化快照由服务端管理，不能覆盖', { sku }, 409);
    }
    assertManagedOzonDimensionsMatch(
      candidate.dimensions,
      currentResolution,
      sku,
      '毛重由采购管理/上架预设联动管理，不能手动修改毛重或重量单位'
    );
    (candidate as Record<string, unknown>).initialization = {
      ...(Object.keys(candidateInitialization).length ? candidateInitialization : currentInitialization),
      ...(Object.hasOwn(currentInitialization, 'presetSnapshot')
        ? { presetSnapshot: currentInitialization.presetSnapshot }
        : {}),
      grossWeightResolution: currentResolution
    };
    (candidate as Record<string, unknown>).dimensions = {
      ...jsonObject(candidate.dimensions),
      weight: currentResolution.effectiveGrossWeightGrams,
      weightUnit: 'g'
    };
    return candidate;
  }

  if (allowGrossWeightInitialization) {
    assertOzonGrossWeightLinkage(candidate, sku);
    return candidate;
  }

  if (Object.keys(candidateInitialization).length) {
    const protectedInitialization = { ...candidateInitialization };
    delete protectedInitialization.grossWeightResolution;
    if (Object.hasOwn(currentInitialization, 'presetSnapshot')) {
      protectedInitialization.presetSnapshot = currentInitialization.presetSnapshot;
    } else {
      delete protectedInitialization.presetSnapshot;
    }
    (candidate as Record<string, unknown>).initialization = protectedInitialization;
  }
  return candidate;
}

function listingReady(data: Record<string, unknown>): boolean {
  const offers = Array.isArray(data.offers) ? data.offers as Array<{ media?: Array<{ kind?: string }> }> : [];
  return Boolean(
    data.categoryKey
    && data.categoryVersionId
    && data.warehouseId
    && data.titleRu
    && data.descriptionRu
    && data.dimensions
    && offers.length > 0
    && Array.isArray(data.mediaAssets)
    && data.mediaAssets.length > 0
    && data.mediaSourceRoot
    && offers.every((offer) => {
      const media = Array.isArray(offer.media) ? offer.media : [];
      const imageCount = media.filter((item) => (item.kind || 'image') === 'image').length;
      const videoCount = media.filter((item) => item.kind === 'video').length;
      return imageCount >= 1 && imageCount <= 15 && videoCount === 1;
    })
  );
}

function normalizeSku(value: string): string {
  const sku = String(value || '').trim();
  if (!sku || sku.length > 128) throw new AppError('CONFIG_INVALID', 'SKU 格式无效', { sku: value });
  return sku;
}

function schemaHash(value: OzonCategoryTemplateInput): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

type OzonPrePlanFrozenTarget = OzonPrePlanRecoveryRearmInput['targetStores'][number];

function ozonPrePlanArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stripOzonPrePlanAuditTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOzonPrePlanAuditTimestamps);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'checkedAt')
    .map(([key, entry]) => [key, stripOzonPrePlanAuditTimestamps(entry)]));
}

function deterministicOzonPrePlanRequestId(jobId: string, planHash: string): string {
  const hex = createHash('sha256').update(`ozon-preparation-recheck\u0000${jobId}\u0000${planHash}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function canonicalOzonPrePlanTarget(value: unknown): Record<string, unknown> {
  const target = jsonObject(value);
  return {
    id: String(target.id || ''),
    rowVersion: Number(target.rowVersion),
    configVersion: Number(target.configVersion),
    credentialVersionId: String(target.credentialVersionId || ''),
    presetId: String(target.presetId || ''),
    presetRowVersion: Number(target.presetRowVersion),
    presetDefinitionHash: String(target.presetDefinitionHash || ''),
    presetSnapshotHash: String(target.presetSnapshotHash || ''),
    publicationMode: String(target.publicationMode || ''),
    warehouseId: String(target.warehouseId || ''),
    fulfillmentMode: String(target.fulfillmentMode || ''),
    accountCurrency: String(target.accountCurrency || ''),
    expectedOfferIds: normalizeOfferIds(ozonPrePlanArray(target.expectedOfferIds))
  };
}

function canonicalOzonPrePlanMediaDelivery(value: unknown): Record<string, unknown> {
  const delivery = jsonObject(value);
  return {
    sourceStageId: String(delivery.sourceStageId || ''),
    submissionId: String(delivery.submissionId || ''),
    variantId: String(delivery.variantId || ''),
    jobId: String(delivery.jobId || ''),
    deliveredAt: String(delivery.deliveredAt || ''),
    payloadHash: String(delivery.payloadHash || ''),
    updatedAt: String(delivery.updatedAt || '')
  };
}

function assertOzonPrePlanRecoveryContract(input: {
  jobId: string;
  sku: string;
  planHash: string;
  requestId: string;
  evidence: unknown;
  productIdentity: unknown;
  manifestSignature: string;
  mediaDeliveries: unknown[];
  targetStores: OzonPrePlanFrozenTarget[] | Record<string, unknown>[];
  eligibilityAt: string;
}): void {
  const evidence = jsonObject(input.evidence);
  const checks = jsonObject(evidence.checks);
  const canonical = {
    schemaVersion: Number(evidence.schemaVersion),
    recoveryMode: String(evidence.recoveryMode || ''),
    jobId: String(evidence.jobId || ''),
    sku: String(evidence.sku || ''),
    rowVersion: Number(evidence.rowVersion),
    checks: stripOzonPrePlanAuditTimestamps(checks)
  };
  const calculatedPlanHash = `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`;
  const media = jsonObject(checks.media);
  const manifest = jsonObject(media.manifest);
  const stores = jsonObject(checks.stores);
  const remote = jsonObject(checks.remoteOfferAbsence);
  const productIdentity = jsonObject(checks.productIdentity);
  const localBlockers = ozonPrePlanArray(checks.localBlockers);
  const expectedTargets = ozonPrePlanArray(stores.items)
    .map(canonicalOzonPrePlanTarget)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const submittedTargets = input.targetStores
    .map(canonicalOzonPrePlanTarget)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const expectedMedia = ozonPrePlanArray(media.evidence)
    .map(canonicalOzonPrePlanMediaDelivery)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const submittedMedia = input.mediaDeliveries
    .map(canonicalOzonPrePlanMediaDelivery)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const latestDelivery = submittedMedia.map((delivery) => String(delivery.deliveredAt || '')).sort().at(-1) || '';
  const proofStartedAt = Date.parse(String(checks.checkedAt || evidence.checkedAt || ''));
  const now = Date.now();
  const proofs = ozonPrePlanArray(remote.evidence).map(jsonObject);
  const proofsValid = proofs.length === submittedTargets.length && proofs.every((proof) => {
    const target = submittedTargets.find((entry) => entry.id === String(proof.storeId || ''));
    const offerIds = normalizeOfferIds(ozonPrePlanArray(proof.offerIds));
    const operations = ozonPrePlanArray(proof.operations).map(jsonObject);
    const semantic = {
      absent: true,
      status: 'CONFIRMED_ABSENT',
      storeId: String(proof.storeId || ''),
      storeConfigVersion: Number(proof.storeConfigVersion),
      credentialVersionId: String(proof.credentialVersionId || ''),
      offerIds,
      operations
    };
    const checkedAt = Date.parse(String(proof.checkedAt || ''));
    const evidenceHash = `sha256:${createHash('sha256').update(stableJson(semantic)).digest('hex')}`;
    return Boolean(target)
      && proof.absent === true
      && proof.status === 'CONFIRMED_ABSENT'
      && semantic.storeConfigVersion === target!.configVersion
      && semantic.credentialVersionId === target!.credentialVersionId
      && stableJson(offerIds) === stableJson(target!.expectedOfferIds)
      && Number.isFinite(checkedAt)
      && Number.isFinite(proofStartedAt)
      && checkedAt >= proofStartedAt - 5_000
      && checkedAt >= now - 5 * 60_000
      && checkedAt <= now + 5_000
      && validOzonPrePlanAbsenceOperations(operations)
      && String(proof.evidenceHash || '') === evidenceHash;
  });
  if (canonical.schemaVersion !== 2 || canonical.recoveryMode !== 'PRE_PLAN'
    || canonical.jobId !== input.jobId || canonical.sku !== input.sku
    || calculatedPlanHash !== input.planHash
    || deterministicOzonPrePlanRequestId(input.jobId, input.planHash) !== input.requestId
    || checks.noPlatformEvidence !== true || media.ownershipValid !== true || manifest.valid !== true
    || String(manifest.signature || '') !== input.manifestSignature
    || jsonObject(checks.contentPolicy).valid !== true || stores.ready !== true
    || remote.status !== 'CONFIRMED_ABSENT' || localBlockers.length > 0
    || stableJson(productIdentity) !== stableJson(input.productIdentity)
    || stableJson(expectedTargets) !== stableJson(submittedTargets)
    || !submittedTargets.length || submittedTargets.some((target) => !target.id
      || !target.credentialVersionId || !target.presetId || !ozonPrePlanArray(target.expectedOfferIds).length)
    || stableJson(expectedMedia) !== stableJson(submittedMedia)
    || !submittedMedia.length || submittedMedia.some((delivery) => !delivery.sourceStageId
      || !delivery.submissionId || !delivery.jobId || !/^sha256:[a-f0-9]{64}$/.test(String(delivery.payloadHash || '')))
    || !Number.isFinite(Date.parse(input.eligibilityAt)) || latestDelivery !== input.eligibilityAt
    || !proofsValid) {
    throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 冻结恢复证据合同无效或已过期', {
      jobId: input.jobId,
      calculatedPlanHash,
      planHash: input.planHash
    }, 409);
  }
}

async function selectExactEligiblePrePlanStoreIds(client: Pick<PoolClient, 'query'>, eligibilityAt: string): Promise<string[]> {
  const result = await client.query<{ id: string }>(`SELECT s.id FROM ozon_stores s
    WHERE s.enabled=true AND s.auto_publish_enabled=true AND s.archived_at IS NULL
      AND s.auto_publish_activated_at IS NOT NULL
      AND s.auto_publish_activated_at<=$1::timestamptz
      AND s.active_credential_version_id IS NOT NULL
      AND s.credential_binding_mode='VAULT'
      AND s.default_preset_id IS NOT NULL
      AND s.preflight_status='PASSED'
      AND s.preflight_expires_at>NOW()
      AND s.seller_id<>''
      AND s.warehouse_id<>''
      AND COALESCE(s.preflight_report->'currencyVerification'->>'status','')='VERIFIED'
      AND COALESCE(s.preflight_report->'currencyVerification'->>'currency','')=s.account_currency
      AND NOT EXISTS(SELECT 1 FROM ozon_stores duplicate
        WHERE duplicate.id<>s.id AND duplicate.enabled=true AND duplicate.archived_at IS NULL
          AND duplicate.seller_id<>'' AND duplicate.seller_id=s.seller_id)
    ORDER BY s.id FOR SHARE OF s`, [eligibilityAt]);
  return result.rows.map((row) => String(row.id)).sort();
}

async function assertOzonPrePlanPersistenceAuthoritiesWithClient(input: {
  client: PoolClient;
  job: SqlRow;
  listing: SqlRow | undefined;
  sku: string;
  mediaSignature: string;
  proposedProductName: string;
  proposedData: OzonListingDraft['data'];
}): Promise<void> {
  const payload = jsonObject(input.job.payload);
  const recovery = jsonObject(payload.prePlanRecovery);
  if (!Object.keys(recovery).length) return;
  const evidence = jsonObject(recovery.evidence);
  const checks = jsonObject(evidence.checks);
  const media = jsonObject(checks.media);
  const stableMaterial = jsonObject(checks.stableMaterial);
  const targetStores = ozonPrePlanArray(recovery.targetStores).map(canonicalOzonPrePlanTarget) as OzonPrePlanFrozenTarget[];
  const expectedMedia = ozonPrePlanArray(media.evidence).map(canonicalOzonPrePlanMediaDelivery);
  const eligibilityAt = expectedMedia.map((entry) => String(entry.deliveredAt || '')).sort().at(-1) || '';
  const productIdentity = jsonObject(recovery.productIdentity);
  const manifestSignature = String(recovery.manifestSignature || '');
  assertOzonPrePlanRecoveryContract({
    jobId: String(input.job.id),
    sku: input.sku,
    planHash: String(recovery.planHash || ''),
    requestId: String(recovery.requestId || ''),
    evidence,
    productIdentity,
    manifestSignature,
    mediaDeliveries: expectedMedia,
    targetStores,
    eligibilityAt
  });
  if (input.mediaSignature !== manifestSignature
    || !input.listing
    || Number(input.listing.row_version) !== Number(stableMaterial.currentRowVersion)
    || Number(input.listing.revision) !== Number(stableMaterial.currentRevision)
    || String(input.listing.management_source || '') !== 'AUTO'
    || Object.keys(jsonObject(payload.networkRecovery)).length
    || input.job.directory_signature
    || ozonPrePlanPayloadHasWriteCheckpoint(payload)
    || input.job.import_task_id || input.job.ozon_product_id
    || ['PROCESSING', 'SUCCESS'].includes(String(input.job.directory_stage || '').toUpperCase())) {
    throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 在生成稳定版本前已出现本地证据漂移', {
      jobId: input.job.id,
      sku: input.sku
    }, 409);
  }
  const frozenListingData = jsonObject(jsonObject(checks.stableMaterial).data);
  const proposedProjection = projectOzonSharedMaterialDraft({
    ...toListing(input.listing),
    productName: input.proposedProductName,
    rowVersion: Number(input.listing.row_version) + 1,
    revision: Number(input.listing.revision) + 1,
    data: input.proposedData
  }, OZON_CONTENT_POLICY_VERSION);
  const frozenProjection = projectOzonSharedMaterialDraft({
    ...toListing(input.listing),
    productName: String(productIdentity.productName || ''),
    rowVersion: Number(input.listing.row_version) + 1,
    revision: Number(input.listing.revision) + 1,
    data: frozenListingData as OzonListingDraft['data']
  }, OZON_CONTENT_POLICY_VERSION);
  if (canonicalOzonSharedMaterialJson(proposedProjection) !== canonicalOzonSharedMaterialJson(frozenProjection)) {
    throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 待写入公共素材与 dry-run 冻结素材不一致', {
      jobId: input.job.id,
      sku: input.sku
    }, 409);
  }

  const productResult = await input.client.query<SqlRow>(
    'SELECT sku,product_name FROM products WHERE sku=$1 FOR SHARE',
    [input.sku]
  );
  const variantResult = await input.client.query<SqlRow>(`SELECT
      id,name,sort_order,created_at,
      wb_color_key,wb_color_name_ru,wb_color_name_zh,
      ozon_color_item_key,ozon_color_dictionary_id,ozon_color_value_id,
      ozon_color_name_ru,ozon_color_name_zh,ozon_color_source
    FROM product_variants WHERE sku=$1 ORDER BY sort_order ASC,created_at ASC FOR SHARE`, [input.sku]);
  const product = productResult.rows[0];
  const currentIdentity = product ? {
    sku: String(product.sku).trim(),
    productName: String(product.product_name),
    variants: variantResult.rows.map((variant) => ({
      variantId: String(variant.id),
      name: String(variant.name),
      ...(variant.wb_color_key && variant.wb_color_name_ru && variant.wb_color_name_zh ? {
        wbColor: {
          colorKey: String(variant.wb_color_key),
          nameRu: String(variant.wb_color_name_ru),
          nameZh: String(variant.wb_color_name_zh)
        }
      } : {}),
      ...(variant.ozon_color_item_key && variant.ozon_color_dictionary_id && variant.ozon_color_value_id
        && variant.ozon_color_name_ru && variant.ozon_color_name_zh && variant.ozon_color_source ? {
          ozonColor: {
            itemKey: String(variant.ozon_color_item_key),
            dictionaryId: Number(variant.ozon_color_dictionary_id),
            valueId: Number(variant.ozon_color_value_id),
            nameRu: String(variant.ozon_color_name_ru),
            nameZh: String(variant.ozon_color_name_zh),
            source: String(variant.ozon_color_source)
          }
        } : {})
    }))
  } : undefined;
  if (!currentIdentity || stableJson(currentIdentity) !== stableJson(productIdentity)) {
    throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 产品身份在生成稳定版本前已变化', { sku: input.sku }, 409);
  }

  const mediaRows = await input.client.query<SqlRow>(`SELECT *,updated_at::text AS updated_at_exact FROM ozon_media_deliveries
    WHERE sku=$1 ORDER BY source_stage_id,submission_id,variant_id FOR UPDATE`, [input.sku]);
      for (const expected of expectedMedia) {
        const row = mediaRows.rows.find((candidate) => String(candidate.source_stage_id) === expected.sourceStageId
          && String(candidate.submission_id) === expected.submissionId
          && String(candidate.variant_id || '') === String(expected.variantId || ''));
        const deliveryPayload = jsonObject(row?.payload);
        const deliveredAt = Date.parse(String(deliveryPayload.deliveredAt || ''));
        const updatedAtValue = String(row?.updated_at_exact || row?.updated_at || '');
        const updatedAt = Date.parse(updatedAtValue);
        const actualPayloadHash = automaticMediaPayloadHash(row?.payload);
        const actualDeliveredAt = Number.isFinite(deliveredAt) ? new Date(deliveredAt).toISOString() : '';
        const actualUpdatedAt = Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : '';
        const failedChecks = [
          !row ? 'ROW_MISSING' : '',
          String(row?.job_id || '') !== expected.jobId ? 'JOB_OWNER' : '',
          !['ACCEPTED', 'DEFERRED', 'FANNED_OUT'].includes(String(deliveryPayload.autoPublishDecision || '').toUpperCase()) ? 'DECISION' : '',
          actualPayloadHash !== expected.payloadHash ? 'PAYLOAD_HASH' : '',
          !sameOzonPrePlanTimestamp(actualDeliveredAt, expected.deliveredAt) ? 'DELIVERED_AT' : '',
          !sameOzonPrePlanTimestamp(actualUpdatedAt, expected.updatedAt) ? 'UPDATED_AT' : ''
        ].filter(Boolean);
        if (failedChecks.length) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON PRE_PLAN 媒体账本在生成稳定版本前已变化', {
            sku: input.sku,
            sourceStageId: expected.sourceStageId,
            submissionId: expected.submissionId,
            variantId: expected.variantId,
            failedChecks,
            expected: {
              jobId: expected.jobId,
              payloadHash: expected.payloadHash,
              deliveredAt: expected.deliveredAt,
              updatedAt: expected.updatedAt
            },
            actual: {
              jobId: String(row?.job_id || ''),
              payloadHash: actualPayloadHash,
              deliveredAt: actualDeliveredAt,
              updatedAt: actualUpdatedAt,
              decision: String(deliveryPayload.autoPublishDecision || '').toUpperCase()
            }
          }, 409);
        }
      }

  const storeIds = targetStores.map((store) => String(store.id));
  const stores = await input.client.query<SqlRow>(`SELECT s.* FROM ozon_stores s
    WHERE s.id=ANY($1::uuid[]) ORDER BY s.id FOR UPDATE`, [storeIds]);
  const eligibleStoreIds = await selectExactEligiblePrePlanStoreIds(input.client, eligibilityAt);
  if (stores.rows.length !== targetStores.length
    || stableJson(eligibleStoreIds) !== stableJson([...storeIds].sort())) {
    throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 目标店铺集合在生成稳定版本前已变化', { storeIds }, 409);
  }
  const presetIds = targetStores.map((store) => String(store.presetId));
  const presets = await input.client.query<SqlRow>(`SELECT id,row_version,definition FROM ozon_listing_presets
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [presetIds]);
  const credentialIds = targetStores.map((store) => String(store.credentialVersionId));
  const credentials = await input.client.query<SqlRow>(`SELECT id,store_id,status FROM ozon_store_credential_versions
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [credentialIds]);
  for (const expected of targetStores) {
    const store = stores.rows.find((candidate) => String(candidate.id) === expected.id);
    const preset = presets.rows.find((candidate) => String(candidate.id) === expected.presetId);
    const credential = credentials.rows.find((candidate) => String(candidate.id) === expected.credentialVersionId);
    if (!store || Number(store.row_version) !== expected.rowVersion
      || Number(store.config_version) !== expected.configVersion
      || String(store.active_credential_version_id || '') !== expected.credentialVersionId
      || String(store.credential_binding_mode || '') !== 'VAULT'
      || String(store.default_preset_id || '') !== expected.presetId
      || !preset || Number(preset.row_version) !== expected.presetRowVersion
      || `sha256:${createHash('sha256').update(stableJson(jsonObject(preset.definition))).digest('hex')}` !== expected.presetSnapshotHash
      || !credential || String(credential.store_id) !== expected.id || String(credential.status) !== 'ACTIVE'
      || String(store.auto_publish_mode || '') !== expected.publicationMode
      || String(store.warehouse_id || '') !== expected.warehouseId
      || String(store.fulfillment_mode || '') !== expected.fulfillmentMode
      || String(store.account_currency || '') !== expected.accountCurrency) {
      throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 店铺冻结合同在生成稳定版本前已变化', {
        storeId: expected.id
      }, 409);
    }
  }
  const platformEvidence = await getAutomaticPreparationRecoveryEvidenceWithClient(input.client, String(input.job.id));
  if (platformEvidence.publicationCount || platformEvidence.mappingCount || platformEvidence.gatewayRequestCount
    || platformEvidence.productLinkCount || platformEvidence.importIntentPresent || platformEvidence.platformWriteAttempted
    || platformEvidence.activeLease || platformEvidence.activeSlot || platformEvidence.activeStatusRefresh) {
    throw new AppError('OZON_READBACK_REQUIRED', 'OZON PRE_PLAN 在生成稳定版本前出现平台或活动租约证据', {
      jobId: input.job.id,
      evidence: platformEvidence
    }, 409);
  }
}

async function getAutomaticPreparationRecoveryEvidenceWithClient(
  client: Pick<PoolClient, 'query'> | Pool,
  jobId: string
): Promise<OzonAutomaticPreparationRecoveryEvidence> {
  const result = await client.query<SqlRow>(`SELECT
      COALESCE((SELECT COUNT(*) FROM ozon_store_publications p WHERE p.preparation_job_id=j.id),0)::integer publication_count,
      COALESCE((SELECT COUNT(*) FROM ozon_product_mappings m WHERE m.sku=j.sku),0)::integer mapping_count,
      COALESCE((SELECT COUNT(*) FROM ozon_gateway_requests g
        WHERE g.task_id=j.task_id
           OR g.publication_id IN (SELECT p.id FROM ozon_store_publications p WHERE p.preparation_job_id=j.id)),0)::integer gateway_request_count,
      CASE WHEN jsonb_typeof(j.product_links)='array' THEN jsonb_array_length(j.product_links) ELSE 0 END product_link_count,
      (COALESCE(j.payload,'{}'::jsonb) ? 'importIntent') import_intent_present,
      COALESCE((j.payload->>'platformWriteAttempted')::boolean,false) platform_write_attempted,
      (j.lease_expires_at>NOW()) active_lease,
      EXISTS(SELECT 1 FROM ozon_publish_slots s WHERE s.job_id=j.id AND s.lease_expires_at>NOW()) active_slot,
      EXISTS(SELECT 1 FROM ozon_platform_status_refresh_leases r WHERE r.sku=j.sku AND r.lease_expires_at>NOW()) active_status_refresh
    FROM ozon_publish_jobs j WHERE j.id=$1`, [jobId]);
  const row = result.rows[0];
  if (!row) throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId }, 404);
  return {
    publicationCount: Number(row.publication_count || 0),
    mappingCount: Number(row.mapping_count || 0),
    gatewayRequestCount: Number(row.gateway_request_count || 0),
    productLinkCount: Number(row.product_link_count || 0),
    importIntentPresent: Boolean(row.import_intent_present),
    platformWriteAttempted: Boolean(row.platform_write_attempted),
    activeLease: Boolean(row.active_lease),
    activeSlot: Boolean(row.active_slot),
    activeStatusRefresh: Boolean(row.active_status_refresh)
  };
}

async function getAutomaticPreparationReplanEvidenceWithClient(
  client: Pick<PoolClient, 'query'> | Pool,
  jobId: string,
  options: { lock?: boolean } = {}
): Promise<OzonAutomaticPreparationReplanEvidence> {
  const lock = options.lock ? ' FOR UPDATE' : '';
  const parentResult = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE id=$1${lock}`, [jobId]);
  const parent = parentResult.rows[0];
  if (!parent) throw new AppError('NOT_FOUND', 'OZON 自动准备任务不存在', { jobId }, 404);
  const payload = jsonObject(parent.payload);
  const fanoutPlan = jsonObject(payload.fanoutPlan);
  const publications = (await client.query<SqlRow>(`SELECT * FROM ozon_store_publications
    WHERE preparation_job_id=$1 ORDER BY store_id,id${lock}`, [jobId])).rows;
  const publicationIds = publications.map((row) => String(row.id));
  const publicationJobs = publicationIds.length
    ? (await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs
        WHERE publication_id=ANY($1::uuid[]) ORDER BY publication_id,id${lock}`, [publicationIds])).rows
    : [];
  const publicationJobIds = publicationJobs.map((row) => String(row.id));
  const allJobIds = [jobId, ...publicationJobIds];
  const mediaRows = (await client.query<SqlRow>(`SELECT * FROM ozon_media_deliveries
    WHERE job_id=$1 AND sku=$2 ORDER BY source_stage_id,submission_id,variant_id${lock}`, [jobId, parent.sku])).rows;
  const gatewayRequestCount = Number((await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_gateway_requests
      WHERE publication_id=ANY($1::uuid[]) OR task_id=ANY($2::text[])`, [
    publicationIds,
    [String(parent.task_id || ''), ...publicationJobs.map((row) => String(row.task_id || ''))].filter(Boolean)
  ])).rows[0]?.count || 0);
  const mappingCount = Number((await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_product_mappings
    WHERE sku=$1 AND (NULLIF(ozon_product_id,'') IS NOT NULL OR NULLIF(ozon_sku,'') IS NOT NULL
      OR last_verified_at IS NOT NULL)`, [parent.sku])).rows[0]?.count || 0);
  const activeSlotCount = Number((await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_publish_slots
    WHERE job_id=ANY($1::uuid[]) AND lease_expires_at>NOW()`, [allJobIds])).rows[0]?.count || 0);
  const activeStatusRefreshCount = Number((await client.query<{ count: string }>(`SELECT COUNT(*) count
    FROM ozon_platform_status_refresh_leases WHERE sku=$1 AND lease_expires_at>NOW()`, [parent.sku])).rows[0]?.count || 0);

  const blockers: string[] = [];
  if (String(parent.source) !== 'AUTO' || String(parent.task_kind) !== 'SHARED_PREPARATION'
    || payload.multistorePreparation !== true) blockers.push('TASK_NOT_SHARED_AUTOMATIC_PREPARATION');
  if (!['NEEDS_ATTENTION', 'FAILED'].includes(String(parent.state))) blockers.push('PREPARATION_STATE_NOT_REPLANABLE');
  if (!/^sha256:[a-f0-9]{64}$/.test(String(fanoutPlan.planHash || ''))) blockers.push('FROZEN_FANOUT_PLAN_MISSING');
  if (parent.import_task_id || parent.ozon_product_id || parent.directory_signature
    || ['PROCESSING', 'SUCCESS'].includes(String(parent.directory_stage || '').toUpperCase())
    || payload.platformWriteAttempted === true || Object.keys(jsonObject(payload.networkRecovery)).length
    || ozonPrePlanPayloadHasWriteCheckpoint(payload)) blockers.push('PREPARATION_REMOTE_OR_PACKAGE_EVIDENCE_PRESENT');
  if (!publications.length) blockers.push('LOCAL_VALIDATION_PUBLICATION_MISSING');
  if (publicationJobs.length !== publications.length) blockers.push('PUBLICATION_JOB_SET_INCOMPLETE');

  for (const publication of publications) {
    if (String(publication.source) !== 'AUTOMATION'
      || String(publication.status) !== 'NEEDS_ATTENTION'
      || publication.package_rel_path || publication.package_signature
      || (Array.isArray(publication.product_ids) ? publication.product_ids.length : 0)
      || (Array.isArray(publication.ozon_skus) ? publication.ozon_skus.length : 0)
      || (Array.isArray(publication.product_links) ? publication.product_links.length : 0)
      || Object.keys(jsonObject(publication.materialized_product_snapshot)).length) {
      blockers.push(`PUBLICATION_NOT_LOCAL_VALIDATION_ONLY:${String(publication.id)}`);
    }
  }
  for (const job of publicationJobs) {
    const childPayload = jsonObject(job.payload);
    if (!['NEEDS_ATTENTION', 'FAILED'].includes(String(job.state))
      || String(job.task_kind) !== 'STORE_PUBLICATION'
      || String(childPayload.attemptPhase || '') !== 'LOCAL_VALIDATION'
      || job.import_task_id || job.ozon_product_id || job.directory_signature
      || ['PROCESSING', 'SUCCESS'].includes(String(job.directory_stage || '').toUpperCase())
      || (Array.isArray(job.product_links) ? job.product_links.length : 0)
      || childPayload.platformWriteAttempted === true
      || Object.keys(jsonObject(childPayload.networkRecovery)).length
      || ozonPrePlanPayloadHasWriteCheckpoint(childPayload)) {
      blockers.push(`PUBLICATION_JOB_NOT_LOCAL_VALIDATION_ONLY:${String(job.id)}`);
    }
  }
  for (const media of mediaRows) {
    const mediaPayload = jsonObject(media.payload);
    if (!['ACCEPTED', 'DEFERRED'].includes(String(mediaPayload.autoPublishDecision || '').toUpperCase())
      || normalizeOfferIds(mediaPayload.fanoutPublicationIds).length
      || normalizeOfferIds(mediaPayload.fanoutStoreIds).length) {
      blockers.push(`MEDIA_LEDGER_NOT_REPLANABLE:${String(media.source_stage_id)}:${String(media.submission_id)}:${String(media.variant_id || '')}`);
    }
  }
  if (!mediaRows.length) blockers.push('MEDIA_LEDGER_MISSING');
  if (gatewayRequestCount) blockers.push('GATEWAY_EVIDENCE_PRESENT');
  if (mappingCount) blockers.push('PRODUCT_MAPPING_EVIDENCE_PRESENT');
  if (activeSlotCount) blockers.push('ACTIVE_RUNTIME_SLOT_PRESENT');
  if (activeStatusRefreshCount) blockers.push('ACTIVE_STATUS_REFRESH_PRESENT');
  const jobsWithActiveLease = [parent, ...publicationJobs].filter((row) => (
    Boolean(row.lease_owner || row.lease_token)
      || (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now())
  ));
  if (jobsWithActiveLease.length) blockers.push('ACTIVE_JOB_LEASE_PRESENT');

  const productLinkCount = (Array.isArray(parent.product_links) ? parent.product_links.length : 0)
    + publications.reduce((sum, row) => sum + (Array.isArray(row.product_links) ? row.product_links.length : 0), 0)
    + publicationJobs.reduce((sum, row) => sum + (Array.isArray(row.product_links) ? row.product_links.length : 0), 0);
  if (productLinkCount) blockers.push('PRODUCT_LINK_EVIDENCE_PRESENT');
  const storeIds = [...new Set(publications.map((row) => String(row.store_id || '')).filter(Boolean))].sort();
  const canonical = {
    schemaVersion: 1,
    recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
    parent: {
      id: String(parent.id),
      sku: String(parent.sku),
      rowVersion: Number(parent.row_version),
      state: String(parent.state),
      fanoutPlanHash: String(fanoutPlan.planHash || '')
    },
    publications: publications.map((row) => ({
      id: String(row.id), storeId: String(row.store_id), rowVersion: Number(row.row_version),
      status: String(row.status), planHash: String(row.plan_hash || ''),
      plannedJobId: String(row.planned_job_id || ''), errorCode: String(row.error_code || '')
    })),
    publicationJobs: publicationJobs.map((row) => ({
      id: String(row.id), publicationId: String(row.publication_id), rowVersion: Number(row.row_version),
      state: String(row.state), taskId: String(row.task_id || ''),
      attemptPhase: String(jsonObject(row.payload).attemptPhase || ''), errorCode: String(row.last_error_code || '')
    })),
    media: mediaRows.map((row) => ({
      sourceStageId: String(row.source_stage_id), submissionId: String(row.submission_id),
      variantId: String(row.variant_id || ''), decision: String(jsonObject(row.payload).autoPublishDecision || ''),
      payloadHash: automaticMediaPayloadHash(row.payload)
    })),
    gatewayRequestCount,
    mappingCount,
    productLinkCount,
    activeLeaseCount: jobsWithActiveLease.length,
    activeSlotCount,
    activeStatusRefreshCount,
    blockers: [...new Set(blockers)].sort()
  };
  return {
    safe: blockers.length === 0,
    blockers: [...new Set(blockers)],
    evidenceHash: `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`,
    originalJobId: String(parent.id),
    originalJobRowVersion: Number(parent.row_version),
    originalFanoutPlanHash: String(fanoutPlan.planHash || ''),
    publicationIds,
    publicationJobIds,
    storeIds,
    publicationCount: publications.length,
    publicationJobCount: publicationJobs.length,
    gatewayRequestCount,
    mappingCount,
    productLinkCount,
    mediaDeliveryCount: mediaRows.length,
    activeLeaseCount: jobsWithActiveLease.length,
    activeSlotCount,
    activeStatusRefreshCount
  };
}

async function assertAutomaticPreparationReplanTargets(
  client: PoolClient,
  input: OzonAutomaticPreparationReplanApplyInput
): Promise<void> {
  const targets = input.targetStores;
  const storeIds = targets.map((target) => target.id);
  if (new Set(storeIds).size !== storeIds.length
    || targets.some((target) => !target.expectedOfferIds.length
      || new Set(target.expectedOfferIds).size !== target.expectedOfferIds.length
      || !target.credentialVersionId || !target.presetId || !target.presetDefinitionHash || !target.presetSnapshotHash
      || !target.categoryKey
      || !/^[0-9a-f-]{36}$/i.test(target.expectedPublishedCategoryVersionId)
      || !/^sha256:[a-f0-9]{64}$/.test(target.expectedProductSnapshotHash)
      || !/^sha256:[a-f0-9]{64}$/.test(target.expectedProductContractHash)
      || !/^sha256:[a-f0-9]{64}$/.test(target.expectedModeEvidenceHash))) {
    throw new AppError('CONFIG_INVALID', 'OZON 当前预设重建目标合同不完整', { storeIds }, 409);
  }
  const stores = await client.query<SqlRow>(`SELECT * FROM ozon_stores
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [storeIds]);
  const presetIds = targets.map((target) => target.presetId);
  const presets = await client.query<SqlRow>(`SELECT id,row_version,definition FROM ozon_listing_presets
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [presetIds]);
  const credentialIds = targets.map((target) => target.credentialVersionId);
  const credentials = await client.query<SqlRow>(`SELECT id,store_id,status FROM ozon_store_credential_versions
    WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [credentialIds]);
  const categoryKeys = [...new Set(targets.map((target) => target.categoryKey))];
  const categories = await client.query<SqlRow>(`SELECT category_key,published_version_id FROM ozon_category_templates
    WHERE category_key=ANY($1::text[]) ORDER BY category_key FOR SHARE`, [categoryKeys]);
  const settings = (await client.query<SqlRow>(`SELECT row_version,root_directory FROM ozon_system_settings
    WHERE id='default' FOR SHARE`)).rows[0];
  if (stores.rows.length !== targets.length || presets.rows.length !== new Set(presetIds).size
    || credentials.rows.length !== targets.length || categories.rows.length !== categoryKeys.length || !settings) {
    throw new AppError('VERSION_CONFLICT', 'OZON 当前预设重建目标集合已变化', { storeIds }, 409);
  }
  const rootDirectoryHash = `sha256:${createHash('sha256').update(stableJson(String(settings.root_directory || ''))).digest('hex')}`;
  if (Number(settings.row_version) !== input.expectedSettingsRowVersion
    || rootDirectoryHash !== input.expectedRootDirectoryHash) {
    throw new AppError('VERSION_CONFLICT', 'OZON 全局设置或发布根目录在重建提交前已变化', {
      expectedSettingsRowVersion: input.expectedSettingsRowVersion,
      actualSettingsRowVersion: Number(settings.row_version)
    }, 409);
  }
  for (const expected of targets) {
    const store = stores.rows.find((row) => String(row.id) === expected.id);
    const preset = presets.rows.find((row) => String(row.id) === expected.presetId);
    const credential = credentials.rows.find((row) => String(row.id) === expected.credentialVersionId);
    const category = categories.rows.find((row) => String(row.category_key) === expected.categoryKey);
    const presetSnapshotHash = preset
      ? `sha256:${createHash('sha256').update(stableJson(jsonObject(preset.definition))).digest('hex')}`
      : '';
    if (!store || Number(store.row_version) !== expected.rowVersion
      || Number(store.config_version) !== expected.configVersion
      || String(store.active_credential_version_id || '') !== expected.credentialVersionId
      || String(store.credential_binding_mode || '') !== 'VAULT'
      || String(store.default_preset_id || '') !== expected.presetId
      || !preset || Number(preset.row_version) !== expected.presetRowVersion
      || presetSnapshotHash !== expected.presetSnapshotHash
      || !credential || String(credential.store_id) !== expected.id || String(credential.status) !== 'ACTIVE'
      || !category || String(category.published_version_id || '') !== expected.expectedPublishedCategoryVersionId
      || String(store.auto_publish_mode || '') !== expected.publicationMode
      || String(store.warehouse_id || '') !== expected.warehouseId
      || String(store.fulfillment_mode || '') !== expected.fulfillmentMode
      || String(store.account_currency || '') !== expected.accountCurrency
      || store.enabled !== true || store.auto_publish_enabled !== true || store.archived_at) {
      throw new AppError('VERSION_CONFLICT', 'OZON 店铺、凭据或当前预设在重建提交前已变化', {
        storeId: expected.id
      }, 409);
    }
  }
}

function deterministicOzonPreparationReplacementJobId(jobId: string, requestId: string): string {
  const hex = createHash('sha256').update(`ozon-preparation-replacement\u0000${jobId}\u0000${requestId}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function ozonPrePlanPayloadHasWriteCheckpoint(payloadInput: unknown): boolean {
  const payload = jsonObject(payloadInput);
  return [
    'importIntent', 'importTaskId', 'productJsonGenerated', 'productJsonPath',
    'packageSignature', 'directorySignature', 'platformWriteAttempted',
    'gatewayUnknown', 'gatewayRequestRef', 'priceStockWriteProgress'
  ].some((key) => {
    const value = payload[key];
    return value !== undefined && value !== null && value !== false && value !== ''
      && (!Array.isArray(value) || value.length > 0)
      && (typeof value !== 'object' || Array.isArray(value) || Object.keys(jsonObject(value)).length > 0);
  });
}

type FrozenOzonOfferContract = {
  offerContractVersion: 1;
  offerContractHash: string;
  expectedOfferIds: string[];
  submittedOfferIds: string[];
  publishOfferIds: string[];
  expectedOfferSnapshots: unknown[];
};

const OZON_OFFER_CONTRACT_KEYS = [
  'offerContractVersion',
  'offerContractHash',
  'expectedOfferIds',
  'submittedOfferIds',
  'publishOfferIds',
  'expectedOfferSnapshots'
] as const;

function strictOfferIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new AppError('CONFIG_INVALID', `OZON ${field} 必须是字符串数组`, undefined, 409);
  const normalized = value.map((entry) => String(entry || '').trim());
  if (!normalized.length || normalized.some((offerId) => !offerId) || new Set(normalized).size !== normalized.length) {
    throw new AppError('CONFIG_INVALID', `OZON ${field} 为空、重复或包含无效 Offer ID`, undefined, 409);
  }
  return normalized;
}

function readFrozenOzonOfferContract(payload: Record<string, unknown>): FrozenOzonOfferContract | undefined {
  // schema-v3 multistore publications always carry offerContractHash as an
  // immutable store/publication binding. That hash alone is not the legacy
  // six-field dual-set contract. Only semantic dual-set fields opt into that
  // contract; once one appears, all six fields remain mandatory.
  const semanticKeys = OZON_OFFER_CONTRACT_KEYS.filter((key) => key !== 'offerContractHash');
  const semanticPresent = semanticKeys.map((key) => payload[key] !== undefined);
  if (semanticPresent.every((value) => !value)) {
    const hashOnlySchemaV3Publication = payload.offerContractHash !== undefined
      && Number(payload.schemaVersion) >= 3
      && payload.mode === 'MULTISTORE_PUBLICATION';
    if (payload.offerContractHash === undefined || hashOnlySchemaV3Publication) return undefined;
    throw new AppError('CONFIG_INVALID', 'OZON 双集合 Offer 合同字段不完整或版本无效', undefined, 409);
  }
  const present = OZON_OFFER_CONTRACT_KEYS.map((key) => payload[key] !== undefined);
  if (present.some((value) => !value) || payload.offerContractVersion !== 1) {
    throw new AppError('CONFIG_INVALID', 'OZON 双集合 Offer 合同字段不完整或版本无效', undefined, 409);
  }
  const expectedOfferIds = strictOfferIdArray(payload.expectedOfferIds, 'expectedOfferIds');
  const submittedOfferIds = strictOfferIdArray(payload.submittedOfferIds, 'submittedOfferIds');
  const publishOfferIds = strictOfferIdArray(payload.publishOfferIds, 'publishOfferIds');
  if (stableJson(submittedOfferIds) !== stableJson(publishOfferIds)
    || submittedOfferIds.some((offerId) => !expectedOfferIds.includes(offerId))) {
    throw new AppError('CONFIG_INVALID', 'OZON submitted/publish 集合与 expected 集合不一致', undefined, 409);
  }
  if (!Array.isArray(payload.expectedOfferSnapshots)) {
    throw new AppError('CONFIG_INVALID', 'OZON expectedOfferSnapshots 必须是数组', undefined, 409);
  }
  const snapshotIds = payload.expectedOfferSnapshots.map((snapshot) => String(jsonObject(snapshot).offerId || '').trim());
  if (stableJson(snapshotIds) !== stableJson(expectedOfferIds)) {
    throw new AppError('CONFIG_INVALID', 'OZON expectedOfferSnapshots 与 expectedOfferIds 不一致', undefined, 409);
  }
  const contractBody = {
    offerContractVersion: 1,
    expectedOfferIds,
    submittedOfferIds,
    publishOfferIds,
    expectedOfferSnapshots: payload.expectedOfferSnapshots
  };
  const offerContractHash = String(payload.offerContractHash || '');
  const actualHash = `sha256:${createHash('sha256').update(stableJson(contractBody)).digest('hex')}`;
  if (offerContractHash !== actualHash) {
    throw new AppError('CONFIG_INVALID', 'OZON 双集合 Offer 合同哈希不匹配', undefined, 409);
  }
  return {
    offerContractVersion: 1,
    offerContractHash,
    expectedOfferIds,
    submittedOfferIds,
    publishOfferIds,
    expectedOfferSnapshots: payload.expectedOfferSnapshots
  };
}

function isHashOnlySchemaV3PublicationPayload(payload: Record<string, unknown>): boolean {
  return Number(payload.schemaVersion) >= 3
    && payload.mode === 'MULTISTORE_PUBLICATION'
    && payload.offerContractHash !== undefined
    && OZON_OFFER_CONTRACT_KEYS
      .filter((key) => key !== 'offerContractHash')
      .every((key) => payload[key] === undefined);
}

export function assertOzonOfferContractTransition(
  currentPayload: Record<string, unknown>,
  incomingPayload: Record<string, unknown>,
  proposedOfferIds?: unknown
): FrozenOzonOfferContract | undefined {
  const current = readFrozenOzonOfferContract(currentPayload);
  const incomingSemanticKeys = OZON_OFFER_CONTRACT_KEYS.filter((key) => key !== 'offerContractHash');
  const incomingIsBindingProjection = isHashOnlySchemaV3PublicationPayload(currentPayload)
    && incomingPayload.offerContractHash !== undefined
    && incomingSemanticKeys.every((key) => incomingPayload[key] === undefined);
  if (incomingIsBindingProjection
    && String(incomingPayload.offerContractHash) !== String(currentPayload.offerContractHash)) {
    throw new AppError('VERSION_CONFLICT', 'OZON publication binding Offer 哈希不允许修改', undefined, 409);
  }
  const incoming = incomingIsBindingProjection ? undefined : readFrozenOzonOfferContract(incomingPayload);
  const contract = current || incoming;
  if (!contract) return undefined;
  if (current && incoming) {
    for (const key of OZON_OFFER_CONTRACT_KEYS) {
      if (stableJson(incomingPayload[key]) !== stableJson(currentPayload[key])) {
        throw new AppError('VERSION_CONFLICT', `OZON 已冻结 Offer 合同字段 ${key} 不允许修改`, undefined, 409);
      }
    }
  }
  if (proposedOfferIds !== undefined
    && stableJson(strictOfferIdArray(proposedOfferIds, 'offerIds')) !== stableJson(contract.expectedOfferIds)) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务 offerIds 不允许缩小或扩展已冻结 expectedOfferIds', undefined, 409);
  }
  return contract;
}

type KnownPrePlatformRecoveryValidation = {
  proposed: OzonKnownPrePlatformFailureRecoveryResult['proposed'];
  nextPresetBinding?: Record<string, unknown>;
  identityEvidence?: Record<string, unknown>;
};

function validateImportIntentUrlMissingRecovery(
  jobRow: SqlRow,
  listingRow: SqlRow | undefined,
  input: OzonKnownPrePlatformFailureRecoveryInput,
  failureHistory: SqlRow[] = []
): KnownPrePlatformRecoveryValidation {
  if (!listingRow) {
    throw new AppError('CONFIG_INVALID', '导入意图 URL 故障恢复要求原任务草稿仍然存在', { id: jobRow.id }, 409);
  }
  if (!Number.isInteger(input.listingRowVersion) || Number(input.listingRowVersion) < 1) {
    throw new AppError('CONFIG_INVALID', '导入意图 URL 故障恢复缺少 listingRowVersion', { id: jobRow.id }, 400);
  }
  if (Number(listingRow.row_version) !== input.listingRowVersion) {
    throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', {
      sku: jobRow.sku,
      expected: Number(listingRow.row_version),
      actual: input.listingRowVersion
    }, 409);
  }
  const payload = jsonObject(jobRow.payload);
  const revision = Number(jobRow.listing_revision || 0);
  const offerIds = normalizeOfferIds(jobRow.offer_ids);
  const listingOfferIds = normalizeOfferIds(
    Array.isArray(listingRow.data?.offers)
      ? listingRow.data.offers.map((offer: Record<string, unknown>) => offer.offerId)
      : []
  );
  const expectedFolder = revision > 0 ? `${jobRow.sku}__r${revision}` : '';
  const expectedPath = expectedFolder ? portableRelPath('processing', expectedFolder) : '';
  const listingErrorMatches = listingRow.status === 'NEEDS_ATTENTION'
    && listingRow.last_task_id === jobRow.id
    && listingRow.last_error_code === 'OZON_STATE_MACHINE_FAILED'
    && String(listingRow.last_error_message || '') === IMPORT_INTENT_URL_ERROR_MESSAGE;
  const failureEvidence = resolveImportIntentUrlFailureEvidence(jobRow, listingRow, failureHistory);
  if (!revision
    || Number(listingRow.revision || 0) !== revision
    || !listingErrorMatches
    || !failureEvidence
    || jobRow.directory_stage !== 'PROCESSING'
    || jobRow.task_folder !== expectedFolder
    || jobRow.work_rel_path !== expectedPath
    || !/^sha256:[a-f0-9]{64}$/.test(String(jobRow.directory_signature || ''))
    || String(jobRow.task_id || '') !== String(jobRow.id)
    || !offerIds.length
    || JSON.stringify([...offerIds].sort()) !== JSON.stringify([...listingOfferIds].sort())) {
    throw new AppError('CONFIG_INVALID', '任务身份、草稿错误或 processing 目录合同不符合已知 URL 故障恢复条件', {
      id: jobRow.id,
      sku: jobRow.sku
    }, 409);
  }
  const expectedDataSignature = String(payload.autoPreparedListingDataSignature || '');
  const actualDataSignature = `sha256:${createHash('sha256').update(stableJson(listingRow.data || {})).digest('hex')}`;
  if (payload.autoPreparedByJobId !== jobRow.id
    || Number(payload.autoPreparedListingRevision) !== revision
    || expectedDataSignature !== actualDataSignature) {
    throw new AppError('VERSION_CONFLICT', '自动草稿所有权签名与当前草稿不一致，禁止恢复', {
      id: jobRow.id,
      expectedDataSignature,
      actualDataSignature
    }, 409);
  }
  if (!['', 'PENDING'].includes(String(jobRow.stage_states?.import || 'PENDING'))) {
    throw new AppError('CONFIG_INVALID', '任务已进入 OZON 导入阶段，不能按预写入 URL 故障恢复', { id: jobRow.id }, 409);
  }
  return {
    proposed: {
      jobState: 'SUBMITTING',
      listingState: 'SUBMITTING',
      retryCount: Number(jobRow.retry_count || 0)
    },
    identityEvidence: {
      listingDataSignature: actualDataSignature,
      revision,
      offerIds,
      directorySignature: String(jobRow.directory_signature),
      failureEvidence
    }
  };
}

const IMPORT_INTENT_URL_ERROR_MESSAGE = 'URL parameter must be a string, got undefined';
const IMPORT_INTENT_URL_MASKED_CODE = 'OZON_COMPATIBLE_UPDATE_NOT_ALLOWED';
const IMPORT_INTENT_URL_MASKED_MESSAGE = '当前草稿状态 NEEDS_ATTENTION 不允许兼容更新';

function isMaskedImportIntentUrlFailure(jobRow: SqlRow): boolean {
  return jobRow.last_error_code === IMPORT_INTENT_URL_MASKED_CODE
    && String(jobRow.last_error_message || '') === IMPORT_INTENT_URL_MASKED_MESSAGE;
}

function resolveImportIntentUrlFailureEvidence(
  jobRow: SqlRow,
  listingRow: SqlRow,
  failureHistory: SqlRow[]
): Record<string, unknown> | undefined {
  const directJobError = jobRow.last_error_code === 'OZON_STATE_MACHINE_FAILED'
    && String(jobRow.last_error_message || '') === IMPORT_INTENT_URL_ERROR_MESSAGE;
  if (directJobError) {
    return {
      source: 'CURRENT_JOB_ERROR',
      errorCode: 'OZON_STATE_MACHINE_FAILED',
      errorMessage: IMPORT_INTENT_URL_ERROR_MESSAGE
    };
  }
  if (!isMaskedImportIntentUrlFailure(jobRow)) return undefined;

  const failures = failureHistory.filter((event) => event.event_type === 'OZON_STATE_MACHINE_FAILED');
  if (failures.length !== 1) return undefined;
  const failure = failures[0]!;
  const failureAt = eventTimestamp(failure.created_at);
  if (failureAt === undefined
    || failure.from_state !== 'UPLOADING_MEDIA'
    || failure.to_state !== 'NEEDS_ATTENTION'
    || String(failure.message || '') !== 'OZON 上品状态机执行失败'
    || hasContradictoryImportIntentUrlFailure(jsonObject(jobRow.payload).stateMachineFailure)
    || hasContradictoryImportIntentUrlFailure(failure.payload)) {
    return undefined;
  }

  const orderedAfterFailure = failureHistory
    .filter((event) => {
      const eventAt = eventTimestamp(event.created_at);
      return eventAt !== undefined && eventAt > failureAt
        && ['MEDIA_DELIVERED', 'AUTOMATION_STOPPED'].includes(String(event.event_type || ''));
    })
    .sort(compareRecoveryEvents);
  const firstOverwriteEvent = orderedAfterFailure[0];
  if (!firstOverwriteEvent
    || firstOverwriteEvent.event_type !== 'MEDIA_DELIVERED'
    || firstOverwriteEvent.from_state !== 'NEEDS_ATTENTION'
    || firstOverwriteEvent.to_state !== 'READY'
    || String(firstOverwriteEvent.message || '') !== 'OZON 共享媒体投递已合并到已绑定的自动上品任务') {
    return undefined;
  }
  const mediaAt = eventTimestamp(firstOverwriteEvent.created_at);
  if (mediaAt === undefined) return undefined;
  const firstMaskEvent = orderedAfterFailure[1];
  const maskAt = eventTimestamp(firstMaskEvent?.created_at);
  if (!firstMaskEvent
    || firstMaskEvent.event_type !== 'AUTOMATION_STOPPED'
    || maskAt === undefined
    || maskAt <= mediaAt
    || firstMaskEvent.from_state !== 'READY'
    || firstMaskEvent.to_state !== 'NEEDS_ATTENTION'
    || String(firstMaskEvent.message || '') !== IMPORT_INTENT_URL_MASKED_MESSAGE) {
    return undefined;
  }

  return {
    source: 'LISTING_AND_EVENT_SEQUENCE',
    listingError: {
      errorCode: String(listingRow.last_error_code),
      errorMessage: String(listingRow.last_error_message)
    },
    stateMachineFailureEvent: recoveryEventEvidence(failure),
    firstMaskingMediaEvent: recoveryEventEvidence(firstOverwriteEvent),
    firstMaskingAutomationEvent: recoveryEventEvidence(firstMaskEvent),
    currentJobError: {
      errorCode: IMPORT_INTENT_URL_MASKED_CODE,
      errorMessage: IMPORT_INTENT_URL_MASKED_MESSAGE
    }
  };
}

function hasContradictoryImportIntentUrlFailure(value: unknown): boolean {
  const evidence = jsonObject(value);
  const code = [evidence.errorCode, evidence.lastErrorCode, evidence.code]
    .find((entry) => nonBlank(entry));
  const message = [evidence.errorMessage, evidence.lastErrorMessage, evidence.message]
    .find((entry) => nonBlank(entry));
  return (code !== undefined && String(code) !== 'OZON_STATE_MACHINE_FAILED')
    || (message !== undefined && String(message) !== IMPORT_INTENT_URL_ERROR_MESSAGE);
}

function eventTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function compareRecoveryEvents(left: SqlRow, right: SqlRow): number {
  const byTime = Number(eventTimestamp(left.created_at)) - Number(eventTimestamp(right.created_at));
  return byTime || String(left.id || '').localeCompare(String(right.id || ''));
}

function recoveryEventEvidence(event: SqlRow): Record<string, unknown> {
  return {
    id: String(event.id || ''),
    eventType: String(event.event_type || ''),
    fromState: String(event.from_state || ''),
    toState: String(event.to_state || ''),
    message: String(event.message || ''),
    createdAt: new Date(String(event.created_at)).toISOString()
  };
}

function validateDescriptionKeywordStuffingFalsePositiveRecovery(
  jobRow: SqlRow,
  listingRow: SqlRow | undefined,
  input: OzonKnownPrePlatformFailureRecoveryInput
): KnownPrePlatformRecoveryValidation {
  if (!listingRow) {
    throw new AppError('CONFIG_INVALID', '详情词频误报恢复要求原任务草稿仍然存在', { id: jobRow.id }, 409);
  }
  if (!Number.isInteger(input.listingRowVersion) || Number(input.listingRowVersion) < 1) {
    throw new AppError('CONFIG_INVALID', '详情词频误报恢复缺少 listingRowVersion', { id: jobRow.id }, 400);
  }
  if (Number(listingRow.row_version) !== input.listingRowVersion) {
    throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', {
      sku: jobRow.sku,
      expected: Number(listingRow.row_version),
      actual: input.listingRowVersion
    }, 409);
  }
  const payload = jsonObject(jobRow.payload);
  const priorRecovery = jsonObject(payload.knownPrePlatformFailureRecovery);
  const priorChecks = jsonObject(priorRecovery.checks);
  const priorRemoteState = jsonObject(priorChecks.remoteState);
  const priorProductJson = jsonObject(priorChecks.productJson);
  const revision = Number(jobRow.listing_revision || 0);
  const offerIds = normalizeOfferIds(jobRow.offer_ids);
  const listingOfferIds = normalizeOfferIds(
    Array.isArray(listingRow.data?.offers)
      ? listingRow.data.offers.map((offer: Record<string, unknown>) => offer.offerId)
      : []
  );
  const expectedFolder = revision > 0 ? `${jobRow.sku}__r${revision}` : '';
  const expectedPath = expectedFolder ? portableRelPath('processing', expectedFolder) : '';
  const expectedErrorFragment = 'descriptionRu [KEYWORD_STUFFING]';
  const jobErrorMatches = jobRow.last_error_code === 'OZON_STATE_MACHINE_FAILED'
    && String(jobRow.last_error_message || '').includes(expectedErrorFragment);
  const listingErrorMatches = listingRow.status === 'NEEDS_ATTENTION'
    && listingRow.last_task_id === jobRow.id
    && listingRow.last_error_code === 'OZON_STATE_MACHINE_FAILED'
    && String(listingRow.last_error_message || '').includes(expectedErrorFragment);
  if (!revision
    || Number(listingRow.revision || 0) !== revision
    || !jobErrorMatches
    || !listingErrorMatches
    || jobRow.directory_stage !== 'PROCESSING'
    || jobRow.task_folder !== expectedFolder
    || jobRow.work_rel_path !== expectedPath
    || !/^sha256:[a-f0-9]{64}$/.test(String(jobRow.directory_signature || ''))
    || String(jobRow.task_id || '') !== String(jobRow.id)
    || !offerIds.length
    || JSON.stringify([...offerIds].sort()) !== JSON.stringify([...listingOfferIds].sort())) {
    throw new AppError('CONFIG_INVALID', '任务身份、草稿错误或 processing 目录合同不符合已知详情词频误报恢复条件', {
      id: jobRow.id,
      sku: jobRow.sku
    }, 409);
  }
  const expectedDataSignature = String(payload.autoPreparedListingDataSignature || '');
  const actualDataSignature = `sha256:${createHash('sha256').update(stableJson(listingRow.data || {})).digest('hex')}`;
  if (payload.autoPreparedByJobId !== jobRow.id
    || Number(payload.autoPreparedListingRevision) !== revision
    || expectedDataSignature !== actualDataSignature) {
    throw new AppError('VERSION_CONFLICT', '自动草稿所有权签名与当前草稿不一致，禁止恢复', {
      id: jobRow.id,
      expectedDataSignature,
      actualDataSignature
    }, 409);
  }
  const priorOfferIds = normalizeOfferIds(priorRecovery.offerIds);
  const priorRecoveryMatches = priorRecovery.reason === 'IMPORT_INTENT_URL_MISSING'
    && nonBlank(priorRecovery.recoveredAt)
    && Number(priorRecovery.previousJobRowVersion || 0) > 0
    && Number(priorRecovery.previousListingRowVersion || 0) > 0
    && priorRecovery.targetJobState === 'SUBMITTING'
    && priorRecovery.targetListingState === 'SUBMITTING'
    && Number(priorRecovery.revision || 0) === revision
    && priorRecovery.listingDataSignature === actualDataSignature
    && priorRecovery.directorySignature === String(jobRow.directory_signature)
    && JSON.stringify([...priorOfferIds].sort()) === JSON.stringify([...offerIds].sort())
    && priorRemoteState.status === 'CONFIRMED_EMPTY'
    && priorProductJson.status === 'MATCHED';
  if (!priorRecoveryMatches) {
    throw new AppError('VERSION_CONFLICT', '当前任务缺少可信的 IMPORT_INTENT_URL_MISSING 前置恢复链，禁止二次恢复', {
      id: jobRow.id,
      priorReason: priorRecovery.reason
    }, 409);
  }
  if (!['', 'PENDING'].includes(String(jobRow.stage_states?.import || 'PENDING'))) {
    throw new AppError('CONFIG_INVALID', '任务已进入 OZON 导入阶段，不能按预写入详情词频误报恢复', { id: jobRow.id }, 409);
  }
  return {
    proposed: {
      jobState: 'SUBMITTING',
      listingState: 'SUBMITTING',
      retryCount: Number(jobRow.retry_count || 0)
    },
    identityEvidence: {
      listingDataSignature: actualDataSignature,
      revision,
      offerIds,
      directorySignature: String(jobRow.directory_signature),
      previousRecoveryReason: 'IMPORT_INTENT_URL_MISSING',
      previousRecoveredAt: String(priorRecovery.recoveredAt)
    }
  };
}

function validateTitleTranslationLimitRecovery(
  jobRow: SqlRow,
  listingRow: SqlRow | undefined,
  input: OzonKnownPrePlatformFailureRecoveryInput
): KnownPrePlatformRecoveryValidation {
  const payload = jsonObject(jobRow.payload);
  const binding = jsonObject(payload.presetBinding);
  const definition = jsonObject(binding.definition);
  const titleTranslation = jsonObject(definition.titleTranslation);
  // The allowlisted title incident owns an immutable pre-017 preset snapshot.
  // Parse it with the read-only historical schema; the current authoring
  // schema intentionally rejects those removed store-routing fields.
  const parsedDefinition = ozonLegacyPresetInputSchema.safeParse(definition);
  const currentHash = `sha256:${createHash('sha256').update(stableJson(definition)).digest('hex')}`;
  if (binding.schemaVersion !== 1
    || !parsedDefinition.success
    || String(binding.definitionHash || '') !== currentHash
    || Number(titleTranslation.maxLength) !== 60
    || String(titleTranslation.workflowId || '') !== OZON_TITLE_TRANSLATION_WORKFLOW_ID) {
    throw new AppError('VERSION_CONFLICT', '任务绑定的 OZON 预设快照不是可迁移的 60 字符版本', {
      id: jobRow.id,
      expectedDefinitionHash: binding.definitionHash,
      actualDefinitionHash: currentHash,
      maxLength: titleTranslation.maxLength
    }, 409);
  }

  const lateSubmitting = Boolean(listingRow) || jobRow.state === 'SUBMITTING';
  let proposedJobState: OzonPublishJobState;
  let identityEvidence: Record<string, unknown>;
  if (!lateSubmitting) {
    if (listingRow || input.listingRowVersion !== undefined) {
      throw new AppError('CONFIG_INVALID', '标题长度迁移的早期恢复路径不允许已有草稿', {
        id: jobRow.id,
        hasListing: Boolean(listingRow)
      }, 409);
    }
    const expectedPath = portableRelPath('inbox', String(jobRow.sku));
    const identityMatches = jobRow.state === 'NEEDS_ATTENTION'
      && jobRow.directory_stage === 'INBOX'
      && jobRow.work_rel_path === expectedPath
      && !jobRow.task_folder
      && !jobRow.task_id
      && Number(jobRow.listing_revision || 0) === 0
      && normalizeOfferIds(jobRow.offer_ids).length === 0
      && jobRow.last_error_code === 'VERIFY_FAILED'
      && /OZON 标题翻译工作流失败（HTTP 502）/.test(String(jobRow.last_error_message || ''))
      && Number(jobRow.retry_count || 0) > 0;
    if (!identityMatches) {
      throw new AppError('CONFIG_INVALID', '任务身份或错误不符合已知标题长度迁移条件', {
        id: jobRow.id,
        sku: jobRow.sku
      }, 409);
    }
    proposedJobState = 'READY';
    identityEvidence = { recoveryMode: 'EARLY_BEFORE_LISTING' };
  } else {
    if (!listingRow) {
      throw new AppError('CONFIG_INVALID', '标题长度晚期恢复要求原任务草稿仍然存在', { id: jobRow.id }, 409);
    }
    if (!Number.isInteger(input.listingRowVersion) || Number(input.listingRowVersion) < 1) {
      throw new AppError('CONFIG_INVALID', '标题长度晚期恢复缺少 listingRowVersion', { id: jobRow.id }, 400);
    }
    if (Number(listingRow.row_version) !== input.listingRowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 草稿状态已变化，请刷新后重试', {
        sku: jobRow.sku,
        expected: Number(listingRow.row_version),
        actual: input.listingRowVersion
      }, 409);
    }
    const revision = Number(jobRow.listing_revision || 0);
    const offerIds = normalizeOfferIds(jobRow.offer_ids);
    const listingOfferIds = normalizeOfferIds(
      Array.isArray(listingRow.data?.offers)
        ? listingRow.data.offers.map((offer: Record<string, unknown>) => offer.offerId)
        : []
    );
    const expectedFolder = revision > 0 ? `${jobRow.sku}__r${revision}` : '';
    const expectedPath = expectedFolder ? portableRelPath('processing', expectedFolder) : '';
    const listingDataSignature = `sha256:${createHash('sha256').update(stableJson(listingRow.data || {})).digest('hex')}`;
    const stageStates = jsonObject(jobRow.stage_states);
    const identityMatches = jobRow.state === 'SUBMITTING'
      && listingRow.status === 'SUBMITTING'
      && listingRow.last_task_id === jobRow.id
      && Number(listingRow.revision || 0) === revision
      && revision > 0
      && jobRow.directory_stage === 'PROCESSING'
      && jobRow.task_folder === expectedFolder
      && jobRow.work_rel_path === expectedPath
      && String(jobRow.task_id || '') === String(jobRow.id)
      && /^sha256:[a-f0-9]{64}$/.test(String(jobRow.directory_signature || ''))
      && offerIds.length > 0
      && JSON.stringify([...offerIds].sort()) === JSON.stringify([...listingOfferIds].sort())
      && Number(jobRow.retry_count || 0) === 4
      && !jobRow.last_error_code
      && !jobRow.last_error_message
      && !listingRow.last_error_code
      && !listingRow.last_error_message
      && stageStates.images === 'LOCAL_READY'
      && stageStates.video === 'LOCAL_READY'
      && stageStates.import === 'PENDING'
      && stageStates.moderation === 'PENDING'
      && payload.autoPreparedMode === 'COMPATIBLE_UPSERT'
      && payload.autoPreparedByJobId === jobRow.id
      && Number(payload.autoPreparedListingRevision) === revision
      && payload.autoPreparedListingDataSignature === listingDataSignature;
    if (!identityMatches) {
      throw new AppError('CONFIG_INVALID', '任务、草稿、Offer 或 processing 目录不符合已知标题长度晚期恢复条件', {
        id: jobRow.id,
        sku: jobRow.sku
      }, 409);
    }
    proposedJobState = 'SUBMITTING';
    identityEvidence = {
      recoveryMode: 'LATE_SUBMITTING_PRE_PLATFORM',
      listingDataSignature,
      listingRowVersion: Number(listingRow.row_version),
      revision,
      offerIds,
      directorySignature: String(jobRow.directory_signature)
    };
  }

  const nextDefinition = {
    ...definition,
    titleTranslation: { ...titleTranslation, maxLength: 200 }
  };
  const nextDefinitionHash = `sha256:${createHash('sha256').update(stableJson(nextDefinition)).digest('hex')}`;
  return {
    proposed: {
      jobState: proposedJobState,
      retryCount: 0,
      titleTranslationMaxLength: 200,
      presetBindingDefinitionHash: nextDefinitionHash
    },
    nextPresetBinding: {
      ...binding,
      definition: nextDefinition,
      definitionHash: nextDefinitionHash
    },
    identityEvidence: {
      ...identityEvidence,
      previousTitleTranslationMaxLength: 60,
      titleTranslationMaxLength: 200,
      previousPresetBindingDefinitionHash: currentHash,
      presetBindingDefinitionHash: nextDefinitionHash
    }
  };
}

function hasOzonWriteCheckpoint(payload: Record<string, unknown>): boolean {
  const checkpointKeys = [
    'importIntent',
    'importTaskId',
    'updateTask',
    'networkRecovery',
    'mediaNetworkRetry',
    'mediaCheckpoint',
    'mediaUploadAudit',
    'videoUploadEvents',
    'submittedMediaUrlsByOffer',
    'videoVerificationByOffer',
    'priceStockWriteProgress',
    'priceStockWriteFailures',
    'imageRecovery',
    'finalConsistencyRecovery',
    'missingOfferConfirmations',
    'productMappings',
    'ozonProductLinks',
    'platformStatusRefreshedAt',
    'finalVerificationLeaseUntil',
    'finalVerificationReadErrorAt',
    'lastFinalVerificationReason',
    'lastFinalVerificationAuditAt',
    'importWarnings',
    'stateMachineFailure',
    'orchestrationStartedAt'
  ];
  return checkpointKeys.some((key) => hasPersistentCheckpointValue(payload[key]));
}

function hasPersistentCheckpointValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function knownRecoveryProposal(
  reason: OzonKnownPrePlatformFailureReason,
  jobRow: SqlRow,
  recovery: Record<string, unknown>
): OzonKnownPrePlatformFailureRecoveryResult['proposed'] {
  const payload = jsonObject(jobRow.payload);
  const binding = jsonObject(payload.presetBinding);
  const definition = jsonObject(binding.definition);
  const titleTranslation = jsonObject(definition.titleTranslation);
  if (reason === 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200') {
    return {
      jobState: String(recovery.targetJobState || jobRow.state) as OzonPublishJobState,
      retryCount: Number(jobRow.retry_count || 0),
      titleTranslationMaxLength: Number(titleTranslation.maxLength || 0),
      presetBindingDefinitionHash: String(binding.definitionHash || '')
    };
  }
  return {
    jobState: String(recovery.targetJobState || jobRow.state) as OzonPublishJobState,
    listingState: String(recovery.targetListingState || 'SUBMITTING') as OzonListingDraft['status'],
    retryCount: Number(jobRow.retry_count || 0)
  };
}

/**
 * A legacy recovery may continue only when the immutable job payload proves
 * the exact executable policy. Unknown history remains deliberately inert.
 *
 * The original three recovery allowlists predate policy v3. Their signed
 * product/intent evidence is therefore v2. Once migration or a prior recovery
 * has frozen an explicit value, it must agree with v2; a contradictory v3 or
 * LEGACY_UNKNOWN marker cannot be generalized into a writable task.
 */
function assertKnownPrePlatformFrozenPolicy(
  jobRow: SqlRow,
  reason: OzonKnownPrePlatformFailureReason
): void {
  const payload = jsonObject(jobRow.payload);
  const importIntent = jsonObject(payload.importIntent);
  const recordedVersions = [
    payload.contentPolicyVersion,
    importIntent.contentPolicyVersion,
    jsonObject(payload.knownPrePlatformFailureRecovery).contentPolicyVersion
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const distinct = [...new Set(recordedVersions)];
  if (distinct.length > 1 || (distinct[0] && distinct[0] !== OZON_CONTENT_POLICY_V2)) {
    throw new AppError(
      'OZON_LEGACY_TASK_READ_ONLY',
      '历史任务的冻结内容策略与已知 v2 恢复合同不一致，只允许审计和人工核验',
      { reason, recordedContentPolicyVersions: distinct },
      409
    );
  }
  if (distinct[0] === 'LEGACY_UNKNOWN') {
    throw new AppError(
      'OZON_LEGACY_TASK_READ_ONLY',
      '历史任务缺少可执行的冻结内容策略，只允许审计和人工核验',
      { reason, contentPolicyVersion: 'LEGACY_UNKNOWN' },
      409
    );
  }
}

function isKnownPreSubmitRecoveryReason(reason: OzonKnownPrePlatformFailureReason): boolean {
  return reason === 'IMPORT_INTENT_URL_MISSING'
    || reason === 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2';
}

function knownPrePlatformRecoveryResult(input: {
  status: OzonKnownPrePlatformFailureRecoveryResult['status'];
  reason: OzonKnownPrePlatformFailureReason;
  dryRun: boolean;
  job: OzonPublishJob;
  listing?: OzonListingDraft;
  proposed: OzonKnownPrePlatformFailureRecoveryResult['proposed'];
  checks?: OzonKnownPrePlatformFailureRecoveryChecks;
}): OzonKnownPrePlatformFailureRecoveryResult {
  const recovery = jsonObject(input.job.payload?.knownPrePlatformFailureRecovery);
  const storedChecks = recovery.checks && typeof recovery.checks === 'object' && !Array.isArray(recovery.checks)
    ? recovery.checks as OzonKnownPrePlatformFailureRecoveryChecks
    : undefined;
  const previousJobRowVersion = Number(recovery.previousJobRowVersion || input.job.rowVersion);
  const previousListingRowVersion = Number(recovery.previousListingRowVersion || input.listing?.rowVersion || 0);
  return {
    status: input.status,
    reason: input.reason,
    dryRun: input.dryRun,
    previous: {
      jobRowVersion: previousJobRowVersion,
      ...(previousListingRowVersion > 0 ? { listingRowVersion: previousListingRowVersion } : {})
    },
    proposed: input.proposed,
    ...((input.checks || storedChecks) ? { checks: input.checks || storedChecks } : {}),
    job: input.job,
    ...(input.listing ? { listing: input.listing } : {})
  };
}

type KnownPostPlatformMinPriceValidation = {
  target: KnownPostPlatformMinPriceTarget;
  proposed: OzonKnownPostPlatformMinPriceRecoveryResult['proposed'];
};

export function validateKnownPostPlatformMinPriceFailureShape(
  jobRow: SqlRow,
  listingRow: SqlRow,
  mappingRows: SqlRow[],
  input: OzonKnownPostPlatformMinPriceRecoveryInput
): KnownPostPlatformMinPriceValidation {
  const target = OZON_KNOWN_POST_PLATFORM_MIN_PRICE_TARGETS[String(jobRow.id || '')];
  if (!target) {
    throw new AppError('CONFIG_INVALID', 'jobId 不在已知 OZON 平台后最低价故障恢复 allowlist', {
      id: jobRow.id
    }, 409);
  }
  const offerIds = normalizeOfferIds(jobRow.offer_ids);
  const listingOfferIds = normalizeOfferIds(
    Array.isArray(listingRow.data?.offers)
      ? listingRow.data.offers.map((offer: Record<string, unknown>) => offer.offerId)
      : []
  );
  const expectedFolder = `${target.sku}__r${target.revision}`;
  const expectedWorkRelPath = portableRelPath('processing', expectedFolder);
  const payload = jsonObject(jobRow.payload);
  const importIntent = jsonObject(payload.importIntent);
  const stageStates = jsonObject(jobRow.stage_states);
  const progress = jsonObject(payload.priceStockWriteProgress);
  const pricesWrite = jsonObject(progress.pricesWrite);
  const stocksWrite = jsonObject(progress.stocksWrite);
  const exactBucket = (bucket: Record<string, unknown>, expectedSucceeded: readonly string[]) => (
    stableJson(normalizeOfferIds(bucket.succeededOfferIds)) === stableJson(expectedSucceeded)
    && normalizeOfferIds(bucket.pendingOfferIds).length === 0
    && normalizeOfferIds(bucket.failedOfferIds).length === 0
    && Object.keys(jsonObject(bucket.errorsByOffer)).length === 0
  );
  const hasFinalVerificationLease = nonBlank(payload.finalVerificationLeaseUntil);
  const finalLeaseUntil = Date.parse(String(payload.finalVerificationLeaseUntil || ''));
  const finalVerificationLeaseIsSafe = !hasFinalVerificationLease
    || (Number.isFinite(finalLeaseUntil) && finalLeaseUntil <= Date.now());
  const payloadWorkDirectory = String(payload.workDirectory || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const payloadProductJsonPath = String(payload.productJsonPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const hasPayloadWorkDirectory = nonBlank(payload.workDirectory);
  const hasPayloadProductJsonPath = nonBlank(payload.productJsonPath);
  const payloadAbsolutePathsMatch = (!hasPayloadWorkDirectory && !hasPayloadProductJsonPath)
    || (hasPayloadWorkDirectory
      && hasPayloadProductJsonPath
      && payloadWorkDirectory.endsWith(`/${expectedWorkRelPath}`)
      && payloadProductJsonPath.endsWith(`/${expectedWorkRelPath}/product.json`));
  const links = normalizeProductLinks(jobRow.product_links);
  const mappingOfferIds = mappingRows.map((row) => String(row.offer_id || '').trim());
  const expectedListingDataSignature = String(payload.autoPreparedListingDataSignature || '');
  const actualListingDataSignature = `sha256:${createHash('sha256').update(stableJson(listingRow.data || {})).digest('hex')}`;
  const baseIdentityMatches = jobRow.source === 'AUTO'
    && jobRow.state === target.jobState
    && String(jobRow.store_alias || '') === 'default'
    && String(jobRow.sku || '') === target.sku
    && String(jobRow.task_id || '') === target.jobId
    && String(jobRow.import_task_id || '') === target.importTaskId
    && String(payload.importTaskId || '') === target.importTaskId
    && Number(jobRow.listing_revision || 0) === target.revision
    && String(jobRow.task_folder || '') === expectedFolder
    && String(jobRow.directory_stage || '') === 'PROCESSING'
    && String(jobRow.work_rel_path || '') === expectedWorkRelPath
    && String(jobRow.directory_signature || '') === target.directorySignature
    && String(payload.workRelPath || '') === expectedWorkRelPath
    && String(payload.directoryStage || '') === 'PROCESSING'
    && payloadAbsolutePathsMatch
    && stableJson(offerIds) === stableJson(target.offerIds)
    && stableJson(normalizeOfferIds(payload.offerIds)) === stableJson(target.offerIds)
    && input.rowVersion === Number(jobRow.row_version)
    && listingRow.status === target.listingState
    && String(listingRow.last_task_id || '') === target.jobId
    && Number(listingRow.revision || 0) === target.revision
    && stableJson(listingOfferIds) === stableJson(target.offerIds)
    && input.listingRowVersion === Number(listingRow.row_version)
    && finalVerificationLeaseIsSafe
    && expectedListingDataSignature === actualListingDataSignature
    && !payload.networkRecovery;
  if (!baseIdentityMatches) {
    throw new AppError('CONFIG_INVALID', '任务、草稿、Offer、importTask 或目录身份不符合已知最低价漏写恢复条件', {
      id: jobRow.id,
      sku: jobRow.sku
    }, 409);
  }
  if (String(importIntent.phase || '') !== 'TASK_ID_BOUND'
    || String(importIntent.importTaskId || '') !== target.importTaskId
    || stableJson(normalizeOfferIds(importIntent.offerIds)) !== stableJson(target.offerIds)) {
    throw new AppError('VERSION_CONFLICT', 'OZON import intent 与既有 importTaskId/Offer 集合不一致', {
      id: jobRow.id
    }, 409);
  }
  if (!exactBucket(pricesWrite, target.offerIds) || !exactBucket(stocksWrite, target.offerIds)) {
    throw new AppError('CONFIG_INVALID', 'OZON 价格库存进度不是“全部误标成功”的已知最低价漏写形状', {
      id: jobRow.id
    }, 409);
  }
  if (String(stageStates.import || '') !== 'SUCCESS'
    || String(stageStates.price || '') !== target.priceStage
    || !['VERIFIED', 'WRITE_ACCEPTED'].includes(String(stageStates.stock || ''))) {
    throw new AppError('CONFIG_INVALID', 'OZON import/price/stock 阶段不符合已知最低价漏写形状', {
      id: jobRow.id,
      stageStates
    }, 409);
  }
  const finalConsistency = jsonObject(payload.finalConsistencyRecovery);
  if (target.finalConsistencyPhase === 'ABSENT') {
    if (Object.keys(finalConsistency).length > 0) {
      throw new AppError('CONFIG_INVALID', 'OZON 任务已有非预期最终一致性恢复记录', { id: jobRow.id }, 409);
    }
  } else {
    const affected = Array.isArray(finalConsistency.affectedOffers)
      ? finalConsistency.affectedOffers.map((entry) => jsonObject(entry))
      : [];
    const exactDifferences = affected.length === target.offerIds.length
      && stableJson(affected.map((entry) => String(entry.offerId || ''))) === stableJson(target.offerIds)
      && affected.every((entry) => {
        const differences = jsonObject(entry.differences);
        const price = jsonObject(differences.price);
        return Object.keys(differences).length === 1
          && differences.price !== undefined
          && Number(price.actualMinPrice) === 0
          && Number(price.expectedMinPrice) > 0
          && Number(price.actual) === Number(price.expected)
          && nullableFiniteEqual(price.actualOldPrice, price.expectedOldPrice)
          && String(price.actualCurrency || '').toUpperCase() === String(price.expectedCurrency || '').toUpperCase()
          && Boolean(String(price.expectedCurrency || '').trim());
      });
    if (String(finalConsistency.phase || '') !== target.finalConsistencyPhase
      || Number(finalConsistency.confirmationCount || 0) !== target.finalConsistencyConfirmationCount
      || !exactDifferences) {
      throw new AppError('CONFIG_INVALID', 'OZON 最终一致性差异不是唯一的 min_price=0 已知故障', {
        id: jobRow.id
      }, 409);
    }
  }
  if (mappingRows.length !== target.persistedMappings.length
    || new Set(mappingOfferIds).size !== mappingOfferIds.length
    || mappingOfferIds.some((offerId) => !target.offerIds.includes(offerId))) {
    throw new AppError('VERSION_CONFLICT', 'OZON 商品映射数量或 Offer 归属已漂移', {
      id: jobRow.id,
      expectedMappingCount: target.persistedMappings.length,
      mappingOfferIds
    }, 409);
  }
  if (target.persistedMappings.length > 0) {
    if (links.length !== target.offerIds.length || stableJson(links.map((link) => link.offerId)) !== stableJson(target.offerIds)) {
      throw new AppError('VERSION_CONFLICT', 'OZON job product links 与 allowlist Offer 不一致', { id: jobRow.id }, 409);
    }
    for (const expectedMapping of target.persistedMappings) {
      const mapping = mappingRows.find((entry) => String(entry.offer_id || '') === expectedMapping.offerId);
      const link = links.find((entry) => entry.offerId === expectedMapping.offerId);
      if (!mapping || !link
        || String(mapping.store_alias || '') !== String(jobRow.store_alias || '')
        || String(mapping.sku || '') !== target.sku
        || String(mapping.ozon_product_id || '') !== expectedMapping.ozonProductId
        || String(mapping.ozon_sku || '') !== expectedMapping.ozonSku
        || link.ozonProductId !== expectedMapping.ozonProductId
        || link.ozonSku !== expectedMapping.ozonSku
        || Number(mapping.last_applied_revision || 0) !== target.revision) {
        throw new AppError('VERSION_CONFLICT', 'OZON job link 与持久化商品映射已漂移', {
          id: jobRow.id,
          offerId: expectedMapping.offerId
        }, 409);
      }
    }
    if (String(jobRow.ozon_product_id || '') !== target.persistedMappings[0]!.ozonProductId) {
      throw new AppError('VERSION_CONFLICT', 'OZON job 主商品 ID 与 allowlist 映射已漂移', { id: jobRow.id }, 409);
    }
  } else if (links.length || nonBlank(jobRow.ozon_product_id)) {
    throw new AppError('VERSION_CONFLICT', 'OZON 0000107 预最终读回任务意外已有部分内部映射', { id: jobRow.id }, 409);
  }
  if (target.jobState === 'NEEDS_ATTENTION') {
    if (jobRow.last_error_code !== 'OZON_FINAL_READBACK_MISMATCH'
      || listingRow.last_error_code !== 'OZON_FINAL_READBACK_MISMATCH') {
      throw new AppError('CONFIG_INVALID', 'OZON 终态错误不是已知最低价最终读回差异', { id: jobRow.id }, 409);
    }
  } else if (jobRow.last_error_code || jobRow.last_error_message || listingRow.last_error_code || listingRow.last_error_message) {
    throw new AppError('CONFIG_INVALID', 'OZON MODERATING 恢复候选含有非预期错误字段', { id: jobRow.id }, 409);
  }
  return {
    target,
    proposed: {
      jobState: 'IMPORTING',
      listingState: 'SUBMITTING',
      schedulerMode: 'RECONCILE_IMPORT',
      pendingPriceOfferIds: [...target.offerIds],
      preservedStockOfferIds: [...target.offerIds],
      workRelPath: String(jobRow.work_rel_path),
      directoryStage: 'PROCESSING'
    }
  };
}

function nullableFiniteEqual(left: unknown, right: unknown): boolean {
  if ((left === null || left === undefined || left === '')
    && (right === null || right === undefined || right === '')) return true;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  const leftCents = Math.round(leftNumber * 100);
  const rightCents = Math.round(rightNumber * 100);
  return Number.isSafeInteger(leftCents) && Number.isSafeInteger(rightCents) && leftCents === rightCents;
}

function assertKnownPostPlatformMinPriceCommitChecks(
  jobRow: SqlRow,
  checks: OzonKnownPostPlatformMinPriceRecoveryChecks
): void {
  const target = OZON_KNOWN_POST_PLATFORM_MIN_PRICE_TARGETS[String(jobRow.id || '')];
  const checkedOfferIds = checks?.pricesRead?.offers?.map((entry) => entry.offerId) || [];
  const remoteOfferIds = checks?.remoteProducts?.mappings?.map((entry) => entry.offerId) || [];
  if (!target
    || checks.remoteProducts?.status !== 'MATCHED'
    || checks.pricesRead?.status !== 'ONLY_MIN_PRICE_MISSING'
    || checks.productJson?.status !== 'MATCHED'
    || checks.productJson.expectedSignature !== target.directorySignature
    || checks.routing?.resumeState !== 'IMPORTING'
    || checks.routing.schedulerMode !== 'RECONCILE_IMPORT'
    || checks.routing.importProductReachable !== false
    || stableJson(checks.remoteProducts.requestedOfferIds) !== stableJson(target.offerIds)
    || stableJson(remoteOfferIds) !== stableJson(target.offerIds)
    || stableJson(checkedOfferIds) !== stableJson(target.offerIds)
    || checks.pricesRead.offers.some((entry) => entry.actual.minPrice !== 0)) {
    throw new AppError('VERSION_CONFLICT', 'OZON 最低价恢复的提交前只读检查不完整或已漂移', {
      id: jobRow.id
    }, 409);
  }
}

function knownPostPlatformMinPriceProposal(
  jobRow: SqlRow,
  recovery: Record<string, unknown>
): OzonKnownPostPlatformMinPriceRecoveryResult['proposed'] {
  const offerIds = normalizeOfferIds(recovery.offerIds || jobRow.offer_ids);
  const directoryAfter = jsonObject(recovery.directoryAfter);
  const stage = String(directoryAfter.directoryStage || jobRow.directory_stage || '').toUpperCase();
  return {
    jobState: 'IMPORTING',
    listingState: 'SUBMITTING',
    schedulerMode: 'RECONCILE_IMPORT',
    pendingPriceOfferIds: offerIds,
    preservedStockOfferIds: offerIds,
    workRelPath: String(directoryAfter.workRelPath || jobRow.work_rel_path || ''),
    directoryStage: stage === 'SUCCESS' ? 'SUCCESS' : 'PROCESSING'
  };
}

function knownPostPlatformMinPriceRecoveryResult(input: {
  status: OzonKnownPostPlatformMinPriceRecoveryResult['status'];
  dryRun: boolean;
  job: OzonPublishJob;
  listing: OzonListingDraft;
  proposed: OzonKnownPostPlatformMinPriceRecoveryResult['proposed'];
  checks?: OzonKnownPostPlatformMinPriceRecoveryChecks;
}): OzonKnownPostPlatformMinPriceRecoveryResult {
  const recovery = jsonObject(input.job.payload?.knownPostPlatformMinPriceRecovery);
  const storedChecks = recovery.checks && typeof recovery.checks === 'object' && !Array.isArray(recovery.checks)
    ? recovery.checks as OzonKnownPostPlatformMinPriceRecoveryChecks
    : undefined;
  return {
    status: input.status,
    reason: OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
    dryRun: input.dryRun,
    previous: {
      jobRowVersion: Number(recovery.previousJobRowVersion || input.job.rowVersion),
      listingRowVersion: Number(recovery.previousListingRowVersion || input.listing.rowVersion)
    },
    proposed: input.proposed,
    ...((input.checks || storedChecks) ? { checks: input.checks || storedChecks } : {}),
    job: input.job,
    listing: input.listing
  };
}

function finitePage(value: number | undefined): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;
}

function finitePageSize(value: number | undefined): number {
  return Number.isInteger(value) && Number(value) > 0 ? Math.min(Number(value), 100) : 20;
}

function normalizePurchaseCreatedDateRange(input: { purchaseCreatedFrom?: string; purchaseCreatedTo?: string }): { purchaseCreatedFrom?: string; purchaseCreatedTo?: string } {
  const purchaseCreatedFrom = input.purchaseCreatedFrom ? normalizePurchaseCreatedDate(input.purchaseCreatedFrom, '采购记录新建日期起始时间') : undefined;
  const purchaseCreatedTo = input.purchaseCreatedTo ? normalizePurchaseCreatedDate(input.purchaseCreatedTo, '采购记录新建日期结束时间') : undefined;
  if (purchaseCreatedFrom && purchaseCreatedTo && purchaseCreatedFrom >= purchaseCreatedTo) {
    throw new AppError('CONFIG_INVALID', '采购记录新建日期结束时间必须晚于起始时间');
  }
  return { purchaseCreatedFrom, purchaseCreatedTo };
}

function normalizePresetWriteInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.sizes) && value.sizes.length) return value;
  return { ...value, sizes: [{ value: '', stock: Number(value.defaultStock || 0) }] };
}

function currentPresetDefinition(input: unknown) {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const definition = { ...value };
  for (const key of ['autoPublishEnabled', 'autoPublishMode', 'autoPublishActivatedAt', 'fulfillmentMode', 'warehouseId', 'currency', 'isDefault', 'id', 'rowVersion', 'createdAt', 'updatedAt']) {
    delete definition[key];
  }
  return ozonPresetInputSchema.parse(normalizePresetWriteInput(definition));
}

function normalizeAutomaticDeliveryTime(value: unknown): string {
  const parsed = new Date(String(value || ''));
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动上品媒体投递时间格式无效', { deliveredAt: value }, 409);
  }
  return parsed.toISOString();
}

function createOzonAutoPresetBinding(
  preset: OzonLegacyPreset,
  boundAt: string,
  activationStartedAtOverride?: string
): OzonAutoPresetBinding {
  const activationStartedAt = activationStartedAtOverride || preset.autoPublishActivatedAt;
  if (!activationStartedAt) {
    throw new AppError('CONFIG_INVALID', '冻结的 OZON 历史预设缺少激活时间', { presetId: preset.id }, 409);
  }
  const definition = legacyPresetDefinition(preset);
  return {
    schemaVersion: 1,
    presetId: preset.id,
    presetName: preset.name,
    presetRowVersion: preset.rowVersion,
    activationStartedAt,
    boundAt,
    definition,
    definitionHash: `sha256:${createHash('sha256').update(stableJson(definition)).digest('hex')}`
  };
}

function legacyPresetDefinition(input: OzonLegacyPreset) {
  const definition = { ...input } as Record<string, unknown>;
  for (const key of ['id', 'rowVersion', 'autoPublishActivatedAt', 'createdAt', 'updatedAt']) {
    delete definition[key];
  }
  return ozonLegacyPresetInputSchema.parse(definition);
}

function normalizePurchaseCreatedDate(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new AppError('CONFIG_INVALID', `${label}格式无效`);
  return parsed.toISOString();
}

function listingStatusForJob(state: OzonPublishJobState): OzonListingDraft['status'] | undefined {
  if (state === 'SUBMITTING' || state === 'IMPORTING') return 'SUBMITTING';
  if (state === 'VERIFYING_IMAGES' || state === 'UPDATING_PRICE' || state === 'UPDATING_STOCK') return 'IMPORTED';
  if (state === 'MODERATING') return 'MODERATING';
  if (state === 'SUCCEEDED') return 'PUBLISHED';
  if (state === 'NEEDS_ATTENTION') return 'NEEDS_ATTENTION';
  if (state === 'FAILED') return 'FAILED';
  if (state === 'CANCELLED') return 'CANCELLED';
  return undefined;
}

function validationError(issues: Array<{ path: PropertyKey[]; message: string }>): AppError {
  return new AppError('CONFIG_INVALID', issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('；'), { issues });
}

function categorySelectSql(suffix: string): string {
  return `
    SELECT c.*,
      draft.id draft_id,draft.version_no draft_version_no,draft.status draft_status,draft.schema_hash draft_schema_hash,
      draft.snapshot draft_snapshot,draft.confirmed_by draft_confirmed_by,draft.created_at draft_created_at,
      draft.updated_at draft_updated_at,draft.published_at draft_published_at,
      published.id published_id,published.version_no published_version_no,published.status published_status,
      published.schema_hash published_schema_hash,published.snapshot published_snapshot,
      published.confirmed_by published_confirmed_by,published.created_at published_created_at,
      published.updated_at published_updated_at,published.published_at published_published_at,
      catalog.description_category_id catalog_description_category_id,catalog.active catalog_active
    FROM ozon_category_templates c
    LEFT JOIN ozon_category_template_versions draft ON draft.id=c.draft_version_id
    LEFT JOIN ozon_category_template_versions published ON published.id=c.published_version_id
    LEFT JOIN ozon_catalog_entries catalog ON catalog.description_category_id=c.description_category_id AND catalog.type_id=c.type_id
    ${suffix}`;
}

function toCategory(row: SqlRow): OzonCategoryTemplate {
  return {
    categoryKey: row.category_key,
    nameRu: row.name_ru,
    nameZh: row.name_zh || '',
    descriptionCategoryId: Number(row.description_category_id),
    typeId: Number(row.type_id),
    rowVersion: Number(row.row_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.catalog_description_category_id != null && row.catalog_active != null
      ? {
          catalogActive: Boolean(row.catalog_active),
          ...(!row.catalog_active ? { catalogIssue: 'OZON 本地目录已将该类目标记为停用，请刷新目录并复核模板' } : {})
        }
      : {}),
    ...(row.draft_id ? { draftVersion: toJoinedCategoryVersion(row, 'draft') } : {}),
    ...(row.published_id ? { publishedVersion: toJoinedCategoryVersion(row, 'published') } : {})
  };
}

function toJoinedCategoryVersion(row: SqlRow, prefix: 'draft' | 'published'): OzonCategoryVersion {
  return {
    id: row[`${prefix}_id`],
    categoryKey: row.category_key,
    versionNo: Number(row[`${prefix}_version_no`]),
    status: row[`${prefix}_status`],
    schemaHash: row[`${prefix}_schema_hash`],
    snapshot: row[`${prefix}_snapshot`],
    confirmedBy: row[`${prefix}_confirmed_by`] || '',
    createdAt: iso(row[`${prefix}_created_at`]),
    updatedAt: iso(row[`${prefix}_updated_at`]),
    ...(row[`${prefix}_published_at`] ? { publishedAt: iso(row[`${prefix}_published_at`]) } : {})
  };
}

function toCategoryVersion(row: SqlRow): OzonCategoryVersion {
  return {
    id: row.id,
    categoryKey: row.category_key,
    versionNo: Number(row.version_no),
    status: row.status,
    schemaHash: row.schema_hash,
    snapshot: row.snapshot,
    confirmedBy: row.confirmed_by || '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.published_at ? { publishedAt: iso(row.published_at) } : {})
  };
}

function toCatalogRun(row: SqlRow): OzonCatalogSyncRun {
  return {
    runId: String(row.id),
    trigger: row.trigger,
    status: row.status,
    ...(row.schedule_key ? { scheduleKey: String(row.schedule_key) } : {}),
    processedEntries: Number(row.processed_entries || 0),
    totalEntries: Number(row.total_entries || 0),
    chineseMissingCount: Number(row.chinese_missing_count || 0),
    ...(row.snapshot_path ? { snapshotPath: String(row.snapshot_path) } : {}),
    ...(row.source_hash ? { sourceHash: String(row.source_hash) } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    startedAt: iso(row.started_at),
    heartbeatAt: iso(row.heartbeat_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function toCatalogEntry(row: SqlRow): OzonCatalogEntry {
  const descriptionCategoryId = Number(row.description_category_id);
  const typeId = Number(row.type_id);
  const pathZh = stringArray(row.path_zh);
  const pathRu = stringArray(row.path_ru);
  return {
    catalogEntryId: `${descriptionCategoryId}:${typeId}`,
    descriptionCategoryId,
    typeId,
    categoryNameZh: String(row.category_name_zh || ''),
    typeNameZh: String(row.type_name_zh || ''),
    categoryNameRu: String(row.category_name_ru || ''),
    typeNameRu: String(row.type_name_ru || ''),
    pathZh,
    pathRu,
    displayPathZh: pathZh.join(' → '),
    displayPathRu: pathRu.join(' → '),
    active: Boolean(row.active),
    missingSyncCount: Number(row.missing_sync_count || 0),
    updatedAt: iso(row.updated_at)
  };
}

function toCatalogDictionaryValue(row: SqlRow): OzonCatalogDictionaryValue {
  const directory = row.directory as OzonCatalogDictionaryName;
  const dictionaryId = Number(row.dictionary_id);
  const valueId = Number(row.value_id);
  return {
    directory,
    itemKey: `${directory}:${dictionaryId}:${valueId}`,
    attributeId: Number(row.attribute_id),
    dictionaryId,
    valueId,
    nameRu: String(row.name_ru || ''),
    nameZh: String(row.name_zh || ''),
    ...(row.info_ru ? { infoRu: String(row.info_ru) } : {}),
    ...(row.info_zh ? { infoZh: String(row.info_zh) } : {})
  };
}

function parseCatalogEntryId(valueInput: string): [number, number] {
  const match = /^(\d+):(\d+)$/.exec(String(valueInput || '').trim());
  if (!match) throw new AppError('CONFIG_INVALID', 'OZON 本地类目录项格式无效', { catalogEntryId: valueInput });
  const descriptionCategoryId = Number(match[1]);
  const typeId = Number(match[2]);
  if (!Number.isSafeInteger(descriptionCategoryId) || descriptionCategoryId < 1 || !Number.isSafeInteger(typeId) || typeId < 1) {
    throw new AppError('CONFIG_INVALID', 'OZON 本地类目录项 ID 无效', { catalogEntryId: valueInput });
  }
  return [descriptionCategoryId, typeId];
}

function normalizeCatalogText(value: string): string {
  return String(value || '').trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

function storedContentPolicyVersion(value: unknown): OzonListingDraft['contentPolicyVersion'] {
  if (value === 'merchroute-ozon-content-v2' || value === 'merchroute-ozon-content-v3' || value === 'merchroute-ozon-content-v4' || value === 'LEGACY_UNKNOWN') {
    return value;
  }
  return undefined;
}

async function insertSharedMaterialVersion(client: PoolClient, row: SqlRow): Promise<SqlRow> {
  const material = projectOzonSharedMaterialDraft(toListing(row), OZON_CONTENT_POLICY_VERSION);
  const canonical = canonicalOzonSharedMaterialJson(material);
  const materialHash = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  const sourceMediaIdentityHash = ozonSourceMediaIdentityHash(material);
  const dataSignature = materialHash;
  const id = randomUUID();
  const sharedMaterialMetadata = {
    generatedVersionId: id,
    materialRevision: Number(row.revision),
    rowVersion: Number(row.row_version),
    materialHash,
    materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION,
    dataSignature,
    contentPolicyVersion: OZON_CONTENT_POLICY_VERSION,
    sourceMediaIdentityHash
  };
  const result = await client.query<SqlRow>(`INSERT INTO ozon_listing_versions(
      id,sku,revision,snapshot,content_policy_version,material_hash,material_hash_version,source_media_identity_hash
    ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`, [
    id,
    String(row.sku),
    Number(row.revision),
    JSON.stringify({ ...row, data: row.data, sharedMaterial: material, sharedMaterialMetadata }),
    OZON_CONTENT_POLICY_VERSION,
    materialHash,
    OZON_SHARED_MATERIAL_HASH_VERSION,
    sourceMediaIdentityHash
  ]);
  return result.rows[0]!;
}

function withSharedMaterialVersion(row: SqlRow, version: SqlRow): OzonListingDraft {
  const metadata = jsonObject(jsonObject(version.snapshot).sharedMaterialMetadata);
  return {
    ...toListing(row),
    generatedVersionId: String(version.id),
    materialRevision: Number(row.revision),
    materialHash: String(version.material_hash || ''),
    materialHashVersion: String(version.material_hash_version || OZON_SHARED_MATERIAL_HASH_VERSION),
    contentPolicyVersion: String(version.content_policy_version || OZON_CONTENT_POLICY_VERSION),
    ...(version.source_media_identity_hash ? { sourceMediaIdentityHash: String(version.source_media_identity_hash) } : {}),
    ...(metadata.dataSignature ? { dataSignature: String(metadata.dataSignature) } : {})
  } as OzonListingDraft;
}

function ozonSourceMediaIdentityHash(material: ReturnType<typeof projectOzonSharedMaterialDraft>): string {
  const identity = {
    schemaVersion: 1,
    mediaAssets: material.mediaAssets.map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      productVariantId: asset.productVariantId || null,
      sourceStageId: asset.sourceStageId || null,
      sourceSubmissionId: asset.sourceSubmissionId || null,
      deliveredAt: asset.deliveredAt || null
    })),
    variants: material.variants.map((variant) => ({
      productVariantId: variant.productVariantId,
      media: variant.media.map((media) => ({ assetId: media.assetId, sortOrder: media.sortOrder }))
    }))
  };
  return `sha256:${createHash('sha256').update(stableJson(identity)).digest('hex')}`;
}

function toListing(row: SqlRow): OzonListingDraft {
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  const materialMetadata = jsonObject(jsonObject(row.generated_version_snapshot).sharedMaterialMetadata);
  return {
    sku: row.sku,
    productName: row.product_name_snapshot,
    managementSource: row.management_source === 'AUTO' ? 'AUTO' : 'MANUAL',
    status: row.status,
    rowVersion: Number(row.row_version),
    revision: Number(row.revision),
    ...(row.generated_version_id ? { generatedVersionId: String(row.generated_version_id) } : {}),
    materialRevision: Number(row.revision),
    ...(row.material_hash ? { materialHash: String(row.material_hash) } : {}),
    ...(row.material_hash_version === OZON_SHARED_MATERIAL_HASH_VERSION
      ? { materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION }
      : {}),
    ...(row.source_media_identity_hash ? { sourceMediaIdentityHash: String(row.source_media_identity_hash) } : {}),
    ...(storedContentPolicyVersion(row.content_policy_version)
      ? { contentPolicyVersion: storedContentPolicyVersion(row.content_policy_version) }
      : {}),
    ...(materialMetadata.dataSignature ? { dataSignature: String(materialMetadata.dataSignature) } : {}),
    data: {
      ...data,
      mediaAssets: Array.isArray(data.mediaAssets) ? data.mediaAssets : [],
      mediaSourceRoot: typeof data.mediaSourceRoot === 'string' ? data.mediaSourceRoot : '',
      videoUploadMode: data.videoUploadMode === 'ORIGINAL' ? 'ORIGINAL' : 'COMPRESSED_COPY'
    },
    ...(row.last_task_id ? { lastTaskId: row.last_task_id } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toPreset(row: SqlRow): OzonPreset {
  const raw = row.definition && typeof row.definition === 'object' ? row.definition : {};
  const parsed = ozonPresetInputSchema.safeParse(currentPresetDefinition({
    ...raw,
    name: row.name,
    description: row.description || '',
    sizes: raw.sizes || [{ value: '', stock: Number(raw.defaultStock || 0) }]
  }));
  if (!parsed.success) throw validationError(parsed.error.issues);
  return {
    ...parsed.data,
    id: row.id,
    name: row.name,
    description: row.description || '',
    rowVersion: Number(row.row_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toLegacyPreset(row: SqlRow): OzonLegacyPreset {
  const raw = row.definition && typeof row.definition === 'object' ? row.definition : {};
  const parsed = ozonLegacyPresetInputSchema.safeParse({
    ...raw,
    name: row.name,
    description: row.description || '',
    isDefault: Boolean(row.is_default),
    autoPublishMode: raw.autoPublishMode || 'COMPATIBLE_UPSERT',
    sizes: raw.sizes || [{ value: '', stock: Number(raw.defaultStock || 0) }]
  });
  if (!parsed.success) throw validationError(parsed.error.issues);
  return {
    ...currentPresetDefinition(parsed.data),
    autoPublishEnabled: parsed.data.autoPublishEnabled,
    autoPublishMode: parsed.data.autoPublishMode,
    fulfillmentMode: parsed.data.fulfillmentMode,
    warehouseId: parsed.data.warehouseId,
    currency: parsed.data.currency,
    isDefault: parsed.data.isDefault,
    id: row.id,
    rowVersion: Number(row.row_version),
    ...(row.auto_publish_activated_at ? { autoPublishActivatedAt: iso(row.auto_publish_activated_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function toJob(row: SqlRow): OzonPublishJob {
  const offerIds = normalizeOfferIds(row.offer_ids);
  if (!offerIds.length && row.offer_id) offerIds.push(String(row.offer_id));
  const productLinks = orderProductLinks(normalizeProductLinks(row.product_links), offerIds);
  const productUrl = row.state === 'SUCCEEDED' ? productLinks[0]?.url : undefined;
  const payload = row.payload || {};
  const taskKind: OzonPublishJob['taskKind'] = row.task_kind === 'SHARED_PREPARATION'
    ? 'SHARED_PREPARATION'
    : row.task_kind === 'STORE_PUBLICATION'
      ? 'STORE_PUBLICATION'
    : payload.multistorePreparation === true ? 'SHARED_PREPARATION'
      : row.publication_id ? 'STORE_PUBLICATION' : 'LEGACY';
  const fanoutRaw = jsonObject(payload.fanoutSummary);
  const fanoutSummary: OzonPublishJob['fanoutSummary'] | undefined =
    ['NOT_STARTED', 'PLANNED', 'MATERIALIZING', 'PARTIAL', 'COMPLETED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(String(fanoutRaw.phase))
    && ['NONE', 'RECHECK', 'REPLAN_WITH_CURRENT_PRESET', 'READBACK_REQUIRED', 'MANUAL_TAKEOVER', 'MANUAL_SUCCESS_RECONCILE'].includes(String(fanoutRaw.recoveryMode))
      ? {
          phase: fanoutRaw.phase as NonNullable<OzonPublishJob['fanoutSummary']>['phase'],
          targetStoreCount: Number(fanoutRaw.targetStoreCount || 0),
          publicationCount: Number(fanoutRaw.publicationCount || 0),
          failureCount: Number(fanoutRaw.failureCount || 0),
          canRecheck: fanoutRaw.canRecheck === true,
          canManualTakeover: fanoutRaw.canManualTakeover === true,
          ...(fanoutRaw.canReconcileManualSuccess === true ? { canReconcileManualSuccess: true } : {}),
          recoveryMode: fanoutRaw.recoveryMode as NonNullable<OzonPublishJob['fanoutSummary']>['recoveryMode'],
          ...(fanoutRaw.blockedReason ? { blockedReason: String(fanoutRaw.blockedReason) } : {})
        }
      : undefined;
  const contentPolicyVersion = storedContentPolicyVersion(payload.contentPolicyVersion);
  const materialHash = String(payload.materialHash || '').trim();
  const materialHashVersion = String(payload.materialHashVersion || '').trim();
  const summaryPresetId = String(row.summary_preset_id || '').trim();
  const summaryPresetName = frozenJobPresetName(row, payload);
  const summaryPublicationMode = row.summary_publication_mode === 'COMPATIBLE_UPSERT'
    ? 'COMPATIBLE_UPSERT' as const
    : row.summary_publication_mode === 'CREATE_ONLY' ? 'CREATE_ONLY' as const : undefined;
  return {
    id: row.id,
    sku: row.sku,
    ...(row.offer_id ? { offerId: row.offer_id } : {}),
    offerIds,
    storeAlias: requiredStoreAlias(row.store_alias),
    ...(row.store_id ? { storeId: String(row.store_id) } : {}),
    ...(row.publication_id ? { publicationId: String(row.publication_id) } : {}),
    ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
    ...(row.credential_binding_mode
      ? { credentialBindingMode: ['VAULT', 'LEGACY_PUBLICATION'].includes(String(row.credential_binding_mode))
          ? String(row.credential_binding_mode) as 'VAULT' | 'LEGACY_PUBLICATION'
          : 'PURE_LEGACY' as const }
      : {}),
    ...(Number(row.store_config_version || 0) > 0 ? { storeConfigVersion: Number(row.store_config_version) } : {}),
    ...(row.warehouse_id !== null && row.warehouse_id !== undefined
      ? { warehouseId: String(row.warehouse_id) }
      : {}),
    ...(row.offer_contract_hash ? { offerContractHash: String(row.offer_contract_hash) } : {}),
    ...(row.materialization_hash ? { materializationHash: String(row.materialization_hash) } : {}),
    ...(contentPolicyVersion ? { contentPolicyVersion } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(materialHashVersion === OZON_SHARED_MATERIAL_HASH_VERSION
      ? { materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION }
      : {}),
    ...(payload.planHash ? { planHash: String(payload.planHash) } : {}),
    ...(payload.requestId ? { requestId: String(payload.requestId) } : {}),
    ...(payload.preparationJobId ? { preparationJobId: String(payload.preparationJobId) } : {}),
    ...(summaryPublicationMode ? { publicationMode: summaryPublicationMode } : {}),
    ...(summaryPresetId ? {
      presetBinding: {
        presetId: summaryPresetId,
        ...(summaryPresetName ? { presetName: summaryPresetName } : {}),
        ...(Number(row.summary_preset_row_version || 0) > 0
          ? { presetRowVersion: Number(row.summary_preset_row_version) }
          : {}),
        sourcePresetExists: Boolean(row.summary_source_preset_id)
      }
    } : {}),
    ...(Number(row.listing_revision || 0) > 0 ? { revision: Number(row.listing_revision) } : {}),
    state: row.state,
    source: row.source,
    taskKind,
    ...(taskKind === 'SHARED_PREPARATION' && fanoutSummary ? { fanoutSummary } : {}),
    payload,
    ...(payload.timings && typeof payload.timings === 'object' ? { timings: payload.timings } : {}),
    ...(Array.isArray(payload.mediaUploadAudit) ? { mediaUploadAudit: payload.mediaUploadAudit } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.import_task_id ? { importTaskId: row.import_task_id } : {}),
    ...(row.ozon_product_id ? { ozonProductId: row.ozon_product_id } : {}),
    ...(productUrl ? { ozonProductUrl: productUrl } : {}),
    ozonProductLinks: productLinks,
    ...(row.task_folder ? { taskFolder: String(row.task_folder) } : {}),
    ...(row.work_rel_path ? { workRelPath: String(row.work_rel_path) } : {}),
    ...(normalizeDirectoryStage(row.directory_stage) ? { directoryStage: normalizeDirectoryStage(row.directory_stage) } : {}),
    ...(row.directory_signature ? { directorySignature: String(row.directory_signature) } : {}),
    stageStates: {
      import: 'PENDING',
      moderation: 'PENDING',
      images: 'PENDING',
      video: 'PENDING',
      price: 'PENDING',
      stock: 'PENDING',
      ...(row.stage_states || {})
    },
    retryCount: Number(row.retry_count || 0),
    rowVersion: Number(row.row_version),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_error_message ? { lastErrorMessage: row.last_error_message } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {})
  };
}

function frozenJobPresetName(row: SqlRow, payload: Record<string, unknown>): string | undefined {
  const candidates = [
    payload.presetName,
    jsonObject(jsonObject(payload.materialSnapshot).preset).name,
    jsonObject(jsonObject(jsonObject(payload.product).materialSnapshot).preset).name,
    jsonObject(jsonObject(jsonObject(row.summary_materialized_product_snapshot).materialSnapshot).preset).name
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean);
}

function toProductMapping(row: SqlRow): OzonProductMapping {
  return {
    storeAlias: row.store_alias,
    offerId: row.offer_id,
    sku: row.sku,
    ozonProductId: row.ozon_product_id || undefined,
    ozonSku: row.ozon_sku || undefined,
    warehouseId: row.warehouse_id || undefined,
    lastAppliedRevision: Number(row.last_applied_revision || 0),
    status: row.status || 'UNKNOWN',
    ...(row.status_snapshot && Object.keys(row.status_snapshot).length ? { statusSnapshot: row.status_snapshot } : {}),
    ...(row.last_verified_at ? { lastVerifiedAt: iso(row.last_verified_at) } : {}),
    updatedAt: iso(row.updated_at)
  };
}

function toEvent(row: SqlRow): OzonPublishEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    eventType: row.event_type,
    ...(row.from_state ? { fromState: row.from_state } : {}),
    ...(row.to_state ? { toState: row.to_state } : {}),
    message: row.message,
    payload: row.payload || {},
    createdAt: iso(row.created_at)
  };
}

function toSettings(row: SqlRow): OzonSystemSettings {
  return {
    enabled: Boolean(row.enabled),
    rootDirectory: row.root_directory || '',
    defaultStoreAlias: 'default',
    taskApiWebhookUrl: row.task_api_webhook_url || '',
    adminApiWebhookUrl: row.admin_api_webhook_url || '',
    preflightWebhookUrl: row.preflight_webhook_url || '',
    imageUploaderWorkflowId: row.image_uploader_workflow_id || '',
    storeGatewayWorkflowId: row.store_gateway_workflow_id || '',
    imageUploadConcurrency: Math.min(7, Math.max(1, Number(row.image_upload_concurrency || 7))),
    videoUploadConcurrency: Math.min(2, Math.max(1, Number(row.video_upload_concurrency || 2))),
    videoPrewarmEnabled: row.video_prewarm_enabled !== false,
    rowVersion: Number(row.row_version),
    credentialReady: false,
    lastPreflightStatus: 'NOT_RUN',
    videoUploadReady: Boolean(row.video_upload_ready),
    ...(row.video_upload_checked_at ? { videoUploadCheckedAt: iso(row.video_upload_checked_at) } : {}),
    ...(row.video_upload_message ? { videoUploadMessage: row.video_upload_message } : {}),
    updatedAt: iso(row.updated_at)
  };
}

function isSafeManualTakeoverJob(job: OzonPublishJob): boolean {
  if (job.source !== 'AUTO' || job.state !== 'WAITING_MEDIA') return false;
  if ([job.taskId, job.importTaskId, job.ozonProductId].some(nonBlank)) return false;
  const payload = jsonObject(job.payload);
  if (nonBlank(payload.productJsonPath) || payload.productJsonGenerated === true || nonBlank(job.taskFolder)) return false;
  if (String(job.stageStates.import || 'PENDING') !== 'PENDING') return false;
  if (String(job.stageStates.moderation || 'PENDING') !== 'PENDING') return false;
  if (String(job.stageStates.price || 'PENDING') !== 'PENDING') return false;
  if (String(job.stageStates.stock || 'PENDING') !== 'PENDING') return false;
  return LOCAL_ONLY_STAGE_STATES.has(String(job.stageStates.images || 'PENDING'))
    && LOCAL_ONLY_STAGE_STATES.has(String(job.stageStates.video || 'PENDING'));
}

function activeJobConflict(sku: string, row: SqlRow): AppError {
  return new AppError('TASK_LOCKED', '该 SKU 已有进行中的 OZON 上品任务', {
    sku,
    jobId: String(row.id),
    source: row.source,
    state: row.state,
    canManualTakeover: false
  }, 409);
}

async function lockSkuJob(client: PoolClient, sku: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`merchroute-ozon-job:${sku}`]);
}

async function assertNoActivePlatformStatusRefreshLease(
  client: PoolClient,
  sku: string,
  jobId?: string,
  allowedToken?: string
): Promise<void> {
  const result = await client.query<SqlRow>(`
    SELECT lease_token,lease_expires_at FROM ozon_platform_status_refresh_leases
    WHERE sku=$1 AND lease_expires_at>NOW()
    LIMIT 1`,
  [sku]);
  const lease = result.rows[0];
  if (!lease || (allowedToken && String(lease.lease_token) === allowedToken)) return;
  throw new AppError('OZON_STATUS_REFRESH_IN_PROGRESS', 'OZON 平台状态刷新正在占用该 SKU/任务，请稍后重试', {
    sku,
    jobId,
    leaseExpiresAt: iso(lease.lease_expires_at)
  }, 409);
}

async function boundStoreAlias(client: PoolClient, requested: unknown): Promise<string> {
  const explicit = String(requested || '').trim();
  if (explicit) return explicit;
  void client;
  return 'default';
}

function requiredStoreAlias(value: unknown): string {
  const storeAlias = String(value || '').trim();
  if (!storeAlias) throw new AppError('CONFIG_INVALID', 'OZON 任务缺少绑定店铺标识', undefined, 409);
  return storeAlias;
}

export function assertCompatibleAppendRemoteAbsenceEvidence(
  input: unknown,
  submittedOfferIds: string[],
  expectedStoreAlias: string
): Record<string, unknown> {
  const evidence = jsonObject(input);
  const offerIds = normalizeOfferIds(evidence.offerIds);
  const requestedOfferIds = normalizeOfferIds(evidence.requestedOfferIds);
  const operations = Array.isArray(evidence.operations)
    ? evidence.operations.map((operation) => jsonObject(operation))
    : [];
  const infoRows = operations.filter((operation) => operation.operation === 'infoList');
  const attributeRows = operations.filter((operation) => operation.operation === 'attributesInfo');
  const info = infoRows[0];
  const attributes = attributeRows[0];
  const absence = jsonObject(evidence.absenceEvidence);
  const infoAbsence = jsonObject(absence.infoList);
  const attributesAbsence = jsonObject(absence.attributesInfo);
  const checkedAt = Date.parse(String(evidence.checkedAt || ''));
  const now = Date.now();
  const fresh = Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt <= 15 * 60_000;
  const normalOperation = (
    operation: Record<string, unknown> | undefined,
    name: 'infoList' | 'attributesInfo'
  ) => Boolean(operation
    && stableJson(Object.keys(operation).sort()) === stableJson([
      'itemCount', 'ok', 'operation', 'outcome', 'requestId', 'resultShape', 'statusCode', 'upstreamOk'
    ])
    && operation.operation === name
    && operation.requestId === `productStatus:${name}`
    && operation.ok === true
    && operation.upstreamOk === true
    && operation.statusCode === 200
    && operation.outcome === 'EMPTY'
    && operation.resultShape === 'ARRAY'
    && operation.itemCount === 0);
  const attributesNotFound = Boolean(attributes
    && stableJson(Object.keys(attributes).sort()) === stableJson([
      'errorCode', 'itemCount', 'ok', 'operation', 'outcome', 'requestId', 'resultShape', 'statusCode', 'upstreamOk'
    ])
    && attributes.operation === 'attributesInfo'
    && attributes.requestId === 'productStatus:attributesInfo'
    && attributes.ok === true
    && attributes.upstreamOk === false
    && attributes.statusCode === 404
    && attributes.outcome === 'NOT_FOUND'
    && attributes.resultShape === 'NOT_FOUND_ERROR'
    && attributes.itemCount === 0
    && attributes.errorCode === '5');
  const expectedMethod = attributesNotFound ? 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND' : 'BOTH_ARRAYS_EMPTY';
  const evidenceKeys = Object.keys(evidence).sort();
  const expectedEvidenceKeys = [
    'absenceEvidence', 'attributeItemCount', 'checkedAt', 'contractVersion', 'infoItemCount',
    'offerIds', 'operations', 'requestedOfferIds', 'status', 'storeAlias'
  ].sort();
  const absenceValid = absence.method === expectedMethod
    && Number(infoAbsence.statusCode) === 200
    && infoAbsence.resultShape === 'ARRAY'
    && Number(infoAbsence.itemCount) === 0
    && Number(attributesAbsence.itemCount) === 0
    && (attributesNotFound
      ? Number(attributesAbsence.statusCode) === 404
        && attributesAbsence.resultShape === 'NOT_FOUND_ERROR'
        && attributesAbsence.errorCode === '5'
      : Number(attributesAbsence.statusCode) === 200 && attributesAbsence.resultShape === 'ARRAY');
  if (stableJson(evidenceKeys) !== stableJson(expectedEvidenceKeys)
    || evidence.status !== 'CONFIRMED_EMPTY'
    || evidence.contractVersion !== 2
    || evidence.storeAlias !== expectedStoreAlias
    || stableJson(offerIds) !== stableJson(submittedOfferIds)
    || stableJson(requestedOfferIds) !== stableJson(submittedOfferIds)
    || Number(evidence.infoItemCount) !== 0
    || Number(evidence.attributeItemCount) !== 0
    || operations.length !== 2
    || infoRows.length !== 1
    || attributeRows.length !== 1
    || !normalOperation(info, 'infoList')
    || !(normalOperation(attributes, 'attributesInfo') || attributesNotFound)
    || !absenceValid
    || !fresh) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 兼容追加缺少当前店铺下完整、最新且可验证的平台空缺证据', {
      submittedOfferIds,
      expectedStoreAlias
    }, 409);
  }
  return {
    status: 'CONFIRMED_EMPTY',
    offerIds: submittedOfferIds,
    checkedAt: new Date(checkedAt).toISOString(),
    infoItemCount: 0,
    attributeItemCount: 0,
    contractVersion: 2,
    requestedOfferIds: submittedOfferIds,
    operations: [info!, attributes!],
    absenceEvidence: absence,
    storeAlias: expectedStoreAlias
  };
}

function normalizeLeaseOwner(value: unknown): string {
  const leaseOwner = String(value || '').trim();
  if (!leaseOwner || leaseOwner.length > 200) {
    throw new AppError('CONFIG_INVALID', 'OZON 运行时 leaseOwner 无效', { leaseOwner }, 400);
  }
  return leaseOwner;
}

function normalizeLeaseToken(value: unknown): string {
  const leaseToken = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) {
    throw new AppError('CONFIG_INVALID', 'OZON 运行时 leaseToken 无效', undefined, 400);
  }
  return leaseToken;
}

function normalizeRuntimeLeaseSeconds(value: unknown): number {
  const seconds = Math.floor(Number(value) || OZON_RUNTIME_LEASE_SECONDS);
  return Math.min(1_800, Math.max(60, seconds));
}

function runtimeLeaseLost(id: string, rowVersion: number): AppError {
  return new AppError('TASK_LOCKED', 'OZON 运行时发布租约已失效或被其他执行接管', {
    id,
    rowVersion,
    reasonCode: 'OZON_RUNTIME_LEASE_LOST'
  }, 409);
}

function isHistoricalNetworkRecoveryCandidate(job: OzonPublishJob): boolean {
  if (!['FAILED', 'NEEDS_ATTENTION'].includes(job.state)) return false;
  const recovery = job.payload?.networkRecovery;
  if (recovery?.status === 'WAITING_NETWORK') return true;
  const code = String(job.lastErrorCode || '').trim().toUpperCase();
  const message = String(job.lastErrorMessage || '');
  if (code === 'N8N_DISPATCH_FAILED') {
    return /(network|fetch failed|socket|timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|网络|断网|连接)/i.test(message);
  }
  return HISTORICAL_NETWORK_ERROR_CODES.includes(code)
    || /(ECONNABORTED|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENOTFOUND|EPIPE|ETIMEDOUT)/i.test(message);
}

function historicalNetworkResumeState(job: OzonPublishJob): OzonPublishJobState {
  const requested = String(job.payload?.networkRecovery?.resumeState || job.payload?.resumeState || '').trim() as OzonPublishJobState;
  if (RUNTIME_ADVANCEABLE_JOB_STATES.includes(requested)) return requested;
  const stageStates = job.stageStates || {};
  const hasImportIntent = Boolean(job.payload?.importIntent && typeof job.payload.importIntent === 'object');
  const enteredImport = Boolean(job.importTaskId || hasImportIntent || !['', 'PENDING'].includes(String(stageStates.import || 'PENDING')));
  if (enteredImport && String(stageStates.moderation || '').match(/RUNNING|VERIFY/i)) return 'MODERATING';
  if (enteredImport && String(stageStates.stock || '').match(/RUNNING|FAILED|PENDING_RETRY|RETRY/i)) return 'UPDATING_STOCK';
  if (enteredImport && String(stageStates.price || '').match(/RUNNING|FAILED|PENDING_RETRY|RETRY/i)) return 'UPDATING_PRICE';
  if (enteredImport && String(stageStates.images || '').match(/RUNNING|FAILED|VERIFY/i)) return 'VERIFYING_IMAGES';
  if (enteredImport) return 'IMPORTING';
  if (String(stageStates.video || '').match(/RUNNING|FAILED|UPLOAD/i)
    || Array.isArray(job.payload?.mediaUploadAudit)) return 'UPLOADING_MEDIA';
  if (job.taskId || job.directoryStage === 'PROCESSING') return 'SUBMITTING';
  return 'READY';
}

async function insertPublishJob(
  client: PoolClient,
  input: {
    id?: string;
    sku: string;
    source: 'MANUAL' | 'AUTO';
    offerId?: string;
    offerIds?: string[];
    storeAlias?: string;
    taskFolder?: string;
    workRelPath?: string;
    directoryStage?: OzonTaskDirectoryStage;
    directorySignature?: string;
    revision?: number;
    payload: Record<string, unknown>;
    state: OzonPublishJobState;
    eventPayload?: Record<string, unknown>;
  }
): Promise<OzonPublishJob> {
  const id = input.id || randomUUID();
  const stageStates = { import: 'PENDING', moderation: 'PENDING', images: 'PENDING', video: 'PENDING', price: 'PENDING', stock: 'PENDING' };
  const offerIds = normalizeOfferIds(input.offerIds || (input.offerId ? [input.offerId] : []));
  const result = await client.query<SqlRow>(`
    INSERT INTO ozon_publish_jobs(
      id,sku,offer_id,state,source,payload,stage_states,row_version,offer_ids,store_alias,
      task_folder,work_rel_path,directory_stage,directory_signature,listing_revision
    )
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,1,$8::jsonb,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [
    id, input.sku, input.offerId || offerIds[0] || null, input.state, input.source,
    JSON.stringify(sanitizePersistentJobPayload(input.payload)), JSON.stringify(stageStates), JSON.stringify(offerIds),
    requiredStoreAlias(input.storeAlias), normalizeTaskFolder(input.taskFolder) || null,
    normalizeOptionalRelativePath(input.workRelPath) || null, normalizeDirectoryStage(input.directoryStage) || null,
    String(input.directorySignature || '').trim() || null, Math.max(0, Number(input.revision || input.payload.revision || 0))
  ]);
  await addEvent(
    client,
    id,
    'JOB_CREATED',
    undefined,
    input.state,
    input.source === 'AUTO' ? '自动上品任务已创建' : '手动上品任务已创建',
    input.eventPayload || {}
  );
  return toJob(result.rows[0]!);
}

function mediaDeliveryIdentity(media: Record<string, unknown>): {
  sourceStageId: string;
  submissionId: string;
  variantId: string;
} {
  const identity = {
    sourceStageId: String(media.sourceStageId || '').trim(),
    submissionId: String(media.submissionId || '').trim(),
    variantId: String(media.variantId || '').trim()
  };
  if (!['E004', 'E005'].includes(identity.sourceStageId) || !identity.submissionId) {
    throw new AppError('CONFIG_INVALID', 'OZON 媒体投递缺少有效的阶段或 submissionId', { identity }, 400);
  }
  return identity;
}

function referencedListingMediaDeliveryIdentities(dataInput: unknown): Array<ReturnType<typeof mediaDeliveryIdentity>> {
  const data = jsonObject(dataInput);
  const assets = new Map(
    (Array.isArray(data.mediaAssets) ? data.mediaAssets : [])
      .map((asset) => jsonObject(asset))
      .filter((asset) => String(asset.assetId || '').trim())
      .map((asset) => [String(asset.assetId).trim(), asset])
  );
  const referencedAssetIds = new Set<string>();
  for (const offerInput of Array.isArray(data.offers) ? data.offers : []) {
    const offer = jsonObject(offerInput);
    for (const referenceInput of Array.isArray(offer.media) ? offer.media : []) {
      const assetId = String(jsonObject(referenceInput).assetId || '').trim();
      if (assetId) referencedAssetIds.add(assetId);
    }
  }
  const identities = new Map<string, ReturnType<typeof mediaDeliveryIdentity>>();
  for (const assetId of referencedAssetIds) {
    const asset = assets.get(assetId);
    if (!asset) throw new AppError('CONFIG_INVALID', 'OZON 上品资料引用了不存在的媒体资源', { assetId }, 409);
    const identity = mediaDeliveryIdentity({
      sourceStageId: asset.sourceStageId,
      submissionId: asset.sourceSubmissionId,
      variantId: asset.productVariantId
    });
    if (!identity.variantId) {
      throw new AppError('CONFIG_INVALID', 'OZON 上品资料中的媒体投递身份缺少产品变体', { assetId }, 409);
    }
    identities.set(mediaDeliveryIdentityKey(identity), identity);
  }
  return [...identities.values()].sort((left, right) => mediaDeliveryIdentityKey(left).localeCompare(mediaDeliveryIdentityKey(right)));
}

function automaticMediaRescanComparableListingData(dataInput: unknown): Record<string, unknown> {
  const data = structuredClone(jsonObject(dataInput));
  const mediaAssets = (Array.isArray(data.mediaAssets) ? data.mediaAssets : [])
    .map((assetInput) => {
      const asset = { ...jsonObject(assetInput) };
      delete asset.modifiedAt;
      delete asset.durationSeconds;
      return asset;
    })
    .sort((left, right) => String(left.assetId || '').localeCompare(String(right.assetId || '')));
  return { ...data, mediaAssets };
}

function automaticPreparationOfferScopeMatches(row: SqlRow, listingDataInput: unknown): boolean {
  const jobOfferIds = normalizeOfferIds(row.offer_ids);
  if (!jobOfferIds.length) return true;
  const listingData = jsonObject(listingDataInput);
  const listingOfferIds = normalizeOfferIds(
    (Array.isArray(listingData.offers) ? listingData.offers : [])
      .map((offer) => jsonObject(offer).offerId)
  );
  if (stableJson(jobOfferIds) !== stableJson(listingOfferIds)) return false;
  const payload = jsonObject(row.payload);
  return ['offerIds', 'expectedOfferIds', 'submittedOfferIds', 'publishOfferIds'].every((key) => (
    payload[key] === undefined || stableJson(normalizeOfferIds(payload[key])) === stableJson(jobOfferIds)
  ));
}

function sameMediaDeliveryIdentity(
  media: unknown,
  expected: ReturnType<typeof mediaDeliveryIdentity>
): boolean {
  if (!media || typeof media !== 'object' || Array.isArray(media)) return false;
  const value = media as Record<string, unknown>;
  return String(value.sourceStageId || '').trim() === expected.sourceStageId
    && String(value.submissionId || '').trim() === expected.submissionId
    && String(value.variantId || '').trim() === expected.variantId;
}

function mediaDeliveryIdentityKey(identity: {
  sourceStageId: string;
  submissionId: string;
  variantId: string;
}): string {
  return `${identity.sourceStageId}\u0000${identity.submissionId}\u0000${identity.variantId}`;
}

function mediaDeliveryRowKey(row: SqlRow): string {
  return mediaDeliveryIdentityKey({
    sourceStageId: String(row.source_stage_id || '').trim(),
    submissionId: String(row.submission_id || '').trim(),
    variantId: String(row.variant_id || '').trim()
  });
}

function automaticMediaPayloadHash(payload: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(jsonObject(payload))).digest('hex')}`;
}

export function sameOzonPrePlanTimestamp(left: unknown, right: unknown): boolean {
  const leftMilliseconds = Date.parse(String(left || ''));
  const rightMilliseconds = Date.parse(String(right || ''));
  return Number.isFinite(leftMilliseconds)
    && Number.isFinite(rightMilliseconds)
    && leftMilliseconds === rightMilliseconds;
}

export function createOzonTargetedRecoveryLedgerAudit(rows: Array<{
  sourceStageId: string;
  submissionId: string;
  variantId: string;
  jobId?: string | null;
  payload?: unknown;
  payloadHash?: string;
  updatedAt: string;
}>): { rowCount: number; hash: string } {
  const audit = rows.map((row) => ({
    sourceStageId: String(row.sourceStageId || ''),
    submissionId: String(row.submissionId || ''),
    variantId: String(row.variantId || ''),
    jobId: String(row.jobId || ''),
    payloadHash: String(row.payloadHash || '') || automaticMediaPayloadHash(row.payload),
    updatedAt: String(row.updatedAt || '')
  })).sort((left, right) => {
    const leftKey = mediaDeliveryIdentityKey(left);
    const rightKey = mediaDeliveryIdentityKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    rowCount: audit.length,
    hash: `sha256:${createHash('sha256').update(stableJson(audit)).digest('hex')}`
  };
}

function targetedRecoveryLedgerAuditFromRows(rows: SqlRow[]): { rowCount: number; hash: string } {
  return createOzonTargetedRecoveryLedgerAudit(rows.map((row) => ({
    sourceStageId: String(row.source_stage_id || ''),
    submissionId: String(row.submission_id || ''),
    variantId: String(row.variant_id || ''),
    jobId: row.job_id ? String(row.job_id) : null,
    payload: row.payload,
    updatedAt: String(row.updated_at_exact || '')
  })));
}

async function targetedRecoveryLedgerAudit(
  client: PoolClient,
  sku: string
): Promise<{ rowCount: number; hash: string }> {
  const rows = await client.query<SqlRow>(`
    SELECT source_stage_id,submission_id,variant_id,job_id,payload,updated_at::text AS updated_at_exact
    FROM ozon_media_deliveries WHERE sku=$1 ORDER BY source_stage_id,submission_id,variant_id
    FOR UPDATE`, [sku]);
  return targetedRecoveryLedgerAuditFromRows(rows.rows);
}

function assertTargetedAcceptedMediaRecoveryContract(
  sku: string,
  input: OzonAcceptedMediaRecoveryContract,
  retainedOfferIds: string[],
  candidateOfferIds: string[],
  deliveryIdentities: Array<ReturnType<typeof mediaDeliveryIdentity>>
): OzonAcceptedMediaRecoveryContract {
  const contract = jsonObject(input);
  const productName = String(contract.productName || '').trim();
  const manifestSignature = String(contract.manifestSignature || '').trim().toLowerCase();
  const manifestContentSha256 = String(contract.manifestContentSha256 || '').trim().toLowerCase();
  const selectedFilesSignature = String(contract.selectedFilesSignature || '').trim().toLowerCase();
  const settingsBinding = jsonObject(contract.settingsBinding);
  const presetBinding = jsonObject(contract.presetBinding);
  const sourceJobSnapshot = jsonObject(contract.sourceJobSnapshot);
  const variants = Array.isArray(contract.variants)
    ? contract.variants.map((entry) => jsonObject(entry))
    : [];
  const deliveries = Array.isArray(contract.deliveryIdentities)
    ? contract.deliveryIdentities.map((entry) => mediaDeliveryIdentity(jsonObject(entry)))
    : [];
  const target = OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS[sku as '0000105' | '0000106'];
  const normalized: OzonAcceptedMediaRecoveryContract = {
    schemaVersion: 1,
    productName,
    settingsBinding: {
      rowVersion: Number(settingsBinding.rowVersion),
      defaultStoreAlias: String(settingsBinding.defaultStoreAlias || '').trim(),
      rootDirectoryHash: String(settingsBinding.rootDirectoryHash || '').trim().toLowerCase()
    },
    presetBinding: {
      presetId: String(presetBinding.presetId || '').trim(),
      presetRowVersion: Number(presetBinding.presetRowVersion),
      definitionHash: String(presetBinding.definitionHash || '').trim().toLowerCase()
    },
    sourceJobSnapshot: {
      jobId: String(sourceJobSnapshot.jobId || '').trim(),
      rowVersion: Number(sourceJobSnapshot.rowVersion),
      payloadHash: String(sourceJobSnapshot.payloadHash || '').trim().toLowerCase()
    },
    manifestSignature,
    manifestContentSha256,
    selectedFilesSignature,
    variants: variants.map((variant) => ({
      variantId: String(variant.variantId || '').trim(),
      variantName: String(variant.variantName || '').trim(),
      offerId: String(variant.offerId || '').trim(),
      disposition: String(variant.disposition || '') as 'RETAINED' | 'CANDIDATE'
    })),
    deliveryIdentities: deliveries.map((delivery) => ({
      sourceStageId: delivery.sourceStageId as 'E004' | 'E005',
      submissionId: delivery.submissionId,
      variantId: delivery.variantId
    }))
  };
  const variantIds = normalized.variants.map((variant) => variant.variantId);
  const offerIds = normalized.variants.map((variant) => variant.offerId);
  const retainedVariants = normalized.variants.filter((variant) => variant.disposition === 'RETAINED');
  const candidateVariantIds = normalized.variants
    .filter((variant) => variant.disposition === 'CANDIDATE')
    .map((variant) => variant.variantId);
  const targetRetainedVariants = target?.variants.filter((variant) => variant.disposition === 'RETAINED') || [];
  const targetCandidateVariants = target?.variants.filter((variant) => variant.disposition === 'CANDIDATE') || [];
  const expectedDeliveryKeys = deliveryIdentities.map(mediaDeliveryIdentityKey);
  const actualDeliveryKeys = deliveries.map(mediaDeliveryIdentityKey);
  const deliveryStagesByVariant = new Map<string, Set<string>>();
  for (const delivery of deliveries) {
    deliveryStagesByVariant.set(
      delivery.variantId,
      new Set([...(deliveryStagesByVariant.get(delivery.variantId) || []), delivery.sourceStageId])
    );
  }
  if (contract.schemaVersion !== 1
    || !target
    || !productName
    || !Number.isSafeInteger(normalized.settingsBinding.rowVersion)
    || normalized.settingsBinding.rowVersion < 1
    || !normalized.settingsBinding.defaultStoreAlias
    || !/^sha256:[a-f0-9]{64}$/.test(normalized.settingsBinding.rootDirectoryHash)
    || !normalized.presetBinding.presetId
    || !Number.isSafeInteger(normalized.presetBinding.presetRowVersion)
    || normalized.presetBinding.presetRowVersion < 1
    || !/^sha256:[a-f0-9]{64}$/.test(normalized.presetBinding.definitionHash)
    || normalized.sourceJobSnapshot.jobId !== target?.recoveredFromJobId
    || !Number.isSafeInteger(normalized.sourceJobSnapshot.rowVersion)
    || normalized.sourceJobSnapshot.rowVersion < 1
    || !/^sha256:[a-f0-9]{64}$/.test(normalized.sourceJobSnapshot.payloadHash)
    || !/^[a-f0-9]{64}$/.test(manifestSignature)
    || !/^sha256:[a-f0-9]{64}$/.test(manifestContentSha256)
    || !/^[a-f0-9]{64}$/.test(selectedFilesSignature)
    || createHash('sha256').update(stableJson({ manifestContentSha256, selectedFilesSignature })).digest('hex') !== manifestSignature
    || normalized.variants.length !== 3
    || new Set(variantIds).size !== 3
    || new Set(offerIds).size !== 3
    || normalized.variants.some((variant) => !variant.variantId || !variant.variantName || !variant.offerId)
    || stableJson(normalized.variants) !== stableJson(target?.variants || [])
    || retainedVariants.length !== 1
    || targetRetainedVariants.length !== 1
    || retainedVariants[0]?.offerId !== stableOzonOfferId(sku, '01')
    || targetRetainedVariants[0]?.offerId !== stableOzonOfferId(sku, '01')
    || stableJson(retainedOfferIds) !== stableJson(targetRetainedVariants.map((variant) => variant.offerId))
    || stableJson(candidateOfferIds) !== stableJson(targetCandidateVariants.map((variant) => variant.offerId))
    || stableJson(candidateOfferIds) !== stableJson(target?.candidateOfferIds || [])
    || stableJson(actualDeliveryKeys) !== stableJson(expectedDeliveryKeys)
    || stableJson(actualDeliveryKeys) !== stableJson((target?.deliveryIdentities || []).map(mediaDeliveryIdentityKey))
    || stableJson([...new Set(deliveries.map((delivery) => delivery.variantId))]) !== stableJson(candidateVariantIds)
    || candidateVariantIds.some((variantId) => {
      const stages = deliveryStagesByVariant.get(variantId);
      return !stages || stages.size !== 2 || !stages.has('E004') || !stages.has('E005');
    })) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'RECOVERY_CONTRACT_INVALID');
  }
  return normalized;
}

function assertTargetedRecoveryListingBinding(
  sku: string,
  listingDataInput: unknown,
  contract: OzonAcceptedMediaRecoveryContract
): void {
  const retained = contract.variants.filter((variant) => variant.disposition === 'RETAINED');
  const listingData = jsonObject(listingDataInput);
  const offers = Array.isArray(listingData.offers) ? listingData.offers.map((offer) => jsonObject(offer)) : [];
  const matches = retained.length === 1
    ? offers.filter((offer) => String(offer.offerId || '').trim() === retained[0]!.offerId)
    : [];
  const boundVariantId = String(matches[0]?.productVariantId || matches[0]?.variantId || '').trim();
  if (retained.length !== 1 || matches.length !== 1 || boundVariantId !== retained[0]!.variantId) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'LISTING_RETAINED_VARIANT_BINDING_CHANGED');
  }
}

async function assertTargetedRecoveryProductIdentity(
  client: PoolClient,
  sku: string,
  contract: OzonAcceptedMediaRecoveryContract
): Promise<void> {
  const target = OZON_TARGETED_ACCEPTED_MEDIA_RECOVERY_TARGETS[sku as '0000105' | '0000106'];
  const product = await client.query<SqlRow>('SELECT product_name FROM products WHERE sku=$1 FOR SHARE', [sku]);
  const variants = await client.query<SqlRow>(`
    SELECT id,name FROM product_variants
    WHERE sku=$1 AND BTRIM(name)<>'默认变体'
    ORDER BY sort_order ASC,created_at ASC
    FOR SHARE`, [sku]);
  const currentVariants = variants.rows.map((variant) => ({
    variantId: String(variant.id || '').trim(),
    variantName: String(variant.name || '').trim()
  }));
  const expectedVariants = target.variants.map((variant) => ({
    variantId: variant.variantId,
    variantName: variant.variantName
  }));
  if (!product.rows[0]
    || String(product.rows[0].product_name || '').trim() !== contract.productName
    || stableJson(currentVariants) !== stableJson(expectedVariants)
    || stableJson(contract.variants) !== stableJson(target.variants)) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'PRODUCT_IDENTITY_CHANGED');
  }
}

function assertTargetedRecoveryPlatformPreflight(
  sku: string,
  input: Record<string, unknown>,
  retainedMappings: Array<{ offerId: string; ozonProductId: string; ozonSku: string }>,
  candidateOfferIds: string[],
  expectedStoreAlias?: string,
  requireFresh = true
): Record<string, unknown> {
  const evidence = jsonObject(input);
  const retainedState = jsonObject(evidence.retainedState);
  const retainedOfferStatus = jsonObject(evidence.retainedOfferStatus);
  const candidateState = jsonObject(evidence.candidateState);
  const responseHashes = jsonObject(evidence.responseHashes);
  const retainedRows = Array.isArray(retainedState.mappings)
    ? retainedState.mappings.map((mapping) => jsonObject(mapping))
    : [];
  const checkedAt = Date.parse(String(evidence.checkedAt || ''));
  const retainedCheckedAt = Date.parse(String(retainedState.checkedAt || ''));
  const candidateCheckedAt = Date.parse(String(candidateState.checkedAt || ''));
  const retainedReadAt = Date.parse(String(retainedOfferStatus.readAt || ''));
  const now = Date.now();
  const fresh = (value: number) => Number.isFinite(value) && value <= now + 60_000 && now - value <= 15 * 60_000;
  const expectedRetained = retainedMappings[0];
  const retainedRow = retainedRows[0];
  const candidateOperations = Array.isArray(candidateState.operations)
    ? candidateState.operations.map((operation) => jsonObject(operation))
    : [];
  const infoOperation = candidateOperations.find((operation) => operation.operation === 'infoList');
  const attributesOperation = candidateOperations.find((operation) => operation.operation === 'attributesInfo');
  const absenceEvidence = jsonObject(candidateState.absenceEvidence);
  const infoAbsence = jsonObject(absenceEvidence.infoList);
  const attributesAbsence = jsonObject(absenceEvidence.attributesInfo);
  const infoOperationValid = Boolean(infoOperation
    && infoOperation.requestId === 'productStatus:infoList'
    && infoOperation.ok === true
    && infoOperation.upstreamOk === true
    && Number(infoOperation.statusCode) === 200
    && infoOperation.outcome === 'EMPTY'
    && infoOperation.resultShape === 'ARRAY'
    && Number(infoOperation.itemCount) === 0);
  const attributesOperationValid = Boolean(attributesOperation
    && attributesOperation.requestId === 'productStatus:attributesInfo'
    && attributesOperation.ok === true
    && Number(attributesOperation.itemCount) === 0
    && ((attributesOperation.upstreamOk === true
      && Number(attributesOperation.statusCode) === 200
      && attributesOperation.outcome === 'EMPTY'
      && attributesOperation.resultShape === 'ARRAY')
      || (attributesOperation.upstreamOk === false
        && Number(attributesOperation.statusCode) === 404
        && attributesOperation.outcome === 'NOT_FOUND'
        && attributesOperation.resultShape === 'NOT_FOUND_ERROR'
        && String(attributesOperation.errorCode || '') === '5')));
  const absenceEvidenceValid = (absenceEvidence.method === 'BOTH_ARRAYS_EMPTY'
    || absenceEvidence.method === 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND')
    && Number(infoAbsence.statusCode) === 200
    && infoAbsence.resultShape === 'ARRAY'
    && Number(infoAbsence.itemCount) === 0
    && Number(attributesAbsence.itemCount) === 0
    && ((absenceEvidence.method === 'BOTH_ARRAYS_EMPTY'
      && Number(attributesAbsence.statusCode) === 200
      && attributesAbsence.resultShape === 'ARRAY')
      || (absenceEvidence.method === 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND'
        && Number(attributesAbsence.statusCode) === 404
        && attributesAbsence.resultShape === 'NOT_FOUND_ERROR'
        && String(attributesAbsence.errorCode || '') === '5'));
  if (evidence.schemaVersion !== 1
    || (expectedStoreAlias && String(evidence.storeAlias || '') !== expectedStoreAlias)
    || retainedMappings.length !== 1
    || retainedRows.length !== 1
    || !expectedRetained
    || !retainedRow
    || retainedState.status !== 'MATCHED'
    || stableJson(normalizeOfferIds(retainedState.requestedOfferIds)) !== stableJson([expectedRetained.offerId])
    || String(retainedRow.offerId || '') !== expectedRetained.offerId
    || String(retainedRow.sku || sku) !== sku
    || String(retainedRow.ozonProductId || '') !== expectedRetained.ozonProductId
    || String(retainedRow.ozonSku || '') !== expectedRetained.ozonSku
    || String(retainedOfferStatus.offerId || '') !== expectedRetained.offerId
    || String(retainedOfferStatus.displayState || '') !== 'ON_SALE'
    || retainedOfferStatus.confirmed !== true
    || String(candidateState.status || '') !== 'CONFIRMED_EMPTY'
    || stableJson(normalizeOfferIds(candidateState.offerIds)) !== stableJson(candidateOfferIds)
    || candidateState.contractVersion !== 2
    || stableJson(normalizeOfferIds(candidateState.requestedOfferIds)) !== stableJson(candidateOfferIds)
    || Number(candidateState.infoItemCount) !== 0
    || Number(candidateState.attributeItemCount) !== 0
    || candidateOperations.length !== 2
    || !infoOperationValid
    || !attributesOperationValid
    || !absenceEvidenceValid
    || !/^sha256:[a-f0-9]{64}$/.test(String(responseHashes.retained || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(responseHashes.candidates || ''))
    || ![checkedAt, retainedCheckedAt, candidateCheckedAt, retainedReadAt].every(Number.isFinite)
    || (requireFresh && (!fresh(checkedAt)
      || !fresh(retainedCheckedAt)
      || !fresh(candidateCheckedAt)
      || !fresh(retainedReadAt)))) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'PLATFORM_PREFLIGHT_INVALID');
  }
  return evidence;
}

function assertTargetedAcceptedMediaRecoverySku(skuInput: string): string {
  const sku = normalizeSku(skuInput);
  if (!['0000105', '0000106'].includes(sku)) {
    throw new AppError('CONFIG_INVALID', 'OZON 定向媒体恢复仅允许 SKU 0000105/0000106', { sku }, 409);
  }
  return sku;
}

function targetedAcceptedMediaRecoveryConflict(
  sku: string,
  reasonCode: string,
  details: Record<string, unknown> = {}
): AppError {
  return new AppError('TASK_LOCKED', 'OZON 定向媒体恢复的持久化前置条件已变化，已停止', {
    sku,
    reasonCode,
    ...details
  }, 409);
}

function legacyAutomaticTaskReadOnly(): AppError {
  return new AppError(
    'OZON_LEGACY_TASK_READ_ONLY',
    '该任务属于全局默认预设时期的冻结历史，只允许查看审计证据，不能重新绑定、重排或继续写入',
    { remediation: '请从公共素材重新创建按店铺发布计划' },
    409
  );
}

function assertLegacyAutomaticTaskReadOnly(): void {
  throw legacyAutomaticTaskReadOnly();
}

async function assertTargetedAcceptedMediaRecoveryMappings(
  client: PoolClient,
  storeAlias: string,
  sku: string,
  retainedMappings: Array<{ offerId: string; ozonProductId: string; ozonSku: string }>,
  candidateOfferIds: string[]
): Promise<void> {
  const offerIds = [...new Set([...retainedMappings.map((mapping) => mapping.offerId), ...candidateOfferIds])];
  const result = await client.query<SqlRow>(`
    SELECT * FROM ozon_product_mappings
    WHERE store_alias=$1 AND offer_id=ANY($2::text[])
    FOR SHARE`,
  [storeAlias, offerIds]);
  const byOffer = new Map(result.rows.map((row) => [String(row.offer_id), row]));
  for (const expected of retainedMappings) {
    const row = byOffer.get(expected.offerId);
    if (!row
      || String(row.sku) !== sku
      || String(row.ozon_product_id || '') !== expected.ozonProductId
      || String(row.ozon_sku || '') !== expected.ozonSku) {
      throw targetedAcceptedMediaRecoveryConflict(sku, 'RETAINED_MAPPING_CHANGED', { offerId: expected.offerId });
    }
  }
  const mappedCandidate = candidateOfferIds.find((offerId) => byOffer.has(offerId));
  if (mappedCandidate) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'CANDIDATE_MAPPING_APPEARED', { offerId: mappedCandidate });
  }
}

async function assertNoActiveTargetedRecoveryExecution(client: PoolClient, sku: string): Promise<void> {
  const [runtimeLease, publishSlot] = await Promise.all([
    client.query<SqlRow>(`
      SELECT id,lease_owner,lease_expires_at FROM ozon_publish_jobs
      WHERE sku=$1 AND lease_expires_at>NOW()
      ORDER BY lease_expires_at DESC LIMIT 1 FOR SHARE`, [sku]),
    client.query<SqlRow>(`
      SELECT job_id,lease_owner,lease_expires_at FROM ozon_publish_slots
      WHERE slot_key=$1 AND lease_expires_at>NOW() LIMIT 1 FOR SHARE`, [OZON_RUNTIME_SLOT_KEY])
  ]);
  if (runtimeLease.rows[0]) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'ACTIVE_RUNTIME_LEASE', {
      jobId: String(runtimeLease.rows[0].id),
      leaseOwner: String(runtimeLease.rows[0].lease_owner || ''),
      leaseExpiresAt: iso(runtimeLease.rows[0].lease_expires_at)
    });
  }
  if (publishSlot.rows[0]) {
    throw targetedAcceptedMediaRecoveryConflict(sku, 'OCCUPIED_PUBLISH_SLOT', {
      jobId: String(publishSlot.rows[0].job_id || ''),
      leaseOwner: String(publishSlot.rows[0].lease_owner || ''),
      leaseExpiresAt: iso(publishSlot.rows[0].lease_expires_at)
    });
  }
}

function isDurablyAcceptedAutomaticMedia(payloadInput: unknown): boolean {
  const payload = jsonObject(payloadInput);
  const acceptedAt = Date.parse(String(payload.autoPublishAcceptedAt || ''));
  const activationStartedAt = Date.parse(String(payload.autoPublishAcceptedActivationStartedAt || ''));
  return Number.isFinite(acceptedAt)
    && Number.isFinite(activationStartedAt)
    && Boolean(String(payload.autoPublishAcceptanceId || payload.autoPublishAcceptedByJobId || '').trim())
    && Boolean(String(payload.autoPublishAcceptedPresetId || '').trim())
    && Number.isSafeInteger(Number(payload.autoPublishAcceptedPresetRowVersion))
    && Number.isSafeInteger(Number(payload.autoPublishAcceptedSettingsRowVersion))
    && Boolean(String(payload.autoPublishAcceptedDefinitionHash || '').trim());
}

export function isBoundDurablyAcceptedAutomaticMediaReplay(
  recordedJobIdInput: string,
  recordedPayload: unknown,
  job: Record<string, unknown>,
  identity: ReturnType<typeof mediaDeliveryIdentity>
): boolean {
  const recordedJobId = String(recordedJobIdInput || '').trim();
  if (String(job.source || '') !== 'AUTO'
    || !recordedJobId
    || recordedJobId !== String(job.id || '')
    || !isDurablyAcceptedAutomaticMedia(recordedPayload)) return false;
  const payload = jsonObject(job.payload);
  const deliveries = Array.isArray(payload.mediaDeliveries) ? payload.mediaDeliveries : [];
  return deliveries.some((delivery) => (
    sameMediaDeliveryIdentity(delivery, identity)
    && isDurablyAcceptedAutomaticMedia(delivery)
  ));
}

function deferredAutomaticMediaReplayMatchesFrozen(
  deferredInput: unknown,
  frozenInput: Record<string, unknown>,
  blockingJobId: string
): boolean {
  const deferred = { ...jsonObject(deferredInput) };
  const frozen = { ...jsonObject(frozenInput) };
  if (deferred.autoPublishDecision !== 'DEFERRED'
    || deferred.autoPublishDeferredReason !== 'ACTIVE_JOB_FROZEN'
    || String(deferred.blockingJobId || '') !== blockingJobId
    || String(deferred.blockingJobState || '') !== 'NEEDS_ATTENTION'
    || !Number.isFinite(Date.parse(String(deferred.autoPublishDeferredAt || '')))) return false;
  delete deferred.autoPublishDecision;
  delete deferred.autoPublishDeferredReason;
  delete deferred.autoPublishDeferredAt;
  delete deferred.blockingJobId;
  delete deferred.blockingJobState;
  delete frozen.autoPublishDecision;
  return stableJson(deferred) === stableJson(frozen);
}

function legacyAutomaticMediaAcceptanceBinding(
  job: SqlRow | undefined,
  identity: ReturnType<typeof mediaDeliveryIdentity>,
  deliveryPayload: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!job || String(job.source || '') !== 'AUTO') return undefined;
  const jobPayload = jsonObject(job.payload);
  const binding = jsonObject(jobPayload.presetBinding);
  const activationStartedAt = Date.parse(String(binding.activationStartedAt || ''));
  const deliveredAt = Date.parse(String(deliveryPayload.deliveredAt || ''));
  const deliveries = Array.isArray(jobPayload.mediaDeliveries) ? jobPayload.mediaDeliveries : [];
  const matchingDelivery = deliveries.find((delivery) => sameMediaDeliveryIdentity(delivery, identity));
  if (!matchingDelivery) return undefined;
  if (isDurablyAcceptedAutomaticMedia(matchingDelivery)) {
    const accepted = jsonObject(matchingDelivery);
    return {
      presetId: accepted.autoPublishAcceptedPresetId,
      presetRowVersion: accepted.autoPublishAcceptedPresetRowVersion,
      activationStartedAt: accepted.autoPublishAcceptedActivationStartedAt,
      definitionHash: accepted.autoPublishAcceptedDefinitionHash
    };
  }
  if (!Number.isFinite(activationStartedAt) || !Number.isFinite(deliveredAt) || deliveredAt < activationStartedAt) return undefined;
  if (!String(binding.presetId || '').trim() || !String(binding.definitionHash || '').trim()) return undefined;
  if (!Number.isSafeInteger(Number(binding.presetRowVersion))) return undefined;
  return binding;
}

function acceptedAutomaticMediaPayload(
  payloadInput: Record<string, unknown>,
  bindingInput: unknown,
  acceptingJobIdInput: string
): Record<string, unknown> {
  const payload = jsonObject(payloadInput);
  const binding = jsonObject(bindingInput);
  const acceptingJobId = String(payload.autoPublishAcceptedByJobId || acceptingJobIdInput || '').trim();
  const acceptanceId = String(payload.autoPublishAcceptanceId || acceptingJobId || '').trim() || randomUUID();
  const acceptedAt = String(payload.autoPublishAcceptedAt || '').trim() || new Date().toISOString();
  const acceptedPresetId = String(payload.autoPublishAcceptedPresetId || binding.presetId || '').trim();
  const acceptedActivationStartedAt = String(
    payload.autoPublishAcceptedActivationStartedAt || binding.activationStartedAt || ''
  ).trim();
  const acceptedDefinitionHash = String(
    payload.autoPublishAcceptedDefinitionHash || binding.definitionHash || ''
  ).trim();
  const acceptedPresetRowVersion = Number(
    payload.autoPublishAcceptedPresetRowVersion ?? binding.presetRowVersion
  );
  const acceptedSettingsRowVersion = Number(
    payload.autoPublishAcceptedSettingsRowVersion
    ?? payload.autoPublishSettingsRowVersion
    ?? binding.settingsRowVersion
  );
  if (!acceptanceId || !acceptedPresetId || !acceptedActivationStartedAt || !acceptedDefinitionHash
    || !Number.isSafeInteger(acceptedPresetRowVersion)
    || !Number.isSafeInteger(acceptedSettingsRowVersion)) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动媒体投递缺少可持久化的预设接受证据', {
      acceptingJobId,
      acceptanceId,
      acceptedPresetId,
      acceptedActivationStartedAt,
      acceptedDefinitionHash,
      acceptedPresetRowVersion,
      acceptedSettingsRowVersion
    }, 409);
  }
  return {
    ...payload,
    autoPublishDecision: 'ACCEPTED',
    autoPublishAcceptanceId: acceptanceId,
    autoPublishAcceptedAt: acceptedAt,
    autoPublishAcceptedByJobId: acceptingJobId || undefined,
    autoPublishAcceptedPresetId: acceptedPresetId,
    autoPublishAcceptedActivationStartedAt: acceptedActivationStartedAt,
    autoPublishAcceptedPresetRowVersion: acceptedPresetRowVersion,
    autoPublishAcceptedSettingsRowVersion: acceptedSettingsRowVersion,
    autoPublishAcceptedDefinitionHash: acceptedDefinitionHash,
    autoPublishIgnoredReason: undefined,
    autoPublishIgnoredAt: undefined,
    autoPublishDeferredReason: undefined,
    autoPublishDeferredAt: undefined,
    blockingJobId: undefined,
    blockingJobState: undefined
  };
}

function isMutableAutomaticMediaJob(row: SqlRow): boolean {
  if (row.source !== 'AUTO' || !['WAITING_MEDIA', 'READY'].includes(String(row.state))) return false;
  if (row.lease_owner || row.lease_token || row.lease_expires_at) return false;
  if (row.task_id || row.import_task_id || row.directory_signature || Number(row.listing_revision || 0) > 0) return false;
  if (normalizeOfferIds(row.offer_ids).length) return false;
  const payload = jsonObject(row.payload);
  if (hasActiveAutomaticRecoveryHold(row)) return false;
  // mediaSignature/mediaIssues are preflight observations written while the
  // coordinator is still waiting for a racing E004/E005 ledger row. Only the
  // stable-material and remote-write markers below freeze media ownership.
  return [
    'autoProcurementSnapshot',
    'grossWeightResolution',
    'autoPreparedByJobId',
    'autoPreparedListingRevision',
    'autoPreparedListingRowVersion',
    'autoPreparedListingDataSignature',
    'autoPreparedDispatchMetadata',
    'materialSnapshot',
    'productJsonGenerated',
    'revision',
    'offerIds',
    'expectedOfferIds',
    'submittedOfferIds',
    'publishOfferIds',
    'importIntent',
    'importTaskId'
  ].every((key) => payload[key] === undefined || payload[key] === null);
}

function hasActiveAutomaticRecoveryHold(row: SqlRow): boolean {
  return jsonObject(jsonObject(row.payload).recoveryHold).active === true;
}

async function deferAcceptedMediaDelivery(
  client: PoolClient,
  sku: string,
  identity: ReturnType<typeof mediaDeliveryIdentity>,
  payload: Record<string, unknown>,
  reason: string
): Promise<void> {
  const deferredPayload = {
    ...payload,
    autoPublishDecision: 'DEFERRED',
    autoPublishDeferredReason: reason,
    autoPublishDeferredAt: new Date().toISOString()
  };
  await client.query(`
    INSERT INTO ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,job_id,payload)
    VALUES($1,$2,$3,$4,NULL,$5::jsonb)
    ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO UPDATE
      SET job_id=NULL,payload=EXCLUDED.payload,updated_at=NOW()`,
  [sku, identity.sourceStageId, identity.submissionId, identity.variantId, JSON.stringify(deferredPayload)]);
}

async function deferMediaDelivery(
  client: PoolClient,
  sku: string,
  identity: ReturnType<typeof mediaDeliveryIdentity>,
  payload: Record<string, unknown>,
  blockingJob: SqlRow
): Promise<void> {
  const deferredPayload = {
    ...payload,
    autoPublishDecision: 'DEFERRED',
    autoPublishDeferredReason: 'ACTIVE_JOB_FROZEN',
    autoPublishDeferredAt: new Date().toISOString(),
    blockingJobId: String(blockingJob.id),
    blockingJobState: String(blockingJob.state)
  };
  await client.query(`
    INSERT INTO ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,job_id,payload)
    VALUES($1,$2,$3,$4,NULL,$5::jsonb)
    ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO UPDATE
      SET job_id=NULL,payload=EXCLUDED.payload,updated_at=NOW()
      WHERE ozon_media_deliveries.job_id IS NOT NULL
         OR COALESCE(ozon_media_deliveries.payload->>'autoPublishDecision','')<>'DEFERRED'
         OR COALESCE(ozon_media_deliveries.payload->>'blockingJobId','')<>$6`,
  [sku, identity.sourceStageId, identity.submissionId, identity.variantId, JSON.stringify(deferredPayload), String(blockingJob.id)]);
}

async function deferMediaDeliveryForRemoteVerification(
  client: PoolClient,
  sku: string,
  identity: ReturnType<typeof mediaDeliveryIdentity>,
  payload: Record<string, unknown>,
  representedOfferIds: string[]
): Promise<void> {
  const deferredPayload = {
    ...payload,
    autoPublishDecision: 'DEFERRED',
    autoPublishDeferredReason: 'LOCAL_VARIANT_WITHOUT_COMPLETE_REMOTE_MAPPING',
    autoPublishDeferredAt: new Date().toISOString(),
    representedOfferIds
  };
  await client.query(`
    INSERT INTO ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,job_id,payload)
    VALUES($1,$2,$3,$4,NULL,$5::jsonb)
    ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO UPDATE
      SET job_id=NULL,payload=EXCLUDED.payload,updated_at=NOW()
      WHERE ozon_media_deliveries.job_id IS NOT NULL
         OR COALESCE(ozon_media_deliveries.payload->>'autoPublishDecision','')<>'DEFERRED'
         OR COALESCE(ozon_media_deliveries.payload->>'autoPublishDeferredReason','')
              <>'LOCAL_VARIANT_WITHOUT_COMPLETE_REMOTE_MAPPING'
         OR COALESCE(ozon_media_deliveries.payload->'representedOfferIds','[]'::jsonb)<>$6::jsonb`,
  [
    sku,
    identity.sourceStageId,
    identity.submissionId,
    identity.variantId,
    JSON.stringify(deferredPayload),
    JSON.stringify(representedOfferIds)
  ]);
}

async function hasCompleteOzonRemoteRepresentation(
  client: PoolClient,
  storeAlias: string,
  sku: string,
  offerIds: string[]
): Promise<boolean> {
  if (!offerIds.length) return false;
  const result = await client.query<{ offer_id: string }>(`
    SELECT offer_id FROM ozon_product_mappings
    WHERE store_alias=$1 AND sku=$2 AND offer_id=ANY($3::text[])
      AND COALESCE(ozon_product_id,'')<>'' AND COALESCE(ozon_sku,'')<>''`,
  [storeAlias, sku, offerIds]);
  const mapped = new Set(result.rows.map((row) => String(row.offer_id || '').trim()).filter(Boolean));
  return offerIds.every((offerId) => mapped.has(offerId));
}

async function markMediaDeliveryRemoteRepresented(
  client: PoolClient,
  sku: string,
  identity: ReturnType<typeof mediaDeliveryIdentity>,
  payloadInput: Record<string, unknown>,
  offerIds: string[]
): Promise<void> {
  const payload = {
    ...payloadInput,
    autoPublishDecision: 'CONSUMED_REMOTE',
    autoPublishConsumedAt: new Date().toISOString(),
    representedOfferIds: offerIds,
    autoPublishDeferredReason: undefined,
    autoPublishDeferredAt: undefined,
    blockingJobId: undefined,
    blockingJobState: undefined
  };
  const result = await client.query<SqlRow>(`
    INSERT INTO ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,job_id,payload)
    VALUES($1,$2,$3,$4,NULL,$5::jsonb)
    ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO UPDATE
      SET payload=EXCLUDED.payload,updated_at=NOW()
      WHERE COALESCE(ozon_media_deliveries.payload->>'autoPublishDecision','')<>'CONSUMED_REMOTE'
    RETURNING *`,
  [sku, identity.sourceStageId, identity.submissionId, identity.variantId, JSON.stringify(payload)]);
  if (!result.rows[0]) {
    const current = await client.query<SqlRow>(`
      SELECT * FROM ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [sku, identity.sourceStageId, identity.submissionId, identity.variantId]);
    const currentPayload = jsonObject(current.rows[0]?.payload);
    if (String(currentPayload.autoPublishDecision || '') !== 'CONSUMED_REMOTE') {
      throw new AppError('TASK_LOCKED', 'OZON 已表示媒体投递账本写入未完成', { sku, identity }, 409);
    }
  }
}

async function insertMediaDelivery(
  client: PoolClient,
  sku: string,
  jobId: string | undefined,
  identity: ReturnType<typeof mediaDeliveryIdentity>,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(`
    INSERT INTO ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,job_id,payload)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT(sku,source_stage_id,submission_id,variant_id) DO UPDATE
      SET job_id=EXCLUDED.job_id,payload=EXCLUDED.payload,updated_at=NOW()`,
  [sku, identity.sourceStageId, identity.submissionId, identity.variantId, jobId || null, JSON.stringify(payload)]);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function listingCategoryIdentity(
  client: PoolClient,
  data: Pick<OzonListingDraft['data'], 'categoryKey' | 'categoryVersionId'>
): Promise<{ attributes: OzonCategoryAttribute[]; typeId?: number }> {
  const versionId = String(data.categoryVersionId || '').trim();
  const categoryKey = String(data.categoryKey || '').trim();
  if (!versionId && !categoryKey) return { attributes: [] };
  const result = await client.query<{ snapshot: unknown; type_id: unknown }>(`
    SELECT version.snapshot,category.type_id
    FROM ozon_category_template_versions version
    INNER JOIN ozon_category_templates category
      ON category.category_key=version.category_key
    WHERE ($1<>'' AND version.id::text=$1)
       OR ($2<>'' AND category.category_key=$2 AND category.published_version_id=version.id)
    ORDER BY CASE WHEN version.id::text=$1 THEN 0 ELSE 1 END
    LIMIT 1`,
  [versionId, categoryKey]);
  const snapshot = jsonObject(result.rows[0]?.snapshot);
  const typeId = Number(result.rows[0]?.type_id);
  return {
    attributes: Array.isArray(snapshot.attributes) ? snapshot.attributes as OzonCategoryAttribute[] : [],
    ...(Number.isSafeInteger(typeId) && typeId > 0 ? { typeId } : {})
  };
}

function nonBlank(value: unknown): boolean {
  return String(value ?? '').trim().length > 0;
}

function isPlatformOfferDisplayState(value: unknown): boolean {
  return PLATFORM_OFFER_DISPLAY_STATES.has(String(value || '').trim().toUpperCase());
}

async function addEvent(
  client: PoolClient,
  jobId: string,
  eventType: string,
  fromState: string | undefined,
  toState: string | undefined,
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(`
    INSERT INTO ozon_publish_events(id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id)
    SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,
      NULLIF(to_jsonb(job)->>'store_id','')::uuid,
      NULLIF(to_jsonb(job)->>'publication_id','')::uuid
    FROM ozon_publish_jobs job WHERE job.id=$2`,
  [randomUUID(), jobId, eventType, fromState || null, toState || null, message, JSON.stringify(payload)]);
}

async function addEventThrottled(
  client: PoolClient,
  jobId: string,
  eventType: string,
  fromState: string | undefined,
  toState: string | undefined,
  message: string,
  payload: Record<string, unknown>,
  reasonHash: string
): Promise<boolean> {
  const duplicate = await client.query<{ exists: boolean }>(`
    SELECT EXISTS(
      SELECT 1 FROM ozon_publish_events
      WHERE job_id=$1 AND event_type=$2 AND payload->>'reasonHash'=$3
        AND created_at>=NOW()-INTERVAL '30 minutes'
    ) AS exists`,
  [jobId, eventType, reasonHash]);
  if (duplicate.rows[0]?.exists) return false;
  await addEvent(client, jobId, eventType, fromState, toState, message, payload);
  return true;
}

function platformOfferStatusSnapshot(offer: OzonPlatformOfferStatus): Record<string, unknown> {
  const snapshot = { ...offer } as Record<string, unknown>;
  delete snapshot.offerId;
  delete snapshot.ozonProductId;
  delete snapshot.ozonSku;
  return snapshot;
}

function platformOfferStatusMeaning(value: unknown): Record<string, unknown> {
  const snapshot = { ...jsonObject(value) };
  // readAt/last_verified_at 表示本次校验发生的时间，不属于商品状态变化。
  delete snapshot.readAt;
  return snapshot;
}

function productLinkFromMapping(mapping: OzonProductMapping): OzonProductLink[] {
  const ozonProductId = String(mapping.ozonProductId || '').trim();
  const ozonSku = String(mapping.ozonSku || '').trim();
  const url = ozonProductUrl(ozonSku);
  if (!ozonProductId || !ozonSku || !url) return [];
  const snapshot = jsonObject(mapping.statusSnapshot);
  const warnings = stringArray(snapshot.warnings);
  return [{
    offerId: mapping.offerId,
    ozonProductId,
    ozonSku,
    url,
    ...(isPlatformOfferDisplayState(snapshot.displayState || mapping.status)
      ? { displayState: String(snapshot.displayState || mapping.status) as OzonProductLink['displayState'] }
      : {}),
    ...(nonBlank(snapshot.platformMessage || snapshot.statusDescription)
      ? { platformMessage: String(snapshot.platformMessage || snapshot.statusDescription).trim() }
      : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(mapping.lastVerifiedAt ? { lastVerifiedAt: mapping.lastVerifiedAt } : {})
  }];
}

function statusRefreshReasonHash(state: string, details: unknown): string {
  return createHash('sha256').update(stableJson({ state, details })).digest('hex');
}

function normalizeOfferIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [];
  return [...new Set(entries.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function normalizeProductLinks(value: unknown): OzonProductLink[] {
  if (!Array.isArray(value)) return [];
  const byOffer = new Map<string, OzonProductLink>();
  for (const entry of value) {
    const source = jsonObject(entry);
    const offerId = String(source.offerId || source.offer_id || '').trim();
    const ozonProductId = String(source.ozonProductId || source.product_id || source.productId || '').trim();
    const ozonSku = String(source.ozonSku || source.ozon_sku || source.sku || '').trim();
    const url = ozonProductUrl(ozonSku, source.url);
    if (!offerId || !url) continue;
    const warnings = stringArray(source.warnings);
    byOffer.set(offerId, {
      offerId,
      ozonProductId,
      ozonSku,
      url,
      ...(isPlatformOfferDisplayState(source.displayState) ? { displayState: String(source.displayState) as OzonProductLink['displayState'] } : {}),
      ...(nonBlank(source.platformMessage) ? { platformMessage: String(source.platformMessage).trim() } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(nonBlank(source.lastVerifiedAt) ? { lastVerifiedAt: String(source.lastVerifiedAt).trim() } : {})
    });
  }
  return [...byOffer.values()];
}

function orderProductLinks(links: OzonProductLink[], offerIds: string[]): OzonProductLink[] {
  const order = new Map(offerIds.map((offerId, index) => [offerId, index]));
  return [...links].sort((left, right) => {
    const leftOrder = order.get(left.offerId) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.offerId) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.offerId.localeCompare(right.offerId);
  });
}

function normalizeProductMappingInput(value: unknown): OzonProductMappingInput | undefined {
  const source = jsonObject(value);
  const offerId = String(source.offerId || source.offer_id || '').trim();
  const ozonProductId = String(source.ozonProductId || source.product_id || source.productId || '').trim();
  if (!offerId || !ozonProductId) return undefined;
  return {
    offerId,
    ozonProductId,
    ...(nonBlank(source.ozonSku || source.sku) ? { ozonSku: String(source.ozonSku || source.sku).trim() } : {}),
    ...(nonBlank(source.warehouseId || source.warehouse_id) ? { warehouseId: String(source.warehouseId || source.warehouse_id).trim() } : {}),
    ...(nonBlank(source.platformStatus || source.status) ? { platformStatus: String(source.platformStatus || source.status).trim() } : {}),
    ...(Object.keys(jsonObject(source.statusSnapshot || source.status_snapshot)).length
      ? { statusSnapshot: jsonObject(source.statusSnapshot || source.status_snapshot) }
      : {})
  };
}

function dedupeProductMappingInputs(values: unknown[]): OzonProductMappingInput[] {
  const mappings = new Map<string, OzonProductMappingInput>();
  for (const value of values) {
    const normalized = normalizeProductMappingInput(value);
    if (!normalized) continue;
    const previous = mappings.get(normalized.offerId);
    if (previous && (
      previous.ozonProductId !== normalized.ozonProductId
      || (previous.ozonSku && normalized.ozonSku && previous.ozonSku !== normalized.ozonSku)
    )) {
      throw new AppError('CONFIG_INVALID', '同一 OZON offerId 返回了冲突的平台映射', {
        offerId: normalized.offerId,
        previous: { ozonProductId: previous.ozonProductId, ozonSku: previous.ozonSku },
        next: { ozonProductId: normalized.ozonProductId, ozonSku: normalized.ozonSku }
      }, 409);
    }
    mappings.set(normalized.offerId, { ...(previous || {}), ...normalized });
  }
  const result = [...mappings.values()];
  const productOwners = new Map<string, string>();
  const skuOwners = new Map<string, string>();
  for (const mapping of result) {
    const productOwner = productOwners.get(mapping.ozonProductId);
    if (productOwner && productOwner !== mapping.offerId) {
      throw new AppError('CONFIG_INVALID', '不同 OZON Offer 不能共享同一 ozonProductId', {
        ozonProductId: mapping.ozonProductId,
        offerIds: [productOwner, mapping.offerId]
      }, 409);
    }
    productOwners.set(mapping.ozonProductId, mapping.offerId);
    if (mapping.ozonSku) {
      const skuOwner = skuOwners.get(mapping.ozonSku);
      if (skuOwner && skuOwner !== mapping.offerId) {
        throw new AppError('CONFIG_INVALID', '不同 OZON Offer 不能共享同一 ozonSku', {
          ozonSku: mapping.ozonSku,
          offerIds: [skuOwner, mapping.offerId]
        }, 409);
      }
      skuOwners.set(mapping.ozonSku, mapping.offerId);
    }
  }
  return result;
}

function normalizeDirectoryStage(value: unknown): OzonTaskDirectoryStage | undefined {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'INBOX' || normalized === 'PROCESSING' || normalized === 'SUCCESS'
    ? normalized
    : undefined;
}

type FrozenPublicationRuntimeIdentity = {
  taskId: string;
  storeAlias: string;
  warehouseId: string;
  revision: number;
  taskFolder: string;
  directoryStage: OzonTaskDirectoryStage;
  workRelPath: string;
};

/**
 * Validates the caller-controlled runtime projection against a schema-v3
 * publication job. Historical pre-v3 rows retain their legacy path bootstrap,
 * but every new publication keeps its DB snapshot as the only authority.
 */
export function assertFrozenOzonPublicationRuntimeInput(
  current: SqlRow,
  input: OzonJobTransitionInput | OzonRuntimeUpdateInput
): FrozenPublicationRuntimeIdentity | undefined {
  const currentPayload = jsonObject(current.payload);
  if (!current.publication_id || Number(currentPayload.schemaVersion || 0) < 3) return undefined;

  const storeAlias = String(current.store_alias || '').trim();
  const sku = String(current.sku || '').trim();
  const revision = Number(current.listing_revision);
  const taskId = String(current.task_id || '').trim();
  const warehouseId = String(current.warehouse_id || '').trim();
  const taskFolder = `${sku}__r${revision}`;
  const deterministicTaskId = `${storeAlias}__${sku}__r${revision}`;
  if (!storeAlias || !sku || !Number.isSafeInteger(revision) || revision <= 0
    || taskId !== deterministicTaskId || !warehouseId) {
    throw new AppError('VERSION_CONFLICT', 'OZON publication 冻结运行时身份不完整', {
      jobId: current.id,
      fields: { storeAlias, sku, revision, taskId, warehouseId }
    }, 409);
  }

  const payload = jsonObject(input.jobPayload);
  const mismatches: string[] = [];
  const assertString = (field: string, expected: string, values: unknown[]) => {
    if (values.some((value) => value !== undefined && value !== null && String(value).trim() !== expected)) {
      mismatches.push(field);
    }
  };
  const assertNumber = (field: string, expected: number, values: unknown[]) => {
    if (values.some((value) => value !== undefined && value !== null && Number(value) !== expected)) {
      mismatches.push(field);
    }
  };

  assertString('taskId', taskId, [input.taskId, payload.taskId]);
  assertString('storeId', String(current.store_id || ''), [payload.storeId]);
  assertString('storeAlias', storeAlias, [input.storeAlias, payload.storeAlias]);
  assertString('publicationId', String(current.publication_id), [payload.publicationId]);
  assertString('credentialVersionId', String(current.credential_version_id || ''), [payload.credentialVersionId]);
  assertString('credentialBindingMode', String(current.credential_binding_mode || ''), [payload.credentialBindingMode]);
  assertNumber('storeConfigVersion', Number(current.store_config_version), [payload.storeConfigVersion]);
  assertString('warehouseId', warehouseId, [
    (input as OzonRuntimeUpdateInput).warehouseId,
    payload.warehouseId,
    ...((input as OzonRuntimeUpdateInput).productMappings || []).map((mapping) => mapping.warehouseId)
  ]);
  assertString('offerContractHash', String(current.offer_contract_hash || ''), [payload.offerContractHash]);
  assertString('materializationHash', String(current.materialization_hash || ''), [payload.materializationHash]);
  const frozenOfferIds = normalizeOfferIds(current.offer_ids);
  if (!frozenOfferIds.length) mismatches.push('offerIds');
  for (const proposedOfferIds of [input.offerIds, payload.offerIds]) {
    if (proposedOfferIds !== undefined
      && stableJson(normalizeOfferIds(proposedOfferIds)) !== stableJson(frozenOfferIds)) {
      mismatches.push('offerIds');
    }
  }
  assertNumber('revision', revision, [
    input.revision,
    payload.revision,
    (input as OzonRuntimeUpdateInput).lastAppliedRevision
  ]);

  const rawStage = input.directoryStage ?? payload.directoryStage ?? current.directory_stage;
  const directoryStage = normalizeDirectoryStage(rawStage);
  if (!directoryStage) mismatches.push('directoryStage');
  const suppliedTaskFolders = [input.taskFolder, payload.taskFolder];
  if (suppliedTaskFolders.some((value) => value !== undefined && value !== null
    && normalizeTaskFolder(value) !== taskFolder)) mismatches.push('taskFolder');
  const suppliedPaths = [input.workRelPath, payload.workRelPath];
  const normalizedSuppliedPaths = suppliedPaths
    .filter((value) => value !== undefined && value !== null)
    .map((value) => normalizeOptionalRelativePath(value)!);
  let workRelPath: string;
  if (directoryStage === 'SUCCESS') {
    const candidate = normalizedSuppliedPaths[0] || '';
    const segments = candidate.split('/');
    const validSuccessPath = input.state === 'SUCCEEDED'
      && normalizedSuppliedPaths.length > 0
      && new Set(normalizedSuppliedPaths).size === 1
      && segments.length === 3
      && segments[0] === 'success'
      && isStrictIsoCalendarDate(segments[1] || '')
      && segments[2] === taskId;
    if (!validSuccessPath) mismatches.push('workRelPath');
    workRelPath = candidate;
  } else {
    workRelPath = directoryStage === 'INBOX'
      ? `stores/${storeAlias}/inbox/${sku}`
      : `processing/${taskId}`;
    if (normalizedSuppliedPaths.some((value) => value !== workRelPath)) mismatches.push('workRelPath');
  }

  if (mismatches.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON runtime 回调试图修改 publication 冻结身份', {
      jobId: current.id,
      mismatches: [...new Set(mismatches)]
    }, 409);
  }
  return { taskId, storeAlias, warehouseId, revision, taskFolder, directoryStage: directoryStage!, workRelPath };
}

function isStrictIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const candidate = new Date(Date.UTC(year!, month! - 1, day!));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month! - 1
    && candidate.getUTCDate() === day;
}

function normalizeOptionalRelativePath(value: unknown): string | undefined {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized) return undefined;
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 任务目录只允许平台无关的相对路径', { workRelPath: value }, 403);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 任务相对路径包含非法片段', { workRelPath: value }, 403);
  }
  return normalized;
}

function normalizeTaskFolder(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (normalized.includes('/') || normalized.includes('\\') || normalized === '.' || normalized === '..' || normalized.includes('\0')) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 任务文件夹名称无效', { taskFolder: value }, 403);
  }
  return normalized;
}

function tryNormalizeRelativePath(value: unknown): string | undefined {
  try {
    return normalizeOptionalRelativePath(value);
  } catch {
    return undefined;
  }
}

function tryNormalizeTaskFolder(value: unknown): string | undefined {
  try {
    return normalizeTaskFolder(value);
  } catch {
    return undefined;
  }
}

function sanitizePersistentJobPayload(value: unknown): Record<string, unknown> {
  const payload = { ...jsonObject(value) };
  if (nonBlank(payload.productJsonPath) || nonBlank(payload.workDirectory)) payload.productJsonGenerated = true;
  delete payload.productJsonPath;
  delete payload.workDirectory;
  return payload;
}

function applyRuntimePathProjection(row: SqlRow, projection?: OzonPublishJob): SqlRow {
  if (!projection) return row;
  if (String(row.id || '') !== projection.id
    || String(row.sku || '') !== projection.sku
    || Number(row.listing_revision || 0) !== Number(projection.revision || 0)
    || (nonBlank(row.work_rel_path) && String(row.work_rel_path) !== String(projection.workRelPath || ''))) {
    throw new AppError('VERSION_CONFLICT', '历史 OZON 任务路径投影与持久化任务身份不一致', { jobId: row.id }, 409);
  }
  const workRelPath = normalizeOptionalRelativePath(projection.workRelPath);
  if (!workRelPath || projection.directoryStage !== 'PROCESSING') {
    throw new AppError('VERSION_CONFLICT', '历史 OZON 任务无法派生安全的 processing 相对路径', { jobId: row.id }, 409);
  }
  const projectionPayload = jsonObject(projection.payload);
  return {
    ...row,
    directory_stage: projection.directoryStage,
    work_rel_path: workRelPath,
    payload: {
      ...jsonObject(row.payload),
      workRelPath,
      directoryStage: projection.directoryStage,
      workDirectory: projectionPayload.workDirectory,
      productJsonPath: projectionPayload.productJsonPath
    }
  };
}

function portableRelPath(...segments: string[]): string {
  return normalizeOptionalRelativePath(segments.join('/'))!;
}

async function migrateOzonSkuModelIdentity(client: PoolClient): Promise<number> {
  const drafts = await client.query<SqlRow>(`
    SELECT draft.*,
      COALESCE(bound_version.snapshot->'attributes',
        published_version.snapshot->'attributes',
        '[]'::jsonb) AS category_attributes
    FROM ozon_listing_drafts draft
    LEFT JOIN ozon_category_template_versions bound_version
      ON bound_version.id::text=draft.data->>'categoryVersionId'
    LEFT JOIN ozon_category_templates category
      ON category.category_key=draft.data->>'categoryKey'
    LEFT JOIN ozon_category_template_versions published_version
      ON published_version.id=category.published_version_id
    ORDER BY draft.sku`);
  let changed = 0;
  for (const draft of drafts.rows) {
    const sku = normalizeSku(draft.sku);
    const categoryAttributes = Array.isArray(draft.category_attributes)
      ? draft.category_attributes as OzonCategoryAttribute[]
      : [];
    const normalizedData = enforceOzonSkuIdentity(
      jsonObject(draft.data) as OzonListingDraft['data'],
      sku,
      categoryAttributes
    );
    const updated = await client.query<SqlRow>(`
      UPDATE ozon_listing_drafts
      SET data=$2::jsonb,row_version=row_version+1,revision=revision+1,updated_at=NOW()
      WHERE sku=$1 AND data IS DISTINCT FROM $2::jsonb
      RETURNING *`,
    [sku, JSON.stringify(normalizedData)]);
    const row = updated.rows[0];
    if (!row) continue;
    await client.query(`
      INSERT INTO ozon_listing_versions(id,sku,revision,snapshot)
      VALUES($1,$2,$3,$4::jsonb)`,
    [randomUUID(), sku, Number(row.revision), JSON.stringify({ ...row, data: normalizedData })]);
    changed += 1;
  }
  return changed;
}

async function migrateOzonPlatformTypeIdentity(client: PoolClient): Promise<number> {
  const drafts = await client.query<SqlRow>(`
    SELECT draft.*,
      COALESCE(bound_version.snapshot->'attributes',
        published_version.snapshot->'attributes',
        '[]'::jsonb) AS category_attributes,
      COALESCE(bound_category.type_id,selected_category.type_id) AS category_type_id
    FROM ozon_listing_drafts draft
    LEFT JOIN ozon_category_template_versions bound_version
      ON bound_version.id::text=draft.data->>'categoryVersionId'
    LEFT JOIN ozon_category_templates bound_category
      ON bound_category.category_key=bound_version.category_key
    LEFT JOIN ozon_category_templates selected_category
      ON selected_category.category_key=draft.data->>'categoryKey'
    LEFT JOIN ozon_category_template_versions published_version
      ON published_version.id=selected_category.published_version_id
    ORDER BY draft.sku`);
  let changed = 0;
  for (const draft of drafts.rows) {
    const typeId = Number(draft.category_type_id);
    if (!Number.isSafeInteger(typeId) || typeId <= 0) continue;
    const categoryAttributes = Array.isArray(draft.category_attributes)
      ? draft.category_attributes as OzonCategoryAttribute[]
      : [];
    const data = jsonObject(draft.data) as OzonListingDraft['data'];
    const normalizedData = {
      ...data,
      sharedAttributes: enforceOzonProductTypeAttribute(
        Array.isArray(data.sharedAttributes) ? data.sharedAttributes : [],
        typeId,
        categoryAttributes
      )
    };
    const updated = await client.query<SqlRow>(`
      UPDATE ozon_listing_drafts
      SET data=$2::jsonb,row_version=row_version+1,revision=revision+1,updated_at=NOW()
      WHERE sku=$1 AND data IS DISTINCT FROM $2::jsonb
      RETURNING *`,
    [normalizeSku(draft.sku), JSON.stringify(normalizedData)]);
    const row = updated.rows[0];
    if (!row) continue;
    await client.query(`
      INSERT INTO ozon_listing_versions(id,sku,revision,snapshot)
      VALUES($1,$2,$3,$4::jsonb)`,
    [randomUUID(), row.sku, Number(row.revision), JSON.stringify({ ...row, data: normalizedData })]);
    changed += 1;
  }
  return changed;
}

async function backfillHistoricalJobMappings(client: PoolClient): Promise<void> {
  const systemStoreAlias = 'default';
  const result = await client.query<SqlRow>(`
    SELECT job.*,
      COALESCE(jsonb_agg(event.payload ORDER BY event.created_at,event.id)
        FILTER (WHERE event.id IS NOT NULL),'[]'::jsonb) AS event_payloads,
      draft.data AS listing_data,
      draft.revision AS listing_revision
    FROM ozon_publish_jobs job
    LEFT JOIN ozon_publish_events event ON event.job_id=job.id
    LEFT JOIN ozon_listing_drafts draft ON draft.sku=job.sku
    GROUP BY job.id,draft.data,draft.revision
    ORDER BY job.created_at,job.id`);
  for (const row of result.rows) {
    const payload = jsonObject(row.payload);
    const eventPayloads = Array.isArray(row.event_payloads) ? row.event_payloads : [];
    const mappings = extractHistoricalProductMappings(eventPayloads);
    const payloadOfferIds = normalizeOfferIds(payload.offerIds);
    const eventOfferIds = mappings.map((mapping) => mapping.offerId);
    const listingOffers = Number(payload.revision || 0) === Number(row.listing_revision || -1)
      && Array.isArray(row.listing_data?.offers)
      ? row.listing_data.offers.map((offer: unknown) => jsonObject(offer).offerId)
      : [];
    const offerIds = normalizeOfferIds([
      ...normalizeOfferIds(row.offer_ids),
      ...(row.offer_id ? [row.offer_id] : []),
      ...payloadOfferIds,
      ...eventOfferIds,
      ...listingOffers
    ]);
    const storeAlias = requiredStoreAlias(payload.storeAlias || row.store_alias || systemStoreAlias);
    const revision = Math.max(0, Number(payload.revision || 0));
    const links = orderProductLinks(normalizeProductLinks([
      ...normalizeProductLinks(row.product_links),
      ...mappings.map((mapping) => ({
        offerId: mapping.offerId,
        ozonProductId: mapping.ozonProductId,
        ozonSku: mapping.ozonSku
      }))
    ]), offerIds);
    const legacyPath = String(payload.productJsonPath || '').replaceAll('\\', '/');
    const inferredWorkRelPath = tryNormalizeRelativePath(payload.workRelPath)
      || (legacyPath.includes(`/inbox/${row.sku}/`) ? portableRelPath('inbox', row.sku) : undefined);
    const taskFolder = tryNormalizeTaskFolder(payload.taskFolder)
      || (revision > 0 ? `${row.sku}__r${revision}` : undefined);
    await client.query(`
      UPDATE ozon_publish_jobs
      SET store_alias=$2,offer_ids=$3::jsonb,product_links=$4::jsonb,
          work_rel_path=COALESCE(work_rel_path,$5),task_folder=COALESCE(task_folder,$6),
          directory_stage=COALESCE(directory_stage,$7),directory_signature=COALESCE(directory_signature,$8),
          listing_revision=CASE WHEN listing_revision>0 THEN listing_revision ELSE $9 END
      WHERE id=$1`,
    [
      row.id,
      storeAlias,
      JSON.stringify(offerIds),
      JSON.stringify(links),
      inferredWorkRelPath || null,
      taskFolder || null,
      inferredWorkRelPath?.startsWith('processing/') ? 'PROCESSING'
        : inferredWorkRelPath?.startsWith('success/') ? 'SUCCESS'
          : inferredWorkRelPath?.startsWith('inbox/') ? 'INBOX' : null,
      String(payload.directorySignature || payload.signature || payload.mediaSignature || '').trim() || null,
      revision
    ]);
    for (const mapping of mappings) {
      await client.query(`
        INSERT INTO ozon_product_mappings(
          store_alias,offer_id,sku,ozon_product_id,ozon_sku,warehouse_id,last_applied_revision,status,last_verified_at,updated_at
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        ON CONFLICT(store_alias,offer_id) DO UPDATE SET
          sku=EXCLUDED.sku,
          ozon_product_id=COALESCE(EXCLUDED.ozon_product_id,ozon_product_mappings.ozon_product_id),
          ozon_sku=COALESCE(EXCLUDED.ozon_sku,ozon_product_mappings.ozon_sku),
          warehouse_id=COALESCE(EXCLUDED.warehouse_id,ozon_product_mappings.warehouse_id),
          last_applied_revision=GREATEST(ozon_product_mappings.last_applied_revision,EXCLUDED.last_applied_revision),
          status=EXCLUDED.status,last_verified_at=NOW(),updated_at=NOW()`,
      [
        storeAlias, mapping.offerId, row.sku, mapping.ozonProductId, mapping.ozonSku || null,
        mapping.warehouseId || null, revision, row.state
      ]);
    }
  }
}

async function backfillFrontendSkuProductLinks(client: PoolClient): Promise<void> {
  const result = await client.query<SqlRow>(`
    SELECT job.id,job.product_links,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'offerId',mapping.offer_id,
            'ozonProductId',mapping.ozon_product_id,
            'ozonSku',mapping.ozon_sku
          )
        ) FILTER (WHERE mapping.offer_id IS NOT NULL),
        '[]'::jsonb
      ) AS current_mappings
    FROM ozon_publish_jobs job
    LEFT JOIN ozon_product_mappings mapping
      ON mapping.store_alias=job.store_alias
      AND mapping.sku=job.sku
    WHERE jsonb_typeof(job.product_links)='array'
      AND jsonb_array_length(job.product_links)>0
    GROUP BY job.id
    ORDER BY job.created_at,job.id`);
  for (const row of result.rows) {
    const storedLinks = Array.isArray(row.product_links) ? row.product_links : [];
    const mappings = Array.isArray(row.current_mappings) ? row.current_mappings.map(jsonObject) : [];
    let changed = false;
    const nextLinks = storedLinks.map((entry: unknown) => {
      const source = jsonObject(entry);
      const offerId = String(source.offerId || source.offer_id || '').trim();
      const ozonProductId = String(source.ozonProductId || source.product_id || source.productId || '').trim();
      const mapping = mappings.find((candidate) =>
        String(candidate.offerId || '').trim() === offerId
        && String(candidate.ozonProductId || '').trim() === ozonProductId
      );
      const ozonSku = String(mapping?.ozonSku || '').trim();
      const url = ozonProductUrl(ozonSku, source.url);
      if (!offerId || !ozonProductId || !url) return entry;
      if (String(source.ozonSku || source.ozon_sku || '').trim() !== ozonSku || source.url !== url) changed = true;
      return { offerId, ozonProductId, ozonSku, url };
    });
    if (changed) {
      await client.query('UPDATE ozon_publish_jobs SET product_links=$2::jsonb WHERE id=$1', [
        row.id,
        JSON.stringify(nextLinks)
      ]);
    }
  }
}

function extractHistoricalProductMappings(payloads: unknown[]): OzonProductMappingInput[] {
  const candidates: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const object = jsonObject(value);
    if (!Object.keys(object).length) return;
    const offerId = object.offerId || object.offer_id;
    const productId = object.ozonProductId || object.productId || object.product_id || object.id;
    if (offerId && productId) {
      candidates.push({
        offerId,
        ozonProductId: productId,
        ozonSku: object.ozonSku || object.sku,
        warehouseId: object.warehouseId || object.warehouse_id,
        platformStatus: object.platformStatus || object.status
      });
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(payloads);
  return dedupeProductMappingInputs(candidates);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}
