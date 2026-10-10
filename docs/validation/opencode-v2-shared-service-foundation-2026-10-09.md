# OpenCode V2 shared-service foundation — 9 October 2026

## Scope and gates

Implemented the independent first slice of the
[shared-service plan](../plans/2026-10-09-opencode-v2-shared-service-plan.md).
Only new `SharedService.*` modules/tests and new documentation were authored;
no prior SharedService files existed at initial inspection. Existing attachment,
UI, runtime, composition and settings work was not edited.

**Not activated in the application.** `Compatibility.ts` still enforces the
historical exact private-preview runtime pin; Application still starts owned
private processes. Shared defaults, borrowed lifecycle, durable shared bindings,
visible update toast and catalog/account UI remain pending file ownership
clearance. No concurrent-owner completion notification was received. No progress
polling, interrupted-session resume, dev-app relaunch or full-workspace test
launch occurred.

**Code green: No** overall: scoped formatting, whole-repository lint/typecheck
and focused tests passed; coordinated whole-tree formatting/full tests remain.
**Implementation/Plan green: No**: integration and independent parent review
remain. Nested guide/debugger/checker delegations returned depth limit 1; direct
source review is not independent clearance.

## Implemented foundation

- Native XDG-state registration convention; private regular-file/current-owner
  checks, no-follow open, 16 KiB bound, literal loopback validation before any
  authenticated request. No profile/global file writes.
- Native `Service.headers`; bounded authenticated deadline-limited GETs only to
  `/api/info` and `/openapi.json`, redirects rejected. No SDK `ensure`/`stop`,
  startup prompt, Location/config load or credential endpoint.
- Registered PID/version matching and post-probe registration re-read. Logical
  generation uses native ID/PID/version/origin, not a password hash. It is **not
  physical-exit or durable database identity proof**.
- Required operation IDs, ownership/model/account shapes and critical field
  types/references. Sanitized stage errors retain no native text/secret causes.
- Explicit **native-api-transport** qualification for actual 2.0.24 and 2.0.26
  fixtures. Baseline 2.0.26+ is advisory; 2.0.20/25/27, 2.1.0 and 3.0.0 are not
  automatically trusted. These are not full application/release qualifications.
- Bounded app-session warning-notice deduper; qualified older service remains
  usable and reconnect/refresh cannot repeat notice. UI toast wiring is pending.

## Real native qualification

Both binaries ran `serve --service --hostname=127.0.0.1 --port=0` in disposable
HOME/XDG/data/state profiles. OpenCode itself wrote the registration, not a mocked
service file. Existing `isolatedEnvironment`, owned-child cleanup, synthetic-model
fixture and native-catalog settlement helper were reused. Project discovery was
enabled only in the disposable temp workspace to verify native skills.

The pinned 2.0.26 Promise client passed against both actual runtimes:

- Read-only handshake has zero model calls. Configured model/variant, custom
  agent/skill and native integration/provider/MCP inventories decode natively.
- Session creation/metadata/update, permission ask/reject (no saved grant),
  instruction put/read/remove, model switch, local synthetic prompt/wait,
  message/inbox/form inventory and event subscription work through native APIs.
- A sibling TUI-like native session stays **active awaiting shell approval**.
  No approval is granted and no shell command executes. Aborting/returning the
  other event iterator and interrupting only its session preserve sibling
  session/history/pending permission exactly at the API boundary.
- Native PID remains alive; config and registration files stay byte-identical;
  re-discovery retains the same logical generation.

This does not prove real TUI frontend coexistence, manager shutdown integration,
durable replay, private migration, account refresh, vendors, other platforms or
release-resource acceptance. No real provider/profile/credentials were used.

### Provenance

Official 2.0.24 registry tarball:
`https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-2.0.24.tgz`.
SHA-512 matched registry integrity:
`sha512-KGZeXsTu7YQuijMuihwTsKM6ezLoksyqkL+RUdKBUv87XBdwDf9bv692tFaTQqcyuL++BMGEZdffy0ImLBtm3w==`.
Extracted binary SHA-256:
`e68cc32cb37b1f3242991c668be3934396825778925cb85670dad61038b05fe7`.
2.0.26 reused the earlier official disposable qualification artifact; neither
installed CLI nor copied user profile was used/replaced.

Official V2 client/API/config/troubleshooting pages and explicit V2 Context7 docs
were consulted. Immutable 2.0.24 source tag commit:
`e7a34f09bfd9134dfade5a8ddb843f7030bc9a69` (complete non-truncated GitHub tree).
Audited server-process, service-registration, database-path, Global and native
config/provider/model source. This is source audit, not rebuilt-binary attestation.

## Validation

Exact disposable binary paths, not the user's CLI:

```sh
V24=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/shared-v2-qualification/2.0.24/package/bin/opencode
V26=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/v2-2.0.26-qualification/cli-darwin-arm64/package/bin/opencode
```

| Exact command                                                                                                                                                                                                                                                                                           | Result                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bun fmt apps/server/src/provider/Layers/OpencodeV2/SharedService.* docs/plans/2026-10-09-opencode-v2-shared-service-plan.md docs/validation/opencode-v2-shared-service-foundation-2026-10-09.md`                                                                                                       | Scoped owned-file formatting; final recheck follows evidence edit.                                         |
| `bun lint`                                                                                                                                                                                                                                                                                              | Passed; 0 errors, 27 inherited warnings, no length policy violations. Final recheck follows evidence edit. |
| `bun typecheck`                                                                                                                                                                                                                                                                                         | Passed; 9/9 uncached tasks, non-failing Effect advisories.                                                 |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService.registration.test.ts src/provider/Layers/OpencodeV2/SharedService.discovery.test.ts src/provider/Layers/OpencodeV2/SharedService.security.test.ts src/provider/Layers/OpencodeV2/SharedService.capabilities.test.ts` | 4 files / 36 tests passed.                                                                                 |
| `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY="$V24" BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.24 bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService.native.test.ts`                                                                                                           | 1 real registered-service fixture passed; 2.62 s total.                                                    |
| `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY="$V26" BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.26 bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService.native.test.ts`                                                                                                           | 1 real registered-service fixture passed; 2.85 s total.                                                    |
| Whole-tree `bun fmt`, full `bun run test`, browser integration                                                                                                                                                                                                                                          | Deferred to coordinated parent; active concurrent edits, no integrated shared UI.                          |

