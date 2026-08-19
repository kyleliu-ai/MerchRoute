import path from 'node:path';
import { rm } from 'node:fs/promises';

const root = process.cwd();
const targets = ['apps/web/dist', 'apps/server/dist', 'packages/shared/dist', 'coverage', 'playwright-report', 'test-results']
  .map((item) => path.resolve(root, item));
for (const target of targets) {
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`拒绝清理项目外路径：${target}`);
  await rm(target, { recursive: true, force: true });
}
console.log('已清理构建与测试产物。');
