'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { reserveExecutionOutputDir, reserveVersionedOutputDir } = require('../pdd-output-dir-version.cjs');

const execFileAsync = promisify(execFile);

function withTempDir(action) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-output-version-')));
  return Promise.resolve()
    .then(() => action(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('allocates R1, increments by SKU, and continues after a product rename', () => withTempDir((parentOutputDir) => {
  const first = reserveVersionedOutputDir({ parentOutputDir, SKU: '0000002', safeProductName: '劳保鞋' });
  const second = reserveVersionedOutputDir({ parentOutputDir, SKU: '0000002', safeProductName: '劳保鞋' });
  const renamed = reserveVersionedOutputDir({ parentOutputDir, SKU: '0000002', safeProductName: '新名称' });

  assert.equal(first.folderName, '0000002-劳保鞋-R1');
  assert.equal(second.folderName, '0000002-劳保鞋-R2');
  assert.equal(renamed.folderName, '0000002-新名称-R3');
}));

test('an existing failed-attempt directory consumes its revision', () => withTempDir((parentOutputDir) => {
  fs.mkdirSync(path.join(parentOutputDir, '0000003-旧名称-R4'));
  fs.mkdirSync(path.join(parentOutputDir, '旧格式_20260713_120000'));
  const next = reserveVersionedOutputDir({ parentOutputDir, SKU: '0000003', safeProductName: '当前名称' });
  assert.equal(next.folderName, '0000003-当前名称-R5');
}));

test('concurrent processes reserve unique revision directories', () => withTempDir(async (parentOutputDir) => {
  const helperPath = path.resolve(__dirname, '../pdd-output-dir-version.cjs');
  const source = "const {reserveVersionedOutputDir}=require(process.argv[1]);const result=reserveVersionedOutputDir({parentOutputDir:process.argv[2],SKU:'0000004',safeProductName:'并发测试'});process.stdout.write(JSON.stringify(result));";
  const results = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(process.execPath, ['-e', source, helperPath, parentOutputDir])));
  const revisions = results.map(({ stdout }) => JSON.parse(stdout).revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, [1, 2, 3, 4]);
}));

test('uses the exact n8n execution id and refuses to overwrite the same directory', () => withTempDir((parentOutputDir) => {
  const first = reserveExecutionOutputDir({
    parentOutputDir,
    SKU: '0000009',
    safeProductName: '跑步鞋-Pro',
    n8nExecutionId: '5524',
  });
  assert.equal(first.folderName, '0000009-跑步鞋-Pro-5524');
  assert.equal(first.revision, 1);
  assert.throws(
    () => reserveExecutionOutputDir({
      parentOutputDir,
      SKU: '0000009',
      safeProductName: '跑步鞋-Pro',
      n8nExecutionId: '5524',
    }),
    (error) => error.code === 'OUTPUT_DIR_EXISTS',
  );
  assert.throws(
    () => reserveExecutionOutputDir({ parentOutputDir, SKU: '0000009', safeProductName: '跑步鞋', n8nExecutionId: 'R1' }),
    /digits only/,
  );
}));
