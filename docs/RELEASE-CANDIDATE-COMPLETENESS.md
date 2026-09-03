# MerchRoute 完整候选：本机分支功能台账与验收门禁

## 当前阶段与边界

阶段 1 已形成并提交本机完整候选；当前进行阶段 2 的 GitHub 发布治理、可移植 CI 与候选打包准备。阶段 2 不切换正式 4173 服务、不修改手动或开机启动入口；提交、GitHub 同步及 Draft PR 的实际完成状态须另行报告，CI 检查本身不执行这些操作。

用户授权重建基线为本机提交 `8a52c7760032167d86b26f36b045a849a6b0569f`；独立候选为 `work/merchroute-complete-release-20260903-0951`。该授权允许重建完整候选，但不能反向宣称原基线已包含全部功能。

阶段 1 候选已提交为 `26235db67baa4b99d15952571f152af8c6c65c9d`（C1），对应 tree 为 `188f6431b2587ec3a4ad9a34f315c6a2c5cdb4ec`。阶段 2 当前分支绑定 `work/merchroute-github-publish-20260903-1108`，从 C1 创建。C1 是明确的本机来源身份，不代表阶段 2 后续提交可以复用旧测试身份，也不代表正式服务已经切换。

[功能台账](../config/release-features.json)保留重建前全部 25 个本机分支的原始条目，并追加 C1 分支来源，共 26 项已记录来源；12 项功能条目继续保留。当前发布分支单独由 policy 绑定，不伪造历史 refs。原工作区保持只读。目录状态、WB 活跃上品重启保护和新项目规则原为三组缺口，已随 C1 提交；台账原有 INTEGRATE 分类保留其重建审计含义，不表示要重新整树移植旧分支。

| 功能组 | 对当前基线的处理 |
| --- | --- |
| 初始发布、采购/审核/定价、WB/OZON、部署和文档 | 保留当前版本及后续修复 |
| E000 本地导入、多媒体目录、价格语义、来源隔离、产品名校验 | 保留；产品名校验已由聚合提交纳入 |
| 采购产品查询和完整录入 URL 精确查询 | 保留；不重复追加已 squash 的功能 |
| 关于页面、三类内容指纹、只读认证和自助 Token | 保留；不同提交可能拥有相同完整 tree |
| 打开产品文件夹 | 保留；开发/发布副本补丁等价 |
| 本地导入目录状态 | 融合缺失补丁，并兼容当前受控路径规范化 |
| WB 活跃上品重启保护 | 融合缺失保护及测试，但不实际重启 |
| Junction 退役及全部后续安全修复 | 保留；不重新执行退役或生产迁移 |
| 项目级开发发布约束 | 纳入此前未提交的已批准规则文件，单独核对 SHA-256 |

目录状态表头必须为“选择 / 变体目录 / 创建日期 / 平台来源 / 导入状态 / 操作”。旧补丁的第一列只是空白占位，本候选需要字面“选择”。历史来源根必须复用当前受控 canonicalizePath；不能因 Junction 退役把历史“已导入”误判为“新下载”，也不能硬编码路径、改写来源快照或关闭链接过滤。

## 门禁命令与含义

在候选根目录使用固定 Node.js 22.23.1；该脚本复用 TypeScript 源码中的指纹实现，不依赖提前构建出的旧 `dist`：

```sh
node --import tsx scripts/verify-release-completeness.mjs --mode local
node --import tsx --test scripts/verify-release-completeness.test.mjs
node --import tsx scripts/verify-release-completeness.mjs --mode local --strict --expected-commit <当前完整SHA> --evidence <仓库外测试证据JSON绝对路径>
node --import tsx scripts/verify-release-completeness.mjs --mode ci --expected-commit <CI实际检出的完整SHA>
```

默认模式仍为 `local`。第一个命令只读核对原基线及 C1 祖先关系、全部审计分支是否漂移、必要源码锚点及候选内容身份。非 strict 的本机草稿静态审计仍允许 `dirty: true`，但必须明确：

