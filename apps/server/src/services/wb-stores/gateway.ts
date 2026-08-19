import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  AppError,
  wbGatewayRequestSchema,
  type WbGatewayDeliveryState,
  type WbGatewayResponse,
  type WbGatewayRetryClass
} from '@n8n-media-review/shared';
import type { WbStoreRepository, WbGatewayIdentity } from '../../repositories/wb-stores.js';
import type { WbStoreService } from './index.js';

type JsonRecord = Record<string, unknown>;
type GatewayOperation = {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  write: boolean;
  timeoutMs: number;
  media?: {
    relativePath: string; mimeType: string; fileName: string; sha256: string;
    sourceRelativePath?: string; sourceSha256?: string;
  };
};

const CONTENT = 'https://content-api.wildberries.ru';
const PRICES = 'https://discounts-prices-api.wildberries.ru';
const MARKETPLACE = 'https://marketplace-api.wildberries.ru';
const COMMON = 'https://common-api.wildberries.ru';

type TransportPhase = 'DNS' | 'CONNECT' | 'REQUEST' | 'RESPONSE_HEADERS' | 'RESPONSE_BODY' | 'UNKNOWN';

export class WbStoreGatewayService {
  constructor(private readonly stores: WbStoreRepository, private readonly storeService: WbStoreService) {}

  async execute(input: unknown): Promise<WbGatewayResponse> {
    const parsed = wbGatewayRequestSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'WB 网关请求格式无效', { issues: parsed.error.issues });
    assertNoSecrets(parsed.data.payload);
    const identity = await this.stores.getGatewayIdentity({ taskId: parsed.data.taskId, storeId: parsed.data.storeId });
    if (parsed.data.storeId && parsed.data.storeId !== identity.storeId) {
      throw new AppError('CONFIG_INVALID', 'WB 网关 taskId 与 storeId 不属于同一店铺', {
        taskId: parsed.data.taskId, storeId: parsed.data.storeId
      }, 409);
    }
    const operation = await buildOperation(parsed.data.operation, parsed.data.payload, identity);
    if (operation.write && parsed.data.taskId && !identity.storeEnabled && !identity.leaseActive) {
      throw new AppError('WB_STORE_DISABLED', '店铺已停用且任务没有有效租约，拒绝开始新的 WB 写入', {
        taskId: parsed.data.taskId, storeId: identity.storeId
      }, 409);
    }
    if (operation.write && !parsed.data.taskId) {
      throw new AppError('TASK_ID_REQUIRED', 'WB 写操作必须绑定不可变 runtime taskId 快照', {
        storeId: identity.storeId, operation: parsed.data.operation
      }, 409);
    }
    // Resolve containment and verify both source/derivative hashes before a
    // ledger row exists. A local verification failure is never a transport
    // UNKNOWN and must not be mistaken for a possibly delivered WB write.
    const resolvedMedia = operation.media ? await resolveMedia(identity, operation.media) : undefined;
    const requestHash = `sha256:${createHash('sha256').update(stableJson({
      taskId: identity.taskId || null,
      storeId: identity.storeId,
      credentialVersionId: identity.credential.id,
      warehouseId: identity.warehouseId,
      operation: parsed.data.operation,
      payload: parsed.data.payload
    })).digest('hex')}`;
    const cardAttempt = resolveCardAttemptIdentity({
      taskId: identity.taskId,
      requestRef: parsed.data.requestRef,
      operation: parsed.data.operation,
      logicalIntentId: parsed.data.logicalIntentId,
      attemptNo: parsed.data.attemptNo
    });
    const ledger = await this.stores.beginGatewayRequest({
      requestRef: parsed.data.requestRef,
      requestHash,
      operation: parsed.data.operation,
      identity,
      ...cardAttempt
    });
    if (ledger.idempotent) return responseFromLedger(ledger.row, parsed.data.requestRef);

