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

The authorized runner is `/tmp/bigbud-p7-native-vm-r67-20261116/vm.py`. Run it with the approved command prefix `python3 /tmp/bigbud-p7-native-vm-r67-20261116/vm.py`. It builds and runs the frozen R6/R7 cases and writes the JSON receipts above. Inspect the runner and frozen manifests before changing its arguments. Do not use a direct host invocation of an ARM64 ELF; it must run in Linux.

Frozen inputs are under `/tmp/bigbud-p7-native-gateway-lease-20261116/guard-r6/` and `managed-proxy-r7/`. R6 source manifest SHA256 is `3935d41590c939863856fd32144896e71d4fbf6bdceffc8a16487ad8cea68c88`; R7 source manifest SHA256 is `8ab862264eb3795de0eba7be1b182e0ecc920a86fed369dc2582d63699e74791`. R7 main ELF SHA256 is `2d9f7d58d96b86bb028699f130a660a8b3a4f667fddb1f4b1cade7daf23f9104` (4,636,712 bytes).

The R6 test build needed two public TypeScript files referenced by `include_str!`; the runner records them as a separate supplement copied from the accepted Node10 public archive and confirms they match the live source. The original missing-input build failure and the stopped direct Orb probe are retained as failed attempts, not product failures.

## Continue from here

The next native qualification is a positive managed-service test on a **new immutable graph and fresh account**. The current VM accounts/configurations and signed graphs are pinned evidence and must not be edited or reused for this. Exercise the real finite owner/SQL context and `acquireManagedNativeLeaseChannel`; controlled injected channels do not qualify the managed path.

Mobile preparation and private signer integration have bounded source review and configured server type evidence (latest server union: 278 paths, 5,557 configured program inputs, actual exit 0). A readiness parser draft is separately tested but remains off-checkout. Production mobile activation still needs native original-child bind/readiness attestation, owner/listener integration, socket recovery/attach proof, and actual managed activation. No ready state is established by the R6/R7 tests.

The two-account callback concurrency proof passed authentication and RPC checks without restart retries. Intentional stop currently yields process exit 130 and systemd `Result=exit-code`; this shutdown-status issue remains open. Preserve that evidence; do not use `reset-failed` to make it appear clean.

## Guardrails

- Keep frozen R6/R7 manifests and artifacts immutable; create a new revision for source changes.
- Use a new account and graph for positive managed activation. Never hand-edit existing signed configs or registry state.
- No provider turns, public listener exposure, release signing, or deployment occurred in these runs.
- Report any future run by exact source manifest, binary hashes, test counts, exit status, and cleanup state.
