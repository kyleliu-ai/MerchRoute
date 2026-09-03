import { z } from 'zod';
import { wbPublishingConfigSchema } from './wb.js';

export * from './countries.js';
export * from './wb.js';
export * from './wb-multistore.js';
export * from './ozon.js';
export * from './ozon-multistore.js';
export * from './ozon-content-policy.js';

export const APP_VERSION = 'v003' as const;
export const PREVIOUS_APP_VERSION = 'v002' as const;
export const LEGACY_APP_VERSION = 'v001' as const;
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp'] as const;
export const VIDEO_EXTENSIONS = ['.mp4', '.mov'] as const;
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS] as const;
export const ROOT_METADATA_EXTENSIONS = ['.json', '.txt', '.md', '.csv'] as const;
export const E001_VARIANT_MAX_IMAGE_COUNT = 5;
export const LOCAL_IMPORT_PRODUCT_NAME_MAX_LENGTH = 20;
export const LOCAL_IMPORT_PRODUCT_NAME_ALLOWED_PUNCTUATION = '，。！？、；：“”‘’（）《》【】—…·';
export const DEPRECATED_OUTPUT_ROOT_STAGE_IDS: readonly string[] = ['E001', 'E002', 'E003', 'E006', 'E007'];
export const ERROR_CODES = [
  'CONFIG_INVALID', 'STAGE_DISABLED', 'PATH_NOT_FOUND', 'PATH_NOT_READABLE', 'PATH_NOT_WRITABLE',
  'DOWNLOAD_ROOT_UNSAFE', 'DOWNLOAD_CONFIG_OUT_OF_SYNC',
  'PRODUCT_URL_ALREADY_EXISTS', 'PRODUCT_URL_UNSUPPORTED', 'DOWNLOAD_WORKFLOW_URL_MISMATCH',
  'SOURCE_FOLDER_MISSING', 'SOURCE_FILE_MISSING', 'SOURCE_FILE_CHANGED', 'SOURCE_FILE_EMPTY', 'UNSUPPORTED_FILE_TYPE',
  'UNSUPPORTED_PLATFORM', 'DIRECTORY_OPEN_FAILED',
  'TARGET_FOLDER_EXISTS', 'TARGET_QUEUE_UNAVAILABLE', 'ARCHIVE_ROOT_UNAVAILABLE', 'STAGING_CREATE_FAILED',
  'COPY_FAILED', 'MANIFEST_WRITE_FAILED', 'READY_WRITE_FAILED', 'VERIFY_FAILED', 'ATOMIC_RENAME_FAILED',
  'PARTIAL_SUBMISSION', 'DATABASE_WRITE_FAILED', 'TASK_LOCKED', 'INVALID_RELATIVE_PATH', 'PATH_TRAVERSAL_BLOCKED'
] as const;

export type PurchaseProductUrlClassification =
  | { platform: 'PDD'; workflowCode: 'E006'; productId: string }
  | { platform: '1688'; workflowCode: 'E007'; productId: string };

export type LocalImportProductNameValidation =
  | { valid: true; value: string; length: number }
  | { valid: false; value: string; length: number; issue: 'REQUIRED' | 'TOO_LONG' | 'INVALID_CHARACTERS'; message: string };

const localImportProductNamePunctuation = new Set(Array.from(LOCAL_IMPORT_PRODUCT_NAME_ALLOWED_PUNCTUATION));

export function validateLocalImportProductName(input: unknown): LocalImportProductNameValidation {
  const value = String(input ?? '').trim().normalize('NFC');
  const characters = Array.from(value);
  const length = characters.length;
  if (length === 0) return { valid: false, value, length, issue: 'REQUIRED', message: '请输入产品名称' };
  if (length > LOCAL_IMPORT_PRODUCT_NAME_MAX_LENGTH) {
    return {
      valid: false,
      value,
      length,
      issue: 'TOO_LONG',
      message: `产品名称最多 ${LOCAL_IMPORT_PRODUCT_NAME_MAX_LENGTH} 个字符，当前 ${length} 个`
    };
  }
  const charactersValid = characters.every((character) => (
    /^\p{Script=Han}$/u.test(character)
    || /^[0-9]$/.test(character)
    || localImportProductNamePunctuation.has(character)
  ));
  if (!charactersValid) {
    return {
      valid: false,
      value,
      length,
      issue: 'INVALID_CHARACTERS',
      message: '产品名称仅允许汉字、数字 0-9 及中文常用标点'
    };
  }
  return { valid: true, value, length };
}

const isHostOrSubdomain = (hostname: string, rootDomain: string): boolean =>
  hostname === rootDomain || hostname.endsWith(`.${rootDomain}`);

const firstNumericSearchParameter = (
  searchParams: URLSearchParams,
  names: readonly string[],
  pattern: RegExp
): string | null => {
  for (const name of names) {
    const parameter = searchParams.get(name);
    if (parameter !== null && pattern.test(parameter)) return parameter;
  }
  return null;
};

export function classifyPurchaseProductUrl(value: string): PurchaseProductUrlClassification | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;

  const hostname = parsed.hostname.toLowerCase();
  if (isHostOrSubdomain(hostname, 'yangkeduo.com')) {
    const productId = firstNumericSearchParameter(parsed.searchParams, ['goods_id', 'goodsId'], /^\d+$/);
    return productId === null ? null : { platform: 'PDD', workflowCode: 'E006', productId };
  }

  if (isHostOrSubdomain(hostname, '1688.com')) {
    const pathProductId = parsed.pathname.match(/^\/offer\/(\d+)\.html$/)?.[1] ?? null;
    const productId = pathProductId
      ?? firstNumericSearchParameter(parsed.searchParams, ['offerId', 'offer_id', 'id'], /^\d+$/);
    return productId === null ? null : { platform: '1688', workflowCode: 'E007', productId };
  }

  return null;
}

