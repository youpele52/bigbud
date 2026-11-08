# OpenCode V2 upgrade and recovery investigation — 2026-11-07

The supplied screenshot is explained by a blocked bigbud plugin upgrade. The installed native service responds, but its bigbud plugin uses bootstrap ABI v3 while the current application requests v4. Two retained owners lack completed retirement evidence. Setup requires that evidence before replacing the plugin, while ordinary dead-backend recovery runs later in session startup.

There is also a filesystem device-number transition affecting installation identity. Fixing only that metadata cannot authorize the ABI upgrade; fixing only owner retirement may expose the identity blocker next.

## Scope and evidence

This investigation used current repository source, a delegated read-only clarification, local installation/enrollment metadata, authenticated loopback metadata requests, focused tests, official OpenCode documentation, versioned upstream source, and upstream issue reports. No prompts, native session mutations, plugin replacements, service restarts, credential changes, or production recovery operations were performed.

Local record observations describe the contents of the signed-record files; this investigation did not independently verify their signatures. The runtime plugin inventory and read-only `info` RPC corroborate the installed artifact and ABI. The screenshot's exact errors were not recovered from the bounded log searches, so the original failed request is not independently reconstructed from a trace.

| Observation                                 | Result                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Native service registration and `/api/info` | OpenCode 2.2.5, PID 10103, responding on loopback                                      |
| Repository client dependency                | `@opencode/client` 2.1.4                                                               |
| Current user's installed scoped plugin      | Active; artifact `42983fb3…`, bootstrap ABI v3                                         |
| Desired artifact exported in app state      | `a0b5d5cf…`, bootstrap ABI v4                                                          |
| Installed / desired schema                  | `614c41…` / `024e26…`                                                                  |
| Installed / desired native contract         | `7d05fb…` / `5c4227…`                                                                  |
| Loaded v3 tool surface                      | Five thread tools; no `render_html`                                                    |
| Other native registrations                  | A second issuer-scoped v3 plugin and a legacy v1 plugin, all active under distinct IDs |

State inspected: `~/.bigbud/userdata/opencode-v2-thread-tools`. Native configuration: `~/.config/opencode/plugins`. Authentication was used only for loopback requests and was not included in diagnostic output.

The distinct issuer IDs are not, by themselves, a namespace collision. They should not be removed as a generic cleanup step.

## Confirmed failure chain

1. [Readiness](../../apps/server/src/provider/Layers/OpencodeV2/Orchestration.readiness.ts) compares the loaded plugin's issuer, registration, artifact, ABI, compatibility, schema, native version, and tool list. Any mismatch produces the same `bootstrap-contract-incompatible` reason. Here, the observed v3 ABI and five-tool surface demonstrably differ from current v4.
2. [Retained bootstrap selection](../../apps/server/src/provider/Layers/OpencodeV2/Orchestration.readiness.manual.ts) explicitly declines a managed v3 installation when the preferred bootstrap is v4. Its `return undefined` sends setup toward replacement. Filesystem identity checks can intervene before that branch on the affected installation.
3. [Registration](../../apps/server/src/provider/Layers/OpencodeV2/Orchestration.registration.ts) uses the same issuer-scoped registration ID and managed filename for v3 and v4. Replacement therefore affects the old owners of that registration too.
4. [Activation activity](../../apps/server/src/provider/Layers/OpencodeV2/PluginSetup.activation.activity.ts) scans all matching persisted enrollments absent from the current in-memory participant map. It calls `assertSettled`; it does not initiate dead-backend retirement. An unsettled record throws the exact retained-owner message from the screenshot **before** native foreground/shell activity is read.
5. [Session startup](../../apps/server/src/provider/Layers/OpencodeV2/Runtime.sessions.ts) awaits readiness before `beforeSharedHistory`. The latter invokes existing per-session recovery through [lazy orchestration](../../apps/server/src/provider/Layers/OpencodeV2/Application.orchestration.lazy.ts). It cannot unblock a readiness failure that prevents reaching it.
6. The setup error propagates to the failed turn. [The recovery notice](../../apps/web/src/components/chat/view/ThreadRecoveryNotice.logic.ts) supplies the final “Could not reconnect” banner. That banner is not independent evidence of a second transport failure.

