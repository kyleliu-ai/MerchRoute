# n8n 工作流部署包

本目录包含 MerchRoute 当前使用的 36 个唯一工作流：核心图片处理与投递 17 个、WB 9 个、OZON 10 个；三类部署包因共享工作流会分别引用同一 ID。`manifest.json` 记录名称、依赖、文件路径与 SHA-256，`catalog.mjs` 是受控导出范围。

## 安全导出

仅在本机 n8n 可访问且当前会话已从密码管理器注入 `N8N_API_KEY` 时执行：

```powershell
$env:N8N_API_URL = 'http://127.0.0.1:5678'
npm run deployment:export:n8n
npm run deployment:verify
```

导出器只保留可部署结构，删除 `credentials`、`webhookId`、Pin Data、Static Data、共享信息与实例版本状态；同时把本机盘符转换为稳定路径模板，随后校验依赖、哈希和敏感字面量。`credential-requirements.json` 只记录逻辑别名、类型、必填字段和只读探测，不包含原凭据 ID、名称、账号、店铺或授权值。

## 新机器导入

标准部署先在仓库外生成：

```text
Windows  %LOCALAPPDATA%\MerchRoute\secrets\credentials.local.json
macOS    ~/Library/Application Support/MerchRoute/secrets/credentials.local.json
```

用户只在本机编辑该文件，不得把内容粘贴到聊天。导入器在外部私有临时目录生成 n8n CLI 输入，通过 `n8n import:credentials` 加密写入新数据库，再为临时工作流副本注入稳定绑定。路径模板只在临时副本中展开为目标系统路径；临时明文无论成功或失败都会删除。

```bash
node deployment/scripts/bootstrap.mjs import-n8n
```

导入是幂等的：凭据和工作流使用稳定 ID 进行 upsert。导入器强制 `active=false`，最终验证会从 n8n 数据库重新导出并确认恰好 36 个且全部停用。部署工具没有启用工作流的代码路径。

全新安装的 E001–E005 Local File Trigger 使用正斜杠路径模板。`prepare` 创建五个监听目录，并将 E003 规则文件复制到 `<MERCHROUTE_DATA_ROOT>/00-config/category-scene-rules.json`；导入前检查精确路径、JSON 和 SHA-256，导入后再通过 n8n CLI 回读验证。该流程不会迁移或覆盖既有 Mac 安装。

## n8n 运行边界

n8n 必须全局安装为 2.32.6，并安装 `n8n-nodes-globals@1.1.0`。部署环境允许 `fs,path,crypto,http,https,url,child_process,zlib`，允许节点读取所需环境变量，并用 `N8N_RESTRICT_FILE_ACCESS_TO` 仅开放用户选择的业务媒体根目录。仓库、凭据目录和 n8n 用户目录不得位于该根目录内。

`runtime-scripts/` 是 E006/E007 实际调用的完整源码、锁文件和离线测试。部署程序将其复制到仓库外的 `n8n-runtime/scripts/`，固定安装 Playwright 1.61.1 与 Sharp 0.34.5；浏览器 Profile、Cookie、下载数据和运行状态不会复制回仓库。

所有工作流保持停用，直到操作员在新机器逐个核对目录、凭据和平台写操作后明确启用。
