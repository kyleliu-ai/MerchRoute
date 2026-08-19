import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { AsyncImageBatchCoordinator } from "../src/api/services/async-image-batch-coordinator.ts";
import {
  ImageTaskLedger,
  adoptRecoverableAsyncReservations,
  buildImageTaskRequestHash,
  fingerprintToken,
  reserveIdempotentBatchForAsync,
} from "../src/api/services/image-task-ledger.ts";
import {
  IMAGE_UPLOAD_REUSE_TTL_MS,
  ImageUploadStore,
  ImageUploadStoreError,
  expectedE002UploadKey,
} from "../src/api/services/image-upload-store.ts";

const COMMON = {
  model: "jimeng-4.5",
  ratio: "1:1",
  resolution: "2k",
};

function sourceImages(count = 1) {
  return Array.from({ length: count }, (_entry, index) => ({
    sourceFileName: `${String(index + 1).padStart(2, "0")}.png`,
    fileSize: 4,
    mimeType: "image/png",
  }));
}

function sourceBytes(index: number): Buffer {
  return Buffer.from(String(index + 1).repeat(4));
}

function taskFor(submissionId: string, view = "front", attempt = 0) {
  return {
    taskId: view === "front" ? "01" : "02",
    view,
    sourceSubmissionId: submissionId,
    retryAttempt: attempt,
    idempotencyKey: `E002:v1:${submissionId}:${view}:attempt-${attempt}`,
    prompt: `generate ${view}`,
  };
}

function fixture(t: test.TestContext, now?: () => Date) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-async-route-regression-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    ledger: new ImageTaskLedger({ storeDir: dir, now }),
    uploadStore: new ImageUploadStore({ storeDir: dir, now }),
  };
}

async function prepare(input: {
  ledger: ImageTaskLedger;
  uploadStore: ImageUploadStore;
  submissionId: string;
  attempt?: number;
  views?: string[];
  imageCount?: number;
  token?: string;
}) {
  const attempt = input.attempt || 0;
  const token = input.token || "token-a";
  const uploadKey = expectedE002UploadKey(input.submissionId);
  const batchKey = `E002:v1:${input.submissionId}:attempt-${attempt}`;
  const tasks = (input.views || ["front"]).map((view) => taskFor(input.submissionId, view, attempt));
  const metadata = sourceImages(input.imageCount || 1);
  const reserved = await reserveIdempotentBatchForAsync({
    ledger: input.ledger,
    batchKey,
    tasks,
    common: COMMON,
    sourceImages: metadata,
    tokenFingerprint: fingerprintToken(token),
    uploadKey,
  });
  let sourceReadCount = 0;
  const accepted = await input.uploadStore.acceptSources({
    uploadKey,
    sourceSubmissionId: input.submissionId,
    sourceImages: metadata,
    tokenFingerprint: fingerprintToken(token),
    readSource: async (index) => {
      sourceReadCount++;
      return sourceBytes(index);
    },
  });
  return {
    accepted,
    batchKey,
    metadata,
    reserved,
    sourceReadCount,
    tasks,
    token,
    uploadKey,
  };
}

