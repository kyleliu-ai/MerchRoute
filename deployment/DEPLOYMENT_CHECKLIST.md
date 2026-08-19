# MerchRoute 部署验收清单

## 平台和版本

- [ ] Windows 11 x64 或 Apple Silicon macOS arm64。
- [ ] Node.js 22.23.1、npm 10.9.8、全局 n8n 2.32.6 回读一致。
- [ ] PostgreSQL 18.4、Playwright 1.61.1、Jimeng 固定版本与 `runtime-versions.json` 一致。
- [ ] `npm run versions:check:full`、`npm run deployment:verify`、`npm run check` 通过。

## 外部数据与数据库

- [ ] 真实状态位于 `%LOCALAPPDATA%\MerchRoute\` 或 `~/Library/Application Support/MerchRoute/`。
- [ ] `MERCHROUTE_ENV_FILE` 指向仓库外绝对路径。
- [ ] `merchroute` 与 `merchroute_n8n` 是空白、隔离数据库，应用角色不能互用。
- [ ] 未恢复历史数据，未把数据库备份放入仓库。

## 服务

- [ ] MerchRoute `127.0.0.1:4173` 健康。
- [ ] 全局 n8n `127.0.0.1:5678` 健康，owner 已在本机浏览器创建。
- [ ] `n8n.env` 含 `N8N_LISTEN_ADDRESS=127.0.0.1`、`NODES_EXCLUDE=[]`、`N8N_GRACEFUL_SHUTDOWN_TIMEOUT=1200`。
- [ ] Jimeng `127.0.0.1:8000/ping` 返回 `pong`，`/app/data` 使用外部卷。
- [ ] n8n 文件访问只开放业务媒体根；仓库、凭据目录和 n8n 用户目录未开放。

## 工作流与凭据

- [ ] 6 组逻辑凭据由用户在本机文件填写，没有值进入聊天或日志。
- [ ] 临时明文导入文件已删除。
- [ ] n8n 数据库回读 36 个工作流，启用数量为 0。
- [ ] n8n 回读明确包含 `G8MSbp9u0dudSgba` / `E007-v01-1688产品媒体下载`，且 `active=false`。
- [ ] E007 的 `executionTimeout=1200`；安装后或升级前后 E007 守卫均为 `safe=true`，没有非终态执行。
- [ ] MerchRoute 系统配置包含 E006、E007、E001–E005；E007 独立目录、Webhook、工作流参数与 PostgreSQL 投影四者一致。
- [ ] 工作流路径模板已解析为当前系统目录，E006/E007 的 12 个运行脚本及锁定依赖已安装到仓库外。
- [ ] `<MERCHROUTE_APP_HOME>/browser-profiles/pdd` 与 `browser-profiles/1688` 是两个独立、持久化、仅当前用户可访问的 Chrome User Data Directory；未复用系统默认 Profile、未从旧机器复制。
- [ ] 用户已分别在 PDD、1688 专用 headed Chrome 中完成人工登录；账号、短信码、Cookie 和截图未进入聊天或日志。
- [ ] 两个 Profile 均通过离线 Playwright headless persistent context 复用烟测，测试后 `.pdd.lock`、`.e007.lock` 与 Chrome `Singleton*` 未被部署脚本强制删除。
- [ ] `prepare` 已创建 E001–E005 五个监听目录；macOS 路径统一使用 `/`，没有 `\` 或混合分隔符。
- [ ] 导入前逐一核对 E001–E005 Local File Trigger 与五个预期目录完全一致；任一不一致均停止导入。
- [ ] E003 规则文件位于 `<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json`，环境变量为该绝对路径，JSON 和 SHA-256 均与仓库版本一致。
- [ ] E003 输出目录严格为 `<MERCHROUTE_DATA_ROOT>/02_GenerateFolder/E003-7套图-下载`，保持 `GenerateFolder` 大小写一致且不含开发者盘符。
- [ ] E003 把 `titleLength`、`titleDescriptionLength` 标准化为正整数，兼容历史 `titleLenth`、`titleDescriptionLenth`；调用 S013 时 `convertFieldsToString=false` 且 `onError=stopWorkflow`。
- [ ] 8 个包含 `__hiddenShQuote` 的受控工作流通过 POSIX 单引号回归测试；不得在 macOS 上出现 `base64 is not defined` 或 `utf8 is not defined`。
- [ ] 导入后通过 n8n CLI 回读 `n8n-e001-e005-local-trigger-paths` 与 `category-scene-rules-file`；验证期间没有启用工作流。
- [ ] Jimeng、WB、OZON、AI 服务与 MerchRoute 运行接口的 6 项只读探测全部通过。
- [ ] 未创建商品、发布 Listing、生成付费媒体、上传真实素材或触发调度。

## 发布前安全

- [ ] Git 候选不含 `.env`、Cookie、dump、`browser-profiles`、Chrome User Data、浏览器缓存、n8n 用户目录、Jimeng 数据卷、日志、媒体和个人路径。
- [ ] Gitleaks/禁入扫描通过。
- [ ] 仓库外 `deployment-report.json` 已生成且不含凭据值。