export const targetConfigSchema = z.object({
  targetStageId: z.string().min(1),
  targetQueueRoot: z.string().min(1),
  folderNameTemplate: z.string().min(1).default('{sourceName}-已经审核'),
  packageMode: z.enum(['preserve-relative', 'flatten']).default('preserve-relative'),
  copyRootMetadata: z.boolean().default(true)
});

export const workflowGroupSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/i, '分组 ID 只能包含字母、数字、下划线和连字符'),
  name: z.string().trim().min(1).max(40)
});

export const downloadWorkflowConfigSchema = z.object({
  webhookUrl: z.string().url(),
  timeoutMs: z.number().int().min(5_000).max(3_600_000).default(900_000),
  isDefault: z.boolean().default(false),
  recoveryMode: z.enum(['MANUAL', 'IDEMPOTENT_REPLAY']).default('MANUAL')
});

const stageFields = {
  id: z.string().trim().regex(/^E\d{3}$/, '工作流编号格式为 E 加三位数字，例如 E007'),
  displayName: z.string().min(1),
  workflowName: z.string().min(1),
  description: z.string(),
  enabled: z.boolean().default(true),
  reviewEnabled: z.boolean().default(true),
  mediaTypes: z.array(z.enum(['image', 'video'])).min(1),
  inputQueueRoot: z.string().optional(),
  candidateRoot: z.string().optional(),
  approvedArchiveRoot: z.string().optional(),
  outputRoot: z.string().optional(),
  ozonOutputRoot: z.string().optional(),
  targets: z.array(targetConfigSchema).default([])
};

export const legacyStageConfigSchema = z.object(stageFields);

export const stageConfigSchema = z.object({
  ...stageFields,
  alias: z.string().trim().min(1).max(30),
  groupId: z.string().trim().min(1),
  download: downloadWorkflowConfigSchema.optional()
});

export const legacyAppConfigSchema = z.object({
  version: z.literal(LEGACY_APP_VERSION),
  submissionConcurrency: z.number().int().min(1).max(4).default(2),
  thumbnail: z.object({
    maxWidth: z.number().int().min(64).max(2048).default(320),
    maxHeight: z.number().int().min(64).max(2048).default(320),
    quality: z.number().int().min(1).max(100).default(75)
  }),
  stages: z.array(legacyStageConfigSchema)
});

const groupedAppConfigFields = {
  submissionConcurrency: z.number().int().min(1).max(4).default(2),
  thumbnail: z.object({
    maxWidth: z.number().int().min(64).max(2048).default(320),
    maxHeight: z.number().int().min(64).max(2048).default(320),
    quality: z.number().int().min(1).max(100).default(75)
  }),
  workflowGroups: z.array(workflowGroupSchema),
  stages: z.array(stageConfigSchema)
};

function refineGroupedAppConfig(config: { workflowGroups: z.infer<typeof workflowGroupSchema>[]; stages: z.infer<typeof stageConfigSchema>[] }, context: z.RefinementCtx): void {
  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  for (const [index, group] of config.workflowGroups.entries()) {
    const normalizedName = group.name.toLocaleLowerCase();
    if (groupIds.has(group.id)) context.addIssue({ code: 'custom', path: ['workflowGroups', index, 'id'], message: `分组 ID ${group.id} 重复` });
    if (groupNames.has(normalizedName)) context.addIssue({ code: 'custom', path: ['workflowGroups', index, 'name'], message: `分组名称 ${group.name} 重复` });
    groupIds.add(group.id);
    groupNames.add(normalizedName);
  }
  const stageIds = new Set<string>();
  for (const [index, stage] of config.stages.entries()) {
    if (stageIds.has(stage.id)) context.addIssue({ code: 'custom', path: ['stages', index, 'id'], message: `工作流编号 ${stage.id} 重复` });
    if (!groupIds.has(stage.groupId)) context.addIssue({ code: 'custom', path: ['stages', index, 'groupId'], message: `工作流 ${stage.id} 引用了不存在的分组` });
    if (stage.download && !stage.candidateRoot) context.addIssue({ code: 'custom', path: ['stages', index, 'candidateRoot'], message: '下载工作流必须配置候选图片目录' });
    stageIds.add(stage.id);
  }
  for (const [stageIndex, stage] of config.stages.entries()) {
    for (const [targetIndex, target] of stage.targets.entries()) {
      if (!stageIds.has(target.targetStageId)) context.addIssue({ code: 'custom', path: ['stages', stageIndex, 'targets', targetIndex, 'targetStageId'], message: `目标工作流 ${target.targetStageId} 不存在` });
      if (target.targetStageId === stage.id) context.addIssue({ code: 'custom', path: ['stages', stageIndex, 'targets', targetIndex, 'targetStageId'], message: '工作流不能投递到自身' });
    }
  }
  const enabledDownloads = config.stages.filter((stage) => stage.enabled && stage.download);
  const defaultDownloads = enabledDownloads.filter((stage) => stage.download?.isDefault);
  if (enabledDownloads.length && defaultDownloads.length !== 1) {
    context.addIssue({ code: 'custom', path: ['stages'], message: '启用下载工作流时必须且只能设置一个默认下载工作流' });
  }
}

export const previousAppConfigSchema = z.object({
  version: z.literal(PREVIOUS_APP_VERSION),
  ...groupedAppConfigFields
}).superRefine(refineGroupedAppConfig);

export const appConfigSchema = z.object({
  version: z.literal(APP_VERSION),
  ...groupedAppConfigFields,
  wbPublishing: wbPublishingConfigSchema
}).superRefine(refineGroupedAppConfig);

