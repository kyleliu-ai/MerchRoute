# MerchRoute 即梦代理候选构建与受控部署

## v1.0.1 永久归档与禁止重投

永久归档独立于远端生成状态：`image-task-archive.json` 保存明确批准的任务完整原始快照、规范化记录指纹、原因、时间和批准依据；主账本只增加 `archiveSha256` 绑定，不改写任何任务的成功、失败或未确认状态。归档记录保留原幂等键。首次归档清单冻结后不自动扩展，不按年龄批量关闭其他任务。

代理对原请求、参数变更请求及关联重试返回 `task_archived_no_replay`，不上传、不重新生成。状态查询保留原始 `status` 并增加 `localDisposition.state=archived_no_replay`、`canRetry=false`；批次以 `archivedCount` 单独计数，归档任务不计入 `pendingCount`。全部任务已在本地结束时 `allTerminal=true`；异步接口不再要求继续轮询。混合批次中的正常任务继续处理。归档不证明上游已取消或生成未发生。

离线归档入口：`node deployment/scripts/jimeng-deploy.mjs archive --record=<候选记录> --container=<精确容器ID> --volume=<原卷> --state-dir=<仓库外恢复目录> --approval-file=<批准清单> --dry-run`。执行时用 `--execute --maintenance-file=<最新维护证据>`。工具自身不停止或启动正式服务：必须先通过受控维护流程阻止新请求、核实 n8n/worker 空闲、停容器并设置 `restart=no`。归档要求无卷写入者、旧记录早于当前进程启动、精确原账本文件哈希和逐条规范化记录哈希；先一致性备份，并在临时卷恢复核对后才写入。

首次从不支持归档的代理升级时，`upgrade` 可附加 `--archive-approval-file=<批准清单>`。同一次卷维护锁下依次完成旧任务维护核对、停止原容器、原卷备份恢复验证、离线归档、归档后再次备份恢复验证，最后启动支持归档的新镜像。任何阶段失败均保留现场和最新数据，不自动启动旧版。切换主应用前必须确认归档后的新代理可用；恢复方案需准备经过验证的归档兼容镜像。

批准清单包含 `schemaVersion=1`、`operation=archived_no_replay`、`preserveRecords=true`、`forbidReplay=true`、`containerId`、`imageId`、`volume`、`storeSha256`、`approvedAt`、短时有效的 `expiresAt`、`reason`、`approvalReference`，以及 `records:[{keyHash,recordHash}]`。记录哈希采用共享模块 `recordDigest` 的递归键排序规则；不能混用旧维护证据中按 JSON 字段顺序计算的哈希。真实批准清单、账本快照、备份与日志只能保存在仓库外受限目录，不上传到 GitHub。

归档文件与主账本绑定分别原子提交并同步磁盘。若在两次提交之间中断，代理拒绝启动；共享离线修复函数只接受同一份未过期批准清单完成绑定，禁止以空账本启动。已成功执行的同一清单重试只回读原归档，不产生新记录。损坏、缺失、内容变化或未知记录均拒绝放行；启动后归档记录仍按原始快照持久保存。

归档与主账本必须一起备份、一起恢复；业务运行后的恢复保留最新账本，不用归档前备份覆盖新任务。维护工具读取并验证持久归档，无需为已归档项重复提供临时历史例外，其他未决项仍需核对。归档后的升级和回滚目标必须具有 `org.merchroute.jimeng.archive-schema=1` 能力标签。历史旧镜像仍保留，但不支持归档的镜像（包括已发布 v1.0.0）会在停服务前被拒绝作为目标，需另备支持归档的恢复镜像；不能宣称旧镜像会自动获得归档保护。手工绕过维护工具启动旧镜像不在受控回滚支持范围内。

本机制修改代理运行代码；已发布 v1.0.0 的标签、镜像和 Release 资产保持不可变。候选验收不代表已正式发布或已对生产三条记录执行归档。

## v1.0.1 版本关联

MerchRoute 与内置即梦代理的组件版本统一为 `1.0.1`。正式镜像为 `merchroute/jimeng-free-api-all:1.0.1`，正式容器为 `merchroute-jimeng-v1.0.1`；实际启动绑定验收记录中的不可变镜像 ID。镜像与容器同时记录 `org.merchroute.product.version` 和 `org.opencontainers.image.version`，发布清单关联 GitHub `v1.0.1`、源码指纹、平台和镜像 ID。

