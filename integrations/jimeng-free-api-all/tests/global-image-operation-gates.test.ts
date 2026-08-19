import assert from "node:assert/strict";
import test from "node:test";

import {
  globalImageOperationGateSnapshot,
  runGlobalImageGeneration,
  runGlobalImageStatus,
  runGlobalImageUploadAttempt,
} from "../src/api/services/global-image-operation-gates.ts";

test("async 与 legacy 参考图上传共享全服务门控，峰值为 2", async () => {
  let active = 0;
  let peak = 0;
  const one = (label: string) => runGlobalImageUploadAttempt({
    token: label.includes("async") ? "token-a" : "token-b",
    work: async () => {
      active += 1;
      peak = Math.max(peak, active);
      try { await new Promise((resolve) => setTimeout(resolve, 15)); return label; }
      finally { active -= 1; }
    },
  });
  await Promise.all([
    ...Array.from({ length: 5 }, (_, index) => one(`async-${index}`)),
    ...Array.from({ length: 5 }, (_, index) => one(`legacy-${index}`)),
  ]);
  assert.equal(peak, 2);
  assert.equal(globalImageOperationGateSnapshot().upload.activeGlobal, 0);
});

test("async 与 legacy 生成 POST 共享公平门控，峰值为 5", async () => {
  let active = 0;
  let peak = 0;
  const completed = new Set<string>();
  const one = (owner: string, index: number) => runGlobalImageGeneration(owner, async () => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      completed.add(`${owner}-${index}`);
    } finally { active -= 1; }
  });
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => one("async-batch", index)),
    ...Array.from({ length: 8 }, (_, index) => one("legacy-route", index)),
  ]);
  assert.equal(peak, 5);
  assert.equal(completed.size, 16);
  assert.deepEqual(globalImageOperationGateSnapshot().generation, { active: 0, queued: 0, limit: 5 });
});

test("跨 status 请求的 history 查询共享门控，峰值为 4", async () => {
  let active = 0;
  let peak = 0;
  const one = (owner: string, index: number) => runGlobalImageStatus(`${owner}-${index}`, async () => {
    active += 1;
    peak = Math.max(peak, active);
    try { await new Promise((resolve) => setTimeout(resolve, 12)); }
    finally { active -= 1; }
  });
  await Promise.all([
    ...Array.from({ length: 6 }, (_, index) => one("status-a", index)),
    ...Array.from({ length: 6 }, (_, index) => one("status-b", index)),
  ]);
  assert.equal(peak, 4);
  assert.deepEqual(globalImageOperationGateSnapshot().status, { active: 0, queued: 0, limit: 4 });
});
