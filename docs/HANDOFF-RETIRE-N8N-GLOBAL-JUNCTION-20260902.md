# `G:\01_n8n-global` Junction 安全退役交接清单

更新时间：2026-09-02 21:56（Asia/Shanghai）

## 续执行权威状态（覆盖下文 19:51 历史快照）

- 用户已在当前任务中明确授权删除失效恢复点 `D:\MerchRoute_Junction_Backups\20260902-200647` 并继续 Cutover。删除前重新确认该目录是备份根的直接子目录、`phase=ROLLED_BACK`、绑定旧 HEAD `5395cfa...`、没有 `finalBackup`/`quarantinePath`，且目标及内部均无 reparse point。
- 删除前已把脱敏后的 `state.json`、3 个 Robocopy 日志、Junction/Target File ID 与 ACL 元数据、n8n 工作流 manifest 和两个数据库 TOC 保存到受限目录 `D:\MerchRoute_Junction_Backups\_superseded-audit\20260902-200647`；共 14 个文件，ACL 仅允许实际运行账户和 SYSTEM，`maintenanceToken` 已置空，并生成 `SHA256SUMS.txt`。没有复制 `external-config`、数据库 dump 或三套大目录。
- 已永久删除且仅删除 `D:\MerchRoute_Junction_Backups\20260902-200647`：60,908 个文件、35,486,826,592 字节。删除后原路径不存在，其他恢复点仍在，`G:\01_n8n-global` Junction、真实目标、三个服务端口和 health 均未受影响。
- 删除后实时容量核验：三套备份源合计 32,261,764,044 字节，新 Prepare 要求 58,575,865,131 字节，D 盘可用 93,459,546,112 字节，容量门禁通过。旧恢复点 `20260902-210154` 仍绑定旧 HEAD，禁止复用；下一步必须从当前干净任务 HEAD 创建全新 Prepare 恢复点。
- 当前现网 MerchRoute 已读回任务实现提交 `8455727...`、`dirty=false`，兼容 readiness 为 `READY`；n8n 仍为本地全局安装。当前未修改任何 n8n 工作流，已知 E004/E006/E007 版本保持不变。

