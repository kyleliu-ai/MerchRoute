import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import dotenv from 'dotenv';
import { Pool } from 'pg';

export default async function globalTeardown(): Promise<void> {
  dotenv.config({ path: path.resolve('.env') });
  const schema = (await readFile(path.resolve('.e2e-data/database-schema.txt'), 'utf8').catch(() => '')).trim();
  if (schema && process.env.DATABASE_URL) {
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).finally(() => admin.end());
  }
  await rm(path.resolve('.e2e-data/database-url.txt'), { force: true });
  await rm(path.resolve('.e2e-data/database-schema.txt'), { force: true });
}
