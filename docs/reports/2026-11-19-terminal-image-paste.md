# Terminal image paste into AI TUIs: root cause and recommended fix

Date: 2026-11-19. Scope: research and recommendation only. No product code was changed.

## 1. Summary

AI TUIs never get image bytes from the terminal. When they receive a trigger, they read the
clipboard of **the machine they run on**, inside their own process. Two triggers exist:

- a **key event**: Ctrl+V (`0x16`), sometimes Alt+V or Ctrl+Alt+V;
- an **empty bracketed paste**: `ESC[200~ESC[201~`. Only some TUIs treat this as "read the image".

They also attach an image when the pasted text is a path to an image file that exists on their host.

bigbud's terminal (xterm.js) forwards Ctrl+V as `0x16` without changing it, so locally it behaves like
a native terminal. bigbud breaks image paste in three places:

1. **Remote terminals (definite, the main gap).** The TUI runs on the remote host and reads that
   host's clipboard, which is empty or has no display server. bigbud has no way to move image bytes
   to the PTY host. Native file drops onto remote terminals are also **silently dropped**
   (`apps/web/src/components/terminal/TerminalViewport.tsx:275-279`). On a remote target, no key,
   paste or drop can attach an image today.
2. **Cmd+V / menu Paste (definite).** xterm's paste handler reads only `text/plain` and throws away the
   image in `ClipboardEvent.clipboardData`. With an image-only clipboard it sends an empty bracketed
   paste (or nothing when bracketed paste mode is off). Claude Code (macOS/WSL) and OpenCode treat that
   as "read the clipboard". **Codex and Gemini CLI ignore it.** Codex's own issue tracker confirms
   that on macOS Codex only pastes images with Ctrl+V, not ⌘V (openai/codex#10523).
3. **Files copied in Finder (high confidence, needs a live check).** Native terminals paste the
   file's full path. Chromium's `text/plain` for a copied file is just the file **name**, which is
   what xterm pastes. The TUI cannot resolve it, so nothing attaches. The real path is available
   through `clipboardData.files` plus Electron `webUtils.getPathForFile`, which bigbud already uses
   for drops.

Recommended fix: make bigbud act like a terminal with built-in file transfer. On a paste gesture that
carries an image or file, **stage the bytes on the host that runs that PTY** (decided by the server,
never by the client). Use a private 0700 directory and 0600 files. Then paste the absolute path as a
bracketed paste. All four TUIs accept a pasted image path. This works the same way for local, remote,
browser and mobile clients. Ctrl+V stays the TUI's key and is never taken over by default.

## 2. How each TUI receives a pasted image (evidence)

Sources: Codex TUI source at `openai/codex` HEAD 65d69f25 (2026-11-19; the installed CLI is 0.170.0),
the Claude Code 2.1.328 bundle, the OpenCode 2.3.2 bundle, and Gemini CLI source at HEAD.

| Tool        | Key that triggers a clipboard read                                                                                                             | Empty bracketed paste (Cmd+V with image-only clipboard)                                                              | Pasted image path                                                                                                                                                                                                 | Where and how it reads                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI   | `v` with CONTROL or ALT (Ctrl+V, Alt+V, Ctrl+Alt+V for WSL hint), Shift+Insert on Windows (`chatwidget/clipboard.rs` `image_paste_key_action`) | **Ignored** (`app.rs` only acts on non-empty pastes; no image fallback)                                              | Yes, **one path per paste**: quotes, `file://` and shlex must give exactly one token, the file must exist and decode (`chat_composer.rs` `handle_paste_image_path`, `clipboard_paste.rs` `normalize_pasted_path`) | In process: `arboard` plus `NSPasteboard` on macOS. A copied file list wins over bitmap data. Writes a temp PNG (`clipboard_paste.rs`) |
| Claude Code | `chat:imagePaste`: `ctrl+v` (macOS/Linux), `alt+v` (Windows/WSL), plus `ctrl+v` on WSL                                                         | **Reads the clipboard image** on macOS and WSL (`rawEmpty` branch of the paste handler)                              | Yes, absolute image paths, several per paste, plus a special case for screencaptureui temp paths                                                                                                                  | In process: `osascript … «class PNGf»` saved to a private temp dir (0700); PowerShell on WSL/Windows                                   |
| OpenCode    | `prompt.paste` = `ctrl+v` (`preventDefault:false`)                                                                                             | **Dispatches `prompt.paste`** (`onPaste`: `bytes.byteLength===0`), which reads the clipboard and prefers `image/png` | Yes, paths or `file://` become file attachments (images, PDF)                                                                                                                                                     | opentui native clipboard service (NSPasteboard on the host) with a "terminal" channel. Protocol not verified, probably OSC 52 text     |
| Gemini CLI  | `input.paste` = `ctrl+v` (and `cmd+v`, which arrives only under the kitty keyboard protocol), plus right-click                                 | **Ignored**: treated as an ordinary empty paste                                                                      | Yes, drag/paste paths become `@path` references                                                                                                                                                                   | In process: `osascript` / PowerShell / `wl-paste` / `xclip`. Saves `clipboard-<ts>.png` under the project temp dir and inserts `@path` |

Native terminals: Cmd+V with a bitmap-only clipboard produces at most an empty bracketed paste. So
Codex and Gemini users rely on **Ctrl+V** there, and on Cmd+V only after copying a **file** (the
terminal pastes its full path). Over SSH all four tools fail in native terminals too:
anthropics/claude-code#106303 ("Ctrl+V reads the remote machine's clipboard") and #98469 (the "try
scp?" hint). kitty and Ghostty 1.4+ now offer the kitty clipboard protocol (OSC 5522) for in-band
remote paste. Claude Code has an open request to adopt it (anthropics/claude-code#105520); none of
the four tools uses it as a client today.

## 3. What bigbud does today (evidence)

- **Ctrl+V.** The custom key handler `createTerminalKeyEventHandler`
  (`apps/web/src/components/terminal/TerminalViewport.keybindings.ts`) does not match `v`. No default
  keybinding uses `+v` (searched the server keybindings and contracts). xterm maps Ctrl+letter to C0
  (`@xterm/xterm@6.1.0-beta.304 src/common/input/Keyboard.ts:314-316`), so Ctrl+V becomes `0x16`. That
  goes through `TerminalInputQueue` → `api.terminal.write` → the PTY with no filtering, both locally
  and through the Rust agent (`crates/bigbud-remote-agent/src/session/pty_input_reconcile.rs`). xterm
  calls `preventDefault` on the keydown, so no DOM paste fires. **bigbud does not swallow Ctrl+V.**
- **Cmd+V / Ctrl+Shift+V / menu Paste.** Electron's `editMenu` role
  (`apps/desktop/src/window/menuManager.ts:243`) fires a DOM `paste` event, which xterm's
  `handlePasteEvent` handles (`src/browser/Clipboard.ts:46-58`). It reads only
  `clipboardData.getData('text/plain')`. `bracketTextForPaste` wraps even an empty string, so with
  mode 2004 on the PTY gets `ESC[200~ESC[201~`. With mode 2004 off, `""` is emitted and
  `TerminalInputQueue.enqueue` drops it (`TerminalInputQueue.ts:30`). **Image bytes in
  `clipboardData.files` are never used.** bigbud has no terminal paste listener, no
  `navigator.clipboard`/Electron clipboard read, and no `attachCustomKeyEventHandler` paste logic.
- **Drops.** `TerminalViewport.drop.ts` pastes quoted native paths locally, which works for Codex when
  one file is dropped. On remote targets only files-panel paths are kept and native files are filtered
  out with no notice. WSL drops are rejected with a notice.
- **Bracketed paste mode** is tracked and replayed on reattach (`TerminalModeTracker.ts`), so xterm
  knows when a TUI has enabled it.
- **Windows Ctrl+Alt+V** (Codex's WSL binding) is treated as AltGr by xterm (`_isThirdLevelShift`,
  `CoreBrowserTerminal.ts:937-948`) and never reaches the PTY. This is a small, separate defect.
- **Remote transport limits.** The agent's workspace `WriteFile` is workspace-relative and capped at
  512 KiB (`crates/bigbud-remote-agent/src/workspace/core.rs:25`). Agent frames are capped at 1 MiB
  (`crates/bigbud-protocol/src/lib.rs:12`). `projects.writeFile` is text-only and writes into the
  workspace. None of these suits private image staging; screenshots are often 2–8 MB.

### Unverified local hypothesis

By code reading, local Ctrl+V should work in bigbud the same way it does in a native terminal. If the
user sees it fail **locally**, the cause is environmental, not routing. Possible causes:

- macOS pasteboard privacy attributes the read to `bigbud.app` (the responsible process for the
  backend's PTYs);
- Linux env without `DISPLAY`/`WAYLAND_DISPLAY`;
- the Windows AltGr case above.

Diagnostics to run in a bigbud **local** terminal:

1. `printf '\e[?2004h'; cat -v`, then press Ctrl+V, then Cmd+V with a screenshot on the clipboard.
   Expect `^V` and `^[[200~^[[201~`.
2. `osascript -e 'clipboard info'` in bigbud and in iTerm2/Ghostty. Expect the same types.
3. `codex` with Ctrl+V. If it fails, note the exact error ("no image on clipboard" or "clipboard
   unavailable").
4. Copy an image file in Finder and press Cmd+V at a shell prompt. The bare file name confirms cause 3.

## 4. Options compared

| Option                                                                             | Local                                      | Remote                       | Correctness / risk                                                                                    | Verdict                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| A. Document "use Ctrl+V"                                                           | Works (except the environment cases above) | No                           | No code                                                                                               | Interim guidance only    |
| B. Turn Cmd+V with an image-only clipboard into `0x16`                             | Codex/Gemini work                          | No                           | `^V` is literal-next in shells and visual-block in vim. Safe only behind agent detection; a heuristic | Not recommended          |
| **C. Stage the bytes on the PTY host and paste the absolute path (bracketed)**     | All four TUIs                              | All four TUIs                | Explicit and visible. Needs a transport, limits, cleanup and consent                                  | **Recommended**          |
| D. Implement kitty OSC 5522 (clipboard read and paste events) in bigbud's emulator | Only TUIs that adopt 5522                  | Same, in-band over agent/SSH | The standards-based end state, but no target TUI uses it today. Permission model needed               | Phase 4 / track upstream |
| E. Always intercept Ctrl+V and run app paste                                       | Breaks the TUIs' own Ctrl+V and shell `^V` | Partial                      | Regression                                                                                            | Rejected                 |

## 5. Recommended design (option C)

1. **Classify each terminal `paste` event.** Use a capture-phase listener on the terminal mount, so it
   runs before xterm's textarea and element listeners.
   - **File list with native paths** (Electron, Finder copy): local host → paste the absolute
     path(s); remote → stage the bytes.
   - **Image blob(s), no meaningful text**: stage, then paste the path.
   - **Text present**: unchanged xterm behaviour. Text wins when both exist.
   - Use `preventDefault` + `stopPropagation` only when bigbud handles the paste.
   - The paste event's `clipboardData` gives image bytes **without** Clipboard API permissions. This
     works in Electron, desktop browsers and mobile paste menus.
2. **Server-authoritative staging RPC** (`terminal.stagePasteFile`). Input: `threadId`, `terminalId`,
   `expectedGeneration`, `mimeType`, `sha256`, and bytes (chunked).
   - The server resolves the host from the terminal session's `executionTargetId`, never from the
     client. The browser client may be a phone, and the PTY host is wherever the session runs.
   - Validate the type by magic bytes (PNG/JPEG/GIF/WebP), cap the size (proposed 20 MB, configurable),
     reject a stale generation, and use random filenames with no spaces.
   - **Local host:** `<server state dir>/terminal-paste/` with a 0700 dir and 0600 files; on Windows,
     a user-only ACL under `%LOCALAPPDATA%`.
   - **Remote host:** a new agent operation (begin/chunk/commit with digest, under the 1 MiB frame
     cap) writes to `~/.bigbud/agent/paste/` with the same permissions (reuse `state/core.rs` private-dir
     creation). It returns the absolute path.
   - **WSL:** keep rejecting with a notice until staging into the distro exists.
3. **Ordered delivery.** Add a deferred "barrier" item to `TerminalInputQueue`, so keys typed during an
   upload are not sent ahead of the path. Add a timeout and cancel, and clear it on a generation change.
   Paste through `terminal.paste()` (bracketed when mode 2004 is on; ESC is already sanitized).
   - For several files, send **one bracketed paste per path**, separated by a typed space. Codex attaches
     only single-path pastes.
4. **Consent and visibility.**
   - Remote uploads use `Ask (once per host) / Always / Never`.
   - Show a toast with the host, file name and size (blue while uploading, green when done, amber or
     red on failure).
   - No background clipboard reads: only a user paste gesture or an explicit command.
   - If the focused terminal, generation or host changes before completion, discard the upload and
     delete the staged file.
   - Never log the bytes.
5. **Cleanup.** TTL sweep (proposed 24 h) and a total cache-size cap. Do not delete on submit; Codex
   reads attachments lazily. Optionally delete when the terminal closes.
6. **Settings** (Terminal settings page). Terminal image paste: `Paste as file path` (default) /
   `Pass through to the app` (current behaviour) / `Off`. Remote image upload: `Ask` / `Always` /
   `Never`.
7. **Optional, later.**
   - An explicit "Paste image from clipboard" command (terminal context menu and command palette)
     using Electron `clipboard.readImage().toPNG()` through preload IPC, or `navigator.clipboard.read()`
     in browsers (permission prompt).
   - Opt-in Ctrl+V interception for remote targets only, with the input barrier, that forwards `0x16`
     when there is no image.
   - Fix Windows Ctrl+Alt+V.
   - Later, OSC 5522.

## 6. Where the code would go

- Web:
  - new `apps/web/src/components/terminal/TerminalViewport.paste.ts` (+ `.logic.ts` for the
    classifier and policy);
  - wire it in `TerminalViewport.input.ts` (`attachTerminalViewportInput`) or next to the drop
    handlers in `TerminalViewport.tsx`;
  - move the path formatting in `TerminalViewport.drop.ts` into a shared `TerminalViewport.paths.ts`;
  - add the barrier in `TerminalInputQueue.ts`;
  - route remote native drops through the same staging path.
- Contracts:
  - `packages/contracts/src/workspace/terminal.ts` (input/result/error schemas);
  - `packages/contracts/src/constants/websocket.constant.ts` (method name);
  - `packages/contracts/src/server/ipc.nativeApi.ts` (`terminal.stagePasteFile`);
  - `packages/contracts/src/core/settings.terminal.ts` (the two settings).
- Server: `apps/server/src/ws/wsRpcHandlers.terminal.ts`; new
  `apps/server/src/terminal/Layers/Manager.pasteStaging.ts` (plus local/remote split files).
- Rust/protocol: `protocol/remote-agent/v1.proto` (staging messages); new
  `crates/bigbud-remote-agent/src/session/paste_staging.rs`; cleanup through `resource_cleanup/`.
- Desktop (optional command): `apps/desktop/src/preload.ts` and `apps/desktop/src/window/ipcHandlers.ts`
  (`readClipboardImage`).
- Settings UI: `apps/web/src/components/settings/TerminalSettingsPanel.tsx` (plus settings search
  entries).

## 7. Phased plan with tests

- **Phase 0:** run the diagnostics in section 3 to confirm causes 2 and 3 and rule out the local
  environment case.
- **Phase 1 (local, web + server):**
  - paste classifier;
  - native-path paste for Finder copies;
  - server-side local staging for image blobs;
  - input barrier;
  - setting.
  - Tests:
    - unit tests for the classifier and policy matrix (text / image / file-with-path / text+image /
      multiple × local/remote/WSL × setting);
    - path formatting per `dropPathMode`;
    - queue barrier ordering, timeout and generation clear;
    - a browser test dispatching a synthetic `paste` with a `DataTransfer` image File: expect a stage
      call and a `ESC[200~/abs/path ESC[201~` write, text paste unchanged, Ctrl+V still `0x16`;
    - server tests for the session-derived target, 0700/0600 perms, magic-byte check, size cap, TTL
      and stale-generation rejection.
- **Phase 2 (remote):**
  - chunked agent staging op;
  - consent flow and toasts;
  - native drops onto remote terminals use the same pipeline.
  - Tests: Rust tests for chunk assembly, digest, limits, perms, path containment and cleanup; a
    server remote test with a fake agent; scoped `cargo fmt`/`clippy`/`test`.
- **Phase 3 (optional):** explicit "Paste image" command, opt-in remote Ctrl+V, Windows Ctrl+Alt+V
  fix.
- **Phase 4:** OSC 5522 support in the emulator once a target TUI adopts it.
- **Manual matrix:** Codex, Claude Code, OpenCode, Gemini × desktop-local / remote agent /
  browser-or-mobile client × macOS/Windows/Linux. Cover bitmap screenshot, Finder-copied file,
  multiple files, text+image, oversized image, and a terminal restart during upload.

## 8. Open decisions

1. Default mode: always stage as a path (uniform, fixes Codex/Gemini on Cmd+V locally), or pass through
   locally and stage only for remote.
2. Remote upload consent default (ask once per host, always ask, or allow), and whether the setting is
   per host.
3. Size cap, TTL, and whether to delete staged files when the terminal closes.
4. Whether to add an explicit "Paste image" command and keybinding, and whether to offer opt-in Ctrl+V
   interception on remote targets.
5. Whether non-image copied files (PDF, etc.) are also staged remotely.
6. WSL staging scope.
7. Whether to invest in OSC 5522 now or track upstream adoption.
