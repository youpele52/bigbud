# Connection Resilience Under Multi-Thread Load

**Date:** 5 November, 2026
**Status:** Implemented (phases 0–3, including row-format baselines); phase 4 awaits live re-measurement; phase 5 awaits a decision
**Owner:** bigbud desktop/server

## Summary

Running several agent threads for a while made the desktop app show dropped connections and frozen threads. Meanwhile the agents kept working on the server, and only an app restart brought the UI back. Four defects combine to cause this. This plan fixes the three that are proven with reproducible tests, and adds a log-based report so each fix is judged on measured numbers:

1. The web client could silently lose its live subscriptions after a ping timeout.
2. Projection baseline checks loaded a 154 MB JSON row, which crashed the backend.
3. The skills/agents discovery scanner rescanned on every write under `~/.pi`.

The fourth defect, event-loop stalls under load, is re-measured after these fixes rather than guessed at. Database growth needs a product decision, recorded below.

## Related Work

- Bigbud note / Kanban card: none identified. The work came from a direct debugging conversation on 5 November, 2026. Linking a card is an open question.
- Earlier plans this builds on: `docs/plans/2026-10-21-connection-resilience-plan.md` (SQLite worker, reconnect design).

## Problem

Evidence comes from the packaged macOS app (0.3.2) on 5 November, 2026:

- `~/Library/Application Support/bigbud/logs/server-child.log*`
- `~/.bigbud/userdata/logs/server.trace.ndjson*`
- `~/Library/Logs/DiagnosticReports/bigbud-2026-11-05-*.ips`

The baseline numbers below come from `bun run scripts/connection-health-report.ts`, run over all retained logs:

| Metric                                    | Baseline |
| ----------------------------------------- | -------- |
| Heap out-of-memory aborts                 | 8        |
| Event-loop stalls over 5 s                | 367      |
| Longest stall                             | 29.6 s   |
| Peak discovery scans per 10 min           | 959      |
| SQL spans over 10 s                       | 608      |
| Reconnects without a new delivery session | 11 of 17 |

### Defect 1: frozen UI after a ping timeout (observed)

The Effect RPC client sends a Ping every 5 s and fails the socket when the next tick finds no Pong. The failure was built as `SocketOpenError { kind: "Timeout" }`. Because the web protocol sets `retryTransientErrors: true` (`apps/web/src/rpc/protocol.ts`), the client treated it as an "open failed" error. It swallowed the error, opened a new socket, and never failed the requests that were in flight (`node_modules/effect/src/unstable/rpc/RpcClient.ts`, `makeProtocolSocket` `tapCause`).

The orchestration domain-event subscription therefore waited forever on a dead request. `WsTransport` only saw the link go down and up, so it never resubscribed. The trace shows this at 16:19 UTC and 17:00/17:24 UTC: the socket reopened with close code 1000, but no new `orchestration.delivery.session` started for that consumer until the user restarted the app. Server crashes (close code 1006) took the normal `ClientProtocolError` path and did resubscribe.

### Defect 2: out-of-memory crashes from projection baselines (observed)

The verified projection baseline is one `payload_json` row. On this machine it is 154 MB.

- `ProjectionBaselineRepository.latestVerified()` reads that row. Its validation then sha256-hashes the payload and `JSON.parse`s it.
- The baseline coordinator called `latestVerified()` two to three times per flight just to compare sequence numbers (`ProjectionPipeline.baseline.coordination.ts`).
- `DirectResourceCleanupRecovery` asks for coverage every 5 s while a pruning candidate is pending (`apps/server/src/deletion/Layers/DirectResourceCleanupRecovery.ts`).

The crash stacks match this:

- 18:24 crash: the SQLite worker thread died in `StatementSync::All → String::NewFromUtf8` at a 309 MB heap. That is the 154 MB row decoded as a two-byte string.
- 17:08 and 18:42 crashes: the main thread died in `MessagePort::OnMessage → ValueDeserializer::ReadValue` while receiving worker results.
- The log shows "canonical cleanup baseline coverage deferred" every 5 s up to the 18:42 crash.

Separately, capture ran `SELECT *` over every projection table, including all messages, in one statement and one worker message.

### Defect 3: discovery rescan storms (observed and measured)

The packaged server runs with `cwd` set to the home directory. For a descriptor path that does not exist, `resolveExistingWatchPath` watched its parent recursively. A probe that reuses the server's descriptor builder reproduces exactly the 21 roots the server logs. Five are parent fallbacks, including all of `~/.pi` (because `~/.pi/skills` is missing) and `~/.copilot`.

