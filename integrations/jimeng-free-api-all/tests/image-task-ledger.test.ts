import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ImageTaskLedger,
  ImageTaskLedgerError,
  buildImageTaskRequestHash,
  fingerprintToken,
  imageTaskLedgerErrorResponse,
  normalizeGenerationConcurrency,
  queryIdempotentBatch,
  submitIdempotentBatch,
} from "../src/api/services/image-task-ledger.ts";
import { uploadImageInputsWithRetry } from "../src/api/services/image-input-upload-retry.ts";

function tempLedger(t: test.TestContext): { ledger: ImageTaskLedger; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-ledger-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ledger: new ImageTaskLedger({ storeDir: dir }), dir };
}

function sourceImages() {
  return [
    { originalIndex: 0, sourceFileName: "01 正面.png", fileSize: 101, mimeType: "image/png" },
    { originalIndex: 1, sourceFileName: "02 侧面.webp", fileSize: 202, mimeType: "image/webp" },
  ];
}

function task(
  suffix = "front",
  submissionId = "SUB-202608060001-test",
  overrides: Record<string, unknown> = {}
) {
  return {
    taskId: suffix,
    view: suffix,
    retryAttempt: 0,
    sourceSubmissionId: submissionId,
    idempotencyKey: `E002:v1:${submissionId}:${suffix}:attempt-0`,
    prompt: `generate ${suffix}`,
    ...overrides,
  };
}

const common = {
  model: "jimeng-4.5",
  ratio: "1:1",
  resolution: "2k",
  sampleStrength: 0.5,
  intelligentRatio: false,
};

function submitInput(
  ledger: ImageTaskLedger,
  tasks: Record<string, any>[],
  overrides: Record<string, any> = {}
) {
  return {
    ledger,
    batchKey: `E002:v1:${tasks[0].sourceSubmissionId}:attempt-0`,
    tasks,
    common,
    images: ["https://oss.invalid/a?signature=old", "https://oss.invalid/b?signature=old"],
    sourceImages: sourceImages(),
    tokens: ["token-a", "token-b"],
    uploadImages: async () => ["uploaded-a", "uploaded-b"],
    submitTask: async ({ task: currentTask }: { task: Record<string, any> }) => ({
      historyId: `history-${currentTask.taskId}`,
      status: "processing" as const,
    }),
    ...overrides,
  };
}

test("requestHash 忽略临时 OSS URL，但包含生成配置与有序源图元数据", () => {
  const first = task("front", "SUB-hash", {
    images: ["https://oss.invalid/a?expires=1"],
    imageUrls: ["https://oss.invalid/a?signature=one"],
  });
  const second = task("front", "SUB-hash", {
    images: ["https://oss.invalid/a?expires=2"],
    imageUrls: ["https://oss.invalid/a?signature=two"],
  });
  const firstHash = buildImageTaskRequestHash({ task: first, common, sourceImages: sourceImages() });
  const secondHash = buildImageTaskRequestHash({ task: second, common, sourceImages: sourceImages() });
  assert.equal(firstHash, secondHash);

  const promptChanged = buildImageTaskRequestHash({
    task: { ...second, prompt: "different prompt" },
    common,
    sourceImages: sourceImages(),
  });
  assert.notEqual(firstHash, promptChanged);

  const imageChanged = buildImageTaskRequestHash({
    task: second,
    common,
    sourceImages: [{ sourceFileName: "different.png", fileSize: 999 }],
  });
  assert.notEqual(firstHash, imageChanged);

  const aliasesHash = buildImageTaskRequestHash({
    task: second,
    common,
    sourceImages: [
      { fileName: "01 正面.png", bytes: 101, mime: "IMAGE/PNG", extension: ".PNG", inputIndex: 0 },
      { fileName: "02 侧面.webp", bytes: 202, contentType: "image/webp", fileExtension: "WEBP", inputIndex: 1 },
    ],
  });
  assert.equal(firstHash, aliasesHash);
});

test("生成并发默认值和上限均为 5", () => {
  assert.equal(normalizeGenerationConcurrency(undefined), 5);
  assert.equal(normalizeGenerationConcurrency(5), 5);
  assert.equal(normalizeGenerationConcurrency(99), 5);
  assert.equal(normalizeGenerationConcurrency(0), 1);
});

