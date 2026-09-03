# MerchRoute 完整候选：本机分支功能台账与验收门禁

## 当前阶段与边界

阶段 1 已形成并提交本机完整候选，PR #23 已由用户在其他任务合并。阶段 3 预检发现候选分支绑定过期及媒体索引测试存在时间竞争，因此当前仅进行用户授权的发布台账和测试门禁修复，重新提交 Draft PR，验收后暂停。不会创建正式 Release、合并 main、切换 4173 或修改启动入口；这些操作仍需另行授权。

用户授权重建基线为本机提交 `8a52c7760032167d86b26f36b045a849a6b0569f`；独立候选为 `work/merchroute-complete-release-20260903-0951`。该授权允许重建完整候选，但不能反向宣称原基线已包含全部功能。

阶段 1 候选已提交为 `26235db67baa4b99d15952571f152af8c6c65c9d`（C1），对应 tree 为 `188f6431b2587ec3a4ad9a34f315c6a2c5cdb4ec`。本次修复来源为本机 `4315999b0c23f4651412b597bfbdc1455d85c212`，tree 为 `22ecc597f1230bcc280d63b032e06b4c72bfee23`，与 PR #23 发布副本 `e8c357247173a912fb588d92ce3d30e11ed09e91` 的 tree 完全相同。它们是来源身份，不是当前候选身份，也不代表正式服务已经切换。