    const token = this.storeService.decryptGatewayCredential(identity.credential, identity.storeId);
    let response: Response;
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: token,
        ...(operation.headers || {})
      };
      let body: BodyInit | undefined;
      if (operation.media) {
        const form = new FormData();
        form.append('uploadfile', await openAsBlob(resolvedMedia!.filePath, { type: operation.media.mimeType }), operation.media.fileName);
        body = form;
      } else if (operation.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(operation.body);
      }
      response = await fetch(operation.url, {
        method: operation.method,
        headers,
        body,
        signal: AbortSignal.timeout(operation.timeoutMs)
      });
    } catch (error) {
      const classification = classifyTransportFailure(error, operation.write);
      const transport = transportFailureDetails(error, 'REQUEST');
      const safe = {
        error: 'WB_GATEWAY_TRANSPORT',
        message: error instanceof Error ? error.message.slice(0, 1_000) : 'WB 请求传输失败',
        transportCode: transport.code,
        transportPhase: transport.phase
      };
      await this.stores.completeGatewayRequest({
        requestRef: parsed.data.requestRef,
        statusCode: 0,
        deliveryState: classification.deliveryState,
        retryClass: classification.retryClass,
        transportCode: transport.code,
        transportPhase: transport.phase,
        response: safe
      });
      return {
        ok: false, statusCode: 0, body: safe, deliveryState: classification.deliveryState,
        retryClass: classification.retryClass, requestRef: parsed.data.requestRef
      };
    }

    let body: unknown;
    try {
      body = await safeResponseBody(response);
    } catch (error) {
      const transport = transportFailureDetails(error, 'RESPONSE_BODY');
      const classification = classifyResponseBodyFailure(operation.write);
      const safe = {
        error: 'WB_GATEWAY_TRANSPORT',
        message: error instanceof Error ? error.message.slice(0, 1_000) : '读取 WB 响应失败',
        transportCode: transport.code,
        transportPhase: transport.phase
      };
      await this.stores.completeGatewayRequest({
        requestRef: parsed.data.requestRef,
        statusCode: response.status,
        deliveryState: classification.deliveryState,
        retryClass: classification.retryClass,
        transportCode: transport.code,
        transportPhase: transport.phase,
        response: safe
      });
      return {
        ok: false,
        statusCode: response.status,
        body: safe,
        deliveryState: classification.deliveryState,
        retryClass: classification.retryClass,
        requestRef: parsed.data.requestRef
      };
    }
    const retryAfterMs = retryAfter(response.headers);
    const classification = classifyResponse(response.status, operation.write);
    const safeBody = redactSecrets(body);
    await this.stores.completeGatewayRequest({
      requestRef: parsed.data.requestRef,
      statusCode: response.status,
      deliveryState: classification.deliveryState,
      retryClass: classification.retryClass,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      response: safeBody
    });
    return {
      ok: response.ok,
      statusCode: response.status,
      body: safeBody,
      deliveryState: classification.deliveryState,
      retryClass: classification.retryClass,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      requestRef: parsed.data.requestRef
    };
  }
}

function resolveCardAttemptIdentity(input: {
  taskId?: string;
  requestRef: string;
  operation: string;
  logicalIntentId?: string;
  attemptNo?: number;
}): { logicalIntentId?: string; attemptNo?: number } {
  if (input.operation !== 'CARD_UPLOAD' || !input.taskId) {
    return input.logicalIntentId === undefined ? {} : {
      logicalIntentId: input.logicalIntentId,
      attemptNo: input.attemptNo
    };
  }
  const prefix = `${input.taskId}:CARD_WRITE:`;
  const tail = input.requestRef.startsWith(prefix) ? input.requestRef.slice(prefix.length) : '';
  const match = /^(.*):attempt-(\d+)$/.exec(tail);
  const derived = match && match[1] ? {
    logicalIntentId: match[1],
    attemptNo: Number(match[2])
  } : undefined;
  if (derived && (derived.logicalIntentId.length > 256 || !Number.isSafeInteger(derived.attemptNo))) {
    throw new AppError('WB_CARD_ATTEMPT_INVALID', 'CARD_UPLOAD requestRef 中的 logical intent 无效', {
      requestRef: input.requestRef
    }, 409);
  }
  if (input.logicalIntentId !== undefined) {
    if (derived && (derived.logicalIntentId !== input.logicalIntentId || derived.attemptNo !== input.attemptNo)) {
      throw new AppError('WB_CARD_INTENT_CONFLICT', 'CARD_UPLOAD 顶层 intent 与 requestRef 身份不一致', {
        requestRef: input.requestRef, logicalIntentId: input.logicalIntentId, attemptNo: input.attemptNo
      }, 409);
    }
    return { logicalIntentId: input.logicalIntentId, attemptNo: input.attemptNo };
  }
  return derived || {};
}

