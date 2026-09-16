# Mobile Recovery Correctness Evidence

**Date:** 10 September 2026  
**Scope:** Server and contracts ownership for the mobile recovery correctness plan  
**Status:** Reviewable implementation evidence; not a release or plan-completion declaration

This record captures the reproducible evidence used for the server recovery gates. The
untracked implementation plan remains the source plan. Client reconnect, fallback, and
status work is owned by the mobile-web implementer. The coordinated client review has now
accepted those gates; this record keeps their result only as integration evidence.

## Operating limits

The server applies these bounded limits at the recovery boundary:

| Boundary                      |                                     Limit | Failure behavior                        |
| ----------------------------- | ----------------------------------------: | --------------------------------------- |
| Recovery identity             |                            256 characters | Contract rejection                      |
| Replay page / batch           |                                500 events | `resync-required: overflow`             |
| Serialized frame              |                                   256 KiB | `resync-required: overflow`             |
| Validated replay page         |                                     1 MiB | `resync-required: overflow`             |
| One recovery attempt's replay | 10,000 events and 10 MiB serialized bytes | `resync-required: overflow`             |
| Live capture backlog          |   2,000 events and 4 MiB serialized bytes | Capture overflow; no `caught-up` marker |
| Initial recovery deadline     |                                15 seconds | `resync-required: timeout`              |

`Schema.isMaxLength` applies the identity bound to JavaScript `String.length`, which is
256 UTF-16 code units—not UTF-8 bytes or Unicode code points. The contract test covers a
valid 128-code-point astral-string identity (256 code units) and rejects the next one.

Capture overflow is observable before completion and is checked again in a separate
completion effect after replay frames have been consumed. This covers both an overflow
that occurs during a zero-event replay and an overflow handed off after the final replay
batch.

The initial deadline is a full-attempt watchdog: it starts with capture registration, closes
the capture independently if replay delivery stalls, and prevents a later consumer pull from
emitting `caught-up` after expiry. A valid completion atomically disarms that watchdog, so a
healthy live stream can remain open after the marker. A later live-gap repair starts its own
bounded deadline rather than reusing the expired initial deadline.

## Projection publication evidence

`ProjectionPipeline.publication.mobile.test.ts` uses the actual
`ProjectionSnapshotQuery` layer and an actual concurrent reader. The writer opens an
outer SQL transaction, appends an event, runs all projectors, and waits before commit.
The reader starts before release and advances `TestClock` by 20 ms; it remains unfinished
until the writer commits. It then reads sequence 2 and the newly projected project.

The same test verifies that a rollback leaves the event and projection rows at sequence 2
and that deleting one cursor is repaired by bootstrap. `ProjectionPipeline.bootstrap.test.ts`
also verifies that a fresh, verified empty event stream atomically receives all 11 required
zero cursors. Missing cursors on a retained event stream are not interpreted as zero; they
are repaired by replay/bootstrap.

The actual temporary publication harness additionally observed:

- normal append plus all projector updates blocking a concurrent baseline until outer
  commit;
- rollback restoring the event, projected rows, and cursors;
- a direct partial-projector failure producing mixed cursors that the baseline rejects;
- bootstrap repairing the retained-history partial state; and
- empty bootstrap producing 11 cursor rows.

This proves the normal nested-transaction path and the fail-closed barrier. It does not
prove every possible command-admission path or out-of-band mutation. `watchingThreads` is
ancillary point-in-time metadata updated outside the 11 event-projector cursors, so it is
not claimed as part of the exact cursor provenance invariant.

## SQL scale evidence

The reusable synthetic fixture contains 20 active nonselected threads. Each thread has
either 1,000 or 10,000 old messages and activities, while the returned mobile baseline is
held constant at 80 messages, 20 activities, and 20 latest turns.

The pre-fix SQL audit used 30 samples on Python SQLite 3.51.1 on an Apple M1 Max running
macOS 26.6.2. Its p95 latency grew as follows:

| Query        | 1,000 old rows/thread | 10,000 old rows/thread |   Approximate VM work |
| ------------ | --------------------: | ---------------------: | --------------------: |
| Messages     |             32.958 ms |             344.296 ms |  1.83M → 18.21M steps |
| Activities   |              8.105 ms |              67.013 ms | 0.522M → 5.202M steps |
| Latest turns |              0.051 ms |               0.096 ms |                stable |

The indexed, existing-index replacement preserves the oracle's deterministic tie ordering,
case-sensitive `startsWith` prefix semantics, overlap deduplication, and approval/user-input
activity selection. SQL-only parity remained true with identical row hashes. Approximate VM
work was about 6,000 message steps and 1,000 activity steps at both history sizes.

The actual migrated application harness (`Bun 1.3.14`, SQLite 3.51.0) returned identical
35,460-byte baselines with SHA-256
`78b8087c7f23d4dda6297640288bdd9a3582db9b14775bc23b3965068f7cfd5c`:

