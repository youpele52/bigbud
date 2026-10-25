# OpenCode V2 native subagents: gate G4 evidence (2026-10-16)

Plan: [Claude Agent SDK and subagent display](../plans/2026-10-16-claude-agent-sdk-and-subagent-display-plan.md), Phase 4. Decision D1: enable V2 native subagents only when gate G4 passes, with automated evidence that children inherit the parent's permissions.

## Current disposition — repository source, 2026-10-21

The integration and portable native source contribution are **implemented and source-reviewed**.
The parent reports that the targeted fixer and final independent security/requirements
re-review closed the reported findings, including the final cached-zero physical-drain
authority P1 (**RESOLVED**, source-only). This supersedes the earlier partial-observer
and missing-implementation statements below, not the external qualification boundary.

Delivered source includes:

- Pre-execution policy ceilings preserving stricter child deny/ask rules, exact owned
  approval/question routing, durable enrollment and generation-fenced Stop/rearming.
- Native-private completion ID reservations/tombstones and immutable payload-bound
  admission receipts; cancellation cannot make an old receipt authenticate replacement text.
- Root/child/nested shell cancellation by actual native job ID, physical finalizer drain,
  handoff cleanup and retention of managed running-shell recovery records even without a
  cancellation marker. Host exit, model idle and synthetic notices are not shell-death proof.
- Per-child terminal closure independent of live siblings, while family activation remains
  reserved. Migration 135 carries `retainedFamily` through the repository/projector and
  full/mobile/operational SQL queries into browser hydration and the cardless main Stop.
- Unknown-by-default physical-drain authority independent of cached pending counts. Only
  an exact stopped/settled barrier for the current root/input/generation can establish it;
  admission, dispatch and executable callbacks invalidate it. Late old proof or reconnect
  cannot retire newer authority. Host loss retains admission, guard, binding quarantine and
  canonical Stop even with cached zero, no child cards and a previously false retained flag.

The source patch targets immutable OpenCode **v2.0.26** commit
`9b4ec5714d481559990db0a816d5dec19541a814`; it adds the plugin-only
`ctx.session.family` ABI `opencode.native-family.v1`, not a dependency upgrade or
invented HTTP endpoint. The frozen `bigbud.thread.v2` bootstrap is unchanged. See the
[native prerequisites](../decisions/2026-10-21-opencode-v2-native-family-prerequisites.md)
and [portable source/artifacts](../../patches/opencode-native-family-v1/README.md).

### Completed parent validation and review

These are separate parent-reported batches from the completed correction pass, **not
reruns in this repository-build pass and not additive totals**:

| Batch                                              | Result                                             | Scope/limitation                                                         |
| -------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Shell/restart source regressions                   | 16 native source-unit tests passed                 | Historical isolated source checkout; no native host/model launch         |
| Server lifecycle and SQL correction                | 29 tests passed                                    | Repository/scripted integration fixtures                                 |
| SQL-to-browser model/composer                      | 1 test passed                                      | Actual SQLite projection/snapshot hydration, no fabricated retained flag |
| Deterministic settlement correction                | 3 tests passed                                     | Reservation-write gap and retained family holds                          |
| Final cached-zero authority correction             | 22 focused tests passed; 13 intentionally excluded | Focused selection, not a native qualification run                        |
| Independent source/security/requirements re-review | Reported findings closed; final P1 RESOLVED        | No executable, platform or plugin-stack qualification claimed            |

Earlier 141-native/214-server/15-logic/8-browser counts and broad quality results belong
to earlier source snapshots; they must not be combined with these batches or relabeled
as a fresh whole-workspace green result. The parent's settlement fixture corrections
and the `toReversed()` drain / `toSorted()` exporter changes are preserved.

### Repository-only artifact audit and build

This continuation reads and builds **only this repository**. It does not inspect,
modify, build, test or launch the old external checkout or an installed application.

- The current portable patch hash is
  `4b0e0d2b9731d6ab826af5b375b0eda8db1cb54cd9ea0315c35089f34289b9fd`.
