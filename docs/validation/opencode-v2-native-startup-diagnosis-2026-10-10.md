# Disposable native shared-service startup diagnosis

## Reported failure and limits

Parent observed both 2.0.26 native tests fail their 15-second registration poll,
then an official-copy rerun end at the 180-second outer deadline without Vitest's
`RUN` header. Parent verified both binaries' version and matching SHA-256. No
sleep occurred in that interval. These failures are **not attributed to sleep**.

The old `SharedService.native.fixture.ts` discarded both process output streams
and reduced every registration-read error to `false`. Consequently the original
native startup failure has no retained child diagnostic identifying its cause.
The pre-`RUN` stall occurred before fixture execution could be established; a
native registration failure must not be claimed to explain that separate stall.

## Bounded experiments

At 01:20 CEST, a directly spawned installed 2.0.26 binary in a fresh disposable
HOME/XDG/DB registered in **1.01 seconds**. Registration PID matched the owned
child, version was 2.0.26, and file mode was 0600. Output was only a loopback
listener announcement. The child was terminated and the disposable profile
removed; the installed native service was never contacted or killed.

Before any fixture change, the actual installed 2.0.26 transport test passed in
**2.58 seconds** (one test). The failures are not currently reproducible; no
underlying native-startup or runner fix is claimed.

## Change and verification

Only `apps/server/src/provider/Layers/OpencodeV2/SharedService.native.fixture.ts`
was changed. It now retains at most 8 KiB of disposable child startup output,
records spawn/exit/signal state and the last sanitized registration error, and
includes diagnostics in startup failures. Credential-related output lines and
URL userinfo are filtered. Registration contents and environment are never
printed. Signal termination is also recognized as process failure. The original
15-second deadline, actual registration validation, synthetic provider,
containment and cleanup remain intact. No production integration changes.

Commands used the existing two test files:

```sh
BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY=<binary> \
BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION=<version> \
bun run --cwd apps/server vitest run \
  src/provider/Layers/OpencodeV2/SharedService.application.native.test.ts \
  src/provider/Layers/OpencodeV2/SharedService.native.test.ts --reporter verbose
```

| Binary                                                                             | Result after diagnostic change                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/Users/youpele/.bigbud/tools/opencode-v2/2.0.26/opencode`                         | 2 files / 2 tests passed, 8.22 seconds                                  |
| Official temporary `v2-2.0.26-qualification/cli-darwin-arm64/package/bin/opencode` | 2 files / 2 tests passed, 7.91 seconds (command-scoped `caffeinate -i`) |
| `/Users/youpele/.opencode/bin/opencode` (2.0.24)                                   | 2 files / 2 tests passed, 7.81 seconds                                  |

A deliberate `/usr/bin/false` negative control failed in 15.55 seconds and
reported `exitCode: 1`, no signal, missing registration, and empty output. This
is expected diagnostic evidence, not a native qualification failure. The wrapper
asserted the expected nonzero status and diagnostic exit code.

Logs reside in
`/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/shared-v2-qualification/`:
`diagnosis-native26-before.log`, `diagnosis-native26-after.log`,
`diagnosis-native26-official-after.log`, `diagnosis-native24-after.log`, and
`diagnosis-fixture-negative.log`.

Scoped formatting passed. Whole-tree lint/typecheck and full-suite runs are
deferred to the coordinating parent, as explicitly requested to avoid overlap.
No app launch, vendor prompt, installed-daemon mutation, credential copy, system
settings change, commit or push. All diagnostic commands completed; task-owned
native children and synthetic listeners were closed. The historical failure's
exact cause remains unknown, but current actual-version qualification is green
and a recurrence will no longer discard its startup evidence.
