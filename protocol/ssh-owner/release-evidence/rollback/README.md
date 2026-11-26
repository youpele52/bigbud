# Offline B-to-A rollback boundary checker

This checker compares normalized observations from one rehearsal against an independently frozen plan. It reads only two explicitly named local JSON files. It does not open SQLite (including WAL), inspect processes, hash artifacts, take a lock, run a rollback, or access the network. Use only redacted tokens and digests from an authorized isolated rehearsal; never supply live user data, paths, process arguments, environment, or credentials. Keep the underlying observations and how each fingerprint was derived in the controlled evidence store.

`rollback-boundary-conforms` means the supplied observations agree on a compatible A/B pair and an offline switch under one fence. It does not authenticate the observations or show that the product refused an unsafe rehearsal. It does not establish build A release precedence, the pre-A/fresh DB cases, the A-to-B re-upgrade, pane-record compatibility, stale-write fencing, or release acceptance. Those remain separate [matrix lanes](../matrix/README.md); reference a reviewed finding only after verifying the underlying rehearsal.

## Input contract

All objects have exact fields. Identifiers use the [matrix token syntax](../matrix/README.md); SHA-256 fields are lowercase hex and sequence positions are distinct positive integers from one recorder ordering, not wall-clock timestamps.

**Plan**: `{ kind: "rollback-boundary-plan-v1", binding, metadata, aImageSha256, bInventory }`.

- Copy `binding` from the independently reviewed **required** matrix cell, including profile/target, artifact IDs, digests, and DB domain; do not derive it from the observed run.
- `metadata` is `{ schemaCeiling, schemaSha256, migration, migrationSha256 }`. Freeze the schema ceiling, the digest of the canonical schema at that ceiling, the preparatory migration ID and a digest of the exact preparatory migration definition. Measure A and B independently using the same normalization; the migration digest is not a hash of its ID. The ceiling and migration ID must agree with the cell.
- `aImageSha256` is the expected executable image of A that first opens the database, distinct in purpose from the distribution artifact digest. Independently freeze `bInventory` as one `{ component, role, imageSha256 }` per expected managed B process alive before drain, with a unique component token for each occurrence. Use roles `launcher`, `owner`, and `transport`; include at least one launcher and exactly one owner matching the cell's owner digest. Include detached launchers and drained transports relevant to this rehearsal, not unrelated user processes. Reviewers must verify this inventory covers all applicable B authority; the checker cannot discover omissions from both inputs.

**Observations**: `{ kind: "rollback-boundary-observations-v1", binding, a, b, capture, before, drained, storageRevokedAt, retirements, boundary, aStart, aOpen }`.

- `binding` identifies the observed cell. `a` and `b` each contain `{ artifact, executor, metadata }`. `artifact` is the observed `{ id, build, sha256 }`, and the executor roles are respectively `legacy-ts` and `rust-owner`.
- `capture` is `{ complete, lostEvents, fenceContinuous, otherBStarts, otherAStarts }` for the entire interval from `before` through `aOpen`. Require a complete lifecycle/DB-holder observation with continuous exclusive release fencing, zero lost events, and no other managed A or B launches. Do not turn missing or ambiguous observations into zero counts or use just process snapshots as verified exits.
- Each of `before`, `drained`, `boundary`, and `aOpen` is `{ seq, fence, db }`, where `db` is `{ domain, instance, metadata, logicalSha256, holders }`. Use one stable redacted DB instance token derived from the underlying file identity (not a path, filename, or content hash), and the same release fence token. Use holder instance tokens, not raw PIDs. For `logicalSha256` use one canonical committed-state fingerprint including migration history, the rollback-relevant tables, timestamps, and WAL-visible commits. Do not compare raw DB/WAL bytes or assume an unchanged pathname proves continuity.
- `before` records known live B DB holders. `drained` records the final committed B state after transport drain and before storage revocation. `storageRevokedAt` is the observed sequence of B binding revocation. Each `retirements` item is `{ component, before, exit, status: "verified-exit", seq }`, with matching `{ instance, imageSha256 }` observed before drain and at verified exit. An instance token must distinguish process lifetimes even when PIDs are reused. Every frozen B entry must exit before `boundary`; a B holder still observed at `drained` cannot already have exited.
- `boundary` is after revocation, exit of all inventoried B processes and closure of all DB handles; it records no holders. `aStart` is `{ seq, process: { instance, imageSha256 } }` for A, after the boundary. `aOpen` is A's first DB open with only this instance holding the DB, before any workload writes or repairs. The DB identity and metadata must stay the same throughout, and the committed-state digest must agree at `drained`, `boundary`, and `aOpen`.

## Run locally

From the repository root using existing Bun dependencies:

```sh
bun run protocol/ssh-owner/release-evidence/rollback/verify.ts /path/to/rollback-plan.json /path/to/boundary-observations.json
bun run vitest run --config protocol/ssh-owner/release-evidence/rollback/vitest.config.ts protocol/ssh-owner/release-evidence/rollback/check.test.ts
```

Exit 1 refuses incomplete, uncertain, mismatched, or out-of-order evidence. Exit 0 reports `rollback-boundary-conforms` with `observationsAuthenticated: false`, `rollbackQualified: false`, and `s4Accepted: false`. The tests use synthetic records only.
