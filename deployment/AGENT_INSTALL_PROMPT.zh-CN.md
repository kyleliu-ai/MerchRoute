# 交给部署智能体的完整执行任务

你是本机部署执行智能体。请在当前这台电脑上从零部署 MerchRoute，并持续执行到所有强制验收通过；不要只给教程、命令清单或计划。允许你安装下述固定依赖、克隆仓库、运行仓库脚本、启动本机服务、构建 Docker 镜像并写入指定的仓库外目录。遇到需要用户提供凭据的步骤时必须暂停，让用户只在本机编辑器中填写，绝不能要求用户把任何密钥粘贴到聊天中。若检测到仓库外已有 `secrets/n8n.env`、`deployment/state.json`、n8n 数据库或浏览器 Profile，这就不是全新安装：立即停止本提示词，改为完整执行 [`deployment/AGENT_UPDATE_PROMPT.zh-CN.md`](AGENT_UPDATE_PROMPT.zh-CN.md)，不得用新装默认值覆盖旧状态。

## 目标与固定契约

- 仓库：`https://github.com/kyleliu-ai/MerchRoute.git`
- 支持系统：Windows 11 x64，或 Apple Silicon macOS（arm64）。其他平台停止并报告。
- MerchRoute：Node.js `22.23.1`、npm `10.9.8`、Playwright `1.61.1`。
- n8n：本机全局安装 `2.32.6`，不要用 Docker 安装 n8n。
- n8n 社区节点：`n8n-nodes-globals@1.1.0`。
- PostgreSQL：major `18`，部署镜像 `postgres:18.4-alpine`。
- Jimeng 镜像：Node.js `20.20.2`、npm `10.8.2`、`playwright-core 1.58.2`、Chromium revision `1208`。
- 新建两个相互隔离的空数据库：`merchroute` 与 `merchroute_n8n`，使用不同最小权限角色；禁止恢复历史数据库。
- 导入 36 个唯一 n8n 工作流，其中必须包含 `G8MSbp9u0dudSgba` / `E007-v01-1688产品媒体下载`；36 个全部保持停用，不得启用任何工作流。

## 成功条件

只有同时满足以下条件才可报告部署成功：

1. 固定版本全部回读一致，Git commit 已记录。
2. `npm run deployment:verify`、`npm run check`、Jimeng 测试和构建全部通过。
3. PostgreSQL 两个数据库均可由各自应用角色连接，角色不能互用。
4. `http://127.0.0.1:4173/api/v1/health` 返回成功。
5. `http://127.0.0.1:5678/healthz` 返回成功。
6. `http://127.0.0.1:8000/ping` 正文为 `pong`。
7. 从新 n8n 数据库回读恰好 36 个与清单 ID 集完全一致的工作流；E007 的 ID/名称正确，且 36 个全部 `active=false`。
8. MerchRoute 系统配置包含 E006、E007、E001–E005；E007 使用独立的 `<MERCHROUTE_DATA_ROOT>/03-1688ProductMedia`、`http://localhost:5678/webhook/1688-product-media-download` 和 `IDEMPOTENT_REPLAY`。
9. `GET /api/v1/workflow-parameters/E007` 的 `parentOutputDir` 与 E007 输出目录一致，PostgreSQL 下载配置投影同时包含 E006 和 E007。
10. 6 组逻辑凭据全部通过无副作用探测；Jimeng 必须明确返回 `live: true`。
11. 脱敏报告已写入仓库外的 `deployment/deployment-report.json`，报告中没有凭据值。
12. E001–E005 的五个 Local File Trigger 已在导入前和导入后回读，路径分别严格等于 `<MERCHROUTE_DATA_ROOT>/01_monitorFolder/<阶段目录>`，统一使用 `/`，不得包含反斜杠或混合分隔符。
13. E003 规则文件位于 `<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json`；`MERCHROUTE_CATEGORY_RULES_FILE` 指向该绝对路径，JSON 可读且 SHA-256 与仓库受控文件一致。
14. 仓库外存在两个相互独立的 Google Chrome User Data Directory：`<MERCHROUTE_APP_HOME>/browser-profiles/pdd` 与 `<MERCHROUTE_APP_HOME>/browser-profiles/1688`；用户已分别完成本机人工登录，两个目录均通过 Playwright headless persistent context 离线复用烟测，且没有残留 Profile 锁。
15. 仓库外 `n8n.env` 明确包含 `N8N_LISTEN_ADDRESS=127.0.0.1`、`NODES_EXCLUDE=[]` 与 `N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200`；n8n 只监听本机回环地址。
16. E007 受控工作流的 `executionTimeout=1200`，并且 `node deployment/scripts/n8n-upgrade-guard.mjs --phase=post-start` 回读为 `safe=true`、`blockingExecutionCount=0`。

