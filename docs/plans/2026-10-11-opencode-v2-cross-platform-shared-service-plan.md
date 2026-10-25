# OpenCode V2 cross-platform shared-service compatibility

**Date:** 11 October, 2026
**Status:** Windows metadata prototype measured and blocked — production containment retained; complete candidate discovery and independent security approval remain gates.
**Owner:** implementation specialist; parent session owns independent plan review

**Superseded boundary:** the approved [API-first plan](2026-10-11-opencode-v2-api-client-integration-plan.md) replaces physical DB equivalence with consent-gated logical history and exact retained-ID verification. The failed Windows evidence below is preserved; it is not a pass for the new architecture. See its [separate ledger](../validation/opencode-v2-api-client-2026-10-11.md).

## Summary

Accept stable OpenCode V2 releases `>=2.0.24 <3.0.0` when their required protocol
capabilities are compatible, rather than admitting only previously tested patch
versions. Borrow an already-running, user-installed service on macOS, Linux and
Windows, without controlling its lifecycle or reinterpreting existing history.

The HTTP client and documented registration format are cross-platform. The
durable database identity/security boundary is not: current bigbud uses macOS
`lsof`/`ps`, and neither minimum-version nor current published OpenCode APIs
identify the active database. A credible solution requires OS metadata inspection,
including genuine Windows security/file-identity verification. This is not safely
implemented by deleting the platform guard or using a guessed database path.

## Related Work

