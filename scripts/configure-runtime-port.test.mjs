import test from 'node:test';
import assert from 'node:assert/strict';
import { updateEnvContent, updateN8nContent } from './configure-runtime-port.mjs';

test('端口配置原子改写契约保留其他密钥且幂等', () => {
  const secret = 'do-not-log-this-secret';
  const before = `MERCHROUTE_RUNTIME_KEY=${secret}\nPORT=4173\n`;
  const values = { HOST: '127.0.0.1', PORT: '43173', MERCHROUTE_PORT: '43173', MERCHROUTE_RUNTIME_BASE_URL: 'http://127.0.0.1:43173' };
  const once = updateEnvContent(before, values);
  assert.match(once, new RegExp(`MERCHROUTE_RUNTIME_KEY=${secret}`));
  assert.equal(updateEnvContent(once, values), once);
  assert.equal((once.match(/^PORT=/gm) || []).length, 1);
});

test('n8n env 与 BAT 只更新 Runtime Base URL', () => {
  const origin = 'http://127.0.0.1:43173';
  const env = updateN8nContent('TOKEN=private\nMERCHROUTE_RUNTIME_BASE_URL=http://127.0.0.1:4173\n', origin, 'n8n.env');
  assert.equal(env, `TOKEN=private\nMERCHROUTE_RUNTIME_BASE_URL=${origin}\n`);
  const bat = updateN8nContent('@echo off\r\nset "MERCHROUTE_RUNTIME_BASE_URL=http://127.0.0.1:4173"\r\nn8n\r\n', origin, '启动n8n.bat');
  assert.equal(bat, `@echo off\r\nset "MERCHROUTE_RUNTIME_BASE_URL=${origin}"\r\nn8n\r\n`);
});
