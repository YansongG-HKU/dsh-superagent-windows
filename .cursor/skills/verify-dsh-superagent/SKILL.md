---
name: verify-dsh-superagent
description: "Drive the dsh-superagent Superagent panel (overview, header search, execution, cluster) the way an operator does. Use when checking panel behavior, a seeded ticket search, or the cluster repository list. On a machine without the dsh CLI this launches the Linux stand-in, not the Windows DSH Desktop host."
---

# Verify dsh-superagent

The operator surface is the **Superagent** web panel hosted by DeepSeek Harness: tabs Overview, Source, Trigger, Eval, Execution, Cluster, and Settings, plus the header search box. This fork's intended host is the Windows DSH Desktop app. Operators also use `node tools/cluster.mjs` and, on POSIX, `scripts/dsh-superagent`. Windows installers live in `tools/*.ps1`.

Run every command from the repository root. The harness is `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs`. One disposable home is `/tmp/dsh-superagent-verify`. A second launch against a live home is refused. Override the home with `DSH_SUPERAGENT_VERIFY_HOME` and the panel port with `DSH_SUPERAGENT_VERIFY_PORT` (default `4173`). Do not point those at a person's real `~/.dsh` directory.

## Launch

If `dsh` is on `PATH`, do not start the stand-in. Start the real service and drive the URL it prints:

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

Ready means `scripts/dsh-superagent status` exits and prints one pid whose `health.runtime` is `ready` or `paused`. Exit `3` means setup is still waiting; the panel is not ready to take work. This VM has no `dsh` binary, so that command was not run. See the gaps below before treating a stand-in result as a Windows result.

When `dsh` is absent, launch the stand-in:

```sh
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs launch
```

Ready is the line `verify-dsh-superagent ready http://127.0.0.1:4173/` after all of these are true: the page title contains `Superagent`, `GET /orchestrator/api/state` reports `health.runtime.state` `ready` for this home's state directory, and the overview lists the seeded ticket `Release checklist`. A listening port alone is not ready.

The stand-in home is created empty, then:

- `pnpm install --frozen-lockfile` runs only when `node_modules` is missing.
- `node tools/cluster.mjs init` and `add --repo acme/widgets` write `/tmp/dsh-superagent-verify/cluster.json`. The dsh binary path in that file is `/nonexistent/dsh/lib/bin.js` because no dsh binary exists. Instance `widgets` is not started.
- SQLite at `/tmp/dsh-superagent-verify/state/orchestrator.sqlite` is migrated by the real `Store` and seeded with GitHub source `acme/widgets`, allowed login `operator`, ticket `Release checklist` (awaiting an answer), ticket `Grocery list` (working), and trigger text `Draft budget` on thread `#42`.
- esbuild is installed under the home and bundles the real `App` from `src/client/app.tsx`.
- The server listens on `127.0.0.1:4173` only.

The panel is English. A DSH Desktop session follows the host locale, which is often Chinese. Do not translate assertions to match a different locale; launch the stand-in, or set the Desktop locale to English, and use the English names in the feature map.

These stand-in steps do not happen on the Windows DSH Desktop target. They stay unverified until a run there covers them:

- Installing esbuild and bundling `scripts/panel-entry.tsx`. The Desktop loads the panel through `src/client/index.tsx` slot injection.
- Serving `scripts/tokens.css`. Desktop and Web shells already define the `--dsw-alias-*` tokens.
- Forcing the English dictionary instead of the host locale.
- Seeding SQLite. Real tickets arrive from GitHub polling.
- Serving `/orchestrator/api` from this process. Production routes are mounted by `registerHttp` on the DSH web server.
- Writing a cluster file whose dsh path is missing. A real cluster file points at an installed `dsh` binary.
- Showing the banner `Linux verification stand-in`.

Still unverified on Windows, because this VM cannot run them:

- `tools/install.ps1`, `tools/setup-agent-gh.ps1`, `tools/dev-profile.ps1`, `tools/status.ps1`, and a PowerShell prepare command (`pwsh` is not installed).
- The Desktop sidebar entry, Plugin Manager config page, DSH design tokens, and **Open main Session**.
- `GH_CONFIG_DIR` agent identity, `.cmd` blocked-command shims, and the Git for Windows credential helper.
- Setup probes: agent login, repository push access, and worker git config.
- A GitHub mention becoming a ticket, a worker session, a worktree, a pull request, and a delivery comment.
- Cluster **Add and start** / `cluster.mjs start`. Both spawn `dsh`.
- Feishu. The Windows port also marks Feishu untested.
- Pause notifying the main Session. The stand-in stores `paused` and returns `sessionNotified: false`.

