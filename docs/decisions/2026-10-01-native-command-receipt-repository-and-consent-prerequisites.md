# Native Command Receipt Repository And Consent Prerequisites

**Date:** 1 October, 2026

**Status:** Parent independent STATIC approved; no confirmed defects

## Provenance / consent prerequisite

Parent independent STATIC0013 review APPROVED bothP2 corrections, publisher-loss
addressed/no new defects. This was NOT execution rerun. Continue substantive work.
Pinned ThreadRetentionRepository.challenges.ts uses node:crypto randomBytes(32),
base64url bearer token and SHA256 UTF8(token) hex digest; tokens are not stored.
Challenge consumption atomically binds trigger/policy/per-thread selector/age/
cutoff/expiry/unused state. Policy service consumes finite consent BEFORE settings
write, then authority write; authority failure rolls settings back but DOES NOT
unconsume token. Rollback failure takes precedence. Never bypasses token consent
while retaining previous selector/age; administrator-disable only gates finite.

Approved Rust direct dependencies provide no approved cross-platform CSPRNG or
SHA256 authoring API. Transitive cryptographic packages used by WebSocket are not
automatic new authorization approval. No homegrown hashing, timestamps-as-entropy,
SQLite randomblob, shell crypto helper or caller-supplied token digest as consent.
Before implementing issuance/consumption, review exact entropy/hash dependency
candidate license/maintenance/unsafe/transitive/platform/features and obtain
explicit approval. Keep consent API and mutation RPC absent. No dependency selected
or added here; independent command-receipt storage can progress safely meanwhile.

## Independent repository decision

Parent STATIC approved receipt foundation with no confirmed defects, NOT execution
rerun103tests/22oracles. Matching in-flight Claimed is NOT exclusive execution/retry
authority. Subsequent P3 queued matching/conflicting sameID regression and independent
event frontier/crypto dossier recorded in
[next decision](2026-10-01-native-event-frontier-and-crypto-approval-dossier.md).

Port actual OrchestrationCommandReceipts get/upsert/claimOrInspect SQL to typed,
bounded SQLite worker requests. Claims transactionally insert-or-ignore then inspect
claim/receipt: mismatching digest/version conflicts, accepted receipt immutable,
rejected row replaceable, receipt digest takes precedence over claim digest, null
legacy receipt digest always conflicts with legacy-unbound/v0/unavailable.
Repeated matching in-progress claims remainclaimed, NOT permission to blindly
replay accepted work. Repository compares TRUSTED owner-supplied digests only;
canonical command hashing/validation/event execution not implemented or exposed.
No client-supplied digest trust or durable consent authority implied.

Bound fields before admission (IDs/timestamps/digest4096bytes, error16KiB,
safe nonnegativeJS integer sequence). These preview bounds are explicit, not
arbitrary historical/string/numeric parity. Fresh profile only, typed SQL/no paths,
source initial schema/rows unchanged. Actual source live repository traces, Rust
restart/constraint/transaction-failure/admission/caller-loss tests and all checks
before independent review. All original safety/no-commit/approved-deps/<=400 rules.