test("ready 缓存在 acceptedAt 后 16 分钟仍可跨重启供 attempt-1 零上传提交", async (t) => {
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  const now = () => new Date(nowMs);
  const { dir, ledger, uploadStore } = fixture(t, now);
  const initial = await prepare({ ledger, uploadStore, submissionId: "SUB-late-ready" });
  let uploadCount = 0;
  const initialCoordinator = new AsyncImageBatchCoordinator({
    ledger,
    uploadStore,
    log: { info() {}, error() {} },
  });
  await initialCoordinator.start({
    batchKey: initial.batchKey,
    uploadKey: initial.uploadKey,
    token: initial.token,
    tokenFingerprint: fingerprintToken(initial.token),
    common: COMMON,
    reservations: initial.reserved.reservations,
    cacheHit: false,
    uploadOne: async ({ imageIndex }) => {
      uploadCount++;
      return `tos-${imageIndex}`;
    },
    submitTask: async () => ({ historyId: "history-initial" }),
  }).promise;
  assert.equal(uploadCount, 1);

  nowMs += 16 * 60 * 1000;
  const restartedLedger = new ImageTaskLedger({ storeDir: dir, now });
  const restartedStore = new ImageUploadStore({ storeDir: dir, now });
  assert.equal(restartedStore.isReusableReady(initial.uploadKey), true);
  const retry = await prepare({
    ledger: restartedLedger,
    uploadStore: restartedStore,
    submissionId: "SUB-late-ready",
    attempt: 1,
  });
  assert.equal(retry.accepted.cacheHit, true);
  assert.equal(retry.sourceReadCount, 0);

  const restartedCoordinator = new AsyncImageBatchCoordinator({
    ledger: restartedLedger,
    uploadStore: restartedStore,
    log: { info() {}, error() {} },
  });
  await restartedCoordinator.start({
    batchKey: retry.batchKey,
    uploadKey: retry.uploadKey,
    token: retry.token,
    tokenFingerprint: fingerprintToken(retry.token),
    common: COMMON,
    reservations: retry.reserved.reservations,
    cacheHit: true,
    uploadOne: async () => {
      uploadCount++;
      throw new Error("ready TTL 内不应重传 TOS");
    },
    submitTask: async () => ({ historyId: "history-attempt-1" }),
  }).promise;
  assert.equal(uploadCount, 1);
  assert.equal(restartedLedger.get(retry.tasks[0].idempotencyKey)?.historyId, "history-attempt-1");
  assert.equal(restartedLedger.get(retry.tasks[0].idempotencyKey)?.context?.asyncBatchCacheHit, true);
  assert.equal(restartedLedger.get(retry.tasks[0].idempotencyKey)?.context?.asyncBatchUploadDurationMs, 0);
});

test("重启后真实 re-reserve(created=false) 经 adopt 恢复，并仅补传未确认图片", async (t) => {
  const { dir, ledger, uploadStore } = fixture(t);
  const prepared = await prepare({
    ledger,
    uploadStore,
    submissionId: "SUB-real-adopt",
    imageCount: 2,
  });
  await uploadStore.markUploadStarted(prepared.uploadKey, 0);
  await uploadStore.markImageUploaded(prepared.uploadKey, 0, "tos-persisted-1");
  await uploadStore.markUploadStarted(prepared.uploadKey, 1);
  await ledger.setReservedAsyncPhase(
    prepared.tasks[0].idempotencyKey,
    prepared.reserved.reservations[0].requestHash,
    "uploading"
  );

  const restartedLedger = new ImageTaskLedger({ storeDir: dir });
  const restartedStore = new ImageUploadStore({ storeDir: dir });
  const replay = await reserveIdempotentBatchForAsync({
    ledger: restartedLedger,
    batchKey: prepared.batchKey,
    tasks: prepared.tasks,
    common: COMMON,
    sourceImages: prepared.metadata,
    tokenFingerprint: fingerprintToken(prepared.token),
    uploadKey: prepared.uploadKey,
  });
  assert.equal(replay.reservations[0].created, false);
  const adopted = adoptRecoverableAsyncReservations(restartedLedger, replay.reservations);
  assert.equal(adopted[0].needsSubmission, true);
  assert.equal(adopted[0].releaseOnPreSubmit, true);

  const uploadedIndexes: number[] = [];
  const coordinator = new AsyncImageBatchCoordinator({
    ledger: restartedLedger,
    uploadStore: restartedStore,
    log: { info() {}, error() {} },
  });
  await coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common: COMMON,
    reservations: adopted,
    cacheHit: false,
    uploadOne: async ({ imageIndex }) => {
      uploadedIndexes.push(imageIndex);
      return `tos-recovered-${imageIndex}`;
    },
    submitTask: async () => ({ historyId: "history-recovered" }),
  }).promise;
  assert.deepEqual(uploadedIndexes, [2]);
  assert.equal(restartedStore.get(prepared.uploadKey)?.images[0].uploadedImageId, "tos-persisted-1");
  assert.equal(new ImageTaskLedger({ storeDir: dir }).get(prepared.tasks[0].idempotencyKey)?.historyId, "history-recovered");
});