This is an ordering and recovery-coverage gap. The refusal to replace a plugin while ownership is uncertain is intentional; removing that protection would hide the defect rather than repair it.

### Retained owners on this installation

| Owner prefix | Stored state               | Retirement evidence                                       | Recorded old backend    |
| ------------ | -------------------------- | --------------------------------------------------------- | ----------------------- |
| `f7904ca…`   | Active, heartbeat pending  | No retirement record                                      | PID 13014               |
| `f92895d…`   | Revoked, heartbeat pending | `retiring`; no detach acknowledgement or settlement proof | PID 22396               |
| `f6af76b…`   | Revoked                    | Settled                                                   | Not the blocking record |

The two blocking backend PIDs were absent at inspection. Their records date to October 25–26 and reference an OpenCode 2.1.4 transport generation. PID absence alone is not sufficient retirement authority: the existing recovery code also checks backend identity/lock ownership, native activity, exact cleanup acknowledgement, and receipt fencing.

One blocker belongs to the bigbud checkout and another to the Documents location. A fresh chat can still fail because the activation scan is registration-wide, rather than limited to the new chat's history. Retry repeats the same durable checks; merely waiting for native activity to finish cannot create missing retirement evidence.

## Second blocker: installation identity after device renumbering

The signed installation records device `16777230`; current root, plugins directory, and managed plugin report `16777231`, with the corresponding inodes unchanged. This is consistent with the device-renumbering case the code anticipates, but is not independently sufficient proof of a safe reboot transition.

No `recovery/` sibling directory was present in the inspected app state. [Installation revalidation](../../apps/server/src/provider/Layers/OpencodeV2/PluginSetup.revalidation.ts) requires an existing signed same-host reboot proof; [automatic revalidation](../../apps/server/src/provider/Layers/OpencodeV2/PluginSetup.revalidation.automatic.ts) delegates to that observation and only adopts the exact installed artifact.

Consequences:

- The automatic metadata path lacks required evidence in this installation.
- The existing explicit preparation path also depends on reboot evidence; a generic instruction to approve maintenance is not a complete recovery procedure for this state.
- Metadata-only adoption of v3 cannot authorize replacing it with v4.
- The current retained-owner error conflates installation maintenance with retirement and does not identify which proof is missing.

## Why earlier fixes and passing tests did not resolve this

The November 5 integration commit `f8c6e9e37e` includes the current v4 bootstrap/default implementation and the explicit v3-to-v4 replacement branch. The installed plugin dates to October 25. This supports an application upgrade exposing older retained state; it does not establish every event that left the two owners unsettled.

Existing tests cover useful but separate invariants:

- `PluginSetup.activation.retained.fixture.ts` deliberately supplies a **synthetic same-ABI v3 successor** for the successful retained-adoption path. Its test also confirms that the actual v4 preference declines v3 adoption, but does not prove the full breaking upgrade recovers old owners.
- `PluginSetup.activation.activity.test.ts` proves that active, pending, revoked, and expired records remain barriers until retirement proof is supplied.
- `Orchestration.selection.htmlUpgrade.test.ts` constructs detach and settlement evidence directly before asserting upgrade selection.
- `Orchestration.enrollment.restart.test.ts` exercises backend restart retirement separately from breaking plugin activation.

Thus, successful retained-bootstrap, retirement, and reboot tests do not establish successful composition of **old v3 installation + unsettled dead owners + new v4 requirement + changed device identity**.

## What official OpenCode material establishes

