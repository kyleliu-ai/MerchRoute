# 交给升级智能体的完整执行任务

你是本机升级执行智能体。请在这台 Apple Silicon Mac 上把已经安装并正在使用的 MerchRoute、全局 n8n、受控 n8n 工作流、Jimeng 代理镜像和仓库内运行脚本安全更新到 `https://github.com/kyleliu-ai/MerchRoute.git` 的最新 `origin/main`，并持续执行到全部升级验收通过。不要只给教程、命令清单或计划。

这是“保留现有数据与登录状态的升级”，不是全新安装。仓库外数据库、凭据、媒体、PDD/1688 Chrome Profile、n8n 用户目录和服务配置都是必须保留的生产状态。

## 本机权威来源与强制二次确认

本机已有的 MerchRoute 源码、相关 n8n 工作流、PostgreSQL 数据库配置和 Jimeng 代理源码是当前权威版本，默认同步方向是“本机 → GitHub”。本提示词本身只授权智能体执行只读检查和可恢复备份，不构成“GitHub → 本机”的覆盖授权。

允许先执行 `git fetch`、`git diff`、提交/哈希比较和 GitHub 状态查询，但只读比较不等于更新授权。完成第 1、2 步后，必须向用户展示：

- 本机 HEAD 与 `origin/main` 的提交差异、领先/落后关系和文件级变更范围。
- 本机未提交代码、受控 n8n 工作流、PostgreSQL 配置/外部环境文件和 Jimeng 代理源码中可能被替换的内容。
- 仓库外备份位置、备份验证结果以及发生问题时的恢复点。

展示完成后必须暂停，明确询问用户是否“确认允许本次 GitHub → 本机更新”。只有用户在看到上述报告后再次明确确认，才能执行 `git switch`、`git pull`、merge、rebase、checkout、restore、工作流导入、配置写入、Jimeng 源码/镜像替换或其它反向覆盖操作。用户最初粘贴本提示词不算二次确认；用户未回复、拒绝或不在线时必须停止，不得自行继续。

## 当前发布契约与升级目标

### 已登记单人开发机的优先处理规则

如果仓库外存在 `MerchRoute/development/machine.json`，先读取[单人串行开发说明](../docs/SINGLE_DEVELOPER_WORKFLOW.zh-CN.md)并执行 `npm run workflow -- status`。固定目录中一次仅允许一个活动批次和一个写入任务；补充、测试、CI 修复复用该分支及 Draft PR，不按对话创建 worktree。

本机为权威来源，默认本机 → GitHub。此类开发机不执行下文通用安装分支的“快进到 origin/main”步骤，也不能把用户粘贴本提示词当成覆盖授权。先只读核对源码树、公开历史映射和已验收基线；内容相同但 squash 提交不同只更新经过核验的映射，不 pull、merge 或 rebase 本机。出现批次外的远端内容先停止报告，再按前述规则二次确认。

本批版本 `0.1.2` 为候选。开发完成、GitHub 已同步、正式运行已更新分别验收；v0.1.1 既有标签不可改写。独立运行包通过外部固定哈希核验全部源码、构建和依赖，无 `.git`、无旧 worktree 依赖；不得上线时重新编译替换已验收构建。

升级不得把开发 5173/4184、测试 4183 接到生产 4173 或生产数据库。`merchroute_dev` / `merchroute_dev_app` 仅用于开发，真实 n8n、PostgreSQL、Jimeng、媒体和 Profile 保持原位置。本批迁移阶段 A/B 只完成候选和 Draft PR，不能更改启动入口；用户合并并发布 v0.1.2 后另行批准正式切换。切换前备份、检查活动任务及 PID，失败只回滚代码/入口，不盲目恢复业务状态，旧目录至少保留七天且清理另批审批。

本提示词对应当前发布快照：Node.js `22.23.1`、npm `10.9.8`、n8n `2.32.6`、PostgreSQL `18.4`、Playwright `1.61.1`、Jimeng `0.9.1`；n8n 清单为 36 个唯一工作流和 3 个部署包；数据库映射为 `merchroute` → `merchroute_app`、`merchroute_n8n` → `merchroute_n8n`。

升级目标必须从目标 `origin/main` 提交中的以下机器可读文件确定，不能只相信本提示词中的静态文字：

- `deployment/runtime-versions.json`：工具链、n8n、PostgreSQL、Playwright、社区节点和 Jimeng 镜像版本。
- `deployment/n8n/manifest.json`：唯一工作流数量、ID 集、3 个部署包、哈希和停用导入策略。
- `deployment/postgres/init/01-databases.sh`：`merchroute` / `merchroute_app` 与 `merchroute_n8n` / `merchroute_n8n` 的所有权契约。
- `package-lock.json`：npm 依赖锁定结果。

