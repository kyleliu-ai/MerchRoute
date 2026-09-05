import type {
  OzonPublishRetryPlan,
  OzonPublishRetryRecord,
  OzonPublishRetryRequest,
  WbPublishRetryDetail,
  WbPublishRetryRequest,
  WbPublishRetryRecord,
  AppConfig,
  ReviewOperation,
  ReviewOperationProgress,
  OzonAutomaticListingSnapshot,
  OzonCategoryAttributeOrderInput,
  OzonCategoryTemplate,
  OzonCatalogDictionaryName,
  OzonCatalogDictionaryResult,
  OzonCatalogEntry,
  OzonCatalogStatus,
  OzonListingDraft,
  OzonListingDraftInput,
  OzonSharedMaterialDraftInput,
  OzonListingDetail,
  OzonManualJobDetail,
  OzonMediaAsset,
  OzonPreset,
  OzonPresetInput,
  OzonPlatformBusinessState,
  OzonPlatformOfferDisplayState,
  OzonPlatformOfferStatus,
  OzonPreparationFanoutSummary,
  OzonPreparationManualSuccessReconcileInput,
  OzonPreparationManualSuccessReconcilePlan,
  OzonPreparationManualSuccessReconcileResult,
  OzonPreparationRecheckInput,
  OzonPreparationRecheckPlan,
  OzonPreparationTaskDetail,
  OzonProductMapping,
  OzonPublicationAttemptResult,
  OzonPublicationCreateResult,
  OzonPublicationRecheckInput,
  OzonPublicationTaskSummary,
  OzonPublicationTaskDetail,
  OzonPublishJob,
  OzonPublicationPlan,
  OzonStore,
  OzonStoreCreate,
  OzonStorePublication,
  OzonStoreSystemSettings,
  OzonStoreUpdate,
  OzonSourceMediaCleanupSummary,
  OzonSystemSettings,
  MediaIndexState,
  PendingSubmission,
  PricingCalculationInput,
  PricingCalculationResult as SharedPricingCalculationResult,
  PricingOptionResult,
  PricingProductQueryInput,
  PricingProductQueryResult,
  PricingTemplateDefinitionV1,
  ProductTask,
  ProductVariant,
  ShippingCalculationInput,
  ShippingTemplateDefinitionV1,
  ShippingVersionStatus,
  StageSummary,
  StageView,
  SubmissionBatchRecord,
  SubmissionRecord,
  TaskDetail,
  VariantSelectionGroup,
  WbColorIdentity,
  WbNetworkRecovery,
  WbPurchaseMeasurements,
  WorkflowParameterOptions,
  WorkflowParameters
} from '@n8n-media-review/shared';

export type {
  OzonAutomaticListingSnapshot,
  OzonCategoryTemplate,
  OzonCatalogDictionaryName,
  OzonCatalogDictionaryResult,
  OzonCatalogEntry,
  OzonCatalogStatus,
  OzonListingDraft,
  OzonListingDraftInput,
  OzonSharedMaterialDraftInput,
  OzonListingDetail,
  OzonManualJobDetail,
  OzonMediaAsset,
  OzonPreset,
  OzonPresetInput,
  OzonPlatformBusinessState,
  OzonPlatformOfferDisplayState,
  OzonPlatformOfferStatus,
  OzonPreparationFanoutSummary,
  OzonPreparationManualSuccessReconcileInput,
  OzonPreparationManualSuccessReconcilePlan,
  OzonPreparationManualSuccessReconcileResult,
  OzonPreparationRecheckInput,
  OzonPreparationRecheckPlan,
  OzonPreparationTaskDetail,
  OzonProductMapping,
  OzonPublicationAttemptResult,
  OzonPublicationCreateResult,
  OzonPublicationRecheckInput,
  OzonPublicationTaskSummary,
  OzonPublicationTaskDetail,
  OzonPublishJob,
  OzonPublicationPlan,
  OzonStore,
  OzonStoreCreate,
  OzonStorePublication,
  OzonStoreSystemSettings,
  OzonStoreUpdate,
  OzonSourceMediaCleanupSummary,
  OzonSystemSettings
};

export type OzonPublicSystemSettings = Omit<OzonSystemSettings,
  'defaultStoreAlias' | 'credentialReady' | 'sellerId' | 'sellerName' | 'accountCurrency'
  | 'lastPreflightAt' | 'lastPreflightStatus' | 'lastPreflightMessage'>;

export type { MediaIndexState, StageView };

export type OzonReadiness = {
  ready: boolean;
  mediaReady: boolean;
  databaseReady: boolean;
  rootReady: boolean;
  workflowReady: boolean;
  videoUploadReady: boolean;
  settings: OzonPublicSystemSettings;
  issues: string[];
  mediaIssues: string[];
};

export type OzonAutomationStatus = {
  readiness: OzonReadiness;
  counts: Record<string, number>;
  businessCounts?: Record<string, number>;
  managementEnabled: boolean;
  acceptingNewJobs: boolean;
  continuingBoundJobs: number;
  eligibleAutoStoreCount: number;
  blockedAutoStoreCount: number;
  worker: { running: boolean; lastReconciledAt?: string };
};

export type OzonStorePublishMode = OzonStore['autoPublishMode'];
export type OzonStoreCredentialState = OzonStore['credential']['state'];
export type OzonStoreWarehouse = OzonStore['warehouses'][number];
export type OzonStoreInput = Omit<OzonStoreUpdate, 'rowVersion'> & { storeAlias?: string };
export type OzonStoreSettings = OzonStoreSystemSettings;
export type OzonPublicationStatus = OzonStorePublication['status'];
export type OzonTaskKind = OzonPublishJob['taskKind'];
export type OzonFanoutSummary = OzonPreparationFanoutSummary;
export type OzonPublication = OzonStorePublication;
export type OzonMaterialPersistenceResult = {
  listing: OzonListingDraft;
  generatedVersionId: string;
  materialRevision: number;
  materialHash: string;
  contentPolicyVersion: string;
};
export type OzonPreparationTaskDetailResponse = OzonPreparationTaskDetail;
export type OzonPreparationMaterialSnapshot = {
  snapshot: Pick<OzonListingDraft,
    'sku' | 'productName' | 'data'
    | 'generatedVersionId' | 'materialRevision' | 'materialHash'
    | 'materialHashVersion' | 'contentPolicyVersion'>;
};
export type OzonPreparationRecheckResult = {
  job: OzonPublishJob;
  requestId: string;
};
export type OzonPublicationCompatibleAppendPlan = {
  planHash: string;
  ready: boolean;
  blockers: string[];
  newOfferIds: string[];
  createdAt?: string;
};

export type PendingView = PendingSubmission & {
  sourceFolderName: string;
  approvedAt?: string;
  targetQueueRoot?: string;
  sourceStageEnabled: boolean;
  targetStageEnabled: boolean;
  disabledReason?: string;
};
export type SubmissionHistoryQuery = { sku?: string; completedFrom?: string; completedTo?: string };
export type WorkflowParameterTemplateView = { stageId: string; fileName: string; optionsFileName: string; parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions };
export type DownloadSyncState = { status: 'synced' | 'pending'; message?: string; syncedAt?: string };
export type WbPublishingConfig = { enabled: boolean; rootDirectory: string };
export type WbPublishingReadiness = {
  status: 'DISABLED' | 'NOT_CONFIGURED' | 'DIRECTORY_UNAVAILABLE' | 'SYNC_PENDING' | 'READY';
  complete: boolean;
  enabled: boolean;
  rootDirectory: string;
  derivedDirectoryPattern: string;
  local?: PathValidation;
  n8nSync: Omit<DownloadSyncState, 'status'> & { status: DownloadSyncState['status'] | 'disabled'; remoteRootDirectory?: string };
};
export type WbStorePublishMode = 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
export type WbStore = {
  id: string;
  storeAlias: string;
  displayName: string;
  enabled: boolean;
  autoPublishEnabled: boolean;
  autoPublishMode: WbStorePublishMode;
  autoPublishActivatedAt?: string;
  defaultPresetId?: string;
  warehouseId: string;
  warehouseName: string;
  accountCurrency: string;
  maxDailyStyles: number;
  credential: {
    state: 'MISSING' | 'LEGACY_EXTERNAL' | 'PENDING' | 'ACTIVE';
    configured: boolean;
    activeVersionId?: string;
    pendingVersionId?: string;
    fingerprint?: string;
    version?: number;
    updatedAt?: string;
  };
  seller: { id?: string; name?: string };
  permissions: string[];
  preflight: {
    status: 'NOT_RUN' | 'PENDING' | 'PASSED' | 'FAILED' | 'STALE';
    currencyVerified?: boolean;
    currencyVerification?: 'VERIFIED' | 'DEFERRED_EMPTY_CATALOG';
    checkedAt?: string;
    errorCode?: string;
    errorMessage?: string;
  };
  network: { status: 'READY' | 'WAITING' | 'ERROR'; nextAttemptAt?: string; errorCode?: string; errorMessage?: string };
  readiness: { ready: boolean; blockers: string[] };
  activeTaskCount: number;
  queuedTaskCount: number;
  configVersion: number;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};
