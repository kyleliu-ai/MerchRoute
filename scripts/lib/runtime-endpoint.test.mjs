import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MERCHROUTE_PORT, createRuntimeEndpoint, runtimeEndpointFromEnvironment,
  runtimeEndpointFromBinding, parseWindowsExcludedPortRanges, preflightRuntimeEndpoint
} from './runtime-endpoint.mjs';
import { productionEnvironment } from '../release-runtime.mjs';

test('默认正式端口为 43173，并允许合法显式覆盖', () => {
  assert.equal(DEFAULT_MERCHROUTE_PORT, 43173);
  assert.deepEqual(runtimeEndpointFromEnvironment({}), { host: '127.0.0.1', port: 43173, origin: 'http://127.0.0.1:43173' });
  assert.equal(runtimeEndpointFromEnvironment({ MERCHROUTE_PORT: '18080', PORT: '28080' }).port, 18080);
  assert.equal(runtimeEndpointFromEnvironment({ PORT: '28080' }).port, 28080);
});

test('拒绝非回环、非法范围、保留端口和 Base URL 不一致', () => {
  assert.throws(() => createRuntimeEndpoint(43173, '0.0.0.0'), /只允许/);
  for (const port of [0, 1023, 49152, 65535, '12x', 4183, 4184, 5173, 5432, 5678, 8000]) {
    assert.throws(() => createRuntimeEndpoint(port));
  }
  assert.throws(() => runtimeEndpointFromEnvironment({ MERCHROUTE_PORT: '43173', MERCHROUTE_RUNTIME_BASE_URL: 'http://127.0.0.1:4173' }), /必须与端口一致/);
});

test('发布绑定必须是 schema v2；v1 仅限 legacy 回滚推断 4173', () => {
  const v2 = { schemaVersion: 2, runtimeEndpoint: { host: '127.0.0.1', port: 43173, origin: 'http://127.0.0.1:43173' } };
  assert.equal(runtimeEndpointFromBinding(v2).port, 43173);
  assert.throws(() => runtimeEndpointFromBinding({ schemaVersion: 1 }), /schema v2/);
  assert.equal(runtimeEndpointFromBinding({ schemaVersion: 1, legacy: true }, { allowLegacy: true }).port, 4173);
  assert.deepEqual(Object.fromEntries(Object.entries(productionEnvironment(v2, {})).filter(([key]) => ['HOST','PORT','MERCHROUTE_PORT','MERCHROUTE_RUNTIME_BASE_URL'].includes(key))), {
    HOST: '127.0.0.1', PORT: '43173', MERCHROUTE_PORT: '43173', MERCHROUTE_RUNTIME_BASE_URL: 'http://127.0.0.1:43173'
  });
});

test('Windows 排除区间解析并在真实绑定前失败', async () => {
  assert.deepEqual(parseWindowsExcludedPortRanges('  4120  4219\r\n  50000  50059 *'), [
    { start: 4120, end: 4219, administered: false },
    { start: 50000, end: 50059, administered: true }
  ]);
  let bound = false;
  await assert.rejects(preflightRuntimeEndpoint(createRuntimeEndpoint(4173), {
    platform: 'win32', listeningPids: [], excludedRangesOutput: '  4120  4219', bindTest: async () => { bound = true; }
  }), /4120-4219/);
  assert.equal(bound, false);
});

test('端口被占用时不自动漂移', async () => {
  await assert.rejects(preflightRuntimeEndpoint(createRuntimeEndpoint(43173), {
    platform: 'darwin', listeningPids: [321, 321]
  }), /43173.*PID 321/);
  await assert.rejects(preflightRuntimeEndpoint(createRuntimeEndpoint(43173), {
    platform: 'darwin', listeningPids: [], bindTest: async () => { throw new Error('端口 43173 无法独占绑定：EADDRINUSE'); }
  }), /43173.*EADDRINUSE/);
});
