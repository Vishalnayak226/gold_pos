# Performance benchmark

Run a repeatable clean-instance baseline with no new runtime dependency:

```powershell
npm --prefix backend run benchmark
npm --prefix backend run benchmark:quick
npm --prefix backend run benchmark -- --output .\evidence\baseline.json
```

`backend/benchmark.js` starts the real Express server on an ephemeral loopback
port, with a new temporary licensed tenant and temporary logs. It warms the
server, reads complete HTTP responses, reports p50/p95/p99 latency and
throughput as JSON, then shuts down and deletes only its own temporary
directory. It never imports the datastore into the benchmark process and never
uses `backend/data`.

Two phases run in one invocation:

1. **Unauthenticated, empty-tenant baseline** — serial health (250), static
   HTML (100), static module (100), and 25-way concurrent health (500). These
   run *before* anything seeds the tenant, so they stay exactly what they always
   measured: the server and static assets alone, with nothing in the ledger.
2. **Authenticated workload against a seeded merchant dataset** — the harness
   signs in as the tenant's owner (the same `/api/admin/login` + session-cookie
   + CSRF-header path a browser uses), files real invoices through
   `POST /api/sales` to build a small ledger (40 customers × 5 invoices in a
   full run, 10 × 2 in `--quick`), then measures: a serial checkout, a
   5-till concurrent checkout, an authenticated lookup
   (`GET /api/sales/lookup`) and a paged-ledger read (`GET /api/sales?limit=`)
   — all against that populated tenant, not an empty one. The report's `seed`
   field records exactly how many customers/invoices were filed and how long
   seeding took, unmeasured, before the timed scenarios began. The child
   process's blanket API rate limit is raised for the run (`API_RATE_MAX`) —
   the harness is measuring throughput, not the abuse-prevention throttle,
   which has its own tests.

`--quick` is a short smoke baseline for development; it is not comparable to a
full run.

## Interpreting the result

This tool deliberately makes a narrow claim: **warm loopback performance for
one isolated tenant, on a small seeded ledger, over a handful of authenticated
scenarios.** It does not certify a large merchant ledger's steady-state
performance, return/void/mixed-concurrency workloads, browser rendering,
scanner/scale/printer hardware, a low-end counter, real network latency or VPS
capacity. Do not turn a laptop result into a merchant promise.

Keep JSON evidence with the Node version, machine and Git revision for each
target environment. The next work item is extending the seeded workload to
return/void and mixed concurrency (several tills billing, returning and
voiding at once), followed by the supported-device browser trace and an
eight-hour soak. Those measurements—not assumptions—will set release budgets.