Pi appends to `~/.pi/agent/sessions/**` continuously while a thread runs. Today's log windows:

| Today's log windows                      | Mean scans per 10 min |
| ---------------------------------------- | --------------------- |
| No Pi activity (44 windows)              | 68                    |
| Over 100 Pi session entries (17 windows) | 412                   |

The peak was 753 per 10 min. Each scan walks 51 roots, reads 528 files with unbounded concurrency, and triggers run concurrently with no coalescing. Provider status changes also forced a full disk rescan, although they only change native catalog entries.

### Defect 4: event-loop stalls (observed, not yet attributed)

Stall reports name SQL calls on the single SQLite connection, baseline work, discovery scans and provider probes. Defects 2 and 3 are two of those named sources. The rest is structural:

- one connection behind one lock;
- about 13 reactors re-reading every event;
- whole-message rewrites per streamed delta.

### Defect 5: database growth (observed)

- `state.sqlite` is 8.2 GB with a 160 MB WAL and 4.05 million events.
- `compact_through_sequence` is 5,216,344, but `retained_through_sequence` is 12,500. About 4 million events are covered by a verified baseline but are only compacted after purges.
- Nothing runs `VACUUM`.

## Goals

- A ping timeout always leads to every live subscription being requested again on the replacement socket.
- Baseline coverage checks never load, hash or parse a baseline payload.
- No baseline operation (capture, verification, restore, migration) holds a whole baseline in memory.
- Writes under a provider folder that only contains a missing discovery root cause no rescans.
- Discovery triggers are coalesced, and provider status changes do not touch the disk.
- One command reports the health numbers from the user's own logs.

## Non-Goals

- Moving connection management to Rust. Every defect above lives upstream of the socket, and a Rust transport would not touch them.
- Changing the default thread retention policy. That deletes user threads and needs an explicit decision.
- Restructuring reactors, projectors or the single SQLite connection (defect 4) before re-measuring.

## Current State

