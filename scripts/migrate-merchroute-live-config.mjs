import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const options = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.split('=');
  return [key.replace(/^--/, ''), value.join('=')];
}));
const runtimeBaseUrl = String(process.env.MERCHROUTE_RUNTIME_BASE_URL || 'http://127.0.0.1:43173').replace(/\/$/, '');
const apiRoot = (options.get('api') || `${runtimeBaseUrl}/api/v1`).replace(/\/$/, '');
const oldRoot = options.get('old') || 'G:\\01_n8n-global';
const newRoot = options.get('new') || 'G:\\01_MerchRoute';
const backupRoot = options.get('backup');
if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error('--backup must be an absolute path');

const replacements = [
  [oldRoot.replaceAll('\\', '\\\\'), newRoot.replaceAll('\\', '\\\\')],
  [oldRoot, newRoot],
  [oldRoot.replaceAll('\\', '/'), newRoot.replaceAll('\\', '/')],
];
const oldForms = replacements.map(([before]) => before);

function containsOld(value) {
  if (typeof value === 'string') return oldForms.some((candidate) => value.includes(candidate));
  if (Array.isArray(value)) return value.some(containsOld);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsOld));
}

function migrate(value, counter) {
  if (typeof value === 'string') {
    let result = value;
    for (const [before, after] of replacements) {
      const count = result.split(before).length - 1;
      if (count > 0) {
        counter.count += count;
        result = result.replaceAll(before, after);
      }
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => migrate(item, counter));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrate(item, counter)]));
  return value;
}

async function request(method, route, body) {
  const response = await fetch(`${apiRoot}${route}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) throw new Error(`${method} ${route} failed with HTTP ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)}`);
  return payload;
}

await mkdir(backupRoot, { recursive: true });
const report = { config: {}, workflowParameters: [], wb: {}, ozon: {} };

const configResponse = await request('GET', '/config');
const configBefore = configResponse.config;
await writeFile(path.join(backupRoot, 'config-before.json'), `${JSON.stringify(configBefore, null, 2)}\n`, 'utf8');
const configCounter = { count: 0 };
const configMigrated = migrate(configBefore, configCounter);
if (configCounter.count > 0) {
  if (configCounter.count !== 30 || containsOld(configMigrated)) throw new Error(`Expected exactly 30 config root values; found ${configCounter.count}`);
  await request('PUT', '/config', configMigrated);
}
const configAfter = (await request('GET', '/config')).config;
if (containsOld(configAfter)) throw new Error('Config readback still contains the old root');
report.config = { valuesChangedThisRun: configCounter.count, version: configAfter.version };

for (const stageId of ['E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007']) {
  const before = await request('GET', `/workflow-parameters/${stageId}`);
  await writeFile(path.join(backupRoot, `${stageId}-parameters-before.json`), `${JSON.stringify(before, null, 2)}\n`, 'utf8');
  const counter = { count: 0 };
  const parameters = migrate(before.parameters, counter);
  if (counter.count > 0) {
    await request('PUT', `/workflow-parameters/${stageId}`, { parameters, parameterOptions: before.parameterOptions || {} });
  }
  const after = await request('GET', `/workflow-parameters/${stageId}`);
  if (containsOld(after.parameters)) throw new Error(`${stageId} parameter readback still contains the old root`);
  report.workflowParameters.push({ stageId, valuesChanged: counter.count });
}
const changedParameterStages = report.workflowParameters.filter((item) => item.valuesChanged > 0).map((item) => item.stageId);
if (changedParameterStages.length > 0 && JSON.stringify(changedParameterStages) !== JSON.stringify(['E001', 'E002', 'E003', 'E004', 'E005', 'E007'])) {
  throw new Error(`Unexpected parameter migration stages: ${changedParameterStages.join(',')}`);
}

const wbBefore = (await request('GET', '/wb/settings')).settings;
await writeFile(path.join(backupRoot, 'wb-settings-before.json'), `${JSON.stringify(wbBefore, null, 2)}\n`, 'utf8');
if (wbBefore.rootDirectory === `${oldRoot}\\WB-Auto-Publish`) {
  await request('PATCH', '/wb/settings', {
    enabled: wbBefore.enabled,
    rootDirectory: `${newRoot}\\WB-Auto-Publish`,
    timezone: wbBefore.timezone,
    globalConcurrency: wbBefore.globalConcurrency,
    rowVersion: wbBefore.rowVersion,
  });
} else if (wbBefore.rootDirectory !== `${newRoot}\\WB-Auto-Publish`) {
  throw new Error(`Unexpected WB root: ${wbBefore.rootDirectory}`);
}
const wbAfter = (await request('GET', '/wb/settings')).settings;
if (wbAfter.rootDirectory !== `${newRoot}\\WB-Auto-Publish` || wbAfter.rowVersion < wbBefore.rowVersion) throw new Error('WB settings readback failed');
report.wb = { updatedThisRun: wbBefore.rootDirectory !== wbAfter.rootDirectory, startingRowVersion: wbBefore.rowVersion, rowVersion: wbAfter.rowVersion, rootDirectory: wbAfter.rootDirectory };

const ozonBefore = (await request('GET', '/ozon/settings')).settings;
await writeFile(path.join(backupRoot, 'ozon-settings-before.json'), `${JSON.stringify(ozonBefore, null, 2)}\n`, 'utf8');
if (ozonBefore.rootDirectory === `${oldRoot}\\OZON-Auto-Publish`) {
  await request('PATCH', '/ozon/settings', { rootDirectory: `${newRoot}\\OZON-Auto-Publish`, rowVersion: ozonBefore.rowVersion });
} else if (ozonBefore.rootDirectory !== `${newRoot}\\OZON-Auto-Publish`) {
  throw new Error(`Unexpected OZON root: ${ozonBefore.rootDirectory}`);
}
const ozonAfter = (await request('GET', '/ozon/settings')).settings;
if (ozonAfter.rootDirectory !== `${newRoot}\\OZON-Auto-Publish` || ozonAfter.rowVersion < ozonBefore.rowVersion) throw new Error('OZON settings readback failed');
report.ozon = { updatedThisRun: ozonBefore.rootDirectory !== ozonAfter.rootDirectory, startingRowVersion: ozonBefore.rowVersion, rowVersion: ozonAfter.rowVersion, rootDirectory: ozonAfter.rootDirectory };

const finalConfig = (await request('GET', '/config')).config;
if (containsOld(finalConfig)) throw new Error('Final config readback regressed to the old root');
await writeFile(path.join(backupRoot, 'live-config-migration-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