export type TargetConfig = z.infer<typeof targetConfigSchema>;
export type WorkflowGroup = z.infer<typeof workflowGroupSchema>;
export type DownloadWorkflowConfig = z.infer<typeof downloadWorkflowConfigSchema>;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type StageConfig = z.infer<typeof stageConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export const MEDIA_INDEX_STATUSES = ['DISABLED', 'WARMING', 'READY', 'REFRESHING', 'STALE', 'ERROR'] as const;
export type MediaIndexStatus = (typeof MEDIA_INDEX_STATUSES)[number];
export const WATCHER_STATUSES = ['ACTIVE', 'STARTING', 'DEGRADED', 'UNAVAILABLE', 'DISABLED'] as const;
export type WatcherStatus = (typeof WATCHER_STATUSES)[number];
export type MediaIndexState = {
  stageId: string;
  revision: string;
  status: MediaIndexStatus;
  watcherStatus: WatcherStatus;
  activeGeneration?: {
    id: string;
    configRevision: string;
    taskCount: number;
    fileCount: number;
    activatedAt: string;
  };
  pendingReconciliations: number;
  queueCount: number;
  lastReconciledAt?: string;
  lastFullReconciledAt?: string;
  lastEventAt?: string;
  error?: string;
};
export type StageSummary = {
  pending: number;
  drafts: number;
  approved: number;
  queue: number;
  totalTasks: number;
  lastScannedAt: string | null;
};
export type StageView = StageConfig & {
  summary: StageSummary;
  index?: MediaIndexState;
};
export type WorkflowParameterJsonValue =
  | string
  | number
  | boolean
  | null
  | WorkflowParameterJsonValue[]
  | { [key: string]: WorkflowParameterJsonValue };
export type WorkflowParameterValue = string | number | boolean | WorkflowParameterJsonValue[];
export type WorkflowParameterType = 'string' | 'number' | 'boolean' | 'array';
export type WorkflowParameters = Record<string, WorkflowParameterValue>;
export type WorkflowParameterOptionValue = string | number;
export type WorkflowParameterOptions = Record<string, WorkflowParameterOptionValue[]>;

export const WORKFLOW_PRODUCT_IDENTITY_PARAMETER_NAMES = ['SKU', 'productName'] as const;
export const WORKFLOW_RUNTIME_PARAMETER_NAMES = ['SKU', 'productName', 'variants'] as const;
export type WorkflowRuntimeParameterName = (typeof WORKFLOW_RUNTIME_PARAMETER_NAMES)[number];

export function workflowUsesVariantParameter(stageId: string): boolean {
  return ['E002', 'E003', 'E004', 'E005'].includes(stageId);
}

export function withWorkflowRuntimeParameterPlaceholders(parameters: WorkflowParameters = {}, includeVariant = false): WorkflowParameters {
  const userParameters = Object.fromEntries(Object.entries(parameters).filter(([name]) => !WORKFLOW_RUNTIME_PARAMETER_NAMES.includes(name as WorkflowRuntimeParameterName)));
  return { SKU: '', productName: '', ...(includeVariant ? { variants: '' } : {}), ...userParameters };
}

export function withWorkflowProductIdentity(parameters: WorkflowParameters, sku: string, productName: string): WorkflowParameters {
  const userParameters = Object.fromEntries(Object.entries(parameters).filter(([name]) => !WORKFLOW_PRODUCT_IDENTITY_PARAMETER_NAMES.includes(name as typeof WORKFLOW_PRODUCT_IDENTITY_PARAMETER_NAMES[number])));
  return { SKU: sku, productName, ...userParameters };
}

export function withWorkflowTaskIdentity(parameters: WorkflowParameters, sku: string, productName: string, variantName?: string): WorkflowParameters {
  const identified = withWorkflowProductIdentity(parameters, sku, productName);
  const userParameters = Object.fromEntries(Object.entries(identified).filter(([name]) => name !== 'variants'));
  return variantName === undefined ? userParameters : { ...userParameters, variants: variantName };
}

export const workflowParameterFileName = (stageId: string): string => `${stageId}_n8n_product_image_task.json`;
export const workflowParameterOptionsFileName = (stageId: string): string => `${stageId}_n8n_product_image_task.options.json`;

export const createDefaultWorkflowParameters = (dataRoot = 'G:\\01_MerchRoute'): Record<string, WorkflowParameters> => {
  const normalizedRoot = dataRoot.trim().replace(/[\\/]+$/, '');
  const separator = normalizedRoot.includes('\\') ? '\\' : '/';
  const dataPath = (...parts: string[]): string => [normalizedRoot, ...parts].join(separator);
  const defaults: Record<string, WorkflowParameters> = {
  E006: {
    productName: '单肩斜跨包',
    productUrl: '',
    parentOutputDir: dataPath('03-pddProductMedia'),
    maxImagesPerTask: '4'
  },
  E007: {
    SKU: '',
    productName: '',
    productUrl: '',
    parentOutputDir: dataPath('03-1688ProductMedia'),
    maxImagesPerTask: '4'
  },
  E001: {
    downloadFatherFolder: dataPath('02_GenerateFolder', 'E001-抠图-下载'),
    productName: '单肩斜跨包',
    productFolderPath: dataPath('01_monitorFolder', 'E001-抠图-监听', '0097-1-bag-Fashion-BL')
  },
  E002: {
    downloadFatherFolder: dataPath('02_GenerateFolder', 'E002-5视图-下载'),
    productName: '单肩斜跨包',
    productFolderPath: dataPath('01_monitorFolder', 'E002-白底图-生5图-监听', '0097-1-bag-Fashion-BL-20260709-180816')
  },
  E003: {
    productName: '单肩斜跨包',
    productDescription: '轻量通勤小包来袭，宽 23cm 合理容量，轻松收纳随身好物。双内袋分区不乱，多背带切换适配通勤逛街，耐磨面料质感出众，多款色系随心挑选。',
    Category: '包包',
    targetPlatform: 'WB',
    ratio: '1:1',
    Language: '俄文',
    Country: '俄罗斯',
    styleDirection: '真实电商商业摄影风格，干净高级，浅色背景，移动端浏览清晰;',
    titleLenth: '20',
    titleDescriptionLenth: '60',
    maxImagesPerTask: '4'
  },
  E004: {
    outputParentDir: dataPath('02_GenerateFolder', 'E004-主图视频-下载'),
    renderWorkflowId: 'x8D4EHfqI2DHcgL7',
    logoPath: dataPath('logo', 'tek+.png'),
    musicPath: dataPath('99-背景音乐', '科技产品宣传.mp3'),
    ffmpegPath: 'D:/myTools/ffmpeg/bin/ffmpeg.exe',
    effectPreset: '效果3',
    targetDuration: 15,
    width: 768,
    height: 1024,
    fps: 25,
    audioVolume: 0.25,
    audioFadeIn: 0.8,
    audioFadeOut: 2,
    enableLogo: true,
    logoWidth: 90,
    logoMarginX: 12,
    logoMarginY: 12,
    logoOpacity: 1,
    logoPosition: 'top_left',
    minImageCount: 1,
    maxImageCount: 10,
    waitStableSeconds: 5,
    maxWaitSeconds: 120,
    allowedImageExtensions: ['.jpg', '.jpeg', '.png', '.webp'],
    waitStableScriptPath: 'F:/n8n_Project/wait-folder-stable.ps1'
  },
  E005: {
    outputParentDir: dataPath('02_GenerateFolder', 'E005-主图加-LOGO-输出'),
    maxSidePx: '768',
    logo: dataPath('logo', 'tek+.png'),
    outputSuffix: '-logo'
  }
  };
  return Object.fromEntries(Object.entries(defaults).map(([stageId, parameters]) => [stageId, withWorkflowRuntimeParameterPlaceholders(parameters, workflowUsesVariantParameter(stageId))]));
};

