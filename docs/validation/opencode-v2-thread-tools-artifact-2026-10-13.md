# OpenCode V2 required thread-tool artifact qualification

**Date:** 13 October, 2026
**Status:** Partial source foundation; production feature is not implemented

## Scope

The independently accepted [integration plan](../plans/2026-10-12-opencode-v2-canonical-thread-tools-plan.md) remains the implementation contract. This checkpoint implemented the portable artifact, app issuer/storage primitives, signed native enrollment/renewal/revocation registry, four native tool definitions, and focused fixtures/tests. It did **not** wire application composition, an authenticated production callback listener, canonical HTTP/SQLite dispatch, journal/approval/receipt guards, persistent enrollment state, readiness/setup UI, or production isolated-mode retirement.

The user's actual shared V2 outbound problem therefore remains unresolved. Passing native tool callbacks below are synthetic protocol qualification, not a claim that actual bigbud thread commands were dispatched. Source implementation/installation are distinct; no user-native setup/install/reload was performed.

## Concrete packaging mismatch and correction

An artifact file URI was imported successfully by Node/Bun, but configured native plugins were absent and `info` returned `rpc.unavailable` on owned 2.0.26. Native config metadata showed the configured file entry was present. Immutable source [`packages/core/src/config/plugin/source.ts`](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/config/plugin/source.ts) explicitly ignores configured absolute file targets with `configured plugin path must be a directory`.

The correction is a dependency-free **directory** artifact, including local `package.json` (`private`, ESM, no dependencies) and `server.js` forwarding to `index.mjs`. Manual setup must reference `artifact.pluginUri`, the immutable directory URI, not `artifact.entryUri`, the internal module URI used by portable tests. Public `@opencode/plugin@2.0.26` `Host.resolve` resolves `server` first, then `index`. This correction passed actual owned 2.0.26 and 2.0.27 without npm installation or server/account duplication.

Hash final module **and resolver metadata** bytes in deterministic ASCII name order; exclude the manifest. `index.mjs` derives only nominal parent-directory identity through `import.meta.url`; there is no circular embedded hash or byte-attestation claim. App file verification remains authoritative within native host-user trust.

## Implemented source

All paths below are under `apps/server/src/provider/Layers/OpencodeV2/`:

- `Orchestration.protocol.ts`: canonical signing-field order, owner schema, stable owner digest, request signature construction, four-action/version constants.
- `Orchestration.plugin.identity.ts`: dependency-free identity/signature/callback renderer with request/response bounds.
- `Orchestration.plugin.registry.ts`: native owner verification, callback challenge, stable-digest enrollment, monotonic renewal/inspect, revocation/tombstones, pending mutation bounds.
- `Orchestration.plugin.ts`: exactly four reused canonical schemas, collision checks, primary/auxiliary filtering, native context invocation, required-hook failure, qualified-version gate.
- `Orchestration.storage.ts`: app-only private issuer/file/directory primitives; no native config access or permission repair.
- `Orchestration.artifact.ts`: noncircular immutable export, directory package resolver metadata, exact reuse/content checks.
- `Orchestration.plugin.fixture.ts`, `.host.fixture.ts`: bounded-use synthetic test helpers, not production transport/authority.
- `Orchestration.plugin.test.ts`, `Orchestration.artifact.test.ts`, `Orchestration.plugin.native.test.ts`: focused registration/lease/storage/portable/native tests.

All authored files and emitted code modules are below 400 lines. No source factory, existing diagnostic module, banner helper, persistence binding or UX file was changed by this foundation slice. Root formatting may normalize the managed `AGENTS.md` block; do not reset managed instructions.

## Verification

Final root `bun fmt`, `bun lint`, and `bun typecheck` passed after the warning-only cleanups (`toSorted` and explicit mock tool projection). The earlier nullable address error in the new fixture was fixed. Typecheck ran all nine packages successfully (20.499 seconds); lint reported zero errors and existing advisory warnings. Full `bun run test` completed successfully: **9 tasks successful, 8521 tests passed, 104 skipped**, 17m8.564s. Server contribution was 1010 files/4385 tests passed and 44 files/100 tests skipped; desktop contributed four skipped tests. Opt-in native artifact qualification was run separately against both actual versions, not inferred from these default skips. This clears repository checks for the frozen partial foundation, not independent source review or completion of the production feature.