候选继续使用独立 RC 标签。所有候选检查通过后，只为同一个镜像 ID 添加尚不存在的正式标签，不重新构建，不覆盖旧标签。内部组件版本变更不修改上游模型协议版本、模型标识或账本 schema。

Compose 额外要求显式设置 `JIMENG_RELEASE_VERSION=1.0.1`，并保留显式 `JIMENG_IMAGE` 和 `JIMENG_TASK_VOLUME`。生产部署工具按版本生成容器名；从无版本名称的旧容器升级必须提供精确旧容器 ID、旧镜像 ID、原卷及 `--handoff`。旧容器保留、停用自动重启，新容器继续使用端口 8000 和原持久卷；兼容的回滚从原操作日志恢复旧容器名称与重启策略，保留最新账本。

版本验收包含容器名称、镜像标签、双版本标签和容器内 package 版本的一致性。旧构建记录没有新增版本字段时，继续支持按原镜像身份核验和回滚。

生产升级需要当前任务的独立授权和维护窗口。本工具不会修改 n8n 凭据、启用工作流或发布正式版本。`0dbfb17b9397e84c3a9d66c2af7c8a4242984dc0` 是历史 rc.2 源码检查点，不能代表后续未提交成果。2026-09-08 已验收并配套部署 rc.13；rc.2、rc.7 和 rc.13 的历史镜像、账本及回滚证据均不得覆盖或重新打标签。

rc.13 继承基线的镜像身份分项如下（标签不是授权令牌）：

| 项目 | 值 |
| --- | --- |
| 镜像仓库 | `merchroute/jimeng-free-api-all` |
| 标签 | `0.9.1-jimeng47-rc.13-1cc507b3fe028abf` |
| 镜像 SHA-256 | `ea0172801fc3227a1f3375c38267201cd9efd866f14da04d6fcab877647e77b3` |

统一 `merchroute-image-v1` 策略适用于全部已登记图片模型：目标 4 张、最低 1 张、部分成功不补图、仅符合条件的明确失败允许一次重新生成，保留持久化账本与原始任务身份。E001/E002/S003 脱敏导出保留已验收策略，E003 保留调用 S003 的契约。

已知限制：jimeng-2.0、jimeng-2.0-pro、jimeng-2.1 的文生图路径此前上游失败，未验收可用；5.0 Pro 官网标识核实只属于取证，不代表新增模型接入。Windows 验证不代表 macOS 实机验收。正式版本发布与本机代理切换分开授权。

## 构建记录

`deployment/runtime-versions.json` 是组件版本、Node/npm 和镜像仓库名的唯一清单。候选使用冻结的白名单源码快照构建；Node 20 全套测试必须通过，runtime 层才能产出。源码、测试或工具变化后增加 RC 序号，禁止重用旧记录。

```bash
node deployment/scripts/jimeng-deploy.mjs build --state-dir="<runtimeHome>/recovery/jimeng" --rc=14 --dry-run
node deployment/scripts/jimeng-deploy.mjs build --state-dir="<runtimeHome>/recovery/jimeng" --rc=14
```

也可设置 `JIMENG_BUILD_STATE_DIR` 后使用 `npm run jimeng:build`。记录包含基线、实际提交、未提交标识、逐文件哈希、源码指纹、镜像 ID、平台及验收阶段。`node20BuildGate=true` 不代表真实生图或生产上线通过；后续验收单独记录，不改写构建记录。

## 只读检查与部署计划

```bash
node deployment/scripts/jimeng-deploy.mjs inspect --container=<exact-container-id> --volume=<existing-volume>
node deployment/scripts/jimeng-deploy.mjs verify --record=<build-record.json> --profile=test --container=<exact-container-id> --volume=<test-volume>
node deployment/scripts/jimeng-deploy.mjs install --record=<build-record.json> --profile=test --volume=<new-test-volume> --dry-run
node deployment/scripts/jimeng-deploy.mjs upgrade --record=<build-record.json> --profile=test --container=<old-container-id> --expected-image=<old-image-id> --volume=<existing-test-volume> --dry-run
```

测试 profile 固定 `127.0.0.1:18001`，卷名必须以 `merchroute-jimeng-test-` 开头；生产 profile 固定 `127.0.0.1:8000`。不接受任意端口、隐式空卷或可变镜像标签。计划与 `--dry-run` 不创建状态目录、卷或锁，不停止服务，不改变重启策略。