如果某项因当前机器、网络或用户尚未提供授权而不能通过，结论必须是“部署未完成”，列出阻塞项和安全恢复命令；不得降低标准或宣称成功。

## 绝对禁止事项

- 不得把 `.env`、数据库 URL/密码、n8n API Key/加密密钥、WB/OZON/AI Token、Client-Id、Jimeng session/cookie 或授权头写入仓库、聊天、命令回显、日志、截图或最终报告。
- 不得读取凭据后向用户复述；只允许报告字段是否已填写及探测状态/HTTP 状态。
- 不得创建商品、发布 Listing、启用工作流、触发定时任务、生成付费媒体、上传真实商品素材或调用任何有副作用的外部接口。
- 不得删除数据库卷、n8n 用户目录、凭据文件或商品媒体。需要破坏性恢复时先停止并取得用户明确授权。
- 不得用 `--force` 推送、绕过验证、静默跳过失败或用不固定的最新版替代指定版本。
- 不得把仓库目录或凭据目录加入 n8n 文件访问白名单。
- 不得复制旧电脑、系统默认 Chrome、浏览器同步盘或聊天附件中的 Profile/Cookie；必须在目标电脑为 PDD 和 1688 分别新建专用目录并由用户本人登录。
- 不得读取、导出、打印、截图或上传 Profile 中的 Cookie、Local Storage、登录账号和授权值；不得用指纹伪造、验证码破解、代理轮换或其他方式绕过平台验证。

## 执行流程

### 1. 识别系统并预检

读取系统版本与 CPU 架构，确认是 Windows 11 x64 或 macOS arm64。确认至少 10 GiB 可用空间、能够访问 GitHub、npm registry、Docker Hub、WB、OZON、Jimeng 及配置中的 AI 服务。检查 `5432`、`4173`、`5678`、`8000`。

在产生任何写入前检查默认/指定 `MERCHROUTE_APP_HOME`。如果已存在 `secrets/n8n.env`、`deployment/state.json`、n8n 数据库或 PDD/1688 浏览器 Profile，判定为既有安装，立即切换到 `deployment/AGENT_UPDATE_PROMPT.zh-CN.md`；不得继续运行新装脚本。

未知进程占用端口时，先显示进程名和监听地址，停止并询问用户如何处理。只有健康端点匹配的既有 MerchRoute/n8n/Jimeng 服务，或带 `com.docker.compose.project=merchroute-postgres` 标签的 PostgreSQL 容器，才能作为幂等重跑对象。

### 2. 安装 Git 并克隆仓库

如果尚无 Git：Windows 使用 `winget` 安装 `Git.Git`；macOS 使用 Homebrew 安装 Git。然后在用户选择的开发目录执行：

```bash
git clone https://github.com/kyleliu-ai/MerchRoute.git
cd MerchRoute
git remote get-url origin
git rev-parse HEAD
git status --short
```

远程必须是上述仓库，初始工作树必须干净。不要在 URL 中嵌入 Token。

### 3. 先执行只读/无写入 dry-run

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File deployment/scripts/bootstrap-windows.ps1 -DryRun
```

macOS：

```bash
chmod +x deployment/scripts/bootstrap-macos.sh
MERCHROUTE_DEPLOY_DRY_RUN=1 ./deployment/scripts/bootstrap-macos.sh
```

dry-run 不得创建应用目录、数据库、凭据或工作流。缺少 Node 时 dry-run 可以明确报告前置依赖缺失，但不能安装任何软件。

### 4. 执行平台部署脚本

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File deployment/scripts/bootstrap-windows.ps1
```

