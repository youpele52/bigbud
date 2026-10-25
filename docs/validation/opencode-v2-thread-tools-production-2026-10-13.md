# OpenCode V2 production thread-tools implementation checkpoint

**Current status:** Frozen source v2 passed repository validation and all three independent delta reviews. Code green and Implementation/Plan green are accepted for this implementation and its stated qualification scope. Manual user-native activation has not been performed; macOS ARM64 synthetic qualification is not a cross-platform/live-vendor release claim. The historical v1 checkpoint below is not transferred evidence. Native approval-contract correction is user-approved.

## Source scope

Production V2 composition now uses only the borrowed shared native service, required canonical infrastructure and local native Locations. Private/SSH/development acquisition is unreachable from production; explicit disposable fixture factories retain owned-process coverage. Historical isolated/unknown bindings and sparse settings remain decodable, with read-only classification and no replacement/replay/private native-database access. Kilo's legacy SDK manager is unchanged.

The required selected-Location setup RPC/UI exports an immutable directory plugin URI from private app storage and provides manual append/replace-only-prior-bigbud instructions. Verify reads plugin info after native trust; it does not install, reload, restart, enroll unrelated sessions or write native configuration. Missing setup blocks native creation/update/new-turn admission while model discovery remains separate. Compatible verified foreground sessions enroll automatically; hidden review/learning jobs remain tool-disabled and never receive canonical caller credentials.

Five executable native definitions reuse canonical public schemas: create, send, status, list and rename. Production callbacks use persistent signed enrollment records, monotonic acknowledged/pending leases, exact guarded RPC bodies, current owner/consent/epoch/transport checks, native assistant/tool-call input-interval correlation, canonical once-approvals, stable invocation IDs and signed private durable receipts. Uncertain reservations do not resend. Stop/interrupt/revoke fences local authority before remote cleanup; physical canonical work is joined outside session queues.

The callback channel uses per-request X25519/HKDF/AES-GCM and fresh Ed25519 response signatures binding owner/nonce, requested/current acknowledged leases, operation and exact request/result digests. Tokens and native arguments are encrypted before the request leaves the native plugin. Signed responses alone are not treated as request confidentiality. The literal owned loopback endpoint, strict field/UTF-8 parsing, wire/body/header/connection/work/approval bounds and safe diagnostics remain enforced. See the authoritative crypto delta in the plan for exact encoding and limits.

## Evidence so far

- Four new deterministic foundation regressions failed against the frozen baseline, then passed after capacity/recognition/lease/deadline fixes. Original failure log: `thread-tools-foundation-races-red.log`.
- Real canonical HTTP/SQLite fixture verifies provider-independent send, busy queueing, provenance, creation inheritance, child ownership, stable replay, changed material refusal, canonical once-approval and revocation. Native projection is synthetic in that fixture.
- Actual owned native **2.0.26 and 2.0.27** qualification executes all five tools through **production application composition, encrypted callback, journal and canonical HTTP/SQLite**, with a synthetic loopback vendor. A created child has an independent native/app session and survives parent stop. Hidden background review remains text-only without canonical tool exposure. Separate native plugin conformance verifies callback-down primary failure with zero additional synthetic requests.
- A disposable rebound-listener regression closes the genuine callback without detaching the still-live native lease, then binds the same port and returns fake HTTP 200 status/result bodies. Those responses are rejected; captured requests contain neither bearer headers nor plaintext callback credentials/tool arguments. Additional signed-response mutation/replay tests cover exact request/result/owner/lease binding.
- Portable artifact fixtures import the emitted modules outside the checkout without `node_modules` under Node/Bun. Private storage tests cover content collisions, permission/link rejection, signed-record tampering, stale conditional updates, uncertain receipts and unsafe ancestor refusal. This is not live Windows/Linux native qualification.

Logs are under `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/`:

```text
thread-tools-foundation-races-red.log
thread-tools-production-core-green.log
thread-tools-production-regressions.log
thread-tools-production-native-2.0.26.log
thread-tools-production-native-2.0.27.log
thread-tools-production-server-typecheck.log
thread-tools-production-web-typecheck.log
```

Additional final focused logs:

```text
thread-tools-production-root-typecheck.log
thread-tools-production-browser.log
thread-tools-production-v2-all.log
thread-tools-retained-isolated-fixtures.log
thread-tools-retirement-final.log
```

