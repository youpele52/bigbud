# OpenCode V2 shared service and compatible runtime plan

**Date:** 9 October, 2026
**Status:** In progress — Ready for implementation
**Owner:** implementation specialist; parent owns final integration/review

## Summary

Make bigbud another interface to the installed OpenCode V2 TUI service, not a
second OpenCode installation/profile. New configuration defaults to shared local
service discovery. Explicit isolated profiles remain an advanced option. Keep the
client dependency at 2.0.26, recommend runtime 2.0.26+, and permit older runtimes
only with recorded real-binary qualification and read-only startup verification.

## Related Work

- [Provider implementation](2026-09-29-opencode-v2-provider-implementation-plan.md).
- [Preview completion](2026-10-08-opencode-v2-preview-completion-plan.md).
- [Owned deletion](2026-10-09-opencode-v2-owned-deletion-design.md).
- [Concurrent attachments](2026-10-09-shared-path-first-attachments.md).
- [Historical 2.0.26 evidence](../validation/opencode-v2-2.0.26.md).
- None identified: no note/card ID was supplied; this plan records the clarified
  parent-session user instruction without inventing a reference.

## Problem

The latest user instruction supersedes **private-profile-by-default** and
**exact-CLI-2.0.26-only** requirements in earlier documents, including the current
attachment plan's preserved pin. Do not erase their historical validation.
The installed shared TUI runtime is reported as 2.0.24 and already authenticated.
An isolated profile cannot truthfully present that account as connected.

Official V2 client docs describe discovery without launch. Pinned Promise SDK
`dist/promise/service.js:29–38` is read-only, but `ensure:66–99` can clear/terminate
an unresponsive service or replace one on version mismatch. Never call `ensure`
or `stop` on the user's daemon. SDK probe source
`dist/chunks/service-timing-8ye1ye6f.js:31–43` fetches a registration URL before
validating its origin, follows default redirects, and decodes unbounded JSON.
Use the documented native registration convention and `Service.headers`, but
validate/bound the registration and transport **before** contacting the endpoint.

## Goals

- Share native auth, config, models/variants, agents, skills and MCP without a
  credential endpoint, credential copy, global config rewrite or plugin injection.
- Discover the existing service and CLI automatically; a binary override alone
  never selects another database. Private mode requires explicit selection.
- Own only bigbud sessions/subscriptions. Detach never kills a daemon, erases
  native history, fabricates physical exit, or discharges uncertain mutations.
- Separate release qualification from startup read-only compatibility checks.
  Runtime version is factual; neither all 2.x nor all versions above a baseline
  are automatically trusted. Qualified older versions run normally with one
  app-session-deduplicated, nonblocking amber update toast.
- Preserve the complete public catalog/grouping/search/recent selection; native
  configured inventory wins conflicts and native integration connection metadata
  determines availability. Ready is green, not a permanent policy warning.
- Preserve durable admission, immutable target identity, no uncertain replay,
  deletion fences, disabled cleanup and no automatic provider fallback.

## Non-Goals

No CLI installation/update, service replacement, real vendor prompt/billing,
database reads/copies, native global mutations, dev-app relaunch, destructive
deletion implementation, Rust protocol change, large attachment stress, V1/Kilo
SDK change, new dependency or git publication. Do not change concurrent attachment,
normalizer, media fingerprint, composer/model-list or existing runtime files.

## Current State

- `Application.composition.ts:24–143` keys private binary/profile, generates the
  coding plugin, starts owned processes, and authorizes that fixed pair.
- `Application.config.ts:9–41` requires absolute private paths and writes a
  marker/catalog directory. This must never run for shared mode.
- `ServerManager.child.ts:19–28,189–251` distinguishes physical exit from transport
  loss; its close is an owned-child kill/lease release, unsuitable for borrowing.
- `ServerManager.ts:89–106,195–234` retains namespaces unless exit is proved;
  borrowed detach requires a separate retirement path, not `hasExited=true`.
- `Runtime.binding.ts:8–49` hashes target/private root and derives deterministic
  IDs. `Runtime.sessions.ts:60–68,170–177` verifies cursor and native ownership.
- `Runtime.mutations.ts:39–43` permits quarantine discharge on physical exit only.
- `Runtime.permissions.saved.ts` fails closed on native project saved grants;
  retain this safety without automatically removing the user's approvals.
- `Client.ts:11–45` already has origin/redirect/body bounds but fixed `opencode`
  username. Factor its transport when file ownership clears, do not duplicate it
  permanently. Foundation read-only probes reuse `boundV2Response` and deadlines.