- 任务分支仍为 `work/retire-n8n-global-junction-20260902-1725`，固定 worktree 未变；已有本地提交包括 `1483aa6`、`ecdeba1`、`5395cfa`、`0e52e93`（真实 AppData 与启动日志）、`a588801`（Prepare 在线 AppData 门禁）。未推送、未创建 PR。
- `G:\01_n8n-global` 仍是精确指向 `G:\01_MerchRoute` 的 Junction；没有 quarantine 对象，真实目标没有移动或删除。本地全局 n8n 仍为 PID `25684`，端口 `5678/5679` 未在兼容部署试验中停止。
- 恢复点 `20260902-195505` 因 `/ZB` 权限失败且无状态文件；`20260902-195705` 因 `Set-Acl` 权限失败；`20260902-200647` 与 `20260902-202333` 均在 DeployCompatibility 失败后自动回滚为 `ROLLED_BACK`。前三个仍保留且不得用于正式切换；`20260902-200647` 已在保留受限审计证据后按本轮授权删除。
- `202333` 已正确备份真实 Roaming AppData、约 20.8 GiB 业务目录、n8n 用户目录、两套数据库及 167/39 个工作流；失败原因由恢复点启动日志精确确定为任务 worktree 缺少 `.tools`，从而命中系统 Node `22.22.3`，未满足项目固定 Node `22.23.1`。失败与业务数据、兼容层和 Junction 无关。
- `202333` 失败后，外部 `merchroute.env` 和 MerchRoute Startup 快捷方式均已恢复原值；当前 MerchRoute 为原发布构建 `73d2e710...`，PID `11452`，4173 health 为 200；两个 retirement marker 均不存在。
- 已确认 `/api/v1/health.appDataDir` 的真实业务目录是 `C:\Users\kylel\AppData\Roaming\n8n-media-review-center`，不是 `C:\Users\kylel\AppData\Local\MerchRoute`。实际目录当前约 34,211 个文件、1,551,112,418 字节；Local 路径只继续用于受保护的 `secrets\merchroute.env`。
- 本节同一提交已把脚本 AppData 固定路径改为 Roaming，并新增 `/health.appDataDir` 精确读回门禁；启动等待从 60 秒提高到 180 秒，新版本与回滚版本的启动 stdout/stderr 都写入所属恢复点，Robocopy/n8n export 控制台输出不再污染 `state.json`。
- 修补后静态安全测试、PowerShell 解析、`git diff --check` 及 GUID TEMP Junction 的 `RemoveDirectory2W` 原生演练已通过；真实 `G:` 路径未参与演练。
- 已从当前实际运行源码 worktree 的忽略目录复制固定工具链到任务 worktree；Node `22.23.1`、npm `10.9.8` 与 `node.exe` SHA-256 均已读回一致，不包含任何源码或其他任务的 Git 修改。本节同一提交新增 Prepare/Deploy 前的固定工具链硬门禁，避免再次在大备份后才发现版本错误。
- 固定工具链门禁已提交为 `99020bc` 并完成干净构建；恢复点 `20260902-203738` 已正确 Prepare，兼容版亦成功部署。但第一次 Cutover 在停止全部端口后，因 PowerShell 空结果被展开为 `$null`、`Stop-VerifiedRuntime` 读取 `.Count` 而中止；最终备份尚未开始，72 条执行未取消，Junction 未改名。
- 上述 Cutover 失败时维护 marker 正确保留。随后已先启动本地全局 n8n，再从同一任务 worktree 恢复兼容版，读回 `99020bc`、`dirty=false`、legacy readiness `READY`，并安全解除维护；当前新 PID 为 MerchRoute `4392`、n8n `2600`，三个端口均健康。
- 本节同一提交把停止/启动函数的所有端口列表都强制包装为数组，并增加静态回归断言。提交并重新构建后必须创建全新恢复点；`203738` 因 HEAD 变化只保留审计，禁止复用。
- 当前 D 盘约余 61.0 GB，新 Prepare 的容量门禁要求约 58.6 GB，仍可完成一次全新恢复点和同恢复点内最终增量；禁止未经用户授权删除旧恢复点来腾挪空间。
- 空端口修复已提交为 `0cdb003` 并完成干净构建；恢复点 `20260902-210154` 已正确 Prepare 并部署同一提交。第二次 Cutover 成功停止三个端口并进入最终增量，但在首个恢复抽查索引计算处因 PowerShell 把逗号表达式解析为 `Object[] - 1` 而中止。
- 第二次 Cutover 的最终备份未完成，72 条执行仍未取消，Junction 仍为原名且 File ID 不变，没有 quarantine 对象。失败时脚本重新启动了兼容版 MerchRoute，但 n8n 未自动恢复；维护 marker 保持 fail-closed。随后已人工按固定启动脚本恢复 n8n，读回 4173/5678/5679 健康、`0cdb003`/`dirty=false`、legacy readiness `READY`，并通过恢复点 token 解除维护。
- 本节同一提交把恢复抽查索引独立为 `Get-RestoreRehearsalIndices` 并增加 1/2/5 文件回归；同时新增 `Start-N8nRuntime`，单独记录 n8n stdout/stderr，且只有 5678、5679 和 `/healthz` 同时就绪后才允许启动 MerchRoute。现网只读调用已验证该门禁识别 n8n PID `4416`。
- `20260902-210154` 仍是此前最新完整预复制恢复点，但提交新修复后会因 HEAD 不匹配而禁止复用。此前容量阻塞已通过本轮授权清理 `20260902-200647` 解除；实时可用空间与新 Prepare 门禁见本节顶部最新记录。

下文保留 19:51 时的实现与风险细节作为历史记录；凡与本节冲突，以本节为准。

## 当前结论