Apple Silicon macOS：

```bash
chmod +x deployment/scripts/bootstrap-macos.sh
./deployment/scripts/bootstrap-macos.sh
```

脚本会安装/校验 Git、Docker Desktop、Node.js、npm、Chrome、FFmpeg 和全局 n8n；在仓库外生成运行配置；安装社区节点与 E006/E007 锁定运行依赖；创建并验证 PDD/1688 两个专用 Chrome Profile；创建 PostgreSQL 空数据库；构建 Jimeng；安装、构建并启动 MerchRoute；启动 n8n。它还必须运行 `configure-merchroute`，保证新配置和已执行过旧安装脚本的配置都具有 E007，并将 E007 投影到 PostgreSQL。每一阶段都必须检查退出码和预期版本。自动重试只适用于网络下载、Docker 就绪和健康检查，单项最多两轮；配置/权限/数据错误不得盲目重试。

`prepare` 还必须幂等创建 E001–E005 的五个监听目录和 `00-config`，把仓库受控的 `deployment/n8n/config/category-scene-rules.json` 复制到 `<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json`，回读 JSON 并核对 SHA-256。重复执行只能刷新同一文件，不得创建带序号的副本。

`prepare` 写出的 n8n 运行环境还必须逐项回读 `N8N_LISTEN_ADDRESS=127.0.0.1`、`NODES_EXCLUDE=[]`、`N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200`。缺少或值不同必须停止，不得先启动 n8n 再补写。

默认仓库外目录：

- Windows：`%LOCALAPPDATA%\MerchRoute\`
- macOS：`~/Library/Application Support/MerchRoute/`

如用户指定媒体根目录，通过 Windows 参数 `-DataRoot '绝对路径'` 或 macOS 环境变量 `MERCHROUTE_DATA_ROOT='绝对路径'` 传入。该目录不得包含仓库、`secrets` 或 n8n 用户目录。

### 5. 创建 PDD 与 1688 专用 Chrome Profile

运行依赖安装完成后，必须执行：

```bash
node deployment/scripts/bootstrap.mjs browser-profiles
node deployment/scripts/bootstrap.mjs verify-browser-profiles
```

`browser-profiles` 必须在仓库外幂等创建两个独立且仅当前用户可读写的目录：

- E006 / PDD：`<MERCHROUTE_APP_HOME>/browser-profiles/pdd`
- E007 / 1688：`<MERCHROUTE_APP_HOME>/browser-profiles/1688`

两个目录都必须是 Google Chrome User Data Directory，不得共用系统默认 Chrome Profile，也不得互相复制或使用同一目录。Windows 默认分别位于 `%LOCALAPPDATA%\MerchRoute\browser-profiles\pdd` 和 `%LOCALAPPDATA%\MerchRoute\browser-profiles\1688`；macOS 默认分别位于 `~/Library/Application Support/MerchRoute/browser-profiles/pdd` 和 `~/Library/Application Support/MerchRoute/browser-profiles/1688`。

安装智能体必须逐项完成以下人工暂停点：

1. PDD：调用仓库外 `n8n-runtime/scripts/pdd-login.cjs`，用普通 headed Google Chrome 和 `--user-data-dir=<.../pdd>` 打开 `https://mobile.yangkeduo.com/`。告诉用户只在该专用窗口中自行登录并完成人工验证；登录后手动关闭该窗口，再回到终端按 Enter。
2. 1688：调用仓库外 `n8n-runtime/scripts/1688-login.cjs`，用 Playwright headed persistent context 和 `<.../1688>` 打开 `https://www.1688.com/`。告诉用户自行登录并完成人工验证，保持窗口打开，回到终端按 Enter；脚本只读检查页面不再处于登录/验证状态后关闭 context 并释放锁。
3. 用户不得把账号、密码、短信码、Cookie 或截图发到聊天。智能体不得自动填写登录信息、读取 Cookie 值或绕过验证码；平台仍拒绝自动化会话时，停止并报告“部署未完成”。

