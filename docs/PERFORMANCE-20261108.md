# Subscription-index performance review

Issue: https://github.com/YansongG-HKU/dsh-superagent-windows/issues/5

snapshot().threadsOf previously used [...bucket, thread] for every subscription: N shared-ticket edges copied O(N²) elements. Request-local buckets now append in place, retaining input order, duplicate subscriptions, lazy loading and one subscribedThreads read per view. No cross-request cache is added.

Windows / Node 24.14.1, five trials of 10000 threads with two identical subscriptions each: baseline e20c13d median 1414.49ms, updated median 0.71ms. This is synthetic index construction only, not full API or desktop latency. tests/views.spec.ts verifies all 20000 entries, repeated reads and freshness in the next request. To reproduce the benchmark, set DSH_PERF_OUTPUT to a writable JSON path, then run pnpm exec vitest run tests/views.spec.ts -t "indexes 10000". Copy the test into the baseline checkout for comparison.

Full suite: 1197 passed, 33 skipped; typecheck/build pass. Existing SQLite, state lock, policy and polling behavior are unchanged. No new source or test file needs an architecture-table entry.