Initial fixture failures were fixed: pinned inventory methods require
`{ location }` and return `{ location, data }`; permission reply uses `decision`.
The first model list can be empty during native plugin settlement: reuse of the
existing bounded native-catalog helper fixes that startup timing. No version/API
assertion was relaxed; those failures did not demonstrate CLI incompatibility.

Approved-temp `shared-v2-qualification/` holds registry/source audit artifacts and
`foundation-lint.log`, `foundation-typecheck.log`. Native/model listeners are
awaited/closed in cleanup; no task-owned background job remains. No large
attachment, real vendor call, user service kill, config rewrite, credential copy,
staging, commit or push occurred.

## Precise integration handoff

1. After file ownership clears, factor `Client.ts` guarded transport to accept
   native `Service.headers`; use `discoverV2SharedService` without duplicating
   client transport. Current foundation supports literal 127.0.0.1 registration.
2. Establish actual canonical running-daemon DB/profile namespace before runtime
   binding. `/api/info` has temp path but no DB path; registration identifies
   generation, not storage. Native source allows `OPENCODE_DB` and channel-based
   DB selection. Do not hash guessed bigbud HOME, auth, or infer storage from PID.
3. Separate manager borrowed logical detach from physical exit; existing manager
   forgetting needs physical proof. Passing a borrowed handle through its owned
   close path is incorrect. Preserve uncertainty separately; `hasExited` cannot
   mean unsubscribed. Prohibit shared `claimExclusive`, MCP/global plugin/config
   mutations.
4. Wire settings/shared default/legacy isolated bindings, native session policies,
   prepared learning identities, safe inventory/account refresh and actual
   deduplicated warning toast. Do not delete private profile/history/settings.
5. Missing-service autostart remains unproved. Native registration replacement
   makes the previous service monitor shut down: another/ephemeral-port contender
   can indirectly replace an incumbent. Never use `Service.ensure`, `opencode api`
   or unverified spawn. Foundation gives manual TUI/service-start guidance.
6. Add application/journal/reconnect/disable/saved-grant/browser coverage, run one
   non-overlapping workspace checkpoint and independently review AC1–AC7.

## Final checkpoint

The table above records the earlier 36-test source checkpoint. A subsequent
focused regression verifies the **actual health-reported** unqualified runtime
before rejecting it, with exactly one read-only GET and no mutation/credential
endpoint. Final unit count is **37**, superseding 36. The same four-file command
and both actual native-version commands passed again after this correction.
Scoped `bun fmt` and read-only owned-file format check passed; `bun lint` passed
(27 warnings / 0 errors); `bun typecheck` passed all 9 tasks; `git diff --check`
passed. No full workspace or browser integration clearance is claimed.

Final 2.0.26 disposable binary SHA-256:
`1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`.
All 12 authored source/test files are <=160 lines at the prior checkpoint
(the added discovery regression remains below 400). Only these 12 new files and
the two new documents are this slice's changes. HEAD remains
`258d99eb4ee822744f6e14d822a306e8532f36f5`; nothing is staged/committed/pushed.

## Parent foundation review

Parent inspected registration/discovery, capability checks and the advisory-version notice policy. Startup is read-only and origin/response/deadline bounded; no SDK service replacement, credential inventory or global mutation is called. Auth rotation is checked during handshake but not used as durable storage identity. The parent independently reran the four unit files: **37 tests passed**. This clears the independent foundation review only, not application wiring, full older-runtime application qualification, automatic startup, borrowed-manager shutdown or shared durable bindings. Existing-file integration remains pending the separate attachment worker's completion and the documented native storage-identity proof. No production changes or user-service probes occurred during this parent review.

## Application continuation — same worktree, ownership cleared

The explicit attachment-worker error/completion notification cleared existing-file
ownership. This section supersedes the earlier foundation-only work state; evidence
above remains chronological. Application now wires shared borrowing, settings,
catalog/account refresh, native discovery and one-time update UI. No dependencies
were added, installed CLI upgraded or native profile modified.

Native storage was verified through `/usr/sbin/lsof -a -p <registered PID> -Fn`:
exactly one open SQLite database with WAL/SHM handles, canonical `realpath`, UID,
device/inode, native executable projection from `/bin/ps`, and matching bounded
health/registration generations before/after. No database bytes/environment dump
were read. Storage hashes canonical path/device/inode, not passwords/PID. This is
macOS-only qualification; ambiguous handles/other platforms fail closed. It does
not prove physical daemon death. No automatic missing-service start is attempted.

| Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Result                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Passed                                                                                                                                                                                                  |
| `bun lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Passed; baseline warnings only, no source/test length-policy violations                                                                                                                                 |
| `bun typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Passed, 9/9 uncached tasks                                                                                                                                                                              |
| `bun run --cwd apps/server vitest run $(find apps/server/src/provider/Layers/OpencodeV2 -name '*.test.ts' ! -name 'Execution.sandbox.test.ts' \| sed 's#apps/server/##') src/attachments/providerAttachments.test.ts src/provider/Layers/Codex/Adapter.attachments.test.ts src/provider/Layers/Claude/Adapter.attachments.test.ts src/provider/Layers/Copilot/Adapter.attachments.test.ts src/provider/Layers/Opencode/Adapter.session.turn.attachments.test.ts src/provider/Layers/Kilocode/Adapter.attachments.test.ts src/provider/Layers/Pi/Adapter.session.helpers.test.ts src/ws/serverSettings.opencodeV2.test.ts` | 99 files / 335 tests passed; 20 files / 26 optional native tests skipped                                                                                                                                |
| `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=<qualified binary above> BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=<2.0.24 or 2.0.26> bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService.application.native.test.ts src/provider/Layers/OpencodeV2/SharedService.native.test.ts`                                                                                                                                                                                                                                                                                                                       | Both actual versions: 2 files / 2 tests passed each                                                                                                                                                     |
| `bun run --cwd apps/web test:browser src/components/useOpencodeV2UpdateToast.browser.tsx src/components/settings/ProviderCard.opencodeV2.browser.tsx src/components/chat/provider/ProviderModelPicker.opencodeV2.browser.tsx src/components/chat/view/ChatView.attachments.browser.tsx src/components/chat/view/chat-view/ChatViewComposer.attachments.browser.tsx`                                                                                                                                                                                                                                                       | 5 files / 8 tests passed                                                                                                                                                                                |
| `bun run --cwd apps/server build`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Passed; existing mobile-desktop-artifact warning, no app launch                                                                                                                                         |
| `bun run test`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Not green: eight package tasks succeeded; server stalled in existing `Execution.sandbox.test.ts`, one failure reported, foreground timeout 1,200,000 ms. Runner was terminated; no server final summary |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Execution.sandbox.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Focused reproduction exceeded 120,000 ms and exited 143, no successful suite result. No sandbox code was changed                                                                                        |
| `git diff --check`; dirty authored-file <=400 scan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed; no length violations                                                                                                                                                                            |

Native application tests cover shared-default startup, actual version, public-only
Azure versus native configured model precedence, agents/skills, admission replay,
stable shutdown/rebind, access decisions, path-first preparation and replay after
snapshot removal. An unrelated active session awaiting shell approval retains
history/permission/config/registration bytes while owned disable/shutdown occurs.
No shell approval/real vendor execution occurs. Additional unit tests cover borrowed
hub sharing/late detach, no fabricated exit or quarantine release, cursor-less
cross-storage rejection, and refreshed OAuth/needs-auth metadata without credential
calls. Browser tests cover notice severity/dedupe across refresh/auth/remount,
shared mode controls, exact-subprovider picker/recent/search and attachments.

Read-only production configuration/guarded-client inventory on the actual user's
2.0.24 registered daemon confirmed connected `openai`, enabled `gpt-6.1-sol`, and
variants `low`, `medium`, `high`, `xhigh`, `max`. No sessions/prompts were created.
The authorized dev-only bigbud settings change adds **only** `connectionMode:
shared`, preserving binary/private paths, V1 settings and model selections. Backup:
`~/.bigbud/dev/settings.json.before-shared-v2-2026-10-09`. The dev app stays closed.

Full workspace/server verification and independent parent application review are
still pending. Nested guide/checker/debugger calls fail at depth limit 1; direct
inspection is not independent review. **Code green: No; Implementation/Plan green:
No.** All task-owned native services/model listeners/test runners have ended. No
staging, commit, push, native sign-in, credential copy or profile/global rewrite.

Final application layer-order correction makes provider snapshots available to
native agents/skills discovery. `bun run --cwd apps/server vitest run
src/provider/Layers/DiscoveryRegistry.native.test.ts
src/provider/Layers/DiscoveryRegistry.opencode.test.ts
src/provider/Layers/DiscoveryRegistry.liveRefresh.test.ts` passed **3 files / 7
tests**. `bun fmt`, `bun lint`, `bun typecheck` (9/9 uncached) and
`bun run --cwd apps/server build` were rerun successfully after that correction.

## Parent application review — 10 October

Independent parent source review covered shared composition, registered-process
storage identity, guarded authentication, borrowed manager teardown, native-session
ownership/access guards, retained-admission binding, model preflight, shared tool
policy, native account/agent/skill inventory and the update-toast lifecycle. The
qualified scope remains macOS, existing healthy service, explicit original-storage
bindings and no automatic generation recovery/startup. No daemon stop/ensure or
global plugin injection is used in shared mode; detachment never proves exit.

The parent added five `Runtime.ownership.test.ts` regressions: changed native
provider/thread/storage metadata or permissions rejects a send before model,
instruction or prompt mutation, without creating journal intent/quarantine; a
changed thread owner also blocks interrupt. All passed using the real pinned
client, synthetic native HTTP and SQLite fixture.

Review found known shared runtime versions could be mislabeled as not installed
when health/generation verification failed. Application now retains safe version
metadata for all typed shared errors, and provider discovery records observed
version before compatibility validation. Three application failure regressions
verify truthful installed/version/warning snapshots, preserving actionable errors.

Additional parent checks:

- Actual 2.0.24 application/transport plus binding/lifecycle: **4 files / 6 tests**.
- Browser UI: **5 files / 8 tests**.
- Attachment/provider/settings/native-discovery: **11 files / 23 tests**.
- Periodic-ingestion integration rerun: **1 file / 6 tests** passed unchanged.
- After the status fix: **6 files / 15 tests** (including the eight new regressions).
- `bun fmt`, `bun lint`, `bun typecheck` and `git diff --check` passed. Lint has
  existing warnings; typecheck completed all nine tasks. No authored-file limit
  violation was reported.