async function buildOperation(name: string, payload: JsonRecord, identity: WbGatewayIdentity): Promise<GatewayOperation> {
  const body = Object.hasOwn(payload, 'body') ? payload.body : payload;
  const locale = payload.locale === 'zh' ? 'zh' : 'ru';
  switch (name) {
    case 'CARDS_LIST_ACTIVE': return json('POST', `${CONTENT}/content/v2/get/cards/list?locale=${locale}`, body, false);
    case 'CARDS_LIST_TRASH': return json('POST', `${CONTENT}/content/v2/get/cards/trash?locale=${locale}`, body, false);
    case 'TNVED_LIST': {
      const subjectId = positiveInteger(payload.subjectId ?? payload.subjectID, 'subjectId');
      const query = new URLSearchParams({ subjectID: String(subjectId), locale });
      if (typeof payload.search === 'string' && payload.search.trim()) query.set('search', payload.search.trim().slice(0, 128));
      return json('GET', `${CONTENT}/content/v2/directory/tnved?${query}`, undefined, false);
    }
    case 'BARCODES_ALLOCATE': return json('POST', `${CONTENT}/content/v2/barcodes`, body, true);
    case 'CARDS_ERROR_LIST': return json('POST', `${CONTENT}/content/v2/cards/error/list?locale=${locale}`, body, false);
    case 'CARD_UPLOAD': return json('POST', `${CONTENT}/content/v2/cards/upload`, body, true);
    case 'CARD_UPDATE': return json('POST', `${CONTENT}/content/v2/cards/update`, body, true);
    case 'CARD_UPLOAD_ADD': return json('POST', `${CONTENT}/content/v2/cards/upload/add`, body, true);
    case 'MEDIA_SAVE': return json('POST', `${CONTENT}/content/v3/media/save`, body, true, 180_000);
    case 'MEDIA_UPLOAD_FILE': {
      const relativePath = safeRelativePath(payload.relativePath);
      const nmId = positiveInteger(payload.nmId ?? payload.nmID, 'nmId');
      const photoNumber = Math.max(1, positiveInteger(payload.photoNumber, 'photoNumber'));
      const sha256 = String(payload.sha256 || '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AppError('CONFIG_INVALID', 'MEDIA_UPLOAD_FILE sha256 格式无效');
      const mimeType = mediaMimeType(relativePath);
      const kind = String(payload.kind || '').trim().toLowerCase();
      if (kind && kind !== (mimeType.startsWith('video/') ? 'video' : 'image')) {
        throw new AppError('CONFIG_INVALID', 'MEDIA_UPLOAD_FILE kind 与文件扩展名不一致');
      }
      const derivative = relativePath.startsWith('.wb-media-cache/');
      const sourceRelativePath = payload.sourceRelativePath === undefined ? undefined : safeRelativePath(payload.sourceRelativePath);
      const sourceSha256 = payload.sourceSha256 === undefined ? undefined : String(payload.sourceSha256 || '').trim().toLowerCase();
      if (derivative && (!sourceRelativePath || sourceRelativePath.startsWith('.wb-media-cache/') || !/^[0-9a-f]{64}$/.test(sourceSha256 || ''))) {
        throw new AppError('CONFIG_INVALID', '转码缓存视频必须提供源 manifest 路径和 sourceSha256');
      }
      if (derivative && !mimeType.startsWith('video/')) {
        throw new AppError('CONFIG_INVALID', '.wb-media-cache 只允许上传经过校验的视频衍生文件');
      }
      if (!derivative && ((sourceRelativePath && sourceRelativePath !== relativePath) || (sourceSha256 && sourceSha256 !== sha256))) {
        throw new AppError('CONFIG_INVALID', '非衍生媒体的 sourceRelativePath/sourceSha256 必须与上传文件一致');
      }
      return {
        method: 'POST', url: `${CONTENT}/content/v3/media/file`, write: true,
        headers: { 'x-nm-id': String(nmId), 'x-photo-number': String(photoNumber) }, timeoutMs: mimeType.startsWith('video/') ? 180_000 : 120_000,
        media: {
          relativePath, mimeType, fileName: path.posix.basename(relativePath), sha256,
          ...(sourceRelativePath && sourceSha256 ? { sourceRelativePath, sourceSha256 } : {})
        }
      };
    }
    case 'PRICES_LIST': return json('POST', `${PRICES}/api/v2/list/goods/filter`, body, false);
    case 'PRICES_UPLOAD_PRODUCT': return json('POST', `${PRICES}/api/v2/upload/task`, body, true);
    case 'PRICES_UPLOAD_SIZE': return json('POST', `${PRICES}/api/v2/upload/task/size`, body, true);
    case 'PRICES_UPLOAD_CLUB_DISCOUNT': return json('POST', `${PRICES}/api/v2/upload/task/club-discount`, body, true);
    case 'PRICE_BUFFER_TASK': return json('GET', `${PRICES}/api/v2/buffer/tasks?uploadID=${positiveInteger(payload.uploadId ?? payload.uploadID, 'uploadId')}`, undefined, false);
    case 'PRICE_HISTORY_TASK': return json('GET', `${PRICES}/api/v2/history/tasks?uploadID=${positiveInteger(payload.uploadId ?? payload.uploadID, 'uploadId')}`, undefined, false);
    case 'PRICE_QUARANTINE': {
      const limit = boundedInteger(payload.limit, 1, 1_000, 1_000);
      const offset = boundedInteger(payload.offset, 0, 100_000_000, 0);
      return json('GET', `${PRICES}/api/v2/quarantine/goods?limit=${limit}&offset=${offset}`, undefined, false);
    }
    case 'STOCKS_READ': return json('POST', `${MARKETPLACE}/api/v3/stocks/${requiredWarehouse(identity)}`, body, false);
    case 'STOCKS_WRITE': return json('PUT', `${MARKETPLACE}/api/v3/stocks/${requiredWarehouse(identity)}`, body, true);
    case 'PARENT_CATEGORIES': return json('GET', `${CONTENT}/content/v2/object/parent/all?locale=${locale}`, undefined, false);
    case 'SUBJECTS_SEARCH': {
      const query = new URLSearchParams({ locale, limit: String(boundedInteger(payload.limit, 1, 1_000, 100)), offset: String(boundedInteger(payload.offset, 0, 100_000_000, 0)) });
      if (typeof payload.name === 'string' && payload.name.trim()) query.set('name', payload.name.trim().slice(0, 256));
      if (payload.parentId !== undefined || payload.parentID !== undefined) query.set('parentID', String(positiveInteger(payload.parentId ?? payload.parentID, 'parentId')));
      return json('GET', `${CONTENT}/content/v2/object/all?${query}`, undefined, false);
    }
    case 'SUBJECT_CHARACTERISTICS': return json('GET', `${CONTENT}/content/v2/object/charcs/${positiveInteger(payload.subjectId, 'subjectId')}?locale=${locale}`, undefined, false);
    case 'DIRECTORY_LOOKUP': {
      const directory = String(payload.directory || '').trim().toLowerCase();
      if (!['colors', 'countries', 'seasons', 'kinds', 'vat', 'tnved'].includes(directory)) {
        throw new AppError('CONFIG_INVALID', 'directory 不在 WB 固定目录允许列表中', { directory });
      }
      const query = new URLSearchParams({ locale });
      if (directory === 'tnved') query.set('subjectID', String(positiveInteger(payload.subjectId, 'subjectId')));
      if (typeof payload.search === 'string' && payload.search.trim()) query.set('search', payload.search.trim().slice(0, 256));
      return json('GET', `${CONTENT}/content/v2/directory/${encodeURIComponent(directory)}?${query}`, undefined, false);
    }
    case 'SELLER_WAREHOUSES': return json('GET', `${MARKETPLACE}/api/v3/warehouses`, undefined, false);
    case 'SELLER_INFO': return json('GET', `${COMMON}/api/v1/seller-info`, undefined, false);
    case 'PRICE_ACCESS_PROBE': return json('GET', `${PRICES}/api/v2/list/goods/filter?limit=1&offset=0`, undefined, false);
    default: throw new AppError('CONFIG_INVALID', 'WB 网关 operation 不在允许列表中', { operation: name }, 400);
  }
}

function json(method: GatewayOperation['method'], url: string, body: unknown, write: boolean, timeoutMs = 60_000): GatewayOperation {
  return { method, url, ...(body === undefined ? {} : { body }), write, timeoutMs };
}

async function resolveMedia(identity: WbGatewayIdentity, media: NonNullable<GatewayOperation['media']>): Promise<{ filePath: string }> {
  const { relativePath, sha256: expectedSha256 } = media;
  if (!identity.rootDirectory || !identity.workRelpath) throw new AppError('CONFIG_INVALID', '媒体任务缺少根目录或 workRelpath', { taskId: identity.taskId }, 409);
  const root = await realpath(identity.rootDirectory);
  const work = await realpath(path.resolve(root, ...identity.workRelpath.split('/')));
  assertInside(root, work, 'WB 任务目录');
  const filePath = await realpath(path.resolve(work, ...relativePath.split('/')));
  assertInside(work, filePath, 'WB 媒体文件');
  const file = await stat(filePath);
  if (!file.isFile()) throw new AppError('SOURCE_FILE_MISSING', 'WB 媒体路径不是文件', { relativePath }, 409);
  if (file.size > 512 * 1024 * 1024) throw new AppError('CONFIG_INVALID', 'WB 媒体文件超过 512 MiB 网关限制', { relativePath, sizeBytes: file.size }, 413);
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new AppError('VERIFY_FAILED', 'WB 媒体文件 SHA-256 与任务清单不一致', { relativePath }, 409);
  }
  const manifestRelativePath = media.sourceRelativePath || relativePath;
  const manifestSha256 = media.sourceSha256 || expectedSha256;
  if (media.sourceRelativePath) {
    const sourcePath = await realpath(path.resolve(work, ...media.sourceRelativePath.split('/')));
    assertInside(work, sourcePath, 'WB 原始媒体文件');
    const source = await stat(sourcePath);
    if (!source.isFile() || await sha256File(sourcePath) !== media.sourceSha256) {
      throw new AppError('VERIFY_FAILED', 'WB 转码源文件与 manifest SHA-256 不一致', { relativePath: media.sourceRelativePath }, 409);
    }
  }
  const runtimeMatch = manifestContains(identity.runtimeResult, manifestRelativePath, manifestSha256);
  const diskMatch = await diskManifestContains(work, manifestRelativePath, manifestSha256);
  if (!runtimeMatch && !diskMatch) {
    throw new AppError('VERIFY_FAILED', 'WB 媒体文件未在任务 manifest 中登记，拒绝上传', { relativePath }, 409);
  }
  return { filePath };
}

