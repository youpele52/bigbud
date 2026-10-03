# Temporary private lifecycle input boundary and decision foundation

Date: 2 October 2026. Parent-authorized temporary restriction, not full parity.

Latest CLI settings-preview review APPROVED STATIC; default-readonly maintained.
Reviewer did not rerun165 tests/nineoracles. Projection/replay otherwise approved
for trusted checkpoint shells, not authoritative product checkpoint admission.

The lifecycle P2 is real: verbatim JSON `threadId:"\ud800"` is accepted by source
JSON.parse/schema/digest, and unknown `1e400` is stripped after source parses it
as Infinity. Prior stringify-based fixtures concealed this raw-wire domain gap.
Eight new verbatim source wire cases retain exact bytes, UTF16 code units and
source canonical/digest output; Rust explicitly rejects unsupported inputs.

Research of pinned serde_json1.0.151 and current docs confirms deserialize_bytes
can preserve lone surrogates as WTF8; String/Value reject them. IgnoredAny skips
unknown overflowing numbers, Value does not. Tests demonstrate both capabilities.
These do not provide an already-reviewed end-to-end source UTF16 string/trim/
canonical JSON serializer/digest representation in this app. No assertion is
made that a new dependency is necessarily required: an approved schema-aware
decoder or reviewed source-semantic representation remains future work. Existing
dependency features were not changed and no hand JSON parser was added.

Parent explicitly accepts temporary failclosed Unicode-scalar/finite-JSON Value
input restrictions in the PRIVATE prerequisite only, including ignored unknown
values. No replacement characters, lossy normalization or approximate hashing.
This scopes the P2 honestly; full six-command raw-wire parity remains incomplete
and on the fidelity backlog. It is not permission for runtime command activation.

Substantive next slice implements private pin/unpin/archive/unarchive decisions
and source thread/project read selectors. Exact source invariant ordering, limit5,
no-op behavior, errors, event identity/correlation and timestamps are tested against
256 actual source decider cases. Trusted owner stamp uses existing UTC helper and
approved CSPRNG UUIDv4, never caller time/fallback. Synthetic canonical worker
decision/append/replay works; this is not an atomic executor or a result receipt.

Latest scopedfmt/clippy/170tests/release/sixoraclesPASS. New independent review
depth-blocked; no default/RPC/provider/deletion/cleanup activation. Workspacefmt
PASS, wider native clippy/tests/release unverified after priorashSIGKILL. Only
explicitly approved generated test prefixes were cleaned after confirmed kernel
OOM; original/live profiles, research/logs, concurrentdesktop preserved.

Migration links: `docs/rust-port/0025-lifecycle-decisions-and-wire-boundary.md`,
`docs/plans/2026-10-02-lifecycle-decisions-validation.md`,
`docs/reports/2026-10-02-lifecycle-decisions-handoff.md`.
No stage/commit/push/publication or newdependency.
