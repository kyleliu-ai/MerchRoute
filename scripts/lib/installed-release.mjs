import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const INSTALLED_MANIFEST = 'installed-release.json';
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/')
    || [...value].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127||c===':') || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new Error('Unsafe release path');
  }
  return value;
}

export function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function assertPlainRoot(root) {
  const absolute = path.resolve(root);
  const resolved = await realpath(absolute);
  const same = process.platform === 'win32' ? absolute.toLowerCase() === resolved.toLowerCase() : absolute === resolved;
  if (!same || !(await lstat(absolute)).isDirectory() || (await lstat(absolute)).isSymbolicLink()) throw new Error('Release root must not use a filesystem alias');
  return absolute;
}

export async function inventoryRelease(root, { onProgress } = {}) {
  root = await assertPlainRoot(root);
  const files = [];
  const names = new Set();
  const pending = [];
  async function visit(relative) {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + item.name : item.name;
      safeRelative(name);
      const key = name.normalize('NFC').toLowerCase();
      if (names.has(key)) throw new Error('Case-colliding release path');
      names.add(key);
      if (name === INSTALLED_MANIFEST) continue;
      if (item.name.toLowerCase() === '.git' || (/^\.env(?:$|[._-])/i.test(item.name) && name !== '.env.example')) throw new Error('Runtime package contains repository state or environment data');
      const absolute = path.join(root, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (!name.split('/').includes('node_modules') || !isWithin(root, target)) throw new Error('External or non-dependency release link');
        files.push({ path:name, kind:'link', target:path.relative(root, target).split(path.sep).join('/') });
      } else if (info.isDirectory()) await visit(name);
      else if (info.isFile()) pending.push({path:name,absolute,bytes:info.size});
      else throw new Error('Unsupported runtime file type');
    }
  }
  await visit('');
  let cursor=0,done=0;
  await Promise.all(Array.from({length:Math.min(32,pending.length)},async()=>{
    while(cursor<pending.length){const item=pending[cursor++];const data=await readFile(item.absolute);
      if(data.length!==item.bytes)throw new Error('Release file changed during inventory');
      files.push({path:item.path,kind:'file',bytes:data.length,sha256:digest(data)});
      done++;if(onProgress&&done%1000===0)onProgress({filesRead:done,total:pending.length});
    }
  }));
  return files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
}

export async function verifyInstalledRelease(root, expectedManifestSha256) {
  root = await assertPlainRoot(root);
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha256 || '')) throw new Error('Installed release requires an externally pinned manifest hash');
  const manifestPath = path.join(root, INSTALLED_MANIFEST);
  if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) throw new Error('Invalid installed manifest file');
  const bytes = await readFile(manifestPath);
  if (digest(bytes) !== expectedManifestSha256) throw new Error('Installed manifest identity changed');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'MERCHROUTE_INSTALLED_RELEASE'
    || !/^\d+\.\d+\.\d+$/.test(manifest.productVersion || '')
    || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '')
    || !/^[a-f0-9]{40}$/.test(manifest.sourceTree || '')
    || !Array.isArray(manifest.files) || !Array.isArray(manifest.sourceFiles) || !manifest.sourceFiles.length) throw new Error('Invalid installed release contract');
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Installed dependencies target another platform');
  if (manifest.nodeVersion !== process.versions.node) throw new Error('Installed release Node version mismatch');
  const actual = await inventoryRelease(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Installed files changed, missing, or undeclared');
  const entries = [];
  const sourceNames = new Set();
  for (const item of manifest.sourceFiles) {
    safeRelative(item.path);
    if (sourceNames.has(item.path) || !['100644','100755'].includes(item.mode)) throw new Error('Invalid source inventory');
    sourceNames.add(item.path);
    const data = await readFile(path.join(root, item.path));
    const sha = gitBlob(data);
    if (sha !== item.sha) throw new Error('Installed source identity mismatch');
    entries.push({path:item.path,mode:item.mode,type:'blob',sha});
  }
  const packageJson = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const build = JSON.parse(await readFile(path.join(root,'apps/server/dist/build-info.json'),'utf8'));
  if (packageJson.version !== manifest.productVersion || build.productVersion !== manifest.productVersion
    || build.commitSha !== manifest.sourceCommit || build.dirty || build.builtAt !== manifest.builtAt) throw new Error('Installed version/build identity mismatch');
  return { manifest, entries, build };
}
