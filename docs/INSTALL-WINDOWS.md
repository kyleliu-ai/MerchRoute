# Windows 11 安装说明

## 1. 安装 Node.js

通过 nvm-windows 安装仓库 `.nvmrc` 中固定的 Node.js 22.23.1，并确认 npm 10.9.8：

```powershell
nvm install 22.23.1
nvm use 22.23.1
npm install --global npm@10.9.8
node --version   # v22.23.1
npm --version    # 10.9.8
```

启动脚本和 `npm run versions:check` 会拒绝其他版本。n8n 固定为 2.32.6，PostgreSQL 固定为 18.x 主版本；完整检查可运行 `npm run versions:check:full`。

## 2. 安装与构建

```powershell
git clone https://github.com/kyleliu-ai/MerchRoute.git
Set-Location MerchRoute
npm ci
npm run versions:check
npm run build
```

## 3. 启动

首次启动前，在项目根目录的 `.env.runtime` 配置两项独立密钥：

```text
MERCHROUTE_RUNTIME_KEY=<n8n 与 MerchRoute 共用的 runtime key>
MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY=<32 字节 Base64 密钥>
```

可用 PowerShell 生成凭据加密密钥：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

该文件包含服务端凭据加密密钥，不得提交到 Git，也不得放在 n8n 的 `N8N_RESTRICT_FILE_ACCESS_TO` 可读根目录内。n8n 进程只注入 `MERCHROUTE_RUNTIME_KEY`；`MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY` 仅由 MerchRoute 服务端读取。路径不同时，可通过 `MERCHROUTE_RUNTIME_ENV_FILE` 指定绝对路径。

OZON 非默认店铺发布默认保持关闭。只有完成多店 n8n fleet 的受控 `--apply`、排空与 live GET 精确回读后，才在 MerchRoute 服务端的 `.env.runtime` 中设置 `MERCHROUTE_OZON_MULTISTORE_FLEET_READY=true`；dry-run 或仅本地验证不得开启。

```powershell
npm start
```

或双击：

```text
scripts\start-windows.cmd
```

启动脚本会检查 Node.js、依赖、构建产物和发布绑定，然后打开实际 `runtimeEndpoint`；新安装默认为 `http://127.0.0.1:43173`。

## 4. 首次设置

示例配置使用 `G:\01_MerchRoute` 作为数据根目录。如果你的目录不同，网页会自动进入系统设置：

1. 修改六阶段目录。
2. 逐项点击“验证”。
3. 候选目录必须由现有工作流创建，应用不会自动创建。
4. 保存配置后回到工作台。
5. 在“WB上品设置”中录入各店铺 Token；Token 只写入加密凭据库，不会回显。

防火墙无需开放 MerchRoute 端口；应用只允许绑定 `127.0.0.1`。
