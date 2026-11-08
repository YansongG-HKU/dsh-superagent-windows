# Startup recovery hardening

Issue: https://github.com/YansongG-HKU/dsh-superagent-windows/issues/3

Runtime.create acquires a proper-lockfile lease asynchronously before registering services or opening SQLite. Contention waits up to 35 seconds, can be cancelled by plugin teardown, logs its waiting state, and never steals a live lease. The 30-second stale threshold and heartbeat remain in force. Constructor failures release the lease before callers retry.

Five dedicated tests cover delayed owner release, active-owner deadline, cancellation and abandoned stale locks. Existing runtime fixtures exercise the asynchronous factory. The passive transcript adapter retains a typed bridge for the locally installed older declaration package.

Validation: typecheck and build passed; full suite 1196 passed, 33 skipped (62 passing files, one skipped file).

The fifth lock test starts a real child process, waits until it owns the lease, terminates it abnormally, and verifies recovery after the unchanged 30-second stale threshold (31.67 seconds for the lock test file locally). It uses an isolated temporary directory and never kills the desktop or touches user SQLite state. The final full suite, typecheck and build all pass.

后续性能复查与测量见 [PERFORMANCE-20261108.md](PERFORMANCE-20261108.md)。