| Fixture                | First connection | Warm median | Warm p95 |
| ---------------------- | ---------------: | ----------: | -------: |
| 1,000 old rows/thread  |         8.975 ms |    2.566 ms | 6.043 ms |
| 10,000 old rows/thread |         8.585 ms |    2.677 ms | 6.966 ms |

These are synthetic warm measurements, not cold-disk guarantees. The larger application
run can include shared-host contention, and it is not a production workload certification.
The selected thread's full history is intentionally outside this bounded-baseline test.

## Phase 4.3 provisional operating gates

These are named-fixture acceptance gates supported by the measurements above, not
production SLOs. Their synthetic hardware and workload limitations are recorded below and
are not additional acceptance gates for this plan:

| Gate                          |                                              Provisional threshold | Observed evidence                                                                     | Status                 |
| ----------------------------- | -----------------------------------------------------------------: | ------------------------------------------------------------------------------------- | ---------------------- |
| Warm baseline p95             |                                                            ≤100 ms | 6.043 ms / 6.966 ms at 1k / 10k history                                               | Pass                   |
| Baseline history-growth ratio |                                         ≤2× from 1k to 10k history | 1.15× application p95; identical decoded output                                       | Pass                   |
| Capture/dispatch p95          |                               ≤10 ms and ≤2× nearby no-capture run | 3.256 ms byte-overflow; 3.436 ms stalled capture vs 3.621 ms no capture               | Pass                   |
| Replay/capture memory fixture | ≤2× matched-control high-water RSS and sampled heap (fixture-only) | RSS 1.355× / 1.308× / 1.368×; heap 1.162× / 1.084× / 1.132×; semantic assertions pass | Pass for named fixture |

The 256 KiB frame, 1 MiB page, 10 MiB total replay, 4 MiB capture, event-count, and
15-second deadline values are enforcement limits verified by focused tests. They are not
substitutes for measured memory evidence; the named fixture measurement below complements
those safety bounds rather than inferring memory behavior from serialized byte caps.

## Capture and dispatch evidence

The hub fixture measured the 4 MiB byte ceiling with 16 KiB payload events: overflow was
observed at event 254, while an oversized single event failed immediately. Releasing a
capture removes it from future dispatch. One-capture publish p95 was approximately
0.010 ms; four-capture publish p95 was approximately 0.032 ms.

The actual engine harness admitted 300 small project commands through the event store,
11 projectors, and delivery hub using synthetic in-memory SQLite. Publish/dispatch p95
was 3.621 ms with no capture, 3.436 ms with a stalled mobile capture, 3.338 ms after
capture removal, 3.160 ms at count overflow, and 3.256 ms at byte overflow. This is a
bounded-fixture operating signal, not a network, disk, or large-payload guarantee.

Memory values in the temporary harness are sampled `process.memoryUsage()` boundaries and
sampled maxima. The reported post-GC heap and observed/lifetime RSS values include the
whole test process; they are not allocator-level or high-frequency peak measurements.
They therefore support bounded-fixture comparison only and must not be read as a peak
mobile-session memory budget or a production RSS limit.

The underlying artifacts are retained outside the repository at
`/tmp/bigbud-mobile-scale-audit/`: `results.json`, `timing.json`, `after.json`,
`parity.json`, `application-1000.json`, `application-10000.json`, `capture.json`,
`engineCapture.json`, `publication.json`, `mobile-recovery-memory.json`, and
`vitest/fixed.test.ts`.

## Phase 4.3 isolated memory measurement

The reproducible benchmark command is:

```sh
bun run --cwd apps/server benchmark:mobile-recovery-memory
```

It forks one Bun worker per named scenario and writes the report to
`/tmp/bigbud-mobile-scale-audit/mobile-recovery-memory.json` (override with
`BIGBUD_MOBILE_MEMORY_OUTPUT`). Each worker uses the actual orchestration event store,
projectors, mobile recovery replay, and delivery capture over synthetic in-memory SQLite;
it never opens or mutates userdata. Before the stream is created, every worker pre-seeds a
canonical 1,001-event backlog after the project-create event. That makes sequence 1,002 the
fixed replay watermark and requires three 500-event replay pages.

Controls dispatch and drain the same matched live workload through the actual event store and
paginated replay reader, without a mobile capture. The normal recovery case uses the actual
mobile recovery stream, publishes and drains 300 small live events while the three-page
backlog is being consumed, and retains only counters, sequence summaries, and resync reasons;
it does not retain frame arrays. Count-overflow publishes 2,001 small events after the
`caught-up(1,002)` boundary while the consumer handoff is held. Byte-overflow publishes 300
16 KiB events under the same held handoff. The latter two exercise the count and 4 MiB
capture-byte overflow boundaries.

The parent bounds each worker to 120 seconds and kills a timed-out worker. Worker cleanup
stops the 1 ms sampler in `finally` and disposes the synthetic orchestration system, including
when a scenario fails.

