import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromApiRelativePath, isPathInside, toApiRelativePath } from './paths.js';

describe('safe path helpers', () => {
  it('round-trips API relative paths using the current platform separator', () => {
    const local = fromApiRelativePath('scenePrompt01/image_02.png');
    expect(toApiRelativePath(local)).toBe('scenePrompt01/image_02.png');
  });

  it('blocks traversal and absolute paths', () => {
    expect(() => fromApiRelativePath('../secret.png')).toThrow(/越过产品目录/);
    expect(() => fromApiRelativePath(path.resolve('secret.png'))).toThrow(/相对路径/);
  });

  it('recognizes children but not siblings', () => {
    const root = path.resolve('fixtures', 'product');
    expect(isPathInside(root, path.join(root, 'images', 'a.png'))).toBe(true);
    expect(isPathInside(root, path.resolve(root, '..', 'other', 'a.png'))).toBe(false);
  });
});
