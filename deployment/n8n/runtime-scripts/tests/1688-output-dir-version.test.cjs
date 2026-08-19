'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const {
  isPathWithinRoot,
  reserveExecutionOutputDir,
  reserveVersionedOutputDir,
  validateSafeProductName,
} = require('../1688-output-dir-version.cjs');

const execFileAsync = promisify(execFile);

function withTempDir(action) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1688-output-version-')));
  return Promise.resolve()
    .then(() => action(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('allocates atomic revisions by SKU and continues after a product rename', () => withTempDir((root) => {
  const parentOutputDir = path.join(root, '中文 output');
  const options = { parentOutputDir, SKU: '0000007', allowedOutputRoots: [root] };
  const first = reserveVersionedOutputDir({ ...options, safeProductName: '劳保鞋' });
  const second = reserveVersionedOutputDir({ ...options, safeProductName: '劳保鞋' });
  const renamed = reserveVersionedOutputDir({ ...options, safeProductName: '新名称' });

  assert.equal(first.folderName, '0000007-劳保鞋-R1');
  assert.equal(second.folderName, '0000007-劳保鞋-R2');
  assert.equal(renamed.folderName, '0000007-新名称-R3');
  assert.ok(path.isAbsolute(first.outputDir));
}));

test('concurrent processes reserve unique revision directories', () => withTempDir(async (root) => {
  const parentOutputDir = path.join(root, 'parallel');
  const helperPath = path.resolve(__dirname, '../1688-output-dir-version.cjs');
  const source = [
    "const {reserveVersionedOutputDir}=require(process.argv[1]);",
    "const result=reserveVersionedOutputDir({parentOutputDir:process.argv[2],SKU:'0000008',safeProductName:'并发测试',allowedOutputRoots:[process.argv[3]]});",
    'process.stdout.write(JSON.stringify(result));',
  ].join('');
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    execFileAsync(process.execPath, ['-e', source, helperPath, parentOutputDir, root])
  )));
  const revisions = results.map(({ stdout }) => JSON.parse(stdout).revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6, 7, 8]);
}));

test('rejects paths outside the allowed root and unsafe cross-platform folder names', () => withTempDir((root) => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1688-outside-')));
  try {
    assert.throws(
      () => reserveVersionedOutputDir({
        parentOutputDir: outside,
        SKU: '0000009',
        safeProductName: '产品',
        allowedOutputRoots: [root],
      }),
      (error) => error.code === 'OUTPUT_PATH_OUTSIDE_ALLOWED_ROOT',
    );
    for (const value of ['..', '../escape', 'a/b', 'a\\b', 'CON', 'name.', 'bad:name']) {
      assert.throws(() => validateSafeProductName(value), (error) => error.code === 'PRODUCT_NAME_UNSAFE');
    }
    assert.equal(validateSafeProductName('中文 产品-01'), '中文 产品-01');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

test('path containment treats siblings as outside and descendants as inside', () => withTempDir((root) => {
  assert.equal(isPathWithinRoot(path.join(root, 'child', 'file'), root), true);
  assert.equal(isPathWithinRoot(root, root), true);
  assert.equal(isPathWithinRoot(`${root}-sibling`, root), false);
}));

test('rejects a symlink or junction that escapes an allowed root when supported', async (t) => withTempDir((root) => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), '1688-symlink-target-')));
  const link = path.join(root, 'linked-outside');
  try {
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`Cannot create a test symlink/junction on this host: ${error.code || error.message}`);
      return;
    }
    assert.throws(
      () => reserveVersionedOutputDir({
        parentOutputDir: path.join(link, 'downloads'),
        SKU: '0000010',
        safeProductName: '安全测试',
        allowedOutputRoots: [root],
      }),
      (error) => error.code === 'OUTPUT_PATH_SYMLINK_ESCAPE',
    );
    assert.equal(fs.existsSync(path.join(outside, 'downloads')), false);
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}));

test('uses the exact n8n execution id and refuses to overwrite the same directory', () => withTempDir((root) => {
  const parentOutputDir = path.join(root, 'downloads');
  const options = {
    parentOutputDir,
    SKU: '0000010',
    safeProductName: '布鞋-Pro',
    n8nExecutionId: '6987',
    allowedOutputRoots: [root],
  };
  const first = reserveExecutionOutputDir(options);
  assert.equal(first.folderName, '0000010-布鞋-Pro-6987');
  assert.equal(first.revision, 1);
  assert.throws(() => reserveExecutionOutputDir(options), (error) => error.code === 'OUTPUT_DIR_EXISTS');
  assert.throws(
    () => reserveExecutionOutputDir({ ...options, n8nExecutionId: 'R1' }),
    (error) => error.code === 'EXECUTION_ID_INVALID',
  );
}));
