# MerchRoute 部署故障排查

排查时不得把 `.env`、`credentials.local.json`、数据库 URL、Token、Cookie 或日志中的授权头粘贴到聊天。只报告错误类型、HTTP 状态、服务名和已脱敏路径。

## 端口冲突

标准端口为 PostgreSQL `5432`、MerchRoute `4173`、n8n `5678`、Jimeng `8000`。运行：

```bash
node deployment/scripts/preflight.mjs
```

`known-service` 表示检测到本部署的健康端点；`occupied` 表示未知进程占用，必须先确认进程归属再停止或改端口。不要盲目结束系统服务。PostgreSQL 只有带 Compose 项目标签 `merchroute-postgres` 的容器才视为可安全重用。

## Docker Desktop 未就绪

先打开 Docker Desktop，等待 `docker info` 成功，再重跑部署脚本。Apple Silicon 必须使用支持 `linux/arm64` 的 Docker Desktop；Jimeng 镜像同时声明支持 `linux/amd64` 与 `linux/arm64`，但不要在 Rosetta 下混用不同架构的旧缓存。

```bash
docker compose -f deployment/postgres/compose.yaml ps
docker compose -f integrations/jimeng-free-api-all/compose.yaml ps
docker compose -f integrations/jimeng-free-api-all/compose.yaml logs --tail=100
```

分享日志前先检查授权头、session 和签名 URL；如有敏感值，只描述错误，不发送原文。

## PostgreSQL 启动或认证失败

部署只在空数据卷首次创建 `merchroute` 与 `merchroute_n8n` 两个数据库及各自角色。查看容器健康状态，不要把 `deployment.env` 打印到终端：

```bash
docker compose -f deployment/postgres/compose.yaml ps
docker compose -f deployment/postgres/compose.yaml logs --tail=100 postgres
```

如果数据卷已由不兼容配置创建，先备份需要的数据，再由用户明确授权是否删除卷；部署智能体不得自动删除数据库卷。

## n8n 无法启动或社区节点缺失

确认版本与全局安装位置：

```bash
n8n --version
node --version
npm --version
```

期望分别为 `2.32.6`、`v22.23.1`、`10.9.8`。Windows 默认 n8n 命令位于 `%APPDATA%\npm\n8n.cmd`。`globalConstantsApi` 缺失时，在外部 n8n 用户目录的 `.n8n/nodes` 安装 `n8n-nodes-globals@1.1.0`，然后重启 n8n。

## n8n 所有者尚未初始化

首次启动后打开 <http://127.0.0.1:5678>，只在浏览器本机完成所有者创建。完成前 `import:credentials` 会提示找不到 owner。初始化后重新运行原部署脚本即可；稳定 ID 会避免重复创建。

## E006/E007 报脚本、Chrome 或 Sharp 不存在

先运行 `npm run n8n-runtime:test`。目标电脑的运行源码应在仓库外 `n8n-runtime/scripts/`，浏览器 Profile 应在 `browser-profiles/`；两者都不应位于 Git 仓库。检查外部 `secrets/n8n.env` 中的 `MERCHROUTE_N8N_RUNTIME_DIR`、`MERCHROUTE_BROWSER_PROFILE_ROOT` 与 `MERCHROUTE_BROWSER_EXECUTABLE` 是否为当前系统绝对路径，不要手改仓库内工作流 JSON。重新执行平台部署脚本会安全同步源码并执行锁文件安装，不会删除 Profile 或 Cookie。

## PDD/1688 专用 Profile 未创建、登录失效或无法无头复用

先确保 E006/E007 均保持停用，再分别执行：

```bash
node deployment/scripts/bootstrap.mjs browser-profiles --profile=pdd --force
node deployment/scripts/bootstrap.mjs browser-profiles --profile=1688 --force
node deployment/scripts/bootstrap.mjs verify-browser-profiles
```

PDD 使用普通 headed Google Chrome：在专用窗口中人工登录，手动关闭该窗口，再回终端按 Enter。1688 使用 Playwright headed persistent context：在专用窗口中人工登录并保持窗口打开，回终端按 Enter，让脚本只读确认登录/验证页已消失后自行关闭。不要把账号、短信码、Cookie 或截图发给智能体。

