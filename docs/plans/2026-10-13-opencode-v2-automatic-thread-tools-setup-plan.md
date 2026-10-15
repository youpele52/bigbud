# OpenCode V2 automatic required plugin setup

**Status:** Ready for implementation — production implementation and final v3 validation are not yet complete.

## Authoritative scope

The user's latest setup clarification supersedes **manual required-plugin installation only** in the earlier canonical-thread-tools plan. Automatically infer the actual chat/worktree Location and automatically install the required integration after one-time expanded acknowledgement. The user-level native configuration directory is the default; its settings override changes only plugin configuration placement, never chat CWD, workspace selection or shared service identity.

Source approval does not authorize the implementation agent to modify actual user-native configuration, accounts, credentials, permissions, services or threads. Every executable installation/qualification during implementation uses disposable native fixtures and synthetic vendors only. No service ensure/restart/kill, CLI upgrade, automatic CLI reload, paid prompt or git publication is authorized.

Keep the immutable v2 manifest (`c370a43d82fe94ca9ff3a692614f69cb8237b02e29a0409846607e13f6cabea5`) and its final-doc exception record unchanged. Its root run already completed successfully: 9/9 tasks; server 1026 files/4433 tests passed, 47 files/104 tests skipped. That result does not validate v3.

Preserve shared-only production; all five canonical tools and ACL/title-lock rules; automatic compatible foreground enrollment; credential-free/tool-disabled hidden work; original native rule/filter order; encrypted/signed callbacks; lease/owner/revision fences; approvals, stable IDs, receipts and uncertainty; read-only incompatible history; no replacement/replay/private fallback; other providers and unrelated dirty work.

## Investigation and route decision

Official V2 `/config`, `/plugins`, and public OpenAPI documentation were fetched, including current Context7 V2 documentation. The pinned 2.0.26 source was inspected only to explain public configuration discovery/ordering; no private API or internal SDK is an implementation dependency.

`GET /api/config` supplies configuration **documents and directory sources** in precedence order. `server.info.paths` contains only `tmp`, not the native config root: it must not be used to invent a root. For the qualified fixture versions, the first directory source is the native global root, independently verified across two Locations. A missing/unrecognized/different source fails closed; never guess from registration paths or fall back to another filesystem root. Config documents can contain credentials: retain/project only required path/plugin/policy facts and never log/persist complete documents.

The disposable `PluginSetup.autoload.native.test.ts` probe passes 2 tests on both actual 2.0.26 and 2.0.27. It verifies:

- Global direct `.js` autoload of the immutable app artifact, with native source provenance identifying the shim.
- Native config directory proof for two independent Locations, and automatic watching without any reload/service call.
- Project and global explicit plugin removal precedence.
- Managed-only artifact upgrade to another genuinely hashed artifact with the same issuer, loaded in both Locations.
- Existing native config bytes stay unchanged, with zero synthetic model requests.

**Important collision finding:** raw autoload plus an explicitly configured copy can expose multiple native records for the same `bigbud.thread.v1` ID; readiness alone can observe the still-valid old registration before the watcher settles. Do not install a shim alongside manual configuration. Reuse a uniquely verified existing configured entry without any write. A configured but settling entry gets bounded read-only verification, not a second installation. Foreign issuer, duplicate/error namespace records, unsupported source provenance or a configured older entry requiring edits are explicit remediation failures, not permission to replace arbitrary files/JSONC.

**Selected route:** one app-owned, signed/provenance-checked **global autoload shim** referencing the immutable artifact. Do not rewrite native JSON/JSONC at all; no dependency/editor is needed. The immutable `artifact.pluginUri` remains a directory URI in manifests and configured-entry matching. Importing `artifact.entryUri` inside the generated shim is module execution, not a module URI inserted into the native configuration array.

## Implementation sequence

### 1. Versioned consent and settings

- Add optional trimmed `nativePluginConfigRoot` to full settings, patch schema, merge/export/import and focused tests. Blank clears the override. Validate absolute platform-appropriate paths server-side; relative paths, NULs, implicit `~` expansion and invalid components fail with a safe diagnostic.
- Resolve root in order: explicit setting; supported `OPENCODE_CONFIG_DIR`; `$XDG_CONFIG_HOME/opencode`; documented user `~/.config/opencode`. No directory inference from chat CWD. Confirm this exact root against the qualified native global directory source before any directory creation/file mutation. Wrong environment/override remains a clear error with inventory visible.
- Retain `host-user-v1` decoding as historical acknowledgement only. Introduce an explicit persisted expanded acknowledgement covering host-user execution **and only app-managed required-plugin installation/upgrades**. Never derive write permission from old acknowledgement, enable alone, settings-open or saved history.
- Include acknowledgement scope and plugin-config-root in `V2ConsentAuthority` revision fencing, separately from the shared connection key. A change synchronously aborts pending installation, callbacks and publication; old owner cleanup targets its original identity. Do not force service restart, change chat CWD or change shared identity because only plugin-root placement changed.
- Existing manually verified compatible histories are conserved; after expanded acknowledgement, reuse their unique current artifact rather than migrating/recreating or adding a duplicate autoload source.

### 2. Secure managed publication

Use dot-notation modules under `provider/Layers/OpencodeV2/PluginSetup.*`, each ≤400 lines. Reuse artifact issuer, signed app-owned records, ancestor checks and established bounded/private file primitives where applicable; do not weaken their private-storage policy to accommodate a public-readable native config root.

