# Native Settings Loaded-Byte Acknowledgment

**Date:** 1 October, 2026

**Status:** Implemented; independent parent STATIC approval

## Context

Independent parent static review found a confirmed P2 missed invalidation in the
new dispatcher. Startup separately sampled disk after caching defaults; reload
sampled disk before a second read. Either could pair a published snapshot with
bytes it never loaded, ignoring a stable external edit forever. Other reviewed
replacement/ownership/stale/fresh-policy/historical-test boundaries were scoped
sound. Reviewer did not rerun checks. Pre-load sampling was not sufficient.

## Decision

Separate polling observation from acknowledgment. Capture one bounded file byte
buffer (or explicit Missing), decode/recover/reconcile exactly that capture, and
return it with successful reload. Acknowledge only that returned capture after
the corresponding snapshot is obtained. Never reread disk to choose acknowledged
bytes. Fresh startup acknowledges the exact sparse encoding used to seed its
cached default snapshot, not a separate disk sample. An intervening external edit
must therefore invalidate the seed snapshot. Quarantine's own write may cause a
redundant reload; this is safer than acknowledging an unseen post-load edit.

Preserve 1 MiB limit, UTF8 restriction, authorized Never, stale/poison behavior,
bounded admission/latest-value subscriptions and explicit supervision. Add both
deterministic reported schedules (failed before correction) and slow-subscriber
multiple-update/stale/recovery version-gap/full-snapshot tests.

## Consequences

Parent independent STATIC review APPROVED: P2 CLOSED/P3 addressed/no new defects.
Reviewer did NOT rerun92tests/17oracles. Snapshot capture/startup seed/ABA restored
invalidation/quarantine extra reload/failures not acknowledged reviewed sound.
Further runtime/repository work is separately recorded in
[next decision](2026-10-01-native-runtime-settings-and-authority-repository.md).

This corrects internal correlation, not a claim of atomic concurrent filesystem
snapshots or trusted-parent/Windows protection. No additional filesystem paths,
mutation RPC, runtime integration, historical replay/import or dependencies.
Latest instruction requires this targeted fix/check/re-review gate first; full
runtime settings/durable authority roadmap resumes after approval, not before.
