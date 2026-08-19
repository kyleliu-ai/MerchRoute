import assert from 'node:assert/strict';
import test from 'node:test';
import { createRootRebaser, migrateStateDatabase, rebaseJsonValue, taskId } from './migrate-merchroute-root.mjs';

test('rebases Windows and slash paths without changing child suffixes', () => {
  const rebase = createRootRebaser('G:\\01_n8n-global', 'G:\\01_MerchRoute');
  assert.equal(rebase('G:\\01_n8n-global\\01_monitorFolder\\中文'), 'G:\\01_MerchRoute\\01_monitorFolder\\中文');
  assert.equal(rebase('G:/01_n8n-global/02_generateFolder/job.json'), 'G:/01_MerchRoute/02_generateFolder/job.json');
  assert.equal(rebase('prefix G:\\01_n8n-global\\file'), 'prefix G:\\01_n8n-global\\file');
  assert.equal(rebase('G:\\01_n8n-global-copy\\file'), 'G:\\01_n8n-global-copy\\file');
});

test('rebases only absolute JSON string values', () => {
  const result = rebaseJsonValue({
    source: 'G:\\01_n8n-global\\a',
    items: ['G:/01_n8n-global/b', 'unchanged'],
    message: 'historical path: G:\\01_n8n-global\\c'
  }, createRootRebaser('G:\\01_n8n-global', 'G:\\01_MerchRoute'));
  assert.equal(result.changed, 2);
  assert.deepEqual(result.value, {
    source: 'G:\\01_MerchRoute\\a',
    items: ['G:/01_MerchRoute/b', 'unchanged'],
    message: 'historical path: G:\\01_n8n-global\\c'
  });
});

test('migrates live reviews and pending parameters but preserves history', () => {
  const oldFolder = 'G:\\01_n8n-global\\02_generateFolder\\E001-抠图-下载\\SKU';
  const oldTaskId = taskId('E001', oldFolder);
  const database = {
    schemaVersion: '1.0',
    reviews: [{ taskId: oldTaskId, stageId: 'E001', sourceFolder: oldFolder, sourceFolderName: 'SKU', selectedRelativePaths: [], selectedTargetStageIds: [], status: 'DRAFT', createdAt: '', updatedAt: '' }],
    pendingSubmissions: [{ id: 'p1', taskId: oldTaskId, sourceStageId: 'E001', targetStageId: 'E002', selectedRelativePaths: [], n8nTaskParameters: { outputParentDir: 'G:/01_n8n-global/02_generateFolder/E002' }, conflictPolicy: 'skip', status: 'PENDING', createdAt: '', updatedAt: '' }],
    submissionHistory: [{ sourceFolder: oldFolder }],
    submissionBatches: [],
    appEvents: [{ details: { sourceFolder: oldFolder } }]
  };
  const result = migrateStateDatabase(database, 'G:\\01_n8n-global', 'G:\\01_MerchRoute');
  assert.equal(result.reviewCount, 1);
  assert.equal(result.database.reviews[0].sourceFolder, 'G:\\01_MerchRoute\\02_generateFolder\\E001-抠图-下载\\SKU');
  assert.equal(result.database.pendingSubmissions[0].taskId, result.database.reviews[0].taskId);
  assert.equal(result.database.pendingSubmissions[0].n8nTaskParameters.outputParentDir, 'G:/01_MerchRoute/02_generateFolder/E002');
  assert.equal(result.database.submissionHistory[0].sourceFolder, oldFolder);
  assert.equal(result.database.appEvents[0].details.sourceFolder, oldFolder);
});
