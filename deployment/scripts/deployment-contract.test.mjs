import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCredentialImportData, buildCredentialRequirements } from '../n8n/credential-contract.mjs';
import { findLegacyRuntimePaths, makeWorkflowPortable, materializeWorkflow } from '../n8n/portable-workflow.mjs';
import {
  LOCAL_FILE_TRIGGER_CONTRACTS,
  assertMaterializedLocalFileTriggerPaths,
  categoryRulesFilePath,
  expectedLocalFileTriggerPath,
  verifyCategoryRulesFiles,
} from '../n8n/runtime-contract.mjs';
import { canListen } from './preflight-lib.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

function runtimePathEnv(root) {
  return {
    MERCHROUTE_N8N_RUNTIME_DIR: path.join(root, 'n8n-runtime'),
    MERCHROUTE_DATA_ROOT: path.join(root, 'files'),
    MERCHROUTE_BROWSER_PROFILE_ROOT: path.join(root, 'browser-profiles'),
    MERCHROUTE_BROWSER_EXECUTABLE: path.join(root, 'browser', 'chrome'),
    MERCHROUTE_TEMP_DIR: path.join(root, 'files', '.tmp'),
    MERCHROUTE_CATEGORY_RULES_FILE: categoryRulesFilePath(path.join(root, 'files')),
  };
}

async function preparedRuntimePathEnv(root) {
  const runtime = runtimePathEnv(root);
  await mkdir(path.dirname(runtime.MERCHROUTE_CATEGORY_RULES_FILE), { recursive: true });
  await copyFile(
    path.join(projectRoot, 'deployment', 'n8n', 'config', 'category-scene-rules.json'),
    runtime.MERCHROUTE_CATEGORY_RULES_FILE,
  );
  return runtime;
}

function fixtureWorkflow(id, nodeName, type, existingId) {
  return { id, nodes: [{ id: `${id}-node`, name: nodeName, credentials: { [type]: { id: existingId, name: 'must-not-persist' } } }] };
}

function validCredentialInput() {
  return { credentials: {
    'jimeng-session': { token: 'fixture-jimeng' },
    'siliconflow-api': { token: 'fixture-silicon' },
    'qwen-runtime': { model: 'fixture-model', baseUrl: 'https://example.invalid/v1/chat/completions', apiKey: 'fixture-qwen' },
    'merchroute-runtime': { runtimeKey: '' },
    'wb-seller-api': { token: 'fixture-wb' },
    'ozon-seller-api': { clientId: 'fixture-client', apiKey: 'fixture-ozon' },
  } };
}

test('credential requirements replace live IDs and names with six logical aliases', () => {
  const workflows = [
    fixtureWorkflow('Wxng7hVbjMNhVOaO', 'Generate Cutout Image', 'httpBearerAuth', 'secret-live-id-1'),
    fixtureWorkflow('5fKlIwJWfXJM1y4E', 'Upload Image', 'httpBearerAuth', 'secret-live-id-2'),
    fixtureWorkflow('pLoryDijfFiNwKiI', 'Global Constants', 'globalConstantsApi', 'secret-live-id-3'),
    fixtureWorkflow('WbwJ8ufnL349l9hk', 'POST Create Job', 'httpHeaderAuth', 'secret-live-id-4'),
    fixtureWorkflow('qYxi3PPmRm7tjK0E', 'WB JSON Request', 'httpHeaderAuth', 'secret-live-id-5'),
    fixtureWorkflow('3hyAiON1l3fEHBzA', 'OZON API请求（在此选择店铺凭据）', 'httpCustomAuth', 'secret-live-id-6'),
  ];
  const result = buildCredentialRequirements(workflows);
  const serialized = JSON.stringify(result);
  assert.equal(result.requirements.length, 6);
  assert.equal(result.bindings.length, 6);
  assert.doesNotMatch(serialized, /secret-live-id|must-not-persist/);
});

