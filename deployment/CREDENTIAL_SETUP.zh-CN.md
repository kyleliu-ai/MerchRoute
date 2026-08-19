# MerchRoute 凭据获取与本机填写指南

本文档专供 Codex、Claude Code 等部署智能体在凭据暂停点向用户讲解。它只记录字段含义、获取步骤和填写格式，不得记录任何真实值。

## 智能体必须遵守的交互规则

1. 打开 `credentials.local.json` 前，先逐项告诉用户“用途、官方入口、获取步骤、填写格式、验证方式”；不得只说“请填写 Key”。
2. 只让用户在本机编辑器中填写。不得要求用户把 Key、Token、Cookie、Client-Id、完整凭据文件或截图发到聊天中。
3. 不得在终端命令参数中直写凭据，不得 `echo`、`cat`、`Get-Content` 或以其他方式回显凭据文件。
4. 可以检查字段是否为空并执行无副作用探测，但最终报告只能写“已填写/未填写”、HTTP 状态和探测结果，不得复述值、长度、前后缀或指纹。
5. 平台界面若改版，只参考下方官方入口定位同名的 API/Token 管理页；不得猜测或引导用户关闭账号安全机制。

凭据文件位于仓库外：

- Windows：`%LOCALAPPDATA%\MerchRoute\secrets\credentials.local.json`
- macOS：`~/Library/Application Support/MerchRoute/secrets/credentials.local.json`

## 1. `jimeng-session.token`

**用途**：让本机 Jimeng 代理以用户自己的即梦账号执行后续图片/视频请求。该值等同账号会话权限，会过期，退出登录或修改账号安全设置后也可能失效。

**获取步骤**：

1. 用 Chrome 打开 <https://jimeng.jianying.com/> 并登录用户自己的账号。
2. macOS 按 `Option + Command + I`；Windows 按 `F12` 打开开发者工具。
3. 进入 `Application` → `Storage` → `Cookies` → `https://jimeng.jianying.com`。如果看不到 `Application`，点击顶部 `»` 展开。
4. 搜索名称严格等于 `sessionid` 的 Cookie，只复制它的 `Value`。
5. 把 Value 填入 `jimeng-session.token`。不要填写 `sessionid=`，不要添加 `Bearer `，也不要复制整段 Cookie 头。

**只读验证**：本机 Jimeng `POST http://127.0.0.1:8000/token/check` 必须返回 `live: true`；不得通过生成付费媒体验证。获取方式与上游说明一致：<https://github.com/zhizinan1997/jimeng-free-api-all#-接入指南>。

## 2. `siliconflow-api.token`

**用途**：供受控 n8n 工作流调用 SiliconFlow 模型服务。当前 MerchRoute 的只读探测访问中国区 `https://api.siliconflow.cn/v1/models`，因此必须使用 SiliconFlow 中国站账号的 API Key，不要混用国际站 Key。

**获取步骤**：

1. 登录 <https://cloud.siliconflow.cn/account/ak>。
2. 进入“API 密钥”，点击“新建 API 密钥”，用可识别且不含业务秘密的名称，例如 `MerchRoute-Macmini`。
3. 创建后点击复制，只在本机填入 `siliconflow-api.token`。不要添加 `Bearer `。
4. 确认账号已开通需要的模型/计费能力；智能体不得代替用户充值或接受付费条款。

官方步骤：<https://docs.siliconflow.cn/cn/userguide/quickstart>。

## 3. `qwen-runtime.model` / `baseUrl` / `apiKey`

**用途**：为 n8n 工作流提供 OpenAI 兼容的千问模型调用。`model` 和 `baseUrl` 不是秘钥；`apiKey` 是秘钥。

**默认中国区配置**：

```json
{
  "model": "qwen3.7-plus",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
}
```

**获取步骤**：

1. 登录阿里云百炼控制台的 API Key 管理页：<https://bailian.console.aliyun.com/?tab=model#/api-key>。
2. 确认选择的地域/业务空间与 `baseUrl` 一致。上述默认地址对应中国站华北 2（北京）的 OpenAI 兼容接口。
3. 在“API Key”/“密钥管理”中为 MerchRoute 创建专用 Key，优先使用只能访问所需模型的业务空间。
4. 只复制 Key 本身到 `qwen-runtime.apiKey`，不要添加 `Bearer `。凭据导入器会在写入 n8n 加密凭据时自动生成 `Authorization: Bearer <API-Key>`。
5. 不要把 Coding Plan 专用 Key、新加坡/美国地域 Key 与上述北京默认 `baseUrl` 混用。如用户明确选择其他地域或 OpenAI 兼容服务，必须让用户确认该服务的 `model` 和 `baseUrl`，但仍不得在聊天中收集 `apiKey`。

