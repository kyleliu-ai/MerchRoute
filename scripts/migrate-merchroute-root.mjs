import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATED_FILE_NAMES = new Set([
  'selection-manifest.json',
  'job.json',
  'prompts.json',
  'manifest.json'
]);
const MIGRATED_ROOT_NAMES = ['01_monitorFolder', '02_generateFolder', '04_已审核图片目录'];

export function createRootRebaser(oldRootValue, newRootValue) {
  const oldRoot = trimRoot(oldRootValue);
  const newRoot = trimRoot(newRootValue);
  if (!path.win32.isAbsolute(oldRoot) || !path.win32.isAbsolute(newRoot)) {
    throw new Error('old-root and new-root must be absolute Windows paths');
  }
  const pattern = new RegExp(`^${oldRoot.split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]')}(?=$|[\\\\/])`, 'i');
  return (value) => {
    if (typeof value !== 'string') return value;
    const match = value.match(pattern);
    if (!match) return value;
    const separator = match[0].includes('/') && !match[0].includes('\\') ? '/' : '\\';
    return newRoot.replaceAll('\\', separator).replaceAll('/', separator) + value.slice(match[0].length);
  };
}

export function rebaseJsonValue(value, rebaseString) {
  if (typeof value === 'string') {
    const next = rebaseString(value);
    return { value: next, changed: next === value ? 0 : 1 };
  }
  if (Array.isArray(value)) {
    let changed = 0;
    const next = value.map((item) => {
      const result = rebaseJsonValue(item, rebaseString);
      changed += result.changed;
      return result.value;
    });
    return { value: next, changed };
  }
  if (value && typeof value === 'object') {
    let changed = 0;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const result = rebaseJsonValue(item, rebaseString);
      changed += result.changed;
      next[key] = result.value;
    }
    return { value: next, changed };
  }
  return { value, changed: 0 };
}

export function migrateStateDatabase(database, oldRootValue, newRootValue) {
  const rebaseString = createRootRebaser(oldRootValue, newRootValue);
  const next = structuredClone(database);
  const taskIdMap = new Map();
  const seenTaskIds = new Map();
  let reviewCount = 0;
  let pathValueCount = 0;

  for (const review of next.reviews || []) {
    const rebasedFolder = rebaseString(review.sourceFolder);
    if (rebasedFolder === review.sourceFolder) {
      seenTaskIds.set(review.taskId, review.sourceFolder);
      continue;
    }
    const nextTaskId = taskId(review.stageId, rebasedFolder);
    const collision = seenTaskIds.get(nextTaskId);
    if (collision && collision !== rebasedFolder) {
      throw new Error(`taskId collision for ${nextTaskId}`);
    }
    seenTaskIds.set(nextTaskId, rebasedFolder);
    taskIdMap.set(review.taskId, nextTaskId);
    review.taskId = nextTaskId;
    review.sourceFolder = rebasedFolder;
    reviewCount += 1;
    pathValueCount += 1;
  }

  for (const pending of next.pendingSubmissions || []) {
    if (taskIdMap.has(pending.taskId)) pending.taskId = taskIdMap.get(pending.taskId);
    for (const field of ['n8nTaskParameters', 'n8nTaskParameterOptions']) {
      if (!pending[field]) continue;
      const result = rebaseJsonValue(pending[field], rebaseString);
      pending[field] = result.value;
      pathValueCount += result.changed;
    }
  }

  return { database: next, reviewCount, pathValueCount, taskIdMap };
}

