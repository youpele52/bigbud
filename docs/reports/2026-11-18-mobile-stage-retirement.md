# Mobile stage retirement (18 November 2026)

**Problem:** the F3 fix in the increment 7 re-run publishes `<stageId>.r<revision>` after each
consent change. The journal never discarded a stage, so it filled after 16 stages. After that,
every activation failed with a generic `publication-failed`. The 16-entry selection history and
32-entry attempt ledger also grew forever, and so did the published `components-v1` directories.

**Result:** consent cycles are unlimited and the journal stays bounded. A test runs 24
revoke/re-grant activation cycles, each with publish, select, a native original and its exit. The
journal never holds more than 2 stages, 2 attempts, 1 history row and 1 release, and it never
holds more than 2 published directories. Nothing is committed.

## Retirement rules

A stage retires only when all of these hold (`mobileStageRetirementBlock`):

- It belongs to an earlier consent revision, so it is already `cancelled`.
- The desired selection does not name it.
- Every attempt of its revision is `exit-confirmed`. That status covers a recorded exit and an
  ended native epoch. These are the evidence rules of the orphan GC and `--resolve`.
- No gateway base pin of those attempts remains.

The planner also checks:

- Its attempts and history rows are the oldest. The attempt and history ledgers only ever lose a
  prefix, otherwise the stage is kept as `history-order`.
- Each original's runtime tree and receipt are gone. The GC's proof needs the attempt row, so the
  row outlives the files.
- Its published directory is the owner-keyed, dev/inode-anchored one from the journal intent. It
  holds only `gateway` and `assets.tar.gz`, and each is private, has a single link, and matches the
  publication receipt's identity.

**Removal** reuses the orphan GC's `removeMobileRuntimeInventory`, which revalidates each stamp
and never recurses blindly. One CAS then retires the stage, its settled attempts and history rows,
and any release nothing references.

**Crash safety:** once a stage is retirable, it stays retirable, because nothing can name a
superseded revision again. Files go before rows, and an absent directory counts as removed, so
every interrupted state is finished by the next run. A lost CAS acknowledgement is reconciled by
the store.

**Fences:**

- The journal gains a monotonic `retired` tally: stages, `revisionFloor`, selections and attempts.
  A new stage must be newer than `revisionFloor`.
- Once anything has retired, the inputs' id is reused only while it is still present at the same
  revision. Retired ids are never reissued.
- Selection revisions are offset by `retired.selections`. The first remaining attempt may be a
  `crash-restart` once attempts have retired.
- Generic CAS writers still cannot drop a stage, a history row or an attempt unless the same rules
  hold. `assertMobileStageRetirementTransition` and the lifecycle and selection prefix checks
  enforce this.

**Old originals:** an old original can still only be revoked, never served. A stage is retired
only after its originals have settled and their pins are gone. A cancelled stage can never be
reminted, selected or admitted.

## Where it runs

- **Every `publish`:** best effort, before the stage reservation, under the same publication job.
- **`bigbud mobile repair`:** after the orphan GC, under the publication lease. While an
  activation holds the lease, retirement is skipped (`stages: null`) and runs at the next
  publication. The repair reply and the CLI print one line per stage with a fixed reason.

## Exhaustion

The 16-stage cap remains as a safety bound. `reserveRemoteAgentMobileStage` throws
`MobileStageBudgetExhausted` only when 16 stages remain after retirement, all genuinely live.
Launch maps this to the new reason `stage-budget-exhausted`, a failure before native Start, not
`publication-failed`. The CLI adds repair guidance: run `bigbud mobile repair`, with `--resolve`
after a reboot.

## Remaining limits

Activations within one consent revision share that revision's stage. They still count against
the 16-entry selection history and the 32-entry attempt ledger, and they retire only after a later
grant and a newer selection. Older backends fail closed on a journal with the `retired` tally.

## Checks

The following were run with explicit paths and passed:

- `bunx oxfmt`
- `bunx oxlint`: 0 warnings
- `bun run --cwd apps/server typecheck`: no errors in the changed files. Errors remain in
  `runtimeUpdate.activate.launcher.test.ts`, another lane's file that was not touched here.
- Focused Vitest over 34 mobile test files, the new ones included: 196 passing tests.

**Mutation check:** each of five mutations failed the new tests, and every backup was restored and
verified byte-identical. The mutations were:

- Drop the unsettled-attempt rule.
- Drop the desired rule.
- Drop the foreign-member check.
- Reuse the inputs' id after a retirement.
- Remove publish-time retirement.