The current [V2 JavaScript client documentation](https://opencode.ai/docs/build/client) specifies `@opencode/client`, resource methods, plugin RPC, and the shared local service. The older [SDK page](https://docs.opencode.ai/docs/sdk/) documents `@opencode-ai/sdk`; it should not be treated as the V2 integration contract. Our V2 client dependency belongs to the correct family.

The [plugin lifecycle documentation](https://opencode.ai/docs/build/plugins/server) describes setup and cleanup on load/unload. The [RPC documentation](https://opencode.ai/docs/build/plugins/rpc) requires a configured, running server plugin and supports read-only calls such as our `info` method through the generic RPC endpoint. Those reads succeeded against this service. The durable issuer/enrollment/retirement protocol in the screenshot is bigbud's additional layer, not an OpenCode setup requirement.

The client docs describe live-only event subscriptions without replay or automatic reconnection. Versioned [2.2.5 shared-event source](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/client/src/shared-events.ts) additionally shows bounded subscriber queues and termination on overflow. Current prose and versioned implementation differ in their backpressure description, so recovery work must use the actual pinned client and native version. These transport properties are relevant to broader reconnect reliability, but they do not explain the observed pre-admission ABI/retirement failure.

Versioned [2.2.5 plugin supervisor source](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/supervisor.ts) retains a prior generation for certain module-load failures and handles duplicate plugin IDs. Its [reload tests](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/test/plugin/supervisor-reload.test.ts) cover local reload behavior. This reinforces the need to verify the loaded contract after publication; plugin inventory alone is insufficient.

Upstream also has relevant reports, which are **not reproduced causes of this incident**:

| Upstream report                                                                                           | Relevance                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [#60229: rapid config reload leaves plugins unloaded](https://github.com/anomalyco/opencode/issues/60229) | Add a concurrent reload case to native activation validation; do not assume each reload completes successfully. |
| [#59635: service restart resumes suspended work](https://github.com/anomalyco/opencode/issues/59635)      | A restart should not be treated as harmless cleanup or permission to resend.                                    |
| [#36347: permission/question waits across restart](https://github.com/anomalyco/opencode/issues/36347)    | Pending interactions need explicit reconciliation rather than assuming their old IDs remain answerable.         |

The release page lists [2.2.6](https://github.com/anomalyco/opencode/releases/tag/v2.2.6) after this installed 2.2.5 service. Updating the native CLI or client alone would not create bigbud retirement/reboot evidence, and no evidence found establishes such an upgrade as the fix for this screenshot.

## Recommended repair plan

1. **Add a combined regression first.** Seed an installed v3 bootstrap with two old owners in different locations: one active with a pending heartbeat and no retirement, one revoked with partial retirement. Request v4 from a fresh chat. Include dead and live backend variants; exercise startup/setup orchestration rather than constructing settlement manually.
2. **Give upgrade preparation a recovery phase before replacement readiness.** Reuse the existing dead-backend retirement service, with exact original-owner routing and receipt fencing, for every same-registration owner blocking replacement. Do not merely move single-session `beforeSharedHistory` earlier: that would leave unrelated retained owners blocking the global plugin upgrade. Do not put mutations inside the idle observer.
3. **Keep maintenance and replacement separate.** Diagnose and verify the installed v3 identity first. Provide a concrete, backed-up repair path for installations without historical reboot evidence, with an explicit trust decision and independently validated provenance. The current automatic path cannot manufacture that evidence. Only then settle eligible owners and authorize v4 publication under the existing admission gate.
4. **Report actionable reasons.** Preserve safe mismatch field names, installed/required ABI, blocker count, retirement phase, and whether recovery can proceed. Distinguish retryable activity from durable maintenance blockers. Avoid showing Retry or “new thread” as if either necessarily bypasses registration-wide failure. Do not include credentials, callbacks, or signed payloads in diagnostics.
5. **Validate the composed lifecycle.** Cover restart before/during detach, native activity in another location, live/foreign backend ownership, missing or changed installation bytes, device transition with and without proof, multiple issuer registrations, partial publication, reload failure, and reconnect without prompt replay. Use disposable profiles for native upgrade testing; never rewrite the production records to make a test pass.
6. **Refresh documentation after implementation verification.** The existing provider guide still says client 2.0.26 and unknown-version rejection. Current package/source says 2.1.4 and runtime checks for stable V2. Distinguish service/catalog availability from required thread-tool readiness and document the actual recovery action.

The ordering defect is in shared TypeScript and is not inherently macOS-specific. Only macOS state was inspected here. Linux should cover POSIX device/identity transitions separately; Windows should exercise its own file identity and service discovery path. No Linux/Windows native recovery was validated during this investigation.

## Validation performed

Focused command:

```sh
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/PluginSetup.activation.activity.test.ts \
  src/provider/Layers/OpencodeV2/PluginSetup.activation.retained.test.ts \
  src/provider/Layers/OpencodeV2/PluginSetup.revalidation.test.ts \
  src/provider/Layers/OpencodeV2/Orchestration.enrollment.restart.test.ts
```

Result: **4 files, 41 tests passed**. These confirm existing component behavior, not a repaired end-to-end upgrade. At this investigation-only baseline, no source code had been changed. Implementation and subsequent validation are recorded below. Repository-wide checks were not run.

## Implemented recovery and additional live findings

The implementation follows [the repair plan](../plans/2026-11-07-opencode-upgrade-recovery.md). Activation now runs eligible dead-backend retirement across retained owners before the replacement idle check. Existing native activity, original-owner RPC, backend lock, receipt fencing, consent and publication barriers remain in place. Already settled owners do not require their old native storage to remain connected.

For an exact unchanged installation with device renumbering, a separate metadata-only path requires same-host owner provenance and the current backend lock, archives the signed original installation, and conditionally adopts the verified identities under the publisher/admission gates. It does not fabricate a reboot checkpoint or rewrite owner history. Changed bytes/inodes, absent authority and cancelled maintenance are rejected.

The first review identified a preparation-stage lifetime gap: RPC deadlines could expire before abort-ignoring native cleanup finished. Preparation now retains and drains physical operations before releasing the shared publisher or activation. Regression cases cover in-flight cancellation, consent revocation and delayed detach. The review also corrected the inode test to use a valid numeric mismatch.

Compatibility errors now identify fixed field names without including native payloads. A stale loaded contract gets a bounded watcher-settlement window; exhausting it preserves the final safe mismatch. The second review identified that final diagnostic loss, and its correction passed a full-transaction regression.

### Latest native policy action

Testing the real dev server against **OpenCode 2.2.6** initially failed before installation because its OpenAPI policy enum contains `websearch.use`. The current app knew only the previous seven actions. Both [the official policy documentation](https://opencode.ai/docs/policies/) and [versioned 2.2.6 schema](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/schema/src/config/policy.ts) define this action as controlling web-search providers.

The known-action list now includes that exact action; unknown actions still fail closed. The previous v4 signed compatibility descriptor is retained byte-for-byte as N7 rather than being silently rewritten. The actual consumed OpenAPI checks pass for both tested versions after this correction.

### Locationless native session notifications

One initial 2.2.6 full-app turn failed before prompt admission with `dirty generation`; a later fresh turn succeeded. Subsequent native event capture confirmed a locationless durable `session.permissions` notification, locationless ephemeral `session.usage.updated`, and locationless durable `session.execution.succeeded`. bigbud treated these as ambiguous stream sources, although OpenCode's session publishers and bus allow omitted location metadata. See [versioned session source](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/session/session.ts) and [bus source](https://github.com/anomalyco/opencode/blob/v2.2.6/packages/core/src/bus.ts). The capture establishes an additional reproducible invalidation path; it does not prove which individual event caused the earlier failure.

Known locationless session notifications now request an authoritative reread without incrementing the admission's dirty generation. Durable notifications require the exact aggregate/session identity, version and nonnegative sequence. Usage is treated only as an ephemeral hint. No notification payload is delivered as chat content, permission approval or completion proof. Arrival fences still change, and explicit wrong locations, unknown events, invalid durable identities and genuine stream gaps remain protected.

## Implementation validation ledger

- Focused combined run: **16 files / 150 tests passed** before the final watcher-diagnostic and event-hint additions.
- Watcher diagnostic correction: **1 file / 12 tests passed**, including recovery, cancellation and timeout cases.
- Event hint and existing admission/delivery checks: **5 files / 27 tests passed**.
- Explicit changed-source formatter/linter and 400-line checks passed; server package typecheck passed before the final event-hint addition. Final check results are appended when complete.
- Implementation manifest check passed. Native qualification registry check passed with **zero qualified records**: these local tests are not clean-machine qualification or a claim of universal native support.
- No full-suite/workspace checks, commits or pushes were performed.

### Native and dev-server tests

Verified macOS arm64 release binaries were downloaded from the npm registry into a task-owned temporary directory. **2.1.1** was ten stable releases behind the then-latest **2.2.6**. Tarball integrity was verified. SHA-256 executable digests: `2f6fe5c3cf1e7827a93b14c7b07117ef0cde776c32613b0aae70c15e4780f271` (2.1.1) and `90e4d03597b03d2051b65b4d793467764e55bacd8e22bf4824479c7233ea0e15` (2.2.6).

Tests used separate native config/state/data/cache directories, separate bigbud state and a disposable local OpenAI-compatible response endpoint. They used the real native executable, pinned SDK, bigbud dev server, WebSocket orchestration, plugin installation, admission and projected assistant message. The model itself was synthetic, with no paid-provider execution or external credential validation. Separate data directories are not an OS security sandbox. Production OpenCode 2.2.5 and production bigbud state were not upgraded, downgraded or repaired in place.

| Test                                                                             | Result                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Native SDK turn on 2.1.1                                                         | Passed                                            |
| Native SDK turn on 2.2.6 after upgrade                                           | Passed                                            |
| Full dev-server turn on 2.2.6 before policy support                              | Rejected before admission; known-action fix added |
| First full-app attempt after policy fix                                          | Failed dirty-generation fence; recorded above     |
| Subsequent fresh dev-server turn on 2.2.6                                        | Passed                                            |
| Restored disposable 2.1.1 profile, two full dev-server turns                     | Both passed                                       |
| Same native/app profile upgraded from 2.1.1 to 2.2.6, fresh full dev-server turn | Passed                                            |

The native service and dev backend were restarted between versions. The service transition also exercised generation-loss protection and retained cleanup; it did not authorize replay of a failed turn. A saved pre-upgrade 2.1.1 native profile was restored for the downgrade, avoiding an assumption that newer database migrations can run under an older executable.

**Desktop limitation:** the local Electron dev app was launched and selected through bigbud computer use. The tool then imposed its time limit and required renewed user confirmation. The request is pending; completed desktop composer/setup interaction is therefore **not claimed**. WebSocket tests supplement this missing UI check. Linux and Windows native runs were not performed.

### Final follow-up and cleanup

- Restored the original official SDK/SSE transport regression alongside the new hint matrix; the final event/SDK/admission run passed **6 files / 29 tests**. After the TypeScript union-narrowing correction, the two hint suites passed again (**2 files / 16 tests**).
- Final server package `tsc --noEmit` passed with no TypeScript errors; existing Effect advisory messages remain. Explicit formatting, lint, whitespace and 400-line checks passed for the task's **26 changed source/test files**. All **13 local links** in the three touched documents resolve. No repository-wide validation was run.
- After the event fix, **two further full dev-server turns on 2.2.6 passed**, both sessions returned to `ready` with no `lastError`, and no ambiguity/admission-owner warnings appeared during those turns. This is bounded smoke evidence, not proof that all reconnect scenarios are resolved.
- Both requested formal review rounds were completed. A follow-up reviewed the evidence-backed event change; no blocking code/security defect remained. Its request to preserve official transport coverage was completed and verified.
- Task-owned native services, local model endpoint, dev API server and Electron/dev supervisors were stopped. Production service registration remains **2.2.5 / PID 10103**, unchanged from investigation. The disposable profiles/binaries are retained temporarily for the still-pending desktop verification; no production records were rewritten, and no commit/push occurred.
- A separate dev-server restart probe exposed a catalog/command disagreement about an existing project. Subsequent OpenCode smoke tests used newly created disposable projects. This was not established as an OpenCode defect or repaired here; existing-project behavior after restart is not certified by these runs.

### Desktop continuation after access renewal

The user renewed computer-use access. The disposable Electron dev app and OpenCode 2.1.1 service were relaunched, and the exact dev window was selected and captured. Input remains blocked: the tool reports `ax_window_unresolved`, and its permission check confirms **Accessibility is not granted to the bigbud host app**, while Screen Recording is granted. The user was asked to enable bigbud under macOS Privacy & Security → Accessibility. The dev test processes remain ready for that continuation; no desktop send/setup pass is claimed yet.

### Subsequent manual UI tests and stalled recovery investigation (November 8)

The user subsequently supplied screenshots confirming synthetic UI replies before and after the native upgrade, then real GPT-6.1 Sol replies and follow-ups on the normal native service with separate bigbud test data. A same-thread reply after restarting the dev app also passed. These supersede the earlier pending manual UI status, but do not prove original-profile recovery.

The attempted recovery threads later stalled. Read-only inspection of their saved state found stale permission replies returning HTTP 404 and retained native history/model verification failures. The dev app log records a normal Electron exit at 23:52:21 on November 7, followed by the launcher's intentional shutdown of its stack; the separate recovery backend exited with code 130 at 23:53:53. The caller responsible for these exits is not established. Failures preceded those exits, so process shutdown alone does not explain the stalls.

The normal native service returned `variant: "default"` for models whose saved bigbud cursors omitted the variant. `Runtime.reconnect.ts` used strict equality and rejected that equivalent selection. It now reuses `assertV2Model`, the existing session-start comparison. Persisted cursor equality and all other ownership, policy, and history checks remain intact. A regression reproduces the failure and verifies reconnect plus a subsequent turn without history replacement or replay; changed provider, model, and non-default variants remain rejected. Two focused files / nine tests, server package typecheck, explicit formatting/lint, and the two-file 400-line check passed.

Original-profile verification is prepared in `~/.bigbud/backups/opencode-recovery-20261108-run/`. The bounded external runner uses the normal profile lock, takes fresh backups, exercises setup and real-model turns, and audits original message hashes. It must also prove the two original owners settled and the committed installation matches bootstrap v4. It reopens the packaged app after releasing the recovery backend. Its progress and result files are the source of truth; preparing the runner is not a successful original-profile test. No original records have been manually edited or deleted during this continuation.

### Completed original-profile recovery and packaged build

The subsequent [enrollment-release investigation](opencode-enrollment-release-2026-11-08.md) resolved the remaining cleanup-scope and installation-archive blockers. Original-profile recovery passed with production retirement validation for both owners, bootstrap v4 installation, and real-model first/follow-up/backend-restart turns. All 12,832 baseline messages remained unchanged, with six test messages added. This supersedes the earlier pending recovery status.

The macOS arm64 app was then rebuilt separately. All 437 packaged server JavaScript files matched the fresh build, packaged native-helper checks passed, and the user confirmed the rebuilt app works. The local build is unsigned; this does not extend the recorded validation to other operating systems or all native versions. Backups and previous run evidence remain preserved.