Tear the stand-in down with Cleanup. Do not leave it running.

## Doctor

Run this before driving, and again whenever the page looks wrong:

```sh
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs doctor
```

Drive only when the JSON has `"ok": true`. That means the recorded pid is alive, that pid owns the listen socket, `x-dsh-superagent-verify` is `linux-stand-in`, `health.runtime.state` is `ready`, and `setup.machine.stateDir` is this run's state directory. `setupProbe` is `skipped` and `sessionCatalog` is `absent`: doctor does not claim GitHub setup or a DSH session passed. Exit code `1` means do not drive.

On a real `dsh` service, doctor is `scripts/dsh-superagent status`, not this command. This command rejects a response that lacks the stand-in header so it cannot be aimed at someone else's panel.

## Drive

The feature map is `.cursor/skills/verify-dsh-superagent/features/`. Read `features/README.md`, then follow one feature file exactly. Prefer accessible names over coordinates.

The panel frame:

- Heading `Superagent` (`h1`).
- Tab list `dsh-superagent pages`. Tabs: `Overview`, `Source`, `Trigger`, `Eval`, `Execution`, `Cluster`, `Settings`.
- Search box: role `searchbox`, name `Search`. Submitting the form runs the search. Emptying the field or pressing `Escape` closes the results. There is no `/` shortcut and no **Clear search** button.
- Results: region named `Search`.
- Glossary button name `Glossary`. **Open main Session** is disabled on the stand-in (`masterId` is empty).

Browser commands, from a ready stand-in:

```sh
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role tab --name "Overview"
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser fill --role searchbox --name "Search" --value "release"
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser press --key "Enter"
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser wait --text "Found 1 Tickets"
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser region --name "Search"
```

`browser wait` matches visible page text. For a result that is also painted behind the dropdown, assert with `browser region`, not with page text alone. The same management API the panel calls:

```sh
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET search --query q=release
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET tickets --query state=open
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs records
```

`records` reads ticket titles and trigger text from the SQLite file. It is a second view of stored rows, not a test-only HTTP route.

## Evidence

Write proof under `.cursor/skills/verify-dsh-superagent/evidence/<feature>/`. Cleanup never deletes that directory.

A UI proof needs the action and the resulting state: an ARIA snapshot (`browser snapshot --aria --path ...`) and a screenshot (`browser screenshot --path ...`) that show the stand-in banner, the `Superagent` heading, and the result. A search proof also needs `browser region` text, the `api GET search` body, and `records` showing both seeded tickets still present. Search must not add or remove rows.

Do not count a stand-in pass as proof of GitHub intake, a worker session, setup probes, or the Windows Desktop shell. Those need the observations listed under Launch. Mocks stop at the existing production boundary: the panel talks to `/orchestrator/api`, and GitHub, Feishu, and DSH sessions stay outside this process. The stand-in calls the same view functions the management API uses (`stateView`, `overview`, `search`, `ticketList`, `ticketDetail`, `sourcesStatus`, `ClusterAdmin.view`). It does not poll GitHub.

## Cleanup

```sh
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs cleanup
```

Cleanup sends `SIGTERM` to the server pid and the Chrome pid recorded in the home's `control.json`, then deletes the home. It does not kill by process name and it does not remove `.cursor/skills/verify-dsh-superagent/evidence/`. After cleanup, `GET` on the panel port must fail and the evidence files must still be on disk.

A failed `launch` deletes only a home that this attempt created.

## Helpers

| Helper | Invocation |
| --- | --- |
| `scripts/verify.mjs` | `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs <launch\|doctor\|browser\|api\|records\|cleanup>` |
| `scripts/stand-in-server.ts` | Started by `launch` as `node --experimental-transform-types --experimental-sqlite scripts/stand-in-server.ts`. Do not start it by hand. |
| `scripts/panel-entry.tsx` | Bundled by `launch` into the home as `panel.js`. It mounts the real `App`. |
| `scripts/tokens.css` | Served at `/tokens.css` as token scaffolding for the stand-in page. |

`browser` subcommands: `click --role --name`, `fill --role --name --value`, `press --key`, `region --name [--out file]`, `text [--out file]`, `wait --text`, `snapshot --aria --path`, `screenshot --path`. `doctor`, `api`, and `records` accept `--out`. `api` is `api <METHOD> <path> [--query key=value]`.

Keep this map honest as the panel changes with `/maintain-verification-skill`.