- `Compatibility.ts:1–12` has the superseded exact runtime assertion; replace only
  after existing-file ownership clears. The dependency itself stays exactly pinned.

## Phases

### Phase 1: independent foundation (authorized now)

Create only new `SharedService.*` concern modules/tests and this plan. No prior
SharedService files were present at initial inspection. Implement:

1. Read-only native registration lookup using inherited XDG state/HOME semantics,
   private regular file/owner checks, bounded bytes, validated loopback origin and
   sanitized stage-specific failures. No raw auth in diagnostics. Reuse native
   `Service.headers`; retain actual username when accepting a native endpoint.
2. Bounded authenticated GET `/api/info` plus `/openapi.json` verification: actual
   version/PID must match registration, all required operation IDs and critical
   input/response contracts must exist. No session creation or prompt at startup.
   Re-read registration after probing to reject replacement races; transport
   generation includes native registration ID/PID, never a password hash.
3. Explicit shipped qualification rows for actual disposable CLI fixtures;
   recommended baseline comparison is separate from compatibility. Never label
   untested 2.0.20/newer releases compatible. Provide a bounded per-app update
   notice deduper for integration, not an always-warning provider status.
4. Disposable real 2.0.24 and 2.0.26 tests with configured synthetic loopback model,
   native agents/skills and sibling TUI-like session. Verify discovery has no
   mutations, prompts remain local, config bytes remain identical and detach
   leaves service/sibling history alive. Record binary provenance and exact
   qualification scope; fixture evidence is not completed application integration.

Exit: focused unit/native tests pass; source <=400 lines; precise integration
handoff. Nested guide/review calls currently fail at depth limit 1; direct review
is not independent clearance.

### Phase 2: settings and stable storage (wait for ownership clearance)

Add `connectionMode: shared | isolated`, default shared, independent binary
override, optional advanced registration path. Preserve historical explicit
private settings/imports as isolated bindings; do not erase paths or migrate
native sessions. Selecting shared applies to new bindings, never reinterprets
an old admission/cursor. Shared storage identity must be derived from verified
canonical native DB/profile namespace; credential rotation/server restart must
not change it. The service info/schema lacks a DB identity today: audit exact
native source for authoritative namespace resolution; fail closed if the running
service's profile cannot be established rather than guessing from bigbud's env.
Keep transport generation separate from storage identity. Explicit same-DB
successor detection must not infer physical exit from a failed HTTP request or
PID alone (PID reuse). Prepared/learning bindings include mode and namespace.

Files: contracts provider settings; settings reader/import/export tests; provider
settings card; `Application.config`, `Runtime.binding`, prepared target/learning
identity. Tests cover legacy sparse settings, mode switching, old cursors, no
resend, account changes and unchanged V1/Kilo values.

### Phase 3: borrowed singleton and native execution

Create one local shared connection/event source across workspace Locations;
per-session ownership remains independent. Factor authenticated guarded client
construction. Integrate borrowed lifecycle into `ServerManager` explicitly:
unsubscribe/close client resources on last release; retain separate uncertainty
records across reconnection and refuse new mutation while unresolved. Logical
entry retirement is distinct from physical daemon exit. Shared leases cannot
`claimExclusive` or mutate process-global MCP state. Disable clears owned local
resources/session work only, never shared daemon/history/config.

Route shared Application composition away from generated coding plugin/private
profile initialization. Native user config/builtins supply tools/agents/skills/
MCP. Session policies follow existing access modes honestly (not a shared
sandbox); native saved grants remain fail-closed for modes they can bypass.
Auto edits must not silently become Full access; use truthful native policy or
explicit ask fallback where bounded helpers are not installed. No new global
helper injection. Remote targets unsupported in shared mode until separately
qualified; never silently fall back to isolated storage/local work.

Files: `Client`, `ServerManager`/lifecycle, `Application.composition/targets`,
`Runtime.sessions/policy/authorization/mutations`, learning target reuse.
Tests: borrowed shutdown, session-own-only stop, mutation uncertainty retention,
settings/reconnect/death races, sibling session/config preservation.

### Phase 4: catalog and compact UI

Use native provider/model inventory first; merge public-only options without
inventing authentication. Poll/refresh safe integration connection metadata on
bounded existing snapshot lifecycle/event changes, so TUI sign-in is reflected
without repeated user refresh. Project only IDs/names/status; never provider
settings/headers/credential values. One older-runtime toast per app session;
unsupported errors state actual runtime/missing feature and manual next action.
Policy prose goes in docs/details, not model dropdown/composer or ready status.
Coordinate with attachment UI owner; do not redo its warning removal.

