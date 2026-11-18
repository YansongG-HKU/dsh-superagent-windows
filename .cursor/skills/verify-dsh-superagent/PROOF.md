# Proof run

Feature driven: header **Search** (`features/search.md`), all four sub-features, on the Linux stand-in.

## Result

**Pass** for the stand-in search journey. **Not a Windows DSH Desktop pass.**

| Check | Result |
| --- | --- |
| `verify.mjs launch` ready line | Pass. `verify-dsh-superagent ready http://127.0.0.1:4173/` |
| `verify.mjs doctor` | Pass. `"ok": true`, identity `linux-stand-in`, runtime `ready`, `setupProbe` `skipped`, `dshOnPath` false |
| Title query `release` | Pass. Region contains `Release checklist` and not `Grocery list`. Status line `Found 1 Tickets, 0 Threads and 0 Triggers` |
| Trigger query `budget` | Pass. Region contains `Draft budget` and neither ticket title. Status line `Found 0 Tickets, 0 Threads and 1 Triggers` |
| Empty query `volcano` | Pass. `Nothing found. Try Trigger text, a GitHub PR or Issue link, or #number.` |
| Stored rows after search | Pass. `records` still has `Release checklist`, `Grocery list`, and `Draft budget` |
| Cleanup | Pass. Home `/tmp/dsh-superagent-verify` removed, port `4173` closed, evidence files still present |

## Evidence

- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/doctor.json`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/overview.png`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/overview.aria.txt`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-release.png`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-release.aria.txt`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-release.txt`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-release.json`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-budget.png`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-budget.txt`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-budget.json`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-empty.png`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-empty.txt`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/search-empty.json`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/tickets.json`
- `.cursor/skills/verify-dsh-superagent/evidence/proof-search/records.json`

## Commands

```sh
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs launch
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs doctor --out .cursor/skills/verify-dsh-superagent/evidence/proof-search/doctor.json
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role tab --name Overview
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser fill --role searchbox --name Search --value release
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser press --key Enter
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser wait --text "Found 1 Tickets"
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser region --name Search
# same fill/press/wait/region for budget and volcano
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET search --query q=release
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET tickets --query state=open
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs records
.cursor/skills/verify-dsh-superagent/scripts/verify.mjs cleanup
```

## Stand-in steps the Windows target does not do

- `pnpm install` only if `node_modules` is missing, then `npm install esbuild@0.25.12` under the disposable home and bundle `scripts/panel-entry.tsx`.
- Run `stand-in-server.ts` with `node --experimental-transform-types --experimental-sqlite`.
- Mount `App` directly in English and serve `tokens.css`, plus the banner `Linux verification stand-in`.
- Seed SQLite instead of receiving GitHub events.
- Serve `/orchestrator/api` by calling `stateView`, `overview`, `search`, `ticketList`, and `ClusterAdmin.view` from this process, not from DSH `registerHttp`.
- Write `cluster.json` with `--dsh-bin /nonexistent/dsh/lib/bin.js` and leave instance `widgets` stopped.

## Unverified

Windows DSH Desktop install and sidebar, host locale, design tokens, **Open main Session**, PowerShell installers and prepare command, `GH_CONFIG_DIR` and `.cmd` shims, setup probes, GitHub intake through worker and pull request, cluster start, Feishu, and pause notifying a main Session. `scripts/dsh-superagent start` was not run because `dsh` is not on `PATH`.