- Manifest source digest `63a01d5479a5934de6b18b3af0346e5bf3e571fb1f913f75721cd093418e28cb`
  matches the generated source stamp embedded in the patch. All three pure-module hashes
  and the ledger hash match the manifest; `nativeQualification` remains false.
- All 68 patch sections parse with matching hunk counts. All 47 complete added source/test
  files are at most 378 lines; changed hunk coordinates end by line 393. Generated modules
  are 396/127/18 lines. Recomputing the full source digest, reapplying to baseline, or
  recounting unchanged baseline tails would require the native checkout; those operations
  were **not** repeated. The prior complete 68-file byte-exact audit remains historical evidence.
- Nothing was regenerated or hand-edited in the patch, stamp, manifest or fixture modules.
  The read-only audit record and build logs are under ignored `.turbo/opencode-family-build/`.

| Command                                                             | Result | Output/boundary                                                    |
| ------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `bun run --cwd packages/contracts build`                            | Passed | ESM/CJS and declarations in `packages/contracts/dist`              |
| `bun run --cwd apps/web build`                                      | Passed | `apps/web/dist`; non-fatal plugin timing / large-chunk warnings    |
| `bun run --cwd apps/server thread-tools:manifest:check`             | Passed | Frozen implementation build preflight; no generated source writes  |
| `bun run --cwd apps/server thread-tools:native-qualification:check` | Passed | Read-only preflight; zero qualified records, `qualified:false`     |
| `bun run --cwd apps/server tsdown`                                  | Passed | Server ESM bundle/maps and isolation helpers in `apps/server/dist` |

`@bigbud/shared` has source subpath exports and no standalone build script; its code is
consumed by these builds. No marketing, desktop or mobile target was built. The full
`apps/server` build script was intentionally not run: its packaging CLI compiles and
executes a native workspace-agent `--check`, outside this no-native-executable scope.
The server bundle is compiled, not a packaged distribution with client/native assets.
No server/app was started, package installed, artifact published or qualification enabled.

Final format/lint/typecheck/test checking for the documentation/capability-rationale
edits belongs to the parent's **targeted** `format-lint-test-fixer`; no root/global
quality command or test suite was run in this pass. Suggested smallest code regression:
`bun run --cwd apps/server vitest run src/provider/providerSubagents.conformance.test.ts`.

### Remaining external prerequisite

Production remains **gated**, not enabled by a local build. The native isolation approval,
release qualification and exact family qualification registries are empty. An independently
approved environment must separately build/qualify the exact native source/artifact/plugin
stack and exercise real lifecycle/race/recovery behavior; scripted loopback responses can
avoid paid model calls. No approvals are fabricated and no installed-app, deployment,
global-configuration or native-service state is asserted here.

## Historical outcome: 2026-10-16, before the native-family implementation

The remainder of this ledger preserves earlier delivery evidence. Statements that
routing/guard/Stop/hydration code was missing describe those historical phases only;
the current source disposition and non-additive validation batches above supersede them.

The `subagent` rule stays `deny` in `v2SharedToolPolicy` (`apps/server/src/provider/Layers/OpencodeV2/Runtime.policy.shared.ts`) and `v2LocalToolPolicy` (`Runtime.policy.ts`). The read-only observer ships, but stays inert: while the policy denies the tool, no child session exists, so V2 shows no subagents and nothing is fabricated.

## Historical 2026-10-16 delivery restriction (superseded)

Every G4 item needs frames recorded from a real native probe. A probe requires a live model run in an isolated profile with `subagent` allowed. That run calls a paid provider, and this delivery forbids paid live runs (D2). No recorded child frames exist in the repository: `SharedService.official.ndjson` and `NativeCompatibility.official.ndjson` contain no `session.created` event at all (`parentID` appears only in the recorded OpenAPI text, as a `session.list` filter and as the create-session parameter that "creates a linked child session at its parent's location"), and the pinned 2.0.26 client declarations do not state the child's effective permissions.

The paragraph above records the old delivery rationale, **not a current technical requirement**. Native subagent mechanics can be exercised with a real native executable and scripted loopback model responses; a paid model is not required. The approved qualification-first follow-up authorizes that offline approach, subject to existing clean-runner/image approvals. Conditional paid-call permission is not permission to bypass those approvals.

