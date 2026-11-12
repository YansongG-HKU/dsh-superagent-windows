# Windows port

This fork makes the [dsh-superagent research prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
run on **Windows**, including **inside the DeepSeek Harness Desktop app** as an ordinary profile plugin.

Upstream is POSIX-first research code: its setup writes `#!/bin/sh` command shims, binds `gh` through a wrapper
script, runs the ticket prepare command with `sh`, and its service script needs `tmux`. None of that exists on
Windows. This fork keeps the upstream design and adds platform branches where the host touches the operating
system, plus a small set of fixes the desktop deployment needed.

> Research prototype, not an official DeepSeek product. MIT licensed; derived from upstream (see [LICENSE](LICENSE)).
> 中文版：[WINDOWS.zh.md](WINDOWS.zh.md)（安装、多仓库 cluster 模式、限制）。

## What works on Windows

Verified end to end on Windows 11 with Node 24 and DSH `0.2.1-rc.5` (Aug 2026 state of this fork):

- GitHub Issue/PR comments that mention the agent become tickets, assessed by the main Session.
- Each ticket gets its own worker Session, `git worktree` directory, branch, commits, pull request and delivery
  comments on the original conversation.
- Follow-up comments wake the worker; a human merge ends the ticket as `merged`; a person's stop ends it as
  `stopped`; a failed assignment can be retried.
- Pause/resume, plugin disable/enable, and full panel UI (overview, sources, triggers, evals, execution,
  settings, prompts, ticket/thread pages, search) work.

## Changes against upstream

Host-side (all with POSIX branches preserved):

- `src/deployment.ts`
  - `stateDir` accepts Windows drive-absolute (`C:\…`, `C:/…`) and UNC paths.
  - `executable()` resolves bare command names over `PATH` with `PATHEXT` (`.exe .cmd .bat .com`).
  - Setup probes run without the POSIX `env` command: Windows passes the probe environment through the
    subprocess spawn instead, **including `GH_CONFIG_DIR`**. Without it, setup would validate the operator's
    own signed-in account instead of the agent's, silently resolving the wrong identity.
  - Feishu probes become platform-safe the same way.
- `src/infra/environment.ts`
  - On Windows the agent identity comes from `GH_CONFIG_DIR` pointing at an isolated `gh` configuration
    directory (`<stateDir>\gh-agent`), not from a wrapper shim, so no `gh`/`lark-cli` shims are written.
  - Blocked commands are written as `<name>.cmd` shims (`@echo off` + marker + failure message + `exit /b 1`),
    keeping the marker-based ownership check, foreign-file refusal, atomic rename, and stale POSIX shim cleanup.
  - `worker-gitconfig` writes the credential helper as `!"C:/…/gh.exe" auth git-credential`, the form Git for
    Windows' bundled `sh` executes; `verifyEnvironment()` normalizes Windows config origins (separators, drive
    case) when validating it.
  - `agentVariables()` adds `GH_CONFIG_DIR` on Windows.
- `src/executor/dsh.ts` — the ticket prepare command runs as
  `pwsh -NoProfile -NonInteractive -Command <command>` on Windows (`sh -c` on POSIX); author prepare commands in
  PowerShell.
- `src/app/sessions.ts` — the main Session's tool allow-list names `pwsh` instead of `bash` on Windows and is
  filtered against the tools the composition actually registers (DSH refuses unknown names, which broke Session
  resume); the no-wait guard also covers `pwsh`.
- `src/sources/github.ts` — when the token cannot use the notifications API (missing `notifications` OAuth
  scope), the Source degrades to the repository event streams (`observeIssues`/`observeComments`) and reports
  the limitation in its health detail instead of failing every poll. Enable `observeIssues`/`observeComments`
  in the Source settings when the token has no `notifications` scope, or when the GitHub account itself
  receives no notifications (new/unverified accounts often do not).

Tests: Windows-specific cases added; inherently POSIX-only specs are skipped on `win32` (`skipIf`) while their
coverage stays intact on POSIX. `pnpm check` (typecheck + tests + build) passes on Windows:
1191 passed, 33 skipped, 0 failed (cluster mode and its panel page included).

## Requirements

- Windows 10/11, Node.js 22.19+ or 24+, pnpm 10/11, git 2.32+ (Git for Windows), GitHub CLI 2.48+.
- A DeepSeek Harness version in `engines.dsh` (`^0.2.1-alpha.2`); verified with the DSH Desktop runtime
  `0.2.1-rc.5`.
- One GitHub repository on github.com, an agent GitHub account with push access, and `gh` signed in to that
  account (keep the operator's own login separate).
- Optional Feishu: still POSIX-oriented (`lark-cli`); untested on Windows.

## Install (DSH Desktop app)

1. Clone this fork somewhere local and build it:

   ```powershell
   git clone https://github.com/<you>/dsh-superagent-windows.git
   cd dsh-superagent-windows
   pnpm install
   pnpm build
   ```

2. Prepare the agent's isolated `gh` configuration (one time; run as the operator, with the agent already
   signed in to `gh`):

   ```powershell
   ./tools/setup-agent-gh.ps1 -AgentUser <agent-login> -StateDir "$env:USERPROFILE\.dsh\state\superagent"
   ```

