# OpenCode V2 cross-platform shared-service validation

**Status:** Implementation handoff; Code green **No**, Implementation/Plan green **No**.
**Date:** 11 October 2026. Parent owns independent review and authorized task-branch CI publication; no release.

## Implemented scope

- Stable `>=2.0.24 <3.0.0`, capability-gated rather than patch allowlisted; finite consumed operation/request/response/SSE projections and bounded local refs. Required permission/form GET and inbox DELETE included. SDK/isolated pins unchanged.
- Existing macOS hash byte serialization preserved. Linux `/proc` inspection requires no native helper or new architecture/libc restriction. Unique open WAL/SHM database discovery supports extensionless names and repeated identity/generation fences.
- Provider-neutral `--inspect-local` helper: same-handle registration owner/DACL checks before/after bounded reads; no native config, provider credential or database-content reads. PSS handles-only snapshot and reduced-right duplicates expose process creation and Windows file IDs without native lifecycle control, process-memory snapshots, source-handle closure or file-position changes.
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

| OS/architecture/version | Binary SHA256                                                              |
| ----------------------- | -------------------------------------------------------------------------- |
| macOS ARM64 2.0.24      | `e68cc32cb37b1f3242991c668be3934396825778925cb85670dad61038b05fe7`         |
| macOS ARM64 2.0.26      | `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`         |
| Linux ARM64 2.0.24      | `216f1d58b539bba2dd662fe68cfbae2d1eb3b4ab7c4f20088827437f204c5921`         |
| Linux ARM64 2.0.26      | `09632275534db1df1c158329fdc4e9fd7fe5d9dbc79cff090314553ec00757f1`         |
| Windows x64/ARM64       | Not yet executed; CI must record actual binary hashes and runtime results. |

## Parent handoff and remaining gates

1. Publish only task-owned changes on a dedicated `task/opencode-v2-*` branch. Its push automatically triggers `.github/workflows/opencode-v2-shared.yml`; a new workflow may not yet support dispatch from the default branch. Monitor all four x64/ARM64 × minimum/pinned jobs, diagnose/fix failures, rerun until green. User authorized this task-branch publication; implementer has not committed or pushed. **Do not run the release workflow.**
2. Native Windows jobs exercise real ACL privacy/null-DACL/ancestor/reparse rejection, process/file identity, borrowed application lifecycle, history identity and packaged resolver/PE/protocol handshake. They fail if required binary/version configuration is absent. Until these execute, Windows support remains unverified, not simulated-as-qualified.
3. Windows Rust CI deliberately runs `cargo test --locked --package bigbud-remote-agent --test inspect_local`: existing unrelated library `supervisor/core/reliability_tests` do not compile for Windows because `Writer`/`super::writer` are Unix-gated. Focused integration tests compile production code without those unrelated unit modules. Do not claim full Windows Rust workspace tests passed.
4. Local baseline blocker reproduction: `env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -S -c 'print("probe")'` fails with the unaccepted Xcode license. Existing `Coding.files.ts` uses that sanitized environment, so a caller `DEVELOPER_DIR` cannot repair those tests. User/parent must resolve local developer tools configuration/license if desired; this task does not accept licenses or alter global settings.
5. Concurrent terminal layout files appeared during implementation. They are not this task's changes and must be preserved/excluded from this task's publication. A 50-file task allowlist (plus this validation document) and exact logs are in `$VALIDATION`; never stage the entire worktree indiscriminately.
6. Parent independently reviews code/security and AC1–AC7 after checks/native gates pass. Nested code-consistency, format-lint-test-fixer and debugging delegation returned `Subagent depth limit reached (1)`. Direct self-review/testing is not independent approval.

**AC3/AC5 platform proof and AC7 completion gates remain partial.** New authored code files are within 400 lines. No native user service, configuration, credentials or database was touched. Nothing was staged, committed or pushed by this implementer.
