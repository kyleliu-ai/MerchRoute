import { describe, expect, it } from 'vitest';
import {
  appendSelectedRelativePaths,
  moveSelectedRelativePath,
  toggleSelectedRelativePath,
  uniqueSelectedRelativePaths
} from './App';

describe('E003 selected media order', () => {
  it('preserves the submitted order while removing duplicate paths', () => {
    expect(uniqueSelectedRelativePaths(['07.png', '01.png', '04.png', '01.png'])).toEqual([
      '07.png',
      '01.png',
      '04.png'
    ]);
  });

  it('appends new selections and appends an item again after it was removed', () => {
    const selected = appendSelectedRelativePaths(['07.png'], ['01.png', '04.png', '01.png']);
    const removed = toggleSelectedRelativePath(selected, '01.png');

    expect(selected).toEqual(['07.png', '01.png', '04.png']);
    expect(removed).toEqual(['07.png', '04.png']);
    expect(toggleSelectedRelativePath(removed, '01.png')).toEqual(['07.png', '04.png', '01.png']);
  });

  it('moves an item to the requested position without mutating the source array', () => {
    const selected = ['07.png', '01.png', '04.png'];

    expect(moveSelectedRelativePath(selected, '04.png', 0)).toEqual(['04.png', '07.png', '01.png']);
    expect(moveSelectedRelativePath(selected, '07.png', 2)).toEqual(['01.png', '04.png', '07.png']);
    expect(moveSelectedRelativePath(selected, 'missing.png', 0)).toEqual(selected);
    expect(selected).toEqual(['07.png', '01.png', '04.png']);
  });
});
