import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import {
  applyOzonGrossWeightToDimensions,
  readOzonGrossWeightResolution,
  resolveOzonGrossWeight
} from './ozon-gross-weight.js';

const capturedAt = '2026-08-07T02:00:00.000Z';
const procurement = (grossWeightGrams: unknown) => ({
  id: randomUUID(),
  versionNo: 7,
  grossWeightGrams
});
const presetDimensions = {
  length: 30,
  width: 20,
  height: 10,
  dimensionUnit: 'cm' as const,
  weight: 800,
  weightUnit: 'g' as const
};

describe('OZON gross-weight resolution', () => {
  it('uses a positive decimal procurement gross weight and records both sources', () => {
    const source = procurement('650.5');
    expect(resolveOzonGrossWeight(source, presetDimensions, capturedAt)).toEqual({
      source: 'PROCUREMENT',
      effectiveGrossWeightGrams: 650.5,
      procurementGrossWeightGrams: 650.5,
      presetGrossWeightGrams: 800,
      procurementVersionId: source.id,
      procurementVersionNo: 7,
      procurementCapturedAt: capturedAt
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['zero string', '0'],
    ['zero number', 0],
    ['negative string', '-0.1'],
    ['negative number', -1],
    ['non-numeric', 'invalid'],
    ['NaN', Number.NaN]
  ])('falls back to preset gross weight for %s procurement input', (_label, grossWeightGrams) => {
    const source = procurement(grossWeightGrams);
    expect(resolveOzonGrossWeight(source, presetDimensions, capturedAt)).toEqual({
      source: 'PRESET_FALLBACK',
      effectiveGrossWeightGrams: 800,
      procurementGrossWeightGrams: null,
      presetGrossWeightGrams: 800,
      procurementVersionId: source.id,
      procurementVersionNo: 7,
      procurementCapturedAt: capturedAt
    });
  });

  it.each([
    ['g', 750, 750],
    ['kg', 0.8, 800],
    ['lb', 2, 907.18474]
  ] as const)('converts preset %s weight to grams', (weightUnit, weight, expectedGrams) => {
    const resolution = resolveOzonGrossWeight(procurement(null), {
      ...presetDimensions,
      weight,
      weightUnit
    }, capturedAt);
    expect(resolution.presetGrossWeightGrams).toBeCloseTo(expectedGrams, 8);
    expect(resolution.effectiveGrossWeightGrams).toBeCloseTo(expectedGrams, 8);
  });

  it('keeps preset dimensions and dimension unit while replacing only weight in grams', () => {
    const resolution = resolveOzonGrossWeight(procurement('650.5'), {
      length: 12,
      width: 8,
      height: 4,
      dimensionUnit: 'in',
      weight: 2,
      weightUnit: 'lb'
    }, capturedAt);
    expect(applyOzonGrossWeightToDimensions({
      length: 12,
      width: 8,
      height: 4,
      dimensionUnit: 'in',
      weight: 2,
      weightUnit: 'lb'
    }, resolution)).toEqual({
      length: 12,
      width: 8,
      height: 4,
      dimensionUnit: 'in',
      weight: 650.5,
      weightUnit: 'g'
    });
  });

  it('reads direct and nested audit snapshots while preserving historical absence', () => {
    const resolution = resolveOzonGrossWeight(procurement('650.5'), presetDimensions, capturedAt);
    expect(readOzonGrossWeightResolution(undefined)).toBeUndefined();
    expect(readOzonGrossWeightResolution({ status: 'COMPLETE', issues: [] })).toBeUndefined();
    expect(readOzonGrossWeightResolution(resolution)).toEqual(resolution);
    expect(readOzonGrossWeightResolution({ grossWeightResolution: resolution })).toEqual(resolution);
  });

  it('rejects present malformed or semantically contradictory audit snapshots', () => {
    const resolution = resolveOzonGrossWeight(procurement('650.5'), presetDimensions, capturedAt);
    for (const input of [
      null,
      {},
      { grossWeightResolution: null },
      { grossWeightResolution: { ...resolution, effectiveGrossWeightGrams: 649 } },
      { ...resolution, source: 'PRESET_FALLBACK' }
    ]) {
      try {
        readOzonGrossWeightResolution(input);
        throw new Error('expected invalid resolution');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
      }
    }
  });
});
