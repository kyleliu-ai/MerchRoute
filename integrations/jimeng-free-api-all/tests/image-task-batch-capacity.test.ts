import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ImageTaskLedger,
  fingerprintToken,
  queryIdempotentBatch,
  reserveIdempotentBatchForAsync,
  submitIdempotentBatch,
} from "../src/api/services/image-task-ledger.ts";

function fixture(t: test.TestContext, count: number, attempt = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-batch-capacity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tasks = Array.from({ length: count }, (_, i) => ({
    taskId: String(i + 1),
    idempotencyKey: `S003:v1:SUB-capacity:scene-${i + 1}:attempt-${attempt}`,
    sourceSubmissionId: "SUB-capacity",
    retryAttempt: attempt,
    prompt: `generate scene ${i + 1}`,
  }));
  const ledger = new ImageTaskLedger({ storeDir: dir });
  const input = {
    ledger, tasks,
    batchKey: `S003:v1:SUB-capacity:attempt-${attempt}`,
    common: { model: "jimeng-4.5", ratio: "1:1", resolution: "2k" },
    sourceImages: [{ sourceFileName: "正面.png", fileSize: 4, mimeType: "image/png" }],
    images: ["https://fixture.invalid/front.png"],
    tokens: ["fixture-token"],
    uploadImages: async () => ["fixture-upload"],
    submitTask: async ({ task }: { task: Record<string, any> }) => ({
      historyId: `history-${task.taskId}`, status: "processing" as const,
    }),
  };
  return { ledger, input, dir };
}

for (const count of [1, 5, 6, 7]) {
  test(`${count} tasks submit, poll and replay without losing scenes or raising concurrency`, async (t) => {
    const { ledger, input } = fixture(t, count);
    let uploads = 0, submits = 0, active = 0, peak = 0;
    const submit = {
      ...input, concurrency: 99,
      uploadImages: async () => { uploads++; return ["fixture-upload"]; },
      submitTask: async ({ task }: { task: Record<string, any> }) => {
        submits++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10)); active--;
        return { historyId: `history-${task.taskId}`, status: "processing" as const };
      },
    };
    const result = await submitIdempotentBatch(submit);
    assert.equal(result.taskCount, count);
    assert.equal(result.submittedCount, count);
    assert.equal(result.concurrency, 5);
    assert.equal(peak, Math.min(count, 5));
    assert.equal(uploads, 1);
    const replay = await submitIdempotentBatch(submit);
    assert.equal(replay.reusedCount, count);
    assert.equal(submits, count);
    assert.equal(uploads, 1);
    let pollActive = 0, pollPeak = 0;
    const status = await queryIdempotentBatch({
      ledger, tasks: result.tasks, tokens: input.tokens, concurrency: 99,
      queryTask: async (historyId: string) => {
        pollActive++; pollPeak = Math.max(pollPeak, pollActive);
        await new Promise(resolve => setTimeout(resolve, 10)); pollActive--;
        return { historyId, status: "success" as const, count: 1, imageUrls: [`https://fixture.invalid/${historyId}.png`] };
      },
    });
    assert.equal(status.taskCount, count);
    assert.equal(status.successCount, count);
    assert.equal(status.allTerminal, true);
    assert.equal(pollPeak, Math.min(count, 4));
    assert.deepEqual(status.tasks.map(task => task.taskId), input.tasks.map(task => task.taskId));
  });
}

for (const attempt of [0, 1]) {
  test(`seven async reservations support attempt ${attempt} and idempotent replay`, async (t) => {
    const { input } = fixture(t, 7, attempt);
    const request = { ...input, uploadKey: "fixture-upload-key", tokenFingerprint: fingerprintToken(input.tokens[0]) };
    const result = await reserveIdempotentBatchForAsync(request);
    assert.equal(result.createdCount, 7);
    assert.equal(result.tasks.length, 7);
    const replay = await reserveIdempotentBatchForAsync(request);
    assert.equal(replay.createdCount, 0);
    assert.equal(replay.reusedCount, 7);
  });
}

for (const count of [0, 8]) {
  test(`${count} tasks fail before reservations, upload, submit or query`, async (t) => {
    const { input, dir } = fixture(t, count);
    let calls = 0;
    const invalid = (error: any) => error.code === "invalid_tasks" && /1-7/.test(error.message);
    await assert.rejects(submitIdempotentBatch({
      ...input, uploadImages: async () => { calls++; return []; },
      submitTask: async () => { calls++; return { historyId: "invalid", status: "processing" as const }; },
    }), invalid);
    await assert.rejects(reserveIdempotentBatchForAsync({
      ...input, uploadKey: "fixture-upload-key", tokenFingerprint: fingerprintToken(input.tokens[0]),
    }), invalid);
    await assert.rejects(queryIdempotentBatch({
      ...input, queryTask: async () => { calls++; return { historyId: "invalid", status: "success" as const, count: 1, imageUrls: [] }; },
    }), invalid);
    assert.equal(calls, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
}
