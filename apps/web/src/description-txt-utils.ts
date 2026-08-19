const MAX_DESCRIPTION_BYTES = 64 * 1024;

export function decodeDescriptionTxt(
  fileName: string,
  buffer: ArrayBuffer,
  options: { maxLength: number; fieldLabel: string }
): string {
  if (!fileName.toLocaleLowerCase().endsWith('.txt')) throw new Error('只允许导入 .txt 文件');
  if (buffer.byteLength > MAX_DESCRIPTION_BYTES) throw new Error('TXT 文件不能超过 64 KiB');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('文件不是有效的 UTF-8 文本'); }
  text = text.replace(/^\uFEFF/, '');
  if ([...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  })) {
    throw new Error('文件包含不允许的二进制控制字符');
  }
  const normalized = text
    .trim()
    .replace(/\\r\\n|\\r|\\n/g, '\n')
    .replace(/\r\n?|\n/g, '\n')
    .replace(/[ \t]*\n+[ \t]*/g, '\n\n');
  if (!normalized) throw new Error('TXT 文件内容为空');
  if (normalized.length > options.maxLength) {
    throw new Error(`${options.fieldLabel}不能超过 ${options.maxLength} 个字符`);
  }
  return normalized;
}
