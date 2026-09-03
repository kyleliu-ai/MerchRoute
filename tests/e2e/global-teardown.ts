import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { e2eDatabaseIdentity, isolatedE2eSchema, requestE2eShutdown } from '../../scripts/e2e-lifecycle.mjs';

export default async function globalTeardown(): Promise<void> {
  const root = path.resolve('.e2e-data');
  const readOptional = (file: string) => readFile(path.join(root, file), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const schema = (await readOptional('database-schema.txt')).trim();
  const databaseUrl = (await readOptional('database-url.txt')).trim();
  if (!schema && !databaseUrl) return;
  try {
    if (!schema || !databaseUrl || isolatedE2eSchema(databaseUrl) !== schema
      || !process.env.DATABASE_URL || e2eDatabaseIdentity(process.env.DATABASE_URL) !== e2eDatabaseIdentity(databaseUrl)) {
      throw new Error('E2E teardown database identity is incomplete or mismatched; preserve the isolated schema');
    }
    await requestE2eShutdown({ root, databaseUrl });
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).finally(() => admin.end());
    console.log('E2E teardown: app.close completed before dropping the isolated schema');
    await rm(path.join(root, 'database-url.txt'), { force: true });
    await rm(path.join(root, 'database-schema.txt'), { force: true });
  } catch (error) {
    console.error('E2E teardown did not complete; retained database metadata:', JSON.stringify({
      schema: /^pixroute_e2e_[a-f0-9]{32}$/.test(schema) ? schema : 'invalid-schema', controlRoot: root
    }));
    throw error;
  }
}
