type IntegrationDatabaseGuardInput = {
  purpose: string;
  testDatabaseUrl?: string;
  productionDatabaseUrl?: string;
};

type DatabaseIdentity = {
  hostname: string;
  port: string;
  database: string;
  username: string;
};

export function guardedIntegrationDatabaseUrl(input: IntegrationDatabaseGuardInput): string | undefined {
  const candidate = String(input.testDatabaseUrl || '').trim();
  if (!candidate) return undefined;

  const testIdentity = parseDatabaseIdentity(candidate, `${input.purpose} 测试数据库地址无效`);
  if (!/(?:^|[_-])test(?:ing)?(?:[_-]|$)/i.test(testIdentity.database)) {
    throw new Error(`${input.purpose} 只能连接数据库名明确包含 test 的专用测试库，当前为 ${testIdentity.database}`);
  }

  const production = String(input.productionDatabaseUrl || '').trim();
  if (production) {
    const productionIdentity = parseDatabaseIdentity(production, `${input.purpose} 生产数据库地址无效`);
    if (sameDatabase(testIdentity, productionIdentity)) {
      throw new Error(`${input.purpose} 的测试数据库不得与 DATABASE_URL 指向同一数据库`);
    }
  }

  return candidate;
}

export function assertIntegrationSchemaBoundary(actualSchema: unknown, expectedSchema: string, purpose: string): void {
  const actual = String(actualSchema || '').trim();
  if (!actual || actual !== expectedSchema || actual === 'public') {
    throw new Error(`${purpose} 隔离 schema 校验失败：expected=${expectedSchema} actual=${actual || '<empty>'}`);
  }
}

function parseDatabaseIdentity(value: string, message: string): DatabaseIdentity {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(message);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, '')).trim();
  if (!url.hostname || !database) throw new Error(message);
  return {
    hostname: url.hostname.toLowerCase(),
    port: url.port || '5432',
    database: database.toLowerCase(),
    username: decodeURIComponent(url.username || '').toLowerCase()
  };
}

function sameDatabase(left: DatabaseIdentity, right: DatabaseIdentity): boolean {
  return left.hostname === right.hostname
    && left.port === right.port
    && left.database === right.database
    && left.username === right.username;
}
