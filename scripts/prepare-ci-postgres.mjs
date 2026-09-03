import { Pool } from 'pg';

// This helper is deliberately unusable against the developer's databases.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw new Error('GitHub-hosted isolated PostgreSQL setup only');
const expected = 'postgresql://merchroute_ci@127.0.0.1:5432/merchroute_ci_test';
const cleanup = 'postgresql://merchroute_ci@127.0.0.1:5432/merchroute_ci_cleanup_test';
if (process.env.DATABASE_URL !== expected || process.env.WB_SOURCE_MEDIA_CLEANUP_TEST_DATABASE_URL !== cleanup) throw new Error('Unexpected CI database configuration');
const pool = new Pool({ connectionString: expected, max: 1 });
try {
  const version = await pool.query("SELECT current_setting('server_version_num')::integer AS version,current_setting('server_encoding') AS encoding");
  if (Math.floor(version.rows[0].version / 10000) !== 18 || version.rows[0].encoding !== 'UTF8') throw new Error('CI requires PostgreSQL 18 with UTF8');
  const primary = await pool.query('SELECT datlocprovider FROM pg_database WHERE datname=current_database()');
  if (primary.rows[0]?.datlocprovider !== 'i') throw new Error('CI requires ICU rather than ASCII C locale');
  const exists = await pool.query("SELECT 1 FROM pg_database WHERE datname='merchroute_ci_cleanup_test'");
  if (!exists.rowCount) await pool.query("CREATE DATABASE merchroute_ci_cleanup_test TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'und'");
  const target = await pool.query("SELECT datlocprovider,pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname='merchroute_ci_cleanup_test'");
  if (target.rows[0]?.datlocprovider !== 'i' || target.rows[0]?.encoding !== 'UTF8') throw new Error('Cleanup database must also use ICU/UTF8');
  console.log(JSON.stringify({ ok: true, postgresMajor: 18, encoding: 'UTF8', localeProvider: 'ICU', cleanupUsesSeparateTestDatabase: true }));
} finally { await pool.end(); }
