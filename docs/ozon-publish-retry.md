# OZON 自动上品：重试上品

本批次将自动任务详情中的“重新检查”替换为“重试上品”。按钮受理的是持久化恢复操作，不表示商品已经上架。仅当前选中店铺参与；不批量重放其他店铺。

## 恢复规则

| 原失败位置 / 证据 | 操作 |
| --- | --- |
| 原店铺商品快照完整，尚无平台写入证据 | 核对 Offer 未被手动上品，恢复原发布包，以原身份进入调度 |
| 已有 importTaskId、商品 ID、写入意图、UNKNOWN 或已返回的写入证据 | 保留原身份进入 P002 导入回查分支，不重置为首次建卡 |
| 图片补传待执行 | 进入原图片修复分支，不重建商品卡 |
| 价格 / 库存部分失败 | 平台回查后仅续跑尚未成功项；已成功 Offer 保留；明确永久业务错误停止并提示 |
| 店铺资料缺失或不合法，且没有平台写入证据 | 先显示原 / 当前预设、仓库、币种相关冻结配置等差异，用户确认后以原公共素材建立新的单店版本与接续任务 |
| 任务已成功、已取消、正在执行、存在租约、预检过期、凭据失效、冻结合同不一致 | 禁止启动，显示具体原因 |

重建使用原公共素材和原 Offer 集合，不重新扇出所有店铺、不覆盖旧版本。旧任务保留原错误和阶段记录；旧 / 新任务保存替代关联并可相互打开。没有公共素材版本、历史单店身份不完整、平台结果不明且原快照损坏等情况仍需人工处理，不伪造恢复条件。

## 接口与并发保护

- `GET /api/v1/ozon/automation/jobs/:id/retry-plan?storeId=...`：只读计划及本轮进度。
- `POST /api/v1/ozon/automation/jobs/:id/retry`：仅本机操作员入口，严格接收 `storeId`、`requestId`、`planHash`、`confirmRebuild`；返回 HTTP 202。
- GET 不创建版本、任务或发布包。POST 以计划摘要核对任务与配置变化；需要重建时必须显式确认。
- `ozon_publish_retries`（迁移 `041_ozon_publish_retry`）保存 CHECKING / RUNNING / SUCCEEDED / FAILED / BLOCKED 状态、检查点及租约。同店铺同 SKU 至多一个活动重试。
- 断线或响应丢失时复用原 requestId 查询受理结果，不能把“不知道结果”当作“尚未执行”。后台中断后从持久化检查点恢复。
- 新发布包在完成核验前始终持有恢复保护。事务中复核凭据有效期、调度合同、配置、租约、原任务状态与平台证据后才交给现有执行器。
- 原任务的整批重检、重新发布、取消和其他同店铺同 SKU 发布不能绕过重试保护。被替代任务不得再次被调度领取。
- 重试表不保存凭据密文或授权头。包路径逐层校验，拒绝符号链接和路径穿越，并核验原商品快照签名。

只有接续任务通过既有平台验收并成为 SUCCEEDED 后，页面才显示完成；受理或入队只显示处理中。失败时展示原停止原因和本轮失败原因。

## 本批次修改范围

- 共享请求 / 结果协议：`packages/shared/src/ozon-retry.ts`、共享导出。
- 持久化、幂等、检查点、租约与单店保护：`repositories/ozon-retry.ts`、`repositories/ozon-stores.ts`。
- 恢复分支、冻结发布包复用和单店重建：`services/ozon-publishing/retry.ts`、`services/ozon-stores/index.ts`。
- 服务启动 / 停止、路由、Web API 客户端及自动任务详情接线。
- 单元、PostgreSQL 集成、路由、独立浏览器及既有 P002 工作流契约测试；保留现有 WB 修改。
- `config/release-features.json` 追加本批次验收项，不代表已发布或已验收上线。

## 隔离验证

使用项目固定 Node 22.23.1。以下 evidence 路径必须替换为仓库外目录：

```text
node scripts/verify-ozon-retry.mjs --output=<仓库外证据目录>
node scripts/verify-ozon-retry.mjs --mode=browser --output=<另一个仓库外证据目录>
node scripts/verify-wb-retry.mjs --output=<WB 保留功能证据目录>
```

