import { describe, expect, it } from 'vitest';
import { decodeDescriptionTxt } from './description-txt-utils';

const bytes = (value: string) => new TextEncoder().encode(value).buffer;
const decodeOzon = (fileName: string, buffer: ArrayBuffer) => decodeDescriptionTxt(fileName, buffer, {
  maxLength: 6_000,
  fieldLabel: '俄文商品详情'
});

describe('decodeDescriptionTxt for OZON', () => {
  it('accepts UTF-8 BOM, Russian text and case-insensitive TXT extensions', () => {
    expect(decodeOzon('俄文详情.TXT', bytes('\uFEFFПервый абзац'))).toBe('Первый абзац');
  });

  it('normalizes real and literal paragraph separators', () => {
    expect(decodeOzon('detail.txt', bytes('A\r\n\r\nB\nC'))).toBe('A\n\nB\n\nC');
    expect(decodeOzon('detail.txt', bytes('A\\r\\n\\r\\nB'))).toBe('A\n\nB');
  });

  it('rejects non-txt, invalid UTF-8, binary controls and empty content', () => {
    expect(() => decodeOzon('detail.md', bytes('A'))).toThrow('只允许导入 .txt 文件');
    expect(() => decodeOzon('detail.txt', new Uint8Array([0xff]).buffer)).toThrow('文件不是有效的 UTF-8 文本');
    expect(() => decodeOzon('detail.txt', bytes(`A${String.fromCharCode(0)}B`))).toThrow('二进制控制字符');
    expect(() => decodeOzon('detail.txt', bytes(' \r\n '))).toThrow('内容为空');
  });

  it('enforces the 64 KiB file limit and the OZON 6000-character limit', () => {
    expect(() => decodeOzon('detail.txt', new Uint8Array(64 * 1024 + 1).buffer)).toThrow('64 KiB');
    expect(decodeOzon('detail.txt', bytes('Я'.repeat(6_000)))).toHaveLength(6_000);
    expect(() => decodeOzon('detail.txt', bytes('Я'.repeat(6_001)))).toThrow('俄文商品详情不能超过 6000 个字符');
  });
});
