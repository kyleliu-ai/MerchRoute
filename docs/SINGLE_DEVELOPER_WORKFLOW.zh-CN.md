# 单人串行开发、候选与正式发布

## 边界

一个固定开发目录、一个活动批次、一个写入任务。批次分支为 `work/<名称>-<YYYYMMDD-HHmm>`，测试与 CI 修复复用同一分支和 Draft PR。只在并行任务、紧急修复和高风险实验时另建 worktree。不能在有未知修改时切换分支、stash、reset 或混入其他任务。

本机为权威来源，默认本机 → GitHub。远端比较不是覆盖授权；GitHub → 本机必须先报告差异、备份、再次获得用户确认。新批次从已验收本机完整基线建立。源码完成、GitHub 同步、正式运行更新是三个独立状态。

批次文档只描述长期流程，不把某个正在开发或运行的版本写成永久事实。实际开发分支、正式运行版本、发布绑定和 GitHub 映射必须通过仓库外登记与只读状态命令回读。

## 外部目录登记

Windows 用户数据根为 `%LOCALAPPDATA%\MerchRoute`，macOS 为 `~/Library/Application Support/MerchRoute`。以下均在仓库外，Windows ACL 只授予本用户和 SYSTEM，macOS 目录 700、凭据文件 600：

| 内容 | 相对用户数据根的位置 |
|---|---|
| 独立正式运行包 | `releases/<版本>-<构建标识>/` |
| 固定启动器/发布指针 | `Start-MerchRoute.ps1` / `current-release.json` |
| 固定 Node 工具链 | `toolchains/` |
| 本机登记/活动批次 | `development/machine.json` / `batch.json` |
| 开发数据库连接和合成媒体 | `development/database.json` / `sandbox/` |
| 验证日志、候选和映射 | `development/verification/`、`candidates/`、`publication.json` |
| 备份与恢复证据 | `recovery/` |

`machine.json` 记录 `schemaVersion:1`、`sourceAuthority:"LOCAL"`、`devRoot`、本机 `baseline.commit/tree`、`github.repository/baselineCommit/baselineTree`、`nodePath/nodeSha256`、Gitleaks 和 GitHub CLI 路径、`releasesRoot`、`runtimeHome`、`acceptedReleaseFile`、`recoveryDirectory` 及生产入口位置。只能在本机写入真实绝对路径，不把登记文件提交到仓库。

固定目录首次建立：确认空目录 → 仓库外完整 Git bundle 与未提交文件备份 → 仅从已验收本机分支使用 `git clone --no-local --single-branch --no-tags --no-checkout` → 在本机基线提交建立批次。不共享旧对象库、hardlink、alternates 或 node_modules。源码树、每个受控文件和二进制哈希相同后再安装依赖。

Windows 固定开发仓库建议使用不含中文、空格、括号和 shell 特殊字符的绝对路径，例如 `F:\Projects\MerchRoute-System\merchroute-ai-system`。需要从旧路径迁移时，只移动登记的固定开发仓库，不整体重命名包含备份、旧 worktree、业务资料或其他项目的共享父目录，也不移动独立正式运行包、数据库、n8n、Jimeng、媒体目录或凭据。

迁移分为两个可核验阶段：

```text
npm run development:migrate-root -- preflight <参数> --apply --approved
# 退出引用旧仓库的开发进程后，在同一磁盘执行一次原子目录移动
# 在目标目录运行 npm ci，重建仍指向旧绝对路径的 workspace 链接
npm run development:migrate-root -- finalize --home <外部 development 目录> --apply --approved
```

`preflight` 要求干净的独立 Git 仓库、唯一 worktree、本机分支起点与公开 `main` 的内容树一致、ASCII 目标路径不存在，并在仓库外保存 Git bundle、登记文件、当前发布指针和固定启动器。移动后必须从锁文件执行 `npm ci`；`finalize` 会拒绝缺失、损坏、仍指向旧目录或仓库外的依赖链接，并重新核对提交、tree、分支、bundle 与登记文件哈希，归档上一批为“已合并待发布”，再更新 `machine.json` 和新的活动批次。旧路径仍存在、外部登记被并发修改或任何身份不一致时必须停止。正式运行包与固定启动器不依赖开发仓库，因此迁移开发目录不得触发正式服务重启。