二次确认前，只允许用 `git show origin/main:<路径>` 只读提取目标提交中的上述契约，并将本机值、目标值和差异列入报告；不得 checkout 文件。取得二次确认并完成快进更新后，重新从工作树读取四份文件，运行 `npm run versions:check`、`npm run deployment:verify` 和 `npm run deployment:test`。若机器可读值与本节或 README 不一致，立即停止并报告“发布文档与代码契约不同步”。升级不得重命名、重建或交换现有两个数据库及其 owner 角色。

## 强制成功条件

只有同时满足以下条件才可报告升级成功：

1. 升级前已记录旧 commit，完成仓库外配置、两个 PostgreSQL 数据库和两个浏览器 Profile 的可恢复备份；备份不在 Git 仓库内。
2. 工作树中的本地修改已被审查并安全提交到独立分支，或工作树原本干净；不得用 `reset --hard`、`checkout --`、`clean -fd` 丢弃修改。
3. 本地分支快进到最新 `origin/main`，记录新 commit；不得直接修改或强推远程 `main`。
4. 升级前后的 `MERCHROUTE_BROWSER_PROFILE_ROOT` 完全相同；PDD 与 1688 Profile 目录、人工登录状态文件和可复用性都未被空目录替换。
5. 仓库外 `n8n.env` 明确包含 `N8N_LISTEN_ADDRESS=127.0.0.1`、`NODES_EXCLUDE=[]`、`N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200`，同时保留原来的 `N8N_ENCRYPTION_KEY`、数据库密码、`MERCHROUTE_RUNTIME_KEY` 及其它自定义设置。只比较是否一致或指纹，不输出值。
6. 停机前 E007 守卫确认没有 `new`、`running`、`unknown`、`waiting` 的 n8n 执行；重启后再次确认没有上述非终态记录。
7. E007 受控工作流 ID 为 `G8MSbp9u0dudSgba`，工作流级 `executionTimeout=1200`；MerchRoute 下载超时仍为 `900000` ms，恢复模式为 `IDEMPOTENT_REPLAY`。
8. 36 个受控 n8n 工作流导入后 ID 集与清单完全一致，全部保持停用；不得为验收启用或触发任何工作流。
9. MerchRoute、n8n、Jimeng 和 PostgreSQL 健康检查通过；`npm run check`、`npm run deployment:verify`、`npm run deployment:test`、`npm run n8n-runtime:test` 全部通过。
10. 最终报告不包含密码、Token、Cookie、数据库 URL、授权头、Profile 内容或业务数据。

任一强制项未通过时，结论必须是“升级未完成”，保留现场并给出从最近恢复点继续的命令；不得降低标准。

## 绝对禁止事项

- 禁止用空目录覆盖现有登录 Profile：不得把 `<EXISTING_PROFILE_ROOT>` 改成新的默认目录或任何新空目录。默认目录只适用于从未安装过的新机器。
- 不得复制、删除、清空、重命名或合并 PDD/1688 User Data Directory；不得读取、导出、打印或上传 Cookie、Local Storage、账号和授权值。
- 不得重新生成或覆盖 `N8N_ENCRYPTION_KEY`、数据库密码、MerchRoute 运行密钥和凭据加密密钥。
- 不得在 E007 仍有非终态执行时停止 n8n、导入工作流、切换 Profile 或重放下载任务。
- 不得直接 `UPDATE`/`DELETE` n8n 的 `execution_entity`，不得把 MerchRoute 的 `download_jobs` 从 `RUNNING` 盲目改回 `QUEUED`，不得用新的任务 ID 重放。客户端超时或断线不等于服务端已停止。
- 不得创建商品、发布 Listing、生成付费媒体、上传真实素材、触发 Webhook、启用工作流或运行定时任务。
- 不得把备份、`.env`、数据库 dump、n8n 用户目录、浏览器 Profile、日志或媒体加入 Git。

## 执行流程

### 1. 识别当前安装，先只读回读

确认系统为 macOS arm64，仓库路径正确，远程为 `https://github.com/kyleliu-ai/MerchRoute.git`。记录但不要泄露：

