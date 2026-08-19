type JsonRecord = Record<string, unknown>;

const ARRAY_SHAPES = new Set(['ITEMS', 'RESULT_ITEMS', 'RESULT_ARRAY']);

/**
 * Accepts only the two read-only response combinations that conclusively prove
 * an Offer is absent for PRE_PLAN recovery.  OZON returns the second form for
 * a missing product: infoList is an empty 200 response while attributesInfo is
 * the exact 404/code-5 `item not found` contract normalized by the gateway.
 */
export function validOzonPrePlanAbsenceOperations(input: unknown): boolean {
  if (!Array.isArray(input) || input.length !== 2) return false;
  const operations = input.map(asRecord);
  const info = operations.find((operation) => operation.operation === 'infoList');
  const attributes = operations.find((operation) => operation.operation === 'attributesInfo');
  if (!info || !attributes || new Set(operations.map((operation) => operation.operation)).size !== 2) return false;
  if (info.endpoint !== '/v3/product/info/list'
    || Number(info.statusCode) !== 200
    || !ARRAY_SHAPES.has(String(info.responseShape || ''))
    || Number(info.itemCount) !== 0
    || info.paginationComplete !== true
    || info.errorCode !== undefined) return false;

  const attributesEmpty200 = attributes.endpoint === '/v4/product/info/attributes'
    && Number(attributes.statusCode) === 200
    && ARRAY_SHAPES.has(String(attributes.responseShape || ''))
    && Number(attributes.itemCount) === 0
    && attributes.paginationComplete === true
    && attributes.errorCode === undefined;
  const attributesNotFound = attributes.endpoint === '/v4/product/info/attributes'
    && Number(attributes.statusCode) === 404
    && attributes.responseShape === 'NOT_FOUND_ERROR'
    && Number(attributes.itemCount) === 0
    && attributes.paginationComplete === true
    && String(attributes.errorCode || '') === '5';
  return attributesEmpty200 || attributesNotFound;
}

function asRecord(input: unknown): JsonRecord {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
}