## 开发数据库与网络隔离

管理员凭据仅在本机受限文件填写，不发送聊天。仅创建空数据库 `merchroute_dev` 和最小权限角色 `merchroute_dev_app`，不赋予 superuser、createdb、createrole、replication、bypassrls 或生产库 CONNECT。若生产库仍对 PUBLIC 开放导致隔离不成立，停止并另行报告，不能擅改生产 ACL。

`database.json` 包含 `databaseUrl`（该专用本机角色/库）和外部绝对 `sandboxRoot`。现有未知角色/库不得接管。以该角色回读数据库身份、生产连接权限、重复创建结果后才标记完成。

`npm run dev` 不加载项目 `.env` 或生产环境文件；只使用登记的开发连接、合成媒体和独立测试密钥。密钥首次生成后保存在外部受限配置中，重复启动复用，不随重启轮换。前端 5173 仅代理 4184，E2E 4183，生产默认 43173 并以外部发布绑定为准。端口占用或被系统排除时直接失败，不自动漂移。开发进程默认阻断 fetch/http/https 外部业务调用，不启动 n8n；真实联网功能需要独立授权测试，不能临时去掉防护来验收。

## 操作入口

先运行 `npm ci`，使用登记的固定 Node；所有变更操作默认需当前任务授权并显式 `--apply --approved`，参数不是用户授权的替代品。

```text
npm run workflow -- status
npm run workflow -- begin --name <batch> --task-id <owner> --baseline <local-sha> --dry-run
npm run workflow -- begin --name <batch> --task-id <owner> --baseline <local-sha> --apply --approved
npm run workflow -- verify --task-id <owner> --quick
npm run workflow -- publish --task-id <owner> --files-json <外部文件清单> --message <提交说明> --dry-run
npm run workflow -- publish --task-id <owner> --files-json <外部文件清单> --message <提交说明> --apply --approved
npm run workflow -- verify --task-id <owner> --full
npm run workflow -- publish --task-id <owner> --dry-run
npm run workflow -- publish --task-id <owner> --apply --approved
npm run workflow -- release prepare --task-id <owner> --dry-run
npm run workflow -- release prepare --task-id <owner> --apply --approved
```

`files-json` 是明确相对文件名数组，不能使用 `git add .`。提交前做禁入和 Gitleaks 扫描；完整检查绑定干净提交、文件树与日志哈希。完整本机迁移验收包含 Windows 安全检查，需要 Docker 中本任务独占的临时 PostgreSQL 18.4 测试实例，不连接生产数据库；结束只删除自己创建且标签匹配的测试容器。

本机完整回归将 Vitest 工作进程上限固定为 2，避免大量并发数据库迁移测试争抢资源；不增加测试超时、不跳过断言。独立运行包验收使用真实 `apps/server/dist/index.js` 入口，所有数据库与环境变量均指向本任务的测试沙箱。

发布用已验收本机完整文件树，以公开 main/上次公开提交作为父提交生成独立公开历史，只推送公开提交，作者邮箱使用 GitHub noreply。公开分支、提交说明和 Draft PR 标题由当前活动批次名与已验收候选版本生成，禁止沿用上一个版本或任务的固定名称。不能直接推送包含旧私有历史的本机开发分支。PR 回读必须 Draft、目标 main、产品版本、源码树和文件清单精确匹配。远端 main 出现批次外更新、PR 不再 Draft 或远端被别人修改时停止。

`command.lock` 不能自动偷取。命令失败或进程崩溃后，核对记录 PID、任务、时间和哈希；确认进程不存在且本次明确批准后才能隔离旧锁并重试。活动批次不是一个可随意清空的缓存。

## 正式包与候选验收

`release prepare` 读取干净 Git HEAD 的标准文件字节和已构建产物，安装独立运行依赖，生成 `installed-release.json`，把清单哈希固定到包外。每次启动和 About 指纹检查都实际读取所有文件；缺失、篡改、未声明程序文件、外部依赖链接、`.git` 或环境文件均拒绝。包内 workspace 依赖链接只允许指向包内。

源码 ZIP、源码加预构建 ZIP、候选清单与 SHA256SUMS 来自同一验收构建。它们不是 GitHub 自动生成的源码 ZIP。不同平台的 node_modules 不混用，固定 Node 的可执行文件也核对哈希。日志和缓存只写包外。