test("五个新任务以并发 5 提交，参考图只上传一次", async (t) => {
  const { ledger } = tempLedger(t);
  const tasks = ["front", "side", "top", "back", "bottom"].map((view) => task(view, "SUB-five"));
  let uploadCount = 0;
  let active = 0;
  let maxActive = 0;
  const result = await submitIdempotentBatch(submitInput(ledger, tasks, {
    uploadImages: async () => {
      uploadCount++;
      return ["uploaded-a", "uploaded-b"];
    },
    submitTask: async ({ task: currentTask }: { task: Record<string, any> }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { historyId: `history-${currentTask.taskId}`, status: "processing" as const };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.concurrency, 5);
  assert.equal(result.submittedCount, 5);
  assert.equal(uploadCount, 1);
  assert.equal(maxActive, 5);
});

test("同一 submission 的并发重复请求只提交一次，并复用原 historyId", async (t) => {
  const { ledger } = tempLedger(t);
  const tasks = [task("front", "SUB-concurrent")];
  let submitCount = 0;
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  const input = submitInput(ledger, tasks, {
    submitTask: async () => {
      submitCount++;
      await submitGate;
      return { historyId: "history-only-once", status: "processing" as const };
    },
  });

  const firstPromise = submitIdempotentBatch(input);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secondPromise = submitIdempotentBatch(input);
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSubmit();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(submitCount, 1);
  assert.equal(first.tasks[0].historyId, "history-only-once");
  assert.equal(second.tasks[0].reused, true);

  const replay = await submitIdempotentBatch(input);
  assert.equal(replay.tasks[0].historyId, "history-only-once");
  assert.equal(replay.tasks[0].reused, true);
  assert.equal(submitCount, 1);
});

test("不同 sourceSubmissionId 使用不同键并分别提交", async (t) => {
  const { ledger } = tempLedger(t);
  let submitCount = 0;
  for (const submissionId of ["SUB-one", "SUB-two"]) {
    const currentTask = task("front", submissionId);
    await submitIdempotentBatch(submitInput(ledger, [currentTask], {
      submitTask: async () => {
        submitCount++;
        return { historyId: `history-${submissionId}`, status: "processing" as const };
      },
    }));
  }
  assert.equal(submitCount, 2);
});

test("同一幂等键使用不同 requestHash 时返回 idempotency_conflict", async (t) => {
  const { ledger } = tempLedger(t);
  const original = task("front", "SUB-conflict");
  let submitCount = 0;
  await submitIdempotentBatch(submitInput(ledger, [original], {
    submitTask: async () => {
      submitCount++;
      return { historyId: "history-conflict", status: "processing" as const };
    },
  }));

  await assert.rejects(
    submitIdempotentBatch(submitInput(ledger, [{ ...original, prompt: "changed" }], {
      submitTask: async () => {
        submitCount++;
        return { historyId: "must-not-submit", status: "processing" as const };
      },
    })),
    (error: unknown) => error instanceof ImageTaskLedgerError && error.code === "idempotency_conflict"
  );
  assert.equal(submitCount, 1);
});

test("服务重启后从持久台账复用 historyId", async (t) => {
  const { ledger, dir } = tempLedger(t);
  const tasks = [task("front", "SUB-restart")];
  await submitIdempotentBatch(submitInput(ledger, tasks, {
    submitTask: async () => ({ historyId: "history-persisted", status: "processing" as const }),
  }));
  const persistedContents = fs.readFileSync(path.join(dir, "image-task-store.json"), "utf8");
  assert.doesNotMatch(persistedContents, /token-a|token-b/);
  assert.doesNotMatch(persistedContents, /oss\.invalid/);
  assert.match(persistedContents, /tokenFingerprint/);

  const restarted = new ImageTaskLedger({ storeDir: dir });
  let submitCount = 0;
  const replay = await submitIdempotentBatch(submitInput(restarted, tasks, {
    images: ["https://oss.invalid/a?signature=new", "https://oss.invalid/b?signature=new"],
    submitTask: async () => {
      submitCount++;
      return { historyId: "must-not-submit", status: "processing" as const };
    },
  }));
  assert.equal(replay.tasks[0].historyId, "history-persisted");
  assert.equal(replay.tasks[0].reused, true);
  assert.equal(submitCount, 0);
});

test("提交异常被持久化为 submission_unknown，重复调用不会盲重提", async (t) => {
  const { ledger, dir } = tempLedger(t);
  const tasks = [task("front", "SUB-unknown")];
  let submitCount = 0;
  const input = submitInput(ledger, tasks, {
    submitTask: async () => {
      submitCount++;
      throw new Error("socket closed after submit");
    },
  });
  const first = await submitIdempotentBatch(input);
  assert.equal(first.ok, false);
  assert.equal(first.code, "submission_unknown");
  assert.equal(first.tasks[0].status, "submission_unknown");

  const restarted = new ImageTaskLedger({ storeDir: dir });
  const replay = await submitIdempotentBatch(submitInput(restarted, tasks, {
    submitTask: async () => {
      submitCount++;
      return { historyId: "must-not-submit", status: "processing" as const };
    },
  }));
  assert.equal(replay.tasks[0].status, "submission_unknown");
  assert.equal(replay.tasks[0].reused, true);
  assert.equal(submitCount, 1);
});

test("重启时遗留 reservation 会转为 submission_unknown", async (t) => {
  const { ledger, dir } = tempLedger(t);
  const currentTask = task("front", "SUB-reserved");
  const requestHash = buildImageTaskRequestHash({ task: currentTask, common, sourceImages: sourceImages() });
  await ledger.reserve({
    taskId: currentTask.taskId,
    idempotencyKey: currentTask.idempotencyKey,
    requestHash,
    tokenFingerprint: fingerprintToken("token-a"),
    context: currentTask,
  });
  const restarted = new ImageTaskLedger({ storeDir: dir });
  const record = restarted.get(currentTask.idempotencyKey);
  assert.equal(record?.status, "submission_unknown");
  assert.equal(record?.failCode, "service_restarted_during_submission");
});

test("损坏台账时失败关闭并保留 corrupt 副本", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-ledger-corrupt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "image-task-store.json"), "{broken", "utf8");
  assert.throws(
    () => new ImageTaskLedger({ storeDir: dir }),
    (error: unknown) => error instanceof ImageTaskLedgerError && error.code === "store_corrupt"
  );
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), "{broken");
});