test('credential import data uses the generated runtime key without logging it', () => {
  const input = validCredentialInput();
  const result = buildCredentialImportData(input, 'fixture-runtime');
  assert.equal(result['merchroute-runtime'].value, 'fixture-runtime');
  assert.equal(JSON.parse(result['qwen-runtime'].globalConstants).Authorization.APIKey_Run, 'Bearer fixture-qwen');
  assert.equal(JSON.parse(result['ozon-seller-api'].json).headers['Client-Id'], 'fixture-client');
});

test('credential import normalizes an accidental Qwen Bearer prefix without duplicating it', () => {
  const input = validCredentialInput();
  input.credentials['qwen-runtime'].apiKey = 'Bearer fixture-qwen';
  const result = buildCredentialImportData(input, 'fixture-runtime');
  assert.equal(JSON.parse(result['qwen-runtime'].globalConstants).Authorization.APIKey_Run, 'Bearer fixture-qwen');
});

test('workflow importer dry-run validates all inputs without writing to n8n', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-deploy-contract-'));
  const file = path.join(root, 'credentials.local.json');
  await writeFile(file, JSON.stringify(validCredentialInput()), { mode: 0o600 });
  try {
    const runtime = await preparedRuntimePathEnv(root);
    const result = spawnSync(process.execPath, ['deployment/n8n/scripts/import-workflows.mjs', `--credentials-file=${file}`, '--dry-run'], {
      cwd: projectRoot,
      env: { ...process.env, MERCHROUTE_RUNTIME_KEY: 'fixture-runtime', ...runtime },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /36 个工作流（含 E007 G8MSbp9u0dudSgba）将保持停用/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('portable workflow templates remove local drive roots and materialize target paths', () => {
  const source = { parameters: {
    root: 'G:/01_MerchRoute/03-pddProductMedia',
    legacyRoot: 'G:/01_n8n-global/03-pddProductMedia',
    script: 'G:/AI_Program_Files/codex-data/n8n_Project/scripts/pdd-login.cjs',
    profile: 'D:/n8n-browser-profile/pdd',
    browser: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  } };
  const portable = makeWorkflowPortable(source);
  assert.deepEqual(findLegacyRuntimePaths(portable), []);
  const runtime = runtimePathEnv(path.join(path.sep, 'portable target'));
  const materialized = materializeWorkflow(portable, runtime);
  assert.match(materialized.parameters.root, /portable target\/files/);
  assert.equal(materialized.parameters.legacyRoot, materialized.parameters.root);
  assert.match(materialized.parameters.script, /n8n-runtime\/scripts\/pdd-login\.cjs/);
  assert.doesNotMatch(JSON.stringify(materialized), /__MERCHROUTE_/);
});

test('macOS E001-E005 Local File Trigger paths are exact POSIX paths', async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'n8n', 'manifest.json'), 'utf8'));
  const runtime = {
    MERCHROUTE_N8N_RUNTIME_DIR: '/Users/example/Library/Application Support/MerchRoute/n8n-runtime',
    MERCHROUTE_DATA_ROOT: '/Users/example/Documents/01_MerchRoute',
    MERCHROUTE_BROWSER_PROFILE_ROOT: '/Users/example/Library/Application Support/MerchRoute/browser-profiles',
    MERCHROUTE_BROWSER_EXECUTABLE: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    MERCHROUTE_TEMP_DIR: '/Users/example/Documents/01_MerchRoute/.tmp',
  };
  const workflows = await Promise.all(LOCAL_FILE_TRIGGER_CONTRACTS.map(async (contract) => {
    const entry = manifest.workflows.find((item) => item.id === contract.workflowId);
    assert.ok(entry, `missing manifest entry ${contract.workflowId}`);
    const source = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'n8n', ...entry.file.split('/')), 'utf8'));
    return materializeWorkflow(source, runtime);
  }));
  assertMaterializedLocalFileTriggerPaths(workflows, runtime.MERCHROUTE_DATA_ROOT);
  for (const contract of LOCAL_FILE_TRIGGER_CONTRACTS) {
    const workflow = workflows.find((item) => item.id === contract.workflowId);
    const trigger = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.localFileTrigger');
    assert.equal(trigger.parameters.path, expectedLocalFileTriggerPath(runtime.MERCHROUTE_DATA_ROOT, contract));
    assert.doesNotMatch(trigger.parameters.path, /\\/);
  }
});