Files: catalog native/public, development provider, snapshot contract if needed,
existing top status/toast consumption. Browser/unit tests verify ready green,
one toast across reconnect/refresh, auth transitions and full catalog retention.

### Phase 5: serial final checkpoint and review

After all integrations and ownership clearance, run formatting, lint, typecheck,
affected unit/native/browser tests, then one non-overlapping workspace checkpoint.
Review each acceptance criterion; preserve historical evidence and report
unrelated failures without unauthorized fixes. No overall completion until both
Code green and Implementation/Plan green pass.

## Risks And Decision Gates

- Historical concurrency gate: the attachment worker's explicit error/completion
  notification cleared existing-file ownership. Its partial work was preserved
  and subsequent focused validation performed; elapsed time was not clearance.
- Missing-service autostart is not safe through `Service.ensure`. Initial slice
  returns an actionable manual TUI/service-start instruction. Before adding
  automatic start, prove from exact native source that a service contender never
  replaces/stops a racing existing registration; otherwise keep this limitation
  explicit and ask for the narrowly scoped startup approval when required.
- Server profile namespace and physical generation identity require authoritative
  native metadata/source, not a guessed HOME or copied credentials.
- Qualification failures exclude that version; do not weaken permission/replay
  tests to admit it. Matrix scope is recorded explicitly.
- Native configured plugins can have side effects even on Location discovery;
  startup uses only server info/OpenAPI. User Location inventory is a subsequent
  native operation, never a global config rewrite.

## Testing And Validation

Foundation unit seams: missing/invalid/insecure registration, remote URLs,
redirects, auth usernames, oversized/malformed responses, mismatched PID/version,
unqualified versions, missing contracts, replacement races, no lifecycle/global
mutation, no credential leakage and one-time older notice. Native fixtures use
disposable profiles and local synthetic models only; no 10 MiB stress.

Final required commands: `bun fmt`, `bun lint`, `bun typecheck`, focused
`bun run --cwd apps/server vitest run ...`, applicable browser tests and
`bun run test` serial checkpoint. Never `bun test`. During concurrent editing,
format only newly owned files and leave full mutating formatter/full workspace
checkpoint to the coordinated parent. Record this as an incomplete gate.

## Acceptance Criteria

| ID  | Required evidence                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Shared defaults use installed native service/profile/auth with no config/credential copies; isolated opt-in and legacy binding preservation tests. |
| AC2 | Own-session-only mutation; detach never kills daemon or clears uncertainty; sibling TUI session/history/config byte-preservation tests.            |
| AC3 | Real 2.0.24/2.0.26 qualification plus read-only startup contracts; unqualified versions rejected clearly; baseline 2.0.26+ is advisory only.       |
| AC4 | One-time nonblocking older update toast; truthful green ready/auth and compact actionable setup errors.                                            |
| AC5 | Full public catalog remains usable; native configured inventory precedence and automatic safe auth metadata refresh.                               |
| AC6 | Durable admission/no uncertain replay/no fallback/deletion fences/learning target identity preserved across mode/reconnect/config changes.         |
| AC7 | Focused native/unit/browser checks and all repository gates pass, final independent parent review, no publication or real profile/daemon mutation. |

## Open Questions

No unresolved user product choice. Implementation proof gates remain: reliable
native running-service storage namespace, safe non-replacing startup, qualification
results and concurrent existing-file ownership clearance. If those proofs are
unavailable, retain a precise partial implementation rather than inventing
shared storage/physical-exit evidence.

## Implementation Ledger

Phase 1 foundation implemented in new `SharedService.*` files. Real registered
disposable 2.0.24 and 2.0.26 services pass the same pinned-client API/coexistence
fixture, including an active sibling awaiting approval during local subscriber
teardown/owned interrupt. Four unit files / 36 tests pass; `bun lint` and all
9 `bun typecheck` tasks pass. Final unit count is 37 after adding actual-version
unsupported health-probe coverage. Scoped authoritative formatting passed. See
[foundation qualification and wiring handoff](../validation/opencode-v2-shared-service-foundation-2026-10-09.md)
for exact commands/provenance and the narrower qualification scope.