test("status 在 processing 时 ok 仍为 true，并通过 token 指纹适配 token 重排", async (t) => {
  const { ledger } = tempLedger(t);
  const tasks = [task("front", "SUB-status")];
  const submitted = await submitIdempotentBatch(submitInput(ledger, tasks, {
    batchKey: "choose-a-stable-token",
    submitTask: async () => ({ historyId: "history-status", status: "processing" as const }),
  }));
  const stored = ledger.get(tasks[0].idempotencyKey)!;
  const expectedToken = ["token-a", "token-b"].find(
    (candidate) => fingerprintToken(candidate) === stored.tokenFingerprint
  );
  assert.ok(expectedToken);

  let actualToken = "";
  const status = await queryIdempotentBatch({
    ledger,
    batchKey: submitted.batchKey,
    phase: "initial",
    pollCount: 1,
    maxPollCount: 120,
    tasks: submitted.tasks,
    tokens: ["token-b", "token-a"],
    queryTask: async (historyId, token) => {
      actualToken = token;
      return { historyId, status: "processing", rawStatus: 20, count: 0, imageUrls: [] };
    },
  });
  assert.equal(actualToken, expectedToken);
  assert.equal(status.ok, true);
  assert.equal(status.pendingCount, 1);
  assert.equal(status.allTerminal, false);
});

test("status 在成功或明确失败时用 allTerminal 表达终态，ok 保持 true", async (t) => {
  const { ledger } = tempLedger(t);
  const tasks = [task("front", "SUB-terminal"), task("side", "SUB-terminal")];
  const submitted = await submitIdempotentBatch(submitInput(ledger, tasks));
  const terminal = await queryIdempotentBatch({
    ledger,
    tasks: submitted.tasks,
    tokens: ["token-a", "token-b"],
    queryTask: async (historyId) => historyId.endsWith("side")
      ? { historyId, status: "failed", rawStatus: 30, failCode: "2038", count: 0, imageUrls: [] }
      : { historyId, status: "success", rawStatus: 10, count: 4, imageUrls: ["1", "2", "3", "4"] },
  });
  assert.equal(terminal.ok, true);
  assert.equal(terminal.allTerminal, true);
  assert.equal(terminal.successCount, 1);
  assert.equal(terminal.failedCount, 1);
  assert.equal(terminal.pendingCount, 0);
});

