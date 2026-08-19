import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf8'));
const expected = readJson('deployment/runtime-versions.json');
const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const jimengPackage = readJson('integrations/jimeng-free-api-all/package.json');
const jimengPackageLock = readJson('integrations/jimeng-free-api-all/package-lock.json');
const n8nRuntimePackage = readJson('deployment/n8n/runtime-scripts/package.json');
const n8nRuntimePackageLock = readJson('deployment/n8n/runtime-scripts/package-lock.json');
const errors = [];

if (process.env.MERCHROUTE_VERSION_CHECK_CHILD !== '1' && process.versions.node !== expected.node) {
  const bundledNode = path.join(projectRoot, '.tools', `node-v${expected.node}-win-x64`, 'node.exe');
  if (process.platform === 'win32') {
    const result = spawnSync(bundledNode, process.argv.slice(1), {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      env: { ...process.env, MERCHROUTE_VERSION_CHECK_CHILD: '1' },
      windowsHide: true,
    });
    if (!result.error) process.exit(result.status ?? 1);
  }
}

function expectEqual(label, actual, wanted) {
  if (actual !== wanted) errors.push(`${label}: 期望 ${wanted}，实际 ${actual ?? '(missing)'}`);
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    errors.push(`${command}: 无法读取版本（${result.status ?? result.error?.code ?? 'not found'}）`);
    return '';
  }
  return result.stdout.trim();
}

expectEqual('Node.js', process.versions.node, expected.node);
expectEqual('npm', commandVersion('npm'), expected.npm);
expectEqual('.nvmrc', readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8').trim(), expected.node);
expectEqual('package.json engines.node', packageJson.engines?.node, expected.node);
expectEqual('package.json engines.npm', packageJson.engines?.npm, expected.npm);
expectEqual('package.json packageManager', packageJson.packageManager, `npm@${expected.npm}`);
expectEqual('package.json volta.node', packageJson.volta?.node, expected.node);
expectEqual('package.json volta.npm', packageJson.volta?.npm, expected.npm);
expectEqual('package.json @playwright/test', packageJson.devDependencies?.['@playwright/test'], expected.playwright);
expectEqual(
  'package-lock.json @playwright/test',
  packageLock.packages?.['node_modules/@playwright/test']?.version,
  expected.playwright,
);
expectEqual('package-lock.json engines.node', packageLock.packages?.['']?.engines?.node, expected.node);
expectEqual('package-lock.json engines.npm', packageLock.packages?.['']?.engines?.npm, expected.npm);
expectEqual('Jimeng package version', jimengPackage.version, expected.jimeng.version);
expectEqual('Jimeng engines.node', jimengPackage.engines?.node, expected.jimeng.node);
expectEqual('Jimeng engines.npm', jimengPackage.engines?.npm, expected.jimeng.npm);
expectEqual('Jimeng packageManager', jimengPackage.packageManager, `npm@${expected.jimeng.npm}`);
expectEqual('Jimeng playwright-core', jimengPackage.dependencies?.['playwright-core'], expected.jimeng.playwrightCore);
expectEqual('Jimeng lock version', jimengPackageLock.packages?.['']?.version, expected.jimeng.version);
expectEqual('Jimeng locked playwright-core', jimengPackageLock.packages?.['node_modules/playwright-core']?.version, expected.jimeng.playwrightCore);
expectEqual('n8n runtime engines.node', n8nRuntimePackage.engines?.node, expected.node);
expectEqual('n8n runtime engines.npm', n8nRuntimePackage.engines?.npm, expected.npm);
expectEqual('n8n runtime packageManager', n8nRuntimePackage.packageManager, `npm@${expected.npm}`);
expectEqual('n8n runtime playwright', n8nRuntimePackage.dependencies?.playwright, expected.n8nRuntimeScripts.playwright);
expectEqual('n8n runtime sharp', n8nRuntimePackage.dependencies?.sharp, expected.n8nRuntimeScripts.sharp);
expectEqual('n8n runtime locked playwright', n8nRuntimePackageLock.packages?.['node_modules/playwright']?.version, expected.n8nRuntimeScripts.playwright);
expectEqual('n8n runtime locked sharp', n8nRuntimePackageLock.packages?.['node_modules/sharp']?.version, expected.n8nRuntimeScripts.sharp);

if (process.argv.includes('--full')) {
  expectEqual('n8n', commandVersion('n8n'), expected.n8n);
  const postgresOutput = commandVersion('psql');
  const postgresMajor = Number(postgresOutput.match(/(\d+)(?:\.\d+)?/)?.[1] || 0);
  expectEqual('PostgreSQL client major', postgresMajor, expected.postgresqlMajor);
}

if (errors.length > 0) {
  console.error(`工具链版本验证失败（${errors.length} 项）：`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  const suffix = process.argv.includes('--full') ? `，n8n ${expected.n8n}，PostgreSQL ${expected.postgresqlMajor}.x` : '';
  console.log(`工具链版本验证通过：Node.js ${expected.node}，npm ${expected.npm}，Playwright ${expected.playwright}${suffix}。`);
}