Frozen source manifest and exact logs:

```text
/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/thread-tools-foundation-source-2026-10-13.sha256
/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/thread-tools-foundation-lint-2026-10-13.log
/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/thread-tools-foundation-typecheck-2026-10-13.log
/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/thread-tools-foundation-test-2026-10-13.log
```

Qualified executable SHA-256 values (read-only hashes, binaries unchanged): 2.0.26 `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`; 2.0.27 `7fa5c8659e57cae76b1da4f45edbc583aef93aae917246a0b3abb1ac1b3fb93c`. New source/test files total 1035 lines across eleven modules; maximum individual file length is 124 lines.

Focused ordinary CI tests passed **2 files / 5 tests**:

```sh
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/Orchestration.plugin.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.artifact.test.ts
```

These exercised Node/Bun imports outside the checkout without `node_modules`, exact artifact reuse, altered/symlink/public-readable file refusal, stable identity across renewal/inspect, lost-ack readback, reordered/stale/same-revision conflicts, revoked replay, unrelated/auxiliary tool filtering, trusted context fields, and honest foreign-definition collision/replacement preservation. This is not exhaustive production concurrency/record/approval coverage.

Actual native qualification passed **1 file / 1 test per version, zero skips** on macOS ARM64:

```sh
BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/v2-2.0.26-qualification/cli-darwin-arm64/package/bin/opencode \
BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.26 \
bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Orchestration.plugin.native.test.ts

BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=/Users/youpele/.opencode/bin/opencode \
BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.27 \
bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Orchestration.plugin.native.test.ts
```

Latest completed runs: ordinary CI tests 1.41 seconds; 2.0.26 native 2.94 seconds; 2.0.27 native 2.33 seconds. Fixture verifies actual server version and PID equals its spawned child. Both processes ran in disposable private HOME/XDG/database/config/workspaces with synthetic loopback provider credentials only. They did not adopt, stop, ensure, restart, modify or enroll the user's service/sessions. The installed 2.0.27 executable was invoked unchanged in that disposable environment.

Native proof covered configured directory loading, exact RPC issuer/artifact identity, enrollment/renewal/inspect, actual execution of all four advertised tools with native session/message/call/agent context, native subagent deny, and callback-down hook failure projecting a failed native outcome with **zero additional synthetic provider requests**. The callback returned fixture responses; canonical business operations and real cross-provider routing were not exercised. No paid prompt or live vendor execution occurred. Other native platforms/releases are not qualified by these runs.

## Required next implementation work

1. Independently review this new source foundation and the directory-packaging correction; retain previously accepted diagnostic/banner/prompt work.
2. Implement the production callback listener and authenticated persisted enrollment/lease client, exact guarded RPC authority, current canonical admission/message interval correlation, canonical approvals and durable receipts. The existing fixture callback is **not** a production broker.
3. Wire required preflight/enrollment before native session creation and new admission; verify actual canonical HTTP route + SQLite cross-provider send/queue/create/provenance/replay, revocation, cancellation and uncertain outcomes.
4. Implement shared-only production topology and preserved read-only isolated/unknown historical bindings without replacing Kilo's legacy manager or discarding user history.
5. Add required selected-Location setup/readiness RPC/UI. Copy the directory URI; append/replace only the prior bigbud entry in the existing native plugin list. Preserve unrelated entries and legacy `plugin` syntax. The user may perform native reload if automatic watching has not settled; the assistant/app must not execute native admin/reload implicitly.
6. Complete planned signed enrollment-record/file/reparse/DACL tests, races, hidden-learning denial, historical policy/fingerprint/replay gates, browser checks, full root checks and independent functional/security/requirements review.

This is a resumable partial implementation, not a new planning blocker or permission request. Source work is authorized. Remaining work is substantial and must not be replaced with instruction-only claims or a prototype auto-installed into the user's native service.
