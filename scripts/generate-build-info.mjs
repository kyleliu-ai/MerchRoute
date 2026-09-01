import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  collectLocalContentSnapshot,
  readFingerprintScopeContract,
  readRepositoryCommit,
  readWorkingTreeDirty,
  summarizeContentSnapshot
} from '../apps/server/dist/services/content-fingerprint.js';

const repoRoot = process.cwd();
const outputPath = path.join(repoRoot, 'apps/server/dist/build-info.json');
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const contract = await readFingerprintScopeContract(repoRoot);
const snapshot = await collectLocalContentSnapshot(repoRoot, contract);
const summary = summarizeContentSnapshot(snapshot);
const buildInfo = {
  schemaVersion: 1,
  productVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
  configVersion: 'v003',
  builtAt: new Date().toISOString(),
  commitSha: await readRepositoryCommit(repoRoot),
  dirty: await readWorkingTreeDirty(repoRoot),
  scopeVersion: summary.scopeVersion,
  fingerprints: summary.fingerprints,
  fileCounts: summary.fileCounts
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`已生成脱敏构建信息：${path.relative(repoRoot, outputPath)}`);
