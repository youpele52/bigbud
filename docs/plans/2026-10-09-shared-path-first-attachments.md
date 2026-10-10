# Shared path-first attachments

Status: **Ready for implementation**. Latest user authorization: all providers,
including OpenCode v2, with document/OCR supplemental context. This supersedes
the earlier V2 text-only attachment exclusion, not SDK/security/replay limits.

## Requirements and implementation

- Restore file/image/paste/drop/path-reference composer actions. Remove the
  permanent unavailable paragraph; action failures use warning/error toasts.
- Remove provider warnings/errors from the model-list area; retain the existing
  top provider status, retry controls, full catalog grouping/search/recent models.
- Reuse one bounded document/OCR preparation layer across every provider.
  Prefer paths to immutable managed snapshots when runtime tools can read them;
  retain supplemental text and native visual media. Never trust an arbitrary
  `sourcePath` as permission to reread a host file. Browser/clipboard inputs have
  byte fallback because they have no genuine filesystem path.
- V2 prepares target-bound supported content before model mutation/admission.
  Persist immutable preparation material for replay: no source reread, OCR rerun,
  automatic resend, trust-policy relaxation, or historical text fingerprint change.
- Preserve canonical thread expansion and directory references. Reject invalid
  metadata, unsupported required visual fallback, unreadable bytes, and bounds
  before admitting a prompt. Explain extraction limitations truthfully.
- Keep exact 2.0.26 pin, app/event bounds and owned-profile authorization. No
  10 MiB stress probe, helper installs, real-provider calls, profile changes,
  unrelated cleanup, publication, or expanded release/platform/deletion gates.

## Validation

Focused shared extraction/target tests; existing provider fixture seams;
normalizer snapshot/transport tests; V2 admission/replay and native disposable
small-fixture tests; Chromium model-list/composer action tests. Run `bun fmt`,
`bun lint`, `bun typecheck`, then relevant Vitest tests and an accepted serial
full-workspace checkpoint. Record unrelated failures without editing them.

Use dot-notation concern splits; every materially edited code file stays at or
below 400 lines. Preserve all inherited worktree changes.