test("sibling abort 后即使底层上传迟到完成，failed store 与 reservation 清零也不会回退", async (t) => {
  const { dir, ledger, uploadStore } = fixture(t);
  const prepared = await prepare({
    ledger,
    uploadStore,
    submissionId: "SUB-late-sibling",
    imageCount: 2,
  });
  let siblingStartedResolve!: () => void;
  const siblingStarted = new Promise<void>((resolve) => { siblingStartedResolve = resolve; });
  let lateUploadResolve!: () => void;
  const lateUpload = new Promise<void>((resolve) => { lateUploadResolve = resolve; });
  const coordinator = new AsyncImageBatchCoordinator({
    ledger,
    uploadStore,
    log: { info() {}, error() {} },
  });
  const job = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common: COMMON,
    reservations: prepared.reserved.reservations,
    cacheHit: false,
    uploadOne: async ({ imageIndex }) => {
      if (imageIndex === 1) {
        await siblingStarted;
        throw Object.assign(new Error("HTTP 400"), { status: 400 });
      }
      siblingStartedResolve();
      // Deliberately ignore AbortSignal to model a transport that resolves late.
      await lateUpload;
      return "late-tos-id";
    },
    submitTask: async () => ({ historyId: "must-not-submit" }),
  });
  await assert.rejects(job.promise, /400/);
  assert.equal(uploadStore.get(prepared.uploadKey)?.status, "failed_pre_submit");
  assert.equal(ledger.get(prepared.tasks[0].idempotencyKey), undefined);
  assert.equal(new ImageTaskLedger({ storeDir: dir }).get(prepared.tasks[0].idempotencyKey), undefined);

  lateUploadResolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(uploadStore.get(prepared.uploadKey)?.status, "failed_pre_submit");
  assert.equal(uploadStore.get(prepared.uploadKey)?.images.some((image) => image.uploadedImageId === "late-tos-id"), false);
  assert.equal(new ImageTaskLedger({ storeDir: dir }).get(prepared.tasks[0].idempotencyKey), undefined);
});

test("mixed reused history + new reserved 上传失败时只清新任务并保留旧 historyId", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const submissionId = "SUB-mixed-preserve";
  const uploadKey = expectedE002UploadKey(submissionId);
  const token = "token-a";
  const front = taskFor(submissionId, "front");
  const side = taskFor(submissionId, "side");
  const initial = await reserveIdempotentBatchForAsync({
    ledger,
    batchKey: `E002:v1:${submissionId}:attempt-0`,
    tasks: [front],
    common: COMMON,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    uploadKey,
  });
  await ledger.submitReserved(front.idempotencyKey, initial.reservations[0].requestHash, async () => ({
    historyId: "history-front-existing",
  }));
  const mixed = await reserveIdempotentBatchForAsync({
    ledger,
    batchKey: `E002:v1:${submissionId}:attempt-0`,
    tasks: [front, side],
    common: COMMON,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    uploadKey,
  });
  await uploadStore.acceptSources({
    uploadKey,
    sourceSubmissionId: submissionId,
    sourceImages: sourceImages(),
    tokenFingerprint: fingerprintToken(token),
    readSource: async () => sourceBytes(0),
  });

  const coordinator = new AsyncImageBatchCoordinator({
    ledger,
    uploadStore,
    log: { info() {}, error() {} },
  });
  const job = coordinator.start({
    batchKey: `E002:v1:${submissionId}:attempt-0`,
    uploadKey,
    token,
    tokenFingerprint: fingerprintToken(token),
    common: COMMON,
    reservations: adoptRecoverableAsyncReservations(ledger, mixed.reservations),
    cacheHit: false,
    uploadOne: async () => { throw Object.assign(new Error("HTTP 400"), { status: 400 }); },
    submitTask: async () => ({ historyId: "must-not-submit" }),
  });
  await assert.rejects(job.promise, /400/);
  assert.equal(ledger.get(front.idempotencyKey)?.historyId, "history-front-existing");
  assert.equal(ledger.get(front.idempotencyKey)?.status, "processing");
  assert.equal(ledger.get(side.idempotencyKey), undefined);
});

