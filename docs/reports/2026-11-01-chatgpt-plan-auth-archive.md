# ChatGPT-plan authentication: archived implementation

**Status:** Shelved, incomplete; not approved for release or managed inference.

**Decision recorded:** 2 November 2026. The branch uses the user-requested 1 November date.

**Local archive branch:** `archive-01-11-2026/chatgpt-plan-auth`

**Source worktree branch:** `feature/chatgpt-plan-auth`

**Snapshot base:** `45c4673acb41223af682ab9738597a9ef7256143`

## What was done

The goal was official, backend-owned ChatGPT-plan authentication for bigbud's Codex provider, separate from existing Codex CLI credentials. Work proceeded in an isolated worktree; managed inference remained disabled.

The partial implementation includes:

- Versioned local account-management RPCs and settings UI: connect, cancel, reconnect, permission consent, rename, select and sign out; separate account health and permission state.
- OAuth PKCE/state/nonce and identity verification, protected server-only account/client storage, refresh serialization, cancellation-safe exchange handling and durable uncertainty/signout fences.
- A standalone command-auth helper and encrypted local token broker; grants bind account, owner, thread, private home and mutation epoch without placing bearer tokens in command arguments or environment variables.
- Durable account/history ownership, selector persistence, fail-closed admission/recovery and queue/delegated-choice checks, including real SQLite COMMIT-edge race tests.
- Account-bound internal-generation and handoff candidate capture, publication guards, conservative model/error handling, managed native-event sanitization and generic client-visible handoff failures.
- Focused synthetic native, server, contract and browser tests, security/correctness reviews and source-checkout drift tracking. CLI/other-provider behavior was intended to remain unchanged; the archive is not full regression certification.

These areas are **partial implementation**, not a completed feature. Production installs no qualified managed inference runner. Windows protected storage and managed remote-workspace execution remain unavailable; runtime cancellation, packaging, crash recovery and full ancillary-path qualification are not complete.

## Why it was archived

### Stable Codex still fails the prompt-body redirect safety gate

Installed Codex **0.164.0** and the verified official **0.166.0** macOS arm64 binary both followed a synthetic cross-port HTTP 307 redirect with a POST containing the prompt body. Authorization was stripped, but the destination still received conversation content. Stripping the bearer therefore does not satisfy the agreed redirect-denial requirement.

At the latest stable-release check, OpenAI's release API still reported **0.166.0**, published 29 October 2026. A newer 0.167.0 alpha was found during research but is not a release candidate for this task: the user chose **stable releases only**. Documentation about redirect rejection for native selected-workspace routing does not establish safety for this integration's custom externally authenticated provider path.

The user chose not to accept the leak risk, add an egress proxy or maintain a patched Codex build. Under that design, bigbud-side changes alone have not removed the blocker. Further local implementation would not make the feature safely usable on the qualified stable candidates, so work was shelved rather than presenting account connection as working plan inference.

### A local retry improvement did not solve redirects

The managed provider configuration now fixes `request_max_retries=0` and `stream_max_retries=0`. An isolated 0.164.0 native test reduced persistent-401 behavior from twelve HTTP requests/six helper acquisitions under defaults to **two Responses requests/one helper acquisition**, without app-level turn replay. Same-process expired-bearer refresh still succeeded. The same zero-retry run **still forwarded the prompt body on 307**. The new retry configuration has not been qualified on 0.166.0 or other platforms.

## Validation and limitations

- Latest focused native/config run: **8/8 tests passed**. Its redirect assertion records the unsafe behavior; a passing fixture is **not** redirect-safety qualification.
- Latest handoff-error containment run: **17/17 tests passed**. Earlier security-hardening coverage passed **75/75 affected tests**; these are separate scoped runs, not a full-suite total.
- Latest affected-file formatter, lint and length checks passed. Configured server typecheck still reported **23 unrelated declaration-fixture diagnostics** (TS2742/TS4058). A separate source-only check reported seven other diagnostics outside the latest changed files. Full package/release green is not claimed.
- No live OAuth login, OpenAI inference, billed requests or full-suite/workspace-wide checks were authorized or performed. Native tests used disposable synthetic credentials and loopback endpoints.
- The archival snapshot preserves mixed worktree content, including inherited/concurrently imported Copilot, sidebar and other changes. It must not be treated as a clean, ChatGPT-only patch. The evolving original `feature/computer-use` checkout has additional changes that were deliberately not overwritten or blindly imported.
- The archival commit is a preservation checkpoint, authorized despite known validation failures, not a release commit. Nothing is to be pushed or merged into the active development branch as part of archiving. This report is also placed in that checkout for discoverability; other active files are left alone.

## When to revisit

Revisit after a **stable official Codex release** provides a supported redirect-denial mechanism or transport fix applicable to custom `auth.command` Responses providers. A version bump, selected-workspace-only fix or release-note claim is a reason to test, not permission to enable inference. There is no reliable completion date while that dependency remains external.

Before resuming implementation:

1. Verify the stable binary's official provenance and exact version; run isolated synthetic 301/302/303/307/308 traps. The destination must receive **zero requests**, not merely zero Authorization headers, including relevant same-origin/cross-origin cases.
2. Requalify command-auth refresh, bounded repeated 401s, streaming/compaction, strict resume and no app-level replay on that exact build. Keep inference disabled until the tests establish the required behavior.
3. Reconcile the archive with current development by concern. Separate inherited changes from feature work; review migration numbering, contracts, ownership and settings behavior. Do not blindly merge this old mixed snapshot into a newer active branch.
4. Finish remaining bigbud work: store-backed runner/authority composition, cancellation and child shutdown, earliest-boundary job capture/publication, packaging, crash/restart and enabled-platform qualification. Unsupported Windows/remote modes must stay explicitly unavailable until proven safe.
5. Resolve applicable typecheck failures, obtain fresh independent review, and request separate approval for broad validation and any live/billed acceptance tests. Only enable explicitly qualified build/OS/execution combinations, default off.

Until those conditions change, keep the feature shelved. Existing CLI authentication and other supported provider routes remain the product paths; never silently substitute them for a saved managed-account selection.

## Recovering the work

The archive branch is a local source snapshot, not a release. To inspect it without switching the active checkout:

```sh
git log -1 archive-01-11-2026/chatgpt-plan-auth
git diff 45c4673acb41223af682ab9738597a9ef7256143..archive-01-11-2026/chatgpt-plan-auth
git show archive-01-11-2026/chatgpt-plan-auth:docs/validation/chatgpt-plan-integration.md
git show archive-01-11-2026/chatgpt-plan-auth:docs/validation/chatgpt-plan-integration-drift.md
```

The full plan is preserved at `docs/plans/2026-10-11-chatgpt-plan-integration-plan.md` on the archive branch. Detailed validation and drift records are preserved at the paths above. Local checkpoint metadata, source-preservation manifests and seven ignored non-build test artifacts are retained in the repository's common Git directory under `chatgpt-plan-archives/01-11-2026/`, outside the retiring worktree. That private administrative backup is local only, not part of the commit; ignored dependencies/build caches are not part of the source archive. The report copy in the active checkout is intentionally left uncommitted; the archive branch contains the committed copy.
