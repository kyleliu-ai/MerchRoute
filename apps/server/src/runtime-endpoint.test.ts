import { describe, expect, it } from 'vitest';
import { resolveRuntimeEndpoint } from './runtime-endpoint.js';

describe('runtime endpoint', () => {
  it('使用 43173 默认值并支持 MERCHROUTE_PORT 优先覆盖', () => {
    expect(resolveRuntimeEndpoint({})).toEqual({ host: '127.0.0.1', port: 43173, origin: 'http://127.0.0.1:43173' });
    expect(resolveRuntimeEndpoint({ MERCHROUTE_PORT: '18080', PORT: '28080' }).port).toBe(18080);
  });

  it('拒绝保留端口、非回环和 URL 不一致', () => {
    expect(() => resolveRuntimeEndpoint({ MERCHROUTE_PORT: '5678' })).toThrow();
    expect(() => resolveRuntimeEndpoint({ MERCHROUTE_PORT: '43173', HOST: '0.0.0.0' })).toThrow();
    expect(() => resolveRuntimeEndpoint({ MERCHROUTE_PORT: '43173', MERCHROUTE_RUNTIME_BASE_URL: 'http://127.0.0.1:4173' })).toThrow();
  });
});
