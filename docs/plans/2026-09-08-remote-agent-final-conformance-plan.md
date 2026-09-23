# Remote-agent final conformance corrections

**Date:** 8 September 2026  
**Status:** Implemented locally; Linux fixture validation pending; no commit, tag, issue, or push  
**Operating parameters:** git tag `none`; issue ID `none`; push `no`

## Objective

Bring the current remote-agent implementation into conformance with the main
two-version update plan and the residual-corrections plan. The canonical
installation for one authenticated SSH account must never write a third
distinct executable build, must preserve a verified fallback, and must retain
all durable evidence needed to reject retries and complete retirement safely.

## Confirmed remaining gaps

1. `pruneRemoteAgentHistory` retains active runtime references but does not
   derive build retention from every durable evidence collection. Released
   slot reservations, retirement reservations, and admission-retirement
   records can still identify a build after ordinary runtime references are
   gone. Pruning must not remove such a build or leave an invalid reference.
2. `buildRemoteAgentInventoryCommand` discovers regular files and the two
   named selector symlinks, but misses arbitrary executable symlinks under the
   managed installation. This can undercount physical executable content and
   allow a third build.
3. Linux acceptance coverage exists but is environment-gated. The code and
   tests must remain truthful when Docker or fixtures are unavailable, while
   coverage must explicitly exercise both supported architectures, legacy
   provenance, and physical executable counts whenever matching fixtures are
   supplied.

## Workstream A — durable history retention

### Scope

- `apps/server/src/remote-agent/remoteAgentInstall.registry.admission.ts`
- Focused registry/admission tests and narrowly related retention helpers.

### Required change

Derive a single retained-build set that includes build IDs referenced by:

- current, predecessor, pending, active pins, unresolved launches, admissions,
  and non-expired/ambiguous stages;
- every non-terminal retirement reservation and any terminal retirement row
  whose build identity is still required for deletion/reconciliation;
- every slot reservation row, including released rows retained as immutable
  reservation/replay evidence;
- every admission-retirement record retained for old-request rejection.

Preserve the existing bounded-history policy only after these references are
accounted for. If the bounded limit conflicts with durable evidence, retain the
evidence and defer compaction rather than deleting a referenced build. Keep
registry parsing/CAS invariants valid and do not weaken replay fencing.

### Acceptance

- A build referenced only by released slot evidence survives pruning.
- A build referenced only by retirement evidence survives pruning through
  deletion confirmation, then becomes eligible for compaction.
- A build referenced only by admission-retirement evidence survives pruning so
  a retry remains rejected deterministically.
- Existing active/uncertain launch, pin, admission, selector, and stage tests
  continue to pass.

## Workstream B — physical inventory and Linux evidence

### Scope

- `apps/server/src/remote-agent/remoteAgentUpdate.inventory.ts`
- Its focused inventory tests.
- Existing fixture-gated Linux acceptance tests/helpers only as needed.

### Required change

Make remote inventory account for arbitrary symlinks that can resolve to
executables under `bin` or staging. Resolve links safely, classify managed,
legacy, unknown, and uncertain ownership conservatively, and deduplicate by
content digest. A link to an unprovable or external executable must not be
silently ignored; it must produce unknown/uncertain inventory and block a new
slot. Preserve the existing protections against root/bin/staging symlink
traversal and do not follow unbounded directory links.

Extend the fixture-gated acceptance coverage so that, when enabled, it checks:

- aarch64 and x86_64 separately when their matching fixtures exist;
- fresh, unmatched, and expired legacy provenance labels;
- physical executable counts at pre-install, staged, health-failure, and
  fallback/promotion boundaries;
- no third digest even when arbitrary executable aliases are present.

If Docker, fixtures, or an architecture-specific artifact is unavailable,
tests must skip with an explicit reason. Do not fabricate a pass or weaken the
gate in order to make the suite green.

## Shared safety rules

