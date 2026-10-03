# Native authenticated settings update RPC candidate

Superseding parent decision: both narrow reviewers approved STATIC, no rerun159/14.
Scoped deviations accepted and freeze lifted; usable explicit preview CLI enabled
without changing readonly defaults. See `2026-10-02-native-settings-preview-activation.md`.
Earlier pending/no-CLI statements below are historical.

Date: 2 October 2026. Status: implemented opt-in candidate, activation review pending.

Both 0022 code/security verdicts are APPROVED STATIC, not reruns of 152 tests/10
oracles; approval covers fresh read-only custody/P2 corrections, not mutation.

The separate migration now implements actual server.updateSettings decoding,
authenticated owner admission, persistence and source success/typed-error exits.
Private exact-runtime Server opt-in only; default CLI remains read-only. Executed
source 1,311 payload cases/seven live service-handler-disk traces and real native
sockets support null/unknown/trim/merge, canonical errors, limits and readback.

Successful bounded try_send under session then runtime admission locks linearizes
against revoke/close. Serialization outside locks; accepted work survives Close,
Interrupt and response loss. Actual candidate output+ID size/version preflight
before staging; uncertain publication poisons/stales, no automatic retry.

Explicit activation-review deviations: raw retention keys including Never receive
the source SERVICE dedicated-retention error although the source RPC codec strips
the unknown key; optional JS/Effect AST error cause is not fabricated/emitted,
while typed tag/path/detail are preserved. Full cause parity is not claimed.
No source settings configstream/readiness, consent grants, new SQL table/dependency,
original/live profile writes or publication. Full Rust/GPUI migration remains open.

Scoped ordered fmt/clippy/159 tests/release/14 affected oracles pass; current
full-workspace fmt blocked in other-agent desktop sidebar, downstream not reached.
New security/requirements reviews depth-blocked: parent review required before
activation. Migration records: `docs/rust-port/0023-authenticated-settings-update-rpc.md`,
`docs/plans/2026-10-02-settings-update-rpc-validation.md`,
`docs/reports/2026-10-02-settings-update-rpc-handoff.md`.