test("status 找不到原 token 指纹时明确失败，绝不按数组下标猜测", async (t) => {
  const { ledger } = tempLedger(t);
  const tasks = [task("front", "SUB-token-missing")];
  const submitted = await submitIdempotentBatch(submitInput(ledger, tasks));
  await assert.rejects(
    queryIdempotentBatch({
      ledger,
      tasks: submitted.tasks,
      tokens: ["different-token"],
      queryTask: async () => {
        throw new Error("must not query");
      },
    }),
    (error: unknown) =>
      error instanceof ImageTaskLedgerError && error.code === "token_fingerprint_unavailable"
  );
});

test("参考图上传失败发生在远端提交前，释放 reservation 并从持久台账回读确认", async (t) => {
  const { ledger, dir } = tempLedger(t);
  const tasks = [task("front", "SUB-upload-failed")];
  let submitCount = 0;
  await assert.rejects(
    submitIdempotentBatch(submitInput(ledger, tasks, {
      uploadImages: async () => uploadImageInputsWithRetry({
        inputs: ["first", "second"],
        sourceFileNames: ["01 正面.png", "02 侧面.webp"],
        random: () => 0,
        sleep: async () => undefined,
        uploadOne: async (input) => {
          if (input === "second") {
            throw Object.assign(new Error("图片上传失败: 504 Gateway Time-out"), { status: 504 });
          }
          return "uploaded-first";
        },
      }),
      submitTask: async () => {
        submitCount++;
        return { historyId: "must-not-submit", status: "processing" as const };
      },
    })),
    (error: unknown) => {
      assert.ok(error instanceof ImageTaskLedgerError);
      assert.equal(error.code, "image_upload_pre_submit");
      const response = imageTaskLedgerErrorResponse(error)!;
      assert.equal(response.stage, "tos_binary_upload");
      assert.equal(response.automaticRetriesExhausted, true);
      assert.equal(response.submittedCount, 0);
      assert.equal(response.unknownCount, 0);
      assert.equal(response.reservationState, "released");
      assert.deepEqual(response.tasks, []);
      const details = response.details as Record<string, unknown>;
      assert.equal(details.imageIndex, 2);
      assert.equal(details.fileName, "02 侧面.webp");
      assert.equal(details.status, 504);
      assert.equal(details.attempts, 3);
      return true;
    }
  );
  assert.equal(ledger.get(tasks[0].idempotencyKey), undefined);
  assert.equal(submitCount, 0);
  const readback = new ImageTaskLedger({ storeDir: dir });
  assert.equal(readback.get(tasks[0].idempotencyKey), undefined);

  const retry = await submitIdempotentBatch(submitInput(ledger, tasks));
  assert.equal(retry.ok, true);
  assert.equal(retry.submittedCount, 1);
});

test("reservation 释放无法回读确认时 fail-closed，禁止进入远端提交", async (t) => {
  const { ledger } = tempLedger(t);
  const tasks = [task("front", "SUB-release-unconfirmed")];
  let submitCount = 0;
  ledger.releaseReservation = async () => undefined;

  await assert.rejects(
    submitIdempotentBatch(submitInput(ledger, tasks, {
      uploadImages: async () => {
        throw new Error("upload failed before generation");
      },
      submitTask: async () => {
        submitCount++;
        return { historyId: "must-not-submit", status: "processing" as const };
      },
    })),
    (error: unknown) => {
      assert.ok(error instanceof ImageTaskLedgerError);
      assert.equal(error.code, "reservation_release_unconfirmed");
      const response = imageTaskLedgerErrorResponse(error)!;
      assert.equal(response.code, "reservation_release_unconfirmed");
      assert.equal(response.retryable, false);
      assert.equal(response.reservationState, "unconfirmed");
      assert.notEqual(response.code, "image_upload_pre_submit");
      const details = response.details as Record<string, unknown>;
      assert.deepEqual(details.unconfirmedKeys, [tasks[0].idempotencyKey]);
      return true;
    }
  );

  assert.equal(ledger.get(tasks[0].idempotencyKey)?.status, "reserved");
  assert.equal(submitCount, 0);
});
