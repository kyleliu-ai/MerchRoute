# MerchRoute

MerchRoute 是一套本地优先的电商运营工具，覆盖采购商品管理、电商主图与视频生成和审核、Wildberries（WB）与 OZON 自动/手动上品、售价、运费、系统设置及消息中心。它把 MerchRoute 应用、全局安装的 n8n、36 个受控工作流、PostgreSQL 与 Jimeng 代理组合成一套可审计、可迁移的本地系统。

[![Node.js](https://img.shields.io/badge/Node.js-22.23.1-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![CI](https://github.com/kyleliu-ai/MerchRoute/actions/workflows/ci.yml/badge.svg)](https://github.com/kyleliu-ai/MerchRoute/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/MerchRoute-MIT-green.svg)](LICENSE)

## 功能模块

| 模块 | 能力 |
| --- | --- |
| 采购管理 | 采购商品、来源链接、下载任务与商品资料管理 |
| 图片审核与投递 | AI 图片/视频的目录扫描、预览、选择、排序、审核、批量投递与历史追踪 |
| 上品管理 | WB/OZON 自动上品、手动上品、公共媒体、店铺预设、提交与平台状态回读 |
| 售价管理 | 平台售价模板、版本管理与计算 |
| 运费管理 | 跨境运费模板、渠道比较与最低运费查询 |
| 系统设置 | 工作流阶段、下载、目录、平台店铺与运行配置 |
| 消息中心 | 任务进度、异常、待处理事项和操作结果通知 |

## 界面预览

以下界面由当前源码在隔离 E2E 数据库中使用合成商品生成，不包含真实店铺、凭据、商品数据或本机路径。点击图片可查看原尺寸。

<p align="center">
  <a href="docs/assets/ui/overview.webp"><img src="docs/assets/ui/overview.webp" alt="MerchRoute 图片审核与投递总览" width="100%"></a><br>
  <strong>图片审核与投递总览</strong>：集中查看 E001–E005 处理阶段、待审核数量和投递方向。
</p>

<table>
  <tr>
    <td width="50%"><a href="docs/assets/ui/procurement.webp"><img src="docs/assets/ui/procurement.webp" alt="MerchRoute 采购管理界面"></a><br><strong>采购管理</strong>：采购台账、来源链接、下载工作流和任务状态。</td>
    <td width="50%"><a href="docs/assets/ui/media-review.webp"><img src="docs/assets/ui/media-review.webp" alt="MerchRoute 图片审核界面"></a><br><strong>图片审核</strong>：按工作流查看产品媒体、审核状态和后续投递目标。</td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/ui/wb-listing.webp"><img src="docs/assets/ui/wb-listing.webp" alt="MerchRoute Wildberries 上品界面"></a><br><strong>WB 上品</strong>：自动任务、手动资料、类目模板和店铺预设。</td>
    <td width="50%"><a href="docs/assets/ui/ozon-listing.webp"><img src="docs/assets/ui/ozon-listing.webp" alt="MerchRoute OZON 上品界面"></a><br><strong>OZON 上品</strong>：自动任务、多店铺手动上品、类目与预设管理。</td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/ui/pricing.webp"><img src="docs/assets/ui/pricing.webp" alt="MerchRoute 售价计算界面"></a><br><strong>售价管理</strong>：结合采购、运费和平台费用计算目标售价。</td>
    <td width="50%"><a href="docs/assets/ui/shipping.webp"><img src="docs/assets/ui/shipping.webp" alt="MerchRoute 运费计算界面"></a><br><strong>运费管理</strong>：按目的国、重量和体积比较跨境物流渠道。</td>
  </tr>
  <tr>
    <td width="50%"><a href="docs/assets/ui/settings.webp"><img src="docs/assets/ui/settings.webp" alt="MerchRoute 系统设置界面"></a><br><strong>系统设置</strong>：统一维护工作流、审核投递、运行参数和下载调用。</td>
    <td width="50%"><a href="docs/assets/ui/notifications.webp"><img src="docs/assets/ui/notifications.webp" alt="MerchRoute 消息中心界面"></a><br><strong>消息中心</strong>：集中追踪任务结果、异常和待处理事项。</td>
  </tr>
</table>

## 系统组成与数据流

```text
采购商品 / 商品素材
        │
        ▼
MerchRoute ── PostgreSQL（业务数据）
        │
        ├── 审核、排序、投递 ── 本地业务媒体目录
        │
        └── 调用本机 n8n（36 个工作流，独立数据库）
                    │
                    ├── Jimeng 代理（Docker，127.0.0.1:8000）
                    ├── AI / 翻译 / 上传服务
                    └── WB / OZON 只读或上品接口
```

仓库中的工作流均已移除现有凭据绑定、Webhook 实例 ID 和运行状态。新部署只导入停用副本；任何工作流必须在人工核对后另行启用。

## 源码目录

```text
apps/web                         React 运营界面（全部业务模块）
apps/server                      Fastify API、数据库、文件与平台服务
packages/shared                  跨端类型、校验和业务常量
deployment/n8n                   36 个脱敏工作流、清单、凭据需求与导入工具
deployment/n8n/runtime-scripts   E006/E007 实际调用的下载、浏览器与图片拼接源码
deployment/postgres              两个隔离数据库的 PostgreSQL 18 定义
deployment/scripts               Windows、macOS 与跨平台部署脚本
integrations/jimeng-free-api-all Jimeng 代理的可独立构建 GPL-3.0 源码
scripts                          启动、验收、迁移和维护脚本
tests/e2e                        Playwright 浏览器测试
```

`integrations/jimeng-free-api-all/` 来源及补丁说明见其 [UPSTREAM.md](integrations/jimeng-free-api-all/UPSTREAM.md)。MerchRoute 主程序使用 MIT 许可证；该独立组件按其上游 GPL-3.0-only 许可证分发。

## 固定版本

| 组件 | 版本 |
| --- | --- |
| MerchRoute Node.js / npm | 22.23.1 / 10.9.8 |
| n8n（本机全局安装） | 2.32.6 |
| PostgreSQL | 18（测试版本 18.4） |
| Playwright | 1.61.1 |
| Jimeng Node.js / npm | 20.20.2 / 10.8.2 |
| Jimeng playwright-core / Chromium | 1.58.2 / 1208 |

机器可读契约在 [deployment/runtime-versions.json](deployment/runtime-versions.json)。版本不一致时不要继续安装依赖，先切换到固定版本并运行 `npm run versions:check`。

## 发布契约同步

README、智能体安装提示词和智能体升级提示词必须与同一个提交中的机器可读契约保持一致：

| 契约 | 权威文件 | 当前发布快照 |
| --- | --- | --- |
| 工具链和 Jimeng | [deployment/runtime-versions.json](deployment/runtime-versions.json) | Node.js `22.23.1`、npm `10.9.8`、n8n `2.32.6`、PostgreSQL `18.4`、Playwright `1.61.1`、Jimeng `0.9.1` |
| n8n 工作流 | [deployment/n8n/manifest.json](deployment/n8n/manifest.json) | 36 个唯一工作流、3 个部署包；新安装全部停用 |
| PostgreSQL | [deployment/postgres/init/01-databases.sh](deployment/postgres/init/01-databases.sh) | `merchroute` → `merchroute_app`；`merchroute_n8n` → `merchroute_n8n` |
| npm 依赖 | [package-lock.json](package-lock.json) | 锁文件安装，禁止用浮动 `latest` 替代固定版本 |

每次修改版本、工作流清单或数据库初始化契约时，必须在同一 PR 中更新本 README、[安装提示词](deployment/AGENT_INSTALL_PROMPT.zh-CN.md) 和[升级提示词](deployment/AGENT_UPDATE_PROMPT.zh-CN.md)。`npm run deployment:test` 会从上述权威文件读取实际值并阻止三份文档发生漂移；`npm run deployment:verify` 继续验证工作流数量、哈希、依赖和脱敏边界。

## 推荐部署方式：把一份提示词交给智能体

从干净的 Windows 11 或 Apple Silicon macOS 部署时，将 [智能体安装部署提示词](deployment/AGENT_INSTALL_PROMPT.zh-CN.md) 的完整内容复制给 Codex、Claude Code 等具备终端和文件权限的智能体。提示词要求智能体持续执行、调用已测试脚本、在本机凭据填写处暂停，并在全部只读验收后生成脱敏报告。

已经安装并有数据库、凭据或 PDD/1688 登录 Profile 的电脑，必须改用 [智能体安全升级提示词](deployment/AGENT_UPDATE_PROMPT.zh-CN.md)。升级流程会先完整备份，保留原 `MERCHROUTE_BROWSER_PROFILE_ROOT`，补齐 n8n 回环监听/节点配置，并在停机前与重启后阻断 E007 非终态执行；不要用全新安装流程覆盖既有状态。

脚本入口：

```powershell
# Windows PowerShell（从仓库根目录）
powershell -ExecutionPolicy Bypass -File deployment/scripts/bootstrap-windows.ps1
```

```bash
# Apple Silicon macOS（从仓库根目录）
chmod +x deployment/scripts/bootstrap-macos.sh
./deployment/scripts/bootstrap-macos.sh
```

遇到端口、Docker、数据库、n8n 所有者初始化或凭据探测问题时，见 [部署故障排查](deployment/TROUBLESHOOTING.zh-CN.md)。

维护 README 界面图时，先启动项目自带的隔离 E2E 服务，再运行 `npm run docs:capture-ui`。截图脚本只接受 `127.0.0.1:4183`，并要求存在 E2E 数据库标记，避免误截生产页面。

## 开发环境快速启动

已有依赖环境、只需开发 MerchRoute 主程序时：

```bash
git clone https://github.com/kyleliu-ai/MerchRoute.git
cd MerchRoute
npm ci
npm run versions:check
npm run build
npm start
```

默认地址为 <http://127.0.0.1:4173>。数据库模块需要 `DATABASE_URL`；新部署应把环境文件放在仓库外，并通过 `MERCHROUTE_ENV_FILE` 指向它。仓库根目录 `.env.runtime` 只作为旧安装兼容回退。

## n8n 与 Jimeng

n8n 采用本机全局安装，不使用 n8n Docker 容器。部署脚本固定安装 `n8n@2.32.6`，启用工作流实际需要的内置模块 `fs,path,crypto,http,https,url,child_process,zlib`，允许节点读取必要环境变量，并通过 `N8N_RESTRICT_FILE_ACCESS_TO` 将文件访问限制在用户选择的业务媒体根目录。仓库目录、凭据目录和 n8n 用户目录均不在允许范围内。

E006/E007 使用的 Playwright、Sharp、幂等控制、登录和下载脚本也在仓库中。部署程序把源码复制到仓库外并安装锁定依赖；在目标电脑分别创建持久化的 PDD、1688 专用 Chrome User Data Directory，并用离线 headless 烟测验证可复用性。工作流文件中的路径使用跨平台模板，导入时解析为当前 Windows 或 macOS 的数据目录、Chrome 与浏览器 Profile 目录，不携带原电脑盘符、Cookie 或旧电脑登录状态。

全新 MerchRoute 配置默认包含 E006、E007、E001–E005。E007 使用独立的 `03-1688ProductMedia` 目录和 `/1688-product-media-download` Webhook；部署脚本会验证其系统配置、参数文件与 PostgreSQL 投影一致，但 n8n 中的 E007 仍保持停用，直到用户完成授权并明确决定启用。

工作流依赖 `n8n-nodes-globals@1.1.0`；36 个工作流及其三类部署包见 [deployment/n8n/README.md](deployment/n8n/README.md)。凭据必须在新机器本地重新输入，并由 n8n 使用新安装的 `N8N_ENCRYPTION_KEY` 加密。

Jimeng 代理由 [Docker Compose](integrations/jimeng-free-api-all/compose.yaml) 构建，只监听 `127.0.0.1:8000`，运行数据保存在仓库外的 Docker 卷 `/app/data`。验收请求 `GET /ping` 必须返回 `pong`。镜像基础与浏览器依赖支持 Docker Desktop 的 `linux/amd64`、`linux/arm64` 平台。

## 数据与安全边界

新部署的全部真实数据位于仓库外：

- Windows：`%LOCALAPPDATA%\MerchRoute\`
- macOS：`~/Library/Application Support/MerchRoute/`

禁止提交或粘贴到聊天中的内容包括 `.env`、数据库连接串和备份、n8n API Key/加密密钥/用户目录、WB/OZON/AI 平台凭据、Jimeng session/cookie、浏览器缓存、商品媒体和日志。数据库备份仍必须放在 GitHub 之外。

部署工具会创建仅当前用户可读的 `credentials.local.json`，但不会读取并输出其值；真实接口验收只执行账号、模型、余额或连接等无副作用探测，禁止创建商品、发布 Listing、生成付费媒体或上传真实商品素材。

提交前运行：

```bash
npm run deployment:verify
npm run n8n-runtime:test
npm run check
```

`deployment:verify` 固定验证 36 个唯一工作流、3 个部署包、依赖和哈希、凭据脱敏、数据库备份禁入以及 Jimeng 运行数据禁入。

## 文档

- [智能体安装部署提示词](deployment/AGENT_INSTALL_PROMPT.zh-CN.md)
- [智能体安全升级提示词](deployment/AGENT_UPDATE_PROMPT.zh-CN.md)
- [部署说明](deployment/README.md)
- [部署故障排查](deployment/TROUBLESHOOTING.zh-CN.md)
- [n8n 工作流部署包](deployment/n8n/README.md)
- [Windows 人工安装](docs/INSTALL-WINDOWS.md)
- [macOS 人工安装](docs/INSTALL-MACOS.md)
- [用户指南](docs/USER-GUIDE.md)
- [架构说明](docs/ARCHITECTURE.md)
- [安全策略](SECURITY.md)

## 许可证

MerchRoute 主程序使用 [MIT License](LICENSE)。`integrations/jimeng-free-api-all/` 是独立的 GPL-3.0-only 组件，使用和再分发时须同时遵守其 [许可证](integrations/jimeng-free-api-all/LICENSE)。