完整验收记录同时固定运行包清单哈希、源码身份和每份发布资产哈希。即使源码提交相同，重新构建或更换候选包后也必须重新验收，不能用旧通过记录发布新构建。已验收记录写入开始后若发生故障，保持当前已验证运行包并标记待人工恢复，不自动切回可能与记录不一致的旧包。

独立正式包只安装服务端/共享库的运行依赖，前端由已验收的 dist 提供；开发目录仍安装完整开发依赖。启动引导同时核对其本地校验模块哈希，不能只验证入口文件后加载未经核对的校验器。文件读取使用有上限的并发队列，不减少文件范围或跳过哈希。

相同候选重复 prepare 返回已验证记录，不重复安装；发现没有成功记录的残留目录则停止，保留 `candidate-intent.json` 和现场。智能体必须先检查并经批准将残留隔离到恢复目录，不能覆盖未知文件或把中断目录直接认定成功。

## 发布与切换（需要下一阶段批准）

1. 阶段 A/B 完成候选和 Draft PR、全部 CI 通过后，保持正式服务与旧快捷方式不变，等待用户合并、发布相同版本及上传验收资产。
2. 用户合并后只读校验 PR、Release、源码树和每份发布资产 SHA-256。提交号可以因 squash 不同，文件树与内容指纹不能伪造。更新映射不能自动 pull 或 rebase 本机。
3. 重新记录真实运行 PID、开始时间、路径、构建、环境与业务空闲结果到外部 `runtime-before-switch.json`。旧 Git 启动器作为 `legacy` 回滚入口时，记录脚本路径与 SHA-256；不移动旧目录。
   legacy 记录必须包含原 Node 路径/哈希、全部三个 dist 目录的 `fileHashes`、原唯一已验收记录的不可变备份 `previousAcceptedFile/previousAcceptedSha256`、原 productVersion/commit/tree。它只用于回滚到迁移前的已核验版本，不是新版本绕过独立运行包规则的通道。
4. 当前用户批准写入外部短期有效 `approval-file`：`operation`、`productionRestartApproved`、`releasePublishedApproved`、`expiresAt`、`expectedCurrentCommit`、`targetCommit`、`expectedPid` 和是否允许 `rollbackApproved`。这些值必须来自本次核验，不能复制历史授权。若上次日志为 `FAILED`，只有证明旧进程仍由原 PID/提交运行、发布指针不存在、已验收记录仍指向旧版，并获得本次 `recoverFailedPreStopApproved` 明确授权后才可重试；`RECOVERY_REQUIRED` 不得使用该通道。
5. `release activate ... --approval-file <外部批准文件> --dry-run` 通过后，才可 `--apply --approved`。先备份入口，检查任务/租约/锁，再核对 PID，只处理确认的当前服务。Windows 固定入口和开机/桌面快捷方式共同使用外部发布指针。
6. 两次独立检查周期读取运行包、PID、About 和只读页面，随后才能更新唯一已验收发布记录。不得因健康码 200 单独宣布全部功能验收通过。
7. `release rollback` 同样要求当前授权、兼容性和业务空闲检查。失败后 `release-journal.json` 为 `RECOVERY_REQUIRED` 时先人工核验，不重复切换。仅回滚代码/入口，不还原旧数据库或审核状态，尤其不能覆盖上线后已产生的业务写入。
8. `finish` 仅允许干净且已验收的本机发布关闭批次，归档公开映射和验证记录，下一批仍在同一个目录开始。Windows 切换适配器不在 macOS 执行；公共 Node 契约必须经过 macOS CI，macOS 正式安装另走其平台验收。

## 回滚与旧目录

切换前失败，原生产服务不变。切换后失败，保留诊断、重新检查业务写入和兼容性后再恢复旧绑定。不恢复数据库历史状态。所有旧仓库、worktree、Profile、n8n、Jimeng、业务数据和备份本次保留；至少观察七天，并逐项证明无使用依赖后另行审批清理。

最终交付分别列出开发批次、GitHub Draft/CI、候选包、正式运行版本、未完成项及恢复点。未通过管理员输入、测试、发布或切换门禁时必须报告未完成，不把“源码已写好”写成“迁移完成”。
