# dsh-superagent verification map

This directory is the maintained source for verifying the operator-facing Superagent panel. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch from the repository root with `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs launch`.
- The ready line is `verify-dsh-superagent ready http://127.0.0.1:4173/`.
- The disposable home is `/tmp/dsh-superagent-verify` unless `DSH_SUPERAGENT_VERIFY_HOME` is set. Do not share it between runs.
- The seeded store contains ticket `Release checklist` (awaiting an answer), ticket `Grocery list` (working), and trigger text `Draft budget` on thread `#42`.
- Cluster config lists instance `widgets` for `acme/widgets`, stopped, on port `4590`.
- Run `verify.mjs doctor` and require `"ok": true`, the stand-in identity, and this run's state directory.
- Never drive a panel this run did not start. A real `dsh` service uses `scripts/dsh-superagent`, not this stand-in.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- The stand-in UI is English. Use the accessible names in these files.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `verify.mjs browser`.
- Run management API reads through `verify.mjs api`.
- Run the SQLite read-back through `verify.mjs records`.
- Restore nothing by hand. `cleanup` drops the home. Do not remove proof artifacts.

## Proof and skip reporting

- Capture the operator action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot that show the stand-in banner and `Superagent`.
- API proof includes the status and JSON body.
- A search or other read proves it did not change stored tickets by running `records` afterward.
- Record the feature id and the entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- A stand-in pass does not verify the Windows DSH Desktop shell, GitHub intake, or cluster start.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the operator-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every operator entry point.
3. `Driving it with verify-dsh-superagent` starts with `Preconditions:` and uses labeled bullets that pair each operator action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Overview](./overview.md) shows tickets that need a person, the last day, and executor load.
- [Search](./search.md) finds tickets and triggers from the header search box, including an empty query result.
- [Cluster repositories](./cluster.md) lists repository instances from the cluster file and records that start needs `dsh`.
- [Execution](./execution.md) lists open tickets and states the pause proof the stand-in cannot finish.