test("慢 preflight 保持 ready，生成边界后完成且同键重入不会再次提交", async (t) => {
  const { ledger, uploadStore } = fixture(t);
  const prepared = await prepare({ ledger, uploadStore, submissionId: "SUB-no-resubmit" });
  let submitCount = 0;
  let paidPostCount = 0;
  let finishPreflight!: () => void;
  const preflight = new Promise<void>((resolve) => { finishPreflight = resolve; });
  const coordinator = new AsyncImageBatchCoordinator({
    ledger,
    uploadStore,
    log: { info() {}, error() {} },
  });
  const firstJob = coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common: COMMON,
    reservations: prepared.reserved.reservations,
    cacheHit: false,
    uploadOne: async () => "tos-stable",
    submitTask: async ({ onBeforeRemoteSubmit }) => {
      submitCount++;
      await preflight;
      await onBeforeRemoteSubmit();
      paidPostCount++;
      return { historyId: "history-once" };
    },
  });
  await waitFor(() => ledger.get(prepared.tasks[0].idempotencyKey)?.context?.asyncPhase === "ready");
  assert.equal(ledger.get(prepared.tasks[0].idempotencyKey)?.status, "reserved");
  assert.equal(paidPostCount, 0);
  finishPreflight();
  await firstJob.promise;
  assert.equal(ledger.get(prepared.tasks[0].idempotencyKey)?.status, "processing");

  const replay = await reserveIdempotentBatchForAsync({
    ledger,
    batchKey: prepared.batchKey,
    tasks: prepared.tasks,
    common: COMMON,
    sourceImages: prepared.metadata,
    tokenFingerprint: fingerprintToken(prepared.token),
    uploadKey: prepared.uploadKey,
  });
  const adopted = adoptRecoverableAsyncReservations(ledger, replay.reservations);
  assert.equal(adopted[0].needsSubmission, false);
  await coordinator.start({
    batchKey: prepared.batchKey,
    uploadKey: prepared.uploadKey,
    token: prepared.token,
    tokenFingerprint: fingerprintToken(prepared.token),
    common: COMMON,
    reservations: adopted,
    cacheHit: true,
    uploadOne: async () => { throw new Error("不应重传"); },
    submitTask: async () => {
      submitCount++;
      return { historyId: "duplicate-history" };
    },
  }).promise;
  assert.equal(submitCount, 1);
  assert.equal(paidPostCount, 1);
  assert.equal(ledger.get(prepared.tasks[0].idempotencyKey)?.historyId, "history-once");
  assert.equal(ledger.get(prepared.tasks[0].idempotencyKey)?.status, "processing");
});

// Route helpers close over module-level stores. Seed their persistent state
// before importing the route, then use sync loader hooks only to replace base
// image-service dependencies that are not part of this offline patch tree.
const routeStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), "jimeng-route-helper-"));
let routeNowMs = Date.parse("2026-08-12T00:00:00.000Z");
const routeNow = () => new Date(routeNowMs);
const routeLedgerSeed = new ImageTaskLedger({ storeDir: routeStoreDir, now: routeNow });
const routeUploadSeed = new ImageUploadStore({ storeDir: routeStoreDir, now: routeNow });
const affinitySubmissionId = "SUB-ledger-affinity";
const affinityUploadKey = expectedE002UploadKey(affinitySubmissionId);
const affinityToken = "token-affinity-original";
const affinityTask = taskFor(affinitySubmissionId);
await reserveIdempotentBatchForAsync({
  ledger: routeLedgerSeed,
  batchKey: `E002:v1:${affinitySubmissionId}:attempt-0`,
  tasks: [affinityTask],
  common: COMMON,
  sourceImages: sourceImages(),
  tokenFingerprint: fingerprintToken(affinityToken),
  uploadKey: affinityUploadKey,
});
await routeUploadSeed.acceptSources({
  uploadKey: affinityUploadKey,
  sourceSubmissionId: affinitySubmissionId,
  sourceImages: sourceImages(),
  tokenFingerprint: fingerprintToken(affinityToken),
  readSource: async () => sourceBytes(0),
});
await routeUploadSeed.markUploadStarted(affinityUploadKey, 0);
await routeUploadSeed.markImageUploaded(affinityUploadKey, 0, "tos-affinity");
routeNowMs += IMAGE_UPLOAD_REUSE_TTL_MS + 1;
assert.deepEqual(routeUploadSeed.cleanupExpired().removedUploadKeys, [affinityUploadKey]);