Historical phase-1 handoff: Phases 2–5 remained pending. Application still used historical private/exact-pin
composition; this foundation is not user-visible integration. No concurrent
owner completion notification was received. Passing new-file tests never grants
permission to overwrite existing work. Reliable actual shared storage identity
and non-replacing missing-service start remain proof gates; native source shows
registration replacement can indirectly shut down the previous service.
Whole-tree format/full workspace/browser integration and independent parent
review remain: **Code green No; Implementation/Plan green No** overall.

### Application integration continuation

The concurrent worker's explicit error/completion notification cleared existing-file
ownership and superseded the earlier edit exclusion. Inherited attachment and
unrelated Games work was preserved. Application composition now selects shared
native borrowing for sparse settings; legacy paths remain isolated until an explicit
shared selection. No shared profile marker/plugin is generated. Settings/UI expose
isolated opt-in. Guarded transport accepts native auth headers. Borrowed leases share
one hub across Locations, deny exclusive ownership, and detach without exit claims.
Exact native metadata fences own-session mutations. Retained admissions reject a
changed namespace even with an omitted cursor. Attachments persist in bigbud state.

macOS unique process-open SQLite WAL/database metadata supplies canonical path and
device/inode storage identity, separate from credentials/transport generation.
Ambiguous handles and other platforms fail closed. Native generation change needs
app restart. Automatic native startup remains unsafe and is not implemented.
Native account/inventory refresh runs every 15 seconds, agents/skills feed discovery,
available native models rank before public setup entries, and the older-runtime
toast is browser-tested once per app lifetime with ready status unchanged.

Disposable application plus transport suites pass on **both 2.0.24 and 2.0.26**
(two files/two tests each): active sibling, config/registration bytes, own disable,
stable rebind/replay and attachment replay after snapshot removal. Read-only actual
2.0.24 inventory confirms connected OpenAI and enabled `gpt-6.1-sol` / `high`; no
vendor prompt/native mutation. Browser checkpoint: five files/eight tests pass.
`bun fmt`, `bun lint`, `bun typecheck` pass. Full `bun run test` completed eight
packages but server sandbox execution stalled and exceeded the 1,200,000 ms
foreground limit; a focused sandbox rerun also exceeded 120,000 ms. No task-owned
runner remains. Full server suite and independent parent review remain unverified:
**Code green No; Implementation/Plan green No**. Successful narrower tests are not
full release/platform conformance evidence.

### Parent review and final checkpoint — 10 October

Independent application review is complete for the documented qualified macOS
shared-service scope. Added five ownership/access regression tests and corrected
known-runtime failure snapshots that incorrectly implied the CLI was not installed;
three additional application tests cover health/generation/compatibility errors.
All eight new regressions passed. Parent browser, attachment/discovery, native
2.0.24 and periodic-ingestion checks passed; debugger independently requalified
both 2.0.24 and 2.0.26 after adding bounded disposable-startup diagnostics.
The sandbox passed unchanged; historical long stalls correlate with host sleep.
The fresh disposable-startup failure's cause is unknown and not attributed to sleep.

Required formatting, lint and all nine typecheck tasks passed after review edits.
The coordinated serial full-workspace checkpoint completed: **8/9 tasks successful**;
server **941 files / 3,992 tests passed**, 38 files / 92 tests skipped, one failure.
`server.http.test.ts` failed its missing-attachment 404 lookup with a transport
socket closure rather than an assertion mismatch. The unchanged focused file
then passed **13/13 tests**. The transient failure's cause is not established;
no whole-suite green claim or unrelated production change is made. AC7 and
overall green status are not yet cleared. See the chronological
[validation ledger](../validation/opencode-v2-shared-service-foundation-2026-10-09.md).

### Live folder-access failure

Actual failed chats resolved their native Location to `~/Documents`, which the
shared native 2.0.24 process could not stat (`EPERM`). Both selected models were
available from an explicitly requested accessible Location. This is not evidence
of failed sign-in, unavailable models or runtime incompatibility. The diagnostic
fix retains locally observed HTTP 5xx status without response/request secrets and
identifies the bounded chat Location and folder-access action rather than advising
repeated refresh. Parent independently reviewed it and reran **31 focused tests**,
all passing. Native 2.0.24/2.0.26 and required quality gates passed for that fix.

The user explicitly approved changing the development default chat folder to
`~/DevWorld`, updating the failed chat only if it has no native history, and a
development-only restart. Operational remediation and read-only acceptance are
in progress. No automatic prompt resend, implicit Location fallback, native TUI
restart or OS privacy modification is authorized.
