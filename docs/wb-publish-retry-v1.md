# WB 自动上品重试协议 v1

本批次从已验收 v0.1.6 的提交 `234ce139bd6d4deb2d630cd3205ba8b6d4df3dbd` 开始。范围是 WB 自动任务详情、重试台账、网关建卡授权及 S001 恢复；手动上品、OZON 和其他业务入口保持原合同。新入口默认关闭。当前开发修改不代表已部署或已经恢复真实商品。

## 操作合同

- 详情按钮为“重试上品”。核对原任务与平台实际结果，再继续未完成步骤。接收请求不代表上品成功。
- `POST /api/v1/wb/automation/jobs/:sku/retry` 接收 `storeId/runId/requestId/expectedStateToken`；客户端从详情获取版本标记并生成 UUID。
- 同一请求返回同一台账；同店铺/SKU/轮次最多一条 CHECKING 或 RUNNING 记录。检查条件失败有具体原因。旧 recheck 对已提交任务返回 WB_RETRY_ENDPOINT_REQUIRED。
- 使用原 publication、taskId、revision、冻结 product 与条码。改资料必须发起新的发布。平台商品身份、类目或条码不能精确对应，或者只存在部分商品卡时，停止处理。
- 失败的历史建卡必须有网关回执及冻结 intent。通用 400 可以得到一次人工许可；新的 400 停止本轮。具体字段错误（含 additionalErrors）保留字段原因。已核验的通用错误批次按 batchUUID 和 updatedAt 保留为历史，新批次仍会停止本轮。所有旧回执保留。
- 建卡物理 attempt 单调递增；人工次数由重试台账独立记录。网关在同一个事务内校验许可并插入请求台账，重复消费不能增加写入。单纯改变 attempt 无法获得授权。
- UNKNOWN 继续原回查，保留原 30 分钟、两轮完整核验、至少 60 秒间隔及最多一次自动补投规则。人工次数不会重置这些规则。
- 回查分页必须完整。失败清单读取 `data.items`，以 `data.cursor.next=false` 结束；在售/回收站必须有明确 cursor.total。只读请求至少间隔 600ms，失败清单翻页至少间隔 6 秒，每次请求前续租。错误格式、分页循环和平台不可用都不能作为“商品不存在”的证据。合同来源：[WB 商品文档](https://dev.wildberries.ru/en/docs/openapi/work-with-products)。
- 新许可在提交前过期且尚未消费时，由后台重新核对，保持同一 retryId 与 attempt。已经存在但响应未知的账本只做回查。
- 活动重试保护原自动任务，数据库行锁下拒绝旧调度状态覆盖。持久化租约保护后台检查；runtime rowVersion 拒绝旧 n8n 回调。
- 原有媒体成功记录用于恢复；价格和库存先查实际值。目录已改名但回写失败时，仅凭具有任务身份和 payloadSignature 的唯一归档结果恢复。

## 受控部署清单

1. 应用迁移 `040_wb_manual_publish_retry` 新建协议开关和重试台账，放宽物理 attempt 整数范围但保留唯一约束。迁移不会重置任何业务任务，协议默认关闭。
2. 工作流 ID `qYxi3PPmRm7tjK0E`（WB-S001-推进单个任务），补丁模块 `deployment/n8n/patches/wb-publish-retry-v1.mjs`。仅更改 Build Step、Handle WB Response、Normalize Worker Error、Finalize Directory 四个 Code 节点。受控 JSON 和 manifest 包含对应内容哈希。
3. 协议状态接口 `GET /api/v1/wb/runtime/retry-protocol`；开关 POST 使用既有 runtime key，不能通过普通业务请求开启。
4. 核验工具 `deployment/n8n/scripts/verify-wb-retry-protocol.mjs` 默认只读：核对运行提交、非 dirty 构建、后端协议、S001 活动状态及四个节点代码；另获上线授权后才可使用 `--apply --approved`。脚本不更新或激活 n8n 工作流。

上线必须另获当前任务授权。先确认业务空闲并在仓库外备份运行包、相关数据库记录和 live 工作流，再部署迁移及候选应用，保持入口关闭。将补丁应用到刚读取的 live S001，保留凭据绑定、节点连线与其他配置；如补丁锚点变化则停止。更新后 GET 回读，报告修改前后 versionId 和 active 状态。

环境变量由既有安全配置提供，禁止把真实密钥或数据库 URL 写入仓库或命令日志。使用固定 Node 22.23.1：

```text
node deployment/n8n/scripts/verify-wb-retry-protocol.mjs --expected-commit=<已部署候选提交>
node deployment/n8n/scripts/verify-wb-retry-protocol.mjs --expected-commit=<已部署候选提交> --apply --approved
```

启用后核验实际前端资源、按钮、详情接口和调度；仍不代表授权真实重试。具体店铺及 SKU 必须另行指定，届时重新读取任务后执行单轮重试。其他店铺的成功记录不受影响。

## 回滚

另获对应操作授权后，先关闭入口：

```text
node deployment/n8n/scripts/verify-wb-retry-protocol.mjs --disable --apply --approved
```

停止接收新重试；已发生写入必须回查到明确结果，业务空闲后恢复匹配的应用及工作流。保留重试记录、所有网关回执和平台操作，不恢复旧数据库快照覆盖这些事实。旧应用不能理解新 attempt 时，应保持入口关闭并完成新协议任务的核对再切换。

## 验收和候选

`scripts/verify-wb-retry.mjs --output=<仓库外绝对证据目录>` 启动一次性 PostgreSQL 容器，执行类型检查、重试单元/集成测试和 S001 模拟。它清除生产环境变量并使用模拟 fetch；测试不会调用 live WB 或 n8n。`--full` 执行完整 npm check 和实际浏览器测试。所有测试证据保留在指定目录。

验收覆盖：无 partial effects 的失败建卡、新成功与新 400、原商品身份、媒体/价格/库存/收尾检查点、UNKNOWN/不完整回查/字段错误/归属冲突、重复点击与过期版本、检查租约/许可/提交/回写重启、多店隔离、浏览器进度/原错误/新错误和窄屏。已有 320px 侧栏限制继续单独登记，不把它当作本次重试功能通过的依据。

保留既有 release-features 清单并增加本功能。正式候选必须来自干净的已提交源码；开发测试记录不能代替完整发布验收，也不能将 dirty 构建标为已验收发布。v0.1.7 将 WB 与 OZON 两项修复按独立提交汇入同一个发布批次，配套部署和回滚要求见 [v0.1.7 发布契约](releases/v0.1.7.md)。
