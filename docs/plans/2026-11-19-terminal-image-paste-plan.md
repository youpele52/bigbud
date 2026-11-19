# Terminal image and file paste as absolute paths

**Date:** 19 November, 2026
**Status:** Implemented (pending live verification below)
**Owner:** implementer agent

## Summary

Pasting an image (or any copied file) into a bigbud terminal always lands as a full absolute path
on the machine that runs that terminal. Local terminals stage clipboard images in a private folder
on the server host; Finder-copied files paste their real paths. Remote terminals upload the bytes
automatically to the remote agent's private paste folder, and the agent returns the resolved
absolute remote path (and sets the remote clipboard when that machine has a graphical session).
Remote drag-and-drop of local files uses the same upload. bigbud also answers the kitty/Ghostty
OSC 5522 clipboard protocol, limited to the pane the user is actively pasting into.

## Related Work

- Research report: [Terminal image paste](../reports/2026-11-19-terminal-image-paste.md)
  (root causes, per-tool behaviour, file references in section 6, tests in section 7).
- kitty clipboard protocol: <https://sw.kovidgoyal.net/kitty/clipboard/> and the paste-event
  addendum <https://rockorager.dev/misc/bracketed-paste-mime/>.

## Problem

See report sections 1 and 3. In short: xterm's paste handler only reads `text/plain`, so image
bytes in `ClipboardEvent.clipboardData` are dropped (Codex and Gemini ignore the resulting empty
bracketed paste); a Finder-copied file pastes only its bare name; remote terminals have no way to
receive image bytes, and native drops onto remote terminals are silently filtered
(`TerminalViewport.tsx` drop handler).

## Goals (user decisions, authoritative)

1. Image paste with no text always becomes a file path, locally and remotely. Text pastes are
   unchanged; text wins when both exist. Ctrl+V is never intercepted (the TUI keeps it).
2. Finder-copied files paste their real absolute paths locally (`clipboardData.files` +
   `webUtils.getPathForFile`, the bridge already used for drops).
3. Remote uploads never ask for consent; a small informational toast shows host and size
   (blue while uploading, green when done, red on failure).
4. Size cap: 20 MB default per file, configurable in Settings > Terminal (10 MB minimum).
   Larger files are rejected with a clear toast. Staged files are deleted when the terminal
   closes or restarts, plus a startup sweep (24 h TTL) and a total-size cap.
5. No explicit "Paste image" command.
6. Any file pasted or dropped from the local machine into a remote terminal uploads to the remote
   `~/.bigbud/agent/paste/` (0700 dir, 0600 files, random names without spaces) and lands as its
   absolute remote path. The remote clipboard is also set to the image when, and only when, the
   remote has a usable clipboard; headless hosts skip silently. Older agents get a toast that the
   remote agent needs updating (no silent drop). The server chooses the target machine from the
   terminal session, never from the client.
7. OSC 5522 now, with a safety model and a setting to disable it.
8. Every pasted path is a full absolute path (never relative, never `~`, never a bare name).

## Non-Goals

- WSL staging (WSL keeps rejecting with a notice, as drops do today).
- An explicit paste-image command or opt-in Ctrl+V interception.
- OSC 5522 clipboard writes from programs (answered with `EPERM`).
- Windows remote agents: staging works, but only POSIX permission bits are enforced; the
  clipboard step is skipped on Windows.

## Current State

- Paste: xterm `handlePasteEvent` (text only). bigbud has no paste listener.
- Input: `TerminalInputQueue` (one write in flight, coalesced) fed from
  `attachTerminalViewportInput` (`TerminalViewport.input.ts`).
- Drops: `TerminalViewport.drop.ts` quotes native paths; remote drops keep only files-panel paths.
- Remote agent: `bigbud-remote-agent` session dispatch in `session/core.rs`, capabilities in
  `session/hello.rs`; frames capped at 1 MiB; TS codec is hand-written in
  `apps/server/src/remote-agent/remoteAgentProtocol.codec.*.ts` with shared goldens in
  `protocol/remote-agent/v1.golden.frames`.
- Terminal manager optional capabilities (`search?`, `recovery?`) are the pattern for an optional
  server operation exposed over one RPC.

## Design

### Path form (quoting rule)