- 已按要求创建独立分支与 worktree，并完成兼容层、退役状态机和测试收口；所有变更仍未提交、未暂存、未推送。
- 重启后的实施会话已恢复，当前正处于“提交前最终审查”安全点。禁止把当前状态误认为已完成切换。
- 尚未修改外部运行环境、数据库或 n8n 工作流；尚未备份、停服、改启动项、隔离 Junction 或删除 Junction。
- `G:\01_n8n-global` 仍是 Junction，精确指向真实目录 `G:\01_MerchRoute`。真实目录不得删除、移动或递归处理。
- 最终删除必须在隔离后至少观察 7 个自然日且覆盖规定业务链路；当前绝对不允许执行 Finalize。

## Git / worktree 门禁

- 分支：`work/retire-n8n-global-junction-20260902-1725`
- worktree：`F:\04_AIGC_Management_Systems\AIGC-管理工具\n8n-media-review-center.worktrees\retire-n8n-global-junction-20260902-1725`
- 起始提交与当前 HEAD：`52be6891c1e5632870796bc0132177f8a2d2eb11`
- 基线来自实施时实际运行的本机 MerchRoute 源码，不是 `origin/main`。
- 禁止 pull、merge、rebase、reset、GitHub → 本地同步及覆盖其他 worktree。
- 后续只能在上述 worktree 中工作；选择性暂存，禁止 `git add .` 和 `git add -A`。
- 当前代码及测试文件均为未提交变更；两个退役脚本与兼容工具文件为未跟踪文件。

## 当前外部运行状态（重启后 2026-09-02 19:51 只读快照）

- MerchRoute：PID `29780`，端口 `4173`，health 与 `/api/v1/config` 均为 200；仍是原发布构建 `73d2e710...`。
- 本地全局 npm n8n `2.32.6`：PID `25684`，端口 `5678`、`5679`，`/healthz` 为 200。
- n8n 启动快捷方式：`G:\01_MerchRoute\启动n8n.bat`。
- MerchRoute 启动快捷方式仍指向主工作树：`F:\04_AIGC_Management_Systems\AIGC-管理工具\n8n-media-review-center\scripts\start-windows.cmd`。
- `D:\MerchRoute_Junction_Backups` 不存在。
- `MERCHROUTE_LEGACY_DATA_ROOT` 尚未写入实际 `merchroute.env`。
- `.legacy-root-retirement-required-v1.json` 与 `.junction-retirement-maintenance-v1.json` 均不存在。
- `G:\01_n8n-global.__quarantine__*` 数量为 0。
- 因此下次开机后启动项仍会启动原发布版本；不要假设当前 worktree 代码已部署。

## 已完成的代码工作

- 新增统一旧根 canonicalization：仅匹配精确旧根或完整边界子路径；兼容大小写和两种分隔符；拒绝 URL、普通文本、近似根、NUL、路径穿越和对象键冲突。
- 历史 `db.json` 只生成内存视图，不改写磁盘原文；增加旧/新 taskId 映射并保护冲突。
- Scanner、历史媒体、目录打开、E000 本地导入、投递、共享媒体重试、WB/OZON 来源媒体清理接入运行时路径映射。
- PostgreSQL 下载目录身份查询同时支持旧根与新根；readiness 增加旧引用计数。
- OZON 历史运行任务与 known pre/post platform 恢复接入安全 runtime projection；原始历史 payload 保留。
- `/api/v1/config` 增加 `legacyRootCompatibility` 状态；维护标记存在时写请求返回 503；兼容层失效时后台下载/发布 worker 保持停止。
- `/api/v1/config` 同时报告非敏感的 `maintenanceMode`；WB/OZON 网络恢复入口也受 fail-closed 门禁保护，仅保留 receipt/transition/lease 收尾接口。
- 退役脚本现分为 `Prepare -> DeployCompatibility -> Cutover -> Observe -> Finalize`；维护标记绑定恢复点并可在同一恢复点崩溃恢复。
- 停服最终备份后才以精确 CAS 取消 72 条 E001 遗留执行；重试时会验证“已精确取消”，不会重复修改。
- Junction 改名前写入 `QUARANTINE_RENAME_PENDING`，删除后立即写入 `FINALIZING_LINK_REMOVED`，显式回滚可覆盖各中间状态。
- 新写入路径使用当前根；历史路径仅在运行时/响应中映射。
- 未修改任何活动 n8n 工作流。当前核查仍为 39 个活动工作流，活动节点与 activeVersion 节点旧根引用为 0。
- 已知工作流版本保持不变：E004 `ac824488-c131-49d6-82c6-2098702566f8`；E006 `49758d49-2e80-47c9-b5b0-7665729a61ac`；E007 `32bc6f2c-1607-4574-99b4-92e98873fe20`。