export type WbColorIdentity = {
  colorKey: string;
  nameRu: string;
  nameZh: string;
};

export type OzonColorMappingSource = 'AUTO_EXACT_RU' | 'MANUAL_E001' | 'MANUAL_OZON';

export type OzonColorIdentity = {
  itemKey: string;
  dictionaryId: number;
  valueId: number;
  nameRu: string;
  nameZh: string;
  source: OzonColorMappingSource;
};

export type ProductVariant = {
  variantId: string;
  name: string;
  wbColor?: WbColorIdentity;
  ozonColor?: OzonColorIdentity;
};

export type VariantSelectionGroup = {
  groupId: string;
  variantName: string;
  wbColor?: WbColorIdentity;
  ozonColor?: OzonColorIdentity;
  /** An explicit E001 user choice to leave the optional OZON color unset. */
  ozonColorSuppressed?: boolean;
  selectedRelativePaths: string[];
};

export type TaskContext = {
  schemaVersion: 1;
  workflowCode: string;
  SKU: string;
  productName: string;
  variantId?: string;
  variants?: string;
  sourceSubmissionId?: string;
  n8nExecutionId?: string;
};

export type ReviewStatus =
  | 'PENDING_REVIEW'
  | 'DRAFT'
  | 'APPROVED_PENDING_SUBMISSION'
  | 'PACKAGING'
  | 'PARTIALLY_SUBMITTED'
  | 'SUBMITTED'
  | 'FAILED';

export type ReviewRecord = {
  version?: number;
  taskId: string;
  stageId: string;
  sourceFolder: string;
  sourceFolderName: string;
  selectedRelativePaths: string[];
  selectedTargetStageIds: string[];
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  productSku?: string;
  productNameSnapshot?: string;
  productIdentitySource?: ProductIdentitySource;
  variantSelectionGroups?: VariantSelectionGroup[];
  variantId?: string;
  variantName?: string;
};

