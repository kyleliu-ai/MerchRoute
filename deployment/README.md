# MerchRoute 标准部署包

本目录提供从空白 Windows 11 或 Apple Silicon macOS 部署 MerchRoute 所需的公开定义。它不包含历史业务数据、数据库备份、商品媒体或任何现有授权值。

## 直接入口

- 给 Codex、Claude Code 等智能体执行：[AGENT_INSTALL_PROMPT.zh-CN.md](AGENT_INSTALL_PROMPT.zh-CN.md)
- 已有数据库、凭据或浏览器 Profile 的电脑安全更新：[AGENT_UPDATE_PROMPT.zh-CN.md](AGENT_UPDATE_PROMPT.zh-CN.md)
- 六组凭据的含义、官方获取入口与安全填写步骤：[CREDENTIAL_SETUP.zh-CN.md](CREDENTIAL_SETUP.zh-CN.md)
- 人工排错：[TROUBLESHOOTING.zh-CN.md](TROUBLESHOOTING.zh-CN.md)
- Windows：`powershell -ExecutionPolicy Bypass -File deployment/scripts/bootstrap-windows.ps1`
- macOS：`chmod +x deployment/scripts/bootstrap-macos.sh && ./deployment/scripts/bootstrap-macos.sh`

## 目录

- `n8n/`：36 个脱敏工作流、三类部署包、凭据需求清单、跨平台路径模板、导出/导入/验证脚本，以及 E006/E007 外部运行源码。
- `postgres/`：PostgreSQL 18 Compose 定义，首次创建两个隔离、最小权限的空数据库。
- `scripts/`：Windows PowerShell、macOS shell 和跨平台 Node 部署逻辑。
- `runtime-versions.json`：所有固定版本的机器可读契约。
- `DEPLOYMENT_CHECKLIST.md`：人工复核清单。

## 外部状态

部署状态和真实数据固定存放在仓库外：

- Windows：`%LOCALAPPDATA%\MerchRoute\`
- macOS：`~/Library/Application Support/MerchRoute/`

`secrets/` 保存自动生成的数据库密码、n8n 加密密钥、MerchRoute 运行密钥和用户本地填写的凭据；`browser-profiles/pdd` 与 `browser-profiles/1688` 保存两个相互隔离的 Chrome User Data Directory；`deployment/state.json`、`deployment/browser-profiles.json` 与 `deployment/deployment-report.json` 用于幂等重跑和脱敏报告。重复执行会复用已有密钥和 Profile，不会重复创建数据库、凭据 ID 或工作流 ID。

既有安装也允许 Profile 位于用户原来选择的仓库外自定义绝对路径。`prepare` 以已有 `n8n.env`/`state.json` 为准保留该路径；显式新路径与持久化路径冲突时会在写入前失败，不会迁移或创建空 Profile。n8n 环境强制包含 `N8N_LISTEN_ADDRESS=127.0.0.1`、`NODES_EXCLUDE=[]` 与 `N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200`，其它已有自定义变量会保留。

到达凭据暂停点时，部署智能体必须先向用户逐项解释获取步骤，再打开仓库外文件。`merchroute-runtime.runtimeKey` 由脚本自动生成，在 `credentials.local.json` 中应保持为空；它不是需要用户从第三方获取的 Key。

## 安全规则

仓库只保存字段需求和稳定逻辑别名。以下内容始终禁止进入 Git：平台 API Key/Token、Client-Id、Jimeng session、n8n API Key/加密密钥/用户目录、`DATABASE_URL`、`.env`、数据库 dump、Cookie、浏览器缓存、日志和商品媒体。

部署脚本只执行无副作用的真实接口探测。36 个工作流全部以停用状态导入；脚本不会启用工作流、发布商品、生成付费媒体或上传素材。全新安装时，`prepare` 会创建 E001–E005 五个监听目录，并将受控 E003 规则文件写入 `<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json`；导入前后都会核对路径、JSON 和 SHA-256。

`node deployment/scripts/bootstrap.mjs configure-merchroute` 是可幂等重跑的 E007 初始化闸门：它确保 MerchRoute 配置、仓库外 `03-1688ProductMedia` 目录、E007 参数文件和 PostgreSQL 下载投影一致，不会启用或触发 n8n 工作流。

`node deployment/scripts/bootstrap.mjs browser-profiles` 会依次引导用户在目标电脑创建并登录 PDD、1688 专用 Chrome Profile；`verify-browser-profiles` 随后只访问离线 `data:` 页面，验证两个目录可分别由 Playwright headless persistent context 打开并正常释放锁。Profile、Cookie 和登录状态始终位于仓库外；脚本不读取 Cookie 值，也不会启用 E006/E007。

既有安装升级前后运行 `node deployment/scripts/n8n-upgrade-guard.mjs --phase=pre-stop|post-start`。守卫只读查询 E007 的执行 ID、状态和时间；出现 `new`、`running`、`unknown` 或 `waiting` 就失败，且从不修改 n8n 数据库。E007 工作流另有 `executionTimeout=1200` 的最终边界。

## 开发者验证

```bash
npm run deployment:test
npm run n8n-runtime:test
npm run deployment:verify
npm run versions:check:full
```

`deployment:verify` 还会检查 `README.en.md` 不存在、凭据需求固定为 6 组逻辑凭据/32 处节点绑定，以及 Jimeng 缓存、会话和数据卷不属于 Git 候选。
