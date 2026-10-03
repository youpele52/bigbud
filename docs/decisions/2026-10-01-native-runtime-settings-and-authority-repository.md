# Native Runtime Settings And Authority Repository

**Date:** 1 October, 2026

**Status:** Accepted for bounded implementation; new-code review pending

## Context / decision

Parent independent static0011 review APPROVED captured-byte correction: P2closed,
P3addressed/no new defects. No reviewer rerun92tests/17oracles. Next source-backed
slice wires fresh --serve-db settings read service and ports durable retention
policy-authority repository operations. Source: ws/serverSettings.ts and
persistence/Layers/ThreadRetentionRepository.ts get/setPolicyAuthority.

Settings worker initializes only fresh files; server shares one bounded latest-
value subscription and reads fullCurrent snapshots for getSettings. Stale/stopped
state returns sanitized protocolDie, not silently authoritative last-good data.
Plainserve fixed defaults unchanged. No new watch/change RPC stream or mutation.
Drain sockets then attempt shutdown of both workers, even on one shutdown error.

Policy authority table operations run on dedicated bounded database worker with
typed policy/source/selection/age records, matching exact source upsert and
optional selection defaults. Trusted library setter is storage only, NOT proof
of consumed consent or a user-facing policy setter. No transport/cleanup/settings
path calls it. Fresh runtime validates absence, continues authorizedNever, never
adds invented initial consent/authority rows. Durable consent consumption, rollback
ordering and mutation RPC remain subsequent gates before deletion authorization.

## Consequences

Subsequent independent STATIC review found TWO P2 liveRPC output defects: retained
historical/malformed selection escaped as invalidSuccess, and140k valid customModels
response exceeded128KiB buffer/disconnected. Authority SQL/reply permits/client
influence/dualshutdown approved scoped static; no consent gate assumed or reviewer
rerun. Targeted correction/limits documented separately in
[next decision](2026-10-01-native-settings-response-encoding-and-limits.md).

No new dependencies or paths. Existing atomic SQLite upsert, fresh-only refusal,
captured-byte correlation, quarantine, bounded state/admission/shutdown preserved.
Source service/repository traces and real-process settings reads validate scope;
not full stream/mutation/history/platform parity. Trusted-parent races and Windows
channels/ACL/reparse/directory durability remain uncertified. Only synthetic data;
original app/profile/workspace and dirty work preserved. No staging/commits/pushes.