const failedSubmissionId = "SUB-wire-failure";
const failedUploadKey = expectedE002UploadKey(failedSubmissionId);
await routeUploadSeed.acceptSources({
  uploadKey: failedUploadKey,
  sourceSubmissionId: failedSubmissionId,
  sourceImages: sourceImages(),
  tokenFingerprint: fingerprintToken("token-wire"),
  readSource: async () => sourceBytes(0),
});
await routeUploadSeed.failBeforeSubmit(failedUploadKey, {
  code: "upload_deadline_exceeded",
  stage: "upload_deadline",
  message: "offline deadline",
});

type RouteHarness = {
  download: (input: string | Buffer, signal?: AbortSignal) => Promise<Buffer>;
  upload: (bytes: Buffer, token: string, options: Record<string, unknown>) => Promise<string>;
  submit: (...args: unknown[]) => Promise<{ historyId: string }>;
  query: (...args: unknown[]) => Promise<Record<string, unknown>>;
};

const routeHarness: RouteHarness = {
  download: async (input) => Buffer.isBuffer(input) ? input : Buffer.from(String(input)),
  upload: async () => "tos-route-default",
  submit: async () => ({ historyId: "history-route-default" }),
  query: async () => ({ status: "processing" }),
};
(globalThis as any).__JIMENG_ASYNC_ROUTE_TEST_HARNESS__ = routeHarness;

const patchRoot = path.resolve(import.meta.dirname, "..");
const stubs: Record<string, string> = {
  "@/lib/request/Request.ts": "export default class Request {}",
  "@/api/controllers/images.ts": `
    const harness = () => globalThis.__JIMENG_ASYNC_ROUTE_TEST_HARNESS__;
    export const generateImages = () => { throw new Error("not used"); };
    export const generateImageComposition = () => { throw new Error("not used"); };
    export const downloadImageInputToBuffer = (input, signal) => harness().download(input, signal);
    export const uploadImageInputs = () => { throw new Error("not used"); };
    export const uploadImageBufferForAsyncTask = (bytes, token, options) => harness().upload(bytes, token, options);
    export const submitImageCompositionFromUploadedIds = async (...args) => {
      const options = args.at(-1);
      if (typeof options?.onBeforeRemoteSubmit === "function") {
        await options.onBeforeRemoteSubmit();
      }
      return harness().submit(...args);
    };
    export const queryImageCompositionTask = (...args) => harness().query(...args);
  `,
  "@/api/controllers/core.ts": `
    export const tokenSplit = (value) => String(value || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  `,
  "@/lib/util.ts": "export default {};",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubs, specifier)) {
      return { shortCircuit: true, url: `jimeng-test-stub:${encodeURIComponent(specifier)}` };
    }
    if (specifier === "lodash") return { shortCircuit: true, url: "jimeng-test-stub:lodash" };
    if (specifier.startsWith("@/api/services/")) {
      return {
        shortCircuit: true,
        url: pathToFileURL(path.join(patchRoot, "src", specifier.slice(2))).href,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "jimeng-test-stub:lodash") {
      return {
        shortCircuit: true,
        format: "module",
        source: `export default {
          isArray: Array.isArray,
          isString: (value) => typeof value === "string",
          sample: (values) => values[0],
        };`,
      };
    }
    if (url.startsWith("jimeng-test-stub:")) {
      return {
        shortCircuit: true,
        format: "module",
        source: stubs[decodeURIComponent(url.slice("jimeng-test-stub:".length))],
      };
    }
    return nextLoad(url, context);
  },
});

process.env.IMAGE_TASK_STORE_DIR = routeStoreDir;
const routeModule = await import("../src/api/routes/images.ts");