- 当前分支、旧 commit、`git status --short`、`git remote get-url origin`。
- `MERCHROUTE_APP_HOME`，默认是 `~/Library/Application Support/MerchRoute`。
- 仓库外 `secrets/n8n.env`、`secrets/merchroute.env`、`deployment/state.json` 是否存在。
- 从现有 `n8n.env` 和 `state.json` 分别读取 `MERCHROUTE_BROWSER_PROFILE_ROOT`；两者都存在时必须一致。
- 该根目录下 PDD、1688 子目录与 `deployment/browser-profiles.json` 是否存在。只报告路径、存在性和状态，不读取 Cookie。
- `N8N_ENCRYPTION_KEY`、数据库密码、运行密钥只记录 SHA-256 指纹用于升级后比对，禁止输出原值；指纹也只写入仓库外临时报告。

如果已有安装却缺少可判定的 Profile 根目录，或 `n8n.env` 与 `state.json` 记录不一致，立即停止并让用户确认真实目录；不得猜测。

确定真实应用目录后，在当前升级 shell 中以带引号的绝对路径设置 `MERCHROUTE_APP_HOME`；后续所有脚本都必须指向同一个目录，不能一部分使用默认目录、一部分使用自定义目录。

### 2. 保护本地修改并完成备份

先审查本地修改和未跟踪文件。若存在真实代码/工作流更新，执行 Gitleaks 与禁入规则扫描，只选择性暂存安全文件，提交到独立分支并推送 Draft PR；不得把这些修改覆盖掉再拉取 main。若仅有生成物、日志或运行数据，也不得擅自删除，先报告。

在仓库外新建带时间戳且权限仅当前用户可读的备份目录，至少备份：

- `MERCHROUTE_APP_HOME` 中的 `secrets`、`deployment`、`n8n` 和 `n8n-runtime`。
- 已判定的完整 PDD/1688 Profile 根目录；复制前确认没有 Chrome、Playwright 或 n8n 进程持有 Profile 锁。若当前仍被业务任务占用，不得复制不一致快照，也不得为备份强停任务；把 Profile 备份标为待完成，并在第 5 步通过 E007 守卫、优雅停机后完成。
- PostgreSQL `merchroute` 与 `merchroute_n8n` 的 custom-format `pg_dump`，并执行 `pg_restore --list` 验证备份可读。
- 当前仓库 commit、分支、远程和版本清单。

数据库密码只能通过子进程环境变量 `PGPASSWORD` 传入，不能出现在命令参数、终端回显或日志中。备份完成前不得写配置、停服务或导入工作流。

### 3. 更新仓库代码，但不启动或写配置

只有在工作树干净或本地修改已安全保留、仓库外备份已验证，并且用户已经在差异报告后完成二次明确确认时，才可执行：

```bash
git fetch --prune origin
git switch main
git pull --ff-only origin main
git rev-parse HEAD
git status --short
```

必须是快进更新且工作树干净。不要把问题报告中的 `7519bfe` 当作固定目标；它只是发现问题时的 main，实际目标始终是当前远程 `origin/main`。

按照 `.nvmrc` 和 `deployment/runtime-versions.json` 安装/选择精确 Node、npm、全局 n8n 与其它固定版本，然后执行 `npm ci`。不得使用浮动的 `latest`。

### 4. 停机前执行 E007 只读守卫

先确保仍使用升级前读取到的同一个仓库外 `n8n.env`，运行：

```bash
node deployment/scripts/n8n-upgrade-guard.mjs --phase=pre-stop
```

该命令只读取 n8n PostgreSQL 的执行元数据，不读取执行 payload，不修改数据库。只有输出 `safe=true` 且 `blockingExecutionCount=0` 才能继续。

若发现 E007 的 `new`、`running`、`unknown` 或 `waiting`：