- Web transport: `apps/web/src/rpc/wsTransport.ts` (subscribe loop, session lifecycle) and `apps/web/src/rpc/protocol.ts` (`retryTransientErrors: true`).
- RPC client: Effect `4.0.0-beta.43`, patched through `patches/effect@4.0.0-beta.43.patch`.
- Baselines:
  - `apps/server/src/persistence/Layers/ProjectionBaselines.ts`: repository; also carries uncommitted organisation-age work from another thread.
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.baseline.coordination.ts`: single-flight coordinator with a 15-minute failure cooldown.
  - `apps/server/src/orchestration/Layers/ProjectionPipeline.baseline.ts`: verification.
- Discovery: `apps/server/src/provider/Layers/DiscoveryRegistry.ts` with `DiscoveryRegistry.watch.ts`.

## Phases

### Phase 0: measurement (done)

- Added `scripts/connection-health-report.lib.ts` (pure analysis) and `scripts/connection-health-report.ts` (CLI).
- The CLI reads `server-child.log*` and `server.trace.ndjson*`. `--current` limits it to the newest files.
- It reports:
  - out-of-memory aborts, counted as distinct process ids;
  - stalls over 1 s and 5 s, and the longest stall;
  - discovery scans and the peak per 10 minutes;
  - traced stalls and SQL spans over 10 s;
  - reconnects with no delivery session within 30 s.
- The server-child log clock has no date. A clock that jumps back by more than an hour starts a new day, so same-time windows on different days are never added together. An earlier version summed them and reported a peak of 2,501 instead of 959.
- Limitation: delivery sessions still open when the trace ends are not yet written, so the newest reconnects can read as orphaned.

### Phase 1: resubscribe after a ping timeout (done)

- Patched the pinger failure in both `dist/unstable/rpc/RpcClient.js` and `src/unstable/rpc/RpcClient.ts` to `SocketReadError({ cause: "ping timeout" })`.
  - A missed Pong means the open socket is dead, so it now takes the same `ClientProtocolError` path as a server-side close.
  - In-flight requests fail and `WsTransport` resubscribes.
  - Socket open failures and open timeouts are still retried silently.
- Regenerated `patches/effect@4.0.0-beta.43.patch` with `bun patch`, removed a stray empty `.bun-tag` hunk, and verified the patch applies to a pristine `npm pack` of the package.
- Added `SocketReadError` to `apps/web/src/rpc/transportError.ts` so recovery retries treat the new failure as a transport error rather than surfacing it on a thread.
- A transport-level "connected but no delivery session" watchdog was rejected. The root cause is fixed and covered by a reproduction test, and a second recovery owner would compete with the existing reconnect logic.

### Phase 2: stop repeated baseline payload loads (done)

- Added `latestVerifiedSequence()` to `ProjectionBaselineRepository`. It runs a single-column query (`ProjectionBaselines.queries.ts`).
- The coordinator now depends only on `Pick<…, "latestVerifiedSequence">`, so the type system prevents it from loading payloads again.
- `verify` compares sequences before it loads the full previous baseline it needs as a verification source.
- Each baseline id is still checked once per process before its sequence counts as coverage. The check requires format 2 and a 64-character hash, inside SQLite, so no payload enters the JavaScript heap. The full sha256 is checked against the stored rows on every restore, including the verification source.
- Capture reads each projection table through `forEachBaselineTablePage`:
  - 1,000-row rowid pages inside one transaction per table, so each table is the same consistent snapshot as before;
  - continuation pages use `WHERE rowid > ?` alone. A first version used `? IS NULL OR rowid > ?`, which SQLite cannot answer from the rowid index, so every page rescanned the table (8.2 s against 0.2 s on 300,000 rows). A test asserts the query plan uses `SEARCH … (rowid>?)`;
  - tables declared `WITHOUT ROWID` (only `projection_usage_codex_retired_turns`) are read in one statement.
- The 5 s cleanup loop was left unchanged. With sequence-only checks a covered request costs one indexed query, and failed verification is already throttled by the 15-minute cooldown.
- **Row-format baselines (format 2).** Paging alone did not bound total memory: a capture still built, sorted and hashed the whole ~154 MB payload, and verification held the candidate string, the source string and its parsed copy, and the replay capture at once. Baselines are now stored one row per projection row:
  - `projection_baseline_rows (baseline_id, table_name, ordinal, row_json)`, added by migration 152 (`152_ProjectionBaselineRows.ts`). `ProjectionBaseline` no longer carries a payload; the shared row logic lives in `apps/server/src/persistence/ProjectionBaselineRows.ts`.
  - **Hash.** An incremental sha256 over the canonical document `{"tables":{"<table>":[<row>,…],…}}`, which is byte-identical to the format 1 string. Rebuilt from your real baseline's rows it reproduces the stored hash `308fec80…` exactly.
  - **Capture** (`ProjectionBaselines.capture.ts`) streams projection pages into a temp table. SQLite assigns ordinals sorted by row text in one statement (spilling to disk when needed), so the result does not depend on insertion order. The hash is then read back page by page.
  - **Restore** (`ProjectionBaselines.restoreRows.ts`) makes two streaming passes in one transaction. Pass 1 hashes every row, validates thread ownership and records primary keys in a temp table (duplicates are detected there). A hash mismatch, malformed row or duplicate key fails before anything is deleted. Pass 2 deletes rows missing from the baseline and upserts the rest.
  - **Verification** copies the source rows into the scratch workspace page by page before restoring, then compares only hashes (`captureDigest`). The copy has to happen before the workspace transaction: Effect's SQL transaction connection is not scoped per client, so live-database reads issued inside a workspace transaction silently ran against the workspace. The workspace tests caught this.
  - **Migration 152** keeps only verified legacy baselines. It checks each against its recorded hash in 8 MB byte chunks, converts it inside SQLite with `json_each`, and re-hashes from the stored rows. A legacy payload that fails its own hash is dropped; today's coverage check already rejects such a payload. On a copy of your real baseline the migration took 2.6 s, used 36 MB of main-thread heap, kept the hash and produced 250,942 rows.
  - **Measured on a 161 MB synthetic baseline:** capture used +31 MB of heap, the workspace digest +63 MB, and the old whole-string-plus-parse shape +804 MB. With the same heap limit (403 MB effective), the new capture, restore and digest completed, and the old shape aborted with "JavaScript heap out of memory".
  - Coverage integrity now requires format 2 and a well-formed hash. The full hash is checked whenever rows are restored.
- An explicit worker or backend heap limit was rejected. A lower limit would turn today's large allocations into earlier crashes. The worker bridge has no automatic restart, so a worker heap failure would also fail every later query.

### Phase 3: stop discovery rescan storms (done)

- `DiscoveryRegistry.watch.ts` now resolves a `DiscoveryWatchTarget` per descriptor:
  - An existing path is watched recursively, as before.
  - A missing path with an existing parent watches the parent **non-recursively** and reacts only when the missing path appears. After that it watches the new path recursively.
  - Watch loops that end or fail re-arm after 30 s instead of stopping for good.
  - Every target records its parent, so a watched folder that is deleted falls back to waiting for it to return instead of logging failures every 30 s.
  - While waiting, existence is re-checked every 30 s as well as on parent events. This covers a folder created just before the parent watch started.
  - A parent watch that ends without the folder appearing (parent removed) waits instead of triggering a rescan.
- `DiscoveryRegistry.sync.ts` adds a coalescing scheduler. One fiber runs syncs. Requests made meanwhile merge into one follow-up of the strongest kind (`rescan` beats `assemble`). There is a 1 s minimum gap. A failed sync is logged and does not stop the fiber.
- The catalog load is split into a disk scan and an assembly step, and the last scan is cached:
  - provider status changes request `assemble`, which only rebuilds native entries from the cached scan;
  - watchers, settings changes and the 2-minute timer request `rescan`;
  - the explicit `refresh()` API still rescans immediately;
  - background syncs and `refresh()` share one lock, so an `assemble` built from an older scan cannot finish after a newer rescan and overwrite it.
- Directory walks are capped at 8 in parallel and file reads at 16, instead of unbounded.
- A live watch that ends is re-armed after 30 s, and nothing is watched in between. The re-arm now requests one catch-up rescan, so changes made in that gap are no longer missed until the 2-minute timer. A watch that fails sooner than the retry delay gets no catch-up, so a path whose watch keeps failing cannot cause a rescan every 30 s.

### Phase 4: re-measure stalls (pending, needs the packaged build)

1. Build and install the app with phases 1–3.
2. Restart it, run four streaming threads (including one Pi thread) for two hours, then run `bun run scripts/connection-health-report.ts --current`.
3. Exit criteria:
   - zero out-of-memory aborts;
   - zero reconnects without a delivery session;
   - zero stalls over 5 s;
   - peak discovery scans under 30 per 10 minutes;
   - backend heap during at least one baseline verification or compaction, measured from the trace or the app's resource monitor. It should stay within the normal working set plus tens of megabytes, not the payload size.
   - the first start after upgrading logs no "dropping corrupt legacy projection baseline" warning, and `projection_baselines` shows `format_version = 2`.
4. If stalls over 5 s remain, attribute them from `stall.spans` before choosing between client pong tolerance and reactor/projector work.

### Phase 5: database growth (decision gate)

> Superseded by `docs/plans/2026-11-06-bounded-database-growth-and-loading-plan.md`, which found that automatic compaction has had no caller since 19 August, 2026, and that retention is blocked by stale runtime rows.

- **Not implemented.** Changing the thread retention default deletes threads, so it needs the user's decision.
- Safe manual procedure, with the app fully quit:
  1. Back up `~/.bigbud/userdata/state.sqlite*`.
  2. Run the existing dry run, `bun run --cwd apps/server src/bin.ts canonical-event-compaction`.
  3. Apply with `--apply --server-stopped --passes <n>`.
  4. Run `sqlite3 ~/.bigbud/userdata/state.sqlite 'VACUUM;'`.
- Automatic background compaction of the verified prefix is a candidate follow-up. It is gated on this decision because it rewrites persisted history automatically.

## Risks And Decision Gates

- **Effect patch.** The library change is two lines in a vendored patch, and a library upgrade must carry it forward. `wsTransport.pingTimeout.test.ts` fails if the behaviour regresses.
- **Ping-timeout failures now surface.** Requests that used to hang after a ping timeout now fail with `SocketReadError`. Recovery paths classify it as a transport error through `transportError.ts`. Unary callers without retry see an error where they previously waited forever.
- **Discovery latency.**
  - Watcher changes now apply up to about 1 s later because of the minimum gap.
  - A newly created discovery folder is still detected immediately.
  - If an existing watched folder is deleted and recreated, the watch re-arms after up to 30 s. The 2-minute rescan also covers it.
- **Baseline format change.** Migration 152 rewrites the stored baseline once, on the first start after upgrading (about 2.6 s on this machine). Its number follows 145–151, which another thread has not committed yet; commit order must keep them in sequence. A downgrade after 152 cannot read format 2 baselines; a downgraded build would find no usable verified baseline until it creates a new one.
- **Hash meaning is unchanged.** The canonical document equals the format 1 string, which a migration test asserts across an 8 MB chunk boundary with multi-byte characters.
- **Shared files.** `ProjectionBaselines.ts`, `.payload.ts`, `ProjectionBaselineSchema.ts` and `Migrations.ts` carry another thread's uncommitted changes (organisation-age normalisation, the pending-classification guard, the age-backfill reset on restore, migrations 145–151). The row-format rewrite keeps all of them. Commits must stage these hunks separately.

## Testing And Validation

New reproducible tests:

| Test                                                                                | What it proves                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/rpc/wsTransport.pingTimeout.test.ts`                                  | Drives the real Effect RPC client over a mock socket that never answers Ping, and asserts the subscription is requested again on the replacement socket. It failed before the patch and passes after. A control case (server close 1006) passes both before and after, so the test can tell the difference.                                                                                 |
| `apps/web/src/rpc/transportError.test.ts`                                           | Read, open and close socket errors are transport errors; provider errors stay visible.                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.baseline.coverage.test.ts` | 20 coverage checks use only the sequence query and never a payload. Compaction runs once when coverage is behind.                                                                                                                                                                                                                                                                           |
| `apps/server/src/persistence/Migrations/152_ProjectionBaselineRows.test.ts`         | A verified legacy baseline larger than one 8 MB hash chunk, with multi-byte text, converts with its hash unchanged. Candidates and a hash-corrupt baseline are dropped. A legacy payload without the Codex tables gets a recomputed hash. The converted rows restore. The migration runs once only.                                                                                         |
| `apps/server/src/persistence/Layers/ProjectionBaselines.rows.test.ts`               | The same state inserted in a different order hashes identically, and the hash equals sha256 of the materialised document and the workspace digest. A 1,203-row restore never reads more than 500 rows per page. A tampered baseline fails on its hash with no projection row changed (the test fails if the hash check is removed). Superseded and rejected baselines leave no stored rows. |
| `apps/server/src/persistence/Layers/ProjectionBaselines.queries.test.ts`            | Paged reads equal a single full read, with rowid gaps, empty tables and exact page boundaries. `WITHOUT ROWID` tables are handled. Continuation pages seek the rowid index (query plan). The sequence query ignores candidates, and a corrupt verified payload fails coverage.                                                                                                              |
| `apps/server/src/provider/Layers/DiscoveryRegistry.sync.test.ts`                    | 200 requests during a running sync collapse into one follow-up, kinds merge to `rescan`, and a crashing sync does not stop the scheduler.                                                                                                                                                                                                                                                   |
| `apps/server/src/provider/Layers/DiscoveryRegistry.watchTarget.test.ts`             | Real file system. 40 writes to `.pi/agent/sessions` cause zero notifications. Creating `.pi/skills` causes one, and a later write inside it causes another. Removing the watched parent causes none. A live watch that ends triggers a catch-up on re-arm (the test fails if the catch-up is removed), and a watch that keeps failing immediately triggers none.                            |
| `apps/server/src/provider/Layers/DiscoveryRegistry.watch.test.ts` (updated)         | Target resolution for direct, parent-only and unreachable paths.                                                                                                                                                                                                                                                                                                                            |
| `scripts/connection-health-report.test.ts`                                          | Metrics parsing on real log line shapes, including windows on different days.                                                                                                                                                                                                                                                                                                               |

The existing suites for baselines (8 files) and discovery (10 files) were rerun. The validation commands and results are recorded in the implementation summary.

## Acceptance Criteria

- The ping-timeout reproduction test passes, and the control still passes.
- Coordinator coverage checks perform no payload reads (asserted by test).
- Baseline capture, restore, verification and migration never hold a whole baseline in memory (bounded pages asserted by test; heap measured at 161 MB scale).
- The baseline hash keeps its meaning across the format change (asserted by test, and checked against the real baseline).
- Writes under a parent of a missing discovery root cause no rescans (asserted on the real file system).
- Focused format, lint, typecheck and tests pass for the changed packages.
- Phase 4 numbers meet the exit criteria on the packaged build. This is pending.

## Open Questions

- Should thread retention default to something other than `never`, or should verified-prefix event compaction run automatically in the background?
- Should a bigbud Kanban card track phase 4 re-measurement?