test("upload store TTL 清理后，route 从 ledger.findByUploadKey 恢复 token 亲和", () => {
  const reorderedTokens = ["token-other", affinityToken];
  const resolved = routeModule.resolveAffinityToken(affinityUploadKey, reorderedTokens, []);
  assert.equal(resolved.token, affinityToken);
  assert.equal(resolved.tokenFingerprint, fingerprintToken(affinityToken));
  assert.equal(new ImageUploadStore({ storeDir: routeStoreDir }).get(affinityUploadKey), undefined);
  assert.equal(new ImageTaskLedger({ storeDir: routeStoreDir }).findByUploadKey(affinityUploadKey).length, 1);
});

test("failed_pre_submit 与 mixed unknown 的 wire shape 保持明确且不互相覆盖", () => {
  const failed = routeModule.uploadFailureResponse(
    new ImageUploadStoreError(
      "upload_deadline_exceeded",
      "offline deadline",
      { stage: "upload_deadline" }
    ),
    `E002:v1:${failedSubmissionId}:attempt-0`,
    failedUploadKey,
    []
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.accepted, false);
  assert.equal(failed.code, "upload_deadline_exceeded");
  assert.equal(failed.failureCode, "upload_deadline_exceeded");
  assert.equal(failed.batchStatus, "failed_pre_submit");
  assert.equal(failed.nextPollAfterSeconds, 0);
  assert.equal(failed.submittedCount, 0);
  assert.equal(failed.unknownCount, 0);
  assert.equal(failed.reservationState, "released");
  assert.deepEqual(failed.tasks, []);
  assert.equal(failed.upload.failureCode, "upload_deadline_exceeded");

  const mixed = routeModule.decorateAsyncResponse({
    ok: true,
    batchKey: "E002:v1:SUB-mixed-wire:attempt-0",
    submittedCount: 1,
    unknownCount: 1,
    tasks: [
      { idempotencyKey: "known", status: "processing", historyId: "history-known" },
      { idempotencyKey: "unknown", status: "submission_unknown", historyId: "" },
    ],
  }, expectedE002UploadKey("SUB-mixed-wire"));
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, "submission_unknown");
  assert.equal(mixed.batchStatus, "processing");
  assert.equal(mixed.nextPollAfterSeconds, 5);
  assert.equal(mixed.tasks[0].historyId, "history-known");
  assert.equal(mixed.tasks[1].status, "submission_unknown");
  assert.equal(routeModule.deriveBatchStatus([], "failed_pre_submit"), "failed_pre_submit");
});

function mockRouteRequest(body: Record<string, unknown>, authorization = "token-route") {
  return {
    body,
    headers: { authorization },
    validate() { return this; },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timeout");
}

test("route 的 active batchKey 冲突失败关闭且不遗留第二组 reservation", async () => {
  const submissionId = "SUB-route-batch-conflict";
  const uploadKey = expectedE002UploadKey(submissionId);
  const batchKey = `E002:v1:${submissionId}:attempt-0`;
  const front = taskFor(submissionId, "front");
  const side = taskFor(submissionId, "side");
  let releaseUpload!: () => void;
  const uploadBlocked = new Promise<void>((resolve) => { releaseUpload = resolve; });
  routeHarness.upload = async () => {
    await uploadBlocked;
    return "tos-route-conflict";
  };
  routeHarness.submit = async (...args) => {
    const options = args.at(-1) as Record<string, unknown> | undefined;
    return { historyId: `history-${String(options?.remoteSubmitId || "front")}` };
  };

  const bodyBase = {
    batchKey,
    uploadKey,
    sourceSubmissionId: submissionId,
    common: COMMON,
    images: [sourceBytes(0)],
    sourceImages: sourceImages(),
    concurrency: 5,
  };
  const handler = routeModule.default.post["/tasks/batch"];
  try {
    const first = await handler(mockRouteRequest({ ...bodyBase, tasks: [front] }) as any);
    assert.equal(first.accepted, true);
    assert.equal(first.backgroundStarted, true);

    const conflicting = await handler(mockRouteRequest({ ...bodyBase, tasks: [side] }) as any);
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.code, "batch_conflict");

    const persistedDuringConflict = new ImageTaskLedger({ storeDir: routeStoreDir });
    assert.equal(persistedDuringConflict.get(front.idempotencyKey)?.status, "reserved");
    assert.equal(
      persistedDuringConflict.get(side.idempotencyKey),
      undefined,
      "batch_conflict 必须回滚本次新建的 reservation"
    );
    assert.deepEqual(
      persistedDuringConflict.findByUploadKey(uploadKey).map((record) => record.idempotencyKey),
      [front.idempotencyKey]
    );
  } finally {
    releaseUpload();
  }
  await waitFor(() => Boolean(new ImageTaskLedger({ storeDir: routeStoreDir }).get(front.idempotencyKey)?.historyId));
});

