# Performance benchmark

Two repeatable, dependency-free CLI tools produce this project's performance
evidence: `benchmark.js` measures the server's own HTTP throughput, and
`perfTrace.js` measures what a cashier waits on inside the browser tab.
Neither adds a runtime dependency — `perfTrace.js` drives a real Chromium tab
via `@playwright/test`, the one devDependency CLAUDE.md §0 already exempts
from the budget for exactly this kind of tooling.

```powershell
npm --prefix backend run benchmark
npm --prefix backend run benchmark:quick
npm --prefix backend run benchmark -- --output .\evidence\baseline.json

npm --prefix backend run perf-trace
npm --prefix backend run perf-trace -- --minutes 480 --output .\evidence\perf-trace.json
```

## `benchmark.js` — server-side HTTP throughput

Starts the real Express server on an ephemeral loopback port, with a new
temporary licensed tenant and temporary logs. It warms the server, reads
complete HTTP responses, reports p50/p95/p99 latency and throughput as JSON,
then shuts down and deletes only its own temporary directory. It never
imports the datastore into its own process and never touches `backend/data`.

Three phases run in one invocation:

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
   seeding took, unmeasured, before the timed scenarios began.
3. **Return/void/stock/payment workloads, serial and mixed-till** — a serial
   cash return, a serial same-day void, a serial stock-lot physical-count
   adjustment and a serial advance/counter deposit, each against its own
   disposable invoice or lot so one sample never interferes with the next;
   plus `mixedTill`, several concurrent "tills" each running a
   sale→sale→return→void→advance-deposit cycle against the same ledger at
   once — the scenario the single-endpoint measurements above cannot show,
   since it contends several different write paths for the same SQLite
   writer lock simultaneously. Per-operation-kind latency is broken out in
   `mixedTill.breakdown` so a regression in, say, void specifically stays
   visible rather than averaged into the others.

The child process's blanket API rate limit is raised for the run
(`API_RATE_MAX`) in every phase — the harness is measuring throughput, not
the abuse-prevention throttle, which has its own tests.

`--quick` is a short smoke baseline for development; it is not comparable to a
full run.

**2026-09-24 full-run evidence (Node 26, Windows dev laptop, loopback):**
return p95 26.16 ms (55.7/s), void p95 28.05 ms (58.8/s), stock-adjust p95
23.25 ms (64.4/s), advance-deposit p95 31.62 ms (45.2/s); mixed-till (5 tills
× 5 cycles, 125 ops) sustained 69.4 ops/s with per-kind p95 of 144.9 ms
(sale), 113.9 ms (return), 91.4 ms (void), 89.7 ms (advance deposit) — higher
than the single-endpoint figures because five tills are genuinely contending
for one write lock at once, which is the point of the scenario.

## `perfTrace.js` — browser-side counter responsiveness

Boots the same kind of ephemeral tenant, then drives a real headless
Chromium tab through repeated shift-like cycles: switch through four admin
screens and back to Billing (tab-transition cost), scan a barcode (a real
round trip to the lookup endpoint), then hand-correct a weight (pure
client-side recalculation and invoice-preview re-render). Each step times
itself independently. `--minutes` controls how long the cycle repeats
(default: a short smoke run); a real soak is `--minutes 480`, run
deliberately since it holds a browser and server process open the whole
time. A once-per-cycle Chromium JS-heap sample (`heapTrace`) is a same-tab
memory-growth proxy, not a full memory/open-handle profiler.

**2026-09-24 smoke evidence (19 cycles, ~18s, Node 26/Chromium 151, Windows
dev laptop):** keyboard-to-recalculation p95 8.45 ms, invoice-preview
re-render p95 16.31 ms (both pure client-side, no server round trip),
barcode-scan round trip p95 53.38 ms, tab transitions p95 117–196 ms
depending on target screen. Heap grew ~777 KB over 19 cycles — not
diagnostic of a leak on its own; only a real multi-hour run can tell genuine
growth from GC timing noise.

## Interpreting the result

Both tools deliberately make a narrow claim: **warm loopback performance for
one isolated tenant, on a small seeded ledger, on this dev laptop, over a
fixed set of scenarios.** Neither certifies a large, production-scale
merchant ledger's steady-state performance, real scanner/scale/printer
hardware, a real low-end counter, real network latency, disk pressure, VPS
capacity, or a genuine eight-hour shift — that last one specifically needs
`perf-trace -- --minutes 480` run deliberately on the actual target
hardware, not the short smoke window either tool defaults to. Do not turn a
laptop result into a merchant promise.

Keep JSON evidence with the Node version, machine and Git revision for each
target environment. What's still open, in roughly the order it should be
tackled: explicit p50/p95/p99 budgets on the actual target VPS and supported
hardware profile (needs that hardware to exist first); a representative
production-scale seeded tenant (thousands, not tens, of invoices); slow
network/provider-delay and disk-pressure simulation; and the real,
multi-hour soak itself. Those measurements — not assumptions — will set
release budgets.