- Native root/ancestors must be canonical, nonsymlink, expected owner, non-group/world-writable; an existing user-owned 0755 config directory is permitted. Own managed entry/staging files are private regular single-link files; never chmod/chown-repair native configuration or a collision. Windows must use existing same-handle owner/DACL/reparse primitives or explicitly fail closed where proof/qualification is unavailable.
- Read bounded raw config source files without following links; reject truncated/malformed/unsafe inputs, preserving all bytes. Parse-only `fromLenientJson` can be reused only for validation/projection, never as a comment-preserving writer. Native returned policy/config facts must be reconciled with raw source validity before publication.
- Check native removal/deny controls and namespace provenance **before** installation. Do not append/re-enable a removed plugin, grant permissions, or overwrite an existing unrelated plugin with a bigbud-looking filename. Exact signed app ownership, not names/comments, establishes cleanup/upgrade authority.
- Persist signed pending publication evidence before mutation; bind root, target name, issuer, artifact digest/URI, exact content hash and relevant filesystem identities. The shim contains only a pinned import and public provenance, never canonical/callback secrets.
- First publication is atomic and no-overwrite (fully written/synced non-autoload staging content, exclusive publication). Upgrade only an exact prior owned entry. Revalidate authority and directory/file identities before physical writes and after awaits; a successor/foreign entry is never cleaned up. Crash recovery accepts only exact signed pending/committed bytes, otherwise retains uncertainty and refuses repair.
- Same-root/same-issuer installation calls join one physical operation. Serialize genuine publication conflicts with bounded ownership locks; do not steal an unproved stale lock. Cancellation detaches a waiter without canceling another authorized waiter; scope/owner revocation fences all remaining authority. No lock/temp/config write is performed for a verified idempotent read-only preflight.
- Keep root/source/artifact verified cache bounded and revision-bound; check current ownership before use. No every-20-second installer invocation or repeated filesystem writes/reloads. Never call native reload to settle watching; bound info/source retries and surface a truthful settling/failure state.

### 3. Production wiring and directory inference

- Extend required orchestration preflight with the installer authority/settings service. Run it only on an acknowledged foreground execution path or an explicit acknowledged settings retry, never from model catalog discovery or hidden work.
- Startup preflight receives the actual resolved native Location before create/update; new-turn readiness receives the exact owned session Location before admission. Keep current fail-closed ordering: no creation/update/prompt/new admission or provider/private fallback when setup fails.
- Check metadata/ABI/current issuer/hash/exact 2.0.26/27 version/exact five-tool inventory after watching settles. Preserve unique manual source compatibility; reject duplicates/foreign issuers before publishing or exposing executors.
- Setup RPC accepts inferred context (thread/worktree where available, otherwise the server's actual local default context), not a user-entered chat directory. Preserve the separate read-only retained-history projection. A settings-root override never enters runtime workspace resolution.
- Fence pending setup result publication by the accepted settings revision and request generation. Root changes revoke old setup work rather than merely discarding its toast.

### 4. Settings/UI and current docs

- Remove the “Selected native Location directory” textbox, manual append/copy workflow and manual-only claims. Explain that chat/worktree directories are detected automatically and global setup is reused.
- Present only a native **plugin configuration directory** override, with persisted value/clear behavior. Show the inferred Location as context/status, never an editable chat CWD.
- Expanded trust explanation states exactly which required-plugin entry may be created/upgraded and excludes credentials/accounts/permissions/other plugins/service actions. Opening settings must not trigger installation.
- Provide explicit retry for failures after acknowledgement. Use blue working, green verified, amber settling/unsupported/manual remediation, red failed severity. Reject stale UI responses after setting/consent changes.
- Amend the current provider report and a separate v3 validation ledger. Preserve historical manual v1/v2 evidence as historical qualification, not rewritten automatic-setup passes.

## Validation checklist

| Requirement                              | Required evidence                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expanded scope is explicit and persisted | Old v1 ack gives zero writes; new ack install; reset/root change/revoke fences awaited publication; schema/patch/export/import tests.                                                                                                       |
| Root and chat directory remain distinct  | Default/override/native-other-environment/source-mismatch tests; actual project and Git worktree CWD unchanged; no project config churn.                                                                                                    |
| Only proven managed entry is changed     | Byte-exact unrelated JSONC/comments/legacy plugin entries/config/model/account/permission/sibling preservation; foreign/link/owner/ancestor/collision cases.                                                                                |
| Atomic/durable/idempotent setup          | First install, repeated preflight zero writes, managed upgrade, concurrent join/conflict, cancellation, revocation, write failure, crash-partial and successor cleanup tests.                                                               |
| Native boundaries and source provenance  | Actual 2.0.26 and 2.0.27 global-root install/watch/upgrade across projects/worktrees, native deny precedence, reuse existing manual entry with **no shim**, foreign/duplicate namespace refusal.                                            |
| Foreground-only ordering                 | Discovery/settings-open/hidden jobs trigger zero setup; startup/new-turn fault matrix gives zero native create/update/prompt/new admission/fallback while model inventory/history stay intact.                                              |
| UI behavior                              | Chromium tests: no manual chat-directory input; plugin-root persist/clear only; expanded old-user acknowledgement, explicit retry, contextual Location, stale-response fences and truthful severity.                                        |
| Preserved v2 integration                 | Re-run canonical five-tool/crypto/race/history/lifecycle/core suites and both owned-native production qualifications.                                                                                                                       |
| Completion                               | Serialized `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` (never `bun test`), relevant browser/native checks, ≤400-line audit, immutable v3 full-worktree manifest/delta and parent independent code/security/requirements reviews. |

Qualified native scope remains **macOS ARM64 2.0.26/2.0.27 with disposable services and synthetic vendors**. Broad discovery is not automatic-installation/execution qualification. No v3 completion or inherited v2-green claim is permitted until the new gates pass.
