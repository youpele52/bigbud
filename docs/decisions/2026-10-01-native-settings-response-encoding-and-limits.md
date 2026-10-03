# Native Settings Response Encoding And Limits

**Date:** 1 October, 2026

**Status:** Implemented; parent independent STATIC approval

## Context / decision

Independent STATIC0012 review found twoP2 blockers: historical/malformed salvaged
model selections escaped as invalidSuccess despite source success encoder failure;
valid140k customModels setting exceeded128KiB WebSocket writebuffer and disconnected.
Authority SQL/reply permits/client influence/dual shutdown reviewed sound, no user
consent gate assumed. Also guard unexpected publisher loss retaining lastCurrent.

Keep historical selection losslessly inside settings persistence/recovery/cache.
At RPC boundary port source OUTPUT encoding, not merely input normalization: current
registered providers/options/types/trim checks; optional encoding defaults omitted,
unknown struct fields stripped; malformed output fails rather than coercing it.
Use actual locked Rpc.exitSchema/toCodecJson encodeUnknownExit for differential
cases including recovery salvage and unknown/malformed option values.

Encoding/unavailable failure emits existing sanitized request-scopedDie string
`Native settings snapshot unavailable`, not source SchemaIssue content which can
disclose settings/model/path data. This deliberate failure-text deviation retains
Failure/Die shape and request identity; not exact source diagnostic parity.

Keep input/file/writebuffer bounds, add explicit64KiB serialized outbound response
limit INCLUDING envelope/JSON escapes/requestId. An oversized response returns
request-scopedDie `Native response exceeds preview byte limit` before socket.send,
not accidental WriteBufferFull disconnect. Socket remains usable forPing/corrected
file reads. This preview bound is deliberate divergence from unbounded source
response size, not widening approved resource or filesystem authority.

Observe watch publisher closure before servingCurrent; closed sender means
unavailable even if last recorded statusCurrent. Test publisher loss directly.
No broader worker-panic/restart/platform certificate.

## Validation / consequences

Parent independent STATIC review APPROVED: BOTH P2 CLOSED, publisher-loss addressed,
no new defects. NOT execution rerun98tests/21oracles. Continuation is separately
documented in [next decision](2026-10-01-native-command-receipt-repository-and-consent-prerequisites.md).

Both P2 regressions fail before correction, including release-process socket tests.
Source response-encoder differential fixtures, output-byte/Unicode/envelope tests,
publisher-loss test, same-socket large/error/recovery oracle and ordered checks/
source oracles precede targeted independent review. Latest instruction fixes these
first; durable-consent/deeper roadmap resumes after approval. No new dependencies,
mutationRPC/history/import/security enabling or git publication; synthetic-only.