默认目录是仓库外的 `browser-profiles/pdd` 和 `browser-profiles/1688`。两者不得相同，不得指向系统默认 Chrome User Data，不得从另一台电脑复制。若 `verify-browser-profiles` 报 Profile busy，先确认哪个 Chrome、n8n 或下载器进程真实占用对应目录并正常结束它；不要直接删除活动的 `.pdd.lock`、`.e007.lock` 或 `Singleton*`。烟测只打开离线 `data:` 页面，不会验证商品下载，也不会启用或触发工作流。

## 缺失凭据或只读探测失败

凭据文件在仓库外 `secrets/credentials.local.json`。先按 [CREDENTIAL_SETUP.zh-CN.md](CREDENTIAL_SETUP.zh-CN.md) 的逐项步骤获取平台凭据；部署智能体必须向用户讲解操作路径，不能只报缺少哪个字段。

`merchroute-runtime.runtimeKey` 是例外：它应保持为空，导入脚本会从仓库外运行环境中取用自动生成的值。其他必需空字段会在生成任何导入文件前失败。用户应在本地编辑器修正，不要把值发给智能体。HTTP `401/403` 通常表示授权失效或权限范围不足；`429` 等待平台限流窗口后最多重试两次；`5xx` 保留部署状态后重试。任何探测都不得改成创建商品、发布 Listing、生成媒体或上传素材。

Jimeng 会话探测只有响应 `live: true` 才通过。WB/OZON 使用类目/账号连接等只读接口；AI 服务使用模型列表或认证接口。

## 工作流数量或启用状态不正确

```bash
npm run deployment:verify
node deployment/scripts/bootstrap.mjs verify
```

仓库验证必须是 36 个唯一工作流、3 个部署包。新 n8n 数据库回读也必须恰好 36 个并全部 `active=false`。如果数据库已有其他工作流，应停止并确认是否使用了错误的 n8n 数据库；不要删除现有工作流。

## macOS 的 E001–E005 监听路径含反斜杠

未来全新安装的正确路径必须形如：

```text
/Users/example/Documents/01_MerchRoute/01_monitorFolder/E001-抠图-监听
```

E001–E005 的 Local File Trigger 中不得出现 `\`，也不得混用 `/` 与 `\`。先不要启用工作流；运行 `prepare`，再运行 `import-n8n`。导入器会在写入 n8n 前逐项核对五条精确路径，`verify` 会通过 n8n CLI 导出后再次核对。若仍失败，报告 `n8n-e001-e005-local-trigger-paths` 的脱敏错误和数据根路径，不要手改受控工作流 JSON。

当前代码既可保证未来全新安装使用 POSIX 路径，也可在既有安装升级时保留原有 Profile 与外部状态。既有 Mac 必须使用 [AGENT_UPDATE_PROMPT.zh-CN.md](AGENT_UPDATE_PROMPT.zh-CN.md) 的升级流程；不要把新装默认目录当成迁移目标。

## E003 缺少 category-scene-rules.json

规范位置只有：

```text
<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json
```

重新运行 `node deployment/scripts/bootstrap.mjs prepare` 会创建 `00-config`，从仓库受控文件复制到该唯一位置，并回读验证 JSON 与 SHA-256；重复执行不会创建副本。不要改用旧的 `<MERCHROUTE_DATA_ROOT>/config`，也不要从聊天、旧机器或未知备份复制规则文件。`MERCHROUTE_CATEGORY_RULES_FILE` 必须指向上述绝对路径，导入前验证失败时不得继续或启用 E003。

## E003 在 macOS 报 base64 未定义、S013 类型错误或出现假成功

这些现象属于同一组受控工作流契约问题：旧 POSIX Shell 引号会让 `node -e` 中的 `'base64'`、`'utf8'` 丢失；历史参数可能把标题长度保存为字符串；旧 S013 调用失败后还可能继续错误输出，使 E003 没有产物却显示成功。

当前受控版本要求：

- E003、S014、S011 及另外 5 个共用隐藏命令辅助函数的工作流使用 POSIX 安全单引号写法。
- E003 输出目录为 `<MERCHROUTE_DATA_ROOT>/02_GenerateFolder/E003-7套图-下载`，macOS 物化后必须是纯 `/` 绝对路径。
- `titleLength`、`titleDescriptionLength` 必须是正整数，同时兼容历史拼写 `titleLenth`、`titleDescriptionLenth`。
- S013 调用设置 `convertFieldsToString=false` 和 `onError=stopWorkflow`，关键子流程失败必须使 E003 失败。

先保持 E003 停用，执行 `npm run deployment:test` 与 `npm run deployment:verify`，再通过部署脚本导入并回读节点配置。不要直接重放已经调用过上传、AI 或 Jimeng 的旧执行；本项验收不得自动生成付费媒体。

## n8n 有 E007，但 MerchRoute 系统配置或数据库投影缺少 E007

这是旧版全新安装默认配置的初始化缺口，不是用户操作错误。更新到包含修复的代码并重启 MerchRoute，然后运行：

```bash
node deployment/scripts/bootstrap.mjs configure-merchroute
node deployment/scripts/bootstrap.mjs verify
```

`configure-merchroute` 会幂等补建 E007 系统配置，使用 `<MERCHROUTE_DATA_ROOT>/03-1688ProductMedia`、`http://localhost:5678/webhook/1688-product-media-download` 和 `IDEMPOTENT_REPLAY`，同步 E007 工作流参数与 PostgreSQL 投影。它不会启用或触发 n8n 工作流。若已有 E007 的关键值不同，命令会停止并报出字段，不会覆盖。

