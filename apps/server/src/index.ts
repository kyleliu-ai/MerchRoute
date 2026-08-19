import path from 'node:path';
import { loadRuntimeEnvironment } from './runtime-environment.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
loadRuntimeEnvironment({ projectRoot });

const { buildApp } = await import('./app.js');

const host = process.env.HOST || '127.0.0.1';
if (host === '0.0.0.0' && process.env.ALLOW_REMOTE !== 'true') throw new Error('默认禁止监听 0.0.0.0；如确有需要请显式设置 ALLOW_REMOTE=true');
const port = Number(process.env.PORT || 4173);
const app = await buildApp();
await app.listen({ host, port });
app.log.info({ host, port }, `n8n 产品图片审核与投递管理工具已启动：http://${host}:${port}`);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, '正在安全关闭服务');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
