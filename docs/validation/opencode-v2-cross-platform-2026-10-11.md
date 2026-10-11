# OpenCode V2 cross-platform shared-service validation

**Status:** Implementation handoff; Code green **No**, Implementation/Plan green **No**.
**Date:** 11 October 2026. Parent owns independent review and authorized task-branch CI publication; no release.

## Implemented scope

- Stable `>=2.0.24 <3.0.0`, capability-gated rather than patch allowlisted; finite consumed operation/request/response/SSE projections and bounded local refs. Required permission/form GET and inbox DELETE included. SDK/isolated pins unchanged.
- Existing macOS hash byte serialization preserved. Linux `/proc` inspection requires no native helper or new architecture/libc restriction. Unique open WAL/SHM database discovery supports extensionless names and repeated identity/generation fences.
- Provider-neutral `--inspect-local` helper: same-handle registration owner/DACL checks before/after bounded reads; no native config, provider credential or database-content reads. Bounded process-local handle-table snapshots and attributes-only retained duplicates expose process creation and Windows file IDs without native lifecycle control, process-memory snapshots, source-handle closure or file-position changes. The planned PSS candidate was replaced after native CI showed incomplete type metadata and unsupported non-file duplication.
- Bounded persistent TS helper peer, queue/deadline/frame/idle limits, safe missing-file error, version handshake. Simulated peer tests cover split replies, capacity, timeout and incompatible helper; they are not Windows proof.
- Windows ARM64 target, PE validation, required server release-artifact producer, scoped x64/ARM64 native CI and real packaged-path/helper smoke. No release workflow was executed.
- Verified registration-directory permission protection and Windows DOS/extended-path variants. Shared binary input disabled without deleting saved isolated values; inactive binary/profile settings do not invalidate a shared connection. Custom native config-root enumeration is not a new connection gate.

## Local validation

`VALIDATION=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/shared-cross-platform-validation`

`V24=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/shared-v2-qualification/2.0.24/package/bin/opencode`

`V26=/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/v2-2.0.26-qualification/cli-darwin-arm64/package/bin/opencode`

Both binaries are disposable official package downloads, never the user's executable.

| Exact command                                                                                                                                                                                                                                                                                                                                       | Result                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun fmt`; final task-only `xargs bun fmt -- < "$VALIDATION/task-files.txt"`                                                                                                                                                                                                                                                                        | Passed. Final scoped formatting avoids reformatting concurrent terminal UI work.                                                                                                                                                                                                          |
| `bun lint`                                                                                                                                                                                                                                                                                                                                          | Passed; existing warnings only after task warnings were corrected.                                                                                                                                                                                                                        |
| `bun typecheck`                                                                                                                                                                                                                                                                                                                                     | Passed all 9 tasks, 51.032 seconds. Intermediate task errors fixed; transient concurrent terminal UI type errors resolved by their owner.                                                                                                                                                 |
| `BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY="$V24" BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=2.0.24 BIGBUD_OPENCODE_V2_REQUIRED_NATIVE=1 bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService src/provider/Layers/OpencodeV2/Application.configKey.test.ts src/provider/Layers/OpencodeV2/Runtime.policy.shared.paths.test.ts` | 103 passed, 1 Windows-only test skipped, 34.85 seconds.                                                                                                                                                                                                                                   |
| Same preceding command with `V26` and `2.0.26`                                                                                                                                                                                                                                                                                                      | 103 passed, 1 Windows-only test skipped, 37.27 seconds. Subsequent additional packaged-native test is Windows-only too.                                                                                                                                                                   |
| `bun run --cwd apps/web test:browser src/components/settings/ProviderCard.opencodeV2.browser.tsx`                                                                                                                                                                                                                                                   | 1 passed: shared disabled field, isolated saved/editable values.                                                                                                                                                                                                                          |
| `bun run --cwd scripts vitest run lib/release-assets.test.ts lib/desktop-artifact/workspaceAgent.test.ts`                                                                                                                                                                                                                                           | 12 passed across 2 files.                                                                                                                                                                                                                                                                 |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo fmt --all --check`                                                                                                                                                                                                                                                                         | Passed. Process-local override; no global Xcode setting/license changed.                                                                                                                                                                                                                  |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo clippy --locked --workspace --all-targets -- -D warnings`                                                                                                                                                                                                                                  | Passed after correcting a new integration-test assertion/Result lint.                                                                                                                                                                                                                     |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo test --locked --workspace`                                                                                                                                                                                                                                                                 | Passed, including real read-only stdio integration on macOS.                                                                                                                                                                                                                              |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools cargo check --locked --package bigbud-remote-agent --test inspect_local --target x86_64-pc-windows-msvc`                                                                                                                                                                                         | Passed with existing platform warnings. Cross-compilation only, not Windows execution.                                                                                                                                                                                                    |
| `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2`                                                                                                                                                                                                                                                                               | Broad run: 23 isolated file-worker/sandbox failures from the local Python/Xcode launcher, plus 1 new fixture typo since corrected and successfully rerun in the scoped suite. No unrelated production fix.                                                                                |
| `bun run test`                                                                                                                                                                                                                                                                                                                                      | Failed on 2 assertions in concurrently authored `ThreadTerminalDrawer.layout.test.tsx` (expected 5 buttons, received 6; 2485 other web tests passed). Also reproduced isolated Python failures before Turbo stopped the remaining server run. Final retry: same blockers, 58.896 seconds. |

Final follow-up checks (after the table's earlier runs):

- `bun typecheck`: all 9 tasks passed again in 20.701 seconds.
- `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService src/provider/Layers/OpencodeV2/Application.configKey.test.ts src/provider/Layers/OpencodeV2/Runtime.policy.shared.paths.test.ts`: without native fixture variables, 97 passed / 8 skipped in 12.60 seconds. Skips are unconfigured disposable binaries and Windows-only cases, not coverage. An earlier launch timed out before the Vitest banner; unchanged retry passed.
- `bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/SharedService.packaging.test.ts src/provider/Layers/OpencodeV2/SharedService.windows.test.ts src/provider/Layers/OpencodeV2/SharedService.capabilities.test.ts`: 52 passed / 1 real-Windows-only packaged test skipped, 6.40 seconds.
- `git diff --check`: passed.
- `bun fmt:check`: additional read-only check found formatting in unchanged root `AGENTS.md` (no git status/diff for that file). Left outside task scope; the required `bun fmt` executions passed.

### Real Linux ARM64 local container

Image `node:24-bookworm-slim` (digest `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`) in local OrbStack. Only a source archive was mounted read-only; no host HOME, native state or credentials were mounted.

Inside the disposable container:

```sh
mkdir -p /work
tar -xzf /fixture-input/repo.tgz -C /work
cd /work
npm install --global bun@1.3.9
bun install --frozen-lockfile --ignore-scripts
for version in 2.0.24 2.0.26; do
  node scripts/opencode-v2-fixture.ts "$version" "/fixtures/$version"
  BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY="/fixtures/$version/package/bin/opencode" \
  BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION="$version" \
  BIGBUD_OPENCODE_V2_REQUIRED_NATIVE=1 \
  bun run --cwd apps/server vitest run \
    src/provider/Layers/OpencodeV2/SharedService.native.test.ts \
    src/provider/Layers/OpencodeV2/SharedService.application.native.test.ts \
    src/provider/Layers/OpencodeV2/SharedService.storage.native.test.ts \
    src/provider/Layers/OpencodeV2/SharedService.capabilities.test.ts \
    src/provider/Layers/OpencodeV2/Runtime.policy.shared.paths.test.ts
