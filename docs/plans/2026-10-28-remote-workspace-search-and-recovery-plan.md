# Remote workspace file search and transient-error recovery

Status: reopened after live failure. Local implementation and focused macOS checks passed, but the VPS is running an older Linux agent that does not contain the search fix. Deployment and live verification remain outstanding.

## Goals

- Make Mod+P file search behave consistently in local, direct-SSH, and managed-agent workspaces.
- Avoid flashing large technical errors during temporary remote directory-listing failures.
- Preserve existing workspace isolation, path security, previews, and local behavior.

## Evidence and limits

Read-only investigation identified three search defects: agent traversal aborts on encountered symlinks; agent matching is case-sensitive and basename-only despite the palette lowercasing queries; remote worktree searches discard their execution target. These are code-path findings, not a reproduction of the user's particular VPS failure.

The subsequent screenshot shows a remote directory-listing command failing with SSH exit code 255 and session/channel errors. The user reports that this failure often resolves quickly. Exit code 255 alone is not sufficient to classify every SSH failure as transient. This file-tree recovery issue is separate from, but included alongside, the Mod+P fixes.

The current directory loader immediately stores the raw error. The tree renders that error in place of nested entries, even when entries were previously loaded. Recovery must include real retry/reconnect behavior, not merely hide the error for 30 seconds.

## 1. Preserve workspace identity throughout Mod+P

- Replace the palette-specific directory/target resolver with the existing shared workspace resolution, verifying active threads, drafts, and remote worktrees.
- Keep execution target and workspace root paired in requests, cache keys, and result opening.
- Ensure a remote path never silently falls back to the local filesystem.

Relevant code:

- [Palette workspace resolution](../../apps/web/src/components/layout/CommandPalette.content.tsx)
- [Shared workspace resolver](../../apps/web/src/hooks/useResolvedWorkspace.ts)
- [File results and opening](../../apps/web/src/components/layout/CommandPalette.workspaceFiles.tsx)

## 2. Align remote-agent filename search with existing search behavior

- Skip symlinks encountered while traversing search candidates without following them. Keep strict validation for explicitly requested unsafe paths.
- Match the existing local/direct-SSH case-insensitive full-path and fuzzy-search behavior, including ranking before applying result limits.
- Reuse existing search semantics where practical; do not introduce palette-side filtering that cannot recover omitted remote candidates.
- Preserve bounded traversal, cancellation, and result limits.

Relevant code:

- [Agent filename search](../../crates/bigbud-remote-agent/src/workspace/search.rs)
- [Existing entry-search matching](../../apps/server/src/workspace/Layers/WorkspaceEntriesSearch.ts)

## 3. Add a 30-second remote recovery window

### User-facing behavior

- For retryable remote directory-listing/connection failures, show only the centered bigbud logo instead of immediately showing the raw red SSH error. Keep the recovery status screen-reader-only; center the logo in the empty files panel, or within the compact loading area when cached content is present.
- Use a 30-second recovery window, starting with the first transient failure in one recovery episode. Repeated failures must not reset that deadline indefinitely.
- Recover immediately when a retry succeeds: the logo is not a forced 30-second minimum loading delay.
- Keep previously loaded folders/files visible while reconnecting, preserving expansion, selection, scroll position, and file preview. For an unloaded directory, show a compact loader in the affected tree area.
- If recovery has not succeeded after 30 seconds, show a concise error with Retry and expandable technical details, rather than the complete SSH command and stderr inline.
- If a request is still outstanding at the deadline, transition to the error/retry state without allowing duplicate in-flight work; ignore stale completions after a newer request or workspace change.
- Authentication, host-key/trust, permission, and confirmed missing-path failures must retain their actionable handling; do not blindly retry or conceal them as temporary connectivity issues.
- Apply the same state policy to Mod+P remote search failures where appropriate, while keeping successful empty search results distinct from connection failures.
- Keep local workspace behavior unchanged. Respect reduced-motion preferences and expose the loading status accessibly.

