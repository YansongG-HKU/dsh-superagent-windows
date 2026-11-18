# Overview

Overview is the panel landing page. It lists tickets that need a person, then system problems, the last 24 hours, and executor load.

## Sub-features

- `overview-pending` shows `Release checklist` under Pending Tickets with stage Awaiting answer.
- `overview-hide-working` does not list `Grocery list` in Pending Tickets. That ticket is working, not waiting on a person.
- `overview-counts` shows the last 24 hours and the executor load, each with a Details link.

## How to get to it (user POV)

- Open the Superagent panel. The stand-in URL is `http://127.0.0.1:4173/`. On DSH Desktop this is the Superagent sidebar entry; that sidebar is not part of the stand-in.
- Choose the `Overview` tab.

## Driving it with verify-dsh-superagent

Preconditions:

- `verify.mjs doctor` reports `"ok": true` and this run's state directory.
- The seeded ticket `Release checklist` is waiting for an answer.
- The seeded ticket `Grocery list` is working.

- **Open overview.** Choose `Overview`. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role tab --name "Overview"`. The tab `Overview` is selected and the heading `Pending Tickets` shows count `1`.
- **Pending ticket.** Read the page. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser text`. The text contains `Release checklist`, `Awaiting answer`, and `Confirm the release checklist`. It does not contain `Grocery list`.
- **Counts.** The same text contains `Last 24 hours` and `Executing` with `0 / 3`.
- **Proof.** Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser snapshot --aria --path .cursor/skills/verify-dsh-superagent/evidence/overview/overview.aria.txt` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser screenshot --path .cursor/skills/verify-dsh-superagent/evidence/overview/overview.png`. Both show the stand-in banner, `Superagent`, and `Release checklist`.

## Gotchas

- The seeded ticket was written by launch into SQLite. It does not prove that a GitHub mention became a ticket.
- `setupProbe` is `skipped`. An overview without a setup problem does not mean the agent CLI, push access, or worker git config passed.
- **Open main Session** is disabled. Clicking it is not a session-navigation proof.
- The DSH sidebar and the host locale are not this page. A Chinese Desktop session labels the tab `概览`.