These files are overwritten by subsequent focused reruns; the final frozen manifest and final commands/results must be recorded before completion. Earlier passes do not prove subsequently edited source is green.

## Limits and outstanding gate

### User-approved native custom-tool permission-contract correction

The initial owned 2.0.26 approval qualification (`Orchestration.approval.native.test.ts`, required and auto-edits modes) expected a native ask before canonical once-approval. Both cases instead reached **canonical** once-approval first; no child was dispatched before that approval. The original failure evidence remains in `thread-tools-production-approval-native-2.0.26.log` until a corrected rerun; owned-native tests run when their binary environment is supplied, and ordinary root tests skip them when absent.

Inspection of the published Promise plugin/schema contracts and Core commit `9b4ec5714d481559990db0a816d5dec19541a814` showed that `Tool.Options.permission` affects native deny/catalog filtering, not a custom-executor ask. The public plugin permission domain exposes list/get/reply/hooks, not an ask operation. Core's custom-tool execution calls the executor directly. Therefore the original assertion “required/auto-edits ask” cannot be implemented with that public custom-tool contract as assumed.

**Explicit user decision:** accept preserving native permission rules/order/deny filtering and using the existing canonical once-only exact-action approval for all five actions in required/auto-edits modes. Never invent a private ask, use a native question as permission, add persisted grants, or claim two prompts. The authoritative plan paragraph and owned-native test now reflect that accepted correction. Latest native requalification and final independent security review remain required.

### Current workspace validation

- `bun fmt` and `bun lint` passed. Lint reports warnings, including unrelated existing oversized test files; all changed source/test files were checked at ≤400 lines.
- `bun typecheck` passed all nine packages after correcting nullable retained-history projection and branded fixture approval IDs.
- The focused production/security run passed 14 files / 28 tests; setup/picker/banner/retained-history Chromium run passed 7 files / 20 tests.
- The first complete workspace attempt exposed old private-path UI expectations. The next attempt passed all completed non-server packages (contracts 191, scripts 128, desktop 431 with 4 skips, mobile 212, shared 359, web 2815), but the server job had failures and the shell timed out before its summary. These are not a green full-test result.
- Setup authority is now lazy, avoiding unrelated HTTP/WS startup dependence on native consent. Existing retirement tests now assert no unknown-legacy adoption or private development environment routing; the isolated deadline remains tested through its explicit fixture factory. Focused rerun passed 7 files / 27 tests.
- The user authorized investigating the apparently unchanged baseline `Coding.plugin.upgrade.test.ts` frozen-template digest failure: expected `8257d436c59c412b5f7b2fcbb4c55e6ecfa3c209533c5472cf91f121a8a55d75`, actual `4829a44f31b505181a5427ccbc168d424f16465f4041eb46ec049b24a151d70b`. Root cause: although test/renderer sources were unchanged, the renderer dynamically imported the live HTTP schema, so canonical rename's new `targetThreadId` changed historical rendered bytes. `Coding.plugin.previous.schema.ts` now freezes the actual previous schema at the generator boundary; the original digest assertion is retained. No new digest is blessed and the previous template is never installed. Focused rerun remains required.
- The original frozen digest is now restored exactly. Focused retirement/upgrade/security rerun passed 4 files / 8 tests with 1 Windows-only skip. No digest assertion was changed.
- Latest owned native **2.0.26** passed 6 files / 7 tests: plugin, five-tool production path, both approval modes, application replay/disable/rebind/sibling preservation, native context, and model/variant routing.
- Latest owned native **2.0.27** passed those same tests plus logical ownership/native transport/native history qualification: 9 files / 11 tests. Both native versions were used only in disposable HOME/XDG/config/workspace/service fixtures with synthetic vendors.
- Existing private application qualification now imports explicit `Application.fixture.ts`, never production composition. The isolated fixture's coding/access-mode/canonical-execution/lifecycle/development and original frozen-upgrade runs passed 6 files / 13 tests on owned 2.0.26. Private development security/deadline tests also use explicit fixture factories. The production import-graph test rejects these fixture entry points.
- Full V2 directory run initially passed 136 files / 555 tests with 28 files / 37 tests skipped and two remaining old private-routing fixture failures. Both failures were corrected through explicit fixture routing, and their focused rerun passed. Final root rerun is required to verify the entire latest source simultaneously.
- The last two workspace attempts exceeded their shell limits (20 and 10 minutes); the latter was still making sequential server-test progress when terminated, with the old frozen-digest failure already recorded. Neither timed-out run is green. Final root tests will need a sufficiently long timeout; do not poll any prior background run.

