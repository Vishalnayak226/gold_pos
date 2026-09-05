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

The default sample sizes match the initial audit baseline: serial health (250),
static HTML (100), static module (100), and 25-way concurrent health (500).
`--quick` is a short smoke baseline for development; it is not comparable to a
full run.

## Interpreting the result

This tool deliberately makes a narrow claim: **warm loopback performance for
an isolated empty tenant.** It does not certify checkout commit time, a large
merchant ledger, browser rendering, scanner/scale/printer hardware, a low-end
counter, network latency or VPS capacity. Do not turn a laptop result into a
merchant promise.

Keep JSON evidence with the Node version, machine and Git revision for each
target environment. The next work item is a seeded, authenticated workload
(lookup, page, sale/return/void and mixed concurrency), followed by the
supported-device browser trace and an eight-hour soak. Those measurements—not
assumptions—will set release budgets.