台账中的 `equivalenceEvidence` 是本次已完成的人工只读 Git 审计记录，不代表该脚本重新执行了每个 patch-id 比较。分支 HEAD 核对也不能检测其他 Worktree 的未提交变化；实施任务仍须按仓库外恢复清单回读原工作区状态及受保护文件哈希，不能用此脚本替代并发保护。

- `staticAudit: PASS` 只证明台账和源码锚点检查通过，不等于业务验收。
- 未提供实际测试证据时，`behaviorEvidence: NOT_PROVIDED`、`candidateValidated: false`。
- 证据完整且与候选身份完全吻合时，`candidateValidated: true` 表示本机候选验证完成。
- 非 strict 的本机草稿检查始终为 `releaseReady: false`、`published: false`。

本机 `local --strict` 保留原严格门禁：干净已提交候选、全部 11 类真实外部测试证据，以及 `apps/server/dist/build-info.json` 的提交、范围版本和三类指纹一致。提供 `--expected-commit` 时还须与真实 Git HEAD 一致。严格通过只是预发布门禁，不会授权或执行提交、同步、PR、服务重启，更不代表已经上线。

CI 模式必须显式提供 `--mode ci --expected-commit <完整SHA>`，不能从构建覆盖变量推断预期提交。CI 检查干净源码、完整台账、必要源码锚点、真实 HEAD、tree、三类指纹及独立规则/范围/台账哈希；不要求 GitHub runner 存在本机 26 项来源 refs，也不在浅检出中验证本机旧祖先。缺少本机 refs 不代表这些 refs 已在 CI 审计，更不能为通过 CI 去删除或伪造台账条目。

CI 中若存在 build-info，必须匹配当前真实提交、干净构建、范围和三类指纹；格式错误或旧产物均失败。尚未构建时输出 `buildAudit: NOT_PROVIDED`，不能据此宣称有可发布产物；候选打包及真实 CI 作业汇总由独立 job/gate 验证。CI 不接受本机 `--evidence` 或 `--strict`，不复用旧本机日志。

- `ciStaticAudit: PASS` 只表示可移植静态检查通过，不代表其他 CI 作业已执行或通过。
- `localAudit: NOT_APPLICABLE` 明确表示本次未执行本机分支和外部行为证据审计。
- CI 无论静态结果如何，`candidateValidated`、`releaseReady`、`published` 均为 `false`。
- 本机正式候选验收仍必须回到 `local --strict`，CI 不能替代本机 API、DOM、运行身份及隔离行为验证。

只运行检查命令不会写报告文件；输出为脱敏 JSON。通过任务执行器将输出和测试日志保存到仓库外受限验证目录，不将证据日志、环境文件、凭据或运行数据加入 Git。

## 候选身份与真实测试证据

身份包括真实 Git HEAD、HEAD tree hash、runtime/documentation/verification 三类内容指纹、scope 契约 SHA-256、新版 AGENTS.md SHA-256 和功能台账 SHA-256。HEAD 直接读取 Git，不允许 `MERCHROUTE_BUILD_SHA` 环境变量掩盖真实提交。

三类指纹复用项目的默认包含范围：已经跟踪以及未被忽略的未暂存新增源码、测试和文档都参与计算；敏感/运行数据仍排除。scope 契约和 AGENTS.md 单独绑定，避免只对比 runtime 指纹而漏掉规则变化。忽略目录内的构建/临时输出不算源码。任何预期纳入的新增文件若被 Git 忽略，必须先审查并解决其受控范围，不可藏进忽略目录通过门禁。

外部证据 JSON 格式如下。将静态检查报告里的完整 `identity` 原样放入；示例占位值不能用于验收：