The [sandbox diagnosis](opencode-v2-sandbox-diagnosis-2026-10-10.md) passed all
four unchanged tests and correlated historical stalls with host sleep. A fresh
parent 2.0.26 disposable startup timeout and separate pre-RUN runner stall did not
reproduce and are **not** attributed to sleep. The
[native startup diagnosis](opencode-v2-native-startup-diagnosis-2026-10-10.md)
records real 2.0.24/2.0.26 requalification, bounded diagnostic capture and the
unknown historical cause; no timeout increase or assertion relaxation occurred.

The coordinated serial `bun run test --concurrency=1` checkpoint is running with a
command-scoped idle-sleep assertion. Its result is not yet known; no whole-suite
green claim is made. Final logs are in approved temporary
`shared-v2-qualification/parent-final-{lint,typecheck,workspace}-20261010.log`.
The dev app remains closed; installed service/profile and unrelated work remain
untouched. No publication or real vendor generation was performed.

## Actual development send failure — 10 October, Location access

The user subsequently launched the development app, superseding the older
closed-app state above. Safe development SQLite projections (selected model,
target, cwd and failure detail only), bounded native log metadata and read-only
model requests establish a different failure from the earlier startup diagnosis:

- The 01:35 attempts selected `opencode/gpt-6-luna`; the 08:10 attempts selected
  `opencode/big-pickle`. Neither latest failure was an Azure selection.
- These local chats have no project/worktree directory. Existing development
  settings omit `defaultChatCwd`, resolving to `/Users/youpele/Documents`.
- Actual shared native 2.0.24 PID 71099 returns **HTTP 500, empty body** for
  `/api/model` at that Location. Native logs record **EPERM** and `stat` for
  Documents at `2026-10-09T23:35:17.210Z`, `23:35:39.020Z`, and the new
  `2026-10-10T06:10:17.166Z`, `06:10:24.346Z` attempts (UTC).
- The same native process/authenticated production client returns HTTP 200 for
  `/Users/youpele/DevWorld/bigbud`, with **645 models**, including both selected
  models enabled/active. Decoded inventory is **489,177 bytes**, below the existing
  response bound. This does not authorize substituting that Location for a chat.
- The first observed development listener was PID 81415 on 3774, distinct from
  the installed app PID 74799 on 3773. At the later investigation, 3774 no longer
  had a listener; only development helper processes remained. No app/service
  stop, restart or relaunch was performed by this diagnosis.

The actual failure is native filesystem access to the chat Location, not missing
models, credentials, byte overflow or version incompatibility. macOS privacy
permissions are implicated; ordinary host listing of Documents also reports
`Operation not permitted`. No production HTTP 500 is automatically classified
as EPERM: that conclusion comes from the correlated native operational log.

### Minimal diagnostic correction

`Client.errors.ts` preserves only locally observed numeric HTTP 5xx status before
the pinned SDK decodes an empty error body. Guarded fetch cancels the unread body;
`v2Request` recognizes this local class through the SDK wrapper and constructs a
fresh sanitized exception with no SDK cause/request/response/headers/body.
Arbitrary SDK status-like fields and text remain untrusted and suppressed.

Model preflight now reports `model.list`, the safe status (or bounded-response /
generic failure category), and a JSON-escaped, 256-character-bounded Location.
Guidance checks native-service folder access, including macOS Files and Folders,
or explicitly choosing an accessible chat/project folder. It no longer tells
the user to keep refreshing a persistent access failure. Exact model/variant,
native Location identity, no fallback, and pre-journal/pre-history admission
fences are unchanged. Read-only production verification displays the corrected
HTTP 500/Documents diagnostic while the explicit repository Location verifies
enabled `opencode/big-pickle`; no session or prompt was created.

### Verification

- Focused `Client.test.ts`, `Runtime.model.availability.test.ts`,
  `Runtime.ownership.test.ts`, `SharedService.security.test.ts`, and
  `Runtime.model.setup.test.ts`: **5 files / 31 tests passed**. New cases cover
  empty/sensitive-body 500s, safe status only, escaped/bounded paths, no startup
  history or mutation, no send admission/journal intent, and no implicit switch
  to an available different Location. Initial regression failures were fixture
  path keys (`/var` versus canonical `/private/var`), corrected using `realpath`;
  no runtime preflight assertion was relaxed.
- `bun fmt`, `bun lint` (**29 warnings, 0 errors**), `bun typecheck` (**9/9 tasks**),
  and `git diff --check`: passed. All six changed source/test files are <=338 lines.
- Real disposable 2.0.24 and 2.0.26, using the exact qualified binary paths and
  `BIGBUD_OPENCODE_V2_SHARED_TEST_{BINARY,VERSION}` above: each passed
  `SharedService.application.native.test.ts` and `SharedService.native.test.ts`
  (**2 files / 2 tests per version**, 7.39s / 7.76s total).
- Initial native24 invocation stalled before `RUN`, hit the unchanged 120s
  command timeout and exited 143; no task-owned runner remained. One exploratory
  retry omitted opt-in variables and skipped both tests (not qualification).
  Subsequent explicitly opted-in, command-scoped `caffeinate -i` invocations
  passed both native versions. The initial pre-RUN stall cause remains unknown.
- No new whole-workspace test run was started. The parent's prior checkpoint
  ended non-green; its independent triage is not superseded by focused results.

Logs: approved-temp `shared-v2-qualification/location-diagnostics-{focused,fmt,
lint,typecheck,native24,native24-retry,native24-qualified,native26-qualified}.log`.
No running task-owned processes remain. No credentials/provider configuration,
prompt history or native database bytes were inspected/printed, and no real
vendor prompt, settings/OS permissions change, native upgrade, service ensure /
stop, commit or push occurred.