Source inspection of how each TUI recognises a pasted path:

| Tool                                                                                   | Parser                                                      | Raw `/a b.png`  | `'/a b.png'` | `"/a b.png"` | `/a\ b.png` | `'it'\''s.png'` |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------- | ------------ | ------------ | ----------- | --------------- |
| Codex (`clipboard_paste.rs normalize_pasted_path`)                                     | strip one outer quote pair, else `shlex`, exactly one token | no (two tokens) | yes          | yes          | yes         | yes             |
| Claude Code 2.1.328 (`N` strips one outer quote pair, `L` removes `\x` escapes)        |                                                             | yes             | yes          | yes          | yes         | no (`it''s`)    |
| OpenCode 2.3.2 (`v` strips all outer quotes, removes `\x` escapes; fallback tokenizer) |                                                             | yes             | yes          | yes          | yes         | no              |
| Gemini CLI (`parsePastedPaths`, quote/backslash aware splitter)                        |                                                             | yes             | yes          | yes          | yes         | yes             |

Chosen rule for POSIX shells (`posix`, `msys`, `wsl` drop modes): **backslash-escape every ASCII
character outside `[A-Za-z0-9_./,:+@%=-]`**, which all four tools and every POSIX shell accept,
including names with spaces and apostrophes. Paths containing control characters (newline, tab)
fall back to single quotes, because a backslash-newline is a shell line continuation. PowerShell
and cmd keep their existing quoting. Staged files use `[a-z0-9]` names, so they never need
escaping. One bracketed paste per path (Codex attaches only single-path pastes), separated by a
typed space. Drops use the same formatter. Paths that are not absolute are never pasted.

### Phase 1: local

- Contracts: `terminal.paste.ts` (`TerminalPasteStageInput/Result/Error`, chunk size),
  `terminal.stagePasteFile` method, server settings `terminalPasteMaxFileMb` (10-200, default 20)
  and `terminalClipboardRequests` (OSC 5522, default on).
- Server: `Manager.pasteStaging*.ts`, exposed as an optional `stagePasteFile` on the terminal
  manager (built in `Manager.ts`, which owns `stateDir` and settings). One RPC with
  `begin | chunk | commit | abort`. `begin` reads the session snapshot: target, generation and
  running status come from the server, never from the client. Local store:
  `<stateDir>/terminal-paste/` (0700), files created exclusive with 0600, written to a `.partial`
  file, sha256 checked at commit, renamed to `<random>.<ext>`; the returned path is absolute.
  Stale generation at `begin` or `commit` discards the upload. Releases on close/restart through
  wrapped manager `close`/`restart`, plus a periodic reconcile of sessions that disappeared, a
  24 h TTL startup sweep and a 512 MiB total cap.
- Web: capture-phase `paste` listener on the terminal mount (`TerminalViewport.paste.ts`),
  classifier in `TerminalViewport.paste.logic.ts`, shared path formatting in
  `TerminalViewport.paths.ts`. A deferred item in `TerminalInputQueue` holds later keystrokes
  until the path is ready (timeout 120 s, cancel action on the toast, cleared on generation
  change). Settings rows in a new Terminal settings "Paste" section.

### Phase 2: remote

- Protocol: `protocol/remote-agent/paste_staging.proto` with begin/chunk/commit/discard request
  and response frames (fields 66-73), capability `terminal.paste-staging` 1.0, protocol minor
  stays 8 (capability-gated, additive). Goldens shared by Rust and TypeScript.
- Agent: `paste_staging/` capability folder (store, names, clipboard). Root is the sibling
  `paste` folder of the agent state root (`~/.bigbud/agent/paste`), created 0700 through the
  existing private-directory helper; files 0600 `create_new`; chunks must be sequential; sha256
  verified at commit; returned path is `canonicalize`d (absolute, home resolved by the agent).
  Limits: chunk 512 KiB, file 256 MiB hard cap, total 512 MiB (oldest evicted), 8 concurrent
  uploads, 10 min idle upload expiry, 24 h TTL sweep at startup. Clipboard step only for images
  and only when a clipboard is usable: `wl-copy` with `WAYLAND_DISPLAY`, `xclip` with `DISPLAY`
  (`xsel` cannot publish image MIME targets, so it is not used), `osascript` on macOS; the
  helper is spawned with null stdio, waited for up to 300 ms, then handed to a bounded reaper
  (killed after 5 s). Discard removes one upload or a whole scope (one terminal generation).
