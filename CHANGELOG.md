# Changelog

All notable changes to `dsh-superagent` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.3.3] — 2026-11-12

### Added

- **Cluster model route.** `tools/cluster.mjs` renders each instance profile's DSH default model from the cluster config: an instance, or the cluster's `defaults`, may carry a `model` object with `provider`, `model`, optional `reasoningEffort`, and — to declare a custom `llm-pi-ai` provider — `baseURL`, `api`, `headers`, `apiKeyEnv`, `contextWindow`, `reasoningEfforts` and `compat`. A self-deployed OpenAI-compatible endpoint can therefore serve a whole cluster, while a cluster file without a `model` object keeps rendering the previous DeepSeek Desktop account route (`deepseek-account` / `deepseek-flash` / `reasoningEffort: max`). `setup`, `doctor` and `list` print each instance's route; the field rules and an example are in `tools/README.md`.
- `tools/profile-template.yml` gained the model placeholders and the rendered `llm-pi-ai` providers block; a custom route keeps the OpenCode Go fallback declaration.

### Changed

- A configured Eval or Executor role model that no longer resolves no longer fails plugin startup. The affected Sessions fall back to the profile's default model, and the `models` health entry (plus a warning log) names the setting to repair; an unset role model still inherits the default, and settings saves still validate a model before storing it.
- `docs/006-deployment.md` documents the cluster model route and the `models` health entry's fallback; `docs/007-architecture.md`, `SETUP.md`, `WINDOWS.md`/`WINDOWS.zh.md` and `tools/README.md` are updated to match.

### Verified

- `vitest`: 1214 passed, 33 skipped (63 test files pass, `tests/service-script.spec.ts` is skipped on this platform), including 9 new tests: the cluster model route's rendering and validation, the shipped profile template's rendered route, and the role-model startup fallback.

## [0.3.2] — 2026-11-06

### Fixed

- **DSH 0.2.2 compatibility.** `SessionController.inspect()` was removed upstream; the transcript resource route now reads a passive event page through `sessionController.events({address, maxMessages})` and maps `records[].event`.

### Changed

- `peerDependencies`: dropped the removed `@deepseek-ai/dsh-client-ui-slots` package, moved `@deepseek-ai/cordis` to `~4.1.0`, `@deepseek-ai/schemastery` to `3.19.0` and every `@deepseek-ai/dsh-*` peer to `^0.2.2-rc.1`.
- `engines.dsh` is now `>=0.2.2-rc.1`.

### Verified

- `vitest`: 1188 passed, 2 known Windows-only environment-restore failures (they fail on the untouched baseline too).