export type WbStoreInput = {
  storeAlias?: string;
  displayName: string;
  defaultPresetId?: string | null;
  autoPublishEnabled?: boolean;
  autoPublishMode?: WbStorePublishMode;
  warehouseId?: string;
  warehouseName?: string;
  accountCurrency?: string;
  maxDailyStyles?: number;
};
export type WbSystemSettings = {
  enabled: boolean;
  rootDirectory: string;
  timezone: string;
  globalConcurrency: number;
  perStoreConcurrency: 1;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type WbPublicationSelection = { storeId: string };
export type WbStorePublicationStatus = 'PLANNED' | 'DISPATCHING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NEEDS_ATTENTION' | 'PAUSED';
export type WbPublicationPlan = {
  planHash: string;
  sku: string;
  draftVersion: number;
  createdAt: string;
  items: Array<{
    storeId: string;
    storeAlias: string;
    displayName: string;
    presetId?: string;
    presetDefinitionHash: string;
    materializationHash: string;
    presetName?: string;
    discountPercent?: number;
    expectedPriceCny?: number;
    categoryKey?: string;
    categoryName?: string;
    packaging?: { grossWeightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
    autoPublishMode: WbStorePublishMode;
    ready: boolean;
    blockers: string[];
    storeRowVersion: number;
    storeConfigVersion: number;
    credentialVersionId?: string;
    warehouseId: string;
  }>;
};
export type WbStorePublication = {
  id: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  storeId: string;
  storeAlias: string;
  storeDisplayName?: string;
  status: WbStorePublicationStatus;
  source: string;
  presetId?: string;
  presetName?: string;
  presetRowVersion?: number;
  operationMode?: WbStorePublishMode;
  draftVersion?: number;
  sourcePresetExists?: boolean;
  presetDefinitionHash?: string;
  planHash?: string;
  materializationHash?: string;
  packageRelPath?: string;
  packageSignature?: string;
  credentialVersionId?: string;
  taskId?: string;
  nmIds: Array<string | number>;
  productUrls: string[];
  productLinks?: Array<{ nmId: string | number; url: string; variantCode?: string }>;
  result: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  configSnapshot?: Record<string, unknown>;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
export type WbAppConfig = AppConfig & { version: 'v002' | 'v003'; wbPublishing?: WbPublishingConfig };
export type LegacyRootCompatibilityView = {
  enabled: boolean;
  required: boolean;
  status: 'DISABLED' | 'READY' | 'BLOCKED';
  legacyRoot?: string;
  canonicalRoot?: string;
  legacyPathPresent: boolean;
  canonicalRootReady: boolean;
  mappingSelfTest: boolean;
  legacyPathTargetsCanonicalRoot?: boolean;
  checkedAt: string;
  issues: string[];
  referenceCounts: {
    stateStore: Record<string, number>;
    purchases: {
      databaseConfigured: boolean;
      downloadJobs: number;
      nonterminalDownloadJobs: number;
      notifications: number;
      unresolvedNotifications: number;
    };
  };
};
export type ConfigView = { config: WbAppConfig; readiness: { complete: boolean; paths: PathValidation[]; legacyRootCompatibility: LegacyRootCompatibilityView; maintenanceMode: { active: boolean; acceptingNewTasks: boolean; reason?: string } }; downloadSync?: DownloadSyncState; wbPublishingReadiness?: WbPublishingReadiness; ozonPublishingReadiness?: OzonReadiness };
export type ProcurementVersion = {
  id: string; versionNo: number; downloadWorkflowCode?: string; purchasePrice: string; retailPrice?: string | null; courierFee: string; currency: string;
  grossWeightGrams?: string | null; lengthCm?: string | null; widthCm?: string | null; heightCm?: string | null;
  netWeightGrams?: string | null; productHeightCm?: string | null; productDepthCm?: string | null; productWidthCm?: string | null;
  transportMode?: string; providerUrl: string; createdAt: string;
};
export type DownloadWorkflow = {
  code: string; displayName: string; webhookUrl: string; parentOutputDir: string; timeoutMs: number;
  enabled: boolean; isDefault: boolean; recoveryMode: 'MANUAL' | 'IDEMPOTENT_REPLAY'; createdAt: string; updatedAt: string;
};
export type PurchaseDownloadJob = {
  id: string; sku?: string; workflowCode: string; workflowSnapshot: DownloadWorkflow;
  requestBody: { downloadJobId?: string; productName: string; SKU?: string; productUrl: string; parentOutputDir: string };
  status: 'QUEUED' | 'WAITING_RESOURCE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'; attempt: number; result?: Record<string, unknown>;
  errorMessage?: string; outputDir?: string; batchId?: string; batchPosition?: number; queueSequence?: number;
  notificationThreadId?: string; nextAttemptAt?: string; retryReason?: string; resourceRetryCount: number;
  resourceWaitStartedAt?: string; createdAt: string; startedAt?: string; finishedAt?: string;
};
export type PurchaseDownloadBatch = {
  id: string; totalRequested: number; queuedCount: number; skippedCount: number;
  skippedItems: Array<{ sku: string; workflowCode: string; reason: string; message: string }>;
  status: 'RUNNING' | 'COMPLETED'; counts: Record<PurchaseDownloadJob['status'], number>;
  createdAt: string; finishedAt?: string; items: PurchaseDownloadJob[];
};
export type TaskNotification = {
  id: string; category: string; eventType: string; severity: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  title: string; message: string; sourceType: string; sourceId: string; batchId?: string; sku?: string;
  productName?: string; workflowCode?: string; details: Record<string, unknown>; readAt?: string; resolvedAt?: string;
  createdAt: string; updatedAt: string;
};
export type PurchaseEntryOrigin = {
  methodKey: string;
  label: string;
  platform?: string;
  workflowCode?: string;
  sourceType: 'LOCAL_IMPORT' | 'URL_DOWNLOAD' | 'OTHER';
  sourceId?: string;
  recordedAt: string;
};
export type PurchaseEntryMethodFacet = Omit<PurchaseEntryOrigin, 'methodKey' | 'sourceId' | 'recordedAt'> & { value: string; count: number };
export type PurchaseSummary = {
  sku: string; productName: string; variants: string[]; createdAt: string; updatedAt: string; procurement: ProcurementVersion;
  entryOrigin: PurchaseEntryOrigin; localMediaFolder?: string;
  latestDownloadJob?: Pick<PurchaseDownloadJob, 'id' | 'status' | 'workflowCode' | 'outputDir' | 'createdAt' | 'finishedAt' | 'errorMessage' | 'nextAttemptAt' | 'retryReason' | 'resourceRetryCount'>;
};
export type PurchaseDetail = { sku: string; productName: string; variants: string[]; createdAt: string; updatedAt: string; procurementVersions: ProcurementVersion[]; downloadJobs: PurchaseDownloadJob[] };
export type PurchaseInput = {
  productName: string; downloadWorkflowCode?: string; purchasePrice: string; retailPrice?: string | null; courierFee?: string | null; currency?: string; grossWeightGrams?: string | null;
  lengthCm?: string | null; widthCm?: string | null; heightCm?: string | null; netWeightGrams?: string | null;
  productHeightCm?: string | null; productDepthCm?: string | null; productWidthCm?: string | null; providerUrl: string;
};
export type LocalImportDirectory = {
  name: string; relativePath: string; platform: string; hasChildren: boolean; childDirectoryCount: number;
  createdAt: string; modifiedAt: string; importStatus?: 'IMPORTED' | 'NEW';
};
export type LocalImportPreview = {
  token: string; previewHash: string; sourceConfigHash: string; targetConfigHash: string; expiresAt: string;
  sourcePlatform: string; importWorkflowLabel: string;
  priceConversion: {
    sourceCurrency: 'CNY' | 'RUB'; exchangeRate?: string; status: 'NOT_REQUIRED' | 'CALCULATED' | 'MANUAL_REQUIRED';
    issue?: 'MISSING' | 'INVALID'; calculatedPurchasePrice?: string;
  };
  fileCount: number; imageCount: number; fields: Omit<PurchaseInput, 'downloadWorkflowCode'>;
  sources: Array<{
    platform: string; relativePath: string; normalizedPathKey: string; directoryName: string; isPrimary: boolean;
    externalSku?: string; informationFileRelativePath?: string; informationFileSha256?: string; providerUrls: string[];
    files: Array<{ relativePath: string; sha256: string; sizeBytes: number }>;
  }>;
};
export type LocalImportRecord = {
  id: string; idempotencyKey: string; sku?: string; duplicateSku?: string;
  status: 'COPYING' | 'IMPORTED' | 'SKIPPED_DUPLICATE' | 'COPY_FAILED_RETRYABLE';
  sourcePlatform?: string; importWorkflowLabel?: string;
  previewHash: string; retryCount: number; errorCode?: string; errorMessage?: string; targetFolder?: string;
  createdAt: string; updatedAt: string; completedAt?: string;
  sources: Array<{
    id: string; platform: string; relativePath: string; normalizedPathKey: string; isPrimary: boolean;
    externalSku?: string; informationFileRelativePath?: string; informationFileSha256?: string;
    providerUrl?: string; targetSubdirectory: string; copyManifest: Record<string, unknown>;
  }>;
  purchase?: { sku: string; productName: string; variants: string[]; createdAt: string; updatedAt: string; procurement: ProcurementVersion };
};
export type LocalImportListItem = Omit<LocalImportRecord, 'sources'> & { sourceDirectoryCount: number };
export type ShippingCarrier = { code: string; displayName: string; active: boolean; createdAt: string; updatedAt: string };
export type ShippingTemplateVersion = {
  id: string; versionNo: number; status: ShippingVersionStatus; definition: ShippingTemplateDefinitionV1;
  sourceReference?: Record<string, unknown>; createdAt: string; updatedAt: string; publishedAt?: string;
};
export type ShippingTemplateSummary = {
  id: string; name: string; platformCode: string; scenarioCode: string; templateType: string; active: boolean;
  carrierCode: string; carrierName: string; carrierActive: boolean; createdAt: string; updatedAt: string;
  draftVersion?: { id: string; versionNo: number; updatedAt: string };
  publishedVersion?: { id: string; versionNo: number; publishedAt: string };
};
export type ShippingTemplateDetail = Omit<ShippingTemplateSummary, 'draftVersion' | 'publishedVersion'> & { versions: ShippingTemplateVersion[] };
export type ShippingQuote = {
  serviceCode: string; serviceName: string; channel: string; deliveryMode?: string; transitTime?: string; returnService?: string; notes?: string;
  productCategory?: string; matchedRuleId: string; actualWeightKg: string; volumetricWeightKg?: string; chargeableWeightKg: string;
  freightAmount: string; currency: string; isCheapest: boolean; breakdown: { ratePerKg: string; fixedFee: string; roundingStepKg?: string; formula: string };
};
export type ShippingCalculationResult = {
  template: { templateId: string; versionId: string; versionNo: number; platformCode: string; scenarioCode: string; templateType?: string; carrierCode: string; carrierName: string; templateName: string };
  normalizedInput: ShippingCalculationInput & { actualWeightKg: string; sideSumCm: string; volumeM3: string; densityKgM3: string; sortedDimensionsCm: string[] };
  summary: { eligibleCount: number; cheapestServiceCode?: string; cheapestFreightAmount?: string; currency: string };
  quotes: ShippingQuote[];
  rejections: Array<{ serviceCode: string; serviceName: string; reasonCodes: string[]; details: Record<string, string> }>;
  calculatedAt: string;
};
export type CommercePlatform = { code: string; displayName: string; active: boolean; createdAt: string; updatedAt: string };
export type CurrencyCatalogItem = { code: string; displayName: string; symbol: string; decimalPlaces: number; active: boolean; createdAt: string; updatedAt: string };
export type PricingTemplateVersion = { id: string; versionNo: number; status: ShippingVersionStatus; definition: PricingTemplateDefinitionV1; sourceReference?: Record<string, unknown>; createdAt: string; updatedAt: string; publishedAt?: string };
export type PricingTemplateSummary = { id: string; name: string; platformCode: string; platformName: string; active: boolean; createdAt: string; updatedAt: string; draftVersion?: { id: string; versionNo: number; updatedAt: string }; publishedVersion?: { id: string; versionNo: number; publishedAt: string } };
export type PricingTemplateDetail = Omit<PricingTemplateSummary, 'draftVersion' | 'publishedVersion'> & { versions: PricingTemplateVersion[] };
export type PricingOption = PricingOptionResult;
export type PricingCalculationResult = SharedPricingCalculationResult;
export type { PricingProductQueryInput, PricingProductQueryResult };
export type PricingBatchResult = { total: number; succeeded: number; failed: number; results: Array<{ index: number; sku: string | null; ok: boolean; result?: PricingCalculationResult; error?: { code: string; message: string } }>; calculatedAt: string };

export type WbCharacteristicScalar = string | number | boolean;
export type WbCharacteristic = { id: number; value: WbCharacteristicScalar | WbCharacteristicScalar[] };
export type WbVariant = {
  variantId: string;
  productVariantId?: string;
  productVariantName?: string;
  productVariantColor?: WbColorIdentity;
  variantCode: string;
  vendorCode: string;
  descriptionRu?: string;
  characteristics: WbCharacteristic[];
  sizes: Array<Record<string, unknown>>;
};
export type WbMediaAsset = {
  assetId: string;
  relativePath: string;
  kind: 'IMAGE' | 'VIDEO' | 'image' | 'video';
  sortOrder?: number;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
  validationStatus?: 'VALID' | 'INVALID';
  validationError?: string;
  productVariantId?: string;
  productVariantName?: string;
  productVariantColor?: WbColorIdentity;
  sourceStageId?: string;
  sourceSubmissionId?: string;
  deliveredAt?: string;
};
export type WbVariantMedia = { variantId: string; imageAssetIds: string[]; videoAssetId?: string };
export type WbListingStatus = 'DRAFT' | 'GENERATING' | 'GENERATED' | 'STALE' | 'SUBMITTING' | 'WAITING_NETWORK' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'NEEDS_ATTENTION' | 'BLOCKED' | 'FAILED';
export type WbSourceMediaState = 'AVAILABLE' | 'CLEANUP_PENDING' | 'CLEANED';
export type WbListingInitializationIssue = {
  code: string;
  message: string;
  field?: string;
  severity?: 'WARNING' | 'ERROR';
  retryable?: boolean;
};
export type WbListingPricingInitialization = {
  listingPriceCny?: number;
  targetSalePriceCny?: number;
  merchantDiscountPercent?: number;
  estimatedDiscountedPriceCny?: number;
  differenceCny?: number;
  currency?: string;
  pricingTemplateVersionNo?: number;
  shippingTemplateVersionNo?: number;
  shippingServiceCode?: string;
  [key: string]: unknown;
};
export type WbListingGrossWeightResolution = {
  source: 'PROCUREMENT' | 'PRESET_FALLBACK';
  effectiveGrossWeightGrams: number;
  procurementGrossWeightGrams: number | null;
  presetGrossWeightGrams: number;
  procurementVersionId: string;
  procurementVersionNo: number;
  procurementCapturedAt: string;
};
export type WbListingInitialization = {
  presetId: string;
  presetName: string;
  presetRowVersion: number;
  appliedAt: string;
  resolvedVersions?: Record<string, unknown>;
  pricing?: WbListingPricingInitialization;
  title?: Record<string, unknown>;
  description?: Record<string, unknown>;
  purchaseMeasurements?: WbPurchaseMeasurements;
  grossWeightResolution?: WbListingGrossWeightResolution;
  issues: WbListingInitializationIssue[];
};
export type WbDescriptionProvenance = {
  type: 'MANUAL_IMPORT' | 'USER_EDIT';
  fileName?: string;
  sha256?: string;
};
export type WbListing = {
  sku: string;
  productName: string;
  status: WbListingStatus;
  draftVersion: number;
  generatedVersionId?: string;
  revision?: number;
  categoryKey?: string;
  categoryNameRu?: string;
  categoryNameZh?: string;
  categoryVersionId?: string;
  brand: string;
  titleRu: string;
  descriptionRu: string;
  packaging: Record<string, unknown>;
  priceCny: number;
  discountPercent: number;
  clubDiscount?: number | null;
  videoUploadMode: 'ORIGINAL' | 'COMPRESSED_COPY';
  compliance: Record<string, unknown> & { tnved?: string; kizMarked?: boolean };
  sharedCharacteristics: WbCharacteristic[];
  variants: WbVariant[];
  mediaAssets: WbMediaAsset[];
  variantMedia: WbVariantMedia[];
  generatedAt?: string;
  submittedAt?: string;
  n8nTaskId?: string;
  nmId?: string;
  productUrl?: string;
  nmIds?: Array<string | number>;
  productUrls?: string[];
  mediaCount?: number;
  sourceMediaState?: WbSourceMediaState;
  sourceMediaCleanedAt?: string;
  updatedAt?: string;
  lastError?: string;
  networkRecovery?: WbNetworkRecovery;
  networkNextAttemptAt?: string;
  autoPublishLocked?: boolean;
  latestOperationSource?: 'MANUAL' | 'AUTOMATION';
  latestOperationAt?: string;
  latestOperationRef?: string;
  initialization?: WbListingInitialization;
  initializationIssues?: WbListingInitializationIssue[];
  descriptionProvenance?: WbDescriptionProvenance;
  purchaseMeasurements?: WbPurchaseMeasurements;
};
export type WbFormField = {
  fieldId: string;
  characteristicId: number;
  labelRu: string;
  labelZh?: string;
  required: boolean;
  scope: 'shared' | 'variant';
  control: 'text' | 'number' | 'select' | 'multi-select' | 'boolean';
  order: number;
  directory?: string;
};
export type WbCategoryFormConfig = {
  fields: WbFormField[];
  sizeMode?: 'sized' | 'sizeless';
  media?: {
    minImages: number;
    maxImages: number;
    videoAllowed: boolean;
    defaultVideoUploadMode?: 'ORIGINAL' | 'COMPRESSED_COPY';
  };
  compliance?: { tnvedCharacteristicId?: number; tnvedRequired?: boolean };
};
export type WbCategoryVersion = {
  id: string;
  versionNo: number;
  nameRu?: string;
  nameZh?: string;
  subjectId?: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  liveSchema: unknown;
  formConfig: WbCategoryFormConfig;
  managedCharacteristicIds: number[];
  schemaHash: string;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};
export type WbCategory = {
  categoryKey: string;
  nameRu: string;
  nameZh?: string;
  subjectId: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  draftVersion?: { id: string; versionNo: number; updatedAt: string };
  publishedVersion?: { id: string; versionNo: number; nameRu?: string; nameZh?: string; subjectId?: number; schemaHash: string; confirmedBy: string; confirmedAt: string; publishedAt: string };
  projection: { status: 'NOT_SYNCED' | 'PENDING' | 'SYNCED' | 'FAILED'; sourceVersionId?: string; definitionHash?: string; syncedAt?: string; lastError?: string };
  versions?: WbCategoryVersion[];
};
export type WbSubject = {
  subjectId: number;
  subjectName: string;
  subjectNameRu?: string;
  subjectNameZh?: string;
  parentId: number;
  parentName: string;
  parentNameRu?: string;
  parentNameZh?: string;
  active: boolean;
};
export type WbCatalogState = 'EMPTY' | 'SYNCING' | 'READY' | 'STALE' | 'FAILED';
export type WbCatalogErrorCode = 'BRIDGE_NOT_CONFIGURED' | 'WB_AUTH_FAILED' | 'WB_RATE_LIMITED' | 'WB_NETWORK_ERROR' | 'WB_SYNC_FAILED';
export type WbCatalogRun = {
  runId: string;
  trigger: 'MANUAL' | 'SCHEDULED' | 'STARTUP';
  status: 'RUNNING';
  startedAt: string;
  processedParents: number;
  totalParents: number;
  processedSubjects: number;
};
export type WbCatalogStatus = {
  status: WbCatalogState;
  subjectCount: number;
  parentCount: number;
  colorCount: number;
  dictionaryCounts: Record<'countries' | 'seasons' | 'kinds' | 'colors', number>;
  lastSuccessfulAt?: string;
  lastError?: string;
  lastErrorCode?: WbCatalogErrorCode;
  currentRun?: WbCatalogRun;
  nextScheduledAt: string;
};
export type WbCatalogSearchMeta = Pick<WbCatalogStatus, 'status' | 'subjectCount' | 'lastSuccessfulAt'> & { isStale: boolean };
export type WbCatalogSearchResult = { items: WbSubject[]; catalog: WbCatalogSearchMeta };
export type WbCatalogSyncResult = { runId: string; status: 'RUNNING'; accepted: boolean };
export type WbColor = { colorKey: string; nameRu: string; nameZh: string; parentNameRu: string; parentNameZh: string };
export type WbColorCatalogResult = { items: WbColor[]; catalog: WbCatalogStatus };
export type WbDictionaryName = 'countries' | 'seasons' | 'kinds' | 'colors';
export type WbDictionaryValue = {
  itemKey: string;
  wbId?: number;
  nameRu: string;
  nameZh: string;
  fullNameRu: string;
  fullNameZh: string;
  parentNameRu?: string;
  parentNameZh?: string;
};
export type WbDictionaryResult = { directory: WbDictionaryName; items: WbDictionaryValue[]; catalog: WbCatalogStatus };
export type WbListingTask = { taskId?: string; status?: string; nmId?: string; productUrl?: string; error?: string };
export type WbTnvedDirectoryEntry = { tnved: string; isKiz: boolean | number | string };
export type WbListingPresetReadiness = 'READY' | 'DRIFT' | 'BROKEN';
export type WbListingPresetSize = {
  sizeId: string;
  techSize?: string;
  wbSize?: string;
  insoleLengthCm?: number;
  stock: number;
};
export type WbListingPresetInput = {
  name: string;
  description?: string;
  autoPublishEnabled: boolean;
  autoPublishMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  pricingTemplateId: string;
  shippingTemplateId: string;
  shippingServiceCode: string;
  destinationCountryCode?: string;
  packaging: { grossWeightGrams: number; lengthCm: number; widthCm: number; heightCm: number };
  categoryKey: string;
  discountPercent: number;
  clubDiscount: number | null;
  tnved: string;
  brand: string;
  sharedCharacteristics: WbCharacteristic[];
  variantCharacteristics: WbCharacteristic[];
  titleTranslation: { workflowId: string; language: string; maxLength: number };
  descriptionSource: 'E003';
  sizes: WbListingPresetSize[];
};
export type WbListingPresetDependency = {
  id?: string;
  name?: string;
  versionId?: string;
  versionNo?: number;
  snapshotVersionId?: string;
  snapshotVersionNo?: number;
  status?: string;
};
export type WbListingPreset = WbListingPresetInput & {
  id: string;
  rowVersion: number;
  autoPublishActivatedAt?: string;
  activeBoundJobCount?: number;
  readiness: WbListingPresetReadiness;
  issues: WbListingInitializationIssue[];
  resolvedDependencies?: {
    pricing?: WbListingPresetDependency;
    shipping?: WbListingPresetDependency;
    category?: WbListingPresetDependency;
  };
  createdAt: string;
  updatedAt: string;
};
export type WbAutoPublishState =
  | 'WAITING_MEDIA'
  | 'WAITING_STABLE'
  | 'WAITING_NETWORK'
  | 'WAITING_GENERATION_TURN'
  | 'CHECKING'
  | 'INITIALIZING'
  | 'GENERATING'
  | 'SUBMITTING'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'NEEDS_ATTENTION'
  | 'PAUSED'
  | 'BLOCKED_EXISTING_CARD'
  | 'FAILED'
  | 'CANCELLED';
export type WbAutoPublishEvent = {
  id: string;
  eventType: string;
  fromState?: WbAutoPublishState;
  toState?: WbAutoPublishState;
  message?: string;
  details?: Record<string, unknown>;
  createdAt: string;
};
export type WbAutoPublishJob = {
  retry?: WbPublishRetryDetail;
  id: string;
  storeId: string;
  sku: string;
  runId: string;
  runNo: number;
  operationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  triggerType: 'MEDIA_DELIVERY' | 'MANUAL';
  baseRevision: number;
  targetRevision: number;
  mediaTargetVariantIds?: string[];
  mediaTargetVendorCodes?: string[];
  warnings?: Array<Record<string, unknown>>;
  variantSummary?: { created: number; updated: number; preserved: number };
  state: WbAutoPublishState;
  presetId?: string;
  presetName?: string;
  presetRowVersion?: number;
  presetBoundAt?: string;
  presetActivationStartedAt?: string;
  presetDefinitionHash?: string;
  sourcePresetExists?: boolean;
  presetBinding?: {
    schemaVersion?: number;
    presetId?: string;
    presetName?: string;
    presetRowVersion?: number;
    boundAt?: string;
    activationStartedAt?: string;
    definitionHash?: string;
  };
  mediaSignature?: string;
  expectedVendorCodes?: string[];
  attemptCount?: number;
  retryCounters?: Record<string, number>;
  nextAttemptAt?: string;
  networkRecovery?: WbNetworkRecovery;
  n8nTaskId?: string;
  nmIds?: Array<string | number>;
  productUrls?: string[];
  productLinks?: Array<{ nmId: string | number; url: string; variantCode?: string }>;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  createdAt: string;
  updatedAt: string;
  canRecheck?: boolean;
  canCancel?: boolean;
  hasListing?: boolean;
  events?: WbAutoPublishEvent[];
};
export type WbAutoPublishStatus = {
  enabled: boolean;
  acceptingNewJobs?: boolean;
  continuingBoundJobs?: number;
  activePreset?: { id: string; name: string; mode?: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT'; activatedAt?: string };
  counts: Record<string, number>;
  boundByPreset?: Record<string, number>;
  worker?: { running: boolean; lastReconciledAt?: string };
};

export class ApiError extends Error {
  public readonly userMessage: string;

  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
    this.userMessage = message;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(error?.code || 'HTTP_ERROR', error?.message || `HTTP ${response.status}`, response.status, error?.details);
  }
  return data as T;
}

export type MediaIndexEventPayload = { type?: string; stageId: string; state: MediaIndexState; summary?: StageSummary; affectedTaskIds?: string[]; at?: string };
type MediaIndexStateWire = Omit<MediaIndexState, 'revision'> & { revision?: unknown };
type StageViewWire = Omit<StageView, 'index'> & { index?: MediaIndexStateWire };
type MediaIndexEventPayloadWire = Omit<MediaIndexEventPayload, 'state'> & { state: MediaIndexStateWire };

function normalizeMediaIndexState(state: MediaIndexStateWire): MediaIndexState {
  const revision = typeof state.revision === 'string'
    ? state.revision
    : state.activeGeneration?.configRevision ?? '';
  return { ...state, revision };
}

function normalizeStageView(stage: StageViewWire): StageView {
  const { index, ...rest } = stage;
  return index ? { ...rest, index: normalizeMediaIndexState(index) } : rest;
}

export type MediaIndexEventHandlers = {
  onState: (payload: MediaIndexEventPayload) => void;
  onOpen?: () => void;
  onError?: () => void;
};

export type AboutSyncStatus = 'SYNCED' | 'LOCAL_ONLY' | 'REMOTE_ONLY' | 'DIVERGED' | 'UNAVAILABLE';
export type AboutRuntimeStatus = 'CURRENT' | 'REBUILD_REQUIRED' | 'UNKNOWN';
export type AboutHistoryStatus = 'IDENTICAL' | 'AHEAD' | 'BEHIND' | 'DIVERGED' | 'UNKNOWN';
export type AboutContentMatchStatus = 'MATCH' | 'DIFFERENT' | 'UNAVAILABLE';
export type AboutContentScope = 'runtime' | 'documentation' | 'verification';
export type AboutGithubAccessMode = 'AUTHENTICATED' | 'ANONYMOUS';
export type AboutGithubAccessSource = 'MANAGED' | 'ENVIRONMENT' | 'NONE';
export type AboutGithubAccessState = 'VERIFIED' | 'UNVERIFIED' | 'INVALID' | 'INSUFFICIENT_ACCESS' | 'RATE_LIMITED' | 'UNAVAILABLE';

export type AboutGithubAccessStatus = {
  mode: AboutGithubAccessMode;
  source: AboutGithubAccessSource;
  state: AboutGithubAccessState;
  anonymousFallback: boolean;
  canManage: boolean;
  rateLimit?: { limit: number; remaining: number; resetAt?: string };
  checkedAt?: string;
};

export type AboutVersionInfo = {
  repositoryUrl: string;
  scopeVersion: number;
  current: {
    productVersion: string;
    buildChannel?: 'candidate' | 'release';
    releaseTag?: string;
    configVersion: string;
    commitSha?: string;
    builtAt?: string;
    dirty?: boolean;
    runtimeEndpoint?: { host: '127.0.0.1'; port: number; origin: string };
  };
  available: {
    source: 'release' | 'main';
    label: string;
    commitSha: string;
    publishedAt?: string;
    url: string;
    compareUrl?: string;
  } | null;
  syncStatus: AboutSyncStatus;
  runtimeStatus: AboutRuntimeStatus;
  contentComparison: Record<AboutContentScope, {
    status: AboutContentMatchStatus;
    differenceCount?: number;
  }>;
  historyComparison: {
    status: AboutHistoryStatus;
    localOnlyCommits?: number;
    remoteOnlyCommits?: number;
  };
  checkedAt: string;
  error?: string;
};

export type ReviewOperationView = Omit<ReviewOperation, 'input' | 'requestHash' | 'requestKey'> & { progress?: ReviewOperationProgress };
const operationRequests = new Map<string, string>();
function stableOperationKey(identity: string): string {
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(localStorage.getItem('merchroute-review-request-keys') || '{}'); } catch { /* storage may be unavailable */ }
  const key = saved[identity] || operationRequests.get(identity) || crypto.randomUUID();
  operationRequests.set(identity, key);
  saved[identity] = key;
  try { localStorage.setItem('merchroute-review-request-keys', JSON.stringify(Object.fromEntries(Object.entries(saved).slice(-200)))); } catch { /* memory fallback */ }
  return key;
}
async function acceptReviewOperation(url: string, body: unknown, key = stableOperationKey(url + JSON.stringify(body))) {
  const result = await request<{ operation: ReviewOperationView }>(url, { method: 'POST', headers: { Prefer: 'respond-async', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  window.dispatchEvent(new Event('merchroute-review-operation-accepted'));
  return result;
}
export function connectReviewOperationEvents(onState: (operation: ReviewOperationView) => void, onOpen: () => void, onError: () => void): () => void {
  if (typeof EventSource === 'undefined') { onError(); return () => undefined; }
  const source = new EventSource('/api/v1/review-operations/events');
  source.addEventListener('review-operation', (event) => {
    try { onState(JSON.parse((event as MessageEvent<string>).data) as ReviewOperationView); }
    catch { onError(); }
  });
  source.addEventListener('open', onOpen);
  source.onerror = onError;
  return () => source.close();
}

export function connectMediaIndexEvents({ onState, onOpen, onError }: MediaIndexEventHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    onError?.();
    return () => undefined;
  }
  const source = new EventSource('/api/v1/media-index/events');
  const handleState = (event: Event) => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as MediaIndexEventPayloadWire;
      if (!payload || typeof payload.stageId !== 'string' || !payload.state || payload.state.stageId !== payload.stageId) return;
      onState({ ...payload, state: normalizeMediaIndexState(payload.state) });
    } catch {
      // Ignore malformed or non-contract SSE messages; the polling fallback remains active.
    }
  };
  source.addEventListener('media-index', handleState);
  source.addEventListener('open', () => onOpen?.());
  source.addEventListener('error', () => onError?.());
  return () => {
    source.removeEventListener('media-index', handleState);
    source.close();
  };
}

export const api = {
  health: () => request<{ status: string; version: string; appDataDir: string }>('/api/v1/health'),
  aboutVersion: (refresh = false) => request<AboutVersionInfo>(`/api/v1/about/version${refresh ? '?refresh=1' : ''}`),
  aboutGithubAccess: () => request<{ access: AboutGithubAccessStatus }>('/api/v1/about/github-access'),
  saveAboutGithubAccess: (token: string) => request<{ access: AboutGithubAccessStatus }>('/api/v1/about/github-access', { method: 'PUT', body: JSON.stringify({ token }) }),
  useAnonymousGithubAccess: () => request<{ access: AboutGithubAccessStatus }>('/api/v1/about/github-access', { method: 'DELETE' }),
  config: () => request<ConfigView>('/api/v1/config'),
  saveConfig: (config: AppConfig) => request<ConfigView>('/api/v1/config', { method: 'PUT', body: JSON.stringify(config) }),
  initializeWbPublishing: (input: WbPublishingConfig) => request<{ config: WbAppConfig; wbPublishingReadiness: WbPublishingReadiness }>('/api/v1/config/wb-publishing/initialize', { method: 'POST', body: JSON.stringify(input) }),
  syncWbPublishing: () => request<{ config: WbAppConfig; wbPublishingReadiness: WbPublishingReadiness }>('/api/v1/config/wb-publishing/sync', { method: 'POST' }),
  wbSettings: () => request<{ settings: WbSystemSettings }>('/api/v1/wb/settings'),
  updateWbSettings: (input: Pick<WbSystemSettings, 'enabled' | 'rootDirectory' | 'timezone' | 'globalConcurrency' | 'rowVersion'>) => request<{ settings: WbSystemSettings }>('/api/v1/wb/settings', { method: 'PATCH', body: JSON.stringify(input) }),
  wbStores: () => request<{ items: WbStore[]; total: number }>('/api/v1/wb/stores'),
  createWbStore: (input: WbStoreInput & { storeAlias: string }) => request<{ store: WbStore }>('/api/v1/wb/stores', { method: 'POST', body: JSON.stringify(input) }),
  updateWbStore: (storeId: string, input: WbStoreInput & { rowVersion: number }) => request<{ store: WbStore }>(`/api/v1/wb/stores/${encodeURIComponent(storeId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  updateWbStoreCredential: (storeId: string, token: string, rowVersion: number) => request<{ store: WbStore }>(`/api/v1/wb/stores/${encodeURIComponent(storeId)}/credential`, { method: 'PUT', body: JSON.stringify({ token, rowVersion }) }),
  preflightWbStore: (storeId: string) => request<{ store: WbStore; accepted: true }>(`/api/v1/wb/stores/${encodeURIComponent(storeId)}/preflight`, { method: 'POST' }),
  setWbStoreEnabled: (storeId: string, enabled: boolean, rowVersion: number) => request<{ store: WbStore }>(`/api/v1/wb/stores/${encodeURIComponent(storeId)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  archiveWbStore: (storeId: string, rowVersion: number) => request<{ store: WbStore }>(`/api/v1/wb/stores/${encodeURIComponent(storeId)}/archive`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  createWorkflow: (stage: AppConfig['stages'][number], copyFromStageId?: string) => request<{ config: AppConfig; workflow: AppConfig['stages'][number]; downloadSync: DownloadSyncState }>('/api/v1/workflows', { method: 'POST', body: JSON.stringify({ stage, copyFromStageId }) }),
  updateWorkflow: (stageId: string, stage: AppConfig['stages'][number]) => request<{ config: AppConfig; workflow: AppConfig['stages'][number]; downloadSync: DownloadSyncState }>(`/api/v1/workflows/${stageId}`, { method: 'PATCH', body: JSON.stringify(stage) }),
  deleteWorkflow: (stageId: string) => request<{ config: AppConfig; deletedStageId: string; downloadSync: DownloadSyncState }>(`/api/v1/workflows/${stageId}`, { method: 'DELETE' }),
  saveWorkflowGroups: (groups: AppConfig['workflowGroups'], assignments: Record<string, string>) => request<{ config: AppConfig }>('/api/v1/workflow-groups', { method: 'PUT', body: JSON.stringify({ groups, assignments }) }),
  workflowParameters: (stageId: string) => request<WorkflowParameterTemplateView>(`/api/v1/workflow-parameters/${stageId}`),
  saveWorkflowParameters: (stageId: string, parameters: WorkflowParameters, parameterOptions: WorkflowParameterOptions) => request<WorkflowParameterTemplateView>(`/api/v1/workflow-parameters/${stageId}`, { method: 'PUT', body: JSON.stringify({ parameters, parameterOptions }) }),
  validatePath: (path: string, localImportRole?: 'source' | 'candidate') => request<PathValidation>('/api/v1/config/validate', { method: 'POST', body: JSON.stringify({ path, localImportRole }) }),
  createDirectory: (path: string) => request<PathValidation>('/api/v1/config/create-directory', { method: 'POST', body: JSON.stringify({ path }) }),
  stages: async () => {
    const response = await request<{ stages: StageViewWire[] }>('/api/v1/stages');
    return { stages: response.stages.map(normalizeStageView) };
  },
  rescanStages: () => request<{ accepted: true; requestedAt: string }>('/api/v1/stages/rescan', { method: 'POST' }),
  connectMediaIndexEvents,
  tasks: (stageId: string, params: URLSearchParams) => request<{ items: ProductTask[]; total: number }>(`/api/v1/stages/${stageId}/tasks?${params}`),
  rescan: (stageId: string) => request(`/api/v1/stages/${stageId}/rescan`, { method: 'POST' }),
  task: (taskId: string) => request<TaskDetail>(`/api/v1/tasks/${taskId}`),
  openTaskFolder: (taskId: string) => request<{ accepted: true }>(`/api/v1/tasks/${encodeURIComponent(taskId)}/open-folder`, { method: 'POST', body: JSON.stringify({}) }),
  assignProductIdentity: (taskId: string, sku: string) => request<{ productIdentity: TaskDetail['productIdentity'] }>(`/api/v1/tasks/${taskId}/product-identity`, { method: 'PUT', body: JSON.stringify({ sku }) }),
  saveDraft: (taskId: string, selectedRelativePaths: string[], selectedTargets: string[], variantSelectionGroups?: VariantSelectionGroup[]) => request(`/api/v1/tasks/${taskId}/draft`, { method: 'PUT', body: JSON.stringify({ selectedRelativePaths, selectedTargets, variantSelectionGroups }) }),
  approve: (taskId: string, selectedRelativePaths: string[], targetStageIds: string[], variantSelectionGroups?: VariantSelectionGroup[], expectedVersion?: number) => acceptReviewOperation(`/api/v1/tasks/${taskId}/approve`, { selectedRelativePaths, targetStageIds, variantSelectionGroups, expectedVersion }),
  reopen: (taskId: string) => request(`/api/v1/tasks/${taskId}/reopen`, { method: 'POST' }),
  pending: (page = 1, pageSize = 20) => request<{ items: PendingView[]; total: number; page: number; pageSize: number }>(`/api/v1/pending-submissions?page=${page}&pageSize=${pageSize}`),
  updatePending: (id: string, patch: { conflictPolicy?: PendingSubmission['conflictPolicy']; n8nTaskParameters?: WorkflowParameters; n8nTaskParameterOptions?: WorkflowParameterOptions }) => request(`/api/v1/pending-submissions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePending: (id: string) => request(`/api/v1/pending-submissions/${id}`, { method: 'DELETE' }),
  submitBatch: (_batchId: string, ids: string[], conflictPolicy: PendingSubmission['conflictPolicy'], expectedVersions?: Record<string, number>) => {
    const key = stableOperationKey('batch:' + JSON.stringify({ ids, conflictPolicy, expectedVersions }));
    return acceptReviewOperation('/api/v1/submissions/batch', { batchId: 'BATCH-' + key, pendingSubmissionIds: ids, conflictPolicy, expectedVersions }, key);
  },
  batch: (batchId: string) => request<SubmissionBatchRecord>(`/api/v1/submissions/batches/${batchId}`),
  history: (filters: SubmissionHistoryQuery = {}, page = 1, pageSize = 20) => {
    const params = new URLSearchParams();
    if (filters.sku) params.set('sku', filters.sku);
    if (filters.completedFrom) params.set('completedFrom', filters.completedFrom);
    if (filters.completedTo) params.set('completedTo', filters.completedTo);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    const query = params.toString();
    return request<{ items: SubmissionRecord[]; total: number; page: number; pageSize: number }>(`/api/v1/submissions/history${query ? `?${query}` : ''}`);
  },
  retry: (submissionId: string) => acceptReviewOperation(`/api/v1/submissions/${submissionId}/retry`, {}),
  reviewOperations: () => request<{ items: ReviewOperationView[] }>('/api/v1/review-operations?active=true&includeRecent=1'),
  retryReviewOperation: (operationId: string) => acceptReviewOperation(`/api/v1/review-operations/${operationId}/retry`, {}, crypto.randomUUID()),
  thumbnailCache: () => request<{ count: number; bytes: number }>('/api/v1/settings/thumbnail-cache'),
  clearThumbnailCache: () => request<{ removed: number }>('/api/v1/settings/thumbnail-cache', { method: 'DELETE' }),
  staging: () => request<{ items: Array<{ path: string; modifiedAt: string; stale: boolean }> }>('/api/v1/settings/staging'),
  clearStaging: (path: string) => request('/api/v1/settings/staging', { method: 'DELETE', body: JSON.stringify({ path }) }),
  thumbnailUrl: (taskId: string, path: string) => `/api/v1/tasks/${taskId}/images/thumbnail?path=${encodeURIComponent(path)}`,
  originalUrl: (taskId: string, path: string) => `/api/v1/tasks/${taskId}/images/original?path=${encodeURIComponent(path)}`,
  localImportDirectories: (relativePath = '') => request<{ path: string; configHash: string; directories: LocalImportDirectory[] }>(`/api/v1/local-import/directories?path=${encodeURIComponent(relativePath)}`),
  previewLocalImport: (directories: string[], primaryDirectory: string) => request<LocalImportPreview>('/api/v1/local-import/preview', { method: 'POST', body: JSON.stringify({ directories, primaryDirectory }) }),
  localImports: (params: URLSearchParams) => request<{ items: LocalImportListItem[]; total: number; page: number; pageSize: number; facets: { platforms: Array<{ value: string; count: number }> } }>(`/api/v1/local-import/imports?${params}`),
  createLocalImport: (previewToken: string, idempotencyKey: string, fields: LocalImportPreview['fields']) => request<{ import: LocalImportRecord }>('/api/v1/local-import/imports', { method: 'POST', body: JSON.stringify({ previewToken, idempotencyKey, fields }) }),
  localImport: (id: string) => request<{ import: LocalImportRecord }>(`/api/v1/local-import/imports/${id}`),
  updateLocalImportPurchase: (id: string, input: Omit<PurchaseInput, 'downloadWorkflowCode'>) => request<{ import: LocalImportRecord }>(`/api/v1/local-import/imports/${id}/purchase`, { method: 'PATCH', body: JSON.stringify(input) }),
  retryLocalImport: (id: string) => request<{ import: LocalImportRecord }>(`/api/v1/local-import/imports/${id}/retry`, { method: 'POST' }),
  purchases: (params: URLSearchParams) => request<{ items: PurchaseSummary[]; total: number; page: number; pageSize: number; facets: { entryMethods: PurchaseEntryMethodFacet[] } }>(`/api/v1/purchases?${params}`),
  purchase: (sku: string) => request<{ purchase: PurchaseDetail }>(`/api/v1/purchases/${sku}`),
  createPurchase: (input: PurchaseInput) => request<{ purchase: PurchaseDetail }>('/api/v1/purchases', { method: 'POST', body: JSON.stringify(input) }),
  updatePurchase: (sku: string, input: PurchaseInput) => request<{ purchase: PurchaseDetail }>(`/api/v1/purchases/${sku}`, { method: 'PATCH', body: JSON.stringify(input) }),
  enqueuePurchaseDownload: (sku: string, workflowCode: string) => request<{ job: PurchaseDownloadJob }>(`/api/v1/purchases/${sku}/downloads`, { method: 'POST', body: JSON.stringify({ workflowCode }) }),
  purchaseDownloadJob: (id: string) => request<{ job: PurchaseDownloadJob }>(`/api/v1/purchase-download-jobs/${id}`),
  enqueuePurchaseDownloadBatch: (items: Array<{ sku: string; workflowCode: string }>) => request<{ batchId: string; queued: PurchaseDownloadJob[]; skipped: Array<{ sku: string; workflowCode: string; reason: string; message: string }> }>('/api/v1/purchase-download-jobs/batch', { method: 'POST', body: JSON.stringify({ items }) }),
  purchaseDownloadBatch: (id: string) => request<{ batch: PurchaseDownloadBatch }>(`/api/v1/purchase-download-batches/${id}`),
  notifications: (params: URLSearchParams) => request<{ items: TaskNotification[]; total: number; page: number; pageSize: number }>(`/api/v1/notifications?${params}`),
  notificationSummary: () => request<{ unreadCount: number; unresolvedErrorCount: number }>('/api/v1/notifications/summary'),
  updateNotification: (id: string, input: { read?: boolean; resolved?: boolean }) => request<{ notification: TaskNotification }>(`/api/v1/notifications/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  markAllNotificationsRead: () => request<{ updated: number }>('/api/v1/notifications/read-all', { method: 'POST' }),
  retryNotification: (id: string) => request<{ job: PurchaseDownloadJob }>(`/api/v1/notifications/${id}/retry`, { method: 'POST' }),
  wbListings: (params: URLSearchParams) => request<{ items: WbListing[]; total: number; page: number; pageSize: number }>(`/api/v1/wb/listings?${params}`),
  wbListing: (sku: string) => request<{ listing: WbListing }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}`),
  createWbListing: (sku: string) => request<{ listing: WbListing }>('/api/v1/wb/listings', { method: 'POST', body: JSON.stringify({ sku }) }),
  initializeMissingWbListing: (sku: string, draftVersion: number) => request<{ listing: WbListing }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/initialize-missing`, { method: 'POST', body: JSON.stringify({ draftVersion }) }),
  updateWbListing: (sku: string, input: Partial<Omit<WbListing, 'sku' | 'productName' | 'status' | 'revision' | 'mediaAssets' | 'autoPublishLocked' | 'latestOperationSource' | 'latestOperationAt' | 'latestOperationRef'>> & { draftVersion: number }) => request<{ listing: WbListing }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}`, { method: 'PUT', body: JSON.stringify(input) }),
  scanWbListingMedia: (sku: string) => request<{ listing: WbListing; mediaAssets: WbMediaAsset[]; productVariants: ProductVariant[] }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/media/scan`, { method: 'POST' }),
  generateWbListing: (sku: string, draftVersion: number) => request<{ listing: WbListing; productJson: Record<string, unknown>; productJsonPath: string }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/generate`, { method: 'POST', body: JSON.stringify({ draftVersion }) }),
  submitWbListing: (sku: string, draftVersion: number) => request<{ listing: WbListing; task: WbListingTask }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/submit`, { method: 'POST', body: JSON.stringify({ draftVersion }) }),
  planWbPublications: (sku: string, draftVersion: number, stores: WbPublicationSelection[]) => request<{ plan: WbPublicationPlan }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/publication-plans`, { method: 'POST', body: JSON.stringify({ draftVersion, stores }) }),
  createWbPublications: (sku: string, planHash: string, draftVersion: number, stores: WbPublicationSelection[]) => request<{ publications: WbStorePublication[]; accepted: number; failed: number; failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }> }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/publications`, { method: 'POST', body: JSON.stringify({ planHash, draftVersion, stores }) }),
  wbListingPublications: (sku: string, filters: { storeId?: string; status?: WbStorePublicationStatus } = {}) => {
    const params = new URLSearchParams();
    if (filters.storeId) params.set('storeId', filters.storeId);
    if (filters.status) params.set('status', filters.status);
    const query = params.toString();
    return request<{ items: WbStorePublication[] }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/publications${query ? `?${query}` : ''}`);
  },
  wbPublications: (filters: { sku?: string; skus?: string[]; storeId?: string; status?: WbStorePublicationStatus; source?: 'MANUAL' | 'AUTOMATION' } = {}) => {
    const params = new URLSearchParams();
    if (filters.sku) params.set('sku', filters.sku);
    if (filters.skus?.length) params.set('skus', filters.skus.join(','));
    if (filters.storeId) params.set('storeId', filters.storeId);
    if (filters.status) params.set('status', filters.status);
    if (filters.source) params.set('source', filters.source);
    const query = params.toString();
    return request<{ items: WbStorePublication[]; total?: number }>(`/api/v1/wb/publications${query ? `?${query}` : ''}`);
  },
  wbListingStatus: (sku: string) => request<{ listing: WbListing; productVariants: ProductVariant[]; task?: WbListingTask; pollError?: string }>(`/api/v1/wb/listings/${encodeURIComponent(sku)}/status`),
  wbMediaUrl: (sku: string, assetId: string) => `/api/v1/wb/listings/${encodeURIComponent(sku)}/media/${encodeURIComponent(assetId)}`,
  wbCategories: () => request<{ items: WbCategory[] }>('/api/v1/wb/categories'),
  wbCategory: (categoryKey: string) => request<{ category: WbCategory }>(`/api/v1/wb/categories/${encodeURIComponent(categoryKey)}`),
  createWbCategory: (input: { categoryKey: string; nameRu: string; nameZh?: string; subjectId: number; liveSchema?: unknown; formConfig?: WbCategoryFormConfig }) => request<{ category: WbCategory }>('/api/v1/wb/categories', { method: 'POST', body: JSON.stringify(input) }),
  saveWbCategoryDraft: (categoryKey: string, input: { nameRu?: string; nameZh?: string; subjectId?: number; liveSchema: unknown; formConfig: WbCategoryFormConfig; confirmedBy?: string }) => request<{ category: WbCategory }>(`/api/v1/wb/categories/${encodeURIComponent(categoryKey)}/draft`, { method: 'PUT', body: JSON.stringify(input) }),
  publishWbCategory: (categoryKey: string, confirmedBy: string) => request<{ category: WbCategory }>(`/api/v1/wb/categories/${encodeURIComponent(categoryKey)}/publish`, { method: 'POST', body: JSON.stringify({ confirmedBy }) }),
  syncWbCategory: (categoryKey: string) => request<{ category: WbCategory; projection: Record<string, unknown> }>(`/api/v1/wb/categories/${encodeURIComponent(categoryKey)}/sync`, { method: 'POST' }),
  deleteWbCategory: (categoryKey: string) => request<{ deletedCategoryKey: string; deletedCategory: { categoryKey: string; nameRu: string; nameZh?: string; subjectId: number }; projection: Record<string, unknown> }>(`/api/v1/wb/categories/${encodeURIComponent(categoryKey)}`, { method: 'DELETE' }),
  wbCatalogStatus: () => request<{ catalog: WbCatalogStatus }>('/api/v1/wb/catalog/status'),
  syncWbCatalog: () => request<WbCatalogSyncResult>('/api/v1/wb/catalog/sync', { method: 'POST' }),
  wbSubjects: (query: string, limit = 30) => request<WbCatalogSearchResult>(`/api/v1/wb/catalog/subjects?query=${encodeURIComponent(query)}&limit=${limit}`),
  wbColors: (query = '', limit = 1_000) => request<WbColorCatalogResult>(`/api/v1/wb/catalog/colors?query=${encodeURIComponent(query)}&limit=${limit}`),
  wbDictionary: (directory: WbDictionaryName, query = '', limit = 1_000) => request<WbDictionaryResult>(`/api/v1/wb/catalog/dictionaries/${directory}?query=${encodeURIComponent(query)}&limit=${limit}`),
  wbSubjectSchema: (subjectId: number, locale: 'ru' | 'zh' = 'ru') => request<unknown>(`/api/v1/wb/catalog/subjects/${subjectId}/schema?locale=${locale}`),
  wbTnvedDirectory: (subjectId: number, tnved: string) => request<WbTnvedDirectoryEntry[]>(`/api/v1/wb/catalog/directories/tnved?subjectId=${subjectId}&search=${encodeURIComponent(tnved)}&locale=ru`),
  wbPresets: () => request<{ items: WbListingPreset[] }>('/api/v1/wb/presets'),
  wbPreset: (id: string) => request<{ preset: WbListingPreset }>(`/api/v1/wb/presets/${encodeURIComponent(id)}`),
  createWbPreset: (input: WbListingPresetInput) => request<{ preset: WbListingPreset }>('/api/v1/wb/presets', { method: 'POST', body: JSON.stringify(input) }),
  updateWbPreset: (id: string, input: WbListingPresetInput & { rowVersion: number }) => request<{ preset: WbListingPreset }>(`/api/v1/wb/presets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteWbPreset: (id: string, rowVersion: number) => request<{ deleted: { id: string; name: string } }>(`/api/v1/wb/presets/${encodeURIComponent(id)}?rowVersion=${encodeURIComponent(String(rowVersion))}`, { method: 'DELETE' }),
  cloneWbPreset: (id: string, name?: string) => request<{ preset: WbListingPreset }>(`/api/v1/wb/presets/${encodeURIComponent(id)}/clone`, { method: 'POST', body: JSON.stringify(name ? { name } : {}) }),
  wbAutoPublishStatus: () => request<WbAutoPublishStatus>('/api/v1/wb/automation/status'),
  wbAutoPublishJobs: (params = new URLSearchParams()) => request<{ items: WbAutoPublishJob[]; total: number }>(`/api/v1/wb/automation/jobs${params.size ? `?${params}` : ''}`),
  wbAutoPublishJob: async (sku: string, storeId: string) => {
    const query = `?storeId=${encodeURIComponent(storeId)}`;
    const result = await request<WbAutoPublishJob | { job: WbAutoPublishJob }>(`/api/v1/wb/automation/jobs/${encodeURIComponent(sku)}${query}`);
    return 'job' in result ? result.job : result;
  },
  retryWbAutoPublishJob: (sku: string, input: WbPublishRetryRequest) =>
    request<{ job: WbAutoPublishJob; retry: WbPublishRetryRecord; outcome: 'ACCEPTED' | 'EXISTING' }>(
      `/api/v1/wb/automation/jobs/${encodeURIComponent(sku)}/retry`, { method: 'POST', body: JSON.stringify(input) }),
  recheckWbAutoPublishJob: async (sku: string, storeId: string) => {
    const result = await request<WbAutoPublishJob | { job: WbAutoPublishJob }>(`/api/v1/wb/automation/jobs/${encodeURIComponent(sku)}/recheck`, { method: 'POST', body: JSON.stringify({ storeId }) });
    return 'job' in result ? result.job : result;
  },
  cancelWbAutoPublishJob: async (sku: string, storeId: string) => {
    const result = await request<WbAutoPublishJob | { job: WbAutoPublishJob }>(`/api/v1/wb/automation/jobs/${encodeURIComponent(sku)}/cancel`, { method: 'POST', body: JSON.stringify({ storeId }) });
    return 'job' in result ? result.job : result;
  },
  wbAutoPublishRuns: (sku: string, storeId: string) => request<{ items: WbAutoPublishJob[] }>(`/api/v1/wb/automation/jobs/${encodeURIComponent(sku)}/runs?storeId=${encodeURIComponent(storeId)}`),
  startCompatibleWbAutoPublishJob: async (sku: string, storeId: string) => {
    const result = await request<WbAutoPublishJob | { job: WbAutoPublishJob }>(`/api/v1/wb/automation/jobs/${encodeURIComponent(sku)}/start-compatible`, { method: 'POST', body: JSON.stringify({ storeId }) });
    return 'job' in result ? result.job : result;
  },
  ozonSettings: () => request<{ settings: OzonStoreSettings }>('/api/v1/ozon/settings'),
  updateOzonSettings: (input: Pick<OzonStoreSettings, 'rowVersion'> & Partial<Pick<OzonStoreSettings, 'enabled' | 'rootDirectory' | 'timezone' | 'globalConcurrency' | 'taskApiWebhookUrl' | 'adminApiWebhookUrl' | 'preflightWebhookUrl' | 'imageUploaderWorkflowId' | 'storeGatewayWorkflowId' | 'imageUploadConcurrency' | 'videoUploadConcurrency' | 'videoPrewarmEnabled'>>) => request<{ settings: OzonStoreSettings }>('/api/v1/ozon/settings', { method: 'PATCH', body: JSON.stringify(input) }),
  ozonStores: (includeArchived = true) => request<{ items: OzonStore[]; total: number }>(`/api/v1/ozon/stores?includeArchived=${includeArchived}`),
  ozonStore: (storeId: string) => request<{ store: OzonStore }>(`/api/v1/ozon/stores/${encodeURIComponent(storeId)}`),
  createOzonStore: (input: OzonStoreCreate) => request<{ store: OzonStore }>('/api/v1/ozon/stores', { method: 'POST', body: JSON.stringify(input) }),
  updateOzonStore: (storeId: string, input: OzonStoreUpdate) => request<{ store: OzonStore }>(`/api/v1/ozon/stores/${encodeURIComponent(storeId)}`, { method: 'PUT', body: JSON.stringify(input) }),
  updateOzonStoreCredentials: (storeId: string, clientId: string, apiKey: string, rowVersion: number) => request<{ store: OzonStore }>(`/api/v1/ozon/stores/${encodeURIComponent(storeId)}/credentials`, { method: 'POST', body: JSON.stringify({ clientId, apiKey, rowVersion }) }),
  preflightOzonStore: (storeId: string, rowVersion: number) => request<{ store: OzonStore; accepted?: true }>(`/api/v1/ozon/stores/${encodeURIComponent(storeId)}/preflight`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  setOzonStoreEnabled: (storeId: string, enabled: boolean, rowVersion: number) => request<{ store: OzonStore }>(`/api/v1/ozon/stores/${encodeURIComponent(storeId)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  archiveOzonStore: (storeId: string, rowVersion: number) => request<{ store: OzonStore }>(`/api/v1/ozon/stores/${encodeURIComponent(storeId)}/archive`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  planOzonPublications: (sku: string, draftVersion: number, storeIds: string[]) => request<{ plan: OzonPublicationPlan }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/publication-plans`, { method: 'POST', body: JSON.stringify({ draftVersion, storeIds }) }),
  createOzonPublications: (sku: string, draftVersion: number, storeIds: string[], planHash: string, requestId: string) => request<OzonPublicationCreateResult>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/publications`, { method: 'POST', body: JSON.stringify({ draftVersion, storeIds, planHash, requestId }) }),
  ozonPublications: (filters: { sku?: string; skus?: string[]; storeId?: string; status?: OzonPublicationStatus; source?: OzonPublication['source'] } = {}) => {
    const params = new URLSearchParams();
    if (filters.sku) params.set('sku', filters.sku);
    if (filters.skus?.length) params.set('skus', filters.skus.join(','));
    if (filters.storeId) params.set('storeId', filters.storeId);
    if (filters.status) params.set('status', filters.status);
    if (filters.source) params.set('source', filters.source);
    const query = params.toString();
    return request<{ items: OzonPublication[]; total?: number }>(`/api/v1/ozon/publications${query ? `?${query}` : ''}`);
  },
  ozonPublicationTaskSummaries: (skus: string[]) => {
    const params = new URLSearchParams({
      skus: [...new Set(skus)].join(','),
      source: 'MANUAL',
      latestBatchOnly: 'true'
    });
    return request<{ items: OzonPublicationTaskSummary[]; total: number }>(`/api/v1/ozon/publication-task-summaries?${params}`);
  },
  ozonPublication: (publicationId: string) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}`),
  ozonPublicationTaskDetail: (publicationId: string) => request<OzonPublicationTaskDetail>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/task-detail`),
  syncOzonPublication: (publicationId: string, rowVersion: number) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/sync`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  cancelOzonPublication: (publicationId: string, rowVersion: number) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/cancel`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  recheckOzonPublication: (publicationId: string, input: OzonPublicationRecheckInput) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/recheck`, { method: 'POST', body: JSON.stringify(input) }),
  refreshOzonPublicationPlatformStatus: (publicationId: string, rowVersion: number, requestId: string) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/platform-status/refresh`, { method: 'POST', body: JSON.stringify({ rowVersion, requestId }) }),
  stopOzonPublicationAutomation: (publicationId: string, rowVersion: number, requestId: string) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/stop-automation`, { method: 'POST', body: JSON.stringify({ rowVersion, requestId }) }),
  ozonPublicationCompatibleAppendPlan: (publicationId: string) => request<{ plan: OzonPublicationCompatibleAppendPlan }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/compatible-append-plan`),
  compatibleAppendOzonPublication: (publicationId: string, rowVersion: number, planHash: string) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/compatible-append`, { method: 'POST', body: JSON.stringify({ rowVersion, planHash }) }),
  republishOzonPublication: (publicationId: string, rowVersion: number) => request<{ publication: OzonPublication }>(`/api/v1/ozon/publications/${encodeURIComponent(publicationId)}/republish`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  ozonSystem: () => request<OzonReadiness>('/api/v1/ozon/system'),
  probeOzonVideoUpload: (sourceFilePath: string) => request<{ ready: boolean; message: string; contentType?: string; publicStatus?: number }>('/api/v1/ozon/system/video-upload-probe', { method: 'POST', body: JSON.stringify({ sourceFilePath }) }),
  ozonListings: (params = new URLSearchParams()) => request<{ items: OzonListingDraft[]; total: number; page: number; pageSize: number }>(`/api/v1/ozon/listings${params.size ? `?${params}` : ''}`),
  ozonListing: (sku: string) => request<OzonListingDetail>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}`),
  createOzonListing: (sku: string) => request<OzonMaterialPersistenceResult>('/api/v1/ozon/listings', { method: 'POST', body: JSON.stringify({ sku }) }),
  takeOverOzonAutomaticPreparation: (sku: string, jobId: string, input: { jobRowVersion: number; listingRowVersion: number }) => request<{ job: OzonPublishJob; listing: OzonListingDraft }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/preparations/${encodeURIComponent(jobId)}/manual-takeover`, { method: 'POST', body: JSON.stringify(input) }),
  initializeOzonListingMissing: (sku: string, rowVersion: number) => request<{ listing: OzonListingDraft }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/initialize-missing`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  updateOzonListing: (sku: string, input: OzonListingDraftInput) => request<OzonMaterialPersistenceResult>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}`, { method: 'PUT', body: JSON.stringify(input) }),
  updateOzonSharedMaterial: (sku: string, input: OzonSharedMaterialDraftInput) => request<OzonMaterialPersistenceResult>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/shared-material`, { method: 'PUT', body: JSON.stringify(input) }),
  scanOzonListingMedia: (sku: string, rowVersion: number) => request<{ changed: boolean; listing: OzonListingDraft; mediaAssets: OzonMediaAsset[]; mediaDirectory: string; removedReferences: number }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/media/scan`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  ozonMediaUrl: (sku: string, assetId: string) => `/api/v1/ozon/listings/${encodeURIComponent(sku)}/media/${encodeURIComponent(assetId)}`,
  ozonCategories: () => request<{ items: OzonCategoryTemplate[] }>('/api/v1/ozon/categories'),
  ozonCategory: (categoryKey: string) => request<{ category: OzonCategoryTemplate }>(`/api/v1/ozon/categories/${encodeURIComponent(categoryKey)}`),
  createOzonCategory: (catalogEntryId: string) => request<{ category: OzonCategoryTemplate }>('/api/v1/ozon/categories', { method: 'POST', body: JSON.stringify({ catalogEntryId }) }),
  refreshOzonCategory: (categoryKey: string) => request<{ category: OzonCategoryTemplate }>(`/api/v1/ozon/categories/${encodeURIComponent(categoryKey)}/refresh`, { method: 'POST' }),
  saveOzonCategoryAttributeOrder: (categoryKey: string, input: OzonCategoryAttributeOrderInput) => request<{ category: OzonCategoryTemplate }>(`/api/v1/ozon/categories/${encodeURIComponent(categoryKey)}/attributes-order`, { method: 'PUT', body: JSON.stringify(input) }),
  publishOzonCategory: (categoryKey: string, confirmedBy: string) => request<{ category: OzonCategoryTemplate }>(`/api/v1/ozon/categories/${encodeURIComponent(categoryKey)}/publish`, { method: 'POST', body: JSON.stringify({ confirmedBy }) }),
  deleteOzonCategory: (categoryKey: string) => request<{ deleted: { categoryKey: string; nameRu: string } }>(`/api/v1/ozon/categories/${encodeURIComponent(categoryKey)}`, { method: 'DELETE' }),
  ozonCatalogStatus: () => request<{ catalog: OzonCatalogStatus }>('/api/v1/ozon/catalog/status'),
  syncOzonCatalog: () => request<{ runId: string; status: 'RUNNING'; accepted: boolean }>('/api/v1/ozon/catalog/sync', { method: 'POST' }),
  ozonCatalogCategories: (query: string, limit = 30) => request<{ items: OzonCatalogEntry[]; catalog: OzonCatalogStatus }>(`/api/v1/ozon/catalog/categories?query=${encodeURIComponent(query)}&limit=${limit}`),
  ozonCatalogDictionary: (directory: OzonCatalogDictionaryName, dictionaryId?: number, query = '', limit = 1_000) => {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (dictionaryId) params.set('dictionaryId', String(dictionaryId));
    return request<OzonCatalogDictionaryResult>(`/api/v1/ozon/catalog/dictionaries/${directory}?${params}`);
  },
  ozonPresets: () => request<{ items: OzonPreset[] }>('/api/v1/ozon/presets'),
  ozonPreset: (id: string) => request<{ preset: OzonPreset }>(`/api/v1/ozon/presets/${encodeURIComponent(id)}`),
  createOzonPreset: (input: OzonPresetInput) => request<{ preset: OzonPreset }>('/api/v1/ozon/presets', { method: 'POST', body: JSON.stringify(input) }),
  updateOzonPreset: (id: string, input: OzonPresetInput & { rowVersion: number }) => request<{ preset: OzonPreset }>(`/api/v1/ozon/presets/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  cloneOzonPreset: (id: string, name?: string) => request<{ preset: OzonPreset }>(`/api/v1/ozon/presets/${encodeURIComponent(id)}/clone`, { method: 'POST', body: JSON.stringify(name ? { name } : {}) }),
  deleteOzonPreset: (id: string, rowVersion: number) => request<{ deleted: { id: string; name: string } }>(`/api/v1/ozon/presets/${encodeURIComponent(id)}?rowVersion=${rowVersion}`, { method: 'DELETE' }),
  ozonAutomationStatus: () => request<OzonAutomationStatus>('/api/v1/ozon/automation/status'),
  ozonPublishRetryPlan: (id: string, storeId: string) => request<{ plan: OzonPublishRetryPlan }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/retry-plan?storeId=${encodeURIComponent(storeId)}`),
  retryOzonPublish: (id: string, input: OzonPublishRetryRequest) => request<{ retry: OzonPublishRetryRecord; idempotent: boolean }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(input) }),
  ozonJobs: (params = new URLSearchParams()) => request<{ items: OzonPublishJob[]; total: number; page: number; pageSize: number }>(`/api/v1/ozon/automation/jobs${params.size ? `?${params}` : ''}`),
  ozonJob: (id: string, storeId: string) => request<{ job: OzonPublishJob; sourceMediaCleanup?: OzonSourceMediaCleanupSummary }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}?storeId=${encodeURIComponent(storeId)}`),
  ozonPreparationTaskDetail: (id: string) => request<OzonPreparationTaskDetailResponse>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/task-detail`),
  ozonPreparationMaterialSnapshot: (id: string) => request<OzonPreparationMaterialSnapshot>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/material-snapshot`),
  ozonPreparationRecheckPlan: (id: string, rowVersion: number) => request<{ plan: OzonPreparationRecheckPlan }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/recheck-plan?rowVersion=${encodeURIComponent(String(rowVersion))}`),
  recheckOzonPreparation: (id: string, input: OzonPreparationRecheckInput) => request<OzonPreparationRecheckResult>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: JSON.stringify(input) }),
  ozonPreparationManualSuccessReconcilePlan: (id: string, rowVersion: number) => request<{ plan: OzonPreparationManualSuccessReconcilePlan }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/manual-success-reconcile-plan?rowVersion=${encodeURIComponent(String(rowVersion))}`),
  reconcileOzonPreparationToManualSuccess: (id: string, input: OzonPreparationManualSuccessReconcileInput) => request<OzonPreparationManualSuccessReconcileResult>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/manual-success-reconcile`, { method: 'POST', body: JSON.stringify(input) }),
  ozonAutomaticListingSnapshot: (id: string, storeId: string) => request<{ snapshot: OzonAutomaticListingSnapshot }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/listing-snapshot?storeId=${encodeURIComponent(storeId)}`),
  recheckOzonJob: (id: string, storeId: string) => request<{ job: OzonPublishJob }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: JSON.stringify({ storeId }) }),
  cancelOzonJob: (id: string, storeId: string) => request<{ job: OzonPublishJob }>(`/api/v1/ozon/automation/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ storeId }) }),
  ozonManualJobs: (sku: string, params = new URLSearchParams()) => request<{ items: OzonPublishJob[]; total: number; page: number; pageSize: number }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/jobs${params.size ? `?${params}` : ''}`),
  ozonManualJob: (sku: string, id: string) => request<OzonManualJobDetail>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/jobs/${encodeURIComponent(id)}`),
  recheckOzonManualJob: (sku: string, id: string, rowVersion: number) => request<{ job: OzonPublishJob }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/jobs/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: JSON.stringify({ rowVersion }) }),
  returnOzonManualJobToEdit: (sku: string, id: string, input: { jobRowVersion: number; listingRowVersion: number }) => request<{ job: OzonPublishJob; listing: OzonListingDraft; recovery: { mode: 'HARDLINK' | 'COPY' | 'MIXED'; assetCount: number } }>(`/api/v1/ozon/listings/${encodeURIComponent(sku)}/jobs/${encodeURIComponent(id)}/return-to-edit`, { method: 'POST', body: JSON.stringify(input) }),
  ozonMapping: (storeAlias: string, offerId: string) => request<{ mapping: OzonProductMapping }>(`/api/v1/ozon/mappings/${encodeURIComponent(storeAlias)}/${encodeURIComponent(offerId)}`),
  downloadWorkflows: (includeDisabled = true) => request<{ items: DownloadWorkflow[] }>(`/api/v1/download-workflows?includeDisabled=${includeDisabled}`),
  shippingCarriers: (includeInactive = true) => request<{ items: ShippingCarrier[] }>(`/api/v1/shipping/carriers?includeInactive=${includeInactive}`),
  createShippingCarrier: (input: { code: string; displayName: string; active?: boolean }) => request<{ carrier: ShippingCarrier }>('/api/v1/shipping/carriers', { method: 'POST', body: JSON.stringify(input) }),
  updateShippingCarrier: (code: string, input: { displayName?: string; active?: boolean }) => request<{ carrier: ShippingCarrier }>(`/api/v1/shipping/carriers/${code}`, { method: 'PATCH', body: JSON.stringify(input) }),
  shippingTemplates: () => request<{ items: ShippingTemplateSummary[] }>('/api/v1/shipping/templates'),
  shippingTemplate: (id: string) => request<{ template: ShippingTemplateDetail }>(`/api/v1/shipping/templates/${id}`),
  createShippingTemplate: (input: { carrierCode: string; platformCode: string; scenarioCode?: string; templateType?: string; name: string }) => request<{ template: ShippingTemplateDetail }>('/api/v1/shipping/templates', { method: 'POST', body: JSON.stringify(input) }),
  updateShippingTemplate: (id: string, input: { name?: string; active?: boolean }) => request<{ template: ShippingTemplateDetail }>(`/api/v1/shipping/templates/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  saveShippingDraft: (id: string, definition: ShippingTemplateDefinitionV1) => request<{ template: ShippingTemplateDetail }>(`/api/v1/shipping/templates/${id}/draft`, { method: 'PATCH', body: JSON.stringify({ definition }) }),
  cloneShippingTemplate: (id: string, input: { carrierCode: string; name: string }) => request<{ template: ShippingTemplateDetail }>(`/api/v1/shipping/templates/${id}/clone`, { method: 'POST', body: JSON.stringify(input) }),
  publishShippingTemplate: (id: string) => request<{ template: ShippingTemplateDetail }>(`/api/v1/shipping/templates/${id}/publish`, { method: 'POST' }),
  calculateShipping: (input: ShippingCalculationInput) => request<ShippingCalculationResult>('/api/v1/shipping/calculate', { method: 'POST', body: JSON.stringify(input) }),
  platforms: (includeInactive = true) => request<{ items: CommercePlatform[] }>(`/api/v1/catalog/platforms?includeInactive=${includeInactive}`),
  createPlatform: (input: { code: string; displayName: string; active?: boolean }) => request<{ platform: CommercePlatform }>('/api/v1/catalog/platforms', { method: 'POST', body: JSON.stringify(input) }),
  updatePlatform: (code: string, input: { displayName?: string; active?: boolean }) => request<{ platform: CommercePlatform }>(`/api/v1/catalog/platforms/${code}`, { method: 'PATCH', body: JSON.stringify(input) }),
  currencies: (includeInactive = true) => request<{ items: CurrencyCatalogItem[] }>(`/api/v1/catalog/currencies?includeInactive=${includeInactive}`),
  createCurrency: (input: { code: string; displayName: string; symbol: string; decimalPlaces: number; active?: boolean }) => request<{ currency: CurrencyCatalogItem }>('/api/v1/catalog/currencies', { method: 'POST', body: JSON.stringify(input) }),
  updateCurrency: (code: string, input: { displayName?: string; symbol?: string; decimalPlaces?: number; active?: boolean }) => request<{ currency: CurrencyCatalogItem }>(`/api/v1/catalog/currencies/${code}`, { method: 'PATCH', body: JSON.stringify(input) }),
  pricingTemplates: () => request<{ items: PricingTemplateSummary[] }>('/api/v1/pricing/templates'),
  pricingTemplate: (id: string) => request<{ template: PricingTemplateDetail }>(`/api/v1/pricing/templates/${id}`),
  createPricingTemplate: (input: { name: string; platformCode: string; definition: PricingTemplateDefinitionV1 }) => request<{ template: PricingTemplateDetail }>('/api/v1/pricing/templates', { method: 'POST', body: JSON.stringify(input) }),
  updatePricingTemplate: (id: string, input: { name?: string; active?: boolean }) => request<{ template: PricingTemplateDetail }>(`/api/v1/pricing/templates/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  savePricingDraft: (id: string, definition: PricingTemplateDefinitionV1) => request<{ template: PricingTemplateDetail }>(`/api/v1/pricing/templates/${id}/draft`, { method: 'PATCH', body: JSON.stringify({ definition }) }),
  publishPricingTemplate: (id: string) => request<{ template: PricingTemplateDetail }>(`/api/v1/pricing/templates/${id}/publish`, { method: 'POST' }),
  clonePricingTemplate: (id: string, input: { platformCode: string; name: string }) => request<{ template: PricingTemplateDetail }>(`/api/v1/pricing/templates/${id}/clone`, { method: 'POST', body: JSON.stringify(input) }),
  calculatePricing: (input: PricingCalculationInput) => request<PricingCalculationResult>('/api/v1/pricing/calculate', { method: 'POST', body: JSON.stringify(input) }),
  queryProductPricing: (input: PricingProductQueryInput) => request<PricingProductQueryResult>('/api/v1/pricing/query', { method: 'POST', body: JSON.stringify(input) }),
  calculatePricingBatch: (input: { pricingTemplateId: string; shippingTemplateIds: string[]; items: unknown[] }) => request<PricingBatchResult>('/api/v1/pricing/calculate-batch', { method: 'POST', body: JSON.stringify(input) })
};

export type PathValidation = { path: string; exists: boolean; readable: boolean; writable: boolean; freeBytes?: number; checkedAt: string; error?: string };