3. Add the machine configuration (`stateDir`) to the DSH profile that will host the plugin. `tools/install.ps1`
   writes/merges it for you:

   ```powershell
   ./tools/install.ps1 -Profile desktop -StateDir "$env:USERPROFILE\.dsh\state\superagent"
   ```

4. Install the bundle into that profile. For the Electron-managed `desktop` profile, ask the DSH agent (the
   `plugin_manager` tool) to install the bundle from this checkout:

   > Install the bundle at `<absolute path to this checkout>` into the current profile, then show the
   > Superagent page.

   For a custom, non-desktop profile you can instead run (with `dsh` on `PATH`):

   ```powershell
   dsh plugin --profile <profile> add "link:<absolute path to this checkout>"
   ```

5. Give the agent its GitHub identity and workload through the Superagent panel (or
   `tools/configure.mjs`, which calls the same management API): the repository, the agent `gh` CLI path, the
   Policy allow-list, the execution root and a PowerShell prepare command, and the Delivery requirements
   prompt section.

Starting from scratch: the panel's **Sources** card wants `owner/name` plus the absolute `gh.exe` path; the
**Policy** card wants the GitHub logins that may ask for work; the **Execution** card wants a prepare command
such as:

```powershell
$ErrorActionPreference = 'Stop'
$repo = '<absolute path to a local clone of the repository>'
$ref = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { 'HEAD' }
$remote = "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git"
git -C $repo fetch --no-tags $remote "${ref}:refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git -C $repo worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"
exit $LASTEXITCODE
```

`tools/` also contains `configure.mjs` (idempotent settings writes through the management API),
`status.ps1` (health/setup/ticket overview) and `smoke-test.mjs` (end-to-end: open an issue, watch the flow,
report the PR).

## Multiple repositories (cluster mode)

The prototype serves **one repository per plugin instance** on purpose: every GitHub API call a Source makes is
restricted to its configured repository, thread identities are per repository, and the ticket's prepare
command, branch, pull request and delivery all belong to that repository. Watching several repositories
therefore means running several isolated instances, and `tools/cluster.mjs` manages that fleet from one
declarative file (`~/.dsh/superagent-cluster.json`).

Each instance is a normal dsh-superagent deployment with its own:

- DSH profile (created from the shipped Web template, patched by the cluster tool),
- DSH process and port, so a crash, restart or upgrade of one repository cannot affect another,
- state directory (database, worker shims, agent git configuration, ticket directories) — the SQLite lock
  requires distinct directories,
- `gh` configuration directory (`<stateDir>\gh-agent`), so one agent account can serve every repository while
  each instance keeps its own identity boundary,
- panel, Policy allow-list and prompts; the agent shows what each repository needs like a separate teammate.

### From the panel

The Superagent panel has a **Repositories (cluster)** tab that reads the same cluster file and runs the same
tool, so the fleet is usable without a terminal:

- it lists every instance with its repository, port, Executor load, waiting Tickets, setup/health state and a
  link that opens that instance's own panel;
- **Start** and **Stop** run `cluster.mjs start --name …` / `stop --name …` for that instance;
- **Add repository** runs `cluster.mjs add --repo … --provision`: it creates the profile, installs the bundle,
  writes the isolated `gh` configuration, clones the repository, starts the process and writes the settings
  (about a minute). Adding a repository that already exists repairs that instance instead (retrying a clone or
  configuration that failed halfway), and the section below the form shows each operation's progress and output;
