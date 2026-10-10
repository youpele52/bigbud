# OpenCode v2 sandbox stall diagnosis

## Outcome

No sandbox production or test changes are needed for the observed stall. The
unchanged `Execution.sandbox.test.ts` passes all four assertions, including real
kernel containment, overflow rejection, timeout escalation and cancellation that
waits for physical process close. No test was skipped or boundary relaxed.

The historical long wall-clock stall correlates with **host sleep**, not evidence
of an unsupported sandbox or stuck child pipe. Read-only `pmset -g log` reports:

- 9 October, 20:03:15 CEST: clamshell sleep on 2% battery.
- 20:03:54: thermal-emergency dark-wake sleep lasting **530 seconds**.
- The historical test logged migrations at 20:03:57–58, then reported the kernel
  test taking **527,083 ms**. The runner was subsequently terminated without a
  final exception summary; its precise assertion failure cannot be recovered
  from that log.
- An independent continuation passed the sandbox in **36,598 ms**, then another
  test (`105_CommandReceiptRejectionReason.test.ts`) took **454,155 ms** while
  `pmset` recorded **458 seconds** of idle sleep from 00:19:10 on 10 October.
  That run also hit its outer timeout. This reproduces the environment-induced
  suspension outside sandbox code.

## Inspection and narrow verification

Inspected `Execution.sandbox.ts`, `Execution.workspace.ts`, `Coding.files.ts`,
`Execution.sandbox.test.ts` and `Runtime.fixture.ts`. Workspace inspection uses
the existing bounded descriptor helper; contained execution drains both output
pipes, rejects overflow, sends TERM at 30 seconds, escalates to KILL after one
second, and resolves only on child close. Kernel tests really exercise denied
fork/spawn/network and outside/profile/metadata access. No capability-detection
skip, permission expansion, synthetic exit or deadline increase was introduced.

Initial targeted checks: unsupported-platform test passed in 1.44 seconds;
actual-kernel test passed in 2.61 seconds; entire file passed 4/4 in 36.07 seconds.
Final command:

```sh
/usr/bin/caffeinate -i bun run --cwd apps/server vitest run src/provider/Layers/OpencodeV2/Execution.sandbox.test.ts --reporter verbose
```

Final result: **1 file / 4 tests passed**, 36.03 seconds. Individual test times:
2 ms, 31,804 ms, 1,018 ms and 1,570 ms. The sleep assertion exists only for the
command lifetime; no persistent power configuration was changed. It cannot
guarantee protection against lid closure, critical battery or forced sleep.

## Preserved logs and parent checkpoint

Logs are under
`/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/shared-v2-qualification/`:

- `continuation-sleep-evidence.log`: selected timestamped power events.
- `continuation-sandbox-final.log`: final verbose 4/4 result.
- `continuation-workspace-test.log`: sleep-interrupted migration run.
- `continuation-awake-workspace-test.log`: unrelated mobile port assertion
  failure (`dev.coordination.test.ts:90`, expected 55981, received 55982).
  Its focused rerun passed 10/10; recorded in `continuation-mobile-coordination.log`.
- `continuation-serial-workspace-test.log`: interrupted serial checkpoint, eight
  tasks successful, server incomplete after 13m21s. Sandbox passed 4/4 in
  34,896 ms. It also reported an unrelated failure in
  `integration/providerRuntimeIngestion.periodic.integration.test.ts`,
  “flushes only the prompts captured before interruption after periodic repair”.
  No final error summary was produced before interruption; no full green claim.

These full runs preceded the narrowed sandbox-only ownership instruction. No
further full run was started afterward. Parent owns full-suite coordination and
triage of unrelated failures. Use an awake host and sufficient foreground time;
a command-scoped idle-sleep assertion avoids the demonstrated idle suspension
without changing system settings. Installed Turbo docs support
`bun run test --concurrency=1` for serial package execution if needed.

All task-owned runners, sleep assertions and sandbox children have ended (process
inspection after the final focused run). No app launch, installed-service kill,
credential access, vendor prompt, commit or push occurred. No source edits means
no new lint/typecheck gate is claimed here; parent retains the whole-tree gates.
The parent is independently reviewing shared application integration; this
diagnosis does not grant that review clearance.