- Server: remote store uses the session's target and the existing connection pool
  (`getConfiguredRemoteAgentComposition().pool.get`), requires the capability, and maps a
  missing capability to `agentUpdateRequired`. SSH-only remote terminals get
  `remoteAgentRequired`.
- Web: remote targets stage every file (images and others); remote native drops go through the
  same pipeline instead of being filtered.

### Phase 3: OSC 5522

- `TerminalViewport.clipboardProtocol.ts` (+ `.logic.ts`): registers OSC 5522 and CSI handlers
  (DECSET/DECRST `?5522`, DECRQM `?5522$p`).
- Safety model (follows the kitty paste-event model; bigbud never prompts, it denies):
  - Reads are answered only from a snapshot of the clipboard captured during a real user paste
    gesture in **this** pane, and only within 10 s of it. Outside that window: `EPERM`.
  - With paste-event mode 5522 on, a user paste sends the MIME list with a one-time password
    (`name` "Paste event") instead of bracketed text; the password is single use, bound to the
    pane and expires after 10 s. A read with that password gets the data without a prompt.
  - Without mode 5522, a read inside the 10 s window after a paste in the same pane is allowed.
  - Total read size is capped by the paste size setting; chunks are 4096 bytes before base64.
  - Writes are refused with `EPERM`; setting off makes DECRQM report "not recognised" and all
    reads `EPERM`.
- Known TUIs: none of Codex, Claude Code, OpenCode or Gemini uses OSC 5522 today
  (anthropics/claude-code#105520 is an open request).

## Risks And Decision Gates

- Barrier delays typed keys during uploads; bounded by timeout and cancel.
- Mode 5522 is not replayed on view reattach (the server mode tracker does not know it); the
  TUI must re-enable it. Follow-up.
- macOS clipboard over SSH works only with a GUI login session; failures are silent by design.

## Testing And Validation

Per report section 7: classifier/policy matrix, path formatting (absolute, spaces, apostrophes,
per mode), queue barrier ordering/timeout/generation clear, browser paste test (stage call and
`ESC[200~/abs/path ESC[201~`, text unchanged, Ctrl+V still `0x16`), server tests (session-derived
target, 0700/0600, size cap, stale generation, cleanup on close/restart, sweep, absolute path),
Rust tests (chunk assembly, digest, limits, perms, name safety, containment, cleanup, sweep),
protocol goldens in both languages, OSC 5522 logic tests. Mutation-check key tests.
Focused commands only (`oxfmt --check`, `oxlint`, package typechecks, focused Vitest, crate-scoped
cargo fmt/clippy/test).

### Pending live verification

- Codex, Claude Code, OpenCode, Gemini: paste a screenshot (Cmd+V) locally and in a remote
  agent terminal; Finder-copied file with spaces; several files; text+image.
- Remote VPS: upload of a 15 MB file, oversized file toast, terminal restart during upload,
  remote clipboard set under a Wayland/X11 desktop session, silent skip on a headless server.
- Phone client pasting into a VPS terminal.
- An OSC 5522 client (for example kitty's `kitten clipboard` test) against bigbud.

## Acceptance Criteria

- Every route (local staged, Finder path, remote upload, drag-and-drop) pastes an absolute path,
  tested including paths with spaces.
- Remote uploads and drops reach the remote paste folder with 0700/0600 and are removed on
  terminal close/restart; old agents produce an update toast.
- Focused checks are green; nothing is committed.

## Implementation Notes

- Protocol minor stays 8: the new frames are additive and gated by the `terminal.paste-staging`
  capability, which the agent advertises only when its paste folder opened.
- The server reconciles staged files every minute (sessions that ended or restarted without a
  close through this server), on top of the close/restart release and the startup TTL sweep.
- Remote files of a terminal are released by scope; after a server restart the agent's own 24 h
  TTL sweep removes them.
- The client sends an optional SHA-256 (WebCrypto is missing on insecure origins); the server
  always hashes what it received and the agent verifies that digest at commit.

## Open Questions

None blocking.