- instances started by the panel are normal detached processes: stopping DSH or the desktop app does not stop
  them, `stop` does, and after a reboot run `cluster.mjs start` (or the panel's Start for each row).

The page needs the plugin installed from its source checkout (it runs `tools/cluster.mjs` from there) and the
cluster file at `~/.dsh/superagent-cluster.json` (override with `DSH_SUPERAGENT_CLUSTER_CONFIG`).

Quick start (Windows; a plain terminal, not a DSH Session, so no inherited worker environment):

```powershell
cd <this checkout>
node tools/cluster.mjs init --bundle <this checkout> --dsh-bin <dsh>/lib/bin.js --node <node.exe> `
  --pnpm <pnpm.mjs> --agent-login <agent> --operator-login <you> --agent-cli <gh.exe> `
  --state-root <dir> --clone-root <dir> --external desktop=http://127.0.0.1:54746
node tools/cluster.mjs add --repo owner/first-repo --provision
node tools/cluster.mjs add --repo owner/second-repo --provision
node tools/cluster.mjs status
```

`add --provision` is the one-command form of add + setup + start + configure; `provision --name <instance>`
does the same for an existing instance that needs repair.

- `setup` creates each profile from the Web template, renders `tools/profile-template.yml` (port, state
  directory and model route), installs this bundle with `dsh plugin add link:<checkout>`, writes the agent's
  isolated `gh` configuration and clones the repository for ticket worktrees.
- `start` spawns `dsh --profile <profile>` detached and prints each panel URL (with its access token).
- `configure` calls each instance's management API with its repository, allow-list, prepare command and prompt.
- `stop` stops an instance and clears a stale state lock; `upgrade` rebuilds the bundle once and restarts every
  running instance; `doctor` checks paths, the agent identity, push access and free ports; `logs --name <n>`
  tails one instance.
- A hosted DSH Desktop instance cannot be started or stopped by the tool, but it can be registered as an
  `external` entry so `status` covers it in the same view.

Each instance's default model comes from `tools/profile-template.yml`. Without further configuration that is
the DeepSeek Desktop account sign-in (`deepseek-account` / `deepseek-flash` / `reasoningEffort: max`), as it
always was. An instance, or the cluster's `defaults`, may instead carry a `model` object in
`~/.dsh/superagent-cluster.json` with `provider`, `model` and an optional `reasoningEffort`; a `baseURL` also
declares that provider as a custom `llm-pi-ai` route with optional `api` (default `openai-completions`),
`headers`, `apiKeyEnv`, `contextWindow`, `reasoningEfforts` and `compat`, which is how a self-deployed
OpenAI-compatible endpoint serves every instance. `setup` and `doctor` print each instance's route; see
[tools/README.md](tools/README.md#model-route-per-instance) for the field-by-field rules and an example.

Practical limits: every instance is a full DSH runtime (a few hundred MB of memory), and GitHub rate limits are
per agent account — the Source polls the repository's notifications and event streams about once a minute, so a
handful of repositories is comfortable, dozens are not. Instances that use the same agent account need that
account to be a collaborator on each repository. For per-repository teams or separate credentials, give an
instance its own `--agent-login`/`--agent-cli` in `add`.

Background start/stop on Windows is not a Windows Service: after a reboot, run `cluster start` again (or register
a scheduled task that runs it at logon).

## How it behaves inside the DSH Desktop app

The plugin runs inside the desktop app's Node process, exactly like any other profile plugin. It does **not**
write the worker environment into `process.env`. Those values — `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL` (an isolated
`worker-gitconfig` with no commit identity and the agent's credential helper), the worker shims on `PATH` and the
credential-shaped tombstones — are attached only to the subprocess requests that belong to a worker Session, along
with the plugin's own worker commands:

- `gh` and `git` inside a worker Session act as the agent account: `git` uses the agent's credential helper and
  refuses to commit without an explicit identity.
- Every other Session of the same host process, and the operator's own tools, keep their own git and GitHub identity.

A spawn belongs to a worker when its initiating Agent is a worker Session (`worker-<ticketId>`) or its working
directory is a ticket workspace. The attribution is conservative on purpose: a spawn that cannot be attributed to a
worker keeps the host environment, so the host never acts as the agent by accident.

A dedicated profile is still recommended for isolation and because one instance polls one repository, but it is no
longer needed for environment reasons. `tools/dev-profile.ps1` starts a dedicated instance on `127.0.0.1:3082`.

## Known limitations

- The agent's GitHub account must be able to receive mentions. If its `gh` token lacks the `notifications`
  scope, or the account itself gets no notifications, enable **Receive Issues/Comments** in the Source settings
  that the degraded path uses. `gh auth refresh -h github.com -s notifications` adds the scope for accounts
  that do receive notifications.
- New Issues and new comments are the reliable triggers on Windows today; editing an old Issue body does not
  notify either path.
- Console windows: `gh`, `git` and the cluster tool are console programs, so on Windows every call made from
  the desktop app (a GUI process) would open its own console window and the Source's polling would flash
  windows. The plugin passes `windowsHide` for every CLI call it makes and the cluster tool does the same;
  other programs that run (a person's terminal, or DSH's own shell tools) keep their own console windows.
- Feishu is not ported (needs `lark-cli`, and is POSIX-oriented upstream).
- No auto-merge: pull requests are merged by a person (upstream default; the sample Delivery requirements remove
  the auto-merge paragraph).
- The state directory contains a plaintext `gh-agent\hosts.yml` (the agent token, ACL-restricted to the current
  user). Treat it as a credential and rotate it if it may have leaked.
- The worker runs as your Windows user without approval. The shims and git configuration are defaults, not a
  security boundary; use a dedicated OS account for real isolation.

## Verification

`tools/` plus the panel were exercised against a private playground repository: full issue→ticket→worker→PR→
delivery flow twice, a follow-up comment waking the worker and pushing a new commit, human merge ending two
tickets as `merged`, pause/resume, a deliberate stop ending a ticket as `stopped` without a PR, failure/retry,
and plugin disable/enable with environment restore and no duplicate work. CI (`.github/workflows/ci.yml`) runs
typecheck, tests and build on `ubuntu-latest` and `windows-latest`.

## License

MIT, same as upstream. See [LICENSE](LICENSE). Upstream copyright notice retained; modifications in this fork
are published under the same license.
