import { z } from 'zod';

export const OZON_DUPLICATE_PRODUCT_CARD_ERROR_CODE = 'SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT' as const;

export type OzonImportFailureClassification = 'NONE' | 'TRANSIENT' | 'DUPLICATE_PRODUCT_CARD' | 'PERMANENT';
export type OzonPublishRetryBlockerCode = 'OZON_DUPLICATE_PRODUCT_CARD' | 'OZON_IMPORT_PERMANENT_FAILURE';
export type OzonPublishRetryBlockedOffer = {
  offerId: string;
  errorCodes: string[];
  platformMessage: string;
  conflictOfferIds: string[];
};

const ozonTransientErrorCode = /^(?:ECONNABORTED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|OZON_RESPONSE_MISSING|OZON_RESPONSE_DUPLICATE|OZON_REQUEST_TIMEOUT|OZON_RATE_LIMITED|TOO_MANY_REQUESTS|INTERNAL_ERROR|INTERNAL_SERVER_ERROR|SERVICE_UNAVAILABLE|NOT_FOUND|PRODUCT_NOT_FOUND|PRODUCT_NOT_READY|PRODUCT_NOT_CREATED|PRODUCT_IS_NOT_CREATED|PRODUCT_HAS_NOT_BEEN_TAGGED_YET|NOT_PASS_MODERATION|OFFER_NOT_FOUND|HTTP_429|HTTP_5\d\d)$/i;

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};
const stringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function ozonErrorsAreTransient(errors: unknown): boolean {
  return Array.isArray(errors) && errors.length > 0 && errors.every((candidate) => {
    const error = objectValue(candidate);
    return ozonTransientErrorCode.test(stringValue(error.code ?? error.errorCode));
  });
}

export function classifyOzonImportFailures(payloadInput: unknown): {
  classification: OzonImportFailureClassification;
  blockerCode?: OzonPublishRetryBlockerCode;
  blockedOffers: OzonPublishRetryBlockedOffer[];
} {
  const failures = objectValue(payloadInput).importFailures;
  if (!Array.isArray(failures) || failures.length === 0) return { classification: 'NONE', blockedOffers: [] };
  const blockedOffers = failures.flatMap((candidate): OzonPublishRetryBlockedOffer[] => {
    const failure = objectValue(candidate);
    const errors = Array.isArray(failure.errors) ? failure.errors.map(objectValue) : [];
    if (ozonErrorsAreTransient(errors)) return [];
    const offerId = stringValue(failure.offer_id ?? failure.offerId);
    const errorCodes = [...new Set(errors.map((error) => stringValue(error.code ?? error.errorCode)).filter(Boolean))];
    const platformMessage = errors.map((error) => stringValue(error.message ?? error.description)).filter(Boolean).join('；');
    const conflictOfferIds = [...new Set([...platformMessage.matchAll(/\b\d{6,}-\d{2}\b/g)]
      .map((match) => match[0]!)
      .filter((candidateOfferId) => candidateOfferId !== offerId))];
    return [{ offerId, errorCodes: errorCodes.length ? errorCodes : ['OZON_IMPORT_FAILED'], platformMessage, conflictOfferIds }];
  });
  if (!blockedOffers.length) return { classification: 'TRANSIENT', blockedOffers: [] };
  const duplicate = blockedOffers.some((offer) => offer.errorCodes.includes(OZON_DUPLICATE_PRODUCT_CARD_ERROR_CODE));
  if (duplicate) return { classification: 'DUPLICATE_PRODUCT_CARD', blockerCode: 'OZON_DUPLICATE_PRODUCT_CARD', blockedOffers };
  const explicitPermanent = blockedOffers.some((offer) => offer.errorCodes.some((code) => code !== 'OZON_IMPORT_FAILED'));
  return {
    classification: 'PERMANENT',
    ...(explicitPermanent ? { blockerCode: 'OZON_IMPORT_PERMANENT_FAILURE' as const } : {}),
    blockedOffers
  };
}

export const ozonPublishRetryRequestSchema = z.object({
  storeId: z.string().uuid(),
  requestId: z.string().uuid(),
  planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  confirmRebuild: z.boolean().default(false)
}).strict();
export type OzonPublishRetryRequest = z.infer<typeof ozonPublishRetryRequestSchema>;
export type OzonPublishRetryMode = 'RESUME' | 'READBACK' | 'REBUILD';
export type OzonPublishRetryStatus = 'CHECKING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export type OzonPublishRetryRecord = {
  id: string; requestId: string; sourceJobId: string; effectiveJobId?: string;
  storeId: string; sku: string; status: OzonPublishRetryStatus; mode: OzonPublishRetryMode;
  stage: string; message: string; previousError: string; errorCode: string;
  createdAt: string; updatedAt: string;
};
export type OzonPublishRetryPlan = {
  canRetry: boolean; blockedReason?: string; planHash: string;
  blockerCode?: OzonPublishRetryBlockerCode;
  blockedOffers?: OzonPublishRetryBlockedOffer[];
  sourceJobId: string; storeId: string; sku: string; storeName: string;
  mode: OzonPublishRetryMode; stage: string; requiresConfirmation: boolean;
  previousError: string; offerIds: string[];
  changes: Array<{ label: string; previous: string; current: string }>;
  latest?: OzonPublishRetryRecord;
};
export const OZON_RETRY_EXPLANATION = '核对当前店铺原任务及 OZON 实际结果，继续未完成的上品步骤；需要重建资料时会先确认。';