### Recovery implementation

- Introduce focused shared recovery state/policy rather than independent timers in individual tree rows and palette results.
- Inspect existing connection/reconnect infrastructure before adding retries; coordinate with it instead of starting competing reconnect loops.
- Classify failures using structured transport information where available; do not treat every SSH exit-255 response as retryable or infer the cause from unrelated stderr warnings.
- Use bounded backoff, deduplicate concurrent work, and limit recovery requests during outages, especially with several expanded folders.
- Cancel timers and invalidate stale requests on workspace/target changes, unmount, or superseding requests, preserving current generation/request-ID guards.
- Retain diagnostic details for troubleshooting without exposing command/environment secrets in the default UI.
- Keep policy/constants in focused modules following repository conventions; preserve the 400-line source/test limit.

Relevant code:

- [Directory loader](../../apps/web/src/components/files/useFilesPanelDirectoryLoader.ts)
- [Nested tree rendering](../../apps/web/src/components/files/FilesPanel.tree.tsx)
- [Directory error classification](../../apps/web/src/components/files/FilesPanel.errors.ts)
- [Existing logo loader](../../apps/web/src/components/layout/BigbudLoader.tsx)

## 4. Focused verification

- Search regressions: uppercase names, path queries, fuzzy queries, ranking/limits, encountered symlinks, and explicitly unsafe paths.
- Routing regressions: local, direct-SSH, managed-agent, remote worktree, draft context, workspace switching, and target-preserving result opening.
- Fake-timer recovery tests: transient failure followed by success before 30 seconds; repeated failures crossing the original deadline; a hung request; successful recovery after an error; manual Retry.
- Assert there is no raw error before the transient recovery deadline, recovery does not wait for 30 seconds after success, and permanent/action-required errors are not masked.
- Verify cached entries and preview remain visible during recovery, and an unloaded expanded directory uses the compact logo/status.
- Verify retries are bounded/deduplicated, multiple expanded folders do not cause a request storm, and old workspace timers/responses cannot update a new workspace.
- Browser checks for loading, genuine no-results, error/details/retry states, accessibility, and reduced motion.
- Run only focused formatting, lint, type checks, and relevant tests for implementation changes. Obtain approval before any full-suite or repository/workspace-wide checks.

## Completion criteria

Remote Mod+P returns and opens expected files on the correct target. Temporary remote listing/search failures recover quietly behind the bigbud logo for up to 30 seconds, with existing content preserved. Persistent failures become actionable rather than leaving an indefinite loader. Local behavior and security boundaries remain intact.

## Implementation and verification — 2026-10-28

### Implemented

- The palette uses shared workspace resolution for local, direct-SSH, managed-agent, draft, and worktree contexts. Opening results forwards the execution target; external root overrides retain their explicitly paired target in the files panel.
- Managed-agent filename search skips discovered symlinks/reparse points and unrepresentable filenames, retains strict validation of explicit search roots, and ranks case-insensitive path/subsequence matches before retaining the bounded result set.
- A shared recovery controller retries read-only operations through the existing transport; it does not introduce a competing reconnect loop. Remote directory reads are serialized, and automatic retries across expanded folders are spaced at least one second apart in addition to per-request backoff.
- A first transient failure starts a fixed 30-second recovery episode. Successful recovery ends the loader immediately. Initially hung requests also have a 30-second response deadline. A still-running request retains its key and disables Retry until it settles; late success is accepted only for its original workspace/query.
- Cached root/nested entries and previews remain visible during temporary and persistent remote failures. Errors use Retry and collapsed, bounded, sanitized diagnostics. Authentication, host-key, permission, and missing-path failures remain immediately actionable.
- Recovery ownership is explicitly identity-keyed and handles the app’s StrictMode cleanup/setup lifecycle. Workspace/query changes, closing the palette, and unmount stop old retries. Queued forced refreshes wait for actual completion even after a hung request has crossed its UI deadline.