function mediaMimeType(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime'
  };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new AppError('CONFIG_INVALID', 'MEDIA_UPLOAD_FILE 文件扩展名不受支持', { extension });
  return mimeType;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function diskManifestContains(workDirectory: string, relativePath: string, sha256: string): Promise<boolean> {
  const candidates = [
    path.join(workDirectory, 'variants', 'variant-media-manifest.json'),
    path.join(workDirectory, 'variant-media-manifest.json'),
    path.join(workDirectory, 'product.json')
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile() || info.size > 10 * 1024 * 1024) continue;
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
      if (manifestContains(parsed, relativePath, sha256)) return true;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return false;
}

function manifestContains(value: unknown, relativePath: string, sha256: string, depth = 0): boolean {
  if (depth > 20 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => manifestContains(item, relativePath, sha256, depth + 1));
  if (typeof value !== 'object') return false;
  const record = value as JsonRecord;
  const recordedPath = String(record.relativePath ?? record.relative_path ?? record.path ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  const recordedSha = String(record.sha256 ?? record.sha_256 ?? '').trim().toLowerCase();
  if (recordedPath === relativePath && recordedSha === sha256) return true;
  return Object.values(record).some((child) => manifestContains(child, relativePath, sha256, depth + 1));
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', `${label}逃逸允许根目录`, undefined, 409);
  }
}