export type PendingSubmission = {
  version?: number;
  id: string;
  taskId: string;
  sourceStageId: string;
  targetStageId: string;
  selectedRelativePaths: string[];
  n8nTaskParameters: WorkflowParameters;
  n8nTaskParameterOptions?: WorkflowParameterOptions;
  conflictPolicy: 'skip' | 'new-revision';
  status: 'PENDING' | 'PACKAGING' | 'FAILED';
  productSku?: string;
  productNameSnapshot?: string;
  variantGroupId?: string;
  variantId?: string;
  variantName?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type SubmissionStatus = 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED' | 'SKIPPED_CONFLICT';

export type SubmissionRecord = {
  submissionId: string;
  pendingSubmissionId: string;
  taskId: string;
  sourceStageId: string;
  targetStageId: string;
  sourceFolder: string;
  targetFolder?: string;
  archiveFolder?: string;
  selectedImageCount: number;
  selectedRelativePaths?: string[];
  n8nTaskParameters?: WorkflowParameters;
  n8nTaskParameterOptions?: WorkflowParameterOptions;
  n8nParameterFileName?: string;
  productSku?: string;
  productNameSnapshot?: string;
  variantGroupId?: string;
  variantId?: string;
  variantName?: string;
  deliveryType?: 'WORKFLOW' | 'WB_MEDIA' | 'OZON_MEDIA';
  outputRootTemplateSnapshot?: string;
  resolvedOutputRoot?: string;
  mediaManifestPath?: string;
  sourceSubmissionId?: string;
  status: SubmissionStatus;
  errorCode?: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
};

export const SUBMISSION_STEPS = [
  '验证源文件',
  '复制图片',
  '复制元数据',
  '生成清单',
  '完整性校验',
  '写入 READY',
  '原子入队',
  '写入审核归档',
  '完成'
] as const;

export type SubmissionStep = (typeof SUBMISSION_STEPS)[number];
export type BatchItemProgress = {
  pendingSubmissionId: string;
  status: 'WAITING' | 'PROCESSING' | SubmissionStatus;
  step?: SubmissionStep;
  submissionId?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type SubmissionBatchRecord = {
  batchId: string;
  status: 'RUNNING' | 'COMPLETED';
  total: number;
  completed: number;
  createdAt: string;
  completedAt?: string;
  items: BatchItemProgress[];
};

export type AppEvent = {
  id: string;
  type: string;
  message: string;
  details?: Record<string, unknown>;
  createdAt: string;
};

export type AppDatabase = {
  schemaVersion: '1.0' | '1.1';
  reviews: ReviewRecord[];
  pendingSubmissions: PendingSubmission[];
  submissionHistory: SubmissionRecord[];
  submissionBatches: SubmissionBatchRecord[];
  appEvents: AppEvent[];
  reviewOperations?: ReviewOperation[];
  deliveryCheckpoints?: DeliveryCheckpoint[];
  deliveryOutbox?: DeliveryOutboxEntry[];
  reviewReplay?: Record<string, { cursor?: string; scanAfter?: string; resolved: string[]; unresolved?: Record<string, { attempts: number; nextAttemptAt: string }> }>;
};

export type ReviewOperationStatus = 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'NEEDS_ATTENTION' | 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED';
export type ReviewOperation = {
  operationId: string;
  kind: 'APPROVE' | 'BATCH' | 'RETRY';
  requestKey: string; requestAliases?: string[];
  requestHash: string;
  subjectKeys: string[];
  input: Record<string, unknown>;
  status: ReviewOperationStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  attempt: number;
  nextAttemptAt?: string;
  result?: unknown;
  error?: { code: string; message: string; statusCode?: number; details?: unknown };
};

export type ReviewOperationProgress = {
  operationId: string;
  step: string;
  completedFiles?: number;
  totalFiles?: number;
  copiedBytes?: number;
  totalBytes?: number;
  updatedAt: string;
};

export type DeliveryCheckpoint = {
  submissionId: string;
  operationId?: string;
  pendingSubmissionId: string;
  taskId: string;
  phase: 'PREPARING' | 'VERIFIED' | 'COMMIT_INTENT' | 'TARGET_COMMITTED' | 'COMPLETE' | 'NEEDS_ATTENTION';
  manifestPath?: string; manifestAssets?: Array<Record<string, unknown>>;
  targetTemp: string;
  targetFinal: string;
  archiveTemp?: string;
  archiveFinal?: string;
  revision: number;
  record: SubmissionRecord;
  files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
  updatedAt: string;
};

export type DeliveryOutboxEntry = {
  id: string;
  platform: 'WB' | 'OZON';
  submissionId: string;
  status: 'PENDING' | 'SENT';
  attempts: number;
  nextAttemptAt?: string;
  createdAt: string;
  lastError?: string;
};

export type ImageItem = {
  relativePath: string;
  fileName: string;
  directory: string;
  sizeBytes: number;
  lastModifiedAt: string;
  mediaType?: 'image' | 'video';
};

export type FolderTreeNode = {
  key: string;
  title: string;
  imageCount: number;
  videoCount?: number;
  mediaCount?: number;
  children: FolderTreeNode[];
};

export type ProductTask = {
  taskId: string;
  stageId: string;
  sourceFolder: string;
  sourceFolderName: string;
  imageCount: number;
  videoCount?: number;
  mediaCount?: number;
  subfolderCount: number;
  lastModifiedAt: string;
  status: ReviewStatus;
  representativeImages: string[];
  representativeMedia?: Array<{ relativePath: string; mediaType: 'image' | 'video' }>;
};

export type ProductIdentityStatus = 'RESOLVED' | 'UNRESOLVED' | 'AMBIGUOUS' | 'DATABASE_UNAVAILABLE';
export type ProductIdentitySource = 'USER_CONFIRMED' | 'TASK_CONTEXT' | 'DOWNLOAD_OUTPUT_DIR' | 'SKU_PREFIX' | 'PRODUCT_NAME_PREFIX';
export type ProductIdentity = {
  status: ProductIdentityStatus;
  sku?: string;
  productName?: string;
  source?: ProductIdentitySource;
  candidates?: Array<{ sku: string; productName: string }>;
  message?: string;
  variants?: string[];
  variantDetails?: ProductVariant[];
};

export type TaskDetail = ProductTask & {
  reviewVersion?: number;
  tree: FolderTreeNode[];
  images: ImageItem[];
  selectedRelativePaths: string[];
  selectedTargetStageIds: string[];
  productIdentity: ProductIdentity;
  variantSelectionGroups?: VariantSelectionGroup[];
  taskContext?: TaskContext;
};

export const createDefaultConfig = (platform: 'win32' | 'darwin' | 'other', dataRoot?: string): AppConfig => {
  const win = platform === 'win32';
  const root = dataRoot?.trim() || (win ? 'G:\\01_MerchRoute' : '/Volumes/YOUR_DATA_DISK/01_MerchRoute');
  const join = (...parts: string[]) => win ? parts.join('\\') : parts.join('/');
  return {
    version: APP_VERSION,
    submissionConcurrency: 2,
    thumbnail: { maxWidth: 320, maxHeight: 320, quality: 75 },
    wbPublishing: { enabled: false, rootDirectory: '' },
    workflowGroups: [
      { id: 'downloads', name: '下载组' },
      { id: 'cutout', name: '抠图组' },
      { id: 'generation', name: '生图组' },
      { id: 'video', name: '视频组' },
      { id: 'logo', name: 'LOGO组' }
    ],
    stages: [
      {
        id: 'E006', alias: 'PDD下载', groupId: 'downloads', displayName: '拼多多商品媒体下载', workflowName: 'E006-拼多多商品媒体下载',
        description: '下载产品主图和详情图', enabled: true, reviewEnabled: true, mediaTypes: ['image'],
        candidateRoot: join(root, '03-pddProductMedia'), approvedArchiveRoot: join(root, '04_已审核图片目录', 'E006-已经审核'),
        download: { webhookUrl: 'http://localhost:5678/webhook/pdd-image-download', timeoutMs: 900_000, isDefault: true, recoveryMode: 'IDEMPOTENT_REPLAY' },
        targets: [{ targetStageId: 'E001', targetQueueRoot: join(root, '01_monitorFolder', 'E001-抠图-监听'), folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true }]
      },
      {
        id: 'E007', alias: '1688下载', groupId: 'downloads', displayName: '1688产品媒体下载', workflowName: 'E007-v01-1688产品媒体下载',
        description: '下载 1688 产品主图、详情图和视频', enabled: true, reviewEnabled: true, mediaTypes: ['image', 'video'],
        candidateRoot: join(root, '03-1688ProductMedia'), approvedArchiveRoot: join(root, '04_已审核图片目录', 'E007-已经审核'),
        download: { webhookUrl: 'http://localhost:5678/webhook/1688-product-media-download', timeoutMs: 900_000, isDefault: false, recoveryMode: 'IDEMPOTENT_REPLAY' },
        targets: [{ targetStageId: 'E001', targetQueueRoot: join(root, '01_monitorFolder', 'E001-抠图-监听'), folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true }]
      },
      {
        id: 'E001', alias: '抠图', groupId: 'cutout', displayName: '批量抠图', workflowName: 'E001-v02-批量抠图-即梦',
        description: '抠出产品主体并生成白底图片', enabled: true, reviewEnabled: true, mediaTypes: ['image'],
        inputQueueRoot: join(root, '01_monitorFolder', 'E001-抠图-监听'), candidateRoot: join(root, '02_generateFolder', 'E001-抠图-下载'),
        approvedArchiveRoot: join(root, '04_已审核图片目录', 'E001-白底图-已经审核'),
        targets: [{ targetStageId: 'E002', targetQueueRoot: join(root, '01_monitorFolder', 'E002-白底图-生5图-监听'), folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true }]
      },
      {
        id: 'E002', alias: '五视图', groupId: 'generation', displayName: '白底图生成 5 视图', workflowName: 'E002-v02-白底图-生5视图',
        description: '由白底图生成 5 视图图片', enabled: true, reviewEnabled: true, mediaTypes: ['image'],
        inputQueueRoot: join(root, '01_monitorFolder', 'E002-白底图-生5图-监听'), candidateRoot: join(root, '02_generateFolder', 'E002-5视图-下载'),
        approvedArchiveRoot: join(root, '04_已审核图片目录', 'E002-5视图-已经审核'),
        targets: [{ targetStageId: 'E003', targetQueueRoot: join(root, '01_monitorFolder', 'E003-5生7-监听'), folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true }]
      },
      {
        id: 'E003', alias: '套图', groupId: 'generation', displayName: '5 视图生成 7 张电商套图', workflowName: 'E003-v09-即梦-5生7-电商套图',
        description: '由 5 视图生成 7 张电商套图', enabled: true, reviewEnabled: true, mediaTypes: ['image'],
        inputQueueRoot: join(root, '01_monitorFolder', 'E003-5生7-监听'), candidateRoot: join(root, '02_generateFolder', 'E003-7套图-下载'),
        approvedArchiveRoot: join(root, '04_已审核图片目录', 'E003-7张套图-已经审核'),
        targets: [
          { targetStageId: 'E004', targetQueueRoot: join(root, '01_monitorFolder', 'E004-主图生视频-监听'), folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true },
          { targetStageId: 'E005', targetQueueRoot: join(root, '01_monitorFolder', 'E005-主图加-LOGO-监听'), folderNameTemplate: '{sourceName}-已经审核', packageMode: 'preserve-relative', copyRootMetadata: true }
        ]
      },
      {
        id: 'E004', alias: '视频', groupId: 'video', displayName: '主图生成视频', workflowName: 'E004-v01-主图生视频-FFmpeng',
        description: '通过多张产品主图生成主图视频', enabled: true, reviewEnabled: true, mediaTypes: ['video'],
        inputQueueRoot: join(root, '01_monitorFolder', 'E004-主图生视频-监听'), candidateRoot: join(root, '02_generateFolder', 'E004-主图视频-下载'),
        approvedArchiveRoot: join(root, '04_已审核图片目录', 'E004-已经审核'),
        ozonOutputRoot: join(root, 'OZON-Auto-Publish', 'inbox', '<SKU>', 'variants'), targets: []
      },
      {
        id: 'E005', alias: 'LOGO', groupId: 'logo', displayName: '主图加 Logo 和 Resize', workflowName: 'E005-v06-图片加logo-Resize',
        description: '给产品主图加 Logo 并调整尺寸', enabled: true, reviewEnabled: true, mediaTypes: ['image'],
        inputQueueRoot: join(root, '01_monitorFolder', 'E005-主图加-LOGO-监听'), candidateRoot: join(root, '02_generateFolder', 'E005-主图加-LOGO-输出'),
        approvedArchiveRoot: join(root, '04_已审核图片目录', 'E005-已经审核'),
        ozonOutputRoot: join(root, 'OZON-Auto-Publish', 'inbox', '<SKU>', 'variants'), targets: []
      }
    ]
  };
};

export class AppError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>, public statusCode = 400) {
    super(message);
    this.name = 'AppError';
  }
}