The named fixture proposes a comparative memory gate of **at most 2× both the process
high-water RSS and the sampled maximum heapUsed of the matched no-capture control** for
capture-drain, count-overflow, and byte-overflow scenarios. This is a bounded fixture gate,
not a production SLO: each comparison uses a fresh process, the same pre-seeded backlog, and
the same dispatch count and payload size. The report's `observedPass` is true only when every
scenario has the expected completion/resync semantics and every ratio is finite, positive,
and at most 2×.

The 10 September 2026 run (generated at `2026-09-10T10:30:14.877Z`) used Bun 1.3.14 on
macOS arm64 with synthetic in-memory SQLite.
The controls drained the pre-seeded multi-page replay plus their matched live dispatches.
Recovery cases used the actual mobile recovery stream and engine-owned capture:

| Scenario       | Dispatch p95 | Sampled max heapUsed | Sampled max RSS | Process high-water RSS | Semantic result                                        |
| -------------- | -----------: | -------------------: | --------------: | ---------------------: | ------------------------------------------------------ |
| control-drain  |     3.529 ms |            112.0 MiB |       254.0 MiB |              254.0 MiB | 1,302 replay / 3 pages                                 |
| capture-drain  |     4.005 ms |            130.2 MiB |       344.2 MiB |              344.3 MiB | 1,002 replay + 300 live; `caught-up(1,002)`; no resync |
| control-count  |     3.545 ms |            115.8 MiB |       269.0 MiB |              269.0 MiB | 3,003 replay / 7 pages                                 |
| count-overflow |     3.972 ms |            125.6 MiB |       351.9 MiB |              351.9 MiB | 1,002 replay; `caught-up(1,002)` → `resync(overflow)`  |
| control-byte   |     3.794 ms |            112.0 MiB |       264.4 MiB |              265.0 MiB | 1,302 replay / 3 pages                                 |
| byte-overflow  |     3.776 ms |            126.8 MiB |       362.5 MiB |              362.6 MiB | 1,002 replay; `caught-up(1,002)` → `resync(overflow)`  |

The matched ratios were 1.355× / 1.162× (capture-drain/control-drain), 1.308× / 1.084×
(count-overflow/control-count), and 1.368× / 1.132× (byte-overflow/control-byte), reported as
process high-water RSS / sampled maximum heapUsed. All ratios were finite and positive, and
the semantic assertions passed, so the named 2× fixture comparison observed a pass. These
numbers are evidence for this bounded fixture, not a claim that overflow has a fixed memory
cost or that process RSS is deterministic.

The table renders the measured raw RSS values as MiB because, in this Bun/macOS run,
`process.resourceUsage().maxRSS` matched the byte magnitude of `process.memoryUsage().rss`.
The benchmark retains the raw value and runtime metadata so another platform can calibrate its
unit before comparison.

Memory fields must be read distinctly:

- `sampledMaxHeapUsed` and `sampledMaxRss` are maxima observed by a 1 ms interval sampler;
  they are sampled observations and can miss short-lived peaks. `afterGc` is one post-GC
  boundary sample, not a peak measurement.
- `processHighWaterRssRaw` is the runtime-reported process-lifetime high-water RSS from
  `process.resourceUsage().maxRSS`, not a sampled heap value and not an allocator trace. It is
  stronger than the 1 ms RSS samples for this process, but it still does not identify which
  allocation caused the high-water value or provide a mobile-session budget. Its raw unit is
  retained because runtimes/platforms can differ; the measured Bun/macOS artifact should not
  be generalized to Windows or Linux without local calibration.
- All values include the worker's server/runtime/projector process, so they are comparative
  evidence for this fixture rather than isolated mobile-replay allocation or a mobile RSS
  budget. The fixture is synthetic, in-memory, and sampled on one host; no allocator trace,
  physical-device measurement, or production memory certification is claimed.

The named synthetic fixture gate is **Pass** for the generated report. Its synthetic workload,
one-host scope, whole-process accounting, and sampling limitations are recorded constraints,
not additional acceptance gates. This scoped measurement does not require an allocator trace,
private userdata, physical-device run, or cross-platform certification. The current serialized
event/page/capture limits remain enforced and tested as safety bounds.

## Server gate status

Focused server/contracts coverage verifies bounded identities and frames, zero-event
catch-up, 1,001-event pagination, cursor/epoch validation, baseline-covered delayed capture
events, above-baseline canonical overlap identity, replay and capture byte budgets, actual-hub
overflow handoff, full-attempt deadline cleanup, post-caught-up longevity, fresh live-gap
deadlines, targeted SQL assembly, empty bootstrap, and concurrent real-query
publication/rollback/repair.

The coordinated client review accepted the 106 focused tests plus browser/integrated stale,
fallback, and targeted Stop evidence. Those client gates are closed for this review record;
they are not being reimplemented in the server slice. The named Phase 4.3 synthetic
replay/capture-memory fixture now passes with the scoped limitations described above. This
record remains evidence for integrated review, not a standalone plan-completion declaration.
No migration, commit, or push is part of this record.