| Item                        | What it needs                                                                                                                                    | Status                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G4.1 parent linkage         | A recorded `session.created.parentID` and `SessionInfo.parentID` from a real `subagent` call                                                     | Not proven. The 2.0.26 types declare both fields; no recorded frame.                                                                                                                 |
| G4.2 permission inheritance | The child's effective `SessionInfo.permissions` for each runtime mode, and denied/ask outcomes for protected-path edits and `external_directory` | Not proven. The types make `permissions` optional and say nothing about inheritance. This is the safety-critical item.                                                               |
| G4.3 request routing        | Child permission and question requests reaching the parent's owner                                                                               | Not proven. EventHub drops child events by design; routing would need new code and recorded frames.                                                                                  |
| G4.4 interrupt propagation  | Parent interrupt stopping the child, or a bounded child terminal signal                                                                          | Not proven.                                                                                                                                                                          |
| G4.5 observer fidelity      | Observer mapping matching a probe child, with no child mutation                                                                                  | Partly: `Runtime.subagents.test.ts` proves the mapping and the read-only behavior against synthetic `SessionInfo` shapes from the 2.0.26 types. Matching a real probe is not proven. |

## What was tested in the 2026-10-16 phase

- `Runtime.subagents.test.ts`:
  - an active child maps to a `providerSubagent` task (`opencodeV2:{threadId}:{epoch}:{childId}`, model `{providerID}/{id}`, tokens and cost, created time);
  - outcomes map to completed, failed and stopped, with end time and duration;
  - a failed read demotes known children to "last seen" and never fails the parent turn;
  - forks and unrelated sessions are never subagents; the child is never read or written directly;
  - observer events carry no top-level `turnId`, so they are never turn liveness evidence;
  - the observer stays inert without a subagent call, a child hint, or a live child;
  - an EventHub child hint refreshes the observer through the coalesced repair queue;
  - the `subagent` action is denied in every runtime mode, for both shared and local policies.
- `EventHub.children.test.ts`: child hints from `session.created.parentID` and observer reads, at most 32 children per owner, unknown IDs still dropped, owners never receive child events, deltas never hint.

## Re-run

Re-run G4 on each V2 runtime upgrade, and when a recorded native probe becomes available. Enabling requires changing the `subagent` rule per mode and deliberately updating `Runtime.policy.test.ts`, `Runtime.accessModes.test.ts`, `Runtime.policy.shared.paths.test.ts`, `SharedService.legacy.fixture.ts` and `Runtime.subagents.test.ts`.

## Qualification-first follow-up: 2026-10-20

### Native prerequisites remain blocked; no enabling claim