- [Consolidated shared-service contract](../reports/providers-opencode-v2.md#consolidated-adoption-and-setup-decisions).
- [Consolidated provider-adoption decision](../reports/providers-opencode-v2.md#consolidated-adoption-and-setup-decisions).
- [Provider implementation](2026-09-29-opencode-v2-provider-implementation-plan.md).
- None identified: no note/card/issue identifier supplied for this request.
- Baseline: clean `plan/terminal-rust-gpu-reliability` at
  `a2ff0368dddd8303f9f767b75d42a79b6911725c` before this plan was authored.

## Problem

The latest clarified request explicitly supersedes the older exact qualification
allowlist and macOS-only scope. It does **not** supersede storage ownership,
uncertain-admission quarantine, isolated-mode compatibility, or native lifecycle
ownership. Subsequent user approval permits the parent to publish a dedicated task
branch for Windows Actions validation, but not release publication. This implementer
leaves git publication to the parent.

### Evidence and provenance

Official V2 documentation was fetched directly; Context7 library
`/websites/opencode_ai_v2` was also consulted. GitHub API responses were retrieved
with `curl` as JSON and formatted/inspected. The official troubleshooting page
links `anomalyco/opencode`; its default branch is `dev`, not an assumed V1 branch.

Pinned source references:

- `v2.0.24`: `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69` (minimum).
- `v2.0.26`: `9b4ec5714d481559990db0a816d5dec19541a814` (pinned bigbud client).
- Live documentation/OpenAPI observations below are dated 11 October 2026;
  they are not substitutes for minimum-version source evidence.

| Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Conclusion                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [V2 client guide](https://opencode.ai/v2/docs/build/client), [minimum Promise service source](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/promise/service.ts#L18-L107)                                                                                                                                                                                                                                                                          | `discover` is read-only; `ensure` may launch, replace or terminate. Use neither `ensure` nor `stop` for shared services. Event streams are live-only, have no replay and no automatic reconnect.                                                                                                                |
| [V2 troubleshooting](https://opencode.ai/v2/docs/troubleshooting), [CLI paths](https://opencode.ai/v2/docs/cli)                                                                                                                                                                                                                                                                                                                                                                                             | Registration/config/database are distinct. `OPENCODE_DB` overrides the DB. Even `opencode api` can start a service; do not use it for discovery. `debug paths` describes the invoked CLI environment, not necessarily an existing daemon.                                                                       |
| [Minimum ServerInfo schema](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/protocol/src/groups/server.ts#L5-L19), [handler](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/server/src/handlers/server.ts#L17-L27), [2.0.26 source](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/server/src/server-info.ts), [live OpenAPI](https://opencode.ai/v2/openapi.json) | `version`, `pid`, URLs, `paths.tmp`, optional persistent-PTY capability; **no DB path, durable storage ID, global config roots or executable identity**. A schema description saying “paths” does not imply those fields exist.                                                                                 |
| [Minimum service registration](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/cli/src/services/service-registration.ts#L18-L64)                                                                                                                                                                                                                                                                                                                               | File contains ID/version/URL/PID/password, written mode 0600 then renamed. A replaced registration causes native shutdown. Never rewrite it. POSIX mode does not establish Windows ACL privacy.                                                                                                                 |
| [Minimum service probe](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/service-probe.ts), [global roots](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/util/src/global-roots.ts#L1-L18)                                                                                                                                                                                                             | Native fallback uses XDG state or `os.homedir()/.local/state`, also on Windows; do not invent AppData paths or prefer a Unix HOME override over Windows homedir semantics. Empty XDG semantics differ between helpers; invalid relative paths must be rejected with an explicit service-file remedy.            |
| [Minimum database path](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/cli/src/database-path.ts), [server process](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/cli/src/server-process.ts#L29-L143), [2.0.26 service config](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/cli/src/services/service-config.ts)                                                 | DB override may be absolute, relative, extensionless or `:memory:`. Global config can use `OPENCODE_CONFIG_DIR`; later service config can inject environment. Reading bigbud's env or launching another CLI cannot prove the running DB/config. Service config helpers can migrate/write files.                 |
| [Minimum release targets](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/cli/script/build.ts#L33-L50), [Windows retained image](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/cli/src/services/retained-image.ts)                                                                                                                                                                                              | Native targets include Windows ARM64/x64 and Linux ARM64/x64 glibc/musl. Binary names/paths may vary by installation or retained-image behavior. Do not require an `opencode` basename or guess installation paths.                                                                                             |
| [Minimum OpenAPI](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/protocol/openapi.json)                                                                                                                                                                                                                                                                                                                                                                       | The minimum already has permission get, form get and inbox cancel, which bigbud uses but currently omits from its required-operations list. Prompt admission uses client ID/metadata; responses have specific data wrappers; event stream is SSE.                                                               |
| [PSS capture](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/nf-processsnapshot-psscapturesnapshot), [capture flags](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/ne-processsnapshot-pss_capture_flags), [handle entry](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/ns-processsnapshot-pss_handle_entry)                                                                                                                                | Documented Windows handle/name snapshots provide a candidate process-metadata route without process-memory cloning. They do not themselves identify which file is OpenCode's primary DB or supply durable file IDs. Must prove access, completeness, races and cleanup on Windows before relying on this route. |
| [Windows file identity](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info), [handle security](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)                                                                                                                                                                                                                                                                                       | Volume serial plus file ID identify an open file; owner/DACL can be read from a handle. Use these, not POSIX uid/mode emulation. Security-descriptor reads themselves are not race-free.                                                                                                                        |

Win32 documentation was also consulted through Context7
`/websites/learn_microsoft_en-us_windows_win32_api`. No user service, native
database, provider credentials or service configuration was inspected or changed
during this research. Source archives/specifications are in the approved temporary
directory, not added to the repository.

## Goals

1. Stable `2.0.24` and newer V2 versions pass an inclusive version floor and
   required API/protocol checks; incompatible/malformed versions and future
   majors fail clearly before native work. Qualification history is evidence,
   not a runtime allowlist. Keep the SDK dependency pinned unless separately needed.
2. Shared local operation on macOS, Linux and Windows, with equivalent file,
   registration, process and durable-history guarantees; include native ARM64
   concerns instead of equating Windows with x64.
3. Borrow only an existing user-owned service. No installation, launch, restart,
   shutdown, config/plugin injection, credential transfer or native DB read/write.
   Users authenticate their own providers in OpenCode.
4. Preserve old shared identities, native session IDs, cursors, admissions,
   attachment replay, permission ownership and same-database restart behavior.
5. Accurate shared/isolated UI, manual setup errors, minimum-version wording and
   nonblocking advisory upgrade notice; preserve legacy isolated settings.

## Non-Goals

V1 changes, SDK embedding, cloud/remote shared services, isolated-mode version
expansion, native history migration/deletion, automatic fallback, live vendor
prompts/billing, provider authentication, arbitrary environment/credential dumps,
process-memory snapshots, privileged/elevated access, or release publication.
Do not change the user's service to make testing or discovery easier.

## Current State

All paths in the first eight rows are under
`apps/server/src/provider/Layers/OpencodeV2/`.

| Area                                                                                                        | Current behavior and impact                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SharedService.compatibility.ts:3-37`; `Development.provider.ts:49-54,137-139`                              | Exact two-version allowlist; update notice only recognizes 2.0.24 at application level. Replace shared checks and comparisons consistently; leave isolated `assertDevelopmentVersion` alone.                                                                                                                                                                |
| `SharedService.registration.ts:35-104`; `Compatibility.ts:16-33`; `Client.ts`                               | Bounded 16 KiB read, nofollow, POSIX uid/mode check; Windows skips privacy validation. URL is restricted to literal IPv4 127.0.0.1. Retain redirect/origin/body/deadline guards; explicit loopback IPv6 needs a coordinated shared transport change if supported, never DNS/wildcard/LAN trust.                                                             |
| `SharedService.discovery.ts`; `SharedService.capabilities.ts`                                               | Only `/api/info` and `/openapi.json` startup GETs; registration reread. Existing shape checks are shallow and omit three used operations. Enrich protocol checks before admitting unknown versions.                                                                                                                                                         |
| `SharedService.storage.ts`; `SharedService.connection.ts`                                                   | macOS-only unique DB/WAL-or-SHM open-file heuristic; realpath, uid, dev/ino; hash of `["opencodeV2-shared-local", path, dev, ino]`. Binary comes from `ps`. Borrow rechecks storage/generation, validates registration before every request; detach never signals native process.                                                                           |
| `Application.shared.ts`; `Application.composition.ts`; `Application.targets.ts`                             | Shared skips profile/plugin initialization and owned-child startup. Config captures DB as profileRoot. Local-only shared target fence must remain. Binary override participates in config key even though shared ignores it; correct shared key without changing isolated key semantics.                                                                    |
| `Runtime.binding/sessions/ownership/model/read/start/learning.ts`; `Admission*`; `Coding.bridge.ts`         | Storage identity determines native session ID and is checked against native metadata, cursors and retained journal bindings. Changing the hash silently would orphan history or admit duplicates. No database-path-only, PID, URL or service-generation substitution.                                                                                       |
| `Runtime.admission/recovery/mutations/cleanup/interactions.ts`; `EventHub.ts`; `ServerManager.ts`           | Durable ID/metadata correlation, quarantine, explicit repair after live-stream gaps, own-session interrupt/inbox cancellation. Logical disconnect is not exit; changed registration stops dispatch, does not auto-resend. Capability list must include permission get, form get, inbox cancel.                                                              |
| `Runtime.policy.shared.ts`; `Runtime.attachments.ts`; `Runtime.media.ts`                                    | Native host-user tools, not sandbox. DB parent protected, but config/state currently inferred from bigbud env. Alternative daemon roots and Windows native rule path normalization need proof. Shared attachment admissions live in bigbud state, not native DB directory. Do not recursively inspect the user's profile using isolated-profile ACL helper. |
| `packages/contracts/src/core/settings.opencodeV2.ts`; `packages/shared` settings helpers                    | Enabled/empty paths default to shared; historical custom paths infer isolated. Optional explicit serviceFile exists. Preserve sparse/import/export compatibility and saved isolated paths.                                                                                                                                                                  |
| `apps/web/src/components/settings/ProviderCard.tsx`; `chat/provider/providerDescriptors.tsx`; browser tests | Binary control shown in shared mode but ignored; copy promises 2.0.26+ while later versions rejected. Hide/disable isolated-only inputs without erasing values, expose explicit registration selection if needed, explain >=2.0.24 plus capability checks.                                                                                                  |
| `ProfileIsolation.windows.mjs`; `crates/bigbud-remote-agent/src/resource_cleanup/windows*`                  | Existing SID/DACL and handle-bound Windows patterns to reuse by concern, not whole recursive profile inventory. Native crate already depends on windows-sys 0.61.2. Rust remains provider-neutral.                                                                                                                                                          |
| `remote-agent/localWorkspaceWatchAgent.binary.ts`; `scripts/lib/workspace-agent-target.ts`                  | Verified packaged native binary resolver exists, but target table currently lacks Windows ARM64 and Linux ARM64/musl. A bundled probe must not silently introduce these platform exclusions.                                                                                                                                                                |

## Phases

### Windows metadata prototype amendment (approved after P2 containment)

**Measured disposition:** source `bd2a7810ec3bbf214f2e7688bcc72721fe32bb42`,
[matrix 38161759696](https://github.com/youpele52/bigbud/actions/runs/38161759696),
all four jobs completed 11 October 2026. Class-47 same-file/replacement membership
passed with private-path checks; mapping discovery rejected error 1006 on 14
unresolved native mappings on x64 and 16 on ARM64 despite one observed SHM region.
No incomplete-region filter was added. Native restart/replacement and mapping-race
proof could not progress beyond initial discovery. The approved investigation is
stopped at this measured completeness blocker; no production admission is enabled.
See the [validation ledger](../validation/opencode-v2-cross-platform-2026-10-11.md)
for exact commits, jobs, counts and independent review scope.

This amendment supersedes the PSS/foreign-handle acquisition hypothesis below.
Security-approved containment `5e2e1bff81afa7d1cd3d0b6501904f30e24dd319` remains the
production boundary. User approval is for a disposable qualification prototype,
not automatic admission or a weaker history identity.

1. **Contract:** build an explicit `windows-metadata-prototype` feature and separate
   `inspect_metadata` example, never packaged or dispatched by `--inspect-local`.
   Inputs are fixture PID, or PID plus a known fixture path for primitive testing.
   Output is observation-only: retained process birth stamp, candidate pathname,
   volume serial/128-bit DB ID and SHM ID; errors yield no identity.
2. **Metadata discovery:** retain one same-user PROCESS_QUERY_INFORMATION handle;
   VirtualQueryEx enumerates bounded region descriptors, GetMappedFileNameW supplies
   filenames without VM_READ or page access. Nominate an extensionless DB from one
   mapped `-shm` path. Resolve only an unambiguous local DOS device path, walk with
   the existing no-reparse/ancestor owner/DACL rules, open existing files with only
   attributes/READ_CONTROL/SYNCHRONIZE and unrestricted read/write/delete sharing.
3. **Membership proof:** query FILE_ID_INFO and class-47
   FileProcessIdsUsingFileInformation on each same independently opened local file
   handle. A successful, complete bounded PID list must contain the retained target
   process. Recheck IDs, checked path identity, mapping inventory, PID membership,
   process liveness and creation stamp. PID/pathname membership alone is insufficient.
4. **Bounds:** 65,536 queried regions / eight-second scan budget; 32,768 UTF-16 path
   units; class-47 buffers grow 16→64→256→1,024→4,096 PID capacity, never accept an
   overflow/truncated/unsupported result. The qualification executable has a 20-second
   caller deadline. Pending I/O buffers stay live through completion; no timed-out
   asynchronous stack buffer may escape. Initial filesystem experiment is local NTFS;
   other filesystem names reject until independently qualified.
5. **Proof matrix:** x64/ARM64 × official minimum 2.0.24/pinned 2.0.26. Test same-file
   membership through independently opened handles, byte-identical replacement while
   the target retains the old file, mapped extensionless DB discovery, same-DB manual
   fixture restart, different DB/physical replacement identity, two candidates,
   invalidated mappings, target exit, bounded malformed membership, and existing
   zero-socket-retention regressions with real TCP/UDP. Prototype failures must not be
   hidden by the existing production containment failures; use independent CI steps.
6. **Admission gate:** mapping metadata is nomination, not complete open-file inventory.
   Unnamed/vanished mappings, unsupported class 47, reused observations, multiple DBs,
   unmapped/in-memory DBs, or inability to prove full candidate coverage must reject.
   A mapped SHM alone cannot establish absence of an unmapped second DB. Independent
   security review must resolve coverage and same-object/replacement semantics before
   any production call site changes. If the measured API route cannot meet those
   guarantees, stop with exact evidence and maintain containment.

Microsoft references: [VirtualQueryEx](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualqueryex),
[GetMappedFileNameW](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getmappedfilenamew),
[FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info),
[NtQueryInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryinformationfile),
[FILE_INFORMATION_CLASS](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ne-wdm-_file_information_class).
Class 47 is explicitly **reserved for system use**, not a documented stability
guarantee. Context7 Windows Rust documentation confirms mapping API signatures;
the installed windows-sys **0.61.2** supplies the actual bindings. Its
Wdk/System/SystemServices FILE_PROCESS_IDS_USING_FILE_INFORMATION is a u32 count
followed by an aligned pointer-sized PID array; the decoder uses `repr(C)` and
`offset_of!` rather than assuming packed layout. No new dependency is introduced.

### Phase 1: implement the reviewed native identity contract

Preferred candidate: a bounded, provider-neutral read-only metadata capability in
the existing native agent for Windows, with TS policy/HTTP ownership remaining in
OpencodeV2. Linux can inspect only `/proc/<registered-pid>/fd` and `/proc/<pid>/exe`
using Node, avoiding lsof/package/libc dependencies. macOS can preserve the current
metadata source and **exact** existing identity hash. Do not require a new helper
on platforms that do not need one solely to unify implementation shape.

Implement and prove on task-owned processes (Windows proof is a completion gate,
not a prerequisite to independent version/Linux/application edits):

- Windows PSS handle/name enumeration with no VA clone, thread capture, injection,
  termination rights or elevation. Open process once, verify owner SID and creation
  identity, bound output and execution time, free all snapshots/handles on errors.
- Distinguish disk files from pipes/devices, map native paths safely, retain open
  handle identity through checks, and compare against canonical pathname identity.
  Reject replacement/deleted files, reparse/junction escapes and incomplete probes.
- Identify one unambiguous native SQLite candidate from process metadata, including
  extensionless `OPENCODE_DB` using WAL/SHM pair bases, not filename suffix alone.
  Multiple candidate databases and `:memory:` cannot establish current durable
  identity; retain fail-closed behavior, never select the first candidate.
- Registration Windows owner/DACL/reparse validation on the actual bounded opened
  file; registration bytes never enter logs. Validate file and ancestor mutation
  exposure without walking unrelated profile contents. Unix keeps regular/private
  owner checks with before/after object identity checks.
- Verify process/generation/registration and database handles before and after the
  probe. Credentials never participate in storage identity. Executable basename
  is not proof and is not necessary for launching a borrowed service.
- Preserve existing host-user permission denies and additionally protect the
  verified registration directory. Exhaustive custom global config-root discovery
  is not an existing sandbox guarantee and is not a connection gate. Document this
  pre-existing limitation; do not read config/credentials to try to eliminate it.

Windows hypothesis is supported by documented primitives, not yet a demonstrated
complete implementation. A Windows runtime is required to close this gate.

### Phase 2: version and protocol capability contract

Replace the runtime allowlist with a strict stable-version parser/floor check.
Reject malformed/overflow/leading-zero forms, V1, <2.0.24 and majors >2; treat
unqualified prerelease labels as not stable releases. Permit 2.0.25, 2.0.27,
2.1.0 and arbitrary later stable V2 only after protocol checks succeed.

Keep a separate tested-version evidence table; do not present a future-version
acceptance fixture as real native qualification. Recommendation stays advisory.

Extend operations with `session.permission.get`, `session.form.get` and
`session.inbox.cancel`. Validate request fields/parameter locations and success
body wrappers consumed by the pinned client, not merely route names or 200/204:
deterministic session creation ID + ownership metadata + permissions; prompt ID,
metadata/files/delivery; inbox correlation and cancellation; interrupt resume;
message pagination/outcomes; permission/form owned IDs and decisions; instruction
entries; catalog envelopes; SSE encoding/event Location/session ownership fields.

Resolve only bounded local schema references, with depth/node/cycle limits. Check
semantic required subsets and compatible envelopes, not whole-document hashes or
literal schema-component names. Permit harmless additive fields/operations and
optional capabilities; reject newly required request fields the client cannot
supply. No network reference fetching or startup behavioral mutations.

### Phase 3: cross-platform integration and migration invariants

Integrate verified platform metadata behind `SharedService.storage.*` concern
modules. Preserve existing macOS digest bytes; use a documented versioned Windows
volume/file identity serialization for new Windows histories. Never migrate or
rewrite native metadata/cursors/admissions automatically. Bigint identities must
not be rounded through JS number conversion. New Linux identity has no existing
supported shared history to reinterpret.

Native helper: dedicated `--inspect-local` stdio mode, no general agent session,
supervisor, network, filesystem writes or process-control authority. Protocol v1
uses bounded UTF-8 lines and hexadecimal byte fields (no extra JSON dependency):
`HELLO\t1`, `READ\t<hex absolute path>`, `PROCESS\t<pid>`; replies `OK` with
version/data or sanitized `ERR`. READ caps at 16 KiB and checks the very same
handle's ACL before and after reading. PROCESS caps at 4096 handles and 512 KiB
reply, returning process creation identity, image, canonical disk-file paths and
volume/file IDs, never contents. OpenProcess requests query/duplicate rights, no
terminate/VM-write. PSS captures handles only; reduced-right DuplicateHandle never
uses CLOSE_SOURCE or SAME_ACCESS. All native resources use RAII. TypeScript owns
OpenCode decoding, candidate selection and storage hashing.

The TS helper connection is persistent, serial and bounded (32 queued requests,
5-second request/start deadline, 1 MiB line limit), idles out and is unref'ed so it
cannot hold server shutdown open. Failure/timeout kills only this owned helper,
rejects pending work and never retries a native mutation. Startup handshake and
packaged binary identity reject old/mismatched helpers. No provider protocol is
added to the remote-agent protobuf session.

Preserve before-request registration fences and app-restart requirement for
generation changes. Same DB across manual native restart retains storage identity;
different DB (even same path) fails history binding. Credential rotation only
changes transport validation, never durable identity. No physical-exit inference,
implicit reconnect/resend, isolated fallback, uncertainty discharge or DB writes.

Keep shared remote targets unsupported explicitly. Test Windows permission path
normalization using native source/runtime, managed-file URIs, attachment immutable
publication and replay. Fix only proven cross-platform failures needed by shared
mode; unrelated attachment/remote redesign remains excluded.

### Phase 4: packaging, settings and truthful UX

Add Windows ARM64 artifact/identity
support and package-boundary tests alongside x64; retain installed-helper ownership
with bigbud, not OpenCode. Inspect all build/verification target consumers before
editing the table. Do not make Linux ARM64/musl require an unavailable bundled
binary when Node `/proc` metadata suffices. No native OpenCode dependency install.

Reuse existing windows-sys dependency features where possible; any new dependency
needs repository-mandated review/approval. Every authored/materially changed code
file remains <=400 lines, split by concern. Preserve stored isolated fields while
hiding/disabling them in shared UI. Shared config identity ignores inactive binary
overrides. Explain manual service startup/sign-in and capability errors without
promising that every future V2 protocol must work.

### Phase 5: validation and independent requirements review

After incorporating parent plan review: implement in dependency order, run
format/lint/typecheck/tests, diagnose failures, then independent requirements review.
Do not mark overall complete with simulated Windows tests only.

## Risks And Decision Gates

1. **Architecture/package scope (resolved by reviewed implementation direction):** a pure documented-HTTP/Node solution cannot
   currently establish Windows active DB identity. Recommended native probe needs
   Rust/Windows security and ARM64 packaging work beyond the apparent TS version
   fix. Review this scope explicitly; do not substitute a PowerShell/PInvoke-only
   dependency, process-generation hash or guessed path without addressing its
   deployment/security tradeoffs. Waiting for upstream identity metadata would not
   satisfy the already-agreed 2.0.24 floor without a separate older-version adapter.
2. **Infrastructure (resolved):** user authorized Windows GitHub Actions on a dedicated task branch. This session has macOS ARM64, a reachable Linux ARM64 Docker
   daemon, and an installed Windows x64 Rust cross target. No Windows execution
   environment was available through the supplied tools. Cross-compilation/mock
   platform branches do not prove Windows file-ID/ACL/process snapshot behavior.
3. **Unresolvable storage:** multiple SQLite files, in-memory storage,
   inaccessible process metadata or unsupported filesystem identities
   must remain explicit failures, not silent reductions
   of the requested reliability/ownership guarantees. Decide/prove support before
   advertising universal platform availability.
4. **Review orchestration:** parent-level independent plan review completed and
   its eight corrections are incorporated here. Nested delegation remains
   unavailable; direct implementation/validation and explicit self-review continue,
   followed by parent independent code/requirements review.

## Testing And Validation

- Version matrix: lower bound, inclusive minimum, .25/.26/.27, later minor, malformed
  and huge numeric components, unsupported majors/prereleases, one-time advisory.
- Capability matrix: each required operation absent; wrong body wrapper/parameters;
  missing ownership/admission fields; changed SSE encoding; missing/cyclic refs;
  extra unrelated fields/operations accepted; failure before session/catalog work.
- Filesystem/security: POSIX ownership/modes; Windows owner/DACL/null-DACL and
  reparse/ancestor attacks; symlink/rename races; bounded registration/probe reads;
  custom XDG, native Windows homedir vs HOME, explicit service files, spaces/Unicode,
  long/UNC/device paths evaluated explicitly rather than assumed equivalent.
- Storage/lifecycle: same-DB restart, replacement same pathname, credential rotation,
  PID reuse/generation race, changed/ambiguous handle inventory, extensionless DB,
  probe timeout/failure; no DB content access; no native lifecycle calls, credential
  inventory, config writes, automatic retries or history rebinding.
- Regression: saved approvals fail closed; full-access/auto-edits/approval-required
  semantics; attachments/replay; own-session permission/form replies and cleanup;
  SSE gap repair; service sibling sessions/config preserved; isolated/default/import
  settings and local-only target fences unchanged.
- Native fixtures: existing `SharedService.native.test.ts` and
  `SharedService.application.native.test.ts` use disposable HOME/XDG/DB and synthetic
  loopback model. Adapt macOS-only skip after actual platform implementation, never
  count a skipped test as coverage. Exercise minimum 2.0.24 and pinned 2.0.26; record
  binary source/hash, OS/arch and native-vs-simulated coverage. No user service tests.
- Packaging: Windows x64/ARM64 probe handshake, missing/old helper, packaged path
  with spaces, no shell/profile/PATH dependency; Linux glibc/musl and ARM64 access.
- Required sequence: `bun fmt`; `bun lint`; `bun typecheck`; focused
  `bun run --cwd apps/server vitest run ...`; applicable web browser tests;
  `bun run test`. For Rust edits also `cargo fmt --all --check`,
  `cargo clippy --locked --workspace --all-targets -- -D warnings`, and
  `cargo test --locked --workspace`. Never `bun test`; parent owns authorized task-branch publication for CI.

Research baseline command executed on macOS:

```sh
bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService.registration.test.ts src/provider/Layers/OpencodeV2/SharedService.discovery.test.ts src/provider/Layers/OpencodeV2/SharedService.security.test.ts src/provider/Layers/OpencodeV2/SharedService.lifecycle.test.ts src/provider/Layers/OpencodeV2/SharedService.binding.test.ts
```

Result: **5 files / 34 tests passed**, 4.32 seconds. These test existing behavior,
including the old allowlist; they do not validate the proposed changes. Docker
`info` confirmed Linux/aarch64 availability only; no Linux runtime tests were run.

Plan-only baseline checks also executed:

| Command                                           | Result                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`                                         | Passed; final worktree contains only this added plan.                                                                                                                                                      |
| `bun lint`                                        | Passed, 0 errors; 29 existing lint warnings and 24 existing test-length warnings. No unrelated cleanup.                                                                                                    |
| `bun typecheck`                                   | First invocation exceeded the 120-second tool timeout without a reported type error; unchanged rerun with a 600-second limit passed all 9 tasks in 23.986 seconds. Existing Effect advisory messages only. |
| Full test suite / native matrix / browser / cargo | Not run for this plan-only change. Required after implementation; no native or cross-platform completion claim.                                                                                            |

Plan-reviewer, code-consistency, format-lint-test-fixer and debugging delegation
were attempted but unavailable at the nested-agent depth limit. Direct execution
of the above commands is recorded honestly, not attributed to those agents.

## Acceptance Criteria

| ID  | Requirement                                                          | Evidence required                                                                                                    |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| AC1 | Research, reviewed plan before implementation                        | Pinned V2 evidence above; independent parent plan-review approval; resolved gates.                                   |
| AC2 | >=2.0.24 stable V2, compatible unknown newer releases allowed        | Positive/negative version and semantic capability tests; actual minimum/pinned native fixtures.                      |
| AC3 | macOS, Linux and Windows without new platform exclusions             | Platform metadata/security tests, native runtime evidence, Windows x64/ARM64 package coverage; limitations explicit. |
| AC4 | Existing user service only; native accounts/config/history preserved | No lifecycle calls; startup GET allowlist; disposable sibling/config conservation tests; no credential inventory.    |
| AC5 | Durable identity and no uncertain replay/rebinding                   | Old macOS digest golden, same/different DB tests, cursors/journal/attachment/recovery/ownership regression suites.   |
| AC6 | Legacy isolated behavior and accurate shared UX                      | Settings round trips/defaults; isolated runtime pin preserved; browser shared/isolated controls and wording tests.   |
| AC7 | Both completion gates; authorized task-branch CI only, no release    | Exact authoritative check results, independent all-complete requirements review, scoped diff and git status.         |

## Open Questions

No unresolved product decision. Windows native validation runs in a scoped Actions
workflow on x64 and ARM64, with minimum/pinned disposable OpenCode binaries
downloaded from official `@opencode/cli-windows-{x64,arm64}` npm packages, verified
against registry SHA512 integrity and recorded binary SHA256. GitHub's `v2.0.24`
release endpoint returned 404; official npm packages exist for both architectures.
No package scripts are run by the downloader. The workflow must fail
if required test-binary variables are absent. The parent publishes/monitors it.

Concrete packaging consumers: workspace-agent-target (PE machine ARM64 0xaa64),
server staging/completeness, desktop workspace-agent/supervisor selectors, release
artifact matrix/download patterns. Add an ARM64 native artifact producer together
with the required target; do not require missing release assets. No new dependency
is planned: enable Windows API features on existing windows-sys only.

Finite capability checks are scoped to the existing operation manifest plus the
three missing operations and their request/success/SSE consumed projections.
Reference traversal has local-only depth/node limits; renamed/inlined equivalent
schemas and additive fields are accepted. No general schema compatibility engine.

Self-review: parent corrections incorporated; proceed in order compatibility,
macOS/Linux storage, Windows helper, packaging/Actions, policy/UI/docs, validation.
Rollback is code-only: no native data migrations or identity rewrites occur.
Any changed service generation invalidates the connection until explicit app
restart; retained admissions/cursors cannot be rebound to another database.
**Code green: No. Implementation/Plan green: No** until implementation and native
validation plus parent review are complete.

## Implementation handoff

Production implementation, native-helper/ARM64 packaging, scoped Windows Actions,
policy/settings changes and regression tests are now present. Local macOS ARM64
and Linux ARM64 disposable native runs pass for minimum and pinned OpenCode.
Real Windows validation, full baseline checks and independent review remain gates,
not reasons to misrepresent a version-only change as completion. See the exact
[validation ledger and parent CI instructions](../validation/opencode-v2-cross-platform-2026-10-11.md).

Windows inspection deliberately rejects reparse, UNC/device and alternate-stream
paths rather than claiming unproved local durable identity. Standard local-drive
and extended-length local-drive paths use handle-based file IDs. No Linux
architecture or libc exclusion was introduced. Custom config roots remain the
documented pre-existing permission-policy limitation, never a blanket connection gate.