function safeRelativePath(value: unknown): string {
  const result = String(value || '').trim();
  if (!result || result.includes('\\') || path.posix.isAbsolute(result) || result.split('/').includes('..')) {
    throw new AppError('INVALID_RELATIVE_PATH', '媒体路径必须是安全的 POSIX 相对路径');
  }
  return result;
}

function requiredWarehouse(identity: WbGatewayIdentity): string {
  if (!identity.warehouseId) throw new AppError('CONFIG_INVALID', '店铺快照缺少 warehouseId', { storeId: identity.storeId }, 409);
  return encodeURIComponent(identity.warehouseId);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new AppError('CONFIG_INVALID', `${field} 必须是正整数`);
  return parsed;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new AppError('CONFIG_INVALID', `整数参数必须在 ${min} 到 ${max} 之间`);
  return parsed;
}

function classifyResponse(status: number, write: boolean): { deliveryState: WbGatewayDeliveryState; retryClass: WbGatewayRetryClass } {
  if (status >= 200 && status < 300) return { deliveryState: 'RESPONDED', retryClass: 'NONE' };
  if (write && (status === 408 || status === 425 || status >= 500)) return { deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' };
  if (status === 408 || status === 425 || status === 429 || status >= 500) return { deliveryState: 'RESPONDED', retryClass: 'RETRYABLE' };
  return { deliveryState: 'RESPONDED', retryClass: 'PERMANENT' };
}

function classifyTransportFailure(error: unknown, write: boolean): { deliveryState: WbGatewayDeliveryState; retryClass: WbGatewayRetryClass } {
  const code = transportFailureDetails(error, 'REQUEST').code;
  const definitelyNotSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
  if (!write || definitelyNotSent) return { deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE' };
  return { deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' };
}

function classifyResponseBodyFailure(write: boolean): { deliveryState: WbGatewayDeliveryState; retryClass: WbGatewayRetryClass } {
  return write
    ? { deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' }
    : { deliveryState: 'RESPONDED', retryClass: 'RETRYABLE' };
}

function transportFailureDetails(error: unknown, fallbackPhase: TransportPhase): { code: string; phase: TransportPhase } {
  let current = error;
  let code = '';
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as JsonRecord;
    if (!code && (typeof record.code === 'string' || typeof record.code === 'number')) code = String(record.code).toUpperCase();
    current = record.cause;
  }
  if (!code && error instanceof DOMException && error.name === 'TimeoutError') code = 'ABORT_TIMEOUT';
  if (!code && error instanceof Error && error.name) code = error.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 128);
  if (!code) code = 'UNKNOWN_TRANSPORT_ERROR';
  const phase: TransportPhase = fallbackPhase === 'RESPONSE_BODY' ? 'RESPONSE_BODY'
    : ['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'DNS'
      : ['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) ? 'CONNECT'
        : code === 'UND_ERR_HEADERS_TIMEOUT' ? 'RESPONSE_HEADERS'
          : code === 'UND_ERR_BODY_TIMEOUT' ? 'RESPONSE_BODY'
            : ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ABORT_TIMEOUT'].includes(code) ? 'REQUEST'
              : fallbackPhase;
  return { code: code.slice(0, 128), phase };
}

function responseFromLedger(row: JsonRecord, requestRef: string): WbGatewayResponse {
  if (!row.completed_at) {
    return {
      ok: false,
      statusCode: Number(row.status_code || 0),
      body: { error: 'WB_GATEWAY_REQUEST_IN_FLIGHT', message: '同一 requestRef 已存在但结果尚未确定，必须先回读' },
      deliveryState: 'UNKNOWN',
      retryClass: 'READBACK_REQUIRED',
      requestRef,
      idempotent: true
    };
  }
  const statusCode = Number(row.status_code || 0);
  return {
    ok: statusCode >= 200 && statusCode < 300,
    statusCode,
    body: redactSecrets(row.response_json),
    deliveryState: row.delivery_state as WbGatewayDeliveryState,
    retryClass: row.retry_class as WbGatewayRetryClass,
    ...(Number.isFinite(Number(row.retry_after_ms)) && Number(row.retry_after_ms) >= 0 ? { retryAfterMs: Number(row.retry_after_ms) } : {}),
    requestRef,
    idempotent: true
  };
}

async function safeResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  if (text.length > 2_000_000) return { truncated: true, rawText: text.slice(0, 2_000_000) };
  try { return JSON.parse(text); }
  catch { return { rawText: text.slice(0, 200_000) }; }
}

function retryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function assertNoSecrets(value: unknown, pathParts: string[] = []): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, [...pathParts, String(index)]));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (/authorization|token|cookie|secret|api[-_]?key/i.test(key)) {
      throw new AppError('CONFIG_INVALID', 'WB 网关 payload 禁止携带凭据或授权字段', { field: [...pathParts, key].join('.') });
    }
    assertNoSecrets(child, [...pathParts, key]);
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === 'string') {
    return value
      .replace(/(authorization|token|api[-_]?key)\s*[:=]\s*["']?(?:Bearer\s+)?[^\s,"'}]+/gi, '$1=[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, child]) => [
    key,
    /authorization|token|cookie|secret|api[-_]?key/i.test(key) ? '[REDACTED]' : redactSecrets(child)
  ]));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
