# tools

Helpers for running this Windows port. All paths and accounts are parameters; nothing here
contains credentials. See [../WINDOWS.md](../WINDOWS.md) for the full installation story.

| File | Purpose |
| --- | --- |
| `install.ps1` | Build `lib/` and append the `dsh-superagent` machine configuration (`stateDir`) to a DSH profile's `cordis.patch.yml`; prints the remaining install steps. |
| `setup-agent-gh.ps1` | Create the agent account's isolated `gh` configuration under `<stateDir>\gh-agent` (GH_CONFIG_DIR), restricted to the current Windows user. |
| `configure.mjs` | Idempotent settings setup through the management API: GitHub Source, Policy allow-list, PowerShell prepare command, Delivery requirements prompt. |
| `status.ps1` | Print setup, accounts, health, last day's flow and the tickets waiting for a person (exit codes 0/1/2/3). |
| `smoke-test.mjs` | Open an Issue that mentions the agent, then follow the ticket to a person stage or its end, printing pull requests. |
| `dev-profile.ps1` | Start/stop a dedicated-profile deployment (upstream's recommended layout) instead of the Desktop profile. |
| `cluster.mjs` | **Multiple repositories:** one independent instance per repository from a declarative JSON config — `init`, `add` (`--provision` brings a repository all the way up), `setup`, `start`, `stop`, `status`, `configure`, `provision`, `upgrade`, `doctor`, `logs`. The panel's **Repositories (cluster)** page reads the same config and runs this tool. |
| `profile-template.yml` | Profile patch template the cluster tool renders for every instance (port, state dir, and the model route: `agent-default-model` plus the `llm-pi-ai` providers a custom endpoint declares). |

## Multiple repositories (cluster mode)

The prototype serves one repository per instance, so several repositories are several isolated
instances: one DSH profile, process, port, state directory, `gh` configuration and panel each.
`cluster.mjs` keeps that fleet in one file (`~/.dsh/superagent-cluster.json`).

```powershell
# one time: describe the machine and the shared agent account
node tools/cluster.mjs init --bundle <this checkout> --dsh-bin <dsh/lib/bin.js> --node <node.exe> `
  --pnpm <pnpm.mjs> --agent-login <agent> --operator-login <you> --agent-cli <gh.exe> `
  --state-root <dir> --clone-root <dir> [--external desktop=http://127.0.0.1:54746]

# per repository
node tools/cluster.mjs add --repo owner/name --provision # allocates name/profile/port/state/clone and brings it up
node tools/cluster.mjs setup                           # profiles, patches, bundle, gh config, clones
node tools/cluster.mjs start                           # detached DSH processes, prints panel URLs
node tools/cluster.mjs configure                       # Source/Policy/Executor/Prompts per instance
node tools/cluster.mjs status                          # setup, health, executor load per instance
```

`--name <instance>` limits setup/start/stop/configure to one instance; `upgrade` rebuilds the
bundle once and restarts the running instances; `doctor` checks paths, identity, push access and
free ports. A hosted DSH Desktop instance can be listed as `--external` so `status` covers it too.

### Model route per instance

Every instance's profile gets its DSH default model from `tools/profile-template.yml`. An instance — or
the cluster's `defaults` — may carry a `model` object in `~/.dsh/superagent-cluster.json`:

```json
{
  "defaults": {
    "model": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "max" }
  },
  "instances": [
    {
      "name": "quantalpha",
      "model": {
        "provider": "spark-local",
        "model": "deepseek-v4.1-flash",
        "reasoningEffort": "max",
        "baseURL": "http://127.0.0.1:18790/v1",
        "api": "openai-completions",
        "apiKeyEnv": "SPARK_API_KEY",
        "headers": { "Authorization": "Bearer local-placeholder" },
        "contextWindow": 1048576,
        "reasoningEfforts": { "low": "low", "medium": "medium", "high": "high", "max": "max" }
      }
    }
  ]
}
```

Without a `model` object the template renders the DeepSeek Desktop account route exactly as clusters
configured before this option did (`deepseek-account` / `deepseek-flash` / `reasoningEffort: max`), so
existing cluster files keep working. Once a `model` object exists, `provider` and `model` are required;
`reasoningEffort` must be one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` and, when
omitted, is left out of the rendered config so the provider's own default applies.

An instance's fields override `defaults.model` field by field; the nested `headers`, `reasoningEfforts`
and `compat` maps are replaced whole. A `baseURL` declares the provider as a custom `llm-pi-ai` route in
the generated profile, which is how a self-deployed OpenAI-compatible endpoint is used: `api` defaults
to `openai-completions`, `apiKeyEnv` names an environment variable of the instance's DSH process,
`headers` are sent as given, and the `models[]` entry declares the model id with an optional
`contextWindow` and `reasoningEfforts` (level → wire value). The advanced `compat` object passes pi-ai's
wire-compatibility switches for that protocol (for example `{"thinkingFormat": "openai"}`). The
endpoint-specific fields require a `baseURL`. No secret is stored in the cluster file; the placeholder
Authorization header above is local. The rendered profile keeps the OpenCode Go fallback route, and a
custom route that is itself `opencode-go` replaces that fallback declaration.

`setup` (and `provision`) renders the route into each instance's profile patch on every run, so keep
model choices in the cluster file rather than editing the generated `cordis.patch.yml`: the next run
overwrites it. `setup` and `doctor` print each instance's route and `list` shows it; a `model` object
that fails validation is reported there with the field to fix. A custom `--profile-template` must keep
the template's placeholders to receive the route.

