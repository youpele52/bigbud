# Shared native service: independent profile registrations

## Contract

- Native service, accounts and configuration remain shared. Each bigbud profile retains its own signing/encryption keys and signed ownership records.
- New plugin/RPC IDs are `bigbud.thread.v2.<full issuer>`. Each profile publishes only `bigbud-thread-tools-<full issuer>.js`.
- Tool names are `bb2_<first 32 issuer hex characters>_<canonical action>`. The shortened prefix is **not** an authority: full-issuer authentication and exact tool fingerprints remain mandatory. A prefix collision fails setup without replacing a definition.
- Publication records use `bigbud.thread.install.v2`; old records retain their original encoding. Record keys and activation scopes distinguish registration families. Exact file content, identity, root, signed-record and CAS checks still apply.
- Explicit installation-device revalidation accepts `--registration-family scoped` for the new slot. The maintenance command defaults to `legacy` for backwards compatibility; backups must contain the selected record's exact filename. Approval never spans both families.
- Publication locks are issuer/family scoped, including activation locks. Private record locks retain their existing encoding. Foreign legacy/profile lock files remain untouched and do not block unrelated slots. Shared directory creation is coordinated by atomic `mkdir`/`EEXIST`, followed by root and child identity attestation; per-slot CAS/exclusive writes protect publication. The conservative native-activity fence is unchanged.
- Fresh shared-session IDs derive from the scheme, shared storage identity, profile issuer and canonical thread ID. A durable `shared-api-v2` creation reservation records issuer/family **before** native creation. Native metadata and resumed cursors retain that identity. Lost acknowledgements never authorize a replacement session.
- Fresh IDs use `ses_bb3_<43-character base64url issuer>_<43-character base64url digest>` (95 characters). Both 256-bit values are encoded losslessly; the native router accepts at most 100 characters in a path parameter even when session creation accepts a longer ID in its body. The versioned hash material uses `bigbud.shared-session.v3`; ownership metadata and durable `shared-api-v2` classification remain unchanged.
- The compact full-issuer prefix and historical `ses_bigbud_v2_<64-hex issuer>_` prefix are permanent **deny boundaries**, not enrollment authority: without a current authenticated enrollment, the plugin rejects native work for matching IDs, even after reload. Existing IDs remain authoritative and are never rewritten. Non-namespaced retained histories retain the original bounded remembered-session guard.
- Already-issued 142-character IDs remain retained evidence, not migration inputs. Startup rejects them before native acquisition/creation with explicit new-thread guidance. Their sessions, history and dispatch intents are not cleared, replaced or replayed. A new thread is an explicit user action, not automatic recovery of the old thread.

## Retained history and mixed versions

The last single-issuer compatibility descriptor is frozen as N2, alongside N0/N1. The first scoped (hex-ID) descriptor is frozen as N3. Compact IDs require bootstrap ABI v3; signed N3 artifact bytes remain readable but cannot be substituted for a compact-aware bootstrap. Canonical implementation identities and stored implementation-selection metadata are unchanged. An explicit narrow compatibility relation allows the existing canonical handlers under the scoped registration ABI; schemas, canonical request ABI and result encoding must still match.

Selection happens before activation, from durable binding/cursor/journal evidence and same-profile signed enrollment records—not from whichever plugin happens to be loaded:

1. Fresh histories select the scoped family.
2. Positively proved legacy histories retain their exact signed legacy artifact.
3. Missing, conflicting or ambiguous legacy evidence leaves history read-only. It does not recreate sessions or replay transcripts.
4. A native session ID never crosses registration families, even after expiry, detach or retirement. Old plugin instances retain managed-session sets and can continue enforcing their boundary.

The legacy global plugin entry is not deleted, adopted by another profile or automatically replaced as part of joining the scoped family. One existing legacy owner and independent scoped profiles can coexist. Two old single-issuer clients still cannot independently own the old global slot. Updating an app does not silently migrate its retained histories; legacy execution requires the original artifact and exact installation to remain available.

## Default chat folder

Intentional folderless threads in the built-in Chats project use the configured Default chat folder. Real project/worktree paths take precedence. Missing/deleted projects and missing canonical project paths do not fall back to a private directory. Relative local Locations are rejected rather than resolved against process cwd.

Changing Default chat folder does not move existing native history. A retained cursor/binding for another Location stays read-only under the changed setting; restoring the original setting can restore the matching context. No automatic native-session rebind is performed.

Active-session reuse enforces the same boundary before admission, model/mode changes or session replacement. Local Locations compare real paths (including equivalent symlink aliases); remote runtime Locations retain their POSIX binding semantics without consulting the backend's local filesystem. An unresolvable local Location fails closed.

## Rollout and evidence boundaries

- Build/release/install the updated app through the normal operator workflow. This change does not rebuild or install a live app.
- Keep existing profile keys, databases, enrollment records and legacy plugin files. Do not copy ownership material between profiles.
- Normal explicit setup consent is still required. New setup adds only the selected profile's entry when native activity and provenance checks allow it. Existing plugin-removal policy and legacy/selected tool denies are not bypassed.
- Selected registration policy is rechecked during native eligibility, locked activation, pre-publication and exact-installation identity maintenance—not only initial setup and final readiness. Regression tests introduce a scoped plugin removal/tool deny after initial authorization and verify no owner retirement or plugin publication occurs.
- Compact support changes artifact bytes in the same issuer-owned plugin slot. Normal same-family retirement and publication proofs still apply; a failed creation binding is not retirement approval. Manual N3 entries require explicit update rather than silently serving compact sessions or adding an autoload alias.
- No service restart is performed. Native watching must activate the entry; failures retain evidence and report setup as unavailable.
- The native contract digest includes scoped coexistence and profile-bound history obligations. Old qualification records are not relabelled as evidence for these new semantics.
- Synthetic tests cover namespace coexistence in both orders (including simulated legacy behavior), routing, foreign calls, tool hiding, detach isolation, publication races/removal, profile-bound session restart/lost acknowledgement and family-selection rejection. The synthetic legacy renderer is explicitly a test fixture, not historical byte qualification.
- Review regressions cover retained foreign legacy/scoped lock bytes and inodes, simultaneous publication into a missing shared `plugins` directory, more than 32 sequential namespaced enrollments/detaches, expiry and reload fail-closed behavior, and the unchanged 32-active-owner limit. The 128-entry short-lived anti-replay tombstone bound remains unchanged; it is not a lifetime-history bound.
- Loopback HTTP router regressions cover 99/100/101/142-character body-create versus exact-GET routing, 95-character production startup, create-success/verify-failure retained dispatch intent without prompt/recreation, and early rejection of retained overlong bindings. The approved isolated native coexistence test also asserts create followed by exact GET; it remains skipped without real isolation approval.
- Retail-native qualification requires the repository's independently approved clean-machine isolation evidence. Tests skipped without that evidence are **not** proof that the installed shared service has been qualified. No live native configuration, profile or service was modified for this implementation.