Qualification is macOS ARM64 with owned disposable native services and synthetic vendors only. The native host-user is explicitly trusted, not sandboxed. Public SDK catalog wrappers cannot prove hostile executor identity when an installed trusted plugin copies exact markers/schema. Plugin unload/native transport loss does not universally stop already admitted ordinary native continuations. Registry recognition refuses capacity rather than forgetting required sessions. Corrupted capability evidence is retained and fails closed.

No user-native configuration, installation, reload, service restart/ensure, actual user thread, paid prompt or credentials were changed. Native activation is still a separate manual user action after source handoff. No changes were staged, committed or pushed. Final formatting, lint, nine-package typecheck, full Vitest, browser qualification and independent code/security/requirements review remain required.

## Source v2 review corrections and final acceptance ledger

The frozen v1 manifest is retained unchanged at `thread-tools-production-source-manifest.v1.json` (SHA-256 `74ec584c9b0fb42e976685e8c79a3abae8dc3be8a68d89d88be461e38dbddbf5`). The original `thread-tools-production-source-manifest.json` is also preserved. All logs/manifests mentioned here are in the managed temporary directory named above. **Do not cite `thread-tools-production-regressions.log` as final green evidence: it contains failures.**

### Completed v1 results, not acceptance of the discovered defects

- Automatic root completion notification for `sh_134822848001XlyQKBy2Pb1MGS` reported success: **9/9 tasks**, server **1024 files / 4429 tests passed**, **46 files / 103 tests skipped**, 17m16.629s total. Command chain: `bun fmt && bun lint && bun typecheck && bun run test`; exact retained output is `thread-tools-production-root-test-final.log`. This v1 result is not transferred to subsequently edited v2 source.
- Independent security source review `ses_ecb76b1f5ffeu36I1YBb0A1wD3` accepted the v1 encryption/rebound/privacy/integrity, storage/principals/lifecycle, current-owner/input-interval/approval/replay and shared-only boundaries; all five earlier security blockers closed. This is source acceptance with macOS ARM64 native evidence only, not a release/platform-general claim.
- Independent functional review `ses_ecb76b204ffeWZSY1q0FtQJ2C1` found two P2 defects: a post-acquisition activation failure leaked the lease, and timer/foreground readiness raced the enrollment update gate. Requirements review `ses_ecb76b1f4ffe9FFVIb6AdSRKBb` confirmed these plus current-guide drift and missing negative production-readiness regressions. All other stated canonical/setup/history/security/scope requirements were accepted for the frozen v1 source. The parent then authorized only these targeted corrections.

### Targeted v2 changes and evidence

| Finding                                                                            | Correction                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1: acquired lease leaked after canonical auth activation failed                   | Retain the successful `createRuntimeSession` result; use existing `releaseV2PreparedSession` cleanup so its `finally` releases that exact lease even when resource cleanup throws. No runtime owner is installed and no native deletion/binding rollback is introduced.                                          | New activation injection tests cover initial/retry attempts, both normal and throwing cleanup, exactly-once release, zero manager references, aborted event subscriptions, one conserved native history, unchanged binding, and no prompt/journal admission.                    |
| F2: periodic ensure collided with foreground ensure                                | Compatible `ensure()` callers on one enrollment object share one physical update; every continuation rechecks live ownership after settlement. Waiter cancellation does not own/cancel shared renewal; revocation still fences all callers. No reentrant session-queue operation or new nonce/proposal is added. | Production timer renewal RPC is held while ordinary `send` reaches readiness. Releasing it yields one renewal proposal, one new prompt/admission and one canonical child dispatch. Cancelled waiter and owner-revocation cases are covered.                                     |
| F3: current report advertised retired private/remote execution and broad readiness | Updated `docs/reports/providers-opencode-v2.md` to borrowed shared-only/local production, retained read-only history, mandatory manual exact-Location directory URI addition preserving unrelated configuration, five canonical tools, exact bridge versions and macOS ARM64 synthetic qualification limits.     | Source/document delta is limited to the current report and this ledger; historical plans/checkpoints are not rewritten as prior green.                                                                                                                                          |
| F4: no negative production readiness execution coverage                            | Added owned-native production-composition wire faults for missing plugin and wrong issuer/hash/version/inventory, both at startup and before subsequent new turns. The actual guarded RPC, adapter/runtime preflight, SQLite journal/binding and provider snapshot paths execute.                                | Ten negative scenarios per qualified native run assert zero native create/update/prompt/delete, no new admission/fallback/model request, preserved compatible native history/binding/admission, no installed failed owner, and unchanged visible model inventory/configuration. |