## Jimeng `/ping` 失败

```bash
docker compose -f integrations/jimeng-free-api-all/compose.yaml build --no-cache
docker compose -f integrations/jimeng-free-api-all/compose.yaml up -d
curl --fail http://127.0.0.1:8000/ping
```

期望正文为 `pong`。`/app/data` 必须由外部 Docker 卷持久化，浏览器缓存和任务台账不得复制进仓库。

## macOS 升级准备改写已有浏览器 Profile 路径

在写配置前停止升级，保留原 `n8n.env`、`deployment/state.json` 与 Profile 目录。不要把 `<EXISTING_PROFILE_ROOT>` 改为新的默认空目录。

使用当前代码运行 `prepare` 时，升级前读取到的目录应作为显式保护值传入：

```bash
MERCHROUTE_BROWSER_PROFILE_ROOT='<已有绝对路径>' node deployment/scripts/bootstrap.mjs prepare
```

脚本会同时核对 `n8n.env` 与 `state.json`；二者不一致、显式值不同或路径与仓库/凭据/媒体目录重叠时都会在写入前失败。不得通过删除状态文件绕过。成功后回读 `MERCHROUTE_BROWSER_PROFILE_ROOT`，并用 `verify-browser-profiles` 做离线烟测；不要读取 Cookie 或打开商品页。

## n8n.env 缺少回环监听或受控节点配置

重新运行当前版本的 `prepare`，然后只回读键名和值是否符合：

```text
N8N_LISTEN_ADDRESS=127.0.0.1
NODES_EXCLUDE=[]
N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200
```

`prepare` 会保留其它已有 n8n 环境变量以及原加密密钥/数据库密码。如果同一个 secret 在 `deployment.env` 与运行环境文件中的值不一致，命令会停止而不是覆盖。禁止在聊天或日志中输出 secret 原值；只允许在仓库外比较指纹。

## E007 执行长期停留在 running 或升级不允许停机

升级停机前运行：

```bash
node deployment/scripts/n8n-upgrade-guard.mjs --phase=pre-stop
```

重启 n8n 并等待健康后再运行：

```bash
node deployment/scripts/n8n-upgrade-guard.mjs --phase=post-start
```

守卫只读查询 E007（`G8MSbp9u0dudSgba`）的执行元数据。`new`、`running`、`unknown`、`waiting` 任一存在都会使命令失败。此时不要停止 n8n、导入工作流、直接改 `execution_entity` 或盲目 Retry；先按 [n8n 官方 Executions 说明](https://docs.n8n.io/workflows/executions/all-executions/) 在界面中筛选 E007/状态，再结合输出目录和 MerchRoute 下载任务租约判断真实状态。正常任务等待终态；疑似悬挂时先报告执行 ID/开始时间并取得用户授权，再使用 n8n 正式停止功能。E007 受控定义另设 `executionTimeout=1200`，但它不能替代升级前后的状态回读。

## 安全恢复原则

- 每个失败步骤最多自动重试两次；仍失败就保留外部状态并报告。
- 重跑前先读 `deployment/state.json` 与脱敏报告，复用已有密钥、数据库卷和稳定 ID。
- 不自动删除数据库卷、n8n 用户目录或商品媒体。
- 不跳过版本、健康、工作流停用或只读凭据验收。