[功能台账](../config/release-features.json)版本 2 保留原始 25 个条目和 C1 条目不变，另追加阶段 2 发布分支、本机 CI 修复分支及其发布副本，共 29 项冻结来源；12 项功能和 11 类检查不删减。当前候选使用显式 `--expected-commit` 绑定，不再把某次旧分支名写死为永远有效的发布目标。原工作区保持只读。目录状态、WB 活跃上品重启保护和新项目规则原为三组缺口，已随 C1 提交；INTEGRATE 分类保留其重建审计含义，不表示要重新整树移植旧分支。

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
node --import tsx scripts/verify-release-completeness.mjs --mode local --expected-commit <当前完整SHA>
node --import tsx --test scripts/verify-release-completeness.test.mjs
node --import tsx scripts/verify-release-completeness.mjs --mode local --strict --expected-commit <当前完整SHA> --evidence <仓库外测试证据JSON绝对路径>
node --import tsx scripts/verify-release-completeness.mjs --mode ci --expected-commit <CI实际检出的完整SHA>
```

默认模式仍为 `local`，所有模式必须显式提供完整预期 SHA。第一个命令只读核对原基线、C1 和本次修复来源的祖先关系及来源 tree、全部审计分支是否漂移、源码锚点及候选身份。当前本机分支必须是 `work/` 且真实 HEAD 等于预期 SHA；检查结束会再次核对完整分支集合，发生并发增删或移动即失败。非 strict 草稿仍允许 `dirty: true`，但必须明确：

台账中的 29 个历史来源始终按原始名称和 HEAD 精确检查，不能删除或移动。其他未知分支仍阻断；如在新 Worktree 验收同一个候选，可逐项提供 `--candidate-alias work/<名称>`，但别名必须已经存在、不是历史条目、不是当前分支，并指向与候选**完全相同的提交**。相同 tree、不同提交不能作为别名豁免；没有显式列出的新分支也不会自动放行。别名列入报告，不修改 refs 或台账。

台账中的 `equivalenceEvidence` 是本次已完成的人工只读 Git 审计记录，不代表该脚本重新执行了每个 patch-id 比较。分支 HEAD 核对也不能检测其他 Worktree 的未提交变化；实施任务仍须按仓库外恢复清单回读原工作区状态及受保护文件哈希，不能用此脚本替代并发保护。

- `staticAudit: PASS` 只证明台账和源码锚点检查通过，不等于业务验收。
- 未提供实际测试证据时，`behaviorEvidence: NOT_PROVIDED`、`candidateValidated: false`。
- 证据完整且与候选身份完全吻合时，`candidateValidated: true` 表示本机候选验证完成。
- 非 strict 的本机草稿检查始终为 `releaseReady: false`、`published: false`。

本机 `local --strict` 保留原严格门禁：干净已提交候选、全部 11 类真实外部测试证据，以及 `apps/server/dist/build-info.json` 的提交、范围版本和三类指纹一致。预期 SHA 必须与真实 Git HEAD 一致。严格通过只是预发布门禁，不会授权或执行提交、同步、PR、服务重启，更不代表已经上线。

CI 模式必须显式提供 `--mode ci --expected-commit <完整SHA>`，不能从构建覆盖变量推断预期提交。CI 检查干净源码、完整台账、必要源码锚点、真实 HEAD、tree、三类指纹及独立规则/范围/台账哈希；不要求 GitHub runner 存在本机 29 项来源 refs，也不在浅检出中验证本机旧祖先。缺少本机 refs 不代表这些 refs 已在 CI 审计，更不能为通过 CI 去删除或伪造台账条目。

CI 中若存在 build-info，必须匹配当前真实提交、干净构建、范围和三类指纹；格式错误或旧产物均失败。尚未构建时输出 `buildAudit: NOT_PROVIDED`，不能据此宣称有可发布产物；候选打包及真实 CI 作业汇总由独立 job/gate 验证。CI 不接受本机 `--evidence` 或 `--strict`，不复用旧本机日志。

- `ciStaticAudit: PASS` 只表示可移植静态检查通过，不代表其他 CI 作业已执行或通过。
- `localAudit: NOT_APPLICABLE` 明确表示本次未执行本机分支和外部行为证据审计。
- CI 无论静态结果如何，`candidateValidated`、`releaseReady`、`published` 均为 `false`。
- 本机正式候选验收仍必须回到 `local --strict`，CI 不能替代本机 API、DOM、运行身份及隔离行为验证。

只运行检查命令不会写报告文件；输出为脱敏 JSON。通过任务执行器将输出和测试日志保存到仓库外受限验证目录，不将证据日志、环境文件、凭据或运行数据加入 Git。

### 本机候选与 GitHub main 的只读映射

后续收到上线授权时，可在本机严格命令后追加 `--github-commit <用户确认的main完整SHA>`。该可选功能只有本机严格门禁先通过才执行；通过 GitHub CLI 的固定 GET 请求，核对 main 的预期提交、完整 tree，以及逐项路径、文件模式、类型和 blob/tree SHA，最后重新读取 main 防止并发变化。仓库身份只读取 package.json 的 GitHub 声明，不接受任意主机或带凭据 URL。不下载源码、不 fetch、不修改本机文件或远端。

本机候选和 squash/main 的提交号可以不同，但完整 tree 与逐项源码必须相同。报告同时保留 localCommit 和 githubMainCommit，不能用远端 SHA 改写本机测试证据或构建身份；CI 模式不能使用此映射。映射不等于 Release、正式服务或启动入口验收，`published` 仍为 false。Draft PR 尚未合并时不能要求 main 已包含修复；此阶段分别验收本机候选及 PR 实际 head 的 CI 和源码包。

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

本文件和台账记录已审计来源及候选门禁，不初始化已验收本机发布记录。本次媒体索引修复仅在隔离测试 schema 中控制租约和 due_at，不改变生产队列逻辑：有效令牌可续租、过期或旧令牌不能续租、重试遵守 due_at 排序。旧测试的 10 毫秒窗口和“当前时间减 1 秒”假设不能作为生产行为契约。

投递缺失文件测试也必须区分索引状态：保留未选中的媒体，分别验证未显式刷新和已刷新时缺少选中文件均返回 `SOURCE_FILE_MISSING`；删除全部媒体并显式刷新后，空任务已从索引移除，应返回 `SOURCE_FOLDER_MISSING`。两类场景都必须失败且不能生成投递或归档任务包，不依赖 watcher 的调度快慢，也不把任意一种错误都当作通过。

以后本机审计分支变更或出现未声明的新分支，local 门禁仍停止，须先补充审计；不能删除功能或历史条目使门禁变绿。源码提交、CI 作业、候选打包、GitHub Draft PR 与正式 4173 上线始终分别报告。