Original defect reproduction: `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Runtime.preparation.activation.test.ts src/provider/Layers/OpencodeV2/Orchestration.enrollment.concurrent.test.ts` failed both files / all 3 original cases against v1. Retained log: `thread-tools-v2-review-fixes-red.log`. After the targeted correction and additional cancellation/revocation coverage, the same two files pass **4 tests**; log: `thread-tools-v2-review-fixes-green.log`.

Final focused core command passed **16 files / 32 tests** (`thread-tools-v2-core.log`):

```sh
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/Runtime.preparation.activation.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.enrollment.concurrent.test.ts \
  src/provider/Layers/OpencodeV2/Application.production.graph.test.ts \
  src/provider/Layers/OpencodeV2/ThreadToolsSetup.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.callback.rebound.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.callback.authentication.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.auth.owner.test.ts \
  src/provider/Layers/OpencodeV2/Client.guard.orchestration.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.security.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.registry.races.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.plugin.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.artifact.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.production.test.ts \
  src/provider/Layers/OpencodeV2/Application.composition.test.ts \
  src/provider/Layers/OpencodeV2/Adapter.execution.binding.test.ts \
  src/provider/Layers/OpencodeV2/Runtime.binding.mode.test.ts
```

Owned native **2.0.26 passed 7 files / 8 tests** (`thread-tools-v2-native-2.0.26.log`):

```sh
BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/v2-2.0.26-qualification/cli-darwin-arm64/package/bin/opencode \
BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.26 \
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/Orchestration.plugin.native.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.production.native.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.approval.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.application.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.context.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.model.routing.native.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.readiness.failure.native.test.ts
```

Owned native **2.0.27 passed 10 files / 12 tests** (`thread-tools-v2-native-2.0.27.log`):

```sh
BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=/Users/youpele/.opencode/bin/opencode \
BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.27 \
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/Orchestration.plugin.native.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.production.native.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.approval.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.application.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.context.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.model.routing.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.logical.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.history.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.native.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.readiness.failure.native.test.ts
```

v2 `bun fmt`, `bun lint` and `bun typecheck` passed (nine packages; existing/advisory warnings), with logs `thread-tools-v2-fmt.log`, `thread-tools-v2-lint.log`, `thread-tools-v2-typecheck.log`.

### Final frozen-source acceptance

The immutable **197-file** v2 manifest is `thread-tools-production-source-manifest.v2.json`, SHA-256 **`c370a43d82fe94ca9ff3a692614f69cb8237b02e29a0409846607e13f6cabea5`**. Its seven-path change inventory is `thread-tools-production-source-delta.v2.json`. Both v1 manifests remain unchanged. All changed authored source/test files are ≤400 lines. The parent independently verified all 197 hashes against this v2 manifest, and the implementation session checked again after root completion: **zero deviations** before this explicitly authorized doc-only finalization.

All final v2 independent reviews are green:

| Review       | Session                          | Final outcome                                                                            |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Functional   | `ses_ecb76b204ffeWZSY1q0FtQJ2C1` | Seven-path delta accepted; both P2 findings closed, no new finding.                      |
| Security     | `ses_ecb76b1f5ffeu36I1YBb0A1wD3` | Seven-path scoped pass; crypto/privacy/storage unchanged, no regression.                 |
| Requirements | `ses_ecb76b1f4ffe9FFVIb6AdSRKBb` | Source green; all four acceptance gaps independently closed and all 197 hashes verified. |

The automatic completion notification for **`sh_134a43cc6001LQ3l3X6e8Rim08`** reported actual successful completion of **`bun run test`**, shell exit **0**, **9/9 tasks successful**, **2 cached**, total **15m47.788s**. No failed test or task was reported. Exact retained output: **`thread-tools-v2-root-test.log`**. This run followed the final serialized v2 formatting/lint/typecheck checks and did not overlap the earlier completed v1 root run.

