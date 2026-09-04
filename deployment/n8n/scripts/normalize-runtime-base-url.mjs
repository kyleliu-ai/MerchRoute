import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOWS } from '../catalog.mjs';
import { normalizeMerchRouteRuntimeUrls, findRuntimeEndpointContractViolations, sha256 } from '../security.mjs';

const n8nRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(n8nRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const changed = [];

for (const entry of WORKFLOWS) {
  const file = path.join(n8nRoot, 'workflows', entry.category, `${entry.id}.json`);
  const before = JSON.parse(await readFile(file, 'utf8'));
  const after = normalizeMerchRouteRuntimeUrls(before);
  const findings = findRuntimeEndpointContractViolations(after);
  if (findings.length) throw new Error(`${entry.id} runtime 地址契约失败：${findings.join('; ')}`);
  const content = `${JSON.stringify(after, null, 2)}\n`;
  const previous = `${JSON.stringify(before, null, 2)}\n`;
  if (content !== previous) {
    await writeFile(file, content, 'utf8');
    changed.push(entry.id);
  }
  const registered = manifest.workflows.find((item) => item.id === entry.id);
  if (!registered) throw new Error(`manifest 未登记 ${entry.id}`);
  registered.sha256 = sha256(content);
}

if (changed.length) manifest.generatedAt = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ workflowCount: WORKFLOWS.length, changedCount: changed.length, changed }, null, 2));