export const SHIPPING_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;

export const commercePlatformCodeSchema = z.string().trim().min(2).max(32).regex(/^[A-Z0-9_-]+$/, '平台代码只能包含大写字母、数字、下划线和连字符').transform((value) => value.toUpperCase());
export const currencyCodeSchema = z.string().trim().length(3).regex(/^[A-Z]{3}$/, '币种代码必须是三位大写字母').transform((value) => value.toUpperCase());
export const shippingScenarioCodeSchema = z.string().trim().min(1).max(64).regex(/^[A-Z0-9_-]+$/, '场景代码只能包含大写字母、数字、下划线和连字符').transform((value) => value.toUpperCase());
export const decimalSchema = z.string().trim().regex(/^\d+(?:\.\d+)?$/, '必须是非负十进制数字');
export const positiveDecimalSchema = decimalSchema.refine((value) => Number(value) > 0, '必须大于 0');
const rateSchema = decimalSchema.refine((value) => Number(value) < 1, '费率必须小于 1');
const componentCodeSchema = z.string().trim().min(1).max(64).regex(/^[A-Z0-9_-]+$/, '组件代码只能包含大写字母、数字、下划线和连字符').transform((value) => value.toUpperCase());

export const shippingDecimalRangeSchema = z.object({
  min: decimalSchema.optional(),
  max: decimalSchema.optional(),
  includeMin: z.boolean().default(true),
  includeMax: z.boolean().default(true)
});