随后 `verify-browser-profiles` 必须分别用同一个目录启动一次 Google Chrome Playwright headless persistent context，只访问离线 `data:` 页面并立即关闭。该烟测用于证明 n8n E006/E007 调用的 Profile 路径可被无头模式打开、两个目录没有串用且锁能正常释放；不得访问商品页、触发 Webhook 或启用工作流。验收只允许记录 Profile ID、绝对路径、是否已完成人工初始化、headless 复用结果和时间，不得读取或记录 Cookie 值。

Profile 已完成且状态文件一致时，重复执行默认复用现有目录，不再次打开登录页；只有用户明确需要刷新单个平台登录时，才运行 `browser-profiles --profile=pdd --force` 或 `browser-profiles --profile=1688 --force`。若出现 `profile_busy`，先识别并结束真实占用该专用目录的浏览器/n8n 任务；不得直接删除活动的 `.pdd.lock`、`.e007.lock` 或 Chrome `Singleton*` 文件。

### 6. 完成本机人工暂停点

首次打开 <http://127.0.0.1:5678> 后，让用户在本机浏览器创建 n8n owner。然后脚本会打开仓库外的 `credentials.local.json`。明确告诉用户：

**在向用户索取任何 Key/Token 之前，必须完整阅读并按顺序向用户讲解 [`deployment/CREDENTIAL_SETUP.zh-CN.md`](CREDENTIAL_SETUP.zh-CN.md)。** 每组都要说明用途、官方入口、点击路径、需要复制的字段、是否需要 `Bearer` 前缀、最小权限及只读验证方式。不得只说“请填写空字段”，也不得要求用户自行搜索。

讲解完成后，再明确告诉用户：

> 请只在已打开的本机文件中填写五组平台凭据；`merchroute-runtime.runtimeKey` 保持为空，脚本会自动使用仓库外已生成的值。保存并关闭编辑器后，只需在聊天中回复“已保存”。不要把文件内容、密钥、Cookie、Client-Id 或截图发到聊天中。

所需逻辑凭据以 `deployment/n8n/credential-requirements.json` 为准，共 6 组：Jimeng session、SiliconFlow、Qwen/OpenAI 兼容配置、MerchRoute 运行密钥、WB Seller API、OZON Seller API。MerchRoute 运行密钥由脚本自动生成，留空时自动使用外部环境中的值。

如果用户尚无某个平台账号、没有创建密钥的权限，或不愿在当前阶段填写，不得伪造、使用示例值或跳过该凭据。保持工作流全部停用，将部署标记为“未完成”，并告诉用户稍后可从该暂停点幂等重跑。

### 7. 导入并做只读验收

在要求用户填写凭据前，先确认平台脚本已运行 `configure-merchroute`。若是从中断点恢复，单独执行：

```bash
node deployment/scripts/bootstrap.mjs configure-merchroute
```

该命令只负责 E007 的 MerchRoute 配置、仓库外目录、工作流参数和 PostgreSQL 投影，不会启用或触发 n8n 工作流。若 E007 已存在但值不同，必须报告差异并停止，不得静默覆盖。

随后明确执行 n8n 导入，不得因 n8n 网页可打开就跳过：

```bash
node deployment/scripts/bootstrap.mjs import-n8n
```

导入命令执行前必须完成硬性检查：逐一读取 E001–E005 的 Local File Trigger，确认路径与当前数据根下的五个预期目录完全一致且不得包含反斜杠；确认 `MERCHROUTE_CATEGORY_RULES_FILE` 是 `<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json` 的绝对路径，并验证文件可读、JSON 有效、SHA-256 与仓库版本一致。任一项失败立即停止，不得生成导入临时文件、不得跳过检查，也不得通过启用工作流测试。

脚本通过临时私有文件执行 `n8n import:credentials` 和 `n8n import:workflow`。明文临时文件必须在 `finally` 清除。导入后依次运行：

```bash
node deployment/scripts/bootstrap.mjs probe --allow-network-probes=true
node deployment/scripts/bootstrap.mjs verify
node deployment/scripts/n8n-upgrade-guard.mjs --phase=post-start
```

