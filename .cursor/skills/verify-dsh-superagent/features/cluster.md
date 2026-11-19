# Cluster repositories

Cluster lists one Superagent instance per repository and can add or start an instance. The stand-in can show the instance that `cluster.mjs add` recorded. It cannot start one, because no `dsh` binary exists.

## Sub-features

- `cluster-list` shows instance `widgets` for `acme/widgets` as stopped.
- `cluster-cli` prints the same instance from `node tools/cluster.mjs list`.
- `cluster-start` starts that instance and opens its panel. This sub-feature fails on the stand-in.

## How to get to it (user POV)

- Choose the `Cluster` tab. The page heading is `Repositories (cluster)`.
- From a terminal, run `node tools/cluster.mjs list --config <cluster.json>` against this run's cluster file.
- Choose `Start` on a stopped row, or submit `Add and start` with a repository `owner/name`. Both run `tools/cluster.mjs`.

## Driving it with verify-dsh-superagent

Preconditions:

- `verify.mjs doctor` reports `"ok": true`.
- Launch already ran `cluster.mjs add --repo acme/widgets` into this home's `cluster.json`.
- `dsh` is absent, and the config's dsh path is `/nonexistent/dsh/lib/bin.js`.

- **Open the tab.** Choose `Cluster`. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role tab --name "Cluster"`, then `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser wait --text "acme/widgets"`. The page shows `widgets`, `acme/widgets`, `stopped`, and a `Start` button.
- **API list.** Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET cluster`. `available` is true, the instance `repository` is `acme/widgets`, and `running` is false.
- **CLI list.** Run `node tools/cluster.mjs list --config /tmp/dsh-superagent-verify/cluster.json` (use the `clusterConfig` path from doctor when the home is overridden). The row contains `widgets` and `acme/widgets`.
- **Start.** Do not mark this passed on the stand-in. Choosing `Start` runs `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role button --name "Start"`, which runs `cluster.mjs start`. The operation fails because `node /nonexistent/dsh/lib/bin.js --profile superagent-widgets --no-open` cannot print a panel URL. The instance stays stopped. Record the operation output and stop. That is a failed `cluster-start`, not a pass.
- **Proof of the list only.** Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser screenshot --path .cursor/skills/verify-dsh-superagent/evidence/cluster/list.png`. The shot shows `acme/widgets` and `stopped`. Name the artifact as the list entry, not as a started instance.

## Gotchas

- **Add and start** is `cluster.mjs add --provision`, which also requires `dsh`. A validation error or a missing binary is a failure.
- The panel and the CLI must use the same `--config` file. The default `~/.dsh/superagent-cluster.json` is a different fleet. Doctor's `clusterConfig` is the file this run may touch.
- Port `4590` is the instance port in the config. The stand-in panel itself is `4173`. A free `4590` does not mean the instance is running.
- `cluster.mjs doctor` checks the agent `gh` identity under `<stateDir>/gh-agent`. That directory is not signed in. A doctor failure there is expected and is not a panel-list failure.