export function taskId(stageId, sourceFolder) {
  const normalized = path.win32.resolve(sourceFolder).toLocaleLowerCase('en-US');
  return createHash('sha256').update(`${stageId}${normalized}`).digest('hex');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rebaseString = createRootRebaser(options.oldRoot, options.newRoot);
  const stateFile = path.join(options.appDataDir, 'db.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const stateMigration = migrateStateDatabase(state, options.oldRoot, options.newRoot);
  const files = await discoverOperationalJson(options.dataRoot);
  const plannedFiles = [];
  let plannedPathValues = 0;

  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const result = rebaseJsonValue(parsed, rebaseString);
    if (!result.changed) continue;
    plannedFiles.push(file);
    plannedPathValues += result.changed;
  }

  assertExpected('JSON file', options.expectJsonFiles, plannedFiles.length);
  assertExpected('review', options.expectReviews, stateMigration.reviewCount);

  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    oldRoot: trimRoot(options.oldRoot),
    newRoot: trimRoot(options.newRoot),
    dataRoot: path.resolve(options.dataRoot),
    stateFile,
    reviewsChanged: stateMigration.reviewCount,
    statePathValuesChanged: stateMigration.pathValueCount,
    taskIdsRemapped: stateMigration.taskIdMap.size,
    operationalJsonFilesChanged: plannedFiles.length,
    operationalJsonPathValuesChanged: plannedPathValues,
    historicalFilesExcluded: ['.download-idempotency/**', '03_MediaDownload/**/metadata/**', 'WB/OZON errors', 'submissionHistory', 'appEvents']
  };

  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (!options.backupDir) throw new Error('--backup-dir is required with --apply');

  await backupAndWriteJson(stateFile, stateMigration.database, path.join(options.backupDir, 'appdata', 'db.json'));
  for (const file of plannedFiles) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const result = rebaseJsonValue(parsed, rebaseString);
    const relative = path.relative(path.resolve(options.dataRoot), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`operational JSON is outside data root: ${file}`);
    await backupAndWriteJson(file, result.value, path.join(options.backupDir, 'operational-json', relative));
  }

  const remaining = [];
  for (const file of plannedFiles) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (rebaseJsonValue(parsed, rebaseString).changed) remaining.push(file);
  }
  if (remaining.length) throw new Error(`${remaining.length} operational JSON files still contain the old root`);
  summary.backupDir = path.resolve(options.backupDir);
  summary.verifiedRemainingOperationalFiles = 0;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

async function discoverOperationalJson(dataRootValue) {
  const dataRoot = path.resolve(dataRootValue);
  const files = [];
  for (const rootName of MIGRATED_ROOT_NAMES) {
    const root = path.join(dataRoot, rootName);
    await walk(root, files);
  }
  return files.sort((left, right) => left.localeCompare(right, 'en-US'));
}

async function walk(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (MIGRATED_FILE_NAMES.has(entry.name) || /^n8n_setParameter.*\.json$/i.test(entry.name)) files.push(absolute);
  }
}

async function backupAndWriteJson(file, value, backupFile) {
  await mkdir(path.dirname(backupFile), { recursive: true });
  await copyFile(file, backupFile);
  const tempFile = `${file}.merchroute-root-migration-${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempFile, file);
}

function parseArgs(args) {
  const values = new Map();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (!arg.startsWith('--') || index + 1 >= args.length) throw new Error(`invalid argument: ${arg}`);
    values.set(arg.slice(2), args[index + 1]);
    index += 1;
  }
  for (const required of ['old-root', 'new-root', 'data-root', 'app-data-dir']) {
    if (!values.get(required)) throw new Error(`--${required} is required`);
  }
  return {
    apply,
    oldRoot: values.get('old-root'),
    newRoot: values.get('new-root'),
    dataRoot: values.get('data-root'),
    appDataDir: values.get('app-data-dir'),
    backupDir: values.get('backup-dir'),
    expectJsonFiles: optionalCount(values.get('expect-json-files')),
    expectReviews: optionalCount(values.get('expect-reviews'))
  };
}

function optionalCount(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid expected count: ${value}`);
  return parsed;
}

function assertExpected(label, expected, actual) {
  if (expected !== undefined && expected !== actual) throw new Error(`${label} count drifted: expected ${expected}, found ${actual}`);
}

function trimRoot(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && invokedFile === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