export const shippingRuleSchema = z.object({
  id: z.string().min(1),
  productCategory: z.string().min(1).optional(),
  destinationCountryCodes: z.array(z.string().trim().min(2).max(8)).default([]),
  constraints: z.object({
    salePrice: shippingDecimalRangeSchema.optional(),
    salePriceRub: shippingDecimalRangeSchema.optional(),
    actualWeightKg: shippingDecimalRangeSchema.optional(),
    maxSideSumCm: positiveDecimalSchema.optional(),
    maxLongestSideCm: positiveDecimalSchema.optional(),
    maxDimensionBoxCm: z.tuple([positiveDecimalSchema, positiveDecimalSchema, positiveDecimalSchema]).optional(),
    minDensityKgM3: positiveDecimalSchema.optional(),
    maxChargeableWeightKg: positiveDecimalSchema.optional()
  }).default({}),
  chargeableWeight: z.object({
    mode: z.enum(['ACTUAL', 'MAX_ACTUAL_VOLUMETRIC']),
    volumetricDivisor: positiveDecimalSchema.optional(),
    volumetricTriggerSideSumCm: positiveDecimalSchema.optional(),
    volumetricRoundingStepKg: positiveDecimalSchema.optional(),
    roundingStepKg: positiveDecimalSchema.optional()
  }),
  pricing: z.object({
    ratePerKg: decimalSchema,
    fixedFee: decimalSchema,
    currency: currencyCodeSchema.default('CNY')
  })
});

export const shippingServiceSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Z0-9_-]+$/, '渠道代码只能包含大写字母、数字、下划线和连字符'),
  name: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  deliveryMode: z.string().trim().optional(),
  transitTime: z.string().trim().optional(),
  returnService: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  sortOrder: z.number().int().min(0).default(0),
  rules: z.array(shippingRuleSchema).min(1)
});

export const shippingTemplateDefinitionSchema = z.object({
  schemaVersion: z.literal('1'),
  currency: currencyCodeSchema,
  salePriceCurrencyCode: currencyCodeSchema.optional(),
  services: z.array(shippingServiceSchema)
}).superRefine((value, context) => {
  const hasSalePriceRanges = value.services.some((service) => service.rules.some((rule) => Boolean(rule.constraints.salePrice || rule.constraints.salePriceRub)));
  if (hasSalePriceRanges && !value.salePriceCurrencyCode) context.addIssue({ code: z.ZodIssueCode.custom, path: ['salePriceCurrencyCode'], message: '配置售价区间时必须指定售价区间币种' });
});

export const shippingCalculationInputSchema = z.object({
  shippingTemplateId: z.string().uuid().optional(),
  platformCode: commercePlatformCodeSchema.optional(),
  scenarioCode: shippingScenarioCodeSchema.optional(),
  templateType: shippingScenarioCodeSchema.optional(),
  carrierCode: z.string().trim().min(1).max(32).transform((value) => value.toUpperCase()).optional(),
  actualWeightGrams: positiveDecimalSchema,
  lengthCm: positiveDecimalSchema,
  widthCm: positiveDecimalSchema,
  heightCm: positiveDecimalSchema,
  salePrice: positiveDecimalSchema.optional(),
  salePriceRub: positiveDecimalSchema.optional(),
  destinationCountryCode: z.string().trim().min(2).max(8).transform((value) => value.toUpperCase()).nullish()
}).superRefine((value, context) => {
  if (!value.shippingTemplateId && !(value.platformCode && (value.scenarioCode || value.templateType) && value.carrierCode)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['shippingTemplateId'], message: '请选择运费模板，或提供平台、场景和承运商兼容字段' });
  }
});

export const commercePlatformInputSchema = z.object({
  code: commercePlatformCodeSchema,
  displayName: z.string().trim().min(1).max(100),
  active: z.boolean().optional()
});

export const currencyInputSchema = z.object({
  code: currencyCodeSchema,
  displayName: z.string().trim().min(1).max(100),
  symbol: z.string().trim().min(1).max(12),
  decimalPlaces: z.number().int().min(0).max(6),
  active: z.boolean().optional()
});

export const pricingTemplateDefinitionSchema = z.object({
  schemaVersion: z.literal('1'),
  costCurrencyCode: currencyCodeSchema,
  saleCurrencyCode: currencyCodeSchema,
  saleCurrencyPerCostCurrency: positiveDecimalSchema,
  exchangeRateAsOf: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, '汇率日期必须是 YYYY-MM-DD').optional(),
  exchangeRateSourceNote: z.string().trim().max(500).optional(),
  storeDiscountRate: rateSchema,
  strikePriceMultiplier: positiveDecimalSchema.refine((value) => Number(value) >= 1, '划线价倍数不能小于 1'),
  defaultCommissionRate: rateSchema,
  defaultTargetMarginRate: rateSchema,
  fixedCosts: z.array(z.object({ code: componentCodeSchema, name: z.string().trim().min(1).max(100), amount: decimalSchema, enabled: z.boolean().default(true) })).default([]),
  percentageDeductions: z.array(z.object({ code: componentCodeSchema, name: z.string().trim().min(1).max(100), rate: rateSchema, enabled: z.boolean().default(true) })).default([])
}).superRefine((value, context) => {
  if (value.costCurrencyCode === value.saleCurrencyCode && Number(value.saleCurrencyPerCostCurrency) !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['saleCurrencyPerCostCurrency'], message: '成本币种与销售币种相同时汇率必须为 1' });
  }
  const componentCodes = [...value.fixedCosts, ...value.percentageDeductions].map((item) => item.code);
  if (new Set(componentCodes).size !== componentCodes.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['fixedCosts'], message: '成本组件代码不能重复' });
  const totalRate = Number(value.defaultCommissionRate) + Number(value.defaultTargetMarginRate) + value.percentageDeductions.filter((item) => item.enabled).reduce((sum, item) => sum + Number(item.rate), 0);
  if (totalRate >= 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ['percentageDeductions'], message: '默认佣金、目标毛利和比例成本合计必须小于 100%' });
});

