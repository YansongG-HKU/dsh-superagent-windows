# Execution

Execution lists tickets by stage and can pause processing. The stand-in can show the seeded open tickets. Pausing is not proved until a DSH main Session is notified, which this stand-in does not do.

## Sub-features

- `execution-open` lists `Release checklist` and `Grocery list` under the Open filter.
- `execution-pending` lists only `Release checklist` under the Pending filter.
- `execution-pause` pauses processing and tells the main Session. The session half fails on the stand-in.

## How to get to it (user POV)

- Choose the `Execution` tab.
- Choose a stage filter: `Open`, `Pending`, `Working`, `Waiting for a Trigger`, or `Ended`.
- Choose `Pause processing`, then `Confirm`.

## Driving it with verify-dsh-superagent

Preconditions:

- `verify.mjs doctor` reports `"ok": true`.
- `Release checklist` is awaiting an answer and `Grocery list` is working.
- No DSH session catalog is available. `doctor` reports `sessionCatalog` `absent`.

- **Open the tab.** Choose `Execution`. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role tab --name "Execution"`. The tab is selected and the status text is `Executor running`.
- **Open filter.** The `Open` filter is selected by default. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser text`. It contains `Release checklist` and `Grocery list`.
- **Pending filter.** Choose `Pending`. Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser click --role button --name "Pending"`. The page contains `Release checklist` and does not contain `Grocery list`.
- **Pause.** Stop this sub-feature and report the unmet precondition. `doctor` has `sessionCatalog` `absent`, so a Session notice cannot be observed. The stand-in `POST executor/pause` returns `sessionNotified: false` and does not stop a Source poll, because the stand-in never polls. Do not treat a `Processing paused` label as a pass.
- **Proof of the list.** Run `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET tickets --query state=open` and `.cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser screenshot --path .cursor/skills/verify-dsh-superagent/evidence/execution/open.png`. The JSON `items` include both titles. The shot is the open list, not a pause proof.

## Gotchas

- `Pending` is the person stage. `Open` includes every ticket that has not ended.
- Pause confirmation is a dialog. The confirm button is `Confirm`. Cancelling with `Cancel` must leave `paused` false. The stand-in still cannot prove the Session notice after a confirm.
- On a real `dsh` service, pause is proved only when the panel shows `Processing paused` and the main Session receives the pause notice. The stand-in has no Session.
- Ticket rows compute a `sessionId` such as `worker-ticket-release`. **Open Session** on a row is not proof that a worker session exists.
