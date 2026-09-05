import assert from 'node:assert/strict';

export const WB_RETRY_WORKFLOW_ID = 'qYxi3PPmRm7tjK0E';
export const WB_RETRY_NODES = ['Build Step', 'Handle WB Response', 'Normalize Worker Error', 'Finalize Directory'];
const marker = '// MerchRoute WB manual retry protocol v1';
function replace(source, before, after) {
  assert.equal(source.split(before).length, 2, 'WB retry patch anchor missing or ambiguous: ' + before.slice(0, 90));
  return source.replace(before, after);
}
export function patchWbPublishRetry(workflow) {
  assert.equal(workflow.id, WB_RETRY_WORKFLOW_ID);
  const result = structuredClone(workflow);
  for (const name of WB_RETRY_NODES) {
    const node = result.nodes.find(node => node.name === name);
    assert.ok(node?.parameters?.jsCode, name);
    if (node.parameters.jsCode.includes(marker)) continue;
    let code = node.parameters.jsCode;
    if (name === 'Build Step') {
      code = replace(code, "  const notSentReplay = String(runtime.networkRecovery?.phase || '') === 'CARD_WRITE'",
        "  const manualAuthorized = runtime.manualRetry?.contractVersion === 1 && runtime.manualRetry.cardWriteAuthorized === true;\n  const notSentReplay = String(runtime.networkRecovery?.phase || '') === 'CARD_WRITE'");
      code = replace(code, "submissionMode === 'CREATE_ONLY' && !retryAuthorized && !retryReplayNotSent",
        "submissionMode === 'CREATE_ONLY' && !manualAuthorized && !retryAuthorized && !retryReplayNotSent");
      code = replace(code, "let attemptNo = retryAuthorized ? 2 : Number(previousIntent.attemptNo || 1);",
        "let attemptNo = manualAuthorized ? Number(runtime.manualRetry.cardAttemptNo) : retryAuthorized ? 2 : Number(previousIntent.attemptNo || 1);");
      code = replace(code, "attemptNo < 1 || attemptNo > 2", "attemptNo < 1 || (attemptNo > 2 && !manualAuthorized)");
      code = replace(code, "if (attemptNo === 2 && previousIntent.retryIssuedAt && !notSentReplay)",
        "if (!manualAuthorized && attemptNo === 2 && previousIntent.retryIssuedAt && !notSentReplay)");
      code = replace(code, "if (runtime.cardRecovery?.active) {", "if (runtime.cardRecovery?.active && !manualAuthorized) {");
      // Caller cannot bypass the gateway: its grant is consumed together with the new ledger row.
      code = replace(code, "const workDir = fs.realpathSync(path.resolve(importRoot, ...String(job.work_relpath || '').split('/')));",
        `let workCandidate = path.resolve(importRoot, ...String(job.work_relpath || '').split('/'));
if (!fs.existsSync(workCandidate) && job.state === 'FINALIZING' && runtime.price?.verified && runtime.stock?.verified) {
  const successRoot = path.join(importRoot, 'success');
  const matches = [];
  if (fs.existsSync(successRoot)) for (const day of fs.readdirSync(successRoot, { withFileTypes: true })) {
    if (!day.isDirectory() || !/^\\d{4}-\\d{2}-\\d{2}$/.test(day.name)) continue;
    const candidate = path.join(successRoot, day.name, job.task_id);
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (!relativeInside(importRoot, real)) fail('WORK_PATH_ESCAPE', '归档目录逃逸导入根目录');
    const saved = parseJson(fs.readFileSync(path.join(real, '_result.json'), 'utf8'));
    if (saved.taskId !== job.task_id || saved.publicationId !== job.publication_id ||
      saved.payloadSignature !== job.payload_signature || Number(saved.revision) !== Number(job.revision) || saved.state !== 'SUCCEEDED')
      fail('FINALIZE_IDENTITY_CONFLICT', '归档结果与原任务身份不一致');
    matches.push({ real, saved, relative: 'success/' + day.name + '/' + job.task_id });
  }
  if (matches.length !== 1) fail('FINALIZE_EVIDENCE_MISSING', '无法唯一确认已归档的原任务');
  workCandidate = matches[0].real;
  job.work_relpath = matches[0].relative;
  runtime.archivedFinalResult = matches[0].saved;
}
const workDir = fs.realpathSync(workCandidate);`);
    } else if (name === 'Handle WB Response') {
      code = replace(code, '  const candidates = items.filter((item) => {',
        `  const candidates = items.filter((item) => {
    if ((runtime.manualRetry?.ignoredGenericFailureBatches || []).some(previous =>
      previous.batchUUID && previous.updatedAt && previous.batchUUID === item.batchUUID && previous.updatedAt === item.updatedAt)) return false;`);
      code = replace(code, 'function businessFail(code, message, partial = false) {',
        `function businessFail(code, message, partial = false) {
  runtime.lastFailureCheckpoint = { at: new Date().toISOString(), state: job.state,
    stage, requestRef: step.request.requestRef, code, message };
  if (runtime.manualRetry) runtime.manualRetry.cardWriteAuthorized = false;`);
      // Existing successful images are retained on a manual resume, including REPLACE_SELECTED tasks.
      code = replace(code, 'if (runtime.compatibleRecoveryMediaMissingOnly === true) return false;',
        'if (runtime.compatibleRecoveryMediaMissingOnly === true || runtime.manualRetry?.preserveCompletedMedia === true) return false;');
    } else if (name === 'Normalize Worker Error') {
      code = replace(code, "  job.state = 'FAILED';",
        `  runtime.lastFailureCheckpoint = { at: new Date().toISOString(), state: job.state,
    stage: step.request?.stage || job.state, requestRef: step.request?.requestRef || '', code: errorCode, message };
  if (runtime.manualRetry) runtime.manualRetry.cardWriteAuthorized = false;
  job.state = 'FAILED';`);
    } else {
      code = replace(code, 'const product = runtime.product;',
        `const product = runtime.product;
if (runtime.archivedFinalResult) {
  runtime.finalResult = runtime.archivedFinalResult;
  delete runtime.archivedFinalResult;
  runtime.audit = [...(runtime.audit || []), { event: 'FINALIZE_RECOVERED', at: new Date().toISOString() }];
  return [{ json: { action: 'PERSIST', fromState: 'FINALIZING', job: { ...job, state: 'SUCCEEDED',
    result_json: JSON.stringify(runtime), finished_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    last_error_code: '', last_error_message: '', lease_owner: '', lease_expires_at: null } } }];
}`);
      code = replace(code, '  taskId: job.task_id,', '  taskId: job.task_id,\n  payloadSignature: job.payload_signature,');
    }
    node.parameters.jsCode = marker + '\n' + code;
  }
  return result;
}
