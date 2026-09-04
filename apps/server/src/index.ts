import path from 'node:path';
import { existsSync } from 'node:fs';
import { verifyInstalledRelease } from '../../../scripts/lib/installed-release.mjs';
import { loadRuntimeEnvironment } from './runtime-environment.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
if (process.env.MERCHROUTE_INSTALLED_MANIFEST_SHA256 || existsSync(path.join(projectRoot, 'installed-release.json'))) {
  await verifyInstalledRelease(projectRoot, process.env.MERCHROUTE_INSTALLED_MANIFEST_SHA256);
}
const { runtimeEndpoint } = loadRuntimeEnvironment({ projectRoot });

const { buildApp } = await import('./app.js');

const { host, port } = runtimeEndpoint;
const app = await buildApp();
await app.listen({ host, port });
app.log.info({ host, port }, `MerchRoute 已启动：${runtimeEndpoint.origin}`);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, '正在安全关闭服务');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