done
```

**Each version passed 5 files / 54 tests, zero skips.** Native transport, application/sibling preservation, same-DB restart and different extensionless DB identity exercised real Linux process metadata. This does not claim native Linux x64 or musl execution; neither receives a new production platform guard.

### Official binary provenance

The downloader verifies registry SHA512 tarball integrity and prints binary SHA256. GitHub's `v2.0.24` release endpoint was absent, so CI uses official scoped npm binary packages without installing or executing package scripts.

| OS/architecture/version | Binary SHA256                                                      |
| ----------------------- | ------------------------------------------------------------------ |
| macOS ARM64 2.0.24      | `e68cc32cb37b1f3242991c668be3934396825778925cb85670dad61038b05fe7` |
| macOS ARM64 2.0.26      | `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26` |
| Linux ARM64 2.0.24      | `216f1d58b539bba2dd662fe68cfbae2d1eb3b4ab7c4f20088827437f204c5921` |
| Linux ARM64 2.0.26      | `09632275534db1df1c158329fdc4e9fd7fe5d9dbc79cff090314553ec00757f1` |
| Windows x64 2.0.24      | `542c51f075026e1dbd5b676ebce685d0b454face48872b0813d08f867e2c4eaa` |
| Windows x64 2.0.26      | `e13e57a7f6b7abddec887e0b2d912d22484077c50dff5bed4f3199bcf63b6088` |
| Windows ARM64 2.0.24    | `539b416417ccfe7595c04c02501ae47d6ea6defe62df1169b39b3872135b300f` |
| Windows ARM64 2.0.26    | `e412f4bc3382d093d5accfaf3fecae0aa4a6587a2bd07094803447522d4895a5` |

## Parent handoff and remaining gates

1. Publish only task-owned changes on a dedicated `task/opencode-v2-*` branch. Its push automatically triggers `.github/workflows/opencode-v2-shared.yml`; a new workflow may not yet support dispatch from the default branch. Monitor all four x64/ARM64 × minimum/pinned jobs, diagnose/fix failures, rerun until green. User authorized this task-branch publication; implementer has not committed or pushed. **Do not run the release workflow.**
2. Native Windows jobs exercise real ACL privacy/null-DACL/ancestor/reparse rejection, process/file identity, borrowed application lifecycle, history identity and packaged resolver/PE/protocol handshake. They fail if required binary/version configuration is absent. Until these execute, Windows support remains unverified, not simulated-as-qualified.
3. Windows Rust CI deliberately runs `cargo test --locked --package bigbud-remote-agent --test inspect_local`: existing unrelated library `supervisor/core/reliability_tests` do not compile for Windows because `Writer`/`super::writer` are Unix-gated. Focused integration tests compile production code without those unrelated unit modules. Do not claim full Windows Rust workspace tests passed.
4. Local baseline blocker reproduction: `env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -S -c 'print("probe")'` fails with the unaccepted Xcode license. Existing `Coding.files.ts` uses that sanitized environment, so a caller `DEVELOPER_DIR` cannot repair those tests. User/parent must resolve local developer tools configuration/license if desired; this task does not accept licenses or alter global settings.
5. Concurrent terminal layout files appeared during implementation. They are not this task's changes and must be preserved/excluded from this task's publication. A 50-file task allowlist (plus this validation document) and exact logs are in `$VALIDATION`; never stage the entire worktree indiscriminately.
6. Parent independently reviews code/security and AC1–AC7 after checks/native gates pass. Nested code-consistency, format-lint-test-fixer and debugging delegation returned `Subagent depth limit reached (1)`. Direct self-review/testing is not independent approval.

**AC3/AC5 platform proof and AC7 completion gates remain partial.** New authored code files are within 400 lines. No native user service, configuration, credentials or database was touched. Nothing was staged, committed or pushed by this implementer.

## Windows CI publication and investigation

**Security qualification: BLOCKED (P2, foreign socket duplication).** The reviewer rejected source `3b229f7397f82f70dd18bcbc95a52f96401b4211`: kernel File candidates included sockets and `DuplicateHandle` ran before device classification. Microsoft explicitly documents that this interferes with socket reference counting. Disruption was not reproduced, and TCP survival is not a sufficient safety proof. A corrected source requires independent security re-review.

**Prior native Windows runtime qualification: GREEN.** [Run 38156070944](https://github.com/youpele52/bigbud/actions/runs/38156070944) completed successfully on all four jobs at source commit `3b229f7397f82f70dd18bcbc95a52f96401b4211`. Last job completed 2026-10-11 16:44:55 UTC. This is runtime evidence only, not security approval; prior review approval is not extended automatically.

Task branch: `task/opencode-v2-windows-validation-20261011` in `youpele52/bigbud`. These are branch-only commits; no tags, releases, release-workflow execution, merges or force pushes.

| Commit                                     | Actual run                                                                  | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `420f0c83f59eb87158679881c0c96c572dd23f3b` | [38141724211](https://github.com/youpele52/bigbud/actions/runs/38141724211) | All four failed. ARM64 Bun install failed; x64 reached TS tests. A combined PowerShell step incorrectly masked the Rust test failure with a successful build.                                                                                                                                                                                                                                                                                       |
| `55c1e548fde5bb321b9f2fe861166a9b21c4a86a` | [38141923007](https://github.com/youpele52/bigbud/actions/runs/38141923007) | All four failed. Native ARM64 Node/Bun assertions and installation passed after Bun 1.3.14 pin; all platforms reached ACL failures.                                                                                                                                                                                                                                                                                                                 |
| `2936a52012520aca915a0c73b152c55aefacf6eb` | [38142357627](https://github.com/youpele52/bigbud/actions/runs/38142357627) | All four failed. Separate Rust test step correctly blocked downstream qualification; disposable diagnostics identified inherited PowerShell 7 module paths breaking Windows PowerShell 5.1 Security module loading.                                                                                                                                                                                                                                 |
| `e4e563403a5e1b71b2e7a9d2574a643059877328` | [38143006046](https://github.com/youpele52/bigbud/actions/runs/38143006046) | All four failed. Fixed module isolation produced ACL snapshots. Elevated runner fixtures were Administrators-owned; system-drive ancestor was TrustedInstaller-owned.                                                                                                                                                                                                                                                                               |
| `8440e5ebccf9cb5172fc9cd743d89d74bae84b54` | [38144257134](https://github.com/youpele52/bigbud/actions/runs/38144257134) | All four failed at snapshot type classification: Rust 2 passed / 2 failed per job. Disposable native registration reads now pass on x64 and ARM64. Final protocol corrections were deliberately excluded while actively edited.                                                                                                                                                                                                                     |
| `cc4cd4398944e62ecf33dc8de84a8b7dd5e3cefd` | [38144339425](https://github.com/youpele52/bigbud/actions/runs/38144339425) | All four failed with the same snapshot-type rejection. Includes all completed P1 files and final request/response directionality corrections. Downstream qualification did not run.                                                                                                                                                                                                                                                                 |
| `966fcc35f1c42ca0692d7c23fa8c7a3e312caa61` | [38144864630](https://github.com/youpele52/bigbud/actions/runs/38144864630) | All four failed. PSS supplied zero metadata flags/type/name lengths on a live inventory entry. Rust 2 passed / 2 failed per job. TS: x64 .26 128 passed / 3 failed / 1 POSIX-only skipped; others 127 passed / 4 failed / 1 POSIX-only skipped. Packaged-native smoke passed on all four, while obsolete unsupported-ARM64 resolver assertion failed (13 passed / 1 failed per job). ARM64 profile inspection hit the 5-second PowerShell deadline. |
| `7ee6dceaffccba5edb06525471c3fc10acd9ed8d` | [38145617981](https://github.com/youpele52/bigbud/actions/runs/38145617981) | All four failed. All four packaging suites now pass 14/14, zero skips; ARM64 PowerShell timeout resolved. Rust 2 passed / 2 failed per job with Windows error 50 while obtaining metadata rights. All TS suites: 127 passed / 4 failed / 1 POSIX-only skip. Custom model absent from native catalog; storage identity remains blocked by helper.                                                                                                    |
| `d38149d014494e04493784918001c1e8224ed222` | [38146480826](https://github.com/youpele52/bigbud/actions/runs/38146480826) | All four failed. ReOpenFile did not resolve error 50, invalidating the earlier rights-escalation attribution. Packaging 14/14 each; native coexistence passed both .24 jobs, catalog settlement still raced in .26. Other failures remained helper/storage-dependent.                                                                                                                                                                               |
| `1bf8d9e2c0da13f6d4c2aa7f6bbd267cccb231a3` | [38147439797](https://github.com/youpele52/bigbud/actions/runs/38147439797) | All four failed. Bounded ProcessHandleInformation/type-index classification eliminated error 50; exact diagnostics now show ReOpenFile access denied. Native coexistence passed all four after waiting for the synthetic provider, packaging 14/14 each. Each TS suite: 128 passed / 3 helper-dependent failures / 1 POSIX-only skip.                                                                                                               |
| `035ef6e4973b285adc1ffa45c7dbf41637e41a2d` | [38148235833](https://github.com/youpele52/bigbud/actions/runs/38148235833) | All four failed. Direct attributes query identified the exact missing access: zero-right duplicates return access denied. Native coexistence and 14/14 packaging remain passed; 128 TS passed / 3 storage-dependent failed / 1 POSIX-only skipped per job.                                                                                                                                                                                          |
| `c1b96dbcca16b0be5f9524110dd70d9c7f058604` | [38148880123](https://github.com/youpele52/bigbud/actions/runs/38148880123) | All four failed. Unconditionally requesting FILE_READ_ATTRIBUTES exceeded rights on some source handles; retain stage returned access denied.                                                                                                                                                                                                                                                                                                       |
| `149140f13d52fe703858fe8b9ada74271cfa7752` | [38153935493](https://github.com/youpele52/bigbud/actions/runs/38153935493) | All four failed. Rights intersected with the source grant and standard information classified traverse-only directories, removing access failures. Remaining rejection was unknown GetFileType classification. Rust 2 passed / 2 failed; TS 128 passed / 3 failed / 1 POSIX-only skip; packaging 14/14 each.                                                                                                                                        |
| `6c9deb42cc457662c3348e234caee654d050d12f` | [38154630312](https://github.com/youpele52/bigbud/actions/runs/38154630312) | All four failed. Bounded device-information diagnostics identified FILE_DEVICE_KSEC (0x39) on x64 and FILE_DEVICE_CRYPT_PROVIDER (0x3f) on ARM64. Same counts as prior run.                                                                                                                                                                                                                                                                         |
| `2680e0958227ab18afeeeeb886242998a9953f39` | [38155363276](https://github.com/youpele52/bigbud/actions/runs/38155363276) | All native/application/storage suites passed: 131 passed / 1 POSIX-only skip and packaging 14/14 each. Rust 2 passed / 2 failed only on fixture path matching and ACL mutation setup. Production now excludes those exact proven non-filesystem security device types.                                                                                                                                                                              |
| `3b229f7397f82f70dd18bcbc95a52f96401b4211` | [38156070944](https://github.com/youpele52/bigbud/actions/runs/38156070944) | **All four jobs completed SUCCESS.** Fixture canonicalization expands Windows short TEMP ancestors before path matching; fixture ACL mutation handle includes READ_CONTROL along with WRITE_DAC. Rust 4/4, TS 131 passed / 1 POSIX-only skip, packaging 14/14 per job.                                                                                                                                                                              |

### Final Windows coverage

| Native target | Version | Rust helper          | Transport/application/storage, protocol and ACL | Packaging                      | Job                                                                                           |
| ------------- | ------- | -------------------- | ----------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| x64           | 2.0.24  | 4 passed, zero skips | 9 files, 131 passed, 1 POSIX-only skip          | 2 files, 14 passed, zero skips | [114519198916](https://github.com/youpele52/bigbud/actions/runs/38156070944/job/114519198916) |
| x64           | 2.0.26  | 4 passed, zero skips | 9 files, 131 passed, 1 POSIX-only skip          | 2 files, 14 passed, zero skips | [114519198905](https://github.com/youpele52/bigbud/actions/runs/38156070944/job/114519198905) |
| ARM64         | 2.0.24  | 4 passed, zero skips | 9 files, 131 passed, 1 POSIX-only skip          | 2 files, 14 passed, zero skips | [114519198972](https://github.com/youpele52/bigbud/actions/runs/38156070944/job/114519198972) |
| ARM64         | 2.0.26  | 4 passed, zero skips | 9 files, 131 passed, 1 POSIX-only skip          | 2 files, 14 passed, zero skips | [114519198784](https://github.com/youpele52/bigbud/actions/runs/38156070944/job/114519198784) |

Includes actual native registration, transport/coexistence, replay, native tools, disable/rebind, active TUI sibling preservation, distinct extensionless databases, same-database restart, Windows owner/DACL rejection, retained TCP preservation, traverse-only directory classification, file replacement, rejected deleted-open-file churn, handle leak/recovery, capability admission, protocol directionality, native helper package execution and ARM64 PE identity. The one TS skip is the POSIX permission test. No full Windows Rust workspace test or release certification is claimed. Complete logs: `$VALIDATION/windows-run-38156070944.full.log` (previous runs use their run IDs in the same naming pattern).

### Windows review summary

#### P2 containment: foreign socket reference-count immutability

The later security review blocks the previously runtime-green source. The narrow correction rejects every unresolved kernel File candidate **before** the retention callback, and opens the inspected process with query-only rights (no PROCESS_DUP_HANDLE). A File type index is not positive evidence of a regular disk file; all current File candidates remain unresolved. This is deliberate fail-closed containment, **not working Windows shared-storage support**. Registration same-handle ACL/path fences and the retained regular-file identity code remain unchanged. Existing success assertions remain enabled and are expected to expose the remaining Windows capability blocker.

Evidence and limits:

- [Microsoft DuplicateHandle remarks](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle#remarks) explicitly warn that socket duplication interferes with internal reference counting. Zero-right duplicates and a surviving TCP exchange do not discharge this requirement.
- [PROCESS_HANDLE_TABLE_ENTRY_INFO](https://github.com/winsiderss/phnt/blob/master/ntpsapi.h) exposes handle value, counts, access, type index and attributes, but no filesystem/socket subtype or pinned disk reference. Existing post-duplication GetFileType/device queries are too late.
- [PSS_CAPTURE_FLAGS](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/ne-processsnapshot-pss_capture_flags) describes PSS_CAPTURE_HANDLES as capturing handle values only. [PSS_HANDLE_ENTRY](https://learn.microsoft.com/en-us/windows/win32/api/processsnapshot/ns-processsnapshot-pss_handle_entry) exposes a handle value plus captured metadata, not an atomic checked disk-file acquisition. Even complete name metadata would not bind a subsequent DuplicateHandle to the same object after source handle-number reuse. Earlier native runs also proved missing PSS metadata. No claim is made about undocumented internal PSS implementation.
- No inspected API establishes a safe atomic handoff under the current constraints. PSS was not reintroduced, unknown File entries are not dropped, and no WSADuplicateSocket, process suspension/injection, driver installation or process-memory access was added. A viable implementation requires a separately reviewed storage-identity authority or atomic OS facility; that architectural work is unresolved.
- `windows.handles.test.rs` creates actual TCP listener/client/accepted and UDP sockets, verifies their kernel type matches a disk file, then exercises the production inspection path with an injected retention recorder. The hook clones only a known test-owned regular file if called, so it can detect the old bug without duplicating sockets. Assertions require zero socket attempts, zero unresolved-file attempts and Unsupported instead of a partial success. A second native test covers an unresolved inventory with a regular disk file. These tests are included in the existing Windows integration CI target; runtime qualification assertions are not relaxed.
- Local containment checks: scoped `bun fmt`, `bun lint`, Rust fmt/clippy/workspace tests and Windows x64 cross-check pass. An intermediate global `bun typecheck` failed on concurrent web edits in `ChatView.browser/context.catalog.ts`, `ChatView.browser/context.tsx`, and `test/wsRpcHarness.ts`; none was edited here. Final global `bun typecheck` rerun passes all nine tasks. Logs use `$VALIDATION/windows-security-*`.

Containment source: `5e2e1bff81afa7d1cd3d0b6501904f30e24dd319`. [Run 38157700454](https://github.com/youpele52/bigbud/actions/runs/38157700454) completed **FAILURE on all four jobs**, last job 2026-10-11 17:06:52 UTC. Actual per-job results are identical:

| Job          | Socket/nonpartial safety regressions | Rust helper total                | Native/application/storage TS             | Packaging |
| ------------ | ------------------------------------ | -------------------------------- | ----------------------------------------- | --------- |
| x64 2.0.24   | Both passed                          | 5 passed / 2 failed / zero skips | 128 passed / 3 failed / 1 POSIX-only skip | 14 passed |
| x64 2.0.26   | Both passed                          | 5 passed / 2 failed / zero skips | 128 passed / 3 failed / 1 POSIX-only skip | 14 passed |
| ARM64 2.0.24 | Both passed                          | 5 passed / 2 failed / zero skips | 128 passed / 3 failed / 1 POSIX-only skip | 14 passed |
| ARM64 2.0.26 | Both passed                          | 5 passed / 2 failed / zero skips | 128 passed / 3 failed / 1 POSIX-only skip | 14 passed |

The two Rust inventory-success tests and three application/storage-success tests remain enabled and fail because disk provenance is unavailable under the guard. This is an architectural capability blocker, not CI infrastructure failure. Runtime registration/transport, protocol checks and packaging continue to pass. Complete log: `$VALIDATION/windows-run-38157700454.full.log`.

Independent security re-review of containment is pending; the parent was asked to recall `ses_ed4ec5a98ffe83D5jMFYfVywWo` for `5061e723d611a30c34995b5fce045b53acfa5b04..5e2e1bff81afa7d1cd3d0b6501904f30e24dd319`. This session has no reviewer recall/delegation tool and does not claim approval. Overall Windows qualification remains BLOCKED; the earlier four-job runtime green is not carried forward. Completing Windows shared storage requires a reviewed source of process-bound storage identity with no unsafe foreign-handle acquisition; the current narrow helper-only scope does not establish one.

Independent parent review: protocol scoped **GREEN**, including nullable-response rejection and integer-response/number-consumer directionality. Linux bigint/inventory and Unix registration fixes remain approved. Security engineer's Windows helper source review is **GREEN**, contingent on real native CI. Parent verified `git hash-object` for `SharedService.windows.ts`, `SharedService.windows.binary.ts`, `inspect_local/{mod,protocol,windows,windows.file,windows.security}.rs` and `tests/inspect_local.rs` matches `8440e5ebccf9cb5172fc9cd743d89d74bae84b54`. This establishes the reviewed helper's commit attribution; it does not substitute for native qualification.

**Parent incremental review required:** compare `8440e5ebccf9cb5172fc9cd743d89d74bae84b54..3b229f7397f82f70dd18bcbc95a52f96401b4211` for `crates/bigbud-remote-agent/Cargo.toml`, `src/inspect_local/{mod.rs,windows.rs,windows.handles.rs,windows.object.rs}`, `tests/inspect_local.rs`, and `apps/server/src/provider/Layers/OpencodeV2/{ProfileIsolation.windows.mjs,ServerManager.child.ts,SharedService.native.fixture.ts}`. Original registration fences in `windows.file.rs` and `windows.security.rs` are byte-identical to the previously reviewed commit. Native green is now established; these later production changes have not received independent approval in this session.

- Helper admission executes side-effect-free `--check --capabilities` before `--inspect-local`; legacy plain check retains seven identity fields. Executable old-helper regression proves rejected admission creates no state. Closing during preflight aborts its owned process before inspection can start.
- `windows.handles.rs` uses process-local `NtQueryInformationProcess(ProcessHandleInformation)` (Windows 8+) with a fixed 4096-entry bound, explicit returned-length/layout checks and per-boot kernel type indices. A metadata-only handle to the helper's own executable establishes the File type index without creating state. Proven non-file entries need no duplication; missing/invalid inventory information rejects. No system-wide table or process memory is read.
- Each File candidate has exactly one retained source duplicate, requesting only the intersection of its granted rights and FILE_READ_ATTRIBUTES. Bounded `NtQueryObject(ObjectTypeInformation)` rechecks its type; `GetFileType` excludes character/pipe devices. Standard information excludes directories even when traverse-only. Unknown file types require a complete fixed-size device-information query: only NETWORK (not NETWORK_FILE_SYSTEM), NULL, KSEC and CRYPT_PROVIDER are irrelevant; unsupported types reject. Final pathname and 128-bit file ID come from the retained object. The checked no-reparse pathname handle must match that ID before its owner ACL is queried. Source handle closure, observed type reuse, deleted files, changed path identity, overflow or native-query failure reject the inventory. No Winsock operations are performed on probes; the native regression verifies active TCP traffic after inspection.
- Native regression exercises same-path file-ID replacement and 32 rejected deleted-open-file inventories with source handle churn, stable helper handle counts and successful recovery. The original-handle ACL recheck and checked ancestor/path reopen in `windows.file.rs` are preserved.
- Windows PowerShell receives the fixed system module directory instead of inherited PS7/user module paths. Exact TrustedInstaller SID is trusted only for ancestors. Effective child-deletion/ACL mutation grants still reject; inherit-only ancestor grants and creating a new sibling do not confer replacement rights. Leaf ownership remains current-user-only.
- Elevated CI fixture ownership is assigned explicitly using the current user SID, only inside disposable fixture roots. This does not relax production owner checks or alter installed native service/config/database state.
- The Windows workflow uses separate build/test steps, explicit runtime architecture assertions, official-package integrity verification, native fixtures and packaged helper/PE checks. Focused Windows Rust integration is distinct from a full Windows workspace test claim.

### Local reconciliation

Original checkout remains `plan/terminal-rust-gpu-reliability`, with an empty staged diff. Its HEAD advanced independently from `a2ff0368dddd8303f9f767b75d42a79b6911725c` through the greeting commits to `b7f4e888521c13a85a3b384c3f9f02f88d48a8fe`; this Windows task neither switched nor committed on that branch. Publication uses a temporary index seeded from the last task commit, exact allowlisted paths, `commit-tree` and a normal fast-forward task-branch push. Final source verification found 75 published paths against the original baseline, all matching the original working files except this ledger's final evidence update. All published authored code/test files are within 400 lines. Concurrent terminal/greeting files were excluded.

An earlier, now-unused worktree remains at `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/shared-cross-platform-validation/windows-ci-worktree`. Read-only verification found clean tracked/untracked status and no commits unique against the published task branch. It retains ignored installed dependencies and was neither reused after steering nor removed.

Final local checks: scoped `bun fmt`, `bun lint`, all nine `bun typecheck` tasks (22.845 seconds), process-local CommandLineTools `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, and `cargo test --locked --workspace` passed. Intermediate typecheck failures came from concurrently edited terminal files; the final full check passes. Focused macOS real native 2.0.24 fixture/storage rerun: 2 files / 3 tests passed. x64 Windows cross-check passed with existing platform warnings; an ARM64 cross-check could not run locally because that Rust target is absent. Native ARM64 CI supplied the runtime proof. Logs: `$VALIDATION/windows-final-{cargo-test,lint,typecheck}.log` and `windows-x64-check.log`. Parent's broad Linux results below remain separately scoped; that suite was not duplicated.

