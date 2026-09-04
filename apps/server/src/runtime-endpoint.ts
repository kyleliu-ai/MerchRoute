export const DEFAULT_MERCHROUTE_PORT = 43173;
export const MERCHROUTE_RUNTIME_HOST = '127.0.0.1' as const;
export const RESERVED_MERCHROUTE_PORTS = [4183, 4184, 5173, 5432, 5678, 8000] as const;

export type RuntimeEndpoint = {
  host: typeof MERCHROUTE_RUNTIME_HOST;
  port: number;
  origin: string;
};

export function resolveRuntimeEndpoint(env: NodeJS.ProcessEnv): RuntimeEndpoint {
  const raw = String(env.MERCHROUTE_PORT || env.PORT || DEFAULT_MERCHROUTE_PORT).trim();
  if (!/^\d+$/.test(raw)) throw new Error('MERCHROUTE_PORT 必须是 1024–49151 的整数');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 49151) throw new Error('MERCHROUTE_PORT 必须是 1024–49151 的整数');
  if ((RESERVED_MERCHROUTE_PORTS as readonly number[]).includes(port)) throw new Error(`MERCHROUTE_PORT=${port} 与 MerchRoute 依赖或隔离端口冲突`);
  const host = String(env.HOST || MERCHROUTE_RUNTIME_HOST).trim();
  if (host !== MERCHROUTE_RUNTIME_HOST) throw new Error('MerchRoute 正式服务只允许绑定 127.0.0.1');
  const origin = `http://${MERCHROUTE_RUNTIME_HOST}:${port}`;
  const configuredOrigin = String(env.MERCHROUTE_RUNTIME_BASE_URL || '').trim().replace(/\/$/, '');
  if (configuredOrigin && configuredOrigin !== origin) throw new Error(`MERCHROUTE_RUNTIME_BASE_URL 必须与端口一致；期望 ${origin}`);
  return { host: MERCHROUTE_RUNTIME_HOST, port, origin };
}
