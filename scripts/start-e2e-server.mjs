import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { blockE2eOutboundHttp, configureE2eEnvironment } from './e2e-isolation.mjs';
import { startE2eLifecycle } from './e2e-lifecycle.mjs';

const root = path.resolve('.e2e-data');
const databaseUrl = (await readFile(path.join(root, 'database-url.txt'), 'utf8')).trim();
configureE2eEnvironment(process.env, { root, databaseUrl });
const outboundGuard = blockE2eOutboundHttp();
// Do not import the production entrypoint: it intentionally loads runtime env
// files, while this server must use only the isolated fixture and synthetic keys.
const { buildApp } = await import('../apps/server/dist/app.js');
const app = await buildApp({ databaseUrl });
const lifecycle = await startE2eLifecycle({
  root, databaseUrl, port: Number(process.env.PORT),
  close: async (reason) => {
    app.log.info({ reason, blockedOutboundRequests: outboundGuard.blockedRequests.length }, 'Stopping isolated E2E server');
    await app.close();
  },
  onResult: (exitCode, error) => {
    if (error) console.error(error);
    process.exit(exitCode);
  }
});
process.once('SIGINT', () => { void lifecycle.shutdown('SIGINT').catch(() => {}); });
process.once('SIGTERM', () => { void lifecycle.shutdown('SIGTERM').catch(() => {}); });
await app.listen({ host: process.env.HOST, port: Number(process.env.PORT) });