## Independent-review P1 corrections (11 October, scoped Unix/protocol follow-up)

This follow-up owns **only protocol capability, Linux storage, Unix registration, their tests/fixtures and this ledger**. No Windows/helper/Rust/CI files were edited or published. The checkout visible to this implementer remained `plan/terminal-rust-gpu-reliability` at `a2ff0368dddd8303f9f767b75d42a79b6911725c`; no branch/worktree change was made. Parent/CI publication state is separate and must not be inferred from this checkout.

### Corrections and evidence

| Item                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 consumed protocol           | Prompt `delivery: queue`, `resume: true`, attachment `uri`/`name` and unsupported mandatory attachment fields are checked. Admission/inbox queue, user identity and metadata; message correlation, assistant completion/errors/model/text/reasoning/tool states/token cache, idle outcomes; required JSON/SSE envelopes, pagination cursor contents and consumed query values are checked. Local references, renamed/inlined equivalents and additive fields/values remain accepted. | `SharedService.protocol.test.ts`: 38 independent-fixture cases, including 35 incompatible mutations. Existing capability tests also use the official fixture rather than reconstructing it from the production manifest. |
| P1 lossless Linux identity     | `/proc` and pathname metadata use bigint stats. Linux identity serializes device/inode as decimal strings under `opencodeV2-shared-linux-v1`; numeric Linux input is rejected. macOS retains the exact historical array/number serialization and digest.                                                                                                                                                                                                                             | Adjacent `9007199254740992` / `9007199254740993` device and inode tests; historical macOS digest regression; real same-DB restart and distinct extensionless DB tests on both OSes.                                      |
| P1 invalidated Linux inventory | Deleted regular-file FDs, FD/path identity mismatches and unresolved `ENOENT` observations remain explicit invalidation evidence. Discovery rejects a partial inventory rather than selecting its surviving plugin DB. Both scans' opened inode/device identities must match the selected pathname metadata.                                                                                                                                                                         | Real task-owned Node SQLite process holds two WAL DBs; ambiguity, unlink and atomic replacement each reject. All three execute on Linux ARM64, not simulated platform substitution.                                      |
| Unix registration security     | Bounded positional read on an `O_NOFOLLOW` handle; bigint type/owner/privacy/size checks before and after reading; current `lstat` pathname comparison of dev/ino/uid/gid/mode/size/mtimeNs/ctimeNs/nlink. Growth, replacement and permission changes fail before dispatch.                                                                                                                                                                                                          | Real-file chmod, rename replacement, symlink replacement and growth injected during the opened-handle read; all four assert zero HTTP calls. Passed on macOS and Linux.                                                  |