test("同键 POST 复查复用原 history，submittedCount 为本次新增 0", async () => {
  const submissionId = "SUB-route-idempotent-replay";
  const uploadKey = expectedE002UploadKey(submissionId);
  const batchKey = `E002:v1:${submissionId}:attempt-0`;
  const task = taskFor(submissionId, "front");
  let uploadCount = 0;
  let submitCount = 0;
  routeHarness.upload = async () => { uploadCount++; return "tos-route-replay"; };
  routeHarness.submit = async () => { submitCount++; return { historyId: "history-route-replay" }; };
  const handler = routeModule.default.post["/tasks/batch"];
  const body = {
    batchKey, uploadKey, sourceSubmissionId: submissionId, common: COMMON,
    images: [sourceBytes(0)], sourceImages: sourceImages(), concurrency: 5, tasks: [task],
  };
  const first = await handler(mockRouteRequest(body, "token-route-replay") as any);
  assert.equal(first.accepted, true);
  await waitFor(() => new ImageTaskLedger({ storeDir: routeStoreDir }).get(task.idempotencyKey)?.historyId === "history-route-replay");
  const beforeLedger = new ImageTaskLedger({ storeDir: routeStoreDir }).get(task.idempotencyKey);
  const beforeUpload = new ImageUploadStore({ storeDir: routeStoreDir }).get(uploadKey);

  const replay = await handler(mockRouteRequest(body, "token-route-replay") as any);
  assert.equal(replay.accepted, true);
  assert.equal(replay.reusedCount, 1);
  assert.equal(replay.submittedCount, 0);
  assert.equal(replay.existingHistoryCount, 1);
  assert.equal(replay.tasks[0].historyId, "history-route-replay");
  assert.equal(uploadCount, 1);
  assert.equal(submitCount, 1);
  assert.deepEqual(new ImageTaskLedger({ storeDir: routeStoreDir }).get(task.idempotencyKey), beforeLedger);
  assert.deepEqual(new ImageUploadStore({ storeDir: routeStoreDir }).get(uploadKey), beforeUpload);
});

test("upload_idempotency_conflict 只回滚本次 attempt，不污染既有 ready 上传集", async () => {
  const submissionId = "SUB-route-upload-conflict";
  const uploadKey = expectedE002UploadKey(submissionId);
  const initialTask = taskFor(submissionId, "front", 0);
  const initialBatchKey = `E002:v1:${submissionId}:attempt-0`;
  routeHarness.upload = async () => "tos-shared-original";
  routeHarness.submit = async () => ({ historyId: "history-original" });
  const handler = routeModule.default.post["/tasks/batch"];
  const initial = await handler(mockRouteRequest({
    batchKey: initialBatchKey,
    uploadKey,
    sourceSubmissionId: submissionId,
    common: COMMON,
    images: [sourceBytes(0)],
    sourceImages: sourceImages(),
    concurrency: 5,
    tasks: [initialTask],
  }, "token-route-conflict") as any);
  assert.equal(initial.accepted, true);
  await waitFor(() => new ImageTaskLedger({ storeDir: routeStoreDir }).get(initialTask.idempotencyKey)?.historyId === "history-original");

  const before = new ImageUploadStore({ storeDir: routeStoreDir }).get(uploadKey);
  assert.equal(before?.status, "ready");
  assert.equal(before?.images[0].uploadedImageId, "tos-shared-original");
  const retryTask = taskFor(submissionId, "front", 1);
  const conflict = await handler(mockRouteRequest({
    batchKey: `E002:v1:${submissionId}:attempt-1`,
    uploadKey,
    sourceSubmissionId: submissionId,
    common: COMMON,
    images: [Buffer.from("different-bytes")],
    sourceImages: [{
      sourceFileName: "different.png",
      fileSize: 15,
      mimeType: "image/png",
    }],
    concurrency: 5,
    tasks: [retryTask],
  }, "token-route-conflict") as any);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "upload_idempotency_conflict");
  assert.equal(conflict.failureCode, "upload_idempotency_conflict");
  assert.equal(conflict.batchStatus, "rejected");
  assert.equal(conflict.automaticRetriesExhausted, false);

  const afterUpload = new ImageUploadStore({ storeDir: routeStoreDir }).get(uploadKey);
  const afterLedger = new ImageTaskLedger({ storeDir: routeStoreDir });
  assert.equal(afterUpload?.status, "ready");
  assert.equal(afterUpload?.sourceMetadataHash, before?.sourceMetadataHash);
  assert.equal(afterUpload?.images[0].uploadedImageId, "tos-shared-original");
  assert.equal(afterLedger.get(initialTask.idempotencyKey)?.historyId, "history-original");
  assert.equal(afterLedger.get(retryTask.idempotencyKey), undefined);
});