export const pricingCalculationItemSchema = z.object({
  sku: z.string().trim().min(1).max(100),
  productName: z.string().trim().min(1).max(300),
  purchaseCost: decimalSchema,
  domesticFreight: decimalSchema.default('0'),
  actualWeightGrams: positiveDecimalSchema,
  lengthCm: positiveDecimalSchema,
  widthCm: positiveDecimalSchema,
  heightCm: positiveDecimalSchema,
  destinationCountryCode: z.string().trim().min(2).max(8).transform((value) => value.toUpperCase()).nullish(),
  commissionRate: rateSchema.optional(),
  targetMarginRate: rateSchema.optional()
});

export const pricingCalculationInputSchema = z.object({
  pricingTemplateId: z.string().uuid(),
  shippingTemplateIds: z.array(z.string().uuid()).min(1).max(50),
  item: pricingCalculationItemSchema
});

export const pricingBatchCalculationInputSchema = z.object({
  pricingTemplateId: z.string().uuid(),
  shippingTemplateIds: z.array(z.string().uuid()).min(1).max(50),
  items: z.array(z.unknown()).min(1).max(500)
});

export const pricingProductQueryInputSchema = z.object({
  lookup: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('SKU'), sku: z.string().trim().regex(/^\d{7}$/, 'SKU 必须是完整的 7 位数字') }),
    z.object({ kind: z.literal('PRODUCT_NAME'), productName: z.string().trim().min(1).max(300) })
  ]),
  pricingTemplateId: z.string().uuid(),
  shippingTemplateIds: z.array(z.string().uuid()).length(1, '售价查询每次只能选择一个运费模板'),
  shippingServiceCodes: z.array(z.string().trim().min(1).max(64).regex(/^[A-Z0-9_-]+$/, '服务渠道代码格式无效').transform((value) => value.toUpperCase())).min(1, '请至少选择一个服务渠道').max(100)
    .refine((codes) => new Set(codes).size === codes.length, '服务渠道不能重复'),
  destinationCountryCode: z.string().trim().min(2).max(8).transform((value) => value.toUpperCase()).nullish()
});

export type PricingMoneyAmount = { currencyCode: string; value: string; displayValue: string };
export type PricingCurrencySnapshot = { code: string; displayName: string; symbol: string; decimalPlaces: number };
export type PricingOptionResult = {
  optionId: string;
  recommended: boolean;
  shipping: Record<string, unknown> & { serviceName: string; channel: string; chargeableWeightKg: string; freightAmount: PricingMoneyAmount };
  costs: {
    purchase: PricingMoneyAmount;
    domesticFreight: PricingMoneyAmount;
    crossBorderFreight: PricingMoneyAmount;
    fixedComponents: Array<{ code: string; name: string; amount: PricingMoneyAmount }>;
    totalFixedCost: PricingMoneyAmount;
  };
  rates: {
    commissionRate: string;
    targetMarginRate: string;
    percentageDeductions: Array<{ code: string; name: string; rate: string }>;
    totalRate: string;
  };
  amounts: {
    targetSale: { costCurrency: PricingMoneyAmount; saleCurrency: PricingMoneyAmount };
    listing: { costCurrency: PricingMoneyAmount; saleCurrency: PricingMoneyAmount };
    strike: { costCurrency: PricingMoneyAmount; saleCurrency: PricingMoneyAmount };
  };
};
export type PricingCalculationResult = {
  pricingTemplate: {
    templateId: string;
    versionId: string;
    versionNo: number;
    templateName: string;
    platformCode: string;
    platformName: string;
    definition: PricingTemplateDefinitionV1 & { costCurrency: PricingCurrencySnapshot; saleCurrency: PricingCurrencySnapshot };
  };
  item: PricingCalculationItem;
  summary: { optionCount: number; recommendedOptionId?: string | null };
  options: PricingOptionResult[];
  calculatedAt: string;
};
export type PricingProductSnapshot = {
  sku: string;
  productName: string;
  updatedAt: string;
  procurement: {
    id: string;
    versionNo: number;
    purchasePrice: string;
    courierFee: string;
    currency: string;
    grossWeightGrams?: string | null;
    lengthCm?: string | null;
    widthCm?: string | null;
    heightCm?: string | null;
    netWeightGrams?: string | null;
    productHeightCm?: string | null;
    productDepthCm?: string | null;
    productWidthCm?: string | null;
    createdAt: string;
  };
};
export type PricingProductQueryResult = {
  lookup: { kind: 'SKU' | 'PRODUCT_NAME'; value: string; matchedCount: number };
  pricingTemplate: { templateId: string; versionId: string; versionNo: number; templateName: string; platformCode: string; platformName: string };
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{
    index: number;
    product: PricingProductSnapshot;
    ok: boolean;
    result?: PricingCalculationResult;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  }>;
  calculatedAt: string;
};

export type ShippingPlatformCode = string;
export type ShippingTemplateType = string;
export type ShippingVersionStatus = (typeof SHIPPING_VERSION_STATUSES)[number];
export type ShippingDecimalRange = z.infer<typeof shippingDecimalRangeSchema>;
export type ShippingRule = z.infer<typeof shippingRuleSchema>;
export type ShippingService = z.infer<typeof shippingServiceSchema>;
export type ShippingTemplateDefinitionV1 = z.infer<typeof shippingTemplateDefinitionSchema>;
export type ShippingCalculationInput = z.infer<typeof shippingCalculationInputSchema>;
export type CommercePlatformInput = z.infer<typeof commercePlatformInputSchema>;
export type CurrencyInput = z.infer<typeof currencyInputSchema>;
export type PricingTemplateDefinitionV1 = z.infer<typeof pricingTemplateDefinitionSchema>;
export type PricingCalculationItem = z.infer<typeof pricingCalculationItemSchema>;
export type PricingCalculationInput = z.infer<typeof pricingCalculationInputSchema>;
export type PricingProductQueryInput = z.infer<typeof pricingProductQueryInputSchema>;