- `SharedService.native.isolation.approvals.ts` contains no approved clean-runner/image record. `requireV2NativeIsolation` rejects before inspecting or executing a retail binary, creating a profile, or invoking a fixture configuration callback. No approval record was added, no native executable launched, and no production/global configuration changed.
- `NativeCompatibility.qualification.registry.ts` contains no completed native release qualification. Neither a matching version nor synthetic unit tests may populate that registry.
- The installed Promise client is `@opencode/client` **2.0.26**. Its declarations describe data/API shapes, not a non-widenable parent/child security intersection.
- Current [V2 permissions](https://opencode.ai/v2/docs/permissions) and [plugin documentation](https://opencode.ai/v2/docs/build/plugins) distinguish an agent's configured rules, inherited session-scoped rules, and durable project-scoped saved approvals. Session rules are evaluated after agent rules; appending a parent's allow or ask rules can therefore override a child's stricter deny. Saved approvals are not inherited policy configuration.
- Official immutable [v2.0.26 source](https://github.com/anomalyco/opencode/tree/v2.0.26/packages/core/src) (`session.ts`, `permission.ts`, `tool/plugin/subagent.ts`, `plugin/hooks.ts`) supports a possible awaited child-progress boundary before prompt admission, but public permission hooks run sequentially and expose mutable effects. There is no documented final-clamp priority in this contract. This is a prerequisite to resolve/qualify against the supported plugin stack, **not proof every native installation is unsafe**.

`Subagents.native.permissions.test.ts` adds an opt-in **negative prerequisite probe**, using the existing approved native fixture and actual HTTP permission evaluator. It creates only idle linked sessions, compares inherited rules against an explicitly empty session overlay, checks child/sibling request isolation and once-only approvals, and asserts zero model requests. It does not execute a native `subagent` tool, install a guard, prove pre-execution interception, or count as G4 qualification. It is skipped without an explicit fixture binary; when requested, the existing isolation approval gate still runs first.

`Subagents.prerequisites.test.ts` tests that isolation cannot be bypassed by the probe callback and that all shared/local/synthetic-remote/disabled policy paths still deny named subagents in every runtime mode. These are application gate tests, not native execution evidence.

### Safely delivered read-only observer work

- Parent-scoped child pagination is now complete within a 32-child retained-observer bound, a bounded page/cursor budget and one five-second observation deadline. Repeated cursors, duplicate children, overflow, malformed sessions, wrong project/Location and invalid activity inventories demote known live activity instead of publishing partial fresh snapshots.
- Missing or regressed live children become last-seen, never inferred completed/deleted. Terminal children survive missing/regressed observations; reopening requires an updated revision newer than both the retained metadata revision and terminal idle marker. Idle/outcome markers also order terminal evidence when native `time.updated` does not advance. Updated native revisions are published even when visible content is unchanged.
- A child's first parent-turn association requires an exact native launch-call `metadata.sessionID` match in the current admitted projection. Discovery during a later turn does not prove that turn launched it; unproven associations remain absent. A proven original association survives newer parent turns. This is **in-memory lineage only**, not durable reconnect identity; task IDs still use the existing epoch scope.
- Assignment, bounded prompt, explicit foreground/background and parent-tool identity are mapped only from an exact native tool `metadata.sessionID` match. Known assignments survive later root projections that omit the launch tool. The assignment index scans parent output once and retains entries only for the bounded observed children.
- Tests exercise runtime reconciliation, the pinned HTTP client and real SQLite-backed admission fixture. They also cover delayed reads whose owner fence expires. They are synthetic application tests, **not native permission or cancellation qualification**.
- No child messages are read or mutated, no child requests are automatically replied to, and task events still omit top-level `turnId`; observer output never proves root-turn liveness.

### Historical missing implementation after the 2026-10-20 observer phase

The approved guard artifact/ABI and its qualification are not installed or implemented by this blocked phase. A qualified non-widenable ceiling and before-execution enrollment, exact child approval/question routing, owned nested/background cancellation with spawn/wake fencing and confirmed settlement, durable identity/cancellation recovery, independent idle observation and accessible main Stop, narrowly correlated native subagent completion continuations, child progress/results and duplicate-presentation/browser checks remain incomplete. Normal root completion is not changed to cancel background children. Existing shell-background continuation and V1/shared-card work is preserved, not credited as native V2 subagent completion.

Next prerequisite: provision and independently approve an existing-policy-compliant clean runner/image, then run the negative evaluator probe and real native tool lifecycle probes using scripted loopback responses. Do not invent approval entries, promote skipped probes, loosen the gate, mutate child permissions after execution, or make paid calls to compensate for missing infrastructure.

### Validation of the blocked-phase source

- `bun fmt`, `bun lint`, `bun typecheck`: passed; the final typecheck completed all nine workspace tasks. Existing lint warnings/Effect refactor diagnostics were not promoted to feature cleanup. All authored/materially edited subagent files are below 400 lines.
- The regression command below passed **42 files / 185 tests**, with the **one native permission probe skipped**. The skipped probe provides no native evidence.
- `bun run --cwd apps/web test:browser src/components/chat/agents/`: **3 files / 9 tests passed**, preserving the existing shared-card work; this is not coverage of the still-missing native child-request/idle-Stop UI.
- `bun run test`: attempted, then deliberately terminated after **24m52.88s**, with eight of nine workspace tasks complete. The incomplete server run reported timeouts in `SharedService.windows.test.ts` and `terminal/Layers/Manager.lifecycle.test.ts`. Both passed a later isolated rerun together with the subagent/conformance files (**8 files / 43 tests passed, one native probe skipped**). Another concurrent focused run and a typecheck attempt timed out; the later serial reruns passed. No full-workspace green claim is made.
- Requested `code-consistency`, debugging, validation, security and final requirements-review delegations were rejected by the configured subagent depth limit of 1. That setting was not changed. Direct source/checklist review is not independent review clearance. Full implementation/plan green remains **No**.

```sh
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/Runtime.subagents \
  src/provider/Layers/OpencodeV2/Subagents.prerequisites.test.ts \
  src/provider/Layers/OpencodeV2/Subagents.native.permissions.test.ts \
  src/provider/Layers/OpencodeV2/EventHub.children.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.native.isolation.test.ts \
  src/provider/providerSubagents.conformance.test.ts \
  src/provider/Layers/Opencode/ \
  src/provider/Layers/Claude/Adapter.stream.subagents \
  src/provider/Layers/Codex/Adapter.stream.subagents \
  src/provider/Layers/Copilot/Adapter.mapEvent.subagents.test.ts \
  src/provider/Layers/Pi/Adapter.stream.subagents.fields.test.ts \
  src/provider/Layers/Pi/Adapter.stream.asyncSubagents.test.ts \
  src/orchestration/Layers/ProviderRuntimeIngestion.subagents.test.ts
```

### Bounded independent-review correction pass

The parent obtained independent code and security reviews after the blocked-phase handoff. Security review reported no introduced vulnerability in the partial observer and confirmed that native launch still requires an independently approved clean macOS ARM64 runner/image. Code review identified P2: first discovery had incorrectly assigned the current root turn without a correlated launch. The correction removes that guess; a regression completes turn A after failed child reads, admits unrelated turn B, then discovers A's child through a delayed hint and requires both payload and top-level `turnId` to remain absent. Positive exact launch correlation and original-turn preservation remain tested.

Additional regressions preserve newer terminal outcome/end-time evidence across older, missing or conflicting idle markers, including equal `time.updated` and newer unrelated metadata revisions. A newer idle marker can advance the terminal without an updated metadata timestamp; an intermediate metadata revision cannot reopen a later terminal. Existing outcome fixtures now supply actual distinct terminal idle evidence instead of relying on conflicting equal-revision outcomes.

Assignment tests verify shared URL-credential/bearer redaction and bounded oversized prompts/descriptions. Full `observeV2Subagents` tests expire the owner during listing or activity reads and require no task publication **and no hub child-index update**. The provider report now states that paid calls are unnecessary and names the real native prerequisites.

External provisioning/approval runbook: [`opencode-v2-native-qualification-2.0.29-2026-10-15.md`, “Runbook (two passes on the hosted runner)”](opencode-v2-native-qualification-2.0.29-2026-10-15.md#runbook-two-passes-on-the-hosted-runner), implemented by `.github/workflows/opencode-v2-shared.yml` (`macos-arm64-qualification`) and `apps/server/scripts/assembleThreadToolNativeQualification.ts` (`provision` / `verify`). Runner acceptance, generated provenance approval and later evidence promotion are explicit external actions, not permissions to hand-author approvals or launch on this host. Existing qualification scopes do not themselves prove G4.

The correction is still a partial observer delivery, not enabled native subagent support. No native launch, paid request, production configuration change, infrastructure approval or git publication occurred. The full workspace test suite is not rerun for this bounded pass; historical counts above are not transferred as fresh correction evidence. Parent post-correction review is separate from the prior independent findings.

Correction validation: `bun fmt`, `bun lint` and `bun typecheck` passed (nine workspace typecheck tasks). The scoped command below passed **11 files / 47 tests** and skipped **one native permission probe**; that skip is not qualification. The seven reproduced attribution/terminal regressions passed after correction. All materially edited subagent source/test files remain below 400 lines (largest: `Runtime.subagents.ts`, 234 lines).

```sh
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/Runtime.subagents \
  src/provider/Layers/OpencodeV2/Subagents.prerequisites.test.ts \
  src/provider/Layers/OpencodeV2/Subagents.native.permissions.test.ts \
  src/provider/Layers/OpencodeV2/EventHub.children.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.native.isolation.test.ts \
  src/provider/providerSubagents.conformance.test.ts
```