**Actual Documents sends remain blocked.** User approval to choose an accessible
chat Location or adjust native Documents permission is still required. Source
diagnostics do not repair an OS access denial; development app/server reload
status must be confirmed separately without forcing a restart.

## Authorized development remediation — 10 October, 08:41–08:46

The user explicitly selected **Use DevWorld** and **Restart development only**.
This supersedes the pending-approval state above. Only development bigbud settings
were changed: `defaultChatCwd` is now `/Users/youpele/DevWorld`. The private backup
is `~/.bigbud/dev/settings.json.before-devworld-2026-10-10` (mode 0600). A parsed
before/after comparison confirms **only `defaultChatCwd` differs**, including
after the correctly profiled application launch. No native/global/OS settings or
installed-app settings were changed.

The latest failed Big Pickle chat has no explicit worktree cwd, queued prompts,
provider runtime binding, native session identifiers or journal admissions.
Read-only native metadata inventory also found no session owned by this thread
at Documents or DevWorld. Therefore the new default applies to this same chat
on the next **explicit manual send**; no events/projections/history were rewritten,
no new chat/session was created, and no failed message was resent. Post-launch
checks retain zero bindings/admissions/queued prompts and the original last
failure timestamp `2026-10-10T06:10:23.900Z`.

### Existing launcher and profile verification

The current launcher is `apps/desktop/scripts/dev-electron.mjs`, not a root-level
`scripts/dev-electron.mjs`. The normal root command is `bun dev:desktop`, through
`scripts/dev-runner.ts`; its desktop task bundles server/desktop with watch mode
and launches the development Electron app. Server `deriveServerPaths` appends
`dev` to the configured base home when a dev URL is present.

An initial launch incorrectly supplied `--home-dir ~/.bigbud/dev`, yielding the
separate `~/.bigbud/dev/dev/state.sqlite`. The read-only lsof acceptance caught
this immediately. Only that task-owned runner (PID 32136) was terminated, its
listener closed, and its background command naturally completed with exit 130.
No deletion of the alternate data directory was attempted, because its prior
existence was not established. This mistaken launch is **not** the accepted
existing-profile result.

Correct launch:

```sh
bun dev:desktop --home-dir /Users/youpele/.bigbud
```

The retained development runner PID is **38256**, background shell
`sh_1248db832001w10NA6mlXTAhUZ`. Development backend PID **38953** listens on
**127.0.0.1:3774** and has the exact original
`/Users/youpele/.bigbud/dev/state.sqlite` open. The launch selected web port 5734;
the desktop allocator preserved the installed app's occupied port 3773.
The rebuilt server bundle contains the new safe HTTP-status/Location diagnostic.
This authorized development app/watch runner is intentionally left running.

### Read-only acceptance

- The development HTTP root responds **302** to its renderer, proving the new
  backend listener is serving; no auth bypass or token dump was used.
- The application's own `server.getConfig` load occurred successfully. Safe log
  projection shows native discovery includes **40 `opencodeV2` skills**; the
  wrong-profile initial launch did not include this provider.
- Authenticated read-only native model inventory at the approved exact Location
  `/Users/youpele/DevWorld`: **645 models**, selected
  **`opencode/big-pickle` enabled/active**, actual runtime **2.0.24**.
- Installed app remains PID **74799** on **3773**; original native OpenCode
  service remains PID **71099**, unchanged version/profile. No native service
  restart/ensure/stop, installed app restart, OAuth flow, CLI upgrade or OS
  privacy change occurred.
- No real vendor prompt was issued. Model preflight is now verified for the
  same failed chat's resolved folder; actual vendor completion remains untested
  until the user chooses to send manually.

Launch evidence is in approved-temp
`shared-v2-qualification/devworld-{launch-dry-run,development-launch,
development-corrected-launch}.log`; raw logs may contain private operational
data and were not dumped. No new workspace test checkpoint was run; the parent
continues independent triage of the earlier full-suite HTTP transport failure.

## Captured model switching and reload routing — 10 October

The next screenshot exposed a separate orchestration bug after workspace access
was repaired. Safe request/model projections show the 08:46:49 user request
captured `opencode/big-pickle`; its single admission subsequently became terminal
failed. The 08:47:03 request captured **`opencode/gpt-6.1-sol`**, with no variant.
It was rejected before another admission by the provider-neutral captured-model
gate. This is the exact Zen subprovider, not an inferred OpenAI/Azure route.
Read-only native metadata confirms the original owned session at DevWorld remains
idle on Big Pickle and that the exact requested GPT selection is enabled/active.
No session/model or vendor mutation was performed by this investigation.

### Reproductions and fixes

1. The executing adapter already advertised and implemented guarded idle
   `session.switchModel`. Application composition spread the **dormant** adapter
   capabilities and never replaced `sessionModelSwitch: unsupported`.
   `ProviderService.getCapabilities` reads that application adapter, so
   orchestration rejected a captured new model before the executing runtime.
   A new real-application/registry regression reproduced the exact screenshot
   error before source changes.
2. After adapter shutdown/reload, the real native orchestration test exposed a
   second gate: startup tried to rebind retained Big Pickle history with the new
   captured model, triggering the existing native model-drift guard. A subsequent
   live manual attempt at `2026-10-10T06:56:10.414Z` recorded the same rebind error.
   This was not fixed by weakening native selection/ownership checks.

`Adapter.capabilities.ts` now supplies one execution-capability definition to
both the application wrapper and executing factory. Idle model switching is
`in-session`; exact saved-cursor rebind is `resume-restart`, qualified through the
real ProviderService/orchestration path below. Dormant execution still advertises
both operations unsupported. This does not enable missing-service startup,
shared-daemon replacement, arbitrary-history recovery or automatic prompt replay.

