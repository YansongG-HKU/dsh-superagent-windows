# Startup recovery hardening

Issue: https://github.com/YansongG-HKU/dsh-superagent-windows/issues/3

Runtime.create acquires a proper-lockfile lease asynchronously before registering services or opening SQLite. Contention waits up to 35 seconds, can be cancelled by plugin teardown, logs its waiting state, and never steals a live lease. The 30-second stale threshold and heartbeat remain in force. Constructor failures release the lease before callers retry.

Four dedicated tests cover delayed owner release, active-owner deadline, cancellation and abandoned stale locks. Existing runtime fixtures exercise the asynchronous factory. The passive transcript adapter retains a typed bridge for the locally installed older declaration package.

Validation: typecheck and build passed; full suite 1195 passed, 33 skipped (62 passing files, one skipped file).