| Package    | Test files passed / skipped | Tests passed / skipped |
| ---------- | --------------------------- | ---------------------- |
| scripts    | 23 / 0                      | 128 / 0                |
| contracts  | 29 / 0                      | 191 / 0                |
| desktop    | 74 / 1                      | 431 / 4                |
| mobile-web | 41 / 0                      | 212 / 0                |
| shared     | 47 / 0                      | 359 / 0                |
| web        | 455 / 0                     | 2815 / 0               |
| server     | 1026 / 47                   | 4433 / 104             |

Skipped cases are explicitly gated live-vendor/platform/owned-native qualifications, not silently counted as passes. Required macOS ARM64 native 2.0.26/2.0.27 bridge scenarios ran separately with the supplied disposable binary gates and passed as recorded above; Linux/Windows native execution and live-vendor behavior are not claimed. No paid prompt, user-native configuration/installation/activation/reload/service action or real-user thread mutation occurred.

**Code green: Yes. Implementation/Plan green: Yes.** No unresolved in-scope finding or implementation blocker remains. Manual selected-Location plugin activation remains an explicit future user action, not part of source implementation acceptance. All changes remain uncommitted/unpushed; review comments about readiness to merge do not authorize git publication.

Only this ledger document was changed after source freeze to record final results. The frozen source manifest is not rewritten: its ledger entry identifies the reviewed pre-finalization bytes. A separate `thread-tools-production-final-doc.json` records the final ledger SHA-256, formatter-check result, preserved v2 manifest hash and doc-only deviation. No full code checks are rerun for this documentation-only acceptance update.

## Consolidated artifact-foundation evidence

Consolidated on 22 October, 2026 from the superseded 13 October four-tool foundation checkpoint. Its statement that production was not implemented described that earlier slice, not today's app. Later production wiring and acceptance above supersede its implementation TODOs; current release qualification still belongs to the [gap-closure ledger](opencode-v2-gap-closure-final-2026-10-15.md).

- The real native resolver rejected a configured absolute module file even though Node/Bun imported it. Native v2.0.26 source `packages/core/src/config/plugin/source.ts` at commit `9b4ec5714d481559990db0a816d5dec19541a814` required a directory. The correction exported an immutable dependency-free directory containing private ESM `package.json` and `server.js` forwarding to `index.mjs`; setup used `artifact.pluginUri`, not the internal `artifact.entryUri`. Public plugin resolution preferred `server` then `index`.
- Artifact identity hashed the final module and resolver metadata in deterministic ASCII filename order, excluding its manifest. `import.meta.url` supplied nominal parent-directory identity only; no circular self-hash, native byte attestation or remote package trust was claimed. App-owned file verification remained authoritative within host-user trust.
- The then-four-action protocol, issuer/storage primitives, signed enrollment/renewal/revocation registry, native schemas and callback fixture existed without production business dispatch. The fixture returned synthetic responses; callback success alone did not prove canonical HTTP/SQLite actions, approvals, receipt admission or cross-provider routing.
- Historical macOS ARM64 native runs passed one file / one test per actual version, zero skips: 2.0.26 executable SHA-256 `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`; 2.0.27 SHA-256 `7fa5c8659e57cae76b1da4f45edbc583aef93aae917246a0b3abb1ac1b3fb93c`. Fixture version/PID had to match the owned child. Both used disposable private HOME/XDG/database/config/workspaces and synthetic loopback credentials, never user sessions or paid model calls.
- Proof covered directory loading, exact issuer/artifact identity, enrollment/renewal/inspect, all four historical tools with native session/message/call/agent context, denied native subagents, and callback-down failure with zero additional synthetic model requests. It did not qualify today's five-tool surface, other releases/platforms or production canonical execution.
- Historical ordinary artifact tests covered exact reuse and altered/link/public-readable refusal, stable identity, lost-ACK readback, stale/conflicting/revoked records, auxiliary filtering and foreign-definition collisions. Root formatting/lint/nine-task typecheck and the frozen partial-foundation full suite passed (8,521 tests / 104 skipped), but did not provide independent production approval. The source manifest and logs used `thread-tools-foundation-source-2026-10-13.sha256` and `thread-tools-foundation-{lint,typecheck,test}-2026-10-13.log` under the original temporary OpenCode directory; those old freezes must not be rewritten or promoted into current qualification.

Retain the narrower artifact proof separately from the later canonical permission/callback/receipt security evidence above. A current registry entry requires its own complete reviewed evidence, not transfer of these old results.