The official fixture is an **88 KB / 169-record endpoint/reference closure**, not the full 537 KB upstream blob. `SharedService.official.generate.mjs` has a frozen operation list independent of the production manifest, verifies each complete upstream file's SHA256, preserves upstream objects verbatim, verifies the two closures are identical, and emits one deduplicated NDJSON fixture. It fails rather than silently deduplicating divergent contracts. Generator and all authored code/test files remain below 400 lines.

Final generator regeneration preserved the fixture byte-for-byte: SHA256 `6c30d10f08da96814f68efb9a6e6a001c68d057840b980465455a22cc5c1e35b`. The final generator-only loop cleanup removed a lint warning without changing production or test data; all focused tests and required local checks were rerun afterward.

Pinned official OpenAPI input hashes:

- `2.0.24`, commit `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`: `0612418392961ef22f0337ce0e1e520270917665fc85f29c4af1c94d1e1873ee`.
- `2.0.26`, commit `9b4ec5714d481559990db0a816d5dec19541a814`: `17951689576c124f66a8b0270d759429f46d2235293b1ec228e889994ac56e5b`.
- URLs, commits and hashes are retained in the fixture provenance records. Current V2-only `https://opencode.ai/v2/docs/api` and Context7 `/websites/opencode_ai_v2` corroborated prompt and pagination syntax. No V1 documentation or native user service was consulted.

