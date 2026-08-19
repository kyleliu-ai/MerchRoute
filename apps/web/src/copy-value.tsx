import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { Button, Tooltip, message } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';

const COPY_EVENT = 'pixroute:value-copied';

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    let permissionTimer: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        permissionTimer = window.setTimeout(() => reject(new Error('Clipboard permission timed out')), 900);
        navigator.clipboard.writeText(value).then(resolve, reject);
      });
      return;
    } catch {
      // Continue with the DOM fallback when browser permissions block the modern API.
    } finally {
      window.clearTimeout(permissionTimer);
    }
  }

  const textarea = document.createElement('textarea');
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  activeElement?.focus();
  if (!copied) throw new Error('Clipboard copy failed');
}

export function CopyValueButton({ value, label, inverse = false }: { value: string; label: string; inverse?: boolean }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number>();

  useEffect(() => {
    const resetOtherButtons = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) return;
      window.clearTimeout(resetTimer.current);
      setCopied(false);
    };
    window.addEventListener(COPY_EVENT, resetOtherButtons);
    return () => {
      window.removeEventListener(COPY_EVENT, resetOtherButtons);
      window.clearTimeout(resetTimer.current);
    };
  }, [id]);

  if (!value.trim()) return null;

  const copy = async (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    try {
      await writeClipboard(value);
      window.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: id }));
      window.clearTimeout(resetTimer.current);
      setCopied(true);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      message.error('复制失败，请选中文本手动复制');
    }
  };

  return <Tooltip title={copied ? `已复制：${value}` : `复制${label}`}>
    <Button
      type="text"
      size="small"
      className={`copy-value-button ${inverse ? 'is-inverse' : ''} ${copied ? 'is-copied' : ''}`}
      icon={copied ? <CheckOutlined /> : <CopyOutlined />}
      aria-label={copied ? `${label} 已复制：${value}` : `复制${label}：${value}`}
      onClick={copy}
    />
  </Tooltip>;
}