预检发现 8000 已占用时，只有显式提供 `JIMENG_DEPLOY_RECORD`、`JIMENG_CONTAINER_ID`、`JIMENG_TASK_VOLUME` 并通过身份验证才视为受控实例。旧手工 rc.2 必须用原检查点单独核验与交接，不因 `/ping` 成功自动当作新工具管理的实例。

生产 Compose 只接受显式 `JIMENG_IMAGE` 和 `JIMENG_TASK_VOLUME`，使用 `external: true`，不再自动构建。手工 rc.2 并非 Compose 自动可接管的实例；首次交接必须另行批准并传 `--handoff`。

## 执行与回滚

全新安装确认不存在已有实例和已有目标卷后，才使用 `install ... --state-dir=<external-state-dir> --execute`。已有实例必须走 `upgrade`，不能借全新安装创建空卷替换旧数据。

升级还要求 `--maintenance-file=<external-observation.json>`。维护观察必须在五分钟内，绑定精确容器、镜像和卷，并包含：

```json
{
  "containerId": "<old-container-id>",
  "imageId": "sha256:<old-image-hash>",
  "volume": "<existing-volume>",
  "observedAt": "<UTC timestamp>",
  "newSubmissionsBlocked": true,
  "n8nIdle": true,
  "proxyWorkersIdle": true,
  "unknownSubmissionsResolved": true
}
```

这些字段是实际检查的记录，不是用于绕过检查的模板值；无人确认或无法控制新投递时不得填写 true。旧任务陈旧不等于当前没有在途提交。

历史非终态默认拒绝。另行批准后可提供 `historicalDisposition`：schemaVersion=1、containerStartedAt、storageContentHash、preserveRecords=true、forbidReplay=true、approvalReference，以及逐条 records。每条必须绑定 keyHash、完整 recordHash 和原 status；已取得远端终态的 processing 使用 remote_terminal、remoteState 和 evidenceSha256；用户明确允许忽略的旧记录使用 ignore_preserve、explicitlyApproved=true。忽略项创建及更新时间必须均早于当前容器启动，且不能是 reserved。不得把忽略说成成功或失败；账本与幂等键始终原样保留。存在此类例外时 unknownSubmissionsResolved 如实为 false。

例外必须覆盖且只覆盖现场全部非终态记录。新记录、内容变化、上传在途、未批准条目或跨进程证明都失败；当前 n8n/worker/投递检查依然必需。停止后的一致性备份再次核对内容指纹，防止检查与停服之间的新投递被遗漏。回滚同样需要重新绑定当前身份的证明，不能沿用旧维护文件。

执行顺序：独占本机锁和 Docker 卷锁 → 重核身份 → 维护检查 → 停止唯一写入者 → 一致性备份 → 恢复到临时卷并校验内容/权限 → 必要时经 `--allow-permission-migration` 授权迁移 → 非 root 写入及重命名探针 → 保留旧容器 → 启动候选 → 身份、存储和健康验证。

每阶段写仓库外 `operation-*.jsonl`。失败不盲目重复切换；通过原日志的精确身份显式恢复：

```bash
node deployment/scripts/jimeng-deploy.mjs rollback --record=<candidate-record.json> --journal=<operation.jsonl> --state-dir=<external-state-dir> --dry-run
node deployment/scripts/jimeng-deploy.mjs rollback --record=<candidate-record.json> --journal=<operation.jsonl> --state-dir=<external-state-dir> --maintenance-file=<fresh-observation.json> --execute
```

候选仍运行时，维护观察绑定候选身份。回滚保留最新卷，恢复旧容器和旧重启策略；不会导入旧快照，也不会删除失败候选或备份。进程中断后如留有锁，必须核对所有者和阶段再人工恢复，不自动抢锁。存在 4.7 未结束任务时，不得回退到未经查询兼容验收的旧镜像。

禁止 `docker compose down -v`、删除生产卷、打印原始凭据或备份内容。Windows 备份目录还必须继承/设置仅当前用户及受信任管理员可访问的 ACL；POSIX 文件使用限制权限。

## 验收边界

验证包括镜像标签与记录、固定端口、唯一卷写入者、非 root UID/GID、文件权限、账本 schema、Docker health、`/ping` 和 HTML 欢迎页。HTTP 200 或模型列表单独不能证明生图成功。`/tasks/status` 可恢复 worker，不能作为通用只读探针。

候选真实测试必须单独批准账号、素材和预算；生成前持久化提交尝试，未知结果不自动重发。Windows/amd64 验证不能冒充 macOS/arm64 实测。生产切换和共享模型启用仍需独立授权。
