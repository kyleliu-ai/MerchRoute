# Jimeng Free API 集成

此目录是 MerchRoute 随仓库分发的 Jimeng API 源码快照，可在 Windows 11 与 Apple Silicon macOS 的 Docker Desktop 中独立构建。它包含当前 MerchRoute E002 所依赖的异步图片任务、上传重试、恢复台账、全局并发门控和敏感日志脱敏补丁。

## 构建与启动

```bash
docker compose build
docker compose up -d
docker compose ps
```

健康检查：

```bash
curl --fail http://127.0.0.1:8000/ping
```

应返回 `pong`。服务仅绑定本机回环地址；任务台账保存在 Docker 命名卷 `merchroute-jimeng-image-task-store`，不得提交到 GitHub。

## 本地离线测试

从 MerchRoute 仓库根目录运行测试入口。离线回归测试使用主仓库固定的 Node.js 22.23.1 测试工具链，不调用即梦接口，也不会产生付费任务；镜像构建阶段会在容器内使用运行时固定的 Node.js 20.20.2 / npm 10.8.2：

```bash
npm run jimeng:test
npm run jimeng:build
```

运行时镜像使用 Node.js 20.20.2、npm 10.8.2、playwright-core 1.58.2，并在镜像构建时下载与锁文件一致的 Chromium。仓库不保存浏览器缓存。

## 秘钥边界

即梦 `sessionid` 或其他会话值只能存放在仓库外的 MerchRoute 凭据文件或 n8n 加密凭据中。不得写入此目录、Dockerfile、Compose、日志、Issue 或聊天记录。`/token/check` 可用于只读验证会话有效性。

来源、许可证和补丁说明见 [UPSTREAM.md](UPSTREAM.md)。