## 测试状态（重启后已全部重跑）

- `npm ci`：通过。
- TypeScript typecheck：通过。
- ESLint 全量：通过。
- 完整测试：Server `1116/1116` 通过（另有 119 项依赖测试库的集成测试按既有配置跳过）；Web `173/173`；Shared `134/134`。
- PowerShell 7.6 静态安全测试：通过。
- GUID 命名 TEMP 目录原生 Junction 演练：改名与 `RemoveDirectory2W(DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS)` 均通过，目标 File ID 和证明文件保持不变；真实 `G:` 路径未变。
- PostgreSQL 18.4 只读验证：退役门禁 SQL、旧根 `ILIKE ... ESCAPE` 粗筛 SQL 均实际执行成功。
- 提交后仍必须重新执行生产 build，使 `apps/server/dist/build-info.json` 记录“当前 HEAD 且 dirty=false”，再运行发布门禁。
- 首次 `Prepare` 于恢复点 `D:\MerchRoute_Junction_Backups\20260902-195505` 安全中止：Robocopy `/ZB` 因当前账户没有 `SeBackupPrivilege` 返回 16。该恢复点没有 `state.json`，外部配置、服务、数据库与 Junction 均未改变；脚本已改用当前账户可执行的 `/Z`，失败恢复点原样保留作审计。
- 第二次 `Prepare` 于恢复点 `D:\MerchRoute_Junction_Backups\20260902-195705` 完成约 20.82 GB 目录镜像、两套数据库校验和 167 个当前/39 个 published 工作流导出后，在临时 env 的 `Set-Acl` 遇到 `SeSecurityPrivilege` 限制而安全中止。正式 env 哈希等于原备份，marker 不存在，服务/Junction 未变；脚本改用 `icacls` 仅修改 DACL，并新增 TEMP 文件 ACL 演练。

## 脚本状态

- 主脚本明确要求 PowerShell `7.4+`；本机执行目标为 PowerShell 7.6，不支持用 Windows PowerShell 5.1 执行运营动作。
- 两个脚本已使用 UTF-8 BOM，PowerShell 7 解析为 0 错误；默认安全测试只读，临时原生变更测试只触及 GUID 命名 TEMP 目录。
- 脚本禁止把 Legacy/Target/Delete/Quarantine 安全路径暴露为参数，且无 `Remove-Item`、`rd /s`、`Directory.Delete` 或其他删除回退。
- 脚本当前 SHA-256：
  - `retire-n8n-global-junction.ps1`：`0760B8C043E509BD607C8E619071B1A4CEECD453673402AEE69D3551E8DFD184`
  - `test-retire-n8n-global-junction-safety.ps1`：`E11388B0504C7BA92F7A9FDCC626E1B64D03E7A37847587B9641E12FF54356A9`

## 已收口的原风险点

1. 历史恢复入口已经强制 `assertOperational()`；只保留不会启动新文件/发布动作的 receipt、transition、lease 收尾接口。
2. OZON `withRuntimePaths()` 会先 canonicalize 配置根，并拒绝不属于当前根或受支持旧根的历史绝对路径。
3. OZON cleanup 的 `BLOCKED/CLEANED/SUPERSEDED` 均视为非 actionable；已知新根 `WAITING_TARGETS` 记录不再错误阻塞切换，但实际 `QUARANTINING/QUARANTINED` 与 lease 仍阻塞。
4. `PurchaseRepository.legacyRootReferenceCounts()` 的 SQL 已做生产库只读语法验证，并由精确路径二次过滤避免近似文本误报。
5. 退役脚本的 ACL、File ID、reparse tag/target、进程归属、最终备份、精确 CAS、同卷改名和唯一删除原语均已收口并通过静态/临时原生测试。
6. typecheck、lint、完整测试与 `git diff --check` 已通过；敏感信息扫描和提交后干净构建仍需在提交门禁中完成。

