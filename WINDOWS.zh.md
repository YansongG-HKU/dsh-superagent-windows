# Windows 移植与多仓库使用指南

本仓库是 [dsh-superagent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 **Windows 移植**：
让它在 **Windows** 上运行，包括直接装进 **DeepSeek Harness 桌面版**（DSH Desktop）作为一个普通的 profile 插件。

上游是 POSIX 优先的研究代码：setup 会写 `#!/bin/sh` 命令 shim、通过包装脚本绑定 `gh` 身份、用 `sh` 跑工单准备命令，
服务脚本还依赖 `tmux`——这些在 Windows 上都不存在。本 fork 保留上游设计，在 host 与操作系统交界处增加平台分支，
并补上桌面版部署需要的少量修复。

> 研究原型，不是 DeepSeek 官方产品。MIT 许可；派生自上游（见 [LICENSE](LICENSE)）。

## Windows 上可用的功能

已在 Windows 11 + Node 24 + DSH `0.2.1-rc.5` 上端到端验证：

- GitHub Issue / PR 评论里 @ 智能体 → 由主 Session 评估成工单；
- 每个工单有自己的 worker Session、`git worktree` 目录、分支、提交、pull request 和原会话交付评论；
- 跟进评论能唤醒 worker；人工合并让工单以 `merged` 结束；人的停止以 `stopped` 结束；失败的 assignment 可重试；
- 暂停/恢复、插件停用/启用、完整面板 UI（概览、来源、触发、评估、执行、设置、提示词、工单/线程页、搜索）都可用；
- **多仓库 cluster 模式**（见下文）：一个仓库一个隔离实例，`tools/cluster.mjs` 统一管理。

## 相对上游的改动

Host 侧（POSIX 分支全部保留）：

- `src/deployment.ts`
  - `stateDir` 接受 Windows 盘符绝对路径（`C:\…`、`C:/…`）和 UNC 路径；
  - `executable()` 通过 `PATH` + `PATHEXT`（`.exe .cmd .bat .com`）解析裸命令名；
  - setup 探针不再依赖 POSIX `env` 命令：Windows 下把探针环境通过 subprocess spawn 传入，**包含 `GH_CONFIG_DIR`**——
    否则 setup 会把操作者自己登录的账号当成 agent，静默解析成错误身份；
  - Feishu 探针同样做了平台安全处理。
- `src/infra/environment.ts`
  - Windows 下 agent 身份来自指向隔离 `gh` 配置目录（`<stateDir>\gh-agent`）的 `GH_CONFIG_DIR`，而不是包装 shim，
    所以不写 `gh`/`lark-cli` shim；
  - 被禁命令写成 `<name>.cmd` shim（`@echo off` + 标记 + 失败信息 + `exit /b 1`），保留标记式归属检查、
    拒绝覆盖外来文件、原子 rename、清理旧的 POSIX shim；
  - `worker-gitconfig` 里的凭据助手写成 Git for Windows 能执行的
    `!"C:/…/gh.exe" auth git-credential`；`verifyEnvironment()` 校验时对 Windows 配置来源做归一化（分隔符、盘符大小写）；
  - `agentVariables()` 在 Windows 下加入 `GH_CONFIG_DIR`。
- `src/executor/dsh.ts`：工单准备命令在 Windows 下用 `pwsh -NoProfile -NonInteractive -Command <命令>`（POSIX 仍是 `sh -c`）；
  准备命令请用 PowerShell 写。
- `src/app/sessions.ts`：主 Session 的工具白名单在 Windows 下用 `pwsh` 而不是 `bash`，并按实际注册的工具过滤
  （DSH 拒绝未知工具名，会导致 Session 恢复失败）；no-wait 保护同样覆盖 `pwsh`。
- `src/sources/github.ts`：token 无法使用通知 API（缺 `notifications` OAuth scope）时，Source 降级到仓库事件流
  （`observeIssues`/`observeComments`），在健康详情里说明限制，而不是每轮 poll 都失败。token 没有 notifications scope、
  或 GitHub 账号本身收不到通知（新账号/未验证邮箱常见）时，请在 Source 设置里打开这两个开关。

测试：新增 Windows 用例；纯 POSIX 用例在 `win32` 上 skip，POSIX 覆盖不变。`pnpm check`（typecheck + test + build）
在 Windows 通过：当前套件 1191 通过 / 33 跳过 / 0 失败（含 cluster 工具、面板集群页及其宿主 API）。

## 环境要求

- Windows 10/11、Node.js 22.19+ 或 24+、pnpm 10/11、git 2.32+（Git for Windows）、GitHub CLI 2.48+；
- 满足 `engines.dsh`（`^0.2.1-alpha.2`）的 DeepSeek Harness；已在桌面版运行时 `0.2.1-rc.5` 验证；
- 一个 github.com 仓库；一个有 push 权限的 agent GitHub 账号，且 `gh` 已登录该账号（与操作者自己的登录分开）；
- 可选 Feishu：仍面向 POSIX（`lark-cli`），Windows 未验证。

## 安装（桌面版 DSH）

1. 克隆本仓库并构建：

   ```powershell
   git clone https://github.com/<you>/dsh-superagent-windows.git
   cd dsh-superagent-windows
   pnpm install
   pnpm build
   ```

2. 准备 agent 的隔离 `gh` 配置（一次性；操作者执行，agent 账号已登录过 `gh`）：

   ```powershell
   ./tools/setup-agent-gh.ps1 -AgentUser <agent-login> -StateDir "$env:USERPROFILE\.dsh\state\superagent"
   ```

3. 把机器配置（`stateDir`）写进要托管插件的 DSH profile。`tools/install.ps1` 会写好：

   ```powershell
   ./tools/install.ps1 -Profile desktop -StateDir "$env:USERPROFILE\.dsh\state\superagent"
   ```

4. 安装 bundle 到该 profile。Electron 托管的 `desktop` profile 请让 DSH agent（`plugin_manager` 工具）安装：

   > 把 `<本仓库绝对路径>` 处的 bundle 安装到当前 profile，然后打开 Superagent 页面。

   自定义的非 desktop profile 也可以直接用 `dsh` 安装：

   ```powershell
   dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
   ```

5. 通过 Superagent 面板（或 `tools/configure.mjs`，调同一套管理 API）配置：仓库、agent 的 `gh` CLI 路径、
   Policy 允许名单、执行根目录与 PowerShell 准备命令、Delivery requirements 提示词。

从零开始：**来源** 卡片填 `owner/name` 和 `gh.exe` 绝对路径；**Policy** 卡片填可以发指令的 GitHub 登录名；
**执行** 卡片填准备命令，例如：

```powershell
$ErrorActionPreference = 'Stop'
$repo = '<仓库本地克隆的绝对路径>'
$ref = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { 'HEAD' }
$remote = "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git"
git -C $repo fetch --no-tags $remote "${ref}:refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git -C $repo worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
exit $LASTEXITCODE
```

`tools/` 里还有：`configure.mjs`（幂等写设置）、`status.ps1`（健康/设置/工单概览）、
`smoke-test.mjs`（端到端：开 Issue、观察流程、报告 PR）。

## 多仓库（cluster 模式）

原型**一个实例只服务一个仓库**，这是有意的：Source 的每个 GitHub API 调用都被限制在配置的仓库、
线程标识按仓库区分、工单的准备命令/分支/PR/交付都属于该仓库。要盯多个仓库，就是跑多个隔离实例，
`tools/cluster.mjs` 用一个声明式文件（`~/.dsh/superagent-cluster.json`）管理这支队伍。

每个实例都是一个普通的 dsh-superagent 部署，各自拥有：

- DSH profile（从随包的 Web 模板创建，由 cluster 工具渲染补丁）；
- DSH 进程与端口——一个仓库崩溃、重启或升级不会影响另一个；
- 状态目录（数据库、worker shim、agent git 配置、工单目录）——SQLite 锁要求目录互不相同；
- `gh` 配置目录（`<stateDir>\gh-agent`）——同一个 agent 账号可以服务多个仓库，但每个实例保持自己的身份边界；
- 面板、Policy 允许名单和提示词；每个仓库像一个独立的同事，各自有自己的"待办"。

### 在面板里管理

Superagent 面板多了一个 **集群** 页，读同一份集群配置、调同一个工具，所以不用终端也能管多仓库：

- 列出每个实例：仓库、端口、执行器负载、待处理工单、setup/健康状态，以及"打开面板"链接（直达该实例自己的面板）；
- **启动 / 停止** 对该实例执行 `cluster.mjs start --name …` / `stop --name …`；
- **添加仓库** 执行 `cluster.mjs add --repo … --provision`：建 profile、装插件、写隔离的 gh 配置、克隆仓库、
  启动进程、写入设置（约一分钟）。重复添加一个已存在的仓库会改为"修复配置"（重试可能中断的克隆或配置），
  表单下方的"最近操作"显示进度和输出；
- 面板启动的实例是普通后台进程：关闭 DSH/桌面版不会停它们，只有"停止"会；机器重启后点各行的"启动"或跑一次
  `cluster.mjs start`。

这个页面需要插件以源码目录方式安装（它会从那里运行 `tools/cluster.mjs`），并且集群配置位于
`~/.dsh/superagent-cluster.json`（可用 `DSH_SUPERAGENT_CLUSTER_CONFIG` 覆盖）。

快速开始（Windows；请在**普通终端**而不是 DSH 会话里执行，避免继承 worker 环境）：

```powershell
cd <本仓库>
node tools/cluster.mjs init --bundle <本仓库> --dsh-bin <dsh>/lib/bin.js --node <node.exe> `
  --pnpm <pnpm.mjs> --agent-login <agent> --operator-login <你> --agent-cli <gh.exe> `
  --state-root <目录> --clone-root <目录> --external desktop=http://127.0.0.1:54746
node tools/cluster.mjs add --repo owner/first-repo --provision
node tools/cluster.mjs add --repo owner/second-repo --provision
node tools/cluster.mjs status
```

`add --provision` 是 add + setup + start + configure 的一条命令形式；`provision --name <实例>` 用于修复已有实例。

- `setup`：从 Web 模板创建各 profile、渲染 `tools/profile-template.yml`（端口、状态目录、模型路由）、
  用 `dsh plugin add link:<本仓库>` 安装本 bundle、写入 agent 的隔离 `gh` 配置、克隆仓库供工单建 worktree。
- `start`：以后台方式启动 `dsh --profile <profile>`，打印每个面板的 URL（含访问 token）。
- `configure`：通过各实例的管理 API 写入仓库、允许名单、准备命令和提示词。
- `stop` 停止实例并清理强杀留下的状态锁；`upgrade` 只构建一次 bundle 然后重启所有运行中的实例；
  `doctor` 检查路径、agent 身份、push 权限和端口占用；`logs --name <n>` 看单个实例日志。
- 桌面内嵌实例不能由工具启停，但可以作为 `external` 条目纳入 `status` 的统一视图。

实际限制：每个实例是一个完整 DSH 运行时（几百 MB 内存），GitHub 速率限制按 agent 账号计算——
Source 约每分钟轮询一次，因此几个到十几个仓库是舒服的，几十个不现实。共用同一 agent 账号时，
该账号必须是每个仓库的协作者；需要按仓库分团队或分凭据时，在 `add` 时给实例单独的 `--agent-login`/`--agent-cli`。

Windows 上的后台启停不是 Windows 服务：机器重启后需要再执行 `cluster start`（或注册登录时运行它的计划任务）。

## 在桌面版 DSH 里运行的行为

插件像其他 profile 插件一样运行在桌面应用的 Node 进程里。它**不会**把 worker 环境写进 `process.env`：`GH_CONFIG_DIR`、
`GIT_CONFIG_GLOBAL`（隔离的 `worker-gitconfig`，没有提交身份，带 agent 的凭据助手）、`PATH` 上的 worker shim 以及
凭据类变量墓碑，只挂到属于 worker 会话的子进程请求上，以及插件自己的 worker 命令上：

- worker 会话里的 `gh` 和 `git` 以 agent 身份工作：`git` 使用 agent 的凭据助手，没有显式身份时拒绝提交。
- 同一个宿主进程里的其他会话、以及你自己的工具，保持各自的 git 与 GitHub 身份。

归因规则：子进程的发起 Agent 是 worker 会话（`worker-<ticketId>`），或其工作目录是工单工作区，才算 worker 的子进程。
归因刻意保守：归不到 worker 的请求保留宿主环境，避免宿主误用 agent 身份。

独立 profile 仍建议用于隔离，也因为一个实例只轮询一个仓库，但不再因为环境原因而必需。
`tools/dev-profile.ps1` 可在 `127.0.0.1:3082` 启动一个独立实例。

## 已知限制

- agent 的 GitHub 账号必须能收到提及。如果它的 `gh` token 没有 `notifications` scope，或账号本身收不到通知，
  请在 Source 设置里打开 **接收仓库里的新 Issue / 评论**（降级路径）。能收到通知的账号可用
  `gh auth refresh -h github.com -s notifications` 补上 scope。
- Windows 上目前可靠的触发是**新 Issue 和新评论**；编辑旧 Issue 正文不会通知任何一条路径。
- 控制台窗口：`gh`、`git`、集群工具都是控制台程序，从桌面版（GUI 进程）调用时每个命令都会新开一个
  控制台窗口，Source 轮询时就会不停闪窗。插件对每一次 CLI 调用都传了 `windowsHide`，集群工具同样处理；
  你自己终端里的命令、或 DSH 本身执行 shell 时，窗口仍属于各自的程序。
- 未移植 Feishu（需要 `lark-cli`，上游面向 POSIX）。
- 不做自动合并：PR 由人合并（上游默认；示例 Delivery requirements 删掉了自动合并段落）。
- 状态目录里有明文 `gh-agent\hosts.yml`（agent token，ACL 限制为当前用户）。把它当凭据对待，怀疑泄露时轮换。
- worker 以你的 Windows 用户身份无审批运行。shim 和 git 配置是默认值，不是安全边界；真正隔离请用独立 OS 账号。

## 验证

`tools/` 与面板已在一个私有 playground 仓库上实际跑过：完整 issue→工单→worker→PR→交付两次、跟进评论唤醒 worker
并推送新提交、人工合并让两个工单以 `merged` 结束、暂停/恢复、主动停止让工单以 `stopped` 结束且不产生 PR、失败/重试、
插件停用/启用后环境恢复且无重复处理；多仓库 cluster 模式另起第二个仓库验证了同样的完整链路，并验证了
setup/start/status/stop/start/configure/doctor/upgrade。CI（`.github/workflows/ci.yml`）在
**ubuntu-latest 与 windows-latest** 上跑 typecheck、测试和构建。

## 许可

MIT，与上游相同。见 [LICENSE](LICENSE)。上游版权声明保留；本 fork 的修改以相同许可发布。
