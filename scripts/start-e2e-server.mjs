import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = path.resolve('.e2e-data');
process.env.DATABASE_URL = (await readFile(path.join(root, 'database-url.txt'), 'utf8')).trim();
process.env.APP_DATA_DIR = path.join(root, 'app');
process.env.DOWNLOAD_CONFIG_SYNC = 'false';
process.env.PORT = '4183';
// E2E runs in an isolated database schema and must never depend on developer or
// production secrets. These values are intentionally synthetic and process-local.
process.env.MERCHROUTE_RUNTIME_KEY ||= randomBytes(32).toString('base64url');
process.env.MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
await import('../apps/server/dist/index.js');