The V2-only start seam restores the saved native selection and cursor before
rebinding. The captured **new turn's selection is unchanged** and reaches the
existing guarded model switch only after successful ownership/idle validation.
Legacy cursors use the validated persisted selection. New cursors retain the
verified current provider/model/variant, and accepted-turn recording persists
that current selection rather than an old replay request's selection. Thus
same-ID cross-provider/variant changes and original-admission replay do not make
later reloads adopt stale model metadata. Other providers' start-input shape and
policy are unchanged.

Native storage/Location/session ownership, model-drift checks, current epochs,
busy/unresolved execution, mutation quarantine and exact model preflight remain
fail-closed. A missing bound native session still cannot create fresh history.
No model-availability, version or native-operation assertion was removed.

### Verification and activation

- Focused model/capability, ProviderService routing/persistence/validation,
  captured-settings orchestration, setup/availability, ownership, drift and race
  tests: **17 files / 83 tests passed**.
- Actual disposable **2.0.24 and 2.0.26** each passed **3 files / 3 tests**:
  `SharedService.model.routing.native.test.ts`, existing application qualification,
  and native transport qualification. The new test exercises the real application
  wrapper, real ProviderService and captured-turn orchestration, rebinds after
  adapter shutdown, switches across synthetic subproviders with `precise`
  variant, preserves the same native session/history/metadata, rejects stale
  transport epochs, replays the original durable admission without another
  model request, and rebinds the switched selection again afterward. Only
  disposable loopback synthetic model endpoints are used.
- Intermediate test failures corrected test assumptions: reload reconciliation
  can re-emit an existing turn's completion, so settlement counts distinct turn
  IDs; stale session epochs correctly reject and are not relaxed. The first
  generic start patch added an unwanted undefined key to other providers' inputs;
  the final start seam is explicitly V2-only and existing provider tests pass.
- Final `bun fmt`, `bun lint` (**29 warnings, 0 errors**), `bun typecheck`
  (**9/9 tasks**) and `git diff --check` passed. All 12 changed source/test files
  are <=305 lines. No new full-workspace test run was started. Prior parent
  full-suite HTTP transport triage remains independent.
- The existing authorized development watcher rebuilt/reloaded the server; no
  second launcher or forced restart was needed. Latest observed backend PID
  **81949** listens on **3774**, with the original `~/.bigbud/dev/state.sqlite`
  open. Its rebuilt bundle contains in-session switching, resume-restart and the
  V2 saved-selection seam. Development launcher PID **38256** remains running.
- Installed app PID **74799** on **3773** and native **2.0.24 PID 71099** remain
  unchanged. Settings still differ from the pre-DevWorld backup only in the
  approved default-folder field. The affected chat retains one original terminal
  admission and zero queued prompts; no new native model mutation/prompt was
  issued by our tools.

Logs are approved-temp `shared-v2-qualification/model-switch-*.log` (including
the exact failing capability/cold-start reproductions and passing native files).
The user can explicitly retry GPT in the **same owned chat**; its retained Big
Pickle history will rebind first and the new turn will request the exact captured
`opencode/gpt-6.1-sol` route. Real vendor generation remains untested here; no
silent substitution to another subprovider, automatic resend, native service
restart, credential/configuration copy, upgrade, commit or push occurred.

## Big Pickle native TUI/API contrast — 10 October

**Generation restoration is not yet established.** The user confirms Big Pickle
works in native TUI with **Build at `/Users/youpele/DevWorld`**. Therefore the
403 must not be presented as proof that every third-party interface is ineligible,
or that all other native subproviders lack credentials.

Only owned session metadata/error projections were read. In chat
`74bcac55-7cb8-49bc-b42e-14a1e479ba56`, both Big Pickle assistant failures at
`2026-10-10T07:45:58.808Z` and `07:46:15.902Z` have native agent `build`, model
`opencode/big-pickle#default`, error type `provider.auth`, HTTP **403**, and exact
message `OpenCode's free tier can only be used from within OpenCode`. The native
log independently records those failures. The owned session's selected agent is
unset, and native resolution chooses Build; this is not a custom-system-agent
override.

**Correction to the previous account-path explanation:** recorded successful GPT
turns in this same session also use the **`opencode`** subprovider. Examples are
`opencode/gpt-6.1-sol` at `07:45:19.836Z` and `opencode/gpt-6-astra` at
`07:45:45.284Z`, both Build with finish `stop`. We did not read their prompt or
response content. These observations rule out a blanket broken Zen transport;
they do not independently prove billing/account details.

Other native failures remain distinct: Muse Spark contributor-free gets the
same 403, Exo Free is explicitly deprecated (**410**) and Ling Flash free is
reported unavailable (**400**). Model inventory enablement is not a generation
entitlement or an upstream-health guarantee.

### Source inspection and non-vendor comparison

- Public native **2.0.24** source is pinned to
  `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`; **2.0.26** is
  `9b4ec5714d481559990db0a816d5dec19541a814`. Inspection focused on TUI prompt
  submission, session context/agent selection, model-request construction, native
  permissions/tool snapshots, and instruction ordering. This is not an upstream
  t3code transplant.
- Both interfaces reach the same native session model runner. Native model
  request identity headers come from that process's `App.Metadata`, not a TUI
  header bigbud forgot to impersonate. No identity, fingerprint, attestation or
  request-header override was added.
- The V2 instruction documentation confirms session entries are **additive**;
  they do not replace the selected native agent/provider base prompt. Native
  session IDs accept client-supplied `ses`-prefixed identifiers; no evidence was
  found that rewriting existing deterministic bigbud IDs would be a supported
  fix. Bindings and history were left untouched.