官方说明：<https://help.aliyun.com/zh/model-studio/get-api-key/>。

## 4. `merchroute-runtime.runtimeKey`

**用途**：MerchRoute 服务与本机 n8n 访问 Runtime API 时共用的认证密钥。

**用户不需要获取或填写。** 保持为空：

```json
"merchroute-runtime": {
  "runtimeKey": ""
}
```

`bootstrap.mjs prepare` 会在仓库外自动生成，并同步写入 `deployment.env`、`merchroute.env` 和 `n8n.env`。导入凭据时会自动使用这个值。智能体不得要求用户查看、复制或在聊天中提供它，也不得把 `N8N_ENCRYPTION_KEY` 或 `MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY` 当成它。

重复执行部署必须复用已存在的值。只有当用户明确要恢复另一台电脑的旧 n8n 数据库时，才需要作为完整密钥恢复计划的一部分单独处理；不得临时在聊天中传递。

## 5. `wb-seller-api.token`

**用途**：访问 Wildberries Seller API。部署探测只读取类目；以后启用 WB 自动上品时，Token 还必须拥有对应的商品内容、价格和库存/仓库权限。

**获取步骤**：

1. 登录 WB 卖家中心 <https://seller.wildberries.ru/>。
2. 进入“个人资料（Профиль）”→“API 集成（Интеграции по API）”，点击创建新 Token。
3. 为密钥使用可识别的专用名称，如 `MerchRoute-Macmini`。
4. 最小权限原则：只做部署连通性验证时至少需要“Content/商品内容”读取权限；准备启用自动上品时，再确认 Token 包含“Content”、“Prices and discounts/价格与折扣”及工作流确实使用的“Marketplace/库存与仓库”权限。不要无需勾选财务、聊天等权限。
5. 创建后只复制 Token 本身到 `wb-seller-api.token`，不要添加 `Bearer `。

官方说明：<https://dev.wildberries.ru/knowledge-base/articles/019d49a0-f9f7-79a4-b5ee-df5dabe9cff4>。若权限不足，只读探测可能返回 `401/403`；不得改用创建商品来试错。

## 6. `ozon-seller-api.clientId` / `apiKey`

**用途**：以 `Client-Id` 和 `Api-Key` 两个请求头访问 Ozon Seller API。`clientId` 和 `apiKey` 都按敏感授权信息处理，都不得进入 Git 或聊天。

**获取步骤**：

1. 使用店铺管理员账号登录 <https://seller.ozon.ru/>。
2. 进入“设置（Настройки）”→“Seller API”/“API 密钥”。
3. 页面显示的店铺 `Client ID` 填入 `ozon-seller-api.clientId`，保持 JSON 字符串格式，不要删除引号。
4. 点击“生成密钥（Сгенерировать ключ）”，使用专用名称，如 `MerchRoute-Macmini`。
5. 如果仅用于当前部署的只读连通性验证，可选只读角色；但启用 Ozon 自动上品前，必须换用能覆盖商品导入/媒体、价格和库存写入的最小角色。`Admin Read only` 可能通过只读探测，但不能用于自动上品。
6. API Key 通常只在创建时完整显示一次。只复制 Key 本身到 `ozon-seller-api.apiKey`，不要添加 `Bearer `。如未安全保存，应在 Ozon 撤销旧 Key 并创建新 Key，不得从日志、聊天或旧导出中搜索。

Ozon Seller API 官方文档入口：<https://docs.ozon.ru/api/seller/>。部署只通过类目读取接口验证，不得创建或更新商品。

## 填写完成后

1. 用户保存并关闭本机编辑器，只告诉智能体“已保存”，不提供文件内容。
2. 智能体确认文件仍在仓库外且仅当前用户可读；不回显文件。
3. 执行标准 `import-n8n` 与 `probe --allow-network-probes=true`，只报告六组凭据逐项的成功/失败和 HTTP 状态。
4. 如任一必需账号尚未开通、用户无权创建 Key，或不愿在当前阶段提供，保持 36 个工作流全部停用，把部署结论标记为“未完成：等待用户在本机填写 `<逻辑别名>`”，不得伪造值、不得跳过验收。
