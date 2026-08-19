import assert from "node:assert/strict";
import test from "node:test";

import {
  AdaptiveImageUploadGate,
  IMAGE_UPLOAD_DEGRADED_DURATION_MS,
} from "../src/api/services/adaptive-image-upload-gate.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("全服务并发上限固定为 2", async () => {
  const gate = new AdaptiveImageUploadGate();
  let active = 0;
  let maxActive = 0;
  const blockers = Array.from({ length: 4 }, deferred);
  const jobs = blockers.map((blocker, index) => gate.run(`token-${index % 2}`, undefined, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await blocker.promise;
    active--;
    return index;
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(active, 2);
  blockers[0].resolve();
  blockers[1].resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(active, 2);
  blockers[2].resolve();
  blockers[3].resolve();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);
  assert.equal(maxActive, 2);
});

test("token 遇到可重试失败后降为 1，120 秒且连续成功 3 次后恢复为 2", async () => {
  let nowMs = 1_000;
  const gate = new AdaptiveImageUploadGate({ now: () => nowMs });
  gate.noteRetryableFailure("token-a");
  assert.equal(gate.snapshot("token-a").token?.limit, 1);

  gate.noteSuccess("token-a");
  gate.noteSuccess("token-a");
  gate.noteSuccess("token-a");
  assert.equal(gate.snapshot("token-a").token?.limit, 2);
});

test("token 即使没有连续成功，120 秒后访问门控也自动恢复为 2", () => {
  let nowMs = 1_000;
  const gate = new AdaptiveImageUploadGate({ now: () => nowMs });
  gate.noteRetryableFailure("token-a");
  assert.equal(gate.snapshot("token-a").token?.limit, 1);
  nowMs += IMAGE_UPLOAD_DEGRADED_DURATION_MS;
  assert.equal(gate.snapshot("token-a").token?.limit, 2);
});

test("排队任务在开始前可由 AbortSignal 取消", async () => {
  const gate = new AdaptiveImageUploadGate({ maxGlobal: 1, maxPerToken: 1 });
  const blocker = deferred();
  const first = gate.run("token-a", undefined, async () => {
    await blocker.promise;
    return "first";
  });
  const controller = new AbortController();
  let started = false;
  const second = gate.run("token-a", controller.signal, async () => {
    started = true;
    return "second";
  });
  controller.abort(new Error("deadline"));
  await assert.rejects(second, /deadline/);
  assert.equal(started, false);
  blocker.resolve();
  assert.equal(await first, "first");
});

test("某 token 降级不会阻塞其他 token 使用剩余全局槽位", async () => {
  const gate = new AdaptiveImageUploadGate();
  gate.noteRetryableFailure("token-a");
  const blockers = [deferred(), deferred()];
  let aActive = 0;
  let bActive = 0;
  const a = gate.run("token-a", undefined, async () => {
    aActive++;
    await blockers[0].promise;
    return "a";
  });
  const b = gate.run("token-b", undefined, async () => {
    bActive++;
    await blockers[1].promise;
    return "b";
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aActive, 1);
  assert.equal(bActive, 1);
  blockers.forEach((entry) => entry.resolve());
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
});