```json
{
  "schemaVersion": 1,
  "identity": {
    "commit": "<真实HEAD>",
    "headTreeHash": "<真实HEAD tree>",
    "scopeVersion": 1,
    "fingerprints": {
      "runtime": "<SHA256>",
      "documentation": "<SHA256>",
      "verification": "<SHA256>"
    },
    "fileCounts": {
      "runtime": 0,
      "documentation": 0,
      "verification": 0
    },
    "scopeContractSha256": "<SHA256>",
    "agentsSha256": "<SHA256>",
    "featureManifestSha256": "<SHA256>"
  },
  "checks": [
    {
      "id": "check",
      "command": "npm run check",
      "exitCode": 0,
      "completedAt": "<实际ISO8601完成时间>",
      "logPath": "<仓库外真实非空日志绝对路径>",
      "logSha256": "<该日志SHA256>"
    }
  ]
}
```

台账要求以下全部检查 ID，每个只能出现一次：

`check`、`postgres-integration`、`e2e`、`jimeng`、`deployment-verify`、`gitleaks`、`diff-check`、`release-verifier-tests`、`restart-safety`、`retirement-safety`、`isolated-runtime`。

每项记录实际命令、真实退出码、完成时间和不可篡改对应的日志哈希；被跳过、未执行、失败或依赖阻断的检查不得填写成功。脚本会拒绝缺项、重复、候选身份不符、未来时间、仓库内日志、空日志及日志哈希不符。日志和 JSON 内容由执行者负责如实记录；哈希不能证明测试本身覆盖充分，门禁不把日志文件存在误当成自动业务验收。

命令须匹配各检查 ID，PostgreSQL 检查使用 `vitest.mjs run .integration.test.ts`。check、PostgreSQL、E2E、Jimeng 和门禁测试日志还必须包含 Vitest、Playwright 或 TAP 的实际汇总，要求通过用例大于 0 且失败为 0；整套跳过不能通过。历史已有跳过用例会在报告中显示数量，不自动判失败，但必须披露原因与现行覆盖；本次新增功能测试不得跳过。安全脚本须输出 `"ok": true`。隔离回读脚本文件名使用 `isolated-runtime.mjs`（也可使用 js/cjs/ts），输出 `"assertionsPassed": <大于0>` 和 `"assertionsFailed": 0`。

先完成源文件编辑并冻结候选身份，再运行测试。测试期间如源码、测试、规则、范围或台账变化，重新计算身份并重新执行受影响检查；不得把旧日志换上新的 identity 冒充重验。生成所有证据后再回读一次静态身份，确认没有并发修改。

E2E 收尾也属于验收：必须先通过测试专属实例握手确认应用已优雅关闭，再删除临时 schema。测试服务异常退出的日志，即便用例汇总通过且 npm 返回 0，也会被完整性门禁拒绝；不能把收尾崩溃计为成功。握手只存在于测试入口，不增加生产 API、不按端口或 PID 杀进程。

## 验收与后续发布边界

- 数据库集成测试只能使用隔离 PostgreSQL；复制、目录状态与审核投递测试只能使用临时配置和媒体目录。
- WB、OZON、n8n、Jimeng 的回归采用仓库现有隔离/模拟测试；禁止因为启动测试服务触发真实平台写入、下载或生产媒体清理。
- 重启保护、退役安全脚本只执行对应的测试程序，不执行生产重启或退役命令。
- 隔离端口回读 API、实际 DOM、六列表头、导入状态及 320px 布局；不要把新服务挂到正式 4173，也不要改运行启动入口。
- Gitleaks 必须覆盖候选的新增与未提交受控内容，不能只扫描旧提交历史；详细敏感命中不得直接输出到公开报告。
- 最终交付单独报告开发、静态完整性、行为验证、提交、集成、GitHub 同步和正式上线状态。

本文件和台账记录阶段 1 来源及阶段 2 发布治理，不初始化已验收本机发布记录。以后本机审计分支变更或出现新分支，local 门禁会停止，必须先补充审计并更新台账；不能删除功能或历史条目使门禁变绿。源码提交、CI 作业、候选打包、GitHub Draft PR 与正式 4173 上线始终分别报告。
