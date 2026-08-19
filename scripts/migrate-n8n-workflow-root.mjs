import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const options = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.split('=');
  return [key.replace(/^--/, ''), value.join('=')];
}));
const phase = options.get('phase');
const backupRoot = options.get('backup');
const envFile = options.get('env') || 'D:\\globle_n8n-data\\.n8n\\.env';
const apiRoot = (options.get('api') || 'http://127.0.0.1:5678/api/v1').replace(/\/$/, '');
const oldRoot = options.get('old') || 'G:\\01_n8n-global';
const newRoot = options.get('new') || 'G:\\01_MerchRoute';
const expectedWorkflowCount = Number(options.get('expected-workflows') || 41);
const expectedActiveCount = Number(options.get('expected-active') || 9);

if (!['deactivate', 'migrate'].includes(phase || '')) throw new Error('--phase=deactivate|migrate is required');
if (!backupRoot || !path.isAbsolute(backupRoot)) throw new Error('--backup must be an absolute path');

function parseEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

const fileEnvironment = parseEnv(await readFile(envFile, 'utf8'));
const apiKey = process.env.N8N_API_KEY || fileEnvironment.N8N_API_KEY;
if (!apiKey) throw new Error('N8N_API_KEY is missing');

async function request(method, route, body) {
  const response = await fetch(`${apiRoot}${route}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-N8N-API-KEY': apiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
  if (!response.ok) throw new Error(`${method} ${route} failed with HTTP ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload).slice(0, 500)}`);
  return payload;
}

async function listWorkflows() {
  const workflows = [];
  let cursor = '';
  do {
    const query = new URLSearchParams({ limit: '250' });
    if (cursor) query.set('cursor', cursor);
    const response = await request('GET', `/workflows?${query}`);
    workflows.push(...(response.data || []));
    cursor = response.nextCursor || '';
  } while (cursor);
  return workflows;
}

function rootForms(root) {
  const windows = root.replaceAll('/', '\\');
  const slash = root.replaceAll('\\', '/');
  return [
    [windows.replaceAll('\\', '\\\\'), newRoot.replaceAll('/', '\\').replaceAll('\\', '\\\\')],
    [windows, newRoot.replaceAll('/', '\\')],
    [slash, newRoot.replaceAll('\\', '/')],
  ];
}

const replacements = rootForms(oldRoot);
const oldForms = replacements.map(([before]) => before);

function containsOldRoot(value) {
  return typeof value === 'string'
    ? oldForms.some((candidate) => value.includes(candidate))
    : Array.isArray(value)
      ? value.some(containsOldRoot)
      : Boolean(value && typeof value === 'object' && Object.values(value).some(containsOldRoot));
}

function migrateValue(value, counter) {
  if (typeof value === 'string') {
    let result = value;
    for (const [before, after] of replacements) {
      const occurrences = result.split(before).length - 1;
      if (occurrences > 0) {
        counter.count += occurrences;
        result = result.replaceAll(before, after);
      }
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => migrateValue(item, counter));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, migrateValue(item, counter)]));
  }
  return value;
}

function updatePayload(workflow, nodes) {
  const allowedSettingKeys = new Set([
    'saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution',
    'saveDataSuccessExecution', 'executionTimeout', 'errorWorkflow', 'timezone',
    'executionOrder', 'callerPolicy', 'callerIds', 'timeSavedPerExecution',
    'redactionPolicy', 'availableInMCP', 'customTelemetryTags',
  ]);
  return {
    name: workflow.name,
    nodes,
    connections: workflow.connections,
    settings: Object.fromEntries(Object.entries(workflow.settings || {}).filter(([key]) => allowedSettingKeys.has(key))),
  };
}

async function currentTargets() {
  const summaries = await listWorkflows();
  const full = [];
  for (const summary of summaries) full.push(await request('GET', `/workflows/${encodeURIComponent(summary.id)}`));
  const targets = full.filter((workflow) => workflow.isArchived !== true && containsOldRoot(workflow.nodes));
  if (targets.length !== expectedWorkflowCount) throw new Error(`Expected ${expectedWorkflowCount} current workflows with old root in nodes; found ${targets.length}`);
  return targets;
}

await mkdir(backupRoot, { recursive: true });

if (phase === 'deactivate') {
  const targets = await currentTargets();
  const activeTargets = targets.filter((workflow) => workflow.active);
  if (activeTargets.length !== expectedActiveCount) throw new Error(`Expected ${expectedActiveCount} active target workflows; found ${activeTargets.length}`);
  await writeFile(path.join(backupRoot, 'n8n-targets-before-deactivation.json'), `${JSON.stringify(targets, null, 2)}\n`, 'utf8');
  const results = [];
  for (const workflow of activeTargets) {
    await request('POST', `/workflows/${encodeURIComponent(workflow.id)}/deactivate`, {});
    const readback = await request('GET', `/workflows/${encodeURIComponent(workflow.id)}`);
    if (readback.active) throw new Error(`${workflow.id} remained active after deactivation`);
    results.push({ id: workflow.id, name: workflow.name, versionId: workflow.versionId, active: readback.active });
  }
  await writeFile(path.join(backupRoot, 'n8n-deactivated.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ phase, targetCount: targets.length, deactivatedCount: results.length, workflows: results }, null, 2));
} else {
  const originalTargets = JSON.parse(await readFile(path.join(backupRoot, 'n8n-targets-before-deactivation.json'), 'utf8'));
  if (originalTargets.length !== expectedWorkflowCount) throw new Error(`Target backup must contain ${expectedWorkflowCount} workflows`);
  const targets = [];
  for (const original of originalTargets) {
    const current = await request('GET', `/workflows/${encodeURIComponent(original.id)}`);
    if (current.isArchived === true) throw new Error(`${current.id}: target workflow became archived`);
    targets.push({ original, current });
  }
  const originallyActive = JSON.parse(await readFile(path.join(backupRoot, 'n8n-deactivated.json'), 'utf8'));
  if (originallyActive.length !== expectedActiveCount) throw new Error(`Deactivation record must contain ${expectedActiveCount} workflows`);
  if (targets.some(({ current }) => current.active)) throw new Error('All target workflows must remain inactive during migration');
  const results = [];
  for (const { original, current } of targets) {
    const counter = { count: 0 };
    const migratedNodes = migrateValue(current.nodes, counter);
    const alreadyMigrated = counter.count === 0 && !containsOldRoot(current.nodes) && JSON.stringify(current.nodes).includes('01_MerchRoute');
    if (!alreadyMigrated && (counter.count < 1 || containsOldRoot(migratedNodes))) throw new Error(`${current.id}: root migration did not converge`);
    const connectionSnapshot = JSON.stringify(original.connections);
    const staticDataSnapshot = JSON.stringify(original.staticData ?? null);
    const pinDataSnapshot = JSON.stringify(original.pinData ?? null);
    const settingsSnapshot = JSON.stringify(original.settings ?? {});
    let updated = current;
    if (!alreadyMigrated) {
      await writeFile(path.join(backupRoot, `${current.id}-before-root-migration.json`), `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      updated = await request('PUT', `/workflows/${encodeURIComponent(current.id)}`, updatePayload(current, migratedNodes));
    }
    const readback = await request('GET', `/workflows/${encodeURIComponent(current.id)}`);
    if (readback.active) throw new Error(`${current.id}: unexpectedly active after PUT`);
    if (containsOldRoot(readback.nodes)) throw new Error(`${current.id}: old root remains in current nodes after PUT`);
    if (JSON.stringify(readback.connections) !== connectionSnapshot) throw new Error(`${current.id}: connections changed`);
    if (JSON.stringify(readback.staticData ?? null) !== staticDataSnapshot) throw new Error(`${current.id}: staticData changed during node PUT`);
    if (JSON.stringify(readback.pinData ?? null) !== pinDataSnapshot) throw new Error(`${current.id}: pinData changed during node PUT`);
    if (JSON.stringify(readback.settings ?? {}) !== settingsSnapshot) throw new Error(`${current.id}: settings changed during node PUT`);
    results.push({ id: current.id, name: current.name, oldVersionId: original.versionId, versionId: readback.versionId || updated.versionId, stringOccurrencesChanged: alreadyMigrated ? null : counter.count, resumedExistingUpdate: alreadyMigrated });
  }
  for (const original of originallyActive) {
    await request('POST', `/workflows/${encodeURIComponent(original.id)}/activate`, {});
  }
  const finalTargets = await Promise.all(results.map((item) => request('GET', `/workflows/${encodeURIComponent(item.id)}`)));
  for (const workflow of finalTargets) {
    const shouldBeActive = originallyActive.some((item) => item.id === workflow.id);
    if (workflow.active !== shouldBeActive) throw new Error(`${workflow.id}: final active state mismatch`);
    if (containsOldRoot(workflow.nodes)) throw new Error(`${workflow.id}: final readback still contains old root`);
  }
  const report = {
    phase,
    updatedCount: results.length,
    reactivatedCount: originallyActive.length,
    results: results.map((item) => ({ ...item, active: originallyActive.some((original) => original.id === item.id) })),
  };
  await writeFile(path.join(backupRoot, 'n8n-root-migration-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