探测范围只能是：Jimeng 会话有效性、WB/OZON 类目或连接读取、AI 服务模型/认证读取，以及 MerchRoute 运行配置读取。最多重试两次；`401/403/429/5xx` 只记录状态并停止，不要改用写接口验证。

验收结果必须分别回读并报告：`n8n-e007-inactive`、E007 的 `executionTimeout=1200`、`merchroute-e007-config`、`merchroute-e007-parameters`、`postgres-e007-download-projection`、`n8n-e001-e005-local-trigger-paths`、`category-scene-rules-file` 和 E007 守卫的 `safe=true`。其中路径检查必须来自导入后 n8n CLI 导出的工作流 JSON，不得只检查仓库模板。任一项失败都是“部署未完成”，不得通过手动启用任何工作流规避。

### 8. 完整本地验证

```bash
npm run versions:check:full
npm run deployment:verify
npm run deployment:test
npm run n8n-runtime:test
npm run check
npm run jimeng:test
npm run jimeng:build
```

运行 Jimeng 双架构构建检查；产物和缓存不得写入 Git 候选：

```bash
docker buildx build --platform linux/amd64,linux/arm64 --output=type=cacheonly integrations/jimeng-free-api-all
```

再次执行：

```bash
git status --short
git ls-files --cached --others --exclude-standard
```

确认没有 `.env`、cookie、数据库 dump、浏览器缓存、n8n 用户目录、Jimeng 数据卷、日志、媒体或个人用户绝对路径。若系统有 `gitleaks`，对 Git 候选/仓库执行扫描；没有则报告未安装，不得把它作为其他安全校验失败的借口。

## 失败恢复与幂等规则

- 每次重跑前读取仓库外 `deployment/state.json`，并运行预检。
- 已存在的外部 secret 必须复用；不得重新生成 `N8N_ENCRYPTION_KEY`、数据库密码或运行密钥。
- PostgreSQL Compose 数据卷存在时不重复初始化数据库。
- 6 个凭据与 36 个工作流使用稳定 ID upsert；重跑后仍必须回读为 6/36，不得产生副本。
- 已有配置缺少 E007 时，`configure-merchroute` 只补建一次；重跑不得生成第二个 E007，也不得改变 n8n 的停用状态。
- `prepare` 重跑必须复用同一 `00-config/category-scene-rules.json` 和五个监听目录；文件内容偏离时只从仓库受控版本安全刷新，不生成副本。
- `browser-profiles` 重跑必须复用 `pdd` 与 `1688` 两个固定目录，不得生成带编号副本、互换目录或覆盖另一个平台的 Profile；除非显式指定单个平台 `--force`，不得要求用户重复登录。
- 任何版本或配置不一致，先报告旧值、目标值和影响，再按固定契约安全修正。
- 网络失败最多两轮；仍失败时保留外部状态，输出具体恢复命令和日志路径，不删除状态。
- 权限不足时只申请完成当前步骤所需的最小权限，不得关闭系统安全机制。

## 最终输出格式

最终只输出脱敏报告摘要，不输出任何 secret 值：

```text
部署结论：成功 / 未完成
平台：Windows 11 x64 / macOS arm64
Git commit：<sha>
固定版本：Node、npm、n8n、PostgreSQL、Playwright、Jimeng 镜像
服务：MerchRoute、n8n、Jimeng、PostgreSQL 的本机地址与健康状态
数据库：两个数据库连通性与角色隔离结果
n8n：导入数量 36；启用数量 0；重复执行结果
n8n 路径：E001–E005 Local File Trigger 导入前/后检查结果
E003 规则：绝对路径、JSON 与 SHA-256 一致性结果（只报告哈希，不输出文件内容）
浏览器 Profile：PDD/1688 各自绝对路径、人工初始化状态、headless 离线复用结果与锁释放状态（不含 Cookie 值）
凭据探测：6/6 或逐项失败状态（不含值）
仓库安全：deployment:verify、Gitleaks/禁入扫描结果
报告文件：仓库外 deployment-report.json 的绝对路径
人工待处理：无 / 列表
```

只要“人工待处理”仍包含强制成功条件，部署结论必须为“未完成”。
