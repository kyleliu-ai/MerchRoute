# MerchRoute 品牌命名规则

## 项目品牌信息

- 品牌名称：MerchRoute
- 中文名称：商品智路
- 产品副标题：AI Marketplace Operations Platform
- 中文定位：AI 跨境电商商品运营与自动上品平台
- 品牌口号：From Source to Shelf.

## Codex 执行规则

- 本项目对外工具名统一使用 `MerchRoute`，不得使用历史旧名称。
- 今后新增或修改的用户可见界面文案、项目说明和文档统一使用 `MerchRoute`。
- 为避免破坏升级兼容性，历史数据库锁名、localStorage key、临时目录前缀等内部技术标识只作为兼容键保留，不得作为品牌名称显示。

## 本机权威来源与同步方向

- 本电脑上的 MerchRoute 源码、与 MerchRoute 相关的本机 n8n 工作流、PostgreSQL 数据库配置和 Jimeng 代理源码是当前权威版本。默认同步方向只能是“本机 → GitHub”。
- “同步到 GitHub”“检查差异”“远端有更新”或用户最初提供升级提示词，均不构成“GitHub → 本机”的覆盖授权。
- 允许执行不改变工作树或运行配置的只读检查，例如 `git fetch`、`git diff`、提交/哈希比较和 GitHub 状态查询。只读比较不等于更新授权。
- 在使用 GitHub 仓库内容更新本机前，必须先完成只读差异检查和仓库外可恢复备份，向用户展示将被替换的文件、工作流和配置范围，然后暂停并取得当前任务中的二次明确确认。用户未回复、拒绝或不在线时必须停止。
- 未取得上述二次确认时，禁止通过 `git pull`、merge、rebase、reset、checkout、restore 或文件复制用 GitHub 内容替换或更新本机代码；禁止用仓库工作流覆盖本机 n8n、用仓库配置覆盖 PostgreSQL 或外部环境文件，也禁止替换本机 Jimeng 代理源码。
- 如果本机与 GitHub 存在分歧，必须保留本机内容、报告差异并等待用户决定，不得把远端版本视为自动优先。全新且不存在任何 MerchRoute 代码、数据库、n8n、Jimeng 或运行配置的电脑，才允许直接从 GitHub 克隆进行首次安装。

## 独立开发分支强制规则

1. Codex 在修改任何源码、配置、测试、文档或受控 n8n 工作流导出文件前，必须先执行只读检查：
   - git status
   - git branch --show-current
   - git rev-parse HEAD

2. 每个新功能、Bug 修复或配置调整必须使用一个全新的独立分支，禁止直接在 main 上修改。

3. 分支必须从当前本机权威版本创建，禁止为了创建分支而执行 git pull、merge、rebase、reset、checkout 或使用 origin/main 覆盖本机。

4. 分支命名格式：
   work/<英文功能简称>-<YYYYMMDD-HHmm>
   例如：
   work/wb-task-description-20260827-1030

5. 如果当前存在未提交修改：
   - 必须先报告文件清单和修改范围；
   - 禁止自动 stash、reset、restore 或删除；
   - 如果修改属于当前任务，可以在用户确认后携带到新分支；
   - 如果属于其他任务，必须暂停并等待用户决定。

6. 如果当前已经位于其他任务的分支，禁止复用该分支。必须先确认当前工作树干净，再从当前本机权威提交创建新的任务分支。

7. 创建分支后必须回读并向用户报告：
   - 新分支名称；
   - 起始提交；
   - 工作树状态。
   确认当前分支不是 main 后，才能开始修改文件。

8. 完成修改后只能选择性暂存本次任务文件，禁止 git add . 和 git add -A。

9. 禁止直接推送或合并 main。需要发布时只能推送当前任务分支并创建 Draft PR。

10. 如果没有实际文件差异，不得制造空提交或空 PR。