test('path normalization does not rewrite backslashes in Code nodes or expressions', () => {
  const source = {
    parameters: { path: '__MERCHROUTE_DATA_ROOT__\\01_monitorFolder\\E001-抠图-监听' },
    code: "const matcher = /foo\\\\bar/; const root = '__MERCHROUTE_DATA_ROOT__\\\\nested';",
    expression: '={{ "__MERCHROUTE_DATA_ROOT__\\\\nested" }}',
  };
  const portable = makeWorkflowPortable(source);
  assert.equal(portable.parameters.path, '__MERCHROUTE_DATA_ROOT__/01_monitorFolder/E001-抠图-监听');
  assert.equal(portable.code, source.code);
  assert.equal(portable.expression, source.expression);
  const materialized = materializeWorkflow(portable, {
    MERCHROUTE_N8N_RUNTIME_DIR: '/Users/example/runtime',
    MERCHROUTE_DATA_ROOT: '/Users/example/Documents/01_MerchRoute',
    MERCHROUTE_BROWSER_PROFILE_ROOT: '/Users/example/browser',
    MERCHROUTE_BROWSER_EXECUTABLE: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    MERCHROUTE_TEMP_DIR: '/Users/example/tmp',
  });
  assert.equal(materialized.parameters.path, '/Users/example/Documents/01_MerchRoute/01_monitorFolder/E001-抠图-监听');
  assert.equal(materialized.code, source.code.replace('__MERCHROUTE_DATA_ROOT__', '/Users/example/Documents/01_MerchRoute'));
  assert.equal(materialized.expression, source.expression.replace('__MERCHROUTE_DATA_ROOT__', '/Users/example/Documents/01_MerchRoute'));
});

