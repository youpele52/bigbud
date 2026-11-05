# Muse Windows/Linux qualification kit

Purpose: qualify Muse Code on Windows and Linux so those platforms can flip to
`true` in `MUSE_PLATFORM_QUALIFICATION`
(`apps/server/src/provider/Layers/Muse/Provider.discovery.ts`). Until a
platform has a dated record produced with this kit, bigbud reports Muse
unavailable on that platform (per-platform fail-closed). macOS is already
qualified — see `docs/validation/muse-provider-qualification-2026-10-29.md`.

## Why this cannot run in CI

This repo's workflows (`.github/workflows/ci.yml`, `release.yml`) do have
`windows-2022`, `windows-latest`, `windows-11-arm`, `ubuntu-22.04`, and
`ubuntu-24.04` runners — but live qualification requires a **signed-in native
Muse account**: device-code browser login whose credentials live in the OS
keychain/store of a real user profile (`auth.json` shows `storage=keychain`,
`subs_active` is account-specific, and subscription credentials are
computer-specific per S18). No CI secret may be provisioned for this: it
would mean exporting a user's subscription credential into CI, which the
plan forbids. CI could only exercise install/schema/logged-out paths, which
do not qualify a platform. **Conclusion: run this kit manually on a real
Windows and a real Linux machine with the user's own `muse` login.**

## Setup (each target machine)

1. Install Muse Code from https://dev.meta.ai/docs/muse-code and record
   `muse --version` (expect a `1.4.x` build; record the exact string).
2. Run `muse` in a terminal and complete **browser sign-in** yourself
   (device login). Do not set `META_API_KEY`. Do not copy credentials.
3. Create a disposable workspace and a scratch dir for transcripts.
4. Install the probe harness next to it:
   `npm install @muse-code/sdk@1.4.14` in the scratch dir (the version
   bigbud pins), then copy `probe1.mjs`, `probe2.mjs`, `probe3.mjs`,
   `probe4.mjs`, `probe5.mjs`, `probe6.mjs`, and `tiny-mcp.mjs` from the
   macOS qualification scratch dir
   (`<qualification-root>/phase0/sdk1414/`
   and `<qualification-root>/phase0b/` on the macOS machine — ask the macOS
   operator for these files; they are intentionally not committed because
   they carry machine-local absolute paths). Adjust only the `WS`, binary
   path (`~/.local/bin/muse` vs the Windows/Linux install path), and node
   executable paths at the top of each probe. On Windows, note that bigbud
   launches `.cmd`/`.bat` shims through `cmd.exe` — record whether the
   installed `muse` resolves to a `.cmd` shim.

## Scenario checklist (mirror of the macOS rows; all must pass)

| #   | Probe                                                                      | Expected                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `probe1.mjs` (Node)                                                        | Handshake grants `sessionMcp`, `sessionDurability=durable`, sandbox available; account state `accountLogin` (redact the label); profiles `:read-only/:ask-me/:auto-review/:unrestricted`; catalog providerId `meta`                                              |
| 2   | `probe3.mjs mcp`                                                           | Two turns complete; required stdio MCP tool only runs after an `allow_once` approval; tool result echoed verbatim                                                                                                                                                |
| 3   | `probe3.mjs resume`                                                        | Codeword recalled after host restart; history mode is a known value (`inline`/`snapshot`/`suffix`/`none`)                                                                                                                                                        |
| 4   | `probe3.mjs queued`                                                        | Second turn ack `queued`; exact-ID `turn/unqueue` emits `turn/unqueued` with the original submission command ID and no start/completion; exact-ID `turn/cancel` ends with terminal `cancelled`                                                                   |
| 5   | `probe4.mjs` matrix (`:ask-me`+`promptUnmatched`, deny/allow, in/out)      | In-workspace write auto-applies; shell is approval-gated (deny blocks it); out-of-workspace write is sandbox-denied. Any deviation from the macOS mapping means the platform does **not** qualify with the current mapping — record it, do not relax the mapping |
| 6   | `probe5.mjs staged`                                                        | Stage-2 reissue carries a new requirement ID; a stale decide is rejected (`-32053`) without approving stage 2; correct decides complete the turn                                                                                                                 |
| 7   | `probe5.mjs userinput` / `userinput-cancel`                                | Question is answered via `userInput/answer`; cancel path settles and the model observes cancellation                                                                                                                                                             |
| 8   | `probe6.mjs lease`                                                         | Second host resume is rejected `sessionInUse` (-32021); duplicate `session/start` rejected `session_id_conflict`; original owner unaffected                                                                                                                      |
| 9   | `probe6.mjs auth-home` (HOME override to an empty dir)                     | `account/read` projects `loggedOut`; with a (bogus) `META_API_KEY` it projects `envKey` and bigbud rejects that lane. Never use real credentials for this row                                                                                                    |
| 10  | Bun probe (`bun run probe1.mjs`) if the platform ships the Bun server host | Same handshake/catalog/account results as Node                                                                                                                                                                                                                   |
| 11  | `muse schema generate-json-schema`                                         | Record the stable fingerprint; a mismatch with SDK 1.4.14's pin must be warning-only, matching macOS behavior                                                                                                                                                    |

Platform specifics to record: on **Linux**, sandbox helper
availability/first-run setup (`muse sandbox`) and whether the sandbox rows
(5) behave identically; on **Windows**, first-use UAC prompts, `.cmd` shim
resolution, path canonicalization for workspace roots, and process-tree
shutdown (no orphaned `muse serve` after `close()`).

## Recording and flipping the gate

Write a dated section into
`docs/validation/muse-provider-qualification-2026-10-29.md` (or a sibling
dated record) with: OS/build, CLI version, SDK version, runtimes, rows 1–11
results, and any platform deviations. Redact account labels. Only then flip
that platform to `true` in `MUSE_PLATFORM_QUALIFICATION`, update the
focused gate tests (`Client.test.ts`, `Provider.test.ts`), and run the
focused Muse checks (`bun run --cwd apps/server vitest run src/provider/Layers/Muse`)
plus the affected typecheck. Do not flip a platform on partial rows.

## Executable shortcut — the opt-in live adapter test

Since 2026-10-29 the scenario matrix also exists as a real-adapter Vitest run
(`apps/server/src/provider/Layers/Muse/Adapter.live.test.ts`): non-canonical
cwd start, plain turn, in-session model switch, shell approval, user-input
question, running Stop, queued Stop and restart-resume, through the production
adapter and the real `muse serve` host. It is skipped unless opted in:

```sh
MUSE_LIVE_PROBE=1 bun run --cwd apps/server vitest run src/provider/Layers/Muse/Adapter.live.test.ts
```

Requirements: user-installed `muse` on PATH with native browser sign-in, a
non-Contributor catalog default, and acceptance that it sends ~9 short turns
and leaves one durable native session. Run it on the target platform and
paste the pass/fail per scenario into the dated record alongside the
`probe*.mjs` results; a pass here does not replace the MCP bridge rows, which
the probes cover.

## Status after enablement amendment 2 (2026-10-29)

Windows and Linux are **enabled** by user decision. This kit is no longer
an enablement gate. It is the verification that confirms the desk-proven
Windows launch/root handling and the Linux sandbox path on real machines.
A failed run means withdrawing that platform (`MUSE_PLATFORM_QUALIFICATION`)
until fixed, not leaving it silently broken.
