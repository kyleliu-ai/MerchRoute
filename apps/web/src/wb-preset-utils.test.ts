import { describe, expect, it } from 'vitest';
import { calculateWbDiscountAudit, decodeWbDescriptionTxt } from './wb-preset-utils';

const bytes = (value: string) => new TextEncoder().encode(value).buffer;

describe('decodeWbDescriptionTxt', () => {
  it('accepts UTF-8 with BOM and normalizes real or literal paragraph separators', () => {
    expect(decodeWbDescriptionTxt('detail.TXT', bytes('\uFEFFA\r\n\r\nB'))).toBe('A\n\nB');
    expect(decodeWbDescriptionTxt('detail.txt', bytes('A\\n\\nB'))).toBe('A\n\nB');
  });

  it('rejects non txt, invalid UTF-8 and binary control characters', () => {
    expect(() => decodeWbDescriptionTxt('detail.md', bytes('A'))).toThrow('只允许导入 .txt 文件');
    expect(() => decodeWbDescriptionTxt('detail.txt', new Uint8Array([0xff]).buffer)).toThrow('文件不是有效的 UTF-8 文本');
    expect(() => decodeWbDescriptionTxt('detail.txt', bytes(`A${String.fromCharCode(0)}B`))).toThrow('二进制控制字符');
  });

  it('rejects an empty or oversized document', () => {
    expect(() => decodeWbDescriptionTxt('detail.txt', bytes('  '))).toThrow('内容为空');
    expect(() => decodeWbDescriptionTxt('detail.txt', new Uint8Array(64 * 1024 + 1).buffer)).toThrow('64 KiB');
  });
});

describe('calculateWbDiscountAudit', () => {
  it('uses the editable merchant discount and reports the CNY difference', () => {
    expect(calculateWbDiscountAudit(395.86, 50, 197.93)).toEqual({ estimatedDiscountedPriceCny: 197.93, differenceCny: 0, mismatch: false });
    expect(calculateWbDiscountAudit(395.86, 49, 197.93)).toEqual({ estimatedDiscountedPriceCny: 201.89, differenceCny: 3.96, mismatch: true });
  });

  it('treats an exact 0.01 CNY difference as a mismatch, matching the server', () => {
    expect(calculateWbDiscountAudit(100, 0, 99.99)).toEqual({ estimatedDiscountedPriceCny: 100, differenceCny: 0.01, mismatch: true });
    expect(calculateWbDiscountAudit(99.99, 0, 100)).toEqual({ estimatedDiscountedPriceCny: 99.99, differenceCny: -0.01, mismatch: true });
  });
});
