# Native Linux validation handoff

**Date:** 16 November 2026
**Status:** R6/R7 isolated ARM64 runtime cases pass; production managed-unit activation remains open.

This handoff lets a successor continue from the frozen Linux native validation without rebuilding or mutating existing VM accounts. It is a bounded native test result, not release-toolchain certification or production readiness.

## Exact result

Evidence directory: `/tmp/bigbud-p7-native-vm-r67-20261116/`.

- R6: `run-r6.json`, exit 0; 7 cases, 31 Rust tests passed. This includes lease (6), guard (2), protocol golden (1), lease unit (20), detached asset custody (1), executable pin (1), and native `--check`.
- R7: `run-r7.json`, exit 0; 8 cases, 34 Rust tests passed. It adds 3 managed-proxy real-socket/refusal tests.
- `SUMMARY.json` records artifact hashes, sizes, source supplement, test counts, and qualification limits. `collect.json` and `evidence.json` contain the collected run details.
- Both transient systemd units ended with `LoadState=not-found`; owned cgroups are absent. Existing accounts and unit configurations were not changed.
- The tests ran in the existing isolated Linux VM with `ProtectHome` and private networking. Build used the installed Rust 1.95 source/toolchain and offline cached dependencies with custom `build-std`; no compiler was installed.

## Reproduce or extend

**Runner availability:** the original runner has been recovered at `/tmp/bigbud-p7-native-vm-r67-20261116/vm.py` in the current environment. It was missing in an intervening session, so this `/tmp` path is not durable and the script is not checked into the repository. The exact runner logic is described below; preserve a repository copy before relying on it across environment resets. Do not execute an ARM64 ELF directly on macOS.

Frozen input locations at the time of the run were `/tmp/bigbud-p7-native-gateway-lease-20261116/guard-r6/` and `managed-proxy-r7/`. R6 source manifest SHA256: `3935d41590c939863856fd32144896e71d4fbf6bdceffc8a16487ad8cea68c88`. R7 source manifest SHA256: `8ab862264eb3795de0eba7be1b182e0ecc920a86fed369dc2582d63699e74791`. R7 main ELF SHA256: `2d9f7d58d96b86bb028699f130a660a8b3a4f667fddb1f4b1cade7daf23f9104` (4,636,712 bytes).

The runner has four modes: `probe` records the VM identity; `install` verifies and stages the already-built R6/R7 binaries; `run r6` and `run r7` execute each revision in a fresh transient protected/private-network systemd unit; and `collect` records results and confirms unit/cgroup cleanup. The normal invocation is `python3 /tmp/bigbud-p7-native-vm-r67-20261116/vm.py probe`, then `install`, `run r6`, `run r7`, and `collect`. It talks to the existing VM `bb-p7-service-20261116-root1` using OrbStack and stages only in `/tmp/bb-p7-native-r67-20261116-lead1`.

To rebuild rather than reuse the recorded binaries, extract each frozen `cargo-source.tar` into a separate fresh source directory, verify it against `source62.json` or `source66.json`, and build with the installed Rust 1.95 sources/toolchain, locked offline Cargo inputs, Linux ARM64 target, and fresh target directory. Build the native main, `bigbud-remote-agent` integration tests `service_lease` and `service_lease_guard`, protocol integration test `service_lease`, and agent library test binary. Run the lease-unit test binary and exact ignored assets test `service_lease::assets::tests::native_original_child_exits_after_assets_modify_while_controller_is_detached` with `BIGBUD_SERVICE_LEASE_TEST_BINARY` pointing to the same-build native main. R7 additionally runs the three `backend_service::lease_proxy::tests` real-socket/refusal cases. Run native `--check`, collect exit status and logs, and verify transient units/cgroups are gone. Merely cross-compiling is not equivalent runtime evidence.

The R6 build needed two public TypeScript files referenced by `include_str!`: `apps/server/src/terminal/Layers/ShellProfiles.candidates.ts` and `ShellProfiles.remote.protocol.ts`. Their hashes and public-archive provenance are recorded in `SUMMARY.json` from the original run. Any recreated test supplement must verify those exact hashes before use. The original missing-input build failure and stopped direct Orb probe are retained as failed attempts, not product failures.

The exact original `vm.py`, build-driver invocation, dependency cache, and emitted test input tar are not checked in. Until those are restored or a replacement runner is independently reviewed, do not present a rerun as identical to the recorded run. The original result remains supported by `run-r6.json`, `run-r7.json`, and `SUMMARY.json` when those evidence files are available.

## Continue from here

The next native qualification is a positive managed-service test on a **new immutable graph and fresh account**. The current VM accounts/configurations and signed graphs are pinned evidence and must not be edited or reused for this. Exercise the real finite owner/SQL context and `acquireManagedNativeLeaseChannel`; controlled injected channels do not qualify the managed path.

Mobile preparation and private signer integration have bounded source review and configured server type evidence (latest server union: 278 paths, 5,557 configured program inputs, actual exit 0). A readiness parser draft is separately tested but remains off-checkout. Production mobile activation still needs native original-child bind/readiness attestation, owner/listener integration, socket recovery/attach proof, and actual managed activation. No ready state is established by the R6/R7 tests.

The two-account callback concurrency proof passed authentication and RPC checks without restart retries. Intentional stop currently yields process exit 130 and systemd `Result=exit-code`; this shutdown-status issue remains open. Preserve that evidence; do not use `reset-failed` to make it appear clean.

## Guardrails

- Keep frozen R6/R7 manifests and artifacts immutable; create a new revision for source changes.
- Use a new account and graph for positive managed activation. Never hand-edit existing signed configs or registry state.
- No provider turns, public listener exposure, release signing, or deployment occurred in these runs.
- Report any future run by exact source manifest, binary hashes, test counts, exit status, and cleanup state.