1. 立即停止升级，不停止 n8n，不运行 `prepare`，不导入工作流。
2. 在 n8n 的 Executions 页面按工作流 `E007-v01-1688产品媒体下载` 和状态筛选，结合输出目录、MerchRoute 下载任务租约与执行时间核对真实状态。
3. 正常运行中的任务等待其终态。疑似悬挂时报告执行 ID、状态和开始时间，请用户授权后再通过 n8n 正式停止功能处理；禁止直接改库。界面中的工作流/状态筛选参考 [n8n 官方 Executions 说明](https://docs.n8n.io/workflows/executions/all-executions/)。
4. 不得自动 Retry。只有确认原执行未产生副作用且仍沿用原 `downloadJobId`/幂等身份时，才能另行制定恢复方案。

处理后重新运行守卫，未通过不得继续。

### 5. 优雅停止服务并安全重写外部配置

使用当前安装实际采用的 `launchd`、终端进程或服务管理方式向 MerchRoute 和 n8n 发送正常终止信号；不得直接 `kill -9`。等待端口 `4173`、`5678` 释放。Jimeng/PostgreSQL 可保持运行，除非升级步骤需要重建。

如果第 2 步因为 Profile 正在使用而延期备份，现在确认 Chrome/Playwright/n8n 已释放两个 Profile，再完成完整 Profile 备份并核对可读性。配置、两个数据库和两个 Profile 的备份全部完成前，仍不得运行 `prepare`。

然后以升级前读取到的 Profile 根目录作为显式保护参数运行：

```bash
MERCHROUTE_BROWSER_PROFILE_ROOT='<升级前的绝对路径>' \
node deployment/scripts/bootstrap.mjs prepare
```

`prepare` 必须在写入前核对现有 `n8n.env` 与 `deployment/state.json`。若显式路径与已持久化路径不同，它必须失败；不得通过删除状态文件绕过。

写入后立即回读并验证：

- `MERCHROUTE_BROWSER_PROFILE_ROOT` 与升级前逐字一致，PDD/1688 原目录仍存在；默认新目录未被创建或采用。
- `N8N_LISTEN_ADDRESS=127.0.0.1`。
- `NODES_EXCLUDE=[]`，从而保留 E006/E007 实际使用的受控节点能力。
- `N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200`。
- 旧的 n8n 加密密钥、数据库密码、运行密钥和凭据加密密钥指纹全部一致。
- 其它已有自定义 n8n 环境变量没有被无故删除。

任一项不一致，立即从备份恢复配置并停止，不得启动 n8n 验证错误配置。

### 6. 更新组件并导入受控工作流

执行固定版本校验、依赖安装、Jimeng 镜像重建、MerchRoute 构建和数据库迁移。不得恢复历史数据库或重建已有数据库角色。

运行：

```bash
npm run versions:check:full
npm run deployment:verify
npm run deployment:test
npm run n8n-runtime:test
npm run build
node deployment/scripts/bootstrap.mjs verify-browser-profiles
node deployment/scripts/bootstrap.mjs import-n8n
```

Profile 烟测只允许离线 `data:` 页面，不访问平台页面、不读取 Cookie。导入器必须把 36 个受控工作流写入同一个现有 n8n 数据库并全部保持停用；不得创建副本，不得启用 E007。导入后通过 n8n CLI 回读 ID 集、名称、停用状态和 E007 的 `executionTimeout=1200`。

### 7. 启动并执行升级后恢复核验

按原服务管理方式启动 n8n、MerchRoute 和更新后的 Jimeng。确认服务仍仅监听本机回环地址，并检查：

```text
http://127.0.0.1:5678/healthz
http://127.0.0.1:4173/api/v1/health
http://127.0.0.1:8000/ping  -> pong
```

n8n 健康后等待启动恢复完成，再运行：

```bash
node deployment/scripts/n8n-upgrade-guard.mjs --phase=post-start
```

必须再次得到 `safe=true`。如果旧 E007 执行仍显示非终态，保持工作流停用，停止后续业务操作并按第 4 步核对；不得直接改 `execution_entity`。

随后执行：

```bash
node deployment/scripts/bootstrap.mjs configure-merchroute
node deployment/scripts/bootstrap.mjs verify
npm run check
```

`configure-merchroute` 只核对/补齐 E007 配置与下载投影，不得触发工作流。最终确认 36 个工作流全部停用、E007 输出目录及 Webhook/恢复模式正确、PDD/1688 Profile 仍为原目录。

### 8. 最终安全检查与报告

执行 `git status --short`、仓库禁入规则和 Gitleaks。升级产生的日志、备份、Profile、数据库 dump、`.env`、Cookie 和运行数据不得成为 Git 候选。

最终只输出以下脱敏摘要：

```text
升级结论：成功 / 未完成
平台：macOS arm64
Git：旧 commit -> 新 origin/main commit
备份：仓库外目录、两个数据库可读性、配置与 Profile 备份状态
固定版本：Node、npm、n8n、PostgreSQL、Playwright、Jimeng
配置：Profile 根目录升级前后是否一致；listen/exclude/graceful 三项是否正确
E007：pre-stop / post-start 守卫结果；executionTimeout；MerchRoute 下载租约未被盲目重置
n8n：受控工作流 36；启用数量 0；ID 集一致性
服务：MerchRoute、n8n、Jimeng、PostgreSQL 健康状态
验证：deployment:verify、deployment:test、n8n-runtime:test、check、Gitleaks
人工待处理：无 / 明确列表
```

不要在报告中输出任何凭据值、数据库 URL、Cookie、业务 payload 或 Profile 文件内容。
