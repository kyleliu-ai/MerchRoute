import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {
  BLOCKING_EXECUTION_STATUSES,
  E007_WORKFLOW_ID,
  assertValidTablePrefix,
  summarizeExecutionGuard,
} from './n8n-upgrade-guard.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

test('E007 upgrade guard treats all n8n non-terminal states as blocking', () => {
  assert.deepEqual(BLOCKING_EXECUTION_STATUSES, ['new', 'running', 'unknown', 'waiting']);
  const report = summarizeExecutionGuard([{
    id: '42',
    status: 'running',
    startedAt: '2026-08-17T00:00:00.000Z',
    waitTill: null,
  }], 'pre-stop');
  assert.equal(report.workflowId, E007_WORKFLOW_ID);
  assert.equal(report.safe, false);
  assert.equal(report.blockingExecutionCount, 1);
  assert.deepEqual(report.blockers[0], {
    id: '42',
    status: 'running',
    startedAt: '2026-08-17T00:00:00.000Z',
    waitTill: null,
  });
  assert.equal(report.databaseMutated, false);
  assert.equal(summarizeExecutionGuard([], 'post-start').safe, true);
});

test('E007 upgrade guard rejects unsafe n8n table prefixes', () => {
  assert.equal(assertValidTablePrefix('n8n_'), 'n8n_');
  assert.throws(() => assertValidTablePrefix('public.execution; DROP TABLE'), /非法字符/);
});

test('E007 upgrade guard dry-run is read-only and does not require a database', () => {
  const result = spawnSync(process.execPath, [
    'deployment/scripts/n8n-upgrade-guard.mjs',
    '--phase=post-start',
    '--app-home=/definitely/not/created',
    '--dry-run',
  ], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.readOnly, true);
  assert.equal(output.phase, 'post-start');
  assert.equal(output.workflowId, E007_WORKFLOW_ID);
  assert.deepEqual(output.blockingStatuses, ['new', 'running', 'unknown', 'waiting']);
});