- `SharedService.context.native.test.ts` compares native Build/API calls and the
  actual application adapter against a disposable loopback model. Both versions
  preserve the same native Build base prompt and discovered skill guidance.
  Browser MCP increases native Code Mode guidance, and the app adds its owned
  access-mode entry. The only direct-tool-name difference in the fixture is
  **`subagent`**, absent under the existing bigbud ownership deny rule. The test
  verifies that deny remains enforced. Service/config files stay byte-identical
  and the disposable service PID/version remains unchanged.
- Public OpenCode reports document this exact 403 **inside official native
  interfaces** when tool availability is restricted, including
  [#50627](https://github.com/anomalyco/opencode/issues/50627),
  [#51315](https://github.com/anomalyco/opencode/issues/51315), and
  [#54111](https://github.com/anomalyco/opencode/issues/54111). They concern
  shell/read restrictions, not a proven cause for our subagent/context difference.
  These user reports are corroboration of misleading eligibility errors, **not
  authoritative permission to spoof eligibility or proof of our exact trigger**.

The remaining candidates are per-session tool/context eligibility, additional
app/browser instructions, and native admission/session metadata. No documented
missing agent/base-instruction/client setting was found. A real same-session
TUI-versus-bigbud comparison, with user-authored sends and only sanitized
metadata, is the next discriminating experiment. No real vendor send was made
by our tools, and no safety permission was relaxed to satisfy a remote heuristic.

### Confirmed diagnostic defect fixed

Terminal reconciliation discarded the correlated native reason and always
reported `OpenCode v2 native execution failed.` Four failing regressions
reproduced that behavior. `Runtime.failure.ts` now maps allowlisted native error
classifications into bounded actionable terminal messages with exact model and
valid HTTP status: free-tier context rejection, explicit model deprecation,
upstream model unavailability, or native authentication/access-policy rejection.
Unknown error text, response bodies, headers and URLs never leave this boundary.
The free-tier message explicitly avoids claiming missing credentials and notes
that native TUI sessions may still work. No retry, fallback, catalog hiding,
account/config change, static model block or global availability mutation was
introduced. This fixes explanation/error fidelity, **not the still-unproven
Big Pickle generation trigger**.

- Focused recovery/projection/finalization/context/ownership suite:
  **9 files / 38 tests passed**, including terminal correlation, sensitive-body
  suppression and original-admission replay without another prompt.
- Real disposable **2.0.24 and 2.0.26** each passed **3 files / 3 tests**:
  new native-context comparison, captured-model cold-rebind routing and existing
  application qualification. Only synthetic loopback generation was exercised.
- The initial comparison accidentally selected native title-generation requests;
  final comparison selects tool-bearing Build requests. Native transport folds
  instructions into one system message, so the base-prefix comparison excludes
  legitimately dynamic Code Mode guidance rather than claiming full system-text
  equality. No production prompt content was read.
- Evidence and pinned public source are approved-temp `zen-tui-comparison/`;
  source changes are limited to one terminal-message integration, a pure failure
  classifier, and two focused tests. No commit/push or full-workspace test run.

The retained authorized development watcher rebuilt this diagnostic change; no
second launcher or manual native restart was needed. Observed development backend
**76130 / 3774** has the original `~/.bigbud/dev/state.sqlite` open and its bundle
contains the new free-context/unavailability messages plus the earlier guarded
switch/rebind fix. Installed app **74799 / 3773** and native **2.0.24 PID 71099**
remain unchanged. Settings still differ from the approved backup only in
`defaultChatCwd`. This activation does **not** mean the unresolved free-tier
generation issue has been repaired; user retries must remain explicit.

Final formatter/linter/typecheck/diff checks passed; no errors and **9/9**
typecheck tasks succeeded. All four authored source/test files are below
**400 lines** (largest: `Runtime.recovery.ts`, **245**). The earlier full-suite
HTTP socket failure remains outside this task; no overall full-suite-green or
real Big Pickle completion claim is made.

## One authorized official-CLI same-session diagnostic — 10 October

The user explicitly authorized **one** minimal Big Pickle diagnostic message
through the official CLI in a retained failing native session, with no OpenAI
request, fallback, permission or instruction change. That authorization has now
been consumed; **no second real diagnostic is authorized**.

The recent chat `74bcac55-7cb8-49bc-b42e-14a1e479ba56` had since switched to
`opencode/gpt-6-luna#default`. It was not sent to or switched back. The older
failed chat `43b65667-bfe1-40d1-9465-39083dab5567`, native session
`ses_bigbud_a55468f7fcef20b7104af1030184549a9a8d2b4e26b66b6e7ab67ab249aed187`,
was verified as still on `opencode/big-pickle#default`, idle, owned by bigbud,
at DevWorld, with its prior Build assistant showing the same free-tier 403. Its
permission and instruction hashes also matched the recent failing chat's
context. Both application and native inboxes were empty and no permissions/forms
were pending.

Before sending, installed CLI `--version` and `run --help`, official V2 CLI/client
documentation, and the pinned **2.0.24** run/session-target/server-connection
source were checked. Explicit `--server` attaches to the existing authenticated
endpoint without calling service ensure/start/replace or copying the shell
environment into the session. No `--model`, `--agent`, `--auto`, `--continue`,
`--fork`, `--title` or standalone override was supplied. The inherited exact
model passes native `switchModel` as an unchanged no-op. Existing-session lookup
was freshly verified to avoid the CLI's documented missing-ID creation behavior.

The official command was `opencode run --server <existing-local-endpoint>
--session <verified-existing-session> --format json` with one message:
**`Reply with exactly OK. Do not use tools.`** Transport authentication was passed
only through the documented private subprocess password environment, never a
command-line credential or logged header. A private exclusive one-shot marker
prevents accidental reruns. A first wrapper preflight stopped **before** marker
creation/CLI launch because it mistook a native navigation cursor for more
history; the existing `Runtime.projection.ts` short-page convention corrected
that read-only check. It did not consume a message or make a generation request.

### Actual result

- CLI **2.0.24** exited **1**, without timeout, stderr or additional invocation.
- Exactly **one** new user message was observed,
  `msg_12506ca41001X9ETlwQT3gBfpV`, matching the authorized diagnostic.
- Exactly one new assistant,
  `msg_12506ca4e001L5Lshvz3kZZ7xE`, remained Build on
  `opencode/big-pickle#default` and finished with **`provider.auth`, HTTP 403**,
  the exact same `OpenCode's free tier can only be used from within OpenCode`
  rejection. It emitted no tool parts and did not reply OK.
- Before/after model, selected agent, permissions, instruction entries,
  ownership/storage metadata and native **PID 71099** were unchanged. The native
  session returned to idle, with no inbox, pending permission or pending form.
- Only sanitized outcome/model/status/IDs and context hashes were retained.
  No provider credential, raw response body, unrelated TUI transcript or native
  database contents were read or exported.

This rules out **bigbud's HTTP submission/client identity as the sole cause**:
the genuine official CLI also fails in this retained session. Native TUI success
in another Build/DevWorld session and this same-session failure narrow the
investigation to retained session/request context or upstream eligibility
handling; they do not prove which individual tool, instruction or metadata field
triggers it. No documented missing API context was established that would
justify a generation-restoring source change. Therefore no identity spoof,
permission relaxation, context removal, model substitution, binding rewrite,
service restart or additional real prompt was attempted. **Generation remains
unresolved; the earlier safe diagnostic fix must not be described as restoring
Big Pickle.**

Approved-temp evidence is `zen-tui-comparison/authorized-cli-before.json`,
`authorized-cli-result.json`, and the private one-shot marker/supervisor. This
checkpoint changes documentation only; the development runner, installed app and
shared native service remain running.

## Bounded public gateway/policy audit — 10 October

No additional generation, production session/configuration mutation or runtime
code change was performed. The one-message authorization above remains consumed.

### Published policy, not an inferred blanket ban

- [V2 Console models](https://opencode.ai/v2/docs/console/models/) explicitly says
  API keys can be used with **“OpenCode or another coding agent”**, lists Big
  Pickle's Chat Completions endpoint, and describes the AI SDK packages as being
  for applications calling endpoints directly. Its free subsection also says
  Big Pickle is **“free on OpenCode for a limited time.”** Neither statement
  defines the exact free-tier admission predicate for customized native sessions.
- [V2 Inference API](https://opencode.ai/v2/docs/console/inference/) says paid
  models require authorization while **“free chat models can be called without
  it.”** This establishes optional authentication, not unconditional entitlement
  for every request context. No required canonical tool set, system text, client
  attestation or session identifier is specified there. Context7 likewise did not
  supply an explicit criterion.

### Exact public-source boundary

The official `anomalyco/opencode` public snapshot
[`055d95bb7e278c94baf06235a52cac79dd13ba67`](https://github.com/anomalyco/opencode/commit/055d95bb7e278c94baf06235a52cac79dd13ba67)
(9 October, 22:29:16 UTC) was inspected, separately from the pinned native CLI
versions. Its full archive search covered **4,534 text source/document files**:
no occurrence of the exact free-tier rejection, its `only be used from within
OpenCode` substring, or `FreeTierError` was found. This is evidence about that
snapshot, **not proof of the deployed gateway version or all vendor repositories**.

- [`handler.ts`, lines 106–125](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/app/src/routes/zen/util/handler.ts#L106-L125)
  forwards configured anonymous free requests before legacy checks.
- [`inference-proxy.ts`, lines 56–98](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/app/src/lib/inference-proxy.ts#L56-L98)
  forwards to `ConsoleMigration.inferenceUrl` and returns the destination's
  non-404 response unchanged. The production destination is
  `https://opencode.ai/inference`, set in
  [`infra/console.ts`, lines 223–230](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/infra/console.ts#L223-L230).
  The destination's free-tier decision implementation was not found in this
  public snapshot; forwarding code cannot establish its predicate.
- The legacy [`ipRateLimiter.ts`, lines 11–19](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/app/src/routes/zen/util/ipRateLimiter.ts#L11-L19)
  has a **commented-out** `checkHeaders` check and sets `headersExist = true`.
  It selects daily rate limits, not this exact rejection. It is not evidence of
  a required client header and does not justify adding one.

### Remediation boundary

The earlier disposable comparison established retained native Build/skill
context, additive owned app/browser instructions and a denied `subagent` tool.
There is **no published predicate here against which to classify those deltas**.
The official CLI's same-session 403 rules out bigbud's submission identity as
the sole cause, but does not identify a specific context field or distinguish
intentional eligibility from an upstream false rejection. No supported missing
native API field or generation-restoring adapter correction is established.

The actionable blocker is vendor clarification of the exact supported contract:
**Does Big Pickle free-tier support genuine native Build sessions with additive
instructions/MCP and explicit tool denials, and what triggers this 403 even
through official CLI 2.0.24?** No issue, email, account flow or request was sent.
Removing the ownership guard, spoofing headers/tool declarations, stripping app
identity or recreating history would not be an evidenced legitimate fix. Native
subagent support would require a separately approved ownership/lifecycle feature,
not an eligibility workaround. Exo's explicit 410 deprecation and Ling's model
unavailability remain distinct upstream outcomes. **Big Pickle generation remains
unresolved; this audit records a source/contract boundary, not a repair.**
