# 数据库边界

标准新部署不恢复任何历史数据。`deployment/postgres/compose.yaml` 首次启动时创建两个空数据库：

- `merchroute`：只授予 `merchroute_app`，保存 MerchRoute 业务数据。
- `merchroute_n8n`：只授予 `merchroute_n8n`，保存 n8n 配置、加密凭据和工作流。

两个应用角色使用不同随机密码，`PUBLIC` 数据库权限已撤销。密码与连接信息只存在仓库外 `MerchRoute/secrets/`。

## 历史迁移

只有用户明确要求迁移历史数据时才单独执行备份/恢复；标准安装提示词禁止恢复。备份必须位于 GitHub 之外，并通过受控私密通道传输。MerchRoute 与 n8n 必须分别备份；迁移 n8n 加密凭据还需要原 `N8N_ENCRYPTION_KEY`，二者应分开保管。

不要把 `.dump`、`.backup`、`.sql`、恢复日志或 `DATABASE_URL` 放入仓库。任何删除/重建卷操作都必须先取得用户明确授权。
