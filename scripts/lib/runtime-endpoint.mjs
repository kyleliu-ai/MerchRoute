import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';

export const DEFAULT_MERCHROUTE_PORT = 43173;
export const LEGACY_MERCHROUTE_PORT = 4173;
export const MERCHROUTE_RUNTIME_HOST = '127.0.0.1';
export const RESERVED_MERCHROUTE_PORTS = Object.freeze([4183, 4184, 5173, 5432, 5678, 8000]);

function parsePort(value, label = 'MERCHROUTE_PORT') {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label} 必须是 1024–49151 的整数`);
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1024 || port > 49151) {
    throw new Error(`${label} 必须是 1024–49151 的整数`);
  }
  if (RESERVED_MERCHROUTE_PORTS.includes(port)) {
    throw new Error(`${label}=${port} 与 MerchRoute 依赖或隔离端口冲突`);
  }
  return port;
}

export function createRuntimeEndpoint(portValue = DEFAULT_MERCHROUTE_PORT, host = MERCHROUTE_RUNTIME_HOST) {
  if (host !== MERCHROUTE_RUNTIME_HOST) throw new Error('MerchRoute 正式服务只允许绑定 127.0.0.1');
  const port = parsePort(portValue);
  return Object.freeze({ host, port, origin: `http://${host}:${port}` });
}

export function runtimeEndpointFromEnvironment(env = process.env) {
  const configuredPort = String(env.MERCHROUTE_PORT || '').trim();
  const compatiblePort = String(env.PORT || '').trim();
  const endpoint = createRuntimeEndpoint(configuredPort || compatiblePort || DEFAULT_MERCHROUTE_PORT);
  const configuredOrigin = String(env.MERCHROUTE_RUNTIME_BASE_URL || '').trim().replace(/\/$/, '');
  if (configuredOrigin && configuredOrigin !== endpoint.origin) {
    throw new Error(`MERCHROUTE_RUNTIME_BASE_URL 必须与端口一致；期望 ${endpoint.origin}`);
  }
  return endpoint;
}

export function runtimeEndpointFromBinding(binding, { allowLegacy = false } = {}) {
  if (binding?.schemaVersion === 2) {
    const endpoint = createRuntimeEndpoint(binding.runtimeEndpoint?.port, binding.runtimeEndpoint?.host);
    if (binding.runtimeEndpoint?.origin !== endpoint.origin) throw new Error('发布绑定 runtimeEndpoint.origin 与 host/port 不一致');
    return endpoint;
  }
  if (allowLegacy && binding?.schemaVersion === 1 && binding?.legacy === true) {
    return { host: MERCHROUTE_RUNTIME_HOST, port: LEGACY_MERCHROUTE_PORT, origin: `http://${MERCHROUTE_RUNTIME_HOST}:${LEGACY_MERCHROUTE_PORT}` };
  }
  throw new Error('新发布绑定必须使用 schema v2 并显式记录 runtimeEndpoint');
}

export async function assertExclusiveBind(endpoint) {
  const normalized = createRuntimeEndpoint(endpoint?.port, endpoint?.host);
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => reject(new Error(`端口 ${normalized.port} 无法独占绑定：${error.code || error.message}`)));
    server.listen({ host: normalized.host, port: normalized.port, exclusive: true }, () => server.close(resolve));
  });
  return normalized;
}

export function parseWindowsExcludedPortRanges(text) {
  const ranges = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*(\*)?\s*$/);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start <= end) ranges.push({ start, end, administered: Boolean(match[3]) });
  }
  return ranges;
}

export function assertNotWindowsExcluded(endpoint, output) {
  const normalized = createRuntimeEndpoint(endpoint?.port, endpoint?.host);
  const range = parseWindowsExcludedPortRanges(output).find((item) => normalized.port >= item.start && normalized.port <= item.end);
  if (range) throw new Error(`端口 ${normalized.port} 位于 Windows 排除区间 ${range.start}-${range.end}`);
  return normalized;
}

export async function preflightRuntimeEndpoint(endpoint, options = {}) {
  const normalized = createRuntimeEndpoint(endpoint?.port, endpoint?.host);
  const platform = options.platform || process.platform;
  let listeningPids = options.listeningPids;
  if (listeningPids === undefined && platform === 'win32') {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${normalized.port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024
    }).trim();
    listeningPids = output ? output.split(',').map(Number).filter(Number.isInteger) : [];
  } else if (listeningPids === undefined && platform === 'darwin') {
    try {
      const output = execFileSync('lsof', ['-nP', `-iTCP:${normalized.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', windowsHide: true }).trim();
      listeningPids = output ? output.split(/\s+/).map(Number).filter(Number.isInteger) : [];
    } catch { listeningPids = []; }
  }
  if (listeningPids?.length) throw new Error(`端口 ${normalized.port} 已被 PID ${[...new Set(listeningPids)].join(',')} 监听`);
  if (platform === 'win32') {
    const outputs = options.excludedRangesOutput === undefined
      ? ['ipv4', 'ipv6'].map((family) => execFileSync('netsh.exe', ['interface', family, 'show', 'excludedportrange', 'protocol=tcp'], {
        encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024
      }))
      : [options.excludedRangesOutput];
    for (const output of outputs) assertNotWindowsExcluded(normalized, output);
  }
  await (options.bindTest || assertExclusiveBind)(normalized);
  return normalized;
}
