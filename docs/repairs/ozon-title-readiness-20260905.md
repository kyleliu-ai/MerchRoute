# OZON 标题翻译启动时序与 v4 契约修复

## 基线与范围

- 本次分支：`work/ozon-title-readiness-20260905-0100`。
- 已验收本机基线：v0.1.5，提交 `771f0b0b99e1fe6636d96f2693b68ef89cfe51de`。
- 本次修改标题翻译客户端、自动计划的临时错误传播，以及 T001/S001/P002 的内容策略兼容检查。
- 不改店铺凭证、SKU、任务/修订标识、平台写入接口、任务冻结校验或调度重试次数。
- 正式应用运行包未替换；历史失败任务未重试；没有发起模型调用或 OZON 上品。

## 原因

2026-09-05（北京时间），n8n 在 08:39:02 启动，两个店铺的标题翻译在 08:42:45 收到 HTTP 404 非 JSON 响应，而标题 Webhook 在 08:44:09 才完成激活。端口已经监听，不代表工作流的 Webhook 已可用。原客户端把该响应归为永久配置错误，自动计划随后被冻结为失败，启动完成后也不会自动恢复。

另一个独立阻断点是版本契约不一致：正式应用发送 `merchroute-ozon-content-v4`，相关在线工作流仅接受 v2/v3。只解决 404，后续仍会在标题、导入或最终状态校验处失败。

## 修复行为

1. 对 n8n `/webhook/` 地址，翻译前读取同源 `/healthz/readiness`，保留反向代理前缀且不发送自动化密钥。必须返回 HTTP 200 和 JSON `status: ok`。
2. 启动未就绪、超时、网络中断、429 和服务端故障作为可恢复的翻译错误。POST 404 时再检查就绪状态，覆盖检查与请求之间重启的窗口；服务已就绪但 Webhook 缺失，仍是永久配置错误。
3. 鉴权失败、无效的就绪响应和真正无效的翻译结果保留明确错误；失败结果不进入缓存。
4. 自动计划等待两个店铺的准备动作结束后，将临时翻译故障交给现有网络恢复机制。平台投递状态为 `NOT_SENT`，不冻结失败计划、不创建平台发布，不重新生成已完成的共享材料。手动计划继续展示逐店铺错误。
5. T001 接受 v4 并复用 v3 标题规则；S001 的 v4 描述检查与应用一致；P002 对 v4 保留与 v3 相同的完整冻结绑定检查。旧策略仍兼容，未知策略仍拒绝。

## 验证

- 服务端 OZON 发布、店铺契约和共享策略测试：16 个文件，465 项通过。
- 工作流策略与受控更新测试：23 项通过，覆盖 v2/v3/v4、非法文本、缺失冻结绑定、节点漂移、版本漂移、运行中阻断、全部备份先于写入和非激活工作流保持不变。
- 服务端 TypeScript 检查、编译与修改文件 ESLint 通过。
- 36 个受控工作流导出验证通过。
- 实机只读就绪检查返回 HTTP 200；无密钥标题请求返回 HTTP 403，证明入口已注册且鉴权有效，未执行翻译节点。
- 未执行付费端到端验证，也未将单元测试通过等同于正式应用已上线。

主要回归命令：

```sh
node node_modules/vitest/vitest.mjs run apps/server/src/services/ozon-publishing apps/server/src/services/ozon-stores packages/shared/src/ozon.test.ts
node --test deployment/scripts/ozon-content-policy-v3.test.mjs deployment/scripts/ozon-import-info-retry.test.mjs deployment/scripts/ozon-title-readiness.test.mjs deployment/scripts/ozon-content-v4.test.mjs deployment/scripts/ozon-content-v4-deploy.test.mjs
node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit
node deployment/n8n/scripts/verify-workflows.mjs
```

测试必须清除继承的生产环境变量，使用仓库 `testEnvironment` 的隔离环境；上述测试不连接生产数据库、不发起真实业务请求。

## 在线工作流交付

应用补丁脚本 `deployment/n8n/scripts/update-ozon-content-v4-live.mjs` 默认只检查。写入必须显式提供三个预期版本、仓库外全新备份目录及 `--apply`。脚本先备份全部工作流，再依次更新 P002、S001、T001；每个写入前重新检查版本和空闲状态，写入后回读完整节点、连接、设置、启用状态和发布版本。它不使用仓库导出覆盖在线工作流。

本机 n8n API 会在更新已启用工作流时发布新版本，故不额外停用/启用，避免人为制造 Webhook 不可用窗口。所有工作流本次均保持启用。

| 工作流 | 修改前版本 | 修改后且已发布版本 |
| --- | --- | --- |
| T001 `HDh0ZNLK2ps5qasR` | `21791bd1-4d7e-4cb9-ad89-1b8edcf5b4d4` | `cefcc508-57e3-433a-a136-9eb1c33c2a98` |
| S001 `stSK51IuxrMZlLjx` | `b305e69f-dd1a-457c-8e06-a6c5d3c5eaed` | `e86b3b7f-74dd-42cf-9ab2-0baec985291d` |
| P002 `g3KK68BLXX7eShqa` | `bb1e1c48-100d-4ad6-84e0-8876739da87b` | `f8d4dfe7-9723-40ef-a45f-788b66ab939d` |

含真实配置的修改前/后备份及逐次回读结果保存在仓库外恢复目录，不进入 Git。回滚须使用对应修改前备份，并重新检查当前版本、业务空闲和现有修改；禁止直接覆盖后来的人工作业。

## 尚未执行的后续阶段

本批次未暂存、提交、推送、创建 PR、发布正式版本或切换正式应用。应用端的就绪检查与自动恢复保护要在另行授权并完成发布验收、正式切换后才对生产进程生效。

SKU `0000171` 的原共享任务及两个店铺任务保持原失败状态。恢复前须只读确认当前任务、冻结计划与平台投递记录，再按单独授权范围恢复；不能盲目重发或创建另一组上品任务。
