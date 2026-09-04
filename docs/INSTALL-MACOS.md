# macOS 安装说明

## 1. 环境

使用 nvm 安装仓库 `.nvmrc` 中固定的 Node.js 22.23.1，并固定 npm 10.9.8：

```bash
nvm install 22.23.1
nvm use 22.23.1
npm install --global npm@10.9.8
node --version   # v22.23.1
npm --version    # 10.9.8
```

n8n 固定为 2.32.6，PostgreSQL 固定为 18.x 主版本；完整检查可运行 `npm run versions:check:full`。

## 2. 安装与构建

首次启动前，在项目根目录的 `.env.runtime` 配置两项独立密钥：

```text
MERCHROUTE_RUNTIME_KEY=<n8n 与 MerchRoute 共用的 runtime key>
MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY=<32 字节 Base64 密钥>
```

可用以下命令生成凭据加密密钥：

```bash
openssl rand -base64 32
```

该文件不得提交到 Git，也不得位于 n8n 允许 Code 节点读取的文件根目录内。n8n 进程只注入 `MERCHROUTE_RUNTIME_KEY`；凭据加密密钥仅由 MerchRoute 服务端读取。路径不同时，可通过 `MERCHROUTE_RUNTIME_ENV_FILE` 指定绝对路径。

OZON 非默认店铺发布默认保持关闭。只有完成多店 n8n fleet 的受控 `--apply`、排空与 live GET 精确回读后，才在 MerchRoute 服务端的 `.env.runtime` 中设置 `MERCHROUTE_OZON_MULTISTORE_FLEET_READY=true`；dry-run 或仅本地验证不得开启。

```bash
git clone https://github.com/kyleliu-ai/MerchRoute.git
cd MerchRoute
npm ci
npm run versions:check
npm run build
chmod +x scripts/start-macos.command
./scripts/start-macos.command
```

也可以执行 `npm start`，然后打开仓库外 `merchroute.env` 中配置的 `MERCHROUTE_RUNTIME_BASE_URL`；新安装默认为 `http://127.0.0.1:43173`。

## 3. 路径配置

macOS 示例使用 `/Volumes/YOUR_DATA_DISK/01_MerchRoute` 占位符，不假定磁盘名称。请在系统设置中替换为实际挂载路径并逐项验证。

- 业务代码只使用 Node.js `path` API。
- 前端相对路径统一使用 `/`，后端转换为当前系统路径。
- 默认跳过符号链接和隐藏系统目录。

本版本已完成跨平台代码、路径单元测试和启动脚本，但当前交付环境没有 macOS 实机，因此仍需在目标 Mac 上执行一次安装、构建和页面冒烟验证。
