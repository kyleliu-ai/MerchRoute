import { describe, expect, it } from 'vitest';
import { validOzonPrePlanAbsenceOperations } from './ozon-preplan-absence.js';

const infoEmpty = {
  operation: 'infoList', endpoint: '/v3/product/info/list', statusCode: 200,
  responseShape: 'ITEMS', itemCount: 0, paginationComplete: true
};
const attributesEmpty = {
  operation: 'attributesInfo', endpoint: '/v4/product/info/attributes', statusCode: 200,
  responseShape: 'RESULT_ITEMS', itemCount: 0, paginationComplete: true
};
const attributesNotFound = {
  operation: 'attributesInfo', endpoint: '/v4/product/info/attributes', statusCode: 404,
  responseShape: 'NOT_FOUND_ERROR', itemCount: 0, paginationComplete: true, errorCode: '5'
};

describe('validOzonPrePlanAbsenceOperations', () => {
  it('accepts both exact empty contracts', () => {
    expect(validOzonPrePlanAbsenceOperations([infoEmpty, attributesEmpty])).toBe(true);
    expect(validOzonPrePlanAbsenceOperations([infoEmpty, attributesNotFound])).toBe(true);
  });

  it.each([
    [infoEmpty],
    [infoEmpty, { ...attributesNotFound, errorCode: '6' }],
    [infoEmpty, { ...attributesNotFound, responseShape: 'RESULT_ITEMS' }],
    [infoEmpty, { ...attributesNotFound, endpoint: '/v4/product/info/other' }],
    [{ ...infoEmpty, statusCode: 404 }, attributesNotFound],
    [infoEmpty, infoEmpty]
  ])('rejects any ambiguous or incomplete operation set: %j', (operations) => {
    expect(validOzonPrePlanAbsenceOperations(operations)).toBe(false);
  });
});