test('prepare dry-run does not create the requested application directory', async () => {
  const root = path.join(os.tmpdir(), `merchroute-dry-run-${Date.now()}`);
  const result = spawnSync(process.execPath, ['deployment/scripts/bootstrap.mjs', 'prepare', `--app-home=${root}`, '--dry-run'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"dryRun": true/);
  await assert.rejects(access(root));
});

test('prepare is idempotent and preserves generated secrets on repeated execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-repeat-'));
  const appHome = path.join(root, 'Application Home');
  const dataRoot = path.join(root, 'Business Media');
  try {
    const args = ['deployment/scripts/bootstrap.mjs', 'prepare', `--app-home=${appHome}`, `--data-root=${dataRoot}`];
    const first = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr);
    const firstSecrets = await readFile(path.join(appHome, 'secrets', 'deployment.env'), 'utf8');
    await writeFile(categoryRulesFilePath(dataRoot), '{"tampered":true}\n', 'utf8');
    const second = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(second.status, 0, second.stderr);
    const secondSecrets = await readFile(path.join(appHome, 'secrets', 'deployment.env'), 'utf8');
    assert.equal(secondSecrets, firstSecrets);
    const repositoryRules = path.join(projectRoot, 'deployment', 'n8n', 'config', 'category-scene-rules.json');
    const runtimeRules = categoryRulesFilePath(dataRoot);
    const verifiedRules = await verifyCategoryRulesFiles(repositoryRules, runtimeRules);
    assert.match(verifiedRules.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readdir(path.dirname(runtimeRules)), ['category-scene-rules.json']);
    await assert.rejects(access(path.join(dataRoot, 'config', 'category-scene-rules.json')));
    for (const contract of LOCAL_FILE_TRIGGER_CONTRACTS) {
      await access(path.join(dataRoot, ...contract.relativePath.split('/')));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare writes the selected media root into both MerchRoute and n8n runtime environments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-data-root-'));
  const appHome = path.join(root, 'Application Home');
  const dataRoot = path.join(root, 'Business Media');
  try {
    const result = spawnSync(process.execPath, ['deployment/scripts/bootstrap.mjs', 'prepare', `--app-home=${appHome}`, `--data-root=${dataRoot}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const merchrouteEnv = await readFile(path.join(appHome, 'secrets', 'merchroute.env'), 'utf8');
    const n8nEnv = await readFile(path.join(appHome, 'secrets', 'n8n.env'), 'utf8');
    assert.match(merchrouteEnv, new RegExp(`^MERCHROUTE_DATA_ROOT=${dataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(n8nEnv, new RegExp(`^MERCHROUTE_DATA_ROOT=${dataRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    const profileRoot = path.join(appHome, 'browser-profiles');
    assert.match(n8nEnv, new RegExp(`^MERCHROUTE_BROWSER_PROFILE_ROOT=${profileRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    await access(path.join(profileRoot, 'pdd'));
    await access(path.join(profileRoot, '1688'));
    assert.notEqual(path.join(profileRoot, 'pdd'), path.join(profileRoot, '1688'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare preserves an existing browser Profile root and enforces the n8n upgrade contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-existing-profile-'));
  const appHome = path.join(root, 'Application Home');
  const dataRoot = path.join(root, 'Business Media');
  const existingProfileRoot = path.join(root, 'n8n-browser-profile');
  const conflictingProfileRoot = path.join(root, 'new-empty-profile');
  const secretsDir = path.join(appHome, 'secrets');
  try {
    await mkdir(secretsDir, { recursive: true });
    await writeFile(path.join(secretsDir, 'n8n.env'), [
      `MERCHROUTE_BROWSER_PROFILE_ROOT=${existingProfileRoot}`,
      'N8N_ENCRYPTION_KEY=fixture-n8n-encryption', // gitleaks:allow - deterministic non-secret test fixture
      'DB_POSTGRESDB_PASSWORD=fixture-n8n-database',
      'MERCHROUTE_RUNTIME_KEY=fixture-runtime',
      'N8N_LISTEN_ADDRESS=0.0.0.0',
      'NODES_EXCLUDE=["n8n-nodes-base.executeCommand"]',
      'CUSTOM_UPGRADE_SETTING=preserved',
      '',
    ].join('\n'), 'utf8');
    const args = ['deployment/scripts/bootstrap.mjs', 'prepare', `--app-home=${appHome}`, `--data-root=${dataRoot}`];
    const result = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const n8nEnv = await readFile(path.join(secretsDir, 'n8n.env'), 'utf8');
    assert.match(n8nEnv, new RegExp(`^MERCHROUTE_BROWSER_PROFILE_ROOT=${existingProfileRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(n8nEnv, /^N8N_LISTEN_ADDRESS=127\.0\.0\.1$/m);
    assert.match(n8nEnv, /^NODES_EXCLUDE=\[\]$/m);
    assert.match(n8nEnv, /^N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200$/m);
    assert.match(n8nEnv, /^CUSTOM_UPGRADE_SETTING=preserved$/m);
    await access(path.join(existingProfileRoot, 'pdd'));
    await access(path.join(existingProfileRoot, '1688'));
    await assert.rejects(access(path.join(appHome, 'browser-profiles')));

    const conflict = spawnSync(process.execPath, [...args, `--browser-profile-root=${conflictingProfileRoot}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(conflict.status, 0);
    assert.match(`${conflict.stderr}\n${conflict.stdout}`, /禁止用空目录覆盖现有登录 Profile/);
    await assert.rejects(access(conflictingProfileRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E007 workflow has a finite timeout longer than the MerchRoute download timeout', async () => {
  const workflow = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'n8n', 'workflows', 'core', 'G8MSbp9u0dudSgba.json'), 'utf8'));
  assert.equal(workflow.id, 'G8MSbp9u0dudSgba');
  assert.equal(workflow.settings.executionTimeout, 1200);
  assert.ok(workflow.settings.executionTimeout * 1000 > 900_000);
});

test('browser profile dry-runs declare two isolated persistent directories without creating them', async () => {
  const root = path.join(os.tmpdir(), `merchroute-browser-profile-dry-run-${Date.now()}`);
  for (const command of ['browser-profiles', 'verify-browser-profiles']) {
    const result = spawnSync(process.execPath, ['deployment/scripts/bootstrap.mjs', command, `--app-home=${root}`, '--dry-run'], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.profiles.map((profile) => profile.id), ['pdd', '1688']);
    assert.equal(output.profiles[0].directory, path.join(root, 'browser-profiles', 'pdd'));
    assert.equal(output.profiles[1].directory, path.join(root, 'browser-profiles', '1688'));
    assert.notEqual(output.profiles[0].directory, output.profiles[1].directory);
  }
  await assert.rejects(access(root));
});

test('configure-merchroute dry-run declares the isolated E007 directory without contacting services', async () => {
  const root = path.join(os.tmpdir(), `merchroute-configure-e007-${Date.now()}`);
  const dataRoot = path.join(root, 'Business Media');
  const result = spawnSync(process.execPath, ['deployment/scripts/bootstrap.mjs', 'configure-merchroute', `--app-home=${root}`, `--data-root=${dataRoot}`, '--dry-run'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"workflowCode": "E007"/);
  assert.match(result.stdout, /03-1688ProductMedia/);
  await assert.rejects(access(root));
});

test('configure-merchroute adds E007 once, writes runtime parameters, and verifies the database projection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-configure-e007-live-'));
  const appHome = path.join(root, 'Application Home');
  const dataRoot = path.join(root, 'Business Media');
  let config = {
    version: 'v003',
    stages: [
      { id: 'E006' },
      { id: 'E001' },
    ],
  };
  let parameters = { SKU: '', productName: '' };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    };
    let body;
    if (request.method === 'GET' && url.pathname === '/api/v1/config') body = { config, downloadSync: { status: 'synced' } };
    else if (request.method === 'PUT' && url.pathname === '/api/v1/config') {
      config = await readBody();
      body = { config, downloadSync: { status: 'synced' } };
    } else if (request.method === 'GET' && url.pathname === '/api/v1/workflow-parameters/E007') body = { parameters, parameterOptions: {} };
    else if (request.method === 'PUT' && url.pathname === '/api/v1/workflow-parameters/E007') {
      const input = await readBody();
      parameters = input.parameters;
      body = { parameters, parameterOptions: input.parameterOptions };
    } else if (request.method === 'GET' && url.pathname === '/api/v1/download-workflows') {
      const e007 = config.stages.find((stage) => stage.id === 'E007');
      body = { items: e007 ? [{
        code: 'E007',
        webhookUrl: e007.download.webhookUrl,
        parentOutputDir: e007.candidateRoot,
        recoveryMode: e007.download.recoveryMode,
      }] : [] };
    } else {
      response.statusCode = 404;
      body = { error: { message: 'not found' } };
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const child = spawn(process.execPath, [
      'deployment/scripts/bootstrap.mjs', 'configure-merchroute',
      `--app-home=${appHome}`,
      `--data-root=${dataRoot}`,
      `--merchroute-base-url=http://127.0.0.1:${address.port}`,
    ], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const status = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(status, 0, stderr);
    assert.match(stdout, /"databaseProjection": "synced"/);
    assert.deepEqual(config.stages.map((stage) => stage.id), ['E006', 'E007', 'E001']);
    const e007 = config.stages[1];
    assert.equal(e007.download.webhookUrl, 'http://localhost:5678/webhook/1688-product-media-download');
    assert.equal(e007.download.recoveryMode, 'IDEMPOTENT_REPLAY');
    assert.equal(parameters.parentOutputDir, path.join(dataRoot, '03-1688ProductMedia'));
    assert.equal(parameters.productUrl, '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('prepared credential template points to the acquisition guide and never asks the user for runtimeKey', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-credential-guide-'));
  const appHome = path.join(root, 'Application Home');
  try {
    const result = spawnSync(process.execPath, ['deployment/scripts/bootstrap.mjs', 'prepare', `--app-home=${appHome}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const input = JSON.parse(await readFile(path.join(appHome, 'secrets', 'credentials.local.json'), 'utf8'));
    assert.equal(input.credentialGuide, 'deployment/CREDENTIAL_SETUP.zh-CN.md');
    assert.match(input.instructions, /runtimeKey 保持为空/);
    assert.equal(input.credentials['merchroute-runtime'].runtimeKey, '');
    assert.equal(input.credentials['ozon-seller-api'].clientId, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing credentials fail before creating plaintext import recovery files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-missing-credential-'));
  const file = path.join(root, 'credentials.local.json');
  await writeFile(file, JSON.stringify({ credentials: {} }), { mode: 0o600 });
  try {
    const runtime = await preparedRuntimePathEnv(root);
    const result = spawnSync(process.execPath, ['deployment/n8n/scripts/import-workflows.mjs', `--credentials-file=${file}`, '--dry-run'], {
      cwd: projectRoot,
      env: { ...process.env, MERCHROUTE_RUNTIME_KEY: 'fixture-runtime', ...runtime },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /缺少 credentials\.[a-z-]+\.[A-Za-z]+/);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.n8n-import-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow importer stops before n8n when the E003 rules file hash differs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-rules-mismatch-'));
  const file = path.join(root, 'credentials.local.json');
  await writeFile(file, JSON.stringify(validCredentialInput()), { mode: 0o600 });
  try {
    const runtime = await preparedRuntimePathEnv(root);
    await writeFile(runtime.MERCHROUTE_CATEGORY_RULES_FILE, '{"validJsonButWrong":true}\n', 'utf8');
    const result = spawnSync(process.execPath, ['deployment/n8n/scripts/import-workflows.mjs', `--credentials-file=${file}`, '--dry-run'], {
      cwd: projectRoot,
      env: { ...process.env, MERCHROUTE_RUNTIME_KEY: 'fixture-runtime', ...runtime },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /SHA-256 不一致/);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.n8n-import-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('port conflict detection rejects a port already held by an unknown process', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(await canListen(address.port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await canListen(address.port), true);
});

test('permission/path failure stops prepare without creating a secret directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-permission-'));
  const blocked = path.join(root, 'blocked-home');
  await writeFile(blocked, 'not a directory');
  try {
    const result = spawnSync(process.execPath, ['deployment/scripts/bootstrap.mjs', 'prepare', `--app-home=${blocked}`], {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    await assert.rejects(access(path.join(blocked, 'secrets')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent prompt keeps mandatory safety, retry, inactive workflow, path, and report contracts', async () => {
  const prompt = await readFile(path.join(projectRoot, 'deployment', 'AGENT_INSTALL_PROMPT.zh-CN.md'), 'utf8');
  for (const required of ['持续执行', '不得启用任何工作流', '绝不能要求用户把任何密钥粘贴到聊天', '最多两轮', 'deployment-report.json', 'linux/amd64,linux/arm64', 'CREDENTIAL_SETUP.zh-CN.md', '不得只说“请填写空字段”', 'runtimeKey` 保持为空', 'G8MSbp9u0dudSgba', 'configure-merchroute', 'postgres-e007-download-projection', '00-config/category-scene-rules.json', 'E001–E005', 'Local File Trigger', '不得包含反斜杠', 'n8n-e001-e005-local-trigger-paths', 'category-scene-rules-file', 'browser-profiles/pdd', 'browser-profiles/1688', 'verify-browser-profiles', 'Playwright headless persistent context', '不得读取或记录 Cookie 值', '不得直接删除活动的 `.pdd.lock`', 'AGENT_UPDATE_PROMPT.zh-CN.md', 'N8N_LISTEN_ADDRESS=127.0.0.1', 'NODES_EXCLUDE=[]', 'N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200', 'n8n-upgrade-guard.mjs --phase=post-start', 'executionTimeout=1200']) {
    assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('README and agent prompts stay aligned with the machine-readable release contract', async () => {
  const runtime = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'runtime-versions.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'deployment', 'n8n', 'manifest.json'), 'utf8'));
  const postgresInit = await readFile(path.join(projectRoot, 'deployment', 'postgres', 'init', '01-databases.sh'), 'utf8');
  const documents = await Promise.all([
    readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    readFile(path.join(projectRoot, 'deployment', 'AGENT_INSTALL_PROMPT.zh-CN.md'), 'utf8'),
    readFile(path.join(projectRoot, 'deployment', 'AGENT_UPDATE_PROMPT.zh-CN.md'), 'utf8'),
  ]);
  const releaseValues = [
    runtime.node,
    runtime.npm,
    runtime.n8n,
    runtime.postgresqlTested,
    runtime.playwright,
    runtime.jimeng.version,
    `${manifest.uniqueWorkflowCount} 个唯一工作流`,
    `${manifest.packages.length} 个部署包`,
    'deployment/runtime-versions.json',
    'deployment/n8n/manifest.json',
    'deployment/postgres/init/01-databases.sh',
    'package-lock.json',
    'merchroute_app',
    'merchroute_n8n',
  ];
  for (const document of documents) {
    for (const value of releaseValues) assert.match(document, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const databaseContract of [
    'CREATE ROLE merchroute_app',
    'CREATE DATABASE merchroute OWNER merchroute_app',
    'CREATE ROLE merchroute_n8n',
    'CREATE DATABASE merchroute_n8n OWNER merchroute_n8n',
  ]) assert.match(postgresInit, new RegExp(databaseContract));
});

test('README references every generated isolated UI screenshot', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');
  for (const file of ['overview.webp', 'procurement.webp', 'media-review.webp', 'wb-listing.webp', 'ozon-listing.webp', 'pricing.webp', 'shipping.webp', 'settings.webp', 'notifications.webp']) {
    const relativePath = `docs/assets/ui/${file}`;
    assert.match(readme, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const image = await readFile(path.join(projectRoot, ...relativePath.split('/')));
    assert.ok(image.byteLength > 20_000, `${relativePath} should contain a rendered UI screenshot`);
  }
});

test('agent update prompt preserves existing state and gates E007 before and after restart', async () => {
  const prompt = await readFile(path.join(projectRoot, 'deployment', 'AGENT_UPDATE_PROMPT.zh-CN.md'), 'utf8');
  for (const required of [
    '最新 `origin/main`',
    '本机权威来源与强制二次确认',
    '默认同步方向是“本机 → GitHub”',
    '只读比较不等于更新授权',
    '确认允许本次 GitHub → 本机更新',
    '用户最初粘贴本提示词不算二次确认',
    '用户未回复、拒绝或不在线时必须停止',
    '不得用 `reset --hard`',
    'MERCHROUTE_BROWSER_PROFILE_ROOT',
    '禁止用空目录覆盖现有登录 Profile',
    'N8N_LISTEN_ADDRESS=127.0.0.1',
    'NODES_EXCLUDE=[]',
    'N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200',
    'n8n-upgrade-guard.mjs --phase=pre-stop',
    'n8n-upgrade-guard.mjs --phase=post-start',
    '`new`、`running`、`unknown` 或 `waiting`',
    '不得直接 `UPDATE`/`DELETE`',
    '不得自动 Retry',
    'executionTimeout=1200',
    'PGPASSWORD',
    '36 个受控 n8n 工作流',
    '全部保持停用',
    'Gitleaks',
  ]) {
    assert.match(prompt, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('project agent rules keep local MerchRoute state authoritative until a second confirmation', async () => {
  const rules = await readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8');
  for (const required of [
    '本机权威来源与同步方向',
    '默认同步方向只能是“本机 → GitHub”',
    '只读比较不等于更新授权',
    '二次明确确认',
    '禁止通过 `git pull`、merge、rebase、reset、checkout、restore',
    '禁止用仓库工作流覆盖本机 n8n',
    '用仓库配置覆盖 PostgreSQL 或外部环境文件',
    '替换本机 Jimeng 代理源码',
    '必须保留本机内容、报告差异并等待用户决定',
  ]) {
    assert.match(rules, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('credential acquisition guide covers every logical alias and prevents secret disclosure', async () => {
  const guide = await readFile(path.join(projectRoot, 'deployment', 'CREDENTIAL_SETUP.zh-CN.md'), 'utf8');
  for (const alias of ['jimeng-session', 'siliconflow-api', 'qwen-runtime', 'merchroute-runtime', 'wb-seller-api', 'ozon-seller-api']) {
    assert.match(guide, new RegExp(alias));
  }
  for (const required of ['sessionid', 'cloud.siliconflow.cn/account/ak', 'bailian.console.aliyun.com', 'seller.wildberries.ru', 'seller.ozon.ru', '不得只说“请填写 Key”', 'runtimeKey', '保持为空', '不要添加 `Bearer `']) {
    assert.match(guide, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