### Exact final validation commands

Use `VALIDATION` above and these shell variables from the repository root:

```sh
P=src/provider/Layers/OpencodeV2
FOCUSED="$P/SharedService.protocol.test.ts $P/SharedService.capabilities.test.ts $P/SharedService.registration.races.test.ts $P/SharedService.storage.identity.test.ts $P/SharedService.storage.linux.test.ts $P/SharedService.discovery.test.ts $P/SharedService.registration.test.ts $P/SharedService.storage.test.ts"
NATIVE="$P/SharedService.native.test.ts $P/SharedService.application.native.test.ts $P/SharedService.storage.native.test.ts"
xargs bun fmt -- < "$VALIDATION/p1-files.txt"
bun lint
bun typecheck
printf '%s\n' "$FOCUSED" | xargs bun run --cwd apps/server vitest run
for version in 2.0.24 2.0.26; do
  if [ "$version" = 2.0.24 ]; then binary="$V24"; else binary="$V26"; fi
  printf '%s\n' "$NATIVE" | env \
    BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY="$binary" \
    BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION="$version" \
    BIGBUD_OPENCODE_V2_REQUIRED_NATIVE=1 \
    xargs bun run --cwd apps/server vitest run
done
git diff --check
```

| Final check                       | Result / log under `VALIDATION`                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped `bun fmt`                  | Passed for owned source/test files; NDJSON is data, not formatter input. Ledger formatted separately with `bun fmt -- docs/validation/opencode-v2-cross-platform-2026-10-11.md`.                  |
| `bun lint`                        | Passed; pre-existing warnings only (`p1-lint.log`).                                                                                                                                               |
| `bun typecheck`                   | 9/9 tasks passed; final rerun 73.167 seconds (`p1-typecheck.log`).                                                                                                                                |
| macOS focused tests               | 7 files / 131 tests passed; 3 Linux-only tests skipped honestly (`p1-focused.log`).                                                                                                               |
| Linux focused tests               | 8 files / 134 tests passed, **zero skips**, including actual process/SQLite regressions (`p1-linux.log`).                                                                                         |
| macOS real native 2.0.24 / 2.0.26 | Each 3 files / 4 tests passed, zero skips; 14.33 / 15.99 seconds (`p1-macos-2.0.24.log`, `p1-macos-2.0.26.log`).                                                                                  |
| Linux real native 2.0.24 / 2.0.26 | Each 3 files / 4 tests passed, zero skips; 13.61 / 13.36 seconds (`p1-linux.log`). Binary hashes match the earlier provenance table.                                                              |
| `git diff --check`                | Passed.                                                                                                                                                                                           |
| Full suite / Rust / Windows       | Not rerun in this scoped follow-up: user directed focused tests, no repeated known unrelated full-suite failures; no Rust/Windows files owned or edited. CI agent owns native Windows validation. |