### Focused verification

- Web unit tests: **130 passed across 12 files**, covering recovery timing/classification, bounded/deduplicated retries, stale responses, workspace resolution, file opening, tree logic, and refresh coordination.
- Chromium browser tests: **25 passed across 4 files**, covering cached root/nested content, preview preservation, immediate successful recovery, the 30-second deadline, Retry/details, hung reads, queued refreshes, workspace switching, palette closing/reopening, StrictMode, target-preserving selection, genuine no-results, and existing refresh coordination.
- Rust filename-search tests: **11 passed** on macOS. Crate-scoped Clippy (`bigbud-remote-agent`, all targets) and formatting of the three changed Rust files passed.
- Web package typecheck, formatting/lint of changed web files, and explicit changed-file length checks passed. No repository/workspace-wide suite was run.

### Remaining verification and limitations

- No live VPS session or packaged desktop build was exercised. Browser cases use deterministic transport failures rather than a real SSH outage.
- The invalid-UTF-8 filesystem regression is Linux-gated: APFS rejects that fixture. Linux and Windows native filesystem cases were not run on this macOS host.
- Existing traversal bounds remain intentional: oversized agent workspaces can return `SearchLimitExceeded`; ranking scans the bounded tree under the existing session lock. This change does not add a search index or change that protocol/budget policy.
- Explicit path validation remains enforced. The pre-existing path-validation/enumeration symlink-swap race is not redesigned by this filename-search change.

## Reopened investigation — 2026-10-28

### Observed live failure

- The user still sees “Couldn't load workspace files” in Mod+P for query `visa`.
- The running development backend recorded 16 failed remote search requests. The underlying error is `Failed to search workspace entries: workspace path contains a symlink component`; recent requests fail in approximately 33–80 milliseconds, not after a connection timeout.
- Read-only inspection of development connection bindings identifies the active managed Linux agent as version `0.2.209`, build digest `d2e1cfabf50b9ecca90ce8cad95c3c73777d98b5`, binary SHA-256 `66a21f0e71940101fce659bffc64cc00ffd0fa92950048d69d103fd902c309bf`. The active SSH proxy command references the same version and binary digest.
- That build digest resolves to the September 15, 2026 commit. Its `workspace/search.rs` lines 54–55 explicitly abort on any discovered symlink. The corrected local source skips discovered symlinks instead.
- The managed-agent installer uses signed release artifacts, not the locally rebuilt macOS executable. A fresh UI/backend launch does not automatically deploy uncommitted Linux source changes. Existing managed runtimes can also remain pinned to preserve their owners.
- This establishes that the active remote runtime lacks the fix. The exact encountered symlink has not been identified: a read-only SSH probe failed authentication with `Permission denied (publickey,password)`. No VPS files, runtime, or connection settings were changed.

### Corrected remaining plan

1. Build the corrected Linux agent for the target architecture from the current source; run focused Linux search regressions and record the artifact identity. Do not assume a published release already contains these uncommitted changes.
2. Prepare a trusted artifact/install source compatible with the existing signature verification and managed-upgrade path. Do not bypass trust checks or overwrite an active runtime binary.
3. Obtain explicit approval before installing or activating a replacement VPS runtime. Inspect active ownership and let the existing managed upgrade flow preserve pinned sessions; do not force-kill owners or silently switch transports.
4. Verify the search connection actually uses the corrected build digest, then search `visa` on the live workspace and open a returned remote file.
5. Recheck logo-only recovery separately. A deterministic old-agent symlink failure must not be described as fixed merely because an error is delayed or displayed more cleanly.
6. Mark the issue complete only after the live target returns and opens expected results. Keep explicit root/path security checks intact.

### Verification boundary

This follow-up is a read-only runtime/source diagnosis plus a plan correction. No new implementation or deployment has been performed, and no new code tests are claimed. Earlier passing mocked browser tests and macOS Rust tests do not establish the behavior of the deployed Linux agent.