- Preserve all inherited dirty changes.
- Do not modify GitHub Actions, releases, tags, remotes, or production hosts.
- Do not commit, push, reset, clean, rebase, merge, or remove unrelated work.
- Reuse existing registry, inventory, capacity, retirement, and fixture
  authorities; do not add a second scheduler or cleanup owner.
- Keep every materially edited source/test file at or below 400 lines.
- Do not alter serving selection, generation pinning, provider retry behavior,
  or existing-work continuity.

## Validation and final review

Run focused tests for both workstreams, then the applicable repository gates:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test` (never `bun test`)
- Rust formatting, clippy, and workspace tests if Rust files are touched
- `git diff --check`
- changed source/test line-count audit

Run Docker/fixture-gated Linux tests when the required environment is
available, and record unavailable cases as skips. Finally, perform a read-only
review against this plan, the residual-corrections plan, and the main
two-version update plan. Completion requires every applicable criterion to be
complete; skipped Linux evidence remains an explicit validation limitation.

## Implementation handoff

### Completed

- `retainedRemoteAgentBuilds` now includes selectors, runtime references,
  updates, slot reservations, retirement reservations, and admission-retirement
  evidence. A released slot remains reusable without deleting its historical
  build reference.
- Pruning now removes only builds with no required durable reference. If the
  protected metadata set exceeds the registry build budget, pruning returns the
  state unchanged rather than slicing away evidence.
- Regression coverage proves retention through released-slot evidence,
  retirement before confirmed deletion, old admission retries, and the
  over-budget protected-reference case.
- Inventory now scans arbitrary file symlinks under managed and staging roots,
  follows bounded file-link chains, avoids directory-link traversal, and emits
  fail-closed unknown/uncertain markers for broken or unprovable links.
- Linux acceptance helpers cover both `aarch64` and `x86_64` labels, explicit
  architecture mismatch handling, legacy provenance, and physical executable
  counts when matching Docker fixtures are available.
- The inventory workstream's final owned files were
  `remoteAgentUpdate.inventory.ts`, `remoteAgentUpdate.inventory.test.ts`,
  `remoteAgentUpgrade.gating.linux.test.ts`,
  `remoteAgentUpgrade.acceptance.linux.test.ts`,
  `remoteAgentUpgrade.linux.fixtures.ts`,
  `remoteAgentUpgrade.installFixture.ts`, and
  `remoteAgentUpgrade.production.linux.test.ts`; each remains at or below 400
  lines.

### Validation evidence

- Focused parent slice: 2 files passed, 18 tests passed; 3 Linux-gated files
  skipped with explicit environment reasons, 23 tests skipped.
- Docker synthetic inventory validation: 4 tests passed, 0 skipped, covering
  duplicate aliases, external/broken/loop links, physical counts, and
  root/bin/staging symlink rejection.
- Workstream A retention slice: 4 files and 43 tests passed.
- Workstream B remote-agent suite: 345 tests passed, 45 optional tests skipped.
- Required repository test gate after the final inventory edit: 9/9 Turbo
  tasks; 697 files passed and 13 skipped; 2,904 tests passed and 48 skipped.
- `bun fmt` and `bun fmt:check`: passed.
- `bun lint`: passed with four pre-existing warnings and baseline oversized-test
  warnings; zero errors.
- `bun typecheck`: passed, 9/9 packages.
- `git diff --check`: passed; the remote-agent source/test line audit found no
  file over 400 lines.
- No Rust files were changed; prior Rust gates remain unaffected.
- No commit, tag, issue, push, reset, clean, rebase, merge, GitHub Actions, or
  remote production operation occurred.

### Remaining validation limitation

Docker/fixture-gated aarch64 and x86_64 execution was unavailable in this
environment because `BIGBUD_TEST_LINUX_DOCKER=1` and
`BIGBUD_TEST_AGENT_FIXTURES` were not supplied. Those tests correctly remain
skipped, so real Linux shell execution, architecture-specific fixture
provenance, and physical on-disk count behavior still require a fixture-enabled
handoff before release certification. The implementation does not claim those
cases as passed.