Linux ran in a fresh local `node:24-bookworm-slim` ARM64 container. `git ls-files --cached --others --exclude-standard -z | tar --null -T - -czf "$VALIDATION/p1-repo.tgz"` captured the source only; this archive was mounted read-only at `/fixture-input/repo.tgz`. No host HOME, credentials, native config, or native database were mounted. Container setup and checks:

```sh
apt-get update -qq && apt-get install -y -qq git ca-certificates python3 >/dev/null
mkdir /work; tar -xzf /fixture-input/repo.tgz -C /work; cd /work
npm install --global bun@1.3.9
bun install --frozen-lockfile --ignore-scripts
# Set P, FOCUSED and NATIVE exactly as above.
printf '%s\n' "$FOCUSED" | xargs bun run --cwd apps/server vitest run
for version in 2.0.24 2.0.26; do
  node scripts/opencode-v2-fixture.ts "$version" "/fixtures/$version"
  printf '%s\n' "$NATIVE" | env \
    BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY="/fixtures/$version/package/bin/opencode" \
    BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION="$version" \
    BIGBUD_OPENCODE_V2_REQUIRED_NATIVE=1 \
    xargs bun run --cwd apps/server vitest run
done
```

### Broader-suite disposition supplied by parent

Parent's Linux Docker broad OpenCode run: **98 files / 390 tests passed**, **25 files / 38 tests skipped**, two failures: `Coding.receipts.test.ts` concurrent capacity and `ServerManager.ssh.test.ts` bootstrap. Log: `/Users/youpele/.local/share/opencode/shell/3cd1dc2c76351a6b49872827a098f6ff69ce3c4a/sh_12b0eed72001YF8adOt8RwNcTz.out`.

