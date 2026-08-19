# 来源与许可证

- 上游项目：<https://github.com/zhizinan1997/jimeng-free-api-all>
- 本地基础源码：`D:\Program Files\AI_Tool\jimeng-free-api-all`
- 导入日期：2026-08-13
- 基础源码声明版本：0.9.1
- 许可证：GNU General Public License v3.0 only，完整文本见 [LICENSE](LICENSE)

基础目录不是 Git 工作树，因此本快照不声明无法证实的上游 commit。`package.json` 原先写有与实际 `LICENSE` 不一致的 `ISC`，本集成以随源码分发的 GPL-3.0 文本及上游仓库为准，已将包许可证字段统一为 `GPL-3.0-only`。

## MerchRoute 补丁

本目录合并了当前运行版本使用的 `jimeng-free-api-async-patch`：

- E002 可恢复异步批量图片任务与持久化台账；
- 参考图上传的有限重试、截止时间和自适应并发；
- 图片上传、生成和历史查询的全服务公平并发门控；
- 视频上传阶段超时；
- refresh token、临时 AK/SK、签名 URL 和上传标识的结构化日志脱敏。

补丁脚本保存在 `patches/scripts/` 以便审计；仓库中的 `src/` 已是补丁应用后的可直接构建结果，Docker 构建不会再次修改源码。