test("后台 failed_pre_submit 释放 tasks 后，status 仍返回结构化失败且绝不恢复 worker", async () => {
  const submissionId = "SUB-route-background-failure";
  const uploadKey = expectedE002UploadKey(submissionId);
  const batchKey = `E002:v1:${submissionId}:attempt-0`;
  const failingTask = taskFor(submissionId);
  let submitCount = 0;
  routeHarness.upload = async () => {
    throw Object.assign(new Error("图片上传失败: HTTP 400 deterministic"), { status: 400 });
  };
  routeHarness.submit = async () => {
    submitCount++;
    return { historyId: "must-not-submit" };
  };
  const batchHandler = routeModule.default.post["/tasks/batch"];
  const accepted = await batchHandler(mockRouteRequest({
    batchKey,
    uploadKey,
    sourceSubmissionId: submissionId,
    common: COMMON,
    images: [sourceBytes(0)],
    sourceImages: sourceImages(),
    concurrency: 5,
    tasks: [failingTask],
  }, "token-route-background-failure") as any);
  assert.equal(accepted.accepted, true);

  await waitFor(() => {
    const upload = new ImageUploadStore({ storeDir: routeStoreDir }).get(uploadKey);
    const task = new ImageTaskLedger({ storeDir: routeStoreDir }).get(failingTask.idempotencyKey);
    return upload?.status === "failed_pre_submit" && task === undefined;
  });
  assert.equal(submitCount, 0);

  const statusHandler = routeModule.default.post["/tasks/status"];
  const status = await statusHandler(mockRouteRequest({
    batchKey,
    uploadKey,
    phase: "initial",
    pollCount: 1,
    maxPollCount: 120,
    concurrency: 4,
    tasks: [{ idempotencyKey: failingTask.idempotencyKey }],
  }, "token-route-background-failure") as any);
  assert.equal(status.ok, false);
  assert.equal(status.accepted, false);
  assert.equal(status.code, "image_upload_pre_submit");
  assert.equal(status.failureCode, "image_upload_pre_submit");
  assert.equal(status.batchStatus, "failed_pre_submit");
  assert.equal(status.stage, "tos_binary_upload");
  assert.equal(status.automaticRetriesExhausted, true);
  assert.equal(status.reservationState, "released");
  assert.equal(status.submittedCount, 0);
  assert.equal(status.unknownCount, 0);
  assert.deepEqual(status.tasks, []);
  assert.equal(new ImageTaskLedger({ storeDir: routeStoreDir }).get(failingTask.idempotencyKey), undefined);
  assert.equal(submitCount, 0);
});

test.after(async () => {
  // Route handlers intentionally return before background jobs finish. The
  // assertions above wait for durable terminal state; leave one macrotask turn
  // for coordinator.finally() to clear its long upload-deadline timer before
  // deleting the isolated store directory.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete (globalThis as any).__JIMENG_ASYNC_ROUTE_TEST_HARNESS__;
  fs.rmSync(routeStoreDir, { recursive: true, force: true });
});