Same container setup against unchanged `git archive a2ff0368dddd8303f9f767b75d42a79b6911725c` reproduced the receipt capacity failure exactly (two fulfilled, expected one); **receipt is proven pre-existing isolated-mode behavior**. SSH passed that isolated baseline run; its broad-run failure remains transient/unresolved and cannot honestly be assigned as a regression or dismissed as proven baseline. Bootstrap and fixture/profile source diffs were empty. Baseline log in the same directory: `sh_12b1360b1001vmQrue4IpvddG4.out`. Neither unrelated area was edited.

### Exact P1-owned changed paths

All following names are relative to `apps/server/src/provider/Layers/OpencodeV2/`:

```text
SharedService.schema.ts
SharedService.protocol.ts
SharedService.protocol.requests.ts
SharedService.protocol.projections.ts
SharedService.protocol.test.ts
SharedService.official.fixture.ts
SharedService.official.generate.mjs
SharedService.official.ndjson
SharedService.test.fixture.ts
SharedService.registration.ts
SharedService.registration.unix.ts
SharedService.registration.races.test.ts
SharedService.storage.ts
SharedService.storage.unix.ts
SharedService.storage.linux.ts
SharedService.storage.linux.test.ts
SharedService.storage.linux.fixture.mjs
SharedService.storage.identity.ts
SharedService.storage.identity.test.ts
```

Plus `docs/validation/opencode-v2-cross-platform-2026-10-11.md`. The source allowlist is `$VALIDATION/p1-files.txt`; preserve other concurrent files and do not stage the whole checkout.

**Scoped checks passed; overall Code green and Implementation/Plan green remain No.** Nested `code-consistency`, `format-lint-test-fixer` and `review` calls were attempted and returned `Subagent depth limit reached (1)`. Direct testing/self-inspection is not independent review approval. Parent must obtain final independent review (including these P1/security fixes), incorporate CI-owned Windows evidence and disposition broader-suite blockers. This implementer staged, committed and pushed nothing; no native user service/configuration/data was touched.