专项验证使用一次性 PostgreSQL 容器与隔离 schema；浏览器仅使用 4183 静态服务和 mock API，禁止真实业务请求，不启动正式服务、不连接生产数据库、不执行 live n8n。P002 测试读取受控工作流导出，验证回查分支和仅写入 pending Offer 的行为；没有修改或部署 n8n 工作流。

验证清单：受理非成功、双击 / 幂等、租约失效、中断恢复、原导入身份保留、部分价格库存失败、图片修复、原商品已被手动创建、重建确认 / 取消、单店接续可领取、另一店铺不变、旧入口不能绕过保护、凭据 / 配置漂移、桌面和窄屏、旧详情页操作与筛选。

## 开发阶段交接记录（非当前发布状态）

以下记录保留开发阶段的验收来源。v0.1.7 的提交、完整测试、发布及本机切换结果以相应发布证据为准，配套步骤见 [v0.1.7 发布契约](releases/v0.1.7.md)。

本次本机记录（2026-09-05）：复用 `work/wb-publish-retry-20260905-0537`，HEAD 保持 `234ce139bd6d4deb2d630cd3205ba8b6d4df3dbd`；已验收发布记录为 v0.1.6。本次没有创建分支或 Worktree，也没有新的提交。正式端口 43173 本轮核查无监听，不能读取实际运行版本，未尝试启动或重启。

| 验证 | 结果 | 仓库外证据目录名称 |
| --- | --- | --- |
| OZON 新增专项（服务、数据库、路由） | 33 通过 | `ozon-retry-final4` |
| OZON 原功能回归 | 266 通过 | `ozon-retry-final4` |
| OZON 原迁移、接管及运行时路由 | 38 通过 | `ozon-retry-final4` |
| P002 原工作流契约 | 3 通过 | `ozon-retry-final4` |
| 浏览器桌面 / 窄屏及旧详情操作 | 8 通过 | `ozon-retry-browser7` |
| WB 保留功能及工作流契约 | 93 + 8 通过 | `ozon-retry-wb-preservation2` |

共 449 项相关测试通过；类型检查、修改范围 ESLint、`git diff --check`、仓库安全检查与 Gitleaks 扫描通过。此前失败的测试记录也保留在仓库外，没有将失败运行标为通过；本表只引用修正后的通过记录，不等同于全项目发布验收。

接管前 29 个 WB 未提交文件已备份并复核：25 个文件 SHA-256 完全相同；共用的 `app.ts`、`api/client.ts`、`shared/index.ts`、`release-features.json` 仅追加 OZON 接线，WB 内容没有删除或替换。

本任务文件清单（共用文件仅包含本任务追加部分）：

```text
apps/server/src/app.ts
apps/server/src/repositories/ozon-retry.ts
apps/server/src/repositories/ozon-retry.integration.test.ts
apps/server/src/repositories/ozon-stores.ts
apps/server/src/routes/ozon.ts
apps/server/src/routes/ozon-retry.test.ts
apps/server/src/routes/ozon-runtime.test.ts
apps/server/src/services/ozon-publishing/retry.ts
apps/server/src/services/ozon-publishing/retry.test.ts
apps/server/src/services/ozon-stores/index.ts
apps/server/src/services/ozon-stores/contracts.test.ts
apps/web/src/api/client.ts
apps/web/src/ozon-listing.tsx
apps/web/src/ozon-retry.tsx
packages/shared/src/index.ts
packages/shared/src/ozon-retry.ts
config/release-features.json
deployment/scripts/ozon-publish-retry.test.mjs
playwright.ozon-retry.config.ts
scripts/serve-ozon-retry-test.mjs
scripts/verify-ozon-retry.mjs
tests/e2e/ozon-listing.spec.ts
tests/e2e/ozon-retry.spec.ts
tests/fixtures/ozon-retry.ts
docs/ozon-publish-retry.md
```

本次只修改当前开发分支的本机文件；不暂存、不提交、不推送、不创建 PR、不发布、不重启正式服务。真实商品任务没有被点击重试。开发验证不等于正式环境已经生效。

正式发布以隔离回归、切换演练、已验收包和只读现场核验为依据，不触发真实上品。若用户另行要求恢复真实商品，必须取得具体店铺和任务的写入授权，再回读店铺预检、冻结凭据与平台事实并执行单轮恢复；不能用本地夹具代替真实任务的完成证据。