## 当前业务门禁与待处置项

- n8n 有 72 条非删除的 E001 `status='new'` 遗留执行：ID `312359–312430`，workflow `Wxng7hVbjMNhVOaO`，version `17606e89-4ded-46a3-ac74-4d7c23c001a3`。
- 这 72 条是 2026-08-31 的 `addDir` 突发；71 个源目录已不存在，剩余 1 个已有完整成功归档。禁止 retry/replay，避免重复付费抠图。
- 完整备份完成并停 n8n 后，才可用严格 CAS 事务仅把这 72 条 `execution_entity` 改为 `canceled` 并写 `stoppedAt`；必须精确匹配连续 ID、workflow/version/mode/new/NULL 字段与 `deletedAt IS NULL`，变更数必须恰好 72。不得修改 `execution_data`。
- n8n 大量 `running` 行是 `deletedAt IS NOT NULL` 的软删除 tombstone，不是活动执行；所有门禁查询必须加 `deletedAt IS NULL`。
- OZON cleanup batch `a85d58ff-5458-4ffd-a15b-83fd43e563c5` 为新根、`WAITING_TARGETS`、无 lease；r1 已失败且 r2 已成功。它不依赖旧 Junction，不得伪造为 `CLEANED/SUPERSEDED`。
- 初次核查时：无 `QUEUED/WAITING_RESOURCE/RUNNING` 下载任务，无活动 WB/OZON 发布任务，无未过期 lease；维护窗口前必须重新读回。

## 下次会话恢复顺序

1. 先读项目 `AGENTS.md` 与本交接文件；读回 `git status`、当前分支、HEAD、`git worktree list --porcelain`，确认仍在指定 worktree。
2. 确认 Junction、真实目标 File ID、端口/PID、实际运行源码 HEAD、外部 env/启动项/marker/backup/quarantine 状态没有漂移。
3. 选择性暂存并提交当前任务分支；敏感信息扫描后重新 build，确认 build-info 精确等于干净 HEAD。除非用户另行授权，不推送、不建 PR。
4. 运行 `Prepare` 创建受限 ACL 恢复点并在线预复制；备份实际 env、启动脚本/快捷方式、n8n 用户数据、两套数据库、活动工作流及 Junction/目标证据。任一校验失败即停止。
5. 运行 `DeployCompatibility`：仅停止并替换 MerchRoute，保持 n8n 在线；GET 读回兼容 readiness 与运行 commit 后才进入下一阶段。
6. 进入维护窗口：停止接收新任务，重新验证门禁；停止 MerchRoute 和 n8n；执行停服最终增量与唯一标签的数据库/工作流备份；随后精确取消 72 条 E001 遗留执行。
7. 再次排空并核验对象/Target/File ID，仅同卷改名到 quarantine；从任务 worktree 干净构建启动，完成即时验收。
8. 进入至少 7 个自然日观察期。覆盖 E001–E007、下载、历史预览、失败重试和下一次已授权的 WB/OZON 真实任务；低频链路未覆盖则自动延长。
9. 只有观察期与业务覆盖同时满足，且最终 target/File ID 校验通过，才允许调用 `RemoveDirectory2W(..., DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS)` 删除隔离 Junction；失败即保留，不得递归回退。

## 明确禁止

- 禁止对 `G:\01_MerchRoute` 或 Junction 使用 `Remove-Item -Recurse`、`rd /s`、递归 Robocopy 删除或任何递归回退。
- 禁止直接重放旧 n8n execution snapshot。
- 禁止批量替换历史 `db.json`、PostgreSQL、`workflow_history`、`execution_data`、receipt 或 media metadata 中的旧根。
- 禁止未经完整备份直接取消 72 条执行、编辑外部 env、改启动项或隔离 Junction。
- 当前安全停止点仍是“开发未提交、外部未变更、Junction 仍在线”；任何正式动作都必须通过提交后干净构建门禁。
