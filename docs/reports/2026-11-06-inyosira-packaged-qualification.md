# Inyosira packaged qualification — 6 November

## Decision

**Partial qualification passed; cross-platform release/cutover qualification remains incomplete.** No organiser defect was found in the executed checks. The macOS ARM64 packaged backend and Linux x64 server runtime passed real startup, engagement and native deadline acceptance. Windows execution, Intel macOS execution, full Linux desktop packaging and the complete standalone artifact-set gate remain open.

This adds runtime evidence to [Fable's code acceptance](2026-11-06-inyosira-fable-final-review.md). It does not replace native installer, signing, release workflow or large-userdata qualification.

## Exact scope

Host: Apple Silicon macOS, Node 25.2.1, Bun 1.3.14. Docker provides Linux execution; x64 Linux ran under emulation on this ARM64 host. No Windows kernel/runner was available. `arch -x86_64 /usr/bin/uname -m` failed with `Bad CPU type in executable`, so Rosetta/Intel execution was unavailable.

Builds used the dirty checkout, not a published version or remote CI ref. HEAD at evidence capture was `70cc1ebb7642bcb6e796503a299287f2dbcf96d8`; the remaining uncommitted migration and unrelated shared work were preserved. Fable finished F1/F2 while qualification was underway. The initial app was therefore superseded by a fresh web/server rebuild and a **final** macOS package after Fable relinquished ownership; only final-package results establish final-source qualification.

Artifacts, commands' stdout/stderr and temporary harnesses are retained under:

`/tmp/inyosira-packaged-qualification.2XHqVl`

The final app is `mac-arm64-final/mac-arm64/bigbud.app`. It is an unsigned unpacked app bundle (`--target dir`), never installed over `/Applications/bigbud.app`. Its backend was run with that app's own Electron executable in Node mode, using the packaged server resources and packaged supervisor path supplied by the desktop configuration. The GUI main process, installer, Gatekeeper and notarization were not exercised.

Linux used the common final packaged server resources from that app and a freshly built Linux x64 supervisor in Docker. This proves the organiser's Linux server runtime; it is **not** a Linux Electron/AppImage/deb artifact qualification. Native OS resource monitoring, terminal/native addon coverage, provider sessions and display behavior are outside these organiser checks.

All runtime profiles and synthetic threads lived beneath the temporary qualification root. No installed-app userdata or real 16 GB database was read or modified. No provider turns were started: the deadline fixtures asserted zero `provider_session_runtime` and `projection_turns` rows.

## Matrix

| Target / boundary                                    | Result                    | Evidence / remaining limit                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS ARM64 unsigned app build                       | PASS                      | Fresh final web/server/desktop bundles and app resource staging; `mac-package-final.log`                                                                                                                                    |
| macOS packaged workspace + organiser                 | PASS                      | Both packaged verifiers exit 0; organiser activation/proposal and workspace handshake/cleanup; `mac-workspace-final.log`, `mac-supervisor-final.log`                                                                        |
| macOS packaged Electron Node backend                 | PASS                      | HTTP and real status RPC healthy, exactly one native organiser child using the packaged path, bounded shutdown; `desktop-electron-startup.log`                                                                              |
| macOS standalone host build/discovery                | PASS                      | Server build exit 0; no binary override, actual child comes from `dist/organization-supervisor/darwin-arm64`; `standalone-build-final.log`, `standalone-startup-final.log`                                                  |
| macOS real two-client engagement                     | PASS                      | Independent leases; disconnect A leaves B protected, reconnect C cannot release B, B release republishes facts; `desktop-deadline.log`                                                                                      |
| macOS full two-minute native snooze                  | PASS                      | Persisted Later until the chosen deadline; Rust proposal accepted canonically once to Needs you, revision 2, zero pending operations; `desktop-deadline.log`                                                                |
| Linux x64 release sidecars                           | PASS, emulated            | Locked release builds, 45 organiser unit + 3 fixture + 2 process tests pass; `linux-x64-build.log`                                                                                                                          |
| Linux x64 binary smoke                               | PASS, emulated            | Organiser activation/proposal/shutdown plus workspace handshake/cleanup; `linux-x64-smoke.log`                                                                                                                              |
| Linux x64 packaged server resources                  | PASS, emulated            | Real HTTP/status healthy with Linux supervisor; `linux-server-startup.log`                                                                                                                                                  |
| Linux real two-client engagement and native deadline | PASS, emulated            | Same lease/disconnect/reconnect and two-minute canonical move checks; revision 2, zero pending operations/sessions/turns; `linux-deadline.log`                                                                              |
| Windows x64 supervisor                               | COMPILE ONLY              | `cargo check` exit 0; `windows-x64-cross-check.log`; no Windows execution                                                                                                                                                   |
| Windows ARM64 supervisor                             | COMPILE ONLY              | `cargo check` exit 0 after installing its Rust target; `windows-arm64-cross-check.log`; no Windows execution                                                                                                                |
| macOS x64                                            | BLOCKED                   | No Rosetta/Intel runtime on this host; requires an Intel runner or an approved Rosetta setup                                                                                                                                |
| Windows packaged x64 / ARM64                         | BLOCKED                   | Requires Windows runners, actual target artifacts and packaged protocol/runtime smoke; compile checks are insufficient                                                                                                      |
| Linux Electron/AppImage/deb                          | NOT RUN                   | Requires full Linux artifact build and desktop/installer execution; server-resource tests above do not cover that boundary                                                                                                  |
| Standalone all-platform prepack gate                 | FAILED: missing artifacts | `verifyWorkspaceAgentPackage.ts` exit 1 at missing `dist/workspace-agent/darwin-x64/bigbud-remote-agent`; this host build supplies only its own platform. `release-assets/` was absent; no foreign binaries were fabricated |
| Release workflow / signing                           | NOT RUN                   | Requires an eligible committed CI ref and native runner matrix; no commit, push, signing/notarization or publication was performed                                                                                          |
| Real large userdata                                  | NOT RUN                   | The prior synthetic scale tests remain the evidence; this request did not authorize live userdata experiments                                                                                                               |

## Commands and results

All builds/checks were focused on the affected artifacts or native crate. No repository/workspace-wide validation was run.

- `bun run --cwd apps/web build` and `bun run --cwd apps/desktop build`: exit 0. Web/server builds were repeated after F1/F2. Logs `web-build-final.log`, `desktop-build.log`.
- `node apps/server/scripts/cli.ts build --verbose`: exit 0; stages and smoke-tests the host supervisor. `standalone-build-final.log`. The build warned that the existing mobile web dist was not a desktop build and skipped it; the mobile companion is not qualified here.
- `node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 --skip-build --output-dir <root>/mac-arm64-final --verbose`: exit 0. `--skip-build` used the freshly rebuilt bundles and release sidecars, not old installed assets.
- `node scripts/verify-packaged-workspace-agent.ts <root>/mac-arm64-final mac arm64`: exit 0. This includes the organiser protocol smoke.
- `bun run scripts/verify-packaged-desktop-supervisor.ts <root>/mac-arm64-final mac`: exit 0. Manifest/SBOM/digest and supervisor recovery/system-monitor smoke.
- `node apps/server/scripts/verifyWorkspaceAgentPackage.ts`: exit 1, missing foreign-platform artifact as listed above. This is not a passed prepack check.
- Linux: Docker `rust:1.95-bookworm`, `--platform linux/amd64`, repository mounted read-only and copied into `/work`; `cargo build --locked --release -p bigbud-desktop-supervisor -p bigbud-remote-agent`, `cargo test --locked -p bigbud-desktop-supervisor organization::`, and the two explicit fixture/process targets: exit 0. Only the copied source and temporary container build outputs were written.
- Docker `node:22-bookworm`, `--platform linux/amd64`: organiser smoke plus workspace handshake/cleanup, exit 0. Actual ELF x86-64 artifacts were used. Shared source imports were read-only.
- `cargo check --locked --package bigbud-desktop-supervisor --target x86_64-pc-windows-msvc` and the ARM64 equivalent: exit 0. These are compile checks, not linked executable or runtime qualification.
- Retained temporary `server-smoke.mjs`, `two-socket-smoke.mjs`, and `deadline-smoke.mjs` run HTTP, raw Effect RPC over real WebSockets, and a synthetic canonical project/thread. The deadline harness observes committed SQLite facts read-only and asserts exactly one revision increment on expiry, no prepared operation, and no provider sessions/turns. Final macOS and Linux invocations exit 0.
- An initial temporary startup harness waited indefinitely through native `fetch`; it was stopped and classified inconclusive. The corrected harness uses bounded core-HTTP requests and bounded WebSocket opening/RPC. No product source was changed for that harness correction.
- All qualification server/native children and named Docker containers stopped. Final owned-process and container inspection found none remaining.

Artifact SHA-256 values (`artifact-digests.json`):

| Artifact                              | SHA-256                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| Final packaged macOS ARM64 supervisor | `ad9e35af750aa8e752a9cfb5232bbc0e6527570d66e8d6a2a29be9d6b2412313` |
| Linux x64 release supervisor          | `319f8659c66963f4cee049fd180a9e7f7ac326e25a540836bc739129e79f8b10` |
| Final packaged server bundle          | `7be6b18e79d199d5dd25c57c07620329a6ea009989f35771e7bb68e93169ac6c` |

## Before cross-platform cutover

1. Run the actual packaged organiser smoke and isolated startup/deadline checks on Windows x64 and ARM64 and macOS x64. The configured native release matrix is the appropriate execution boundary; local cross-checks do not substitute for it.
2. Build and exercise the Linux desktop artifact on its supported native runner, including the existing packaged verifiers/installer smoke. The emulated headless Linux results remain useful bounded evidence.
3. Assemble all five workspace-agent and organisation-supervisor target pairs into the standalone package, then pass the complete prepack gate on the assembled distribution.
4. Execute the release workflow and signing/notarization gates through the normal approved release path. This dirty local checkout was not published or silently substituted for a CI ref.

No new organiser failure blocks the qualified macOS ARM64/backend or emulated Linux server paths. A blanket cross-platform packaged-cutover or release-readiness claim is still blocked by the missing execution/artifact evidence above. Code acceptance remains as recorded by Fable.

## Final F1/F2 regression rerun — 6 November, 10:33–10:35 UTC

**PASS: all 52 organiser server files, 171 tests; no failures or skipped tests.** The two new F1 retention/pruner files were run separately: **3 additional tests pass**, bringing this scoped run to **174 tests across 54 files**. This supersedes the earlier statement that the consolidated manifest had not been rerun after F1/F2.

Fable had already started the user-authorized rerun when the integration owner received the same request. The owner confirmed the live runner, monitored that run instead of starting overlapping server tests, and independently verified every batch log, the captured command exit codes and source hashes. All nine F1/F2 files match the final handoff SHA-256 prefixes; source/test fingerprints remained unchanged through the run. The tests therefore cover the final retention and shared-limit sources, not the earlier scratch build.

The command was `bun run vitest run --project integration <explicit src/... paths>` from `apps/server`, using the 52 unique existing paths in `/tmp/rr-integ-rel.txt`, prefixed with `src/`. Five batches ran sequentially, followed by the two explicit new files:

- `src/persistence/Layers/ThreadOrganizationOperations.retention.test.ts`
- `src/thread-organization/organizationBridge.loops.pruner.test.ts`

| Batch        | Manifest rows                | Files | Passed tests | Exit code | Log                                   |
| ------------ | ---------------------------- | ----- | ------------ | --------- | ------------------------------------- |
| 1            | 1–11                         | 11    | 42           | 0         | `/tmp/fable-suite52-batch1.log`       |
| 2            | 12–22                        | 11    | 38           | 0         | `/tmp/fable-suite52-batch2.log`       |
| 3            | 23–33                        | 11    | 21           | 0         | `/tmp/fable-suite52-batch3.log`       |
| 4            | 34–44                        | 11    | 50           | 0         | `/tmp/fable-suite52-batch4.log`       |
| 5            | 45–52                        | 8     | 20           | 0         | `/tmp/fable-suite52-batch5.log`       |
| F1 additions | Outside the 52-file manifest | 2     | 3            | 0         | `/tmp/fable-suite52-batch6-extra.log` |

The background runner's overall exit code was also 0. Real-binary tests were not skipped. No Vitest runner remained after completion. Copies of the manifest, six logs, source fingerprints and machine-readable counts/exit codes are retained under `/tmp/inyosira-packaged-qualification.2XHqVl/regression-f1f2/`.

This closes the final-source consolidated server regression gap. It does **not** change the packaged platform, installer, signing/workflow or complete standalone artifact-set blockers above. Only this report was edited; no product source, staging, commit or push was performed by the integration owner for this request.
