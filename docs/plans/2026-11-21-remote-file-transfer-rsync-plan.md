# Remote file transfer over rsync: drag out, download, folder upload, progress and cleanup

**Status: Blocked on prerequisite S4 accepted.** Do not start transfer implementation, including M0, until the [Rust SSH ownership plan](2026-11-22-rust-ssh-ownership-plan.md) records the all-consumer cutover and build-specific capability evidence. A passing vertical slice is not acceptance. Transfer qualification is separate and still pending.
**Created:** 2026-11-21 21:21 CET (+0100)
**Last modified:** 2026-11-22
**Project root:** `/Users/youpele/DevWorld/bigbud`
**Inspected baseline:** original source audit at `c7724dddd8`; Windows review against the plan introduced at `dd58798049`. Refresh file ownership before implementation.
**Related issues:** None supplied or found in the reviewed plan context.
**Revision:** 7.11. The Rust SSH owner replaces the earlier TS SSH policy and spawn-helper design. Design §2 governs transfer execution and outcome; historical review logs are not implementation instructions.

## Windows v1 decisions

After SSH-owner S4, qualify two transfer routes independently. Key-auth may use packaged rsync after W0/W1; Windows password targets always select the recursive built-in route, even with a working bundle and the setting enabled. Never probe or stage rsync on a password target. Unsupported Windows password capability returns `windowsPasswordUnsupported` with “Use an SSH key for this host”; a missing SSH owner returns `sshOwnerUnavailable`, never a TS fallback. Keep the >10 MiB progress, cancellation, cleanup and no-overwrite guarantees on both routes.

The SSH prerequisite owns the former W-2–W-4 and W-6–W-12 caller, credential, PTY and lifecycle work. W-1/W-5 survive here as route/credential-isolation tests: no rsync operation for Windows passwords, and no password grant in key-auth rsync. Consume the native capability snapshot; there is no parallel password milestone in this plan. Verify the packaged transfer sequence under **Real SSH integration and manual checks** after cutover.

## Summary

Provide reliable, bidirectional transfers between the local desktop and remote workspaces: files and recursive folders in both directions, progress for transfers larger than 10 MiB (including fallback uploads), terminal/file-tree uploads, download/save-as, and native drag-out with platform fallbacks. macOS, Windows, Linux, and supported remote hosts must not require the user to install or configure rsync. bigbud bundles and stages its pinned rsync locally and remotely; it never invokes a PATH/system rsync.

When the bundled rsync route is unavailable or incompatible, use a setup-free, framed built-in transfer protocol for recursive trees and files, including uploads. Do not downgrade to file-only behavior or refuse folders merely because rsync is unavailable. The transport capability matrix below makes the remote-agent protocol additions an explicit prerequisite. Unsupported old agents, forced-command SSH servers without a compatible bigbud transport, and host targets that cannot run either transport must be reported as unsupported rather than described as working.

The rsync route is preferred for large and incremental transfers. The fallback must preserve recursive structure, enforce limits and safe paths, stream progress and integrity, and finalize safely. Both paths share authorization, conflict rules, transfer manager, cancellation, UI, staging ownership and cleanup.

## Agreed decisions (settled; do not reopen without new evidence)

- **D1:** Bundle GNU rsync 3.5.2, pinned and checksummed, subject to security, licensing and release sign-off. A newer pin requires documented security evidence and requalification. Never use a system/PATH rsync. Refusal of GPL/release sign-off blocks release; it does not silently cut the feature or replace the settled direction.
- **D2:** Transfers **must** work in both directions and recursively for folders, including uploads to Mac remotes and other supported platforms. Routing for single terminal files: a file of 10 MiB or less uses the legacy paste staging when the remote agent advertises `terminal.paste-staging`; otherwise, and for everything larger or any folder, it uses bundled rsync (or the built-in fallback).
- **D3:** Native drag-out is included, with platform-appropriate native implementations and graceful in-app/download/save fallbacks.
- **D4:** If the Windows rsync build fails its spike, Windows automatically uses the built-in recursive fallback; it is not a product blocker for other platforms. Fallback uploads larger than 10 MiB show byte progress.
- Folder upload, large-transfer progress, cleanup, no-extra-setup, private IPC authorization and “no system rsync” are acceptance requirements, not optional follow-up work.
- Direct SSH and remote-agent transports are distinct modes. Do not infer a POSIX remote shell on stock Windows OpenSSH.

## User decisions (answered 2026-11-22)

The user confirmed these three choices. They are settled; do not reopen them without new evidence
and an explicit user decision.

### U1. Conflict policy: always auto-rename, never overwrite, never merge, never prompt

This applies at **every entry point**: Downloads, Save as, file-tree upload, terminal drop and
native drag-out finalization. It covers files and folders alike. bigbud never shows its own
conflict prompt.

| Entry point / operation                     | Entry kind | Destination already has that name (same or different type)                                                                                                                                                                                 | Collisions inside the transferred tree                                                                          |
| ------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Download to Downloads                       | file       | Publish as `name (2).ext`, then `(3)`, … (first free name); never overwrite                                                                                                                                                                | n/a                                                                                                             |
| Download to Downloads                       | directory  | Publish as `name (2)`, `(3)`, …; **never merge** into the existing folder                                                                                                                                                                  | Case-fold or Unicode-normalisation collisions on the destination: the later entry is renamed with the same rule |
| Save as                                     | file       | If the chosen path exists at finalize time, publish as `name (2).ext`. bigbud does not replace even if the OS dialog showed its own "Replace?" question (that dialog is OS-owned and cannot be suppressed); the toast names the final file | n/a                                                                                                             |
| Save as (folder: chosen parent + item name) | directory  | `name (2)`, …; never merge                                                                                                                                                                                                                 | as above                                                                                                        |
| File-tree upload into a workspace folder    | file       | `name (2).ext`, …                                                                                                                                                                                                                          | n/a                                                                                                             |
| File-tree upload into a workspace folder    | directory  | `name (2)`, …; never merge                                                                                                                                                                                                                 | rename the later entry when the remote filesystem folds case or normalisation (probed)                          |
| Terminal drop (private staging, §U3)        | file / dir | Cannot collide with existing files. Two sources with the same basename get separate sub-staging folders (`<id>/<n>/<basename>`), so the terminal receives distinct paths                                                                   | as above, inside each source                                                                                    |
| Native drag-out (macOS promise, Linux XDS)  | file / dir | The drop target chooses the URL. If that path exists when bigbud finalizes, publish as `name (2)`, … and never overwrite                                                                                                                   | as above                                                                                                        |
| Native drag-out (Windows virtual files)     | file / dir | Explorer writes the files itself and owns its own conflict dialog (an OS behaviour bigbud cannot suppress). bigbud itself never overwrites                                                                                                 | Explorer handles them; bigbud renames nothing it does not write                                                 |

**Naming rule (Rust conflict-name implementation and common local/remote conformance fixtures):**

- Files: insert ` (n)` before the **last** extension (`report (2).pdf`, `archive.tar (2).gz`).
  Names that start with a dot and have no other dot get the suffix appended (`.env (2)`).
  Directories always append (`src (2)`).
- n starts at 2. The first free name wins, checked again at the moment of publication.
- The result is kept within 255 bytes: the stem is shortened (at a UTF-8 character boundary)
  before the suffix and extension, never the extension.
- **No-replace publication by the Rust worker on the destination volume.** On `EEXIST`,
  move to the next n, for up to 100 tries before failing with `nameCollision`.
  - **Local files:** `std::fs::hard_link(stage_path, dst)`, which fails with `EEXIST` and never clobbers, then
    `std::fs::remove_file(stage_path)`. Stage on the destination volume. In v1, if that filesystem does not
    support hard links, return `unsupportedFilesystem`, leave the destination untouched, and tell
    the user to choose another location. Propagate unrelated errors such as permission denied or
    disk full; do not relabel them as lack of hard-link support. No native rename helper or
    placeholder-and-replace fallback in v1. M3 does not depend on the optional native drag module.
  - **Local directories, POSIX:** reserve with `std::fs::create_dir(dst)` (atomic, `EEXIST` means the next
    n), then `std::fs::rename(stage, dst)` **onto the reserved empty directory**. POSIX `rename` replaces
    an empty directory, and fails with `ENOTEMPTY`/`EEXIST` if anything appeared in it. On that
    error, leave `dst` alone, take the next n, and retry.
  - **Local directories, Windows:** the worker moves the staged directory directly to a candidate with a same-volume Win32 move that does not permit replacement or copy. Never emulate it with a check followed by a replacing rename.
    - Retry a destination-exists collision with the next candidate (up to 100); report other I/O failures without touching the competing entry. The local **file** hard-link rule above is unchanged.
    - There is no `mkdir` reserve or probe on Windows.
    - Capture the staged directory’s volume and file ID before rename; verify that the published
      directory has that same identity before reporting success.
    - Required Windows CI test (not yet qualified): have a second writer claim the first candidate
      before rename. Verify its entry and contents survive unchanged and the next published name
      has the original stage identity.
  - The rules are implemented once in the local Rust publication module, with tests for an intruding creator on
    each path, including FAT/network volumes: an intruding file survives unchanged; the operation retries or fails safely, never clobbers.
  - **Remote POSIX scripts, files:** `ln -- "$part" "$dst"` (never clobbers), then `rm` the part.
    If `ln` fails, check `[ -e "$dst" ] || [ -L "$dst" ]`:
    - if the name exists, take the next n;
    - otherwise fail with the actual I/O error, or `unsupportedFilesystem` if no safe no-replace
      operation is available. Do not infer lack of hard-link support just from a missing destination.
      Never follow a failed link with `mv -f` over a placeholder.
  - **Remote POSIX scripts, directories:** `mkdir dst; mv stage dst` would **nest** the stage
    inside an existing `dst`, and BSD `mv` has no `-T`. A writer could also drop files into a
    reserved `dst`, and BSD `mv` clobbers them. So the `publish-dir` script does this:
    1. **Reserve privately:** `mkdir -m 700 -- "$dst"` (atomic, and no other user can write into
       it). If the name exists, take the next n, up to 100 times.
    2. **Move each top-level entry, including dotfiles:**
       `for e in "$stage"/* "$stage"/.[!.]* "$stage"/..?*; do`
       `{ [ -e "$e" ] || [ -L "$e" ]; } || continue` (this skips unmatched glob patterns, so an
       empty stage or one without dotfiles is safe). Then
       `[ -e "$dst/${e##*/}" ] && exit 3` (something intruded), then
       `mv -n -- "$e" "$dst"/` where `mv -n` is available (GNU, BSD and busybox all have it; the
       probe confirms), otherwise plain `mv` after that check. Stage and destination are on the
       same filesystem, so each `mv` is a rename.
    3. **Verify per entry:** every manifest top-level name exists in `dst` with the expected type,
       and `dst` contains no other entries.
    4. `rmdir -- "$stage"`. It fails if anything is left, and the publish fails with it.
    5. Only then `chmod` `dst` to its final mode (from the source, minus setuid/setgid and o+w).
    6. **Rollback** runs from a `trap … EXIT` that uses an explicit **moved-list**. Each entry is
       appended to the list only after its `mv` and an existence check in `dst` confirm it moved.
       BSD `mv -n` exits 0 even when it skips, so its exit status is never trusted. On failure the
       trap moves exactly the listed entries back and removes `dst` only if it is then empty;
       otherwise it reports `nameCollision`.

    Tests run on GNU coreutils, BSD (macOS) and busybox: an empty folder, dotfiles only, `..x`
    names, a concurrent creator writing into `dst` (it must be detected, never clobbered),
    filesystems without hard links, and failure rollback.

- **Collision detection inside a tree:**
  - Destinations are classified by a probe in the destination directory: create
    `.bigbud-case-<id>-aB` and test `…-Ab`; create an NFD name and test its NFC form; remove both
    probes. APFS and NTFS are case-insensitive by default; APFS and HFS+ are
    normalisation-insensitive.
  - On a folding destination, names in each directory are grouped by
    `normalize("NFC")` plus full Unicode case folding. Entries are processed in UTF-8 byte order;
    the first keeps its name and later ones get ` (n)`.
  - Every rename is listed in the `done` event's warnings and in the toast ("2 items were renamed").
- **Not a conflict:** names a Windows destination cannot hold (`< > : " | ? *`, control
  characters, trailing dot or space, reserved device names) are refused with a message listing
  them. A single file instead offers Save as.

### U2. Windows password credentials belong to the SSH owner

Use a target-scoped native channel. The transfer worker must not receive, cache or prompt for the password, set askpass variables, or create a master. The SSH prerequisite owns trust, credentials and failure classification.

### U3. Terminal drops through rsync

- Terminal drops that go through the transfer manager (rsync, or the built-in fallback) **ignore
  `terminalPasteMaxFileMb`**. That setting stays only for the legacy paste-staging route. Only the
  free-space check and the numeric transfer limits (§5) apply.
- **Destination:** `<home>/.bigbud/transfers/<scope>/<id>/`, where `<home>` is the validated remote
  home (§7) and `<scope>` is the terminal scope. Directories are created `0700`. Each source has
  its own sub-folder, `<id>/<n>/<basename>`. This is outside `~/.bigbud/agent`, so the agent's
  install inventory and Remove are unaffected (F-14).
- **Retention:** deleted on terminal close or restart (the terminal release hook), or **24 hours**
  after completion, whichever is first.
- **GC is owned by M7:** the release-hook integration, the 24-hour TTL sweep with marker and owner
  checks, and tests (injected clock, close and restart, a stale-stage sweep, never deleting outside
  `<home>/.bigbud/transfers`).

### U4–U8. Windows password-host guarantees inherited from SSH ownership

U4: support the agent, file tree and built-in transfers on qualified password targets. U5: qualify Win10 22H2 with inbox 8.1p1 and Win11 with inbox SSH. U6: the native owner wipes credentials after ten minutes without user activity, on Disconnect or on exit; background checks pause without dropping live sessions. Transfer start is user intent; progress and cleanup are background. U7: single-use password release only to the verified helper for the exact owner-controlled SSH process. U8: explain that this prevents casual retrieval, not deliberate same-user malware. These auth tests and implementations belong to S2/S4 upstream. This plan tests **consumption** of those capabilities and errors, not another implementation.

## Engineering gates still open

1. Prove the exact desktop/remote-agent platform pairs and shipping sidecar layout against release manifests (matrix below is the observed baseline, not a promise of undocumented targets).
2. Complete the cross-platform bundled-rsync staging and no-PATH audit; test both architectures of macOS and all supported Linux/Windows targets.
3. Build and prove recursive, progress-reporting built-in transfer on every supported pair lacking staged rsync, including uploads; negotiate old-agent protocol behavior and document forced-command limits.
4. Close the W0 Windows rsync, capability-consumption, code-signing and Windows 11 checks. A key-auth rsync no-go selects the fallback. A password qualification failure defers Windows password support; it does not select a different password transport or block other platforms.
5. Obtain GPL/source-distribution/legal sign-off and security review of the pinned GNU rsync before release.
6. Prove the one-use grant, IPC authorization and peer-provenance model, including non-loopback server behavior and key rotation on backend restart.
7. Run focused integration and real-host release matrix checks; the independent review verified the design, not platform behavior.

These are implementation and release gates, not additional product choices. Do not claim support for a platform pair until its evidence gate passes; use the specified fallback or typed unsupported outcome otherwise.

## Related Work

- **Hard predecessor:** [Rust SSH ownership plan](2026-11-22-rust-ssh-ownership-plan.md) — S4 accepted for this build before M0. Its evidence does not waive either transfer proof in §2.

- Plan: [Terminal image and file paste as absolute paths](2026-11-19-terminal-image-paste-plan.md),
  the source of today's upload path. Report:
  [docs/reports/2026-11-19-terminal-image-paste.md](../reports/2026-11-19-terminal-image-paste.md).
- Plan: [Remote agent install, replace and remove](2026-11-20-remote-agent-install-plan.md). Its
  Remove deletes only `~/.bigbud/agent`, and its inventory rules constrain where staged binaries
  may live (see F-14).
- Plan: [Terminal lifecycle](2026-11-21-terminal-lifecycle-plan.md), which is in progress in
  another session. Its files are off limits to this plan.
- Report: [P8 live acceptance](../reports/2026-11-18-p8-live-acceptance.md) row 8. A restricted
  (forced-command) peer key produced nothing from `sftp`. This is evidence that restricted keys
  break any file protocol over ssh, so the capability probe must detect them.
- Report: [x86_64 VPS acceptance](../reports/2026-11-19-x86-64-vps-acceptance.md), describing the
  real Debian 13 host used for manual checks.
- bigbud note or Kanban card: **none identified**. The request came directly from the user in
  conversation.

## Problem

Observed behaviour, with evidence:

1. **There is no remote → local transfer.**
   - File tree rows are draggable only with an in-app MIME type and the path as `text/plain`
     (`apps/web/src/components/files/filesPanel.dnd.ts:13-20`,
     `apps/web/src/components/files/FilesPanel.tree.tsx:45-54`).
   - There is no `webContents.startDrag`, no `DownloadURL`, and no save dialog anywhere in
     `apps/desktop/src`. Only `pickFolder` exists, at `apps/desktop/src/window/ipcHandlers.ts:178-189`.
   - "Open externally" is hidden for remote targets
     (`apps/web/src/components/files/FileTargetContextMenu.tsx:177-179`).
2. **Uploads are slow, capped and file-only.**
   - Each 256 KiB renderer chunk (`packages/contracts/src/workspace/terminal.paste.ts:6`) becomes one
     or more agent round trips of at most 512 KiB, each with a 30 s timeout
     (`apps/server/src/remote-agent/remoteAgentPasteStaging.ts:6,83-96`). That puts the bulk bytes on
     the same stdio connection that carries PTY frames.
   - The cap is `terminalPasteMaxFileMb`: default 20, range 10–200
     (`packages/contracts/src/core/settings.terminalPaste.ts:4`).
   - Files upload one at a time (`apps/web/src/components/terminal/TerminalViewport.paste.ts:147`).
     The toast has Cancel but no byte progress (`TerminalViewport.paste.ts:95-102`).
   - **Dropping a folder is broken today.** The dropped directory `File` is staged as if it were a
     file (`TerminalViewport.drop.ts:37-42` → `TerminalViewport.paste.logic.ts:46-51`). It fails as
     empty or unreadable.
   - Direct SSH terminals cannot receive files at all; they need the agent
     (`apps/server/src/terminal/Layers/Manager.pasteStaging.remote.ts:85-109`).
3. **The remote staging cleanup runs only when the agent starts.** `PasteStore::open` sweeps at
   start (`crates/bigbud-remote-agent/src/paste_staging/store.rs:49-61`). A long-lived supervisor
   never sweeps again.

## Goals (definition of done)

1. **Bidirectional files and recursive folders.** On every explicitly supported host pair below, upload and download files and directory trees, including empty directories and hidden entries. The requirement applies to Mac remotes and other supported host platforms; rsync absence may select the setup-free built-in transport, never a file-only restriction.
2. **Upload UX.** Drop files/folders from Finder, Explorer or supported Linux file managers onto a remote terminal or remote file-tree destination. Terminal paths are inserted only after successful completion if session identity is unchanged and there was no intervening user typing; otherwise offer “Paste path.” Small Direct SSH terminal drops use bundled rsync by default when paste staging is unavailable.
3. **Download UX.** Download/Save as files or recursive folders from the remote tree. Native drag-out is provided where supported and otherwise degrades to quick fetch, tray drag, and Download/Save as without losing transfer functionality.
4. **Bundled rsync and setup-free fallback.** Bundle and automatically stage the pinned rsync on local and supported remote endpoints; never use PATH/system rsync. No extra rsync setup by the user. Every supported target lacking a verified rsync path has a recursive fallback for uploads and downloads. Remote-agent fallback requires a negotiated protocol extension; POSIX Direct SSH uses a tested transient streaming/helper script, not an installed tool. Unsupported endpoints are explicitly bounded.
5. **Progress.** All transfers over 10 MiB show byte progress, rate/ETA where measurable, and cancellation, including fallback uploads and downloads. Bytes are acknowledged/verified according to the active transport; start/log output is not completion proof.
6. **Security and correctness.** Scoped local IPC and one-use HMAC grants, target/path confinement, pre-scan limits, symlink/special-file policy, collision checks, integrity, safe finalize and redaction are verified.
7. **Lifecycle.** Cancel and shutdown/disconnect have separate budgets. Immediate failure cleanup while connected; queued indexed cleanup after abrupt loss/reconnect; no network wait in shutdown. Include a confirmed per-host “Remove bigbud transfer files” action that refuses active transfers and deletes only indexed, verified owned artifacts. Cleanup never mutates git config/ignore.
8. **Release proof.** Every claimed desktop/host pair passes packaged artifact selection, no-system-rsync proof, file/folder transfers on eligible routes (Windows password: built-in only), progress, cancel, integrity and cleanup. Unsupported old-agent/forced-command cases state the exact user remedy.
9. **Native drag-out.** macOS file promises, Windows virtual files and conditional Linux XDS (or partial fallback chain) meet target-specific signing and real-host tests. A Windows rsync no-go enables its fallback and does not block macOS/Linux.

## Non-Goals and scope

**In scope:** server transfer manager and both engines; contract/protocol negotiation; package/stage bundled local and remote rsync; setup-free recursive fallback; terminal/file-tree upload; download/save-as/tray; local-only desktop IPC; lifecycle journal and remote cleanup; native drag addon and fallbacks; Windows Cygwin acceleration spike; settings/docs/tests.

**Out of scope:** synchronization/watch/mirroring/`--delete`; remote-to-remote; resume across app restart; owner/group/xattr/ACL/hardlink preservation unless already required for safe tree semantics; browser/mobile transfers; transfer IPC to remote-backend or forwarded clients; claims for desktop OS/arch or remote-agent OS/arch without release artifact and matrix proof; arbitrary stock Windows SSH/forced-command support without a compatible protocol endpoint.

**Must remain unchanged:** ordinary terminal paste staging behavior for existing small files and images; existing terminal/session protocol behavior for older agents; existing picker API response shape; current in-app file-row drag MIME/path behavior; existing SSH unlock/ControlMaster and password session lifecycle on POSIX (through the Rust SSH owner; on win32 it is deliberately replaced per §U2/§U4); provider and remote-agent lifecycle except versioned transfer additions. Do not edit user git config, ignore files, repository metadata or arbitrary staging locations.

## Feasibility verdict per requirement

| Requirement                                    | Current evidence / planned proof                                                                                                                     | Verdict / boundary                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local desktop targets                          | Release workflow lists macOS arm64/x64, Linux x64, Windows x64                                                                                       | Verified as workflow baseline; confirm actual release assets/signing before release claim                                                                                    |
| Remote-agent targets                           | Release workflow lists Linux x86_64/arm64, glibc/musl                                                                                                | Verified as workflow baseline; feature fallback needs protocol addition and version handshake                                                                                |
| Direct SSH POSIX targets including Mac remotes | Existing structured SSH invocation and POSIX remote command support are present; target-specific bootstrap, remote path and BSD utilities not proven | Feasible only after real-host tests; bundle/stage exact remote executable and add setup-free recursive transient stream fallback                                             |
| Direct SSH stock Windows OpenSSH               | No verified POSIX shell / arbitrary command semantics                                                                                                | Not claimed supported without an explicitly compatible endpoint; never assume shell/quoting/path behavior                                                                    |
| Recursive fallback on remote agent             | Existing protocol is file/paste oriented and lacks recursive write stream                                                                            | Requires scoped agent protocol addition with capability negotiation, recursive manifests, bidirectional bounded chunks, per-file completion and cleanup                      |
| Recursive fallback on POSIX Direct SSH         | Existing SSH can run structured commands but `cat`/shell semantics and target variants need proof                                                    | Add temporary streaming scripts (`dd`-loop framed records, large-file channels) with no installed helper; test safe recursive mkdir/write/read/finalize on each POSIX target |
| Windows rsync                                  | Cygwin build not yet proven; user's settled fallback                                                                                                 | Conditional acceleration; W0 no-go selects built-in fallback, including recursive upload and >10 MiB progress                                                                |
| Native drag-out                                | Electron startDrag requires existing files; file promise/virtual-file APIs need native addon                                                         | Feasible by platform implementation and fallback chain; Linux XDS remains gated                                                                                              |
| Security/lifecycle                             | Existing per-route authority, transfer lifecycle, IPC roles and journal patterns require detailed integration                                        | Feasible after M6a, M3/M4 tests; remain release blockers until proved                                                                                                        |

## Current State (repository findings)

### F-1 Current upload flow (terminal drop or paste of a file onto a remote terminal)

```
 Finder / clipboard
       │  File objects (renderer)
       ▼
 TerminalViewport.paste.ts  ── file.size > terminalPasteMaxFileMb? → red toast, stop
       │  sequential per file; one "Uploading…" toast with Cancel, no bytes
       ▼
 WS RPC terminal.stagePasteFile  begin → chunk(256 KiB base64)… → commit(sha256) / abort
       ▼
 apps/server terminal/Layers/Manager.pasteStaging*.ts
   SHA-256, runtime-generation check, 2 min idle expiry (Manager.pasteStaging.ts:25)
       │  needs an agent-owned PTY runtime, else "remoteAgentRequired"
       ▼
 remoteAgentPasteStaging.ts  PasteStage{Begin,Chunk,Commit,Discard} frames,
   one round trip per ≤512 KiB, 30 s timeout, on the SAME stdio as PTY traffic
       ▼
 ssh -T … sh -lc 'exec bigbud-remote-agent --proxy'   (remoteAgentConnection.ts:141-158)
       ▼
 agent paste_staging  ~/.bigbud/agent/paste/<scope>/<random>.ext (0700/0600, .partial→rename)
   limits 512 KiB chunk · 256 MiB file · 512 MiB total · 8 uploads · 24 h TTL swept only at open
       ▼
 escaped absolute path typed into the terminal (TerminalViewport.paths.ts)
```

### F-2 SSH transport

- `buildSshTransportArgs` (`apps/server/src/ssh/sshCommand.ts:46-68`):
  - Key targets get `-T -o BatchMode=yes [-o IdentitiesOnly=yes] [-p port] [-i key]`.
  - Password targets get `-T -o BatchMode=yes -o ControlMaster=no -o ControlPath=<socket>
[-p port]` (`sshSession.ts:82-97`). The socket is checked for freshness first; a dead socket
    throws `SshTargetAuthRequiredError` (`sshSession.ts:180-193`).
- `buildSshCommandInvocation` (`sshCommand.ts:70-113`) runs remote commands as
  `sh -c REMOTE_EXEC_SCRIPT`, with every argument POSIX-quoted and `--` before the destination.
  It supports a `shellMode` of `"clean-posix"`.
- The password ControlMaster is created by `unlockSshExecutionTargetPassword`:
  - flags `-f -N`, `ControlPersist=600`, `StrictHostKeyChecking=yes` (`sshSession.ts:236-344`);
  - the socket is under a per-process `mkdtemp("/tmp/bbs-")` (`sshSession.ts:33-43`);
  - masters close on Disconnect (`closeSshPasswordSession`, `:350-366`) and on process exit
    (`:368-383`);
  - the askpass directory is created and deleted around the unlock (`:261,341-343`).
- **Remote commands killed locally keep running on the remote.** `sshCommand.cancellation.ts:1`
  says "Local ssh termination is not remote process termination". This matters for remote rsync
  cleanup (see Design §6).
- Disconnect runs best-effort `RemoteDisconnectStep`s (`apps/server/src/ws/wsRemoteConnection.ts:24-34`).
  - The steps are built by `makeRemoteDisconnectSteps` in `wsRemoteConnection.steps.ts`, in this
    order: provider sessions, direct-SSH terminals, remote-agent connections, ControlMaster,
    monitor.
  - Two callers wire them: `wsRemoteConnection.handlers.ts:21` and
    `wsRemoteAgentRemove.dependencies.ts:36`.
  - **The disconnect is persisted before any step runs** (`markSshTargetDisconnected`,
    `wsRemoteConnection.ts:82-102`). After that, `assertSshTargetConnected`
    (`sshTargetDisconnects.ts:59-63`) makes `buildSshTransportArgs` (`sshCommand.ts:49`) throw for
    that target. **No step can run ssh against the host.**
- The Direct SSH `readFileRange` runs `dd bs=1` and one ssh per 512 KiB
  (`apps/server/src/workspace/Layers/WorkspaceFileSystem.range.ts:16-18`). It is unsuitable for
  bulk transfer.

### F-3 Remote file tree and file I/O

- Remote file reads go through `WorkspaceFiles.readFileRange` and `listDirectory`
  (`apps/server/src/workspace-runtime/Services/WorkspaceFiles.ts:44-52`).
- `makeTargetAwareRuntime` routes each call to the agent backend or the local or Direct SSH backend
  (`WorkspaceRuntime.ts:23-40`).
- On the agent, `ReadFile` is capped at 5 MiB per call (`crates/bigbud-remote-agent/src/workspace/files.rs:51`).
  The server reads 512 KiB per call (`WorkspaceRuntime.remote.read.ts:4`).
- `ListDirectory` returns at most 10,000 entries (`workspace/core.rs:24`). Its `DirectoryEntry`
  has `is_directory`, `is_file`, `size_bytes` and `modified_unix_ms`
  (`protocol/remote-agent/workspace.proto:48-54`).
- Agent path resolution rejects symlink components (`workspace/path.rs:22-41`, `WorkspaceError::SymlinkComponent`).
- The file tree has **no drop handler** (`FilesPanel.tree.tsx` has `onDragStart` only).

### F-4 Desktop bridge

- `getFilePath` (`webUtils.getPathForFile`) is at `apps/desktop/src/preload.ts:206`.
  `pickFolder` is at `:207`, and `showItemInFolder` at `:225` (channel `main.channels.ts:24`).
- Handlers are registered through `authorizedHandle(…, BROAD_RENDERER_ROLES, …)`.
- `ipcHandlers.ts` is 332 lines long, so new handlers belong in a new
  `window/ipcHandlers.transfer.ts`, following `ipcHandlers.fileAccess.ts` and `shellPathHandlers.ts`.

### F-5 Window scope

- `isBoundBackendWindow()` (`apps/web/src/rpc/backendScope.state.ts:66`) is true for windows
  bound to a remote backend. In those windows the server is not on the user's computer.

### F-6 Local binary packaging

- The packaged server ships `dist/workspace-agent/<platform>-<arch>/bigbud-remote-agent`
  (`apps/server/scripts/workspaceAgent.ts:19-26`). It is resolved at runtime by
  `localWorkspaceWatchAgent.binary.ts`, which supports an env override, the packaged path and
  `target/debug`.
- The packaged binary is smoke-tested by `scripts/verify-packaged-workspace-agent.ts`
  (`.github/workflows/release-desktop-build.yml:212-222`).
- The macOS architecture audit is `verify:desktop:mac-architecture`.

### F-7 Remote binary staging precedent

- `buildRemoteAgentInstallScript` (`remoteAgentInstall.ts:200-224`) stages the agent binary:
  - it uploads base64 on stdin into a `mktemp` file;
  - it checks the size and `sha256sum`, then runs `chmod 700`;
  - it publishes with a no-clobber `ln` and verifies an existing target.
- The script runs through `runSshCommand` with `sh -lc` and a 60 s timeout (`:237-266`).

### F-8 Local binary staging and GC precedent (read-only reference)

- `stageLocalTerminalHostBinary` and `collectLocalTerminalHostRuntimes`
  (`apps/server/src/terminal-host/localTerminalHost.binary.ts:112-188`) are the pattern:
  - content-addressed directories;
  - `0700` permissions;
  - re-verification before use;
  - removing only directories that match the expected naming.
- Its helpers live in `localTerminalHost.fs.ts`, which is off limits now (F-15).

### F-9 Process control

- `killProcessTree` (`apps/server/src/utils/killProcessTree.ts:32`) handles Windows with
  `taskkill`; on POSIX it signals only the pid.
- Detached process-group spawns already exist, for example in
  `apps/server/src/provider/acp/AcpSessionRuntime.ts:167` and `utils/open.launch.ts`.

### F-10 UI building blocks

- `toastManager` with `add`, `update` and `close` (`apps/web/src/components/ui/toast.manager.ts`).
- `DownloadProgress` (`components/common/DownloadProgress.tsx`), which already uses
  `bg-info`, `text-xs` and an accessible progress role.

### F-11 Settings

- Server-owned settings are composed in `packages/contracts/src/core/settings.ts:316`, which is
  343 lines long. The paste fields live in `settings.terminalPaste.ts`.
- The UI for them is `apps/web/src/components/settings/TerminalPasteSettings.tsx`, mounted from
  `TerminalSettingsSection.tsx:147`.

### F-12 Streaming RPC precedent

- Streaming RPCs are declared with `stream: true` (`packages/contracts/src/server/rpc.search.ts:15-20`).
- Method names live in `packages/contracts/src/constants/websocket.constant.ts`.
- Handlers live in `apps/server/src/ws/wsRpcHandlers.*.ts`.

### F-13 Agent capabilities

- Capabilities are listed in `crates/bigbud-remote-agent/src/session/hello.rs:43-77`. Only the versioned built-in agent fallback adds a new transfer capability; bundled rsync over permitted ordinary SSH does not require that capability.
- Current rsync over Direct SSH does not depend on agent transfer capabilities. Agent fallback is a new version-negotiated protocol; an older agent without it keeps existing session behavior but transfer returns a typed update/reconnect compatibility error. Never assume old-agent recursive fallback.

### F-14 Install inventory rules

- The install inventory scans only `~/.bigbud/agent/bin` and `~/.bigbud/agent/staging`
  (`remoteAgentUpdate.inventory.ts:199-200`).
- An unknown executable there marks the host `unknownOwner` and can block installs.
- Remove deletes `~/.bigbud/agent` only (install plan, decision 10).
- So **the rsync companion must live outside `~/.bigbud/agent`**. This plan uses
  `~/.bigbud/tools/rsync/`.

### F-15 Current concurrent ownership and worktree (re-baselined at `c7724dddd8`)

- At `dev` / `c7724dddd8` (2026-11-22, revision 7.8), `git status` shows **only this plan** as
  untracked. The in-flight terminal files listed in revision 7.7 have been committed.
- Earlier baselines: `73cde5bf18`, `a494f2d63c` and `3c9670e3a3`.
- Terminal-owner spawn-site rows (for example `Manager.remoteHosts.ts` and
  `Manager.remote-inspection.ts`) still need coordination during the prerequisite SSH cutover, not this transfer implementation.
- **The peer still owns** terminal, deletion and capabilities work. The terminal lifecycle plan is
  still active (Q1 fidelity results were recorded in `73cde5bf18`). Re-check `git status` and the
  terminal plan before each milestone.
- Do not change `terminal-host/`, `DirectShellLaunch*`, `Manager.*remote*`, `OwnedPtyRuntime*`, or
  remote-agent terminal or persistence surfaces without their owners' approval.
- Serialize `docs/COMMANDS.md` and `justfile` with the terminal plan.
- `TerminalSettingsSection.tsx`, `Manager.pasteStaging.attach.ts` and the paste-staging agent
  files are shared surfaces. They are edited only by their owner in the shared-file owner table,
  and only after confirming with the terminal owner.
- `wsRpcContext.ts` is shared: prefer a module-level transfer registry so it needs no edit.
- Keep the `privateFiles` helpers read-only; no speculative helper move.

### F-17 Server composition and modes

- `ServerConfig.mode` is `"web" | "desktop" | "remote"` (`apps/server/src/startup/config.ts:21`). `profileLayer(local, remote)` in `apps/server/src/server.profile.ts` treats both desktop and web as local; it is not a desktop-only selector. `RuntimeDependenciesLive` in `apps/server/src/server.ts` composes `TerminalLayerLive` and `WorkspaceLayerLive`.
- Compose `TransferManagerLive` only for `ServerConfig.mode === "desktop"` in `apps/server/src/server.profile.ts` / `apps/server/src/server.ts`, alongside `TerminalLayerLive` and `WorkspaceLayerLive`; provide typed unavailable services in `web` and `remote` modes. Do not insert the manager in `apps/server/src/remote-agent/remoteAgentServerLayer.ts`; that is the remote-agent/workspace layer and wrong profile/lifecycle boundary.
- WS routes are declared via `WsRpcGroup` in `apps/server/src/ws/ws.ts`, with handlers supplied from the server composition. Follow its existing patterns only after verifying the exact route/authority path and peer provenance; do not use a broad role registration for transfer IPC.

### F-16 Test gating conventions

- Docker-backed Linux tests run when `BIGBUD_TEST_LINUX_DOCKER === "1"`
  (`remoteAgentUpgrade.linux.fixtures.ts:8-10`), with `describe.runIf(...)`.
- Opt-in integration tests use `process.env.BIGBUD_<NAME>_IT === "1"`
  (`localTerminalHost.it.test.ts:29`).
- The Rust live tests skip when their env var is unset (`os_index/locate.live.tests.rs:79-80`).
- Server tests are serial (`apps/server/vitest.config.ts`).

## Design

### 1. Platform and transport support matrix (verified baseline)

Observed from `.github/workflows/release-desktop-build.yml`, `.github/workflows/release-remote-agent-build.yml`, `.github/workflows/release.yml`, and `scripts/lib/release-assets.ts` at the inspected commit. The release assembly verifies the six local workspace-agent sidecars separately from the four Linux SSH remote-agent targets. Recheck final assembled release manifests/assets before launch; do not widen SSH support based on local sidecar compilation alone.

| Local desktop release target | Desktop arch | SSH remote-agent release/update targets | Direct SSH POSIX targets in scope              | Preferred route / fallback                                                                                                                |
| ---------------------------- | ------------ | --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| macOS                        | arm64        | Linux x86_64/arm64, glibc/musl          | macOS x64/arm64; Linux x86_64/arm64 glibc/musl | Signed/notarized local bundled rsync; automatically stage matched remote bundle; agent stream or transient Direct SSH fallback            |
| macOS                        | x64          | Linux x86_64/arm64, glibc/musl          | macOS x64/arm64; Linux x86_64/arm64 glibc/musl | Same; local Darwin binary must be universal or exact arch-specific signed/notarized payload                                               |
| Linux                        | x64          | Linux x86_64/arm64, glibc/musl          | macOS x64/arm64; Linux x86_64/arm64 glibc/musl | Bundled local Linux x64 rsync; stage matched remote bundle; agent stream or transient Direct SSH fallback                                 |
| Windows 10 22H2 and 11       | x64          | Linux x86_64/arm64, glibc/musl          | macOS x64/arm64; Linux x86_64/arm64 glibc/musl | Key: Cygwin rsync after W0/W1, else built-in. Password: built-in only when the SSH owner advertises support, with >10 MiB upload progress |

Windows 11 on arm64 runs the x64 app under emulation. **Windows 10** is a supported desktop (it is advertised on the download page). Its inbox OpenSSH 8.1p1 uses the U5 legacy askpass trigger for password hosts.

The release assembly also publishes six `server-workspace-agent-*` local server sidecars, verified by `scripts/lib/release-assets.ts` and its tests: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`, and `win32-arm64`. These binaries are local packaged workspace-agent assets, **not** the SSH remote-agent install/update target set. The SSH remote-agent builder and signed manifests publish `bigbud-remote-agent` Linux triples only: x86_64 and aarch64, glibc and musl. Do not infer that an SSH remote Windows/macOS agent is supported from the local sidecar matrix. Mac remote hosts are in scope through explicitly tested POSIX Direct SSH; remote-agent Mac/Windows targets require a future release-manifest change and are not claimed here.

Stock Windows OpenSSH and forced-command accounts are not assumed to provide `sh`, POSIX paths, shell quoting or arbitrary command execution. They are supported only if a compatible bigbud protocol endpoint is available and tested; otherwise the host pairing is explicitly unsupported. No system rsync or extra user setup is permitted for supported pairs.

**Pairwise release proof:** CI and packaged real-host tests enumerate each local desktop target against each released remote-agent Linux target. Tests separately cover Direct SSH POSIX hosts and the unsupported/compatible Windows and forced-command cases. A pair passes only after proving bundled executable selection and remote staging/probe on rsync-eligible rows (zero rsync attempts on Windows password rows), recursive upload and download, fallback both directions when staging is disabled/unavailable, progress, cancellation and cleanup. No row may use `which rsync`, `command -v rsync`, PATH lookup or an unowned rsync binary.

### 2. Architecture and data flow

**TypeScript owns product authorization and user intent. Rust owns all SSH policy/execution and all transfer execution/outcomes.** These are two distinct responsibilities: the local SSH owner controls the connection and child lifetime; the local transfer worker owns route selection, file I/O, publication, cancellation outcome and reconciliation. `TransferManagerLive` is a desktop-only TS control adapter, never an SSH launcher or second transfer engine.

| Owner                               | Responsibility                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop main + TypeScript server    | Verify caller, peer and scoped grants. Forward admitted start/cancel/status requests and display Rust snapshots. Never prepare SSH arguments or environment, decide host trust, launch SSH, process file chunks or infer terminal results.                                |
| Local Rust SSH owner (prerequisite) | Admit the target/generation, enforce trust/auth/session budget, open and reap SSH channels, and supervise a packaged rsync launch that delegates to its allowlisted SSH child. Return scoped native data/control handles, never SSH credentials or a generic launch spec. |
| Local Rust transfer worker          | Choose an eligible route from owner capabilities; request admitted channels, operate their streams, build manifests, verify and publish entries, and journal cancellation, cleanup and outcomes. No independent SSH process, auth or reconnect loop.                      |
| Remote endpoint                     | Run the verified rsync binary, negotiated Rust agent transfer endpoint, or setup-free POSIX shell helper. Report receiver-side verification and publication evidence; the local worker alone reconciles it into the user-visible result.                                  |

```text
Renderer → desktop main / TS server (intent and grant)
                       ↕ private control IPC: start / cancel / status; bounded snapshots
                  Local Rust transfer worker → scoped opens via Rust SSH owner
                    ├─ bundled rsync ↔ SSH ↔ remote rsync
                    ├─ worker-owned transfer channel ↔ Rust remote agent
                    └─ worker-owned SSH stdin/stdout ↔ POSIX helper
```

**No bulk data in TypeScript.** For rsync, the child processes carry the bytes; for the two built-in routes the worker reads/writes the streams directly. Qualify a dedicated agent data channel instead of forwarding its frames through the existing JS agent connection. Charge it to the same host budget as other transfer sessions and reserve interactive capacity. If it cannot be opened safely, queue or return the existing typed capacity/capability error; do not silently relay bytes through TypeScript. Send coalesced progress, not an IPC message for each chunk.

**One operation, one outcome.** The existing `transferId` is the operation ID across TS, the worker and the receiver. Duplicate authorized `start(id)` with the same request returns the known status; reject changed parameters for that ID. Repeated `cancel(id)` requests are harmless: cancellation is a request, not a terminal result. Before each independently publishable entry, durably record its intended final name and identity; record the commit evidence afterward. A cancellation before publication prevents that entry from landing; if publication wins, report that entry as committed and never undo it. A partial multi-entry result lists what landed.

**Reconciliation is not byte-stream resume.** On lost publication acknowledgement or worker restart, report `reconciling`. Check the journal and destination using operation-bound evidence, not filename or size alone. If the result cannot be proved, report `outcomeUnknown`; do not repeat publication, allocate a suffix, erase the evidence, or enable retry for that entry. On TS restart, reauthorize the observer and reattach with `status(id)`, not a new start. An explicit authorized retry may restart only entries proved uncommitted in a clean stage. Restart never restores grants or passwords.

**Two implementation gates:** (1) Before building out the agent route, transfer a large file on a worker-owned channel with a live terminal under the §4 session budget. Trace zero file payloads on TS IPC and verify interactive input/output stays responsive against a recorded idle baseline. (2) Before release, inject cancel, disconnect and process loss immediately before publication and after publication but before acknowledgement. Reattach by the same ID; verify results per entry, including `outcomeUnknown` when evidence is missing, with zero duplicate publications or overwrites.

The local Rust worker chooses only a binary from its server-owned packaged cache and an exact remote bundle it staged and hash-verified. It never resolves `rsync` from PATH, Homebrew, Cygwin outside the app, or a user-provided location. Missing local bundle fails closed for the rsync route and selects the built-in fallback where available.

The two transports share a canonical relative-path manifest, limits, conflict/collision policy, progress contract, cancellation, final verification and cleanup. Fallback uses bounded streaming chunks, per-file authoritative size and digest, recursive directory entries, symlink policy, and temporary files/directories under a private per-transfer root. It validates the completed manifest before publishing. Final publication is atomic only when source/destination are on the same filesystem and the platform's rename guarantees have been tested; otherwise it copies into a destination-side temp object, flushes, verifies, then renames without exposing partial final names.

**Routing rule (all operation × entry-kind × size combinations):** operation is upload or download; kind is regular file or recursive directory; size is compared with 10 MiB for progress presentation, not transport eligibility or a feature cap. First exclude rsync for Windows password targets before any resolver, staging, or capability probe. For every other combination, choose verified bundled GNU rsync when local+remote payloads are available and the target permits the structured invocation; otherwise choose the setup-free recursive fallback (negotiated agent stream, or the qualified POSIX Direct SSH stream). No fallback to PATH rsync. Missing/incompatible transports yield a typed unsupported error and remedy. Small-tree upload and download use this same manager routing; they never go through the legacy single-file paste path. A small terminal file may continue the existing legacy staging behavior only where it remains behavior-compatible. Terminal drops routed through the manager land in `<home>/.bigbud/transfers/<scope>/<id>/` and are deleted on terminal close or restart, or after 24 h (§U3). `terminalPasteMaxFileMb` limits only the legacy stage path, never manager transfers. Conflicts follow §U1 at every entry point.

| Operation | Entry     | ≤10 MiB                                                | >10 MiB                         | Route availability rule                |
| --------- | --------- | ------------------------------------------------------ | ------------------------------- | -------------------------------------- |
| Upload    | file      | same engine selection; legacy terminal exception above | same engine; show byte progress | eligible verified rsync, else built-in |
| Upload    | directory | same engine; enumerate recursive manifest              | same engine; show byte progress | eligible verified rsync, else built-in |
| Download  | file      | same engine selection                                  | same engine; show byte progress | eligible verified rsync, else built-in |
| Download  | directory | same engine; enumerate recursive manifest              | same engine; show byte progress | eligible verified rsync, else built-in |

### 3. Upload and download behavior

- Finder/Explorer/Linux file-manager drops and file-tree drops support files and recursive folders. Classify native paths with desktop-main `lstat`/stat IPC; never trust a browser `File` shape or drag-entry hint for authorization.
- Upload source files are revalidated on the server and remote side. Reject symlinks and special files unless an explicitly reviewed policy is later added. Preserve relative paths and apply case-folding plus Unicode-normalization collision checks before transfer.
- Terminal upload delivers the resulting remote path only if the terminal identity/generation remains the same and the user has not typed since; otherwise offer an explicit “Paste path” action. Small Direct SSH terminal drops use the manager routing rule above whenever paste staging is unavailable. Manager-routed terminal drops ignore `terminalPasteMaxFileMb`, land in `<home>/.bigbud/transfers/<scope>/<id>/<n>/<basename>` (0700) and are removed on close or restart, or after 24 h (§U3, GC in M7). Do not retain retry artifacts in workspace staging.
- Download/save-as support individual files and directory trees. Native drag-out uses native file promises/virtual files when the platform supports it; otherwise the existing fallback chain (quick fetch, tray drag, Download/Save as) remains available. Windows fallback must be quiet, clear, non-blocking to other platforms, and report why native delivery was unavailable.
- Transfers over 10 MiB show byte progress, rate and ETA when computable, on both rsync and fallback paths and both directions. Fallback upload reports acknowledged/sent bytes, not just completed chunks; final completion is separately confirmed.

### 4. Bundled rsync staging, process and protocol behavior

- Pin GNU rsync version and source checksums in the existing transfer-tool pin source. Package and resolve by desktop target, CPU architecture and remote OS/ABI. Include desktop-local executables plus remote Linux release targets and Direct SSH macOS x64/arm64 remote payloads.
- **macOS payload (settled): one universal binary.** M1 builds the arm64 and x86_64 slices from the same pinned source and patch, joins them with `lipo -create`, signs the result with hardened runtime, and notarizes it once. The same file is the local rsync in both macOS desktop apps and the payload staged to macOS remotes of either architecture. Verification (M1, release proof):
  - Built with `MACOSX_DEPLOYMENT_TARGET` equal to the app's minimum macOS (Electron 40's floor,
    recorded in `rsync.pins.ts`).
  - `lipo -archs` reports exactly `x86_64 arm64`, and `otool -L` lists only system libraries.
  - `codesign --verify --strict` passes, and `codesign -d --verbose` shows the hardened-runtime
    flag (`flags=0x10000(runtime)`).
  - It is **notarized as part of the app**: the app bundle is notarized and stapled. A bare Mach-O
    cannot be stapled, so there are no `spctl` or stapling checks on the binary itself. The copy
    staged to macOS remotes travels over ssh, carries no quarantine attribute, and needs only a
    valid signature.
  - Each slice runs `--version` natively in CI (the arm64 runner, plus the x64 runner or Rosetta).
- **Linux payloads:** static musl builds verified with `file` ("statically linked") and `ldd`
  ("not a dynamic executable"). Remote-agent **glibc** triples are transitional: the agent
  workflow ships them for one transition release (`release-remote-agent-build.yml`, matrix
  comment). rsync ships musl only and runs on glibc hosts too.

  This was chosen over per-architecture payloads because it gives one artifact to sign and audit, no runtime architecture selection for remotes, and the cost is only about 1–2 MB.

- Stage remote executable to a private bigbud-owned tool directory using only bigbud's signed/verified payload; check exact hash, executable identity and target. Never run a discovered system copy. Stage lazily, but stage automatically and synchronously before a caller can start a transfer; APIs that promise synchronous availability must fail fast if the package is not already cached.
- Use `--info=progress2` for aggregate progress only. For rsync per-file completion hints, use the pinned build’s `--out-format` with `%b` (for example `%i %b %n`); never interpret an early `%i %n` line or aggregate progress as completion. Capture a slow-transfer fixture on each supported target that records the early line, post-transfer `%b` line, and temporary-to-final rename order. A hint may trigger a check, but publication is allowed only once both the post-transfer hint and final-file verification have occurred, in either order. If a target cannot prove that boundary, publish only after successful rsync exit and final verification; if that cannot support native asynchronous drag on that target, use the cached-file/tray fallback. The authoritative completion rule is: regular file beneath the private per-transfer root, no symlink, expected manifest identity, exact expected size and rsync-reported verified completion bound to that manifest identity. Same-size stale files must never be accepted. Do not perform a second full-file hash pass on large rsync transfers; any independent digest must be streamed during transfer or reused from a verified result. A private random per-transfer directory and an opaque file identity bind the output; no guessed basename lookup.
- Avoid hashing huge rsync transfers twice. Pin and document the integrity policy: rsync's transfer checksum plus authoritative completed-file size and identity is the baseline; any independent digest must be streamed during one pass or reused from a verified transfer result, never a second full read without a measured/approved reason. Built-in fallback always computes a streaming digest while receiving and verifies it before publication. Fault-injection tests corrupt bytes and prove rejection.
- Normalize legacy `ssh:user@host` inputs before parsing/validation. Include user@host and IPv6 literals in target parsing tests. Keep SSH arguments structured and safely quoted; don't depend on implicit shell behavior.
- **One SSH owner on all platforms:** request native leases and scoped data handles from the S4 contract. POSIX password channels reuse the owner's master. Windows password channels require the owner's qualified direct-SSH binding; rsync is ineligible. No second askpass broker, TS password cache, executable resolver, monitor or reconnect controller is implemented here. Observe target-generation changes; stale transport events never authorize a publish or reopen a session.

- The direct SSH and remote-agent paths share the engine only above transport adapters. Remote-agent protocol additions are versioned and capability-negotiated. Old agent: for rsync-eligible target/auth combinations only, the bundled-rsync route remains independent of the new agent transfer capability when ordinary structured SSH staging is supported and verified. Only built-in agent fallback requires the new negotiated capability; without it return a typed “update/reconnect agent” transfer error, preserve the existing session and never use PATH rsync. Forced-command endpoints: use a compatible bigbud protocol endpoint only; never assume arbitrary command mode.

**rsync invocation contract (settled; the Rust worker’s rsync argv builder produces exactly this, and unit tests pin it).**

- **Local spawn:** an argument vector with `shell: false`, run from the bundled path only by the SSH owner under a transfer-scoped process-tree lease.
- **Environment: the ssh client environment, minus rsync-affecting variables.**
  - The SSH owner supplies the qualified client environment, preserving the existing SSH agent socket, HOME and PATH required by permitted ProxyCommands. The transfer-specific environment removes every `RSYNC_*` variable and `CVSIGNORE`, sets `LC_ALL=C`, and on Windows replaces inherited `CYGWIN` with `noglob`
    (replacing any inherited value). On Windows build this environment only for key-auth targets: clear inherited `BIGBUD_ASKPASS*`, `SSH_ASKPASS`, and `SSH_ASKPASS_REQUIRE`; use non-interactive SSH. No password/trust grant, registration or broker address goes to rsync. Test with deliberately contaminated parent env and pin the `-e` argv round trip.
  - Tests:
    - injected `RSYNC_RSH`, `RSYNC_PARTIAL_DIR` and `RSYNC_OLD_ARGS` never reach the child;
    - a `ProxyCommand` that needs a custom `PATH` entry still works;
    - an `ensureSshAgentEnv` socket reaches ssh.
- **The SSH executable:** only the native SSH owner resolves the approved absolute system executable and supplies the SSH portion of `-e`. It launches the verified packaged rsync process tree under the admitted target lease. The worker supplies validated transfer operands; it cannot substitute an executable, SSH environment, host, or auth options. Pin the argv round trip in the real bundle.
- **Flags (baseline argv):**
  - **no `--recursive`**, with `--files-from=- --from0`. Every entry is written as
    **`./<relpath>`**, with **no trailing slash** on directories. The `./` prefix stops the local
    sender from treating names that start with `#` or `;` as comments (rsync `flist.c:2764-2768`
    drops them even with `--from0`). A trailing `/` would send a directory's contents. Tests cover
    `#a`, `;b`, an empty directory and a name with a trailing space. In rsync 3.5.2, `-r` together with
    `--files-from` copies the **whole subtree** of every listed directory (rsync.1). The server
    instead writes the validated manifest to rsync's stdin, NUL-separated: **every file and every
    directory, including empty directories**. rsync's `--files-from` implies `-R` (relative paths)
    and `--dirs`, so it creates exactly the listed directories and transfers exactly the listed
    files. Changes made after the scan cannot add entries. A test lists a directory whose remote
    copy gained an extra file after the scan, and asserts the extra file is not transferred;
  - `--times`, `--perms --chmod=ug-s,o-w` (on Windows, `--no-perms --chmod=ugo=rwX`);
  - `--no-links` and `--no-specials --no-devices` (symlinks and special files are excluded and
    counted, per §3);
  - `--secluded-args`;
  - `--info=progress2`;
  - `--no-h` (`--no-human-readable`, so 3.5.2's human-readable defaults never change parsing),
    also on `--list-only`;
  - `--out-format=%i %b %n` with **`--8-bit-output`** (`-8`). This stops most high-bit bytes
    being escaped, but under `LC_ALL=C` bytes 0x80–0x9F (and control characters) are **still**
    printed as `\#ooo`, so the parser always decodes them. Matching is by decoded relative path. The `%n` parser splits each line into exactly two leading fields (`%i`, then `%b`) and
    the rest (`%n`), strips one trailing `/` (directories), and decodes only `\#ooo` escapes.
    Completion lines are matched to manifest entries by decoded relative path, and an unmatched
    line is an error. Tests cover UTF-8, NFD, spaces, a leading space and control-character
    names;
  - **no `--partial-dir`** (and no `--partial`). An absolute partial directory outside the stage
    would be refused under `--confine-root` (rsync 3.5.2 `util1.c:1609-1613`, where
    `handle_partial_dir` resolves it as an operator path), and `--partial-dir` implies `--partial`.
    rsync writes each file to its own temporary name **inside the stage** and renames it when
    complete; an interrupted file's temporary is removed by rsync or with the stage. A test
    interrupts a transfer with `--confine-root` active and asserts nothing exists outside the
    stage;
  - `--timeout=60`.
  - Never `--inplace`, `--append`, `-L`/`--copy-links`, `-K` or `--delete`.
- **Remote command through `--rsync-path`:** the string
  `/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C '<abs staged rsync>' --confine-root='<root>'`.
  - The remote shell parses it, so it is POSIX single-quoted.
  - It carries `--confine-root` (M1 verifies the pinned 3.5.2 provides it) to the **remote** rsync
    itself, because that option does not propagate from the client's argv.
  - **Physical paths:** `--confine-root` is enforced against the **physical** working directory
    (rsync `syscall.c`), so a lexically normalised path breaks under a symlinked ancestor (macOS
    `/tmp` and `/var`, or a symlinked home). Every confine root and stage root is therefore
    resolved first: `fs.realpath` locally, and `cd -P -- "$x" && pwd -P` remotely. **The same
    resolved string** is used as the rsync destination or source root. Test: a stage under macOS
    `/tmp` works with confinement active.
  - **What it does:** it bounds the paths rsync is asked to operate on: the operator arguments and
    the `--files-from` list. It does not sanitise names the receiver gets from the protocol. That
    is still the job of the private stage, `--no-links`, and the stage-versus-manifest check.
  - **Per direction:**
    - **download** (the remote is the **sender**): `<root>` is the validated, canonical source
      root. This is where it adds real value: a tampered `--files-from` list cannot reach outside
      the workspace;
    - **upload** (the remote is the receiver): `<root>` is the private stage root. This is limited
      defence in depth on top of the stage;
    - on downloads, the **local** receiver also gets `--confine-root=<local private stage root>`.
  - **It is mandatory when available**, not optional. Tests cover both directions: the option
    appears in the remote argv, a `--files-from` entry outside the root is refused, and
    confinement of received names still holds with the option removed.
  - The staged path and home must be absolute and free of control characters; otherwise the
    verdict is `unsupported-path`.
- **Remote shell `-e`:** one string built by `encodeRsyncRemoteShell(argv)`, following rsync's own
  tokenizer (`main.c` `do_cmd`):
  - it splits only on the space character;
  - inside a quoted run, a doubled quote is one literal quote;
  - every token is single-quoted, with `'` written as `''`;
  - tokens containing control characters, tabs or newlines are rejected;
  - `shellEscapePosix` is never used here.

  The argv is the resolved ssh executable, then the native owner’s approved transport options (with the `ControlPath` for
  POSIX password hosts), then `-l <user>` **only when the target has a user**, then a final `--`. rsync is then given `host:path` only, never `user@host`, so rsync
  appends no `-l` after the `-e` argv. Hosts starting with `-`, or containing whitespace, `@`, `/`,
  quotes or control characters, are rejected, and IPv6 literals are bracketed. Round-trip tests
  run the pinned rsync with a fake `ssh` that records its argv.

- **popt:** the pinned build patches out the client's `poptReadDefaultConfig`, so `/etc/popt` and
  `~/.popt` aliases cannot add options. CI asserts the call is absent.
- **Stage check before publication:** after rsync exits 0, the server walks the private stage
  without following links. It requires exactly the manifest's entries: the same count, each
  relative path present, the same type, and each file's exact size. Anything extra, missing or
  different fails the transfer, and nothing is published.
- **Cygwin (Windows):**
  - **Layout:** `transfer-tools/rsync/win32-x64/rsync/bin/{rsync.exe,cygwin1.dll,…}` and
    `transfer-tools/rsync/win32-x64/rsync/etc/fstab`. Cygwin finds `etc/` relative to the DLL's
    `bin/` parent.
  - **argv encoding:** Cygwin rebuilds `argv` from the Windows command line itself (`dcrt0.cc`,
    `build_argv`). With `CYGWIN=noglob`, only `"` quotes, and there is no `\"` escape.
    - So rsync.exe is spawned with **`windowsVerbatimArguments: true`**, and a Cygwin-specific
      encoder wraps every argument in `"…"`. That includes **argv0**: with verbatim arguments,
      Node writes argv0 unquoted and Cygwin would re-split a path containing a space. So the spawn
      passes `argv0` explicitly, encoded as `"<path to rsync.exe>"`.
    - The encoder **rejects** any argument containing `"` or a control character. A quoted
      leading `@` is never expanded as a response file, but the encoder still rejects a leading
      `@` for defence in depth. Remote roots or names containing `"` are rejected on Windows with
      `unsupportedPath`.
    - A W0 test installs the app under a path **with a space** (`C:\Program Files\bigbud …`) and
      runs rsync through it.
    - A W0 round-trip test runs through the real `cygwin1.dll`, with a tiny Cygwin test program
      that echoes its argv. It covers spaces, `'`, `\`, `*`, `?`, `[`, a trailing backslash and
      UTF-8.
  - the bundle ships `etc/fstab` with `none /cygdrive cygdrive binary,noacl,posix=0,user 0 0`;
  - a W1 test checks that published files inherit the parent folder's ACL (`icacls` shows only
    inherited entries);
  - the argv builder **asserts that no argv element starts with `@`**, because the Cygwin runtime
    expands `@file` response-file arguments. Paths that would start with `@` are always passed as
    absolute `/cygdrive/...` paths, and the relative manifest goes through `--files-from` on stdin.
- **Progress fixture:** the Rust worker parses 3.5.2's `progress2` output, including the `B`
  and `B/s` units that 3.5.2 prints with `--no-h`. A fixture captured from the pinned 3.5.2 covers
  this.
- Define source and destination root semantics, and ensure each side receives an explicit
  manifest root. Add target and host validation, argument-injection and environment tests.

Remote rsync staging is content-addressed and no-clobber: derive a private path from validated target identity and pinned digest, parse/validate the remote home, verify with a qualified platform SHA tool, compare existing bytes before reuse, then atomically publish. Probe only the exact staged absolute executable with `--version`, require exact GNU rsync 3.5.2 identity and matching pinned digest for the resolved OS/architecture/ABI, and verify output format per host fixture; never use `which`, `command -v`, PATH search or a system executable. Cover Darwin `shasum`/BSD utilities and Linux `sha256sum` only after verifying their output/availability in target fixtures. Track active transfer leases across desktops before GC; use a lock/lease or equivalent so one desktop cannot collect a bundle another process is using. Retain glibc/musl and architecture-specific payload selection only for release-supported targets.

**Fallback execution.** The agent fallback uses a separately negotiated worker-owned agent transfer channel (§2), never the TS-managed `--proxy` stream used for PTY/control traffic; each data frame is at most 256 KiB, has bounded credit/backpressure and cancellation, and cannot monopolize control/PTY traffic. Test concurrent transfers, fairness/latency under PTY load, credit exhaustion, disconnect, partial frames and legacy-session compatibility. Direct SSH POSIX fallback is a one-shot, self-contained executable protocol over structured SSH stdin/stdout.

**Settled mechanism: framed records read with `dd` loops for small files, one channel per large file.**

Exact-count `head -c` on a shared stdin **loses data**:

- macOS `/usr/bin/head -c 10` read 65,536 bytes from a pipe;
- `printf abcdefghij | (head -c 3; cat)` left `cat` with nothing;
- busybox `head` reads through stdio buffers.

`dd` with an explicit block size performs single `read(2)` calls and does not read ahead. The
reviewer verified exact framing of three back-to-back files on BSD. Tar and pax stay rejected.

- **Small files** (below 8 MiB) share one channel as framed records. The `put-batch` script (a
  fixed `clean-posix` script using the §7 home prelude) loops:
  1. `IFS= read -r header`. The shell `read` builtin reads a pipe one byte at a time. The header is
     `F <k> <size> <b64 relpath>` or `D <b64 relpath>`.
  2. For `F`, first create the part exclusively with `set -C; : > "$part"; set +C`, so 0-byte files
     exist and a name clash fails. Then start the hasher **once per file**:
     `mkfifo "$fifo"; sha256sum < "$fifo" > "$h" &` (or `shasum -a 256`), then
     **`exec 3>"$fifo"`**, so one writer stays open for the whole file.
  3. Set `remaining=<size>`, then loop until `remaining` is 0:

     ```sh
     before=$(wc -c < "$part")
     dd bs="$remaining" count=1 2>/dev/null | tee -a "$part" >&3
     after=$(wc -c < "$part")
     got=$((after - before))
     [ "$got" -gt 0 ] || fail eof        # EOF before the count is an error
     remaining=$((remaining - got))
     ```

     A short read just loops.

     A new `tee` per `dd` read would otherwise **close the FIFO's writer** after the first chunk,
     so the hash would cover only that chunk and the next `tee` would block (verified locally).
     Holding fd 3 open prevents both.

  4. `exec 3>&-`, then `wait` for the hasher and read `$h`. There is no second read pass.
     Test: a 1 MiB file delivered in 16 KiB writes hashes correctly, on GNU, BSD and busybox.
  5. Print `OK <k> <size> <sha256>`. The local worker compares the digest with the one it computed while
     sending.

- **Large files** (8 MiB or more) each use their own channel, delimited by EOF and never counted
  from a shared stdin:
  - **upload:** `put <part>` runs `cat > "$1"`, hashing through `tee`, then prints
    `<size> <sha256>`;
  - **download:** `get <abs path>` prints the sentinel, then self-framed `C <n>` chunks and a
    `T <total> <sha256>` trailer (the same framing as `get-batch`, below). The server hashes while
    receiving and compares.
- **Small-file downloads: `get-batch`**, one channel, **self-framed chunks**. An exact-size read
  from an open fd is not portable: GNU and busybox `wc -c <&4` move fd 4 to EOF (macOS does not),
  reopening defeats the open-fd size, and a short read would desync length framing.
  - The script makes a private `mktemp -d` work directory, removed by a `trap`.
  - **Source trust boundary (POSIX Direct SSH shell downloads only):** use this fallback for
    source trees whose writers are trusted not to redirect reads during transfer. Before opening
    each file, require `[ -f "$p" ] && [ ! -L "$p" ]` and use `cd -P` to check that its parent
    resolves inside the canonical source root. After opening, re-check the file pathname before
    sending data. If a check detects an unsafe path, skip it with `unsafeSource`.
    These checks inspect names, not the opened file descriptor: a concurrent replacement can
    cause data outside the selected root to be read. This is not a sandbox for an untrusted
    writable source. Destination confinement and the other transports' requirements are unchanged.
  - For each file it opens `exec 4<"$path"`, takes the **listed size** from the server's manifest
    (not from a fresh `wc`), and prints `F <k> <listed size> <b64 relpath>`.
  - It then reads **at most the listed size** (`remaining=<listed size>`) in bounded chunks:
    ```sh
    while [ "$remaining" -gt 0 ]; do
      bs=$(( remaining < CHUNK ? remaining : CHUNK ))
      dd bs="$bs" count=1 <&4 > "$chunk" 2>/dev/null
      n=$(( $(wc -c < "$chunk") ))          # $(( )) strips macOS wc's leading padding
      [ "$n" -eq 0 ] && break               # shrank: total < listed
      printf 'C %d\n' "$n"
      cat "$chunk"; cat "$chunk" >&3        # stdout, and the single-writer hash FIFO
      remaining=$(( remaining - n ))
    done
    extra=$(( $(dd bs=1 count=1 <&4 2>/dev/null | wc -c) ))   # probe one byte: grew?
    ```
    `CHUNK` is 64 KiB for `get-batch` (small files). The large-file `get` uses **4 MiB**: at
    64 KiB a single-channel download measured about 5 MB/s, against near line rate at 4 MiB.
  - Then `exec 4<&-` and it prints `T <k> <total> <sha256> <extra>`. If `total` is less than the
    listed size (shrank) or `extra` is 1 (grew), the server reports `sourceChangedDuringTransfer`
    for that file and never publishes it.
  - All numeric fields are printed with `printf '%d'` after `$(( ))` normalisation. The server
    parser also tolerates surrounding whitespace.
  - **The local worker reads exactly `n` bytes after each `C` line**, so a file that shrinks or grows
    never desyncs the stream. It accepts the file only if `total` equals the listed size and the
    digest matches; otherwise it reports a typed `sourceChangedDuringTransfer` for that file.
  - `D` records carry directories.
  - Tests: shrink and growth during the send on GNU, BSD (macOS) and busybox; 10,000 small files
    on one channel; 0-byte files.
- **Large-file `get` framing:** the same bounded loop with **4 MiB** chunks, the one-byte growth
  probe, and the `T <total> <sha256> <extra>` trailer. There is no trailer-in-payload ambiguity.
  The local worker accepts the file only if `total` equals the listed size and `extra` is 0.
- **Read-side path tests** (GNU, BSD and busybox): after listing but before the pre-open checks,
  replace the file with a symlink or FIFO, or redirect its parent outside the root. Leave the
  replacement in place and assert `unsafeSource` with no payload for that entry. Separately,
  if a FIFO appears after the check and open blocks, require the channel timeout to terminate
  the operation. Neither test establishes confinement against concurrent pathname replacement.
- **Output sentinel:** every script prints a random per-call sentinel (`BBSENT-<128-bit hex>`, sent
  as an argument) before any payload or status line. The server discards everything before it, so
  stdout noise from shell rc files cannot corrupt framing.
- **Integrity basis:** SSH's transport MAC protects bytes in flight. Exact size plus a SHA-256
  computed during the single write or read pass protects against truncation and helper bugs.
  `verify-rename` compares the stored digest with the expected one; it does not re-read the file.
- **Directories and finalize:** directories come from `D` records (or a `mkdirs` batch). Finalize
  uses `verify-rename` batches (header lines only, read with `read -r`).
- **Channels and shared masters:**
  - **POSIX password host:** the existing `ControlPath` master is **shared** with terminals, the
    agent proxy and providers (`Manager.remote.ts:11-16`, `ShellProfiles.remote.launch.ts:91-105`,
    and `remoteAgentConnection.ts:144` through `buildSshCommandInvocation`). sshd's `MaxSessions`
    defaults to 10.
  - **Every ssh command a transfer makes runs inside its granted session budget, one after another:**
    staging, probe, lease, the free-space check, publish and cleanup. **Sweeps** (after Connect,
    after unlock, before terminal drops, and periodic) also take a session from the same per-master
    budget and wait their turn, so a sweep never pushes a shared master over `MaxSessions`. The remote transfer root is
    created **only after** the session is granted. On a shared password master, the rsync route
    takes **no** extra lease session; liveness there relies on quiescence alone, bounded by
    rsync's `--timeout=60`.
  - So there is **one per-master transfer session budget**, default **1**, configurable to **2**
    (`fileTransferSharedMasterChannels`). It is shared by **all** transfers to that master and by
    **both** routes: an rsync run uses one session for its whole run, and each fallback channel
    uses one. Further transfers queue in order. Small files are batched on the granted session,
    and large files wait their turn.
  - Test: 8 open terminals plus 3 queued transfers under `MaxSessions=10`. All terminals keep
    working, transfers run one at a time, and a new terminal still opens.
  - **POSIX key host:** an SSH-owner-managed master scoped to the transfer at most 4 channels. Its socket goes
    under the existing short `/tmp` `mkdtemp` root that `sshSession.ts:33-43` already uses, as
    `<root>/t-<12-hex>`, which keeps it below the Unix socket path limit.
  - **Windows:** no master; at most 2 concurrent connections per transfer. Small files are batched
    per connection, so **no file-count cap is needed**.
  - A refused session is a typed, retryable `maxSessions` error.
- **Path safety:** the local worker decodes and validates every relpath (no `..`, no absolute paths, no
  NUL) before sending. Each script re-checks with `case` patterns and `cd -P` confinement before
  every `mkdir`, write or rename.
- **Tests:**
  - three back-to-back records, including 0-byte, 1-byte and 7.9 MiB files, through the `dd` loop
    on GNU coreutils, BSD (macOS) and busybox arrive byte-exact;
  - large-file `put` and `get` with the trailer digest;
  - rc-file noise before the sentinel is ignored;
  - a corrupted record fails its digest;
  - cancel mid-record removes `.part-*` and closes the private master;
  - **opening a new terminal during a fallback transfer on a password host with `MaxSessions=10`
    still succeeds**.

The helper must prove path manifest confinement, bounded resource use, no extra installed tools,
and safe finalize and cleanup. It must never bypass `ForceCommand`; an endpoint that does not expose the compatible bigbud channel stays unsupported. Probe by exact supported shell/OS/arch and test that the selected helper starts, completes and is reaped. Do not claim one transport is implemented until those executable traces exist.

### 5. Remote fallback protocol and compatibility

The fallback is a first-class recursive transport, not a reduced file-only transfer. For agent targets, extend the remote-agent protocol with capability discovery, manifest/entry framing, bounded file chunks in both directions, per-file completion, cancellation, integrity result and safe finalize/cleanup messages. Add matching local Rust worker and remote Rust agent implementations in separate modules under established protocol ownership. Allocate the new capability/protocol method in the next available minor version after inspecting the current `protocol/remote-agent/v1.proto` definitions; do not reserve or assume a version range. Direct SSH rsync staging remains independent of agent transfer capability negotiation when ordinary SSH commands and staging are allowed; only the built-in agent fallback requires the new capability. For Direct SSH POSIX targets, M3 must add a one-shot helper protocol per the invocation constraints above; it creates only private per-transfer staging and never runs for stock Windows SSH or a forced-command endpoint unless that endpoint explicitly provides the compatible protocol. Agent data frames are at most 256 KiB and use bounded credit/backpressure. **Numeric limits (settled floors):**

| Limit                  | Value                                                                        |
| ---------------------- | ---------------------------------------------------------------------------- |
| Entries per transfer   | at least **100,000**                                                         |
| Depth                  | at least **128**                                                             |
| Per-file bytes         | unbounded except by free space                                               |
| Aggregate bytes        | **bounded only by free space** on both endpoints (plus 5 % headroom)         |
| Concurrent transfers   | 3 per target and 4 overall (plus the separate low-priority quick-fetch pool) |
| Manifest page size     | 2,000 entries per page                                                       |
| Agent fallback buffers | 4 MiB of in-flight credit per transfer                                       |

**Rule:** no limit may refuse a folder the user can list in the file tree. A tree beyond the entry
or depth floor is paged and transferred, not refused; only free space or a filesystem error can
stop it. These values are enforced in schema, producer and receiver. Enumerate/page the complete manifest rather than silently truncating at 10,000 entries. Check free space on both endpoints before staging/publication and return typed quota/space/MaxSessions failures; probe SSH `MaxSessions` behavior and never retry resource failures as authentication or shell errors. Resume is not required for initial completion; disconnect leaves an indexed cleanup record and only entries proved uncommitted may retry from a clean owned stage (§2).

For protocol-version mismatch, negotiate feature support before opening a transfer. Existing agent versions that lack the new capability must continue existing terminal/session behavior unchanged, and transfers return a typed compatibility failure with an update/reconnect remedy; there is no silent unsafe downgrade. For forced-command SSH, the release test must establish whether an already-configured compatible bigbud endpoint exists. If not, that pairing is explicitly unsupported rather than represented as covered by the fallback. Add any required Direct SSH built-in transport/helper only as an explicit milestone with a concrete executable protocol and no extra user setup; do not ship a fallback that depends on installing a remote tool.

### 6. Security, authorization and local IPC

- Transfer IPC channels are registered only for the local desktop `main` role. Do not add them to `BROAD_RENDERER_ROLES`, remote-backend roles, forwarded requests, mobile routes, or generic renderer capabilities. Add denial tests for each forbidden route/role.
- **The single server-checked token is a one-use HMAC grant (settled).** There is no separate
  launch capability. There is also no per-window binding.
  - **Key:** desktop main generates a fresh 32-byte grant key **on every backend start**, and
    delivers it once through the fd-3 bootstrap envelope (`apps/desktop/src/backend/backendManager.ts:219,268`;
    `backendBootstrapEnvelope.ts`). A backend restart therefore invalidates every outstanding
    grant. The key never travels in the environment, argv, a URL, the renderer or a log.
  - **Grant:** main computes `HMAC-SHA256(key, LP("bigbud-transfer-grant-v1") ‖ LP(operation) ‖
LP(direction) ‖ LP(canonicalLocalPath) ‖ LP(targetId) ‖ LP(expiryUnixMs) ‖ LP(nonce128))`,
    where `LP(x)` is a 4-byte big-endian length followed by the UTF-8 bytes. Length prefixes make
    field boundaries unambiguous.
  - The grant (the fields plus the MAC) is returned to the requesting renderer, which may pass it
    through to the server unchanged. It is useless for any other path, operation or target, and
    expires after 10 minutes.
  - The server recomputes the MAC in constant time, checks expiry, and **consumes the nonce**
    (single use, with an in-memory set until expiry).
  - **There is no webContents binding.** The server cannot see `webContents.id`, because a WS
    connection carries no Electron identity (`ws.ts:130-160`), so that field is removed rather
    than pretended.
  - **Scope:** a destination grant covers the **parent directory plus the requested basename**.
    The worker may publish under that authorized basename or a U1 suffix of it (`name (2)`…) in the same
    parent, and nowhere else. Source grants (uploads) cover the exact canonical path the user
    dropped or picked.
  - **Drops:** for Finder and Explorer drops, desktop main stats the dropped native paths and
    issues the grant itself, for exactly the native paths of that drop. Only the local main role can
    mint grants, because only it holds the key. The threat model is remote and
    forwarded clients, which can never obtain a main-issued grant.
  - **Retry after the nonce is consumed:** a grant is consumed by `transfer.start`.
    - **Only after Rust proves the requested entries uncommitted** (§2), `transfer.retry` of the same `transferId` reuses the
      authorization kept **in server memory** with that transfer, for up to 24 h. It needs no new
      grant.
    - **After a backend restart,** that memory is gone, so a retry needs a **fresh grant for the
      same paths and target**.
    - Starting a **new** transfer always needs a new grant. Recovery is a status lookup, not permission to replay a consumed grant or start a replacement transfer.
  - **Grant fields for `transfer.removeHostFiles`:** operation `removeHostFiles`, direction `none`,
    `canonicalLocalPath` empty, `targetId` the host, plus the existing expiry and nonce. It is
    issued by main only after the user confirms the dialog.
  - **Multi-source drops:** one grant **per source path**, all from the same drop. `transfer.start`
    carries the list, and every grant must verify (same target, operation `upload`); one failure
    rejects the whole start.
  - **Every disk-touching call needs a grant:** `transfer.start` (local sources for uploads, local
    destinations for downloads, Save as, Downloads, native-drag promise paths) and
    `transfer.removeHostFiles`. `cache` destinations are server-chosen and need none.
  - Control calls (`watch`, `list`, `cancel`, `retry` subject to the retry rules above) take the unguessable 128-bit `transferId`,
    plus the peer checks below.
- **Header and peer rejection.** The server rejects any `transfer.*` call whose WebSocket upgrade:
  - came from a non-loopback `remoteAddress`;
  - carried any forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`,
    `X-Forwarded-Proto`, `X-Real-IP`, `Tailscale-User-*`); Tailscale Serve proxies from loopback
    and adds these headers;
  - arrived on `/mobile-ws` or the remote-client Unix socket router.

  These facts are captured once when `ws.ts` authorizes the connection, and stored on the
  connection context. Add denial tests for Tailscale/non-loopback binding, remote backend,
  forwarded routes, a replayed nonce, the wrong operation, direction or target, an expired grant,
  a grant from a previous backend start, and a tampered length prefix.

- Use a separate grant-returning picker API for transfer destinations; preserve existing picker response shape and existing consumers. Desktop main issues grants for exact canonical paths. The transfer service verifies only the grant (and the peer checks). Grants and the key are never returned in logs, event payloads, errors, telemetry, CLI output or persisted transfer history; redact them at boundaries.
- Follow the actual `provisionAuthority` per-route authorization pattern, not a new broad boolean. Verify WebSocket peer provenance (the header and peer rejection above) plus the one-use grant. The grant key is held only in desktop main and the server (delivered over fd 3), never in a renderer-readable global or the server environment.
- A server bound to non-loopback `BIGBUD_HOST` must fail closed for local-only transfer IPC unless equivalent authenticated, origin-bound protection is proven and tested. Forwarded and mobile routes remain denied.
- Server-side source and destination canonicalization, no-follow opens, ownership checks, path-root confinement, manifest collision checks and per-transfer isolation are mandatory. The sole exception to descriptor-based source confinement is the POSIX Direct SSH shell download: §4 defines its trusted-writer boundary and pathname checks. This exception does not apply to writes. On macOS, apply both case-folding and Unicode normalization collision detection; on Windows, separately prove NTFS case-insensitive path handling and reparse-point/symlink rejection. `--confine-root` is **mandatory when the pinned build provides it**. It is passed via `--rsync-path` to the remote side (the download sender: the source root; the upload receiver: the stage root) and in the local receiver's argv. It bounds operator and `--files-from` paths, not received names. Adversarial tests must still prove confinement of received names with it removed (§4).
- Workspace staging uses a distinct bigbud-owned directory name plus a private marker and indexed ownership manifest; only hide/clean a folder when marker, owner, transfer id, private directory identity and expected root all verify. Define visibility behavior per OS; hidden does not imply git-invisible. Never modify a user's git config, ignore files, repository attributes or workspace metadata. Never sweep arbitrary matching user paths or delete outside validated owned roots. The host-removal action lists both Direct SSH and agent execution targets, refuses while any target transfer is active, and deletes only the indexed owned rsync/staging artifacts after confirmation.

### 7. Lifecycle, cleanup and UX gates

- User Cancel has its own responsive kill budget, escalation and cancellation event. On the Rust owner’s durable, generation-fenced Disconnect, stop transfer admission and release the affected target’s leases before slower cleanup. The SSH owner terminates its transport trees and the worker stops its own local work within one concurrent 500 ms budget. It must do no network cleanup. **Remote cleanup for that target, including U3 terminal-drop stages released by a terminal close during Disconnect, is queued in the pending remote-cleanup queue**, because ssh cannot start once the disconnected guard is persisted (`wsRemoteConnection.ts:82-102`). For app quit, the observed path is Electron `before-quit` in `apps/desktop/src/main.quitTeardown.ts` → fd-5 quit hint/ack → `stopRuntime` in `apps/desktop/src/main.ts` → backend SIGTERM/SIGKILL window in `apps/desktop/src/backend/backendShutdown.ts` (8 s force-kill delay). The TS server forwards the scoped stop intent to Rust; the SSH owner terminates its transport trees, while only the transfer worker finalizes transfer outcomes. The server records the hint in `apps/server/src/lifecycle/AppQuitIntent.ts`; `apps/server/src/terminal/Layers/Manager.process.host.ts` runs `applyTerminalQuitPolicy` from `Manager.quitPolicy.ts` with its 3 s terminal-close deadline inside that backend window. Coordinate with the terminal owner to run transfer shutdown concurrently with that existing terminal policy under the 500 ms transfer budget; do not add an independently ordered finalizer that extends the window. The desktop's 1.5 s quit-hint ack and 10 s backend stop-wait timeout are separate outer handshake/exit bounds, not transfer or terminal budgets. Persist ownership before spawning; do no unbounded journal/network work during the 500 ms teardown. Verify wall-clock deadlines with terminal close in flight and at least four uncooperative transfer children.
- Best-effort remove workspace staging immediately on a failed/cancelled transfer while connected. Do not leave retry files there. On abrupt transport/server loss, preserve the Rust journal, commit evidence and indexed cleanup record; reconcile uncertain publications before cleanup can erase their evidence. After reconnect, retry idempotent remote cleanup asynchronously. Reap/verify process ownership before deleting stage roots; cleanup never deletes a stage that may still be in use.
- Subscribe to the authoritative Rust owner’s successful Connect/unlock for the matching target generation. Queue reconciliation and then eligible cleanup asynchronously, never on a failed durable clear, stale epoch or during Disconnect/quit. Connect does not wait for network cleanup. Do not attach an independent TS reconnect loop.
- **Remote sweep triggers** (for queued cleanup, U3 terminal stages and indexed workspace stages),
  all asynchronous and never in Disconnect or quit paths:
  1. right after a successful Connect (the reconnect hook above). On password hosts, a sweep that
     hits `SshTargetAuthRequiredError` is **deferred, not failed**: it stays queued;
  2. **right after a successful unlock** of a password host;
  3. before each terminal-drop transfer to that target;
  4. every 30 minutes while the target is connected.

  **Transfer-root layout:** each remote transfer has a transfer root that holds three things: the
  **stage** (`<transfer-root>/payload/`), the **marker**, and the **lock**.
  - Workspace uploads: the root is `<destDir>/.bigbud-<id>.partial/`.
  - Terminal drops: the root is `<home>/.bigbud/transfers/<scope>/<id>/`.

  Only `payload/` is seen by the manifest check and by `publish-dir`. Marker and lock are siblings
  of `payload/`, so no bigbud file is ever published.

  **Remote liveness before deleting a stage:** the lock is kept **beside** the stage, as
  `<transfer-root>/lock`, never inside it, so the manifest check and `publish-dir` never see it.
  - **Fallback scripts:** each script writes its pid and start time to `<transfer-root>/lock`, then
    runs a refresher,
    `( while kill -0 $$ 2>/dev/null; do touch "$lock"; sleep 60; done ) </dev/null >/dev/null 2>&1 &`,
    killed by an `EXIT` trap. Its stdio is detached, so an orphaned `sleep` can never hold the SSH
    channel open. Test: the channel closes within 1 s of the payload's end.
  - **rsync route:** the remote rsync cannot refresh a lock. The worker runs a bounded `lease`
    command (`touch <transfer-root>/lock`, a 10 s timeout) over the same transport every 5 minutes
    while the transfer runs. If that cannot run, the sweep relies only on quiescence (below).
  - The sweep deletes a transfer root only if the lock is absent or older than 10 minutes **and**
    nothing under the whole transfer root changed **ctime** in the last 10 minutes. ctime is used
    because rsync's `--times` sets **mtime** to the source time, so mtime cannot show recent
    activity; ctime changes on every write and rename. Where ctime is unavailable (no `stat -c`/
    `stat -f`), only the lock and the worker’s journal lease decide. Otherwise it skips and retries
    later.
  - A test checks that a published upload contains **no bigbud files** (no lock, marker or
    partial).

  Tests: a terminal close during Disconnect queues instead of spawning ssh; the queue drains after
  Connect; the pre-drop sweep removes a stale stage; the periodic timer runs only while connected
  (fake clock).

- Parse remote home without assuming `$HOME` exists. Complete macOS shell variants including `dscl` parsing before rejection, BSD `stat`, durability and garbage collection without `/proc`; test each shipped remote-agent OS/arch and supported Direct SSH shell.
- Native drag-out UI and transfer toasts use a consistent progress/status schema. Priority values must match the shared schema and bridge event count must match tests. Windows Explorer progress accurately reflects per-file completion: use the authoritative completed identity/size, never “starting” progress as finished.

### 8. Native drag-out and signing

Keep platform implementations isolated: macOS file promises with native promise events, file/folder type, `NSProgress` and nonblocking completion; Windows virtual-file COM streams with STA/MTA and Global Interface Table qualification plus fail-fast synchronous extraction; Linux XDS only on a proven X11/Ozone target after a real-host spike. Continue with quick fetch/tray/download fallbacks on all platforms. For Windows synchronous-extraction targets, return promptly and fail cleanly until a file is fully cached; test completion identity, exact size, stale file, and reparse-point/symlink cases. Do not call Rust panic containment crash isolation; no external ArrayBuffers or asar-unpacked dependencies without verified Electron contract.

Windows signing uses electron-builder's default `.exe` signing plus `signExts: [".exe", ".node"]`, with `signDlls` left false (`winPackager.js:192-196`). There is no custom hook. Prove `rsync.exe` and the native addon are Authenticode-signed, and verify Cygwin DLLs against the pinned package hash, never re-signing them. The macOS universal rsync must pass the audit, codesign and hardened-runtime checks, and is notarized as part of the app (§4). Keep architecture audit for every emitted artifact.

### 9. Diagrams

**Download:**

```text
remote workspace ── manifest/list ──► authorize + collision scan
    ├─ matched staged bundled rsync ─► private transfer stage ─► verify identity/size/integrity
    └─ compatible agent stream ──────► private transfer stage ─► streaming digest + verify
                                                   │
                                      same-filesystem safe finalize
                                                   ▼
                            Downloads / granted Save-as / native promise/cache
```

**Recursive upload:**

```text
Finder / Explorer / file tree ─► main-role stat + scoped grant ─► canonical manifest
          ├─ bundled local rsync ─► SSH / agent relay ─► matched bundled remote rsync
          ├─ built-in stream ─────► versioned remote-agent file frames
          └─ POSIX Direct SSH ────► transient framed recursive stream
                                                        │
                         private indexed per-transfer staging tree
                                                        ▼
                          verify each completed file + tree + collisions
                                                        ▼
                               safe finalize, then terminal path/toast
```

### 10. Integration boundaries to use

The current call paths and existing interfaces are catalogued in “Current State (repository findings)”. Reuse structured SSH arguments and sessions; never put transfer orchestration in PTY framing. For RPC ownership, inspect `packages/contracts/src/server/rpc.ts` headroom, `packages/contracts/src/constants/websocket.constant.ts`, `apps/server/src/ws/ws.ts`, `wsRpcContext.ts` and the existing `wsRpcHandlers.*` split; add the RPC contract, method name, handler construction, context service and client wiring consistently, or explicitly document why a surface does not change. Compose `TransferManagerLive` only in desktop mode at `server.profile.ts` / `server.ts`, with typed unavailable implementations for web/remote; do not reuse `profileLayer(local, remote)` or add it to `remoteAgentServerLayer.ts`. M0 must allocate the next available protocol minor after checking current `v1.proto` and generated-code boundaries. Add hello capability only for the agent fallback, preserve ordinary SSH rsync compatibility. M6a must use the actual `provisionAuthority`/peer-provenance pattern, fd3 private bootstrap precedent and per-route checks. M4 must consume the scoped native lifecycle event delivered by S4; the pre-cutover TS Connect implementation is not an insertion point.

**Owner matrix completeness:** include contracts plus `rpc.ts` only if its actual headroom warrants it; websocket constant; `ws.ts`/`wsRpcContext.ts` or explicit no-change rationale; server transfer layers/services and desktop-only composition; protocol, agent hello and generated boundary; private IPC/preload/bootstrap; migration files plus `Migrations.ts`/`migrationEntries` only if a database journal is approved; settings contracts/UI; package artifact source/build/verification; `.github/workflows/release-desktop-build.yml`, `release-remote-agent-build.yml`, `release.yml`, `scripts/lib/release-assets.ts`, signing, notices and publication. Split generated/source artifacts at generator boundary and keep authored source/tests ≤400 lines.

### 11. Reuse targets and cross-platform implementation constraints

- Reuse and explicitly compare existing `ProcessLedger`/`processGroup` APIs and the durable `DirectResourceCleanup` repository/executor/recovery pattern before adding a transfer process journal. Transfer children must be registered with the process group/ledger where compatible, and cleanup must be durable across restart. If a dedicated SQLite transfer journal is necessary, document why existing durable cleanup cannot represent ownership/lease state, add the normal migration file/import/`migrationEntries` wiring, and test migration/recovery. Reap/verify local children and remote ownership records before deleting their stage roots; a quit path must never wait for remote cleanup.
- Request SSH channels via the prerequisite’s native owner. POSIX master reuse and Windows password lifetime remain SSH-owner responsibilities; no transfer or TS credential state.
- Native drag spikes must test actual OS entry points: macOS file-promise events, native folder type, `NSProgress`, and nonblocking completion; Windows COM stream apartment (STA/MTA), Global Interface Table use if required, and fail-fast synchronous extraction. A panic boundary contains Rust unwinds but is not crash isolation; do not advertise process isolation unless a helper process exists. Avoid external `ArrayBuffer` transfer and asar-unpacked payload assumptions unless the installed Electron/package contract proves them necessary.
- Linux XDS is eligible only on a proven X11 session with required Ozone/backend support; Wayland-only or unqualified targets retain quick-fetch/tray/download. macOS binaries require audit, codesign and notarization in the shipped universal or exact-architecture artifact. Cygwin licensing/source obligations must be recorded (including LGPL components); never bundle Cygwin `ssh.exe`, and test inbox Windows 11 OpenSSH with hangs and large streams.
- **Windows signing (settled):** electron-builder 25.1.8 signs every `.exe` by default, adds `signExts` extensions, and signs `.dll` files only when `signDlls: true` (`app-builder-lib/out/winPackager.js:192-196`). So `rsync.exe` is signed by default; `signExts` becomes `[".exe", ".node"]` so `bigbud-native-drag.node` is signed; `signDlls` stays false, so `cygwin1.dll` is not re-signed. **There is no custom allow-list hook.** The packaged verifier checks Authenticode on `rsync.exe` and the `.node`, and the package hash on `cygwin1.dll`. `release.yml`, desktop build, remote-agent build, `release-assets.ts`, signing, notices and publication must all select and verify the new payloads. **Transfer kill switch (settled):**

- The switch is a server setting, `fileTransfersEnabled` (default true, in `settings.fileTransfer.ts`),
  plus an environment override, `BIGBUD_DISABLE_FILE_TRANSFERS=1`, which wins.
- **M3 owns enforcement.** New `transfer.start` calls fail with a typed `disabled` error. Transfers
  already running continue to completion or cancel normally, and their cleanup still runs.
- **M7 owns the UI**: a settings toggle; with transfers off, the upload, download and drag-out
  actions are hidden.
- Tests: switching it off mid-transfer lets the active transfer finish intact and rejects the next
  start; the environment override beats the setting; then test downgrade/restart compatibility with persisted cleanup records and older agents. Do not silently delete bundles/stages during downgrade.
- Remote bundle GC is lease-aware across concurrent desktop instances. Validate remote home and hash output, use no-clobber content-addressed staging, and prove exact Linux musl architecture/ABI before shipping. Workspace stage names, marker, visibility and cleanup are specified in §6.

## Plan assumptions

| Assumption / constraint                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                         | Verification / resolution                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Release targets include four desktop installers (Windows x64 tested on both Windows 10 22H2 and Windows 11, giving 20 agent pairs and 30 Direct SSH pairs), six local workspace-agent sidecars, and four Linux SSH remote-agent install/update triples, as distinguished in Design §1. | Inspected release workflows at HEAD `73cde5bf18`; desktop publishes macOS arm64/x64, Linux x64, Windows x64; release assembly publishes the four Linux remote-agent ABI targets. | Re-read workflows, artifact manifests, installer/stager and signing audit immediately before M1; add rows only with release artifacts and real-host proof.                                             |
| POSIX Direct SSH may work without an installed remote tool only if bigbud can bootstrap its own remote payload over a tested shell; stock Windows OpenSSH is not assumed POSIX.                                                                                                        | `buildSshCommandInvocation` uses remote shell semantics; support differs by target and forced-command configuration.                                                             | W0/W1 and Direct SSH integration spike must prove shell, path, staging, startup and cleanup behavior. Otherwise mark pair unsupported and use only a compatible built-in protocol endpoint.            |
| Existing agent compatibility requires explicit protocol negotiation.                                                                                                                                                                                                                   | Agent release artifacts have version/protocol identity and current agent capabilities are versioned.                                                                             | Test current and prior released agent binaries; preserve session behavior and return typed transfer-specific compatibility error for unsupported agent.                                                |
| Safe atomic publication is filesystem-dependent.                                                                                                                                                                                                                                       | Rename atomicity does not cross filesystems; Windows/macOS/Linux semantics vary.                                                                                                 | Test same-filesystem atomic rename and cross-device copy-to-temp/flush/verify/rename separately on target OSes.                                                                                        |
| Native drag mechanisms are platform/target specific; Linux XDS is not assumed.                                                                                                                                                                                                         | Existing design and Electron platform APIs; no source-level guarantee of destination support.                                                                                    | Run packaged target matrix; keep fallback chain functional if a native route is unavailable.                                                                                                           |
| Source and target paths can race between selection and transfer.                                                                                                                                                                                                                       | Desktop paths may be replaced; remote trees may change between list and open.                                                                                                    | Use no-follow opens, identity and manifest checks; test races. POSIX Direct SSH shell reads rely on trusted source writers (§4), not descriptor confinement.                                           |
| GNU rsync licensing and CVE maintenance requires an explicit release gate.                                                                                                                                                                                                             | D1 selects GNU rsync, and release packaging distributes it.                                                                                                                      | Maintainer/legal sign-off, source and notices archive, reproducible build evidence, pinned CVE review; refusal blocks release and triggers an explicit return to the user, not a silent design change. |
| 10 MiB is the existing UX threshold.                                                                                                                                                                                                                                                   | User-settled requirement.                                                                                                                                                        | Test exactly below, at, and above threshold for rsync and fallback uploads/downloads.                                                                                                                  |

## Milestones and file ownership

The following ownership is exclusive per milestone; serialize edits where paths overlap. Refresh the dirty-file ownership map immediately before starting each milestone because the checkout currently has unrelated terminal work in progress. Do not overwrite another branch's or agent's edits. The transfer plan file is not implementation-owned.

### Owner matrix and dependencies

| Milestone                               | Main owner / exact files or subsystem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Dependencies / serialized overlaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Output / gate                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M0 Contracts                            | `packages/contracts/src/workspace/transfer.ts`, `packages/contracts/src/server/rpc.transfer.ts`, `packages/contracts/src/server/rpc.ts` only if verified headroom, `packages/contracts/src/constants/websocket.constant.ts`, `protocol/remote-agent/v1.proto` plus newly allocated transfer schema, IPC schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Contract-first; version the private TS/worker control protocol (authorized scope, stable ID, start/cancel/status, per-entry outcomes) as well as remote-agent protocol negotiation                                                                                                                                                                                                                                                                                                                                                                                                              | Stable types for both transports, capability, destination grant, errors, manifest, progress, priority and file completion |
| M1 Bundled tools                        | `scripts/transfer-tools/build-rsync.ts`, `rsync.pins.ts`, `scripts/lib/desktop-artifact/transferTools.ts`, `scripts/verify-packaged-transfer-tools.ts`, `.github/workflows/release-transfer-tools-build.yml`, `.github/workflows/release-desktop-build.yml`, `.github/workflows/release-remote-agent-build.yml`, `.github/workflows/release.yml`, `scripts/lib/release-assets.ts`, `scripts/lib/desktop-artifact/resources.ts` (`signExts: [".exe", ".node"]`, `signDlls` false, no custom hook) and the notices/publication verifier                                                                                                                                                                                                                                                                         | M1 owns shared release/artifact files; coordinate N0a; update package builder, release.yml and release-assets publication; include desktop local targets, remote Linux ABI targets and Direct SSH macOS x64/arm64; add kill switch and downgrade verification. GNU GPL/source and Cygwin LGPL gates                                                                                                                                                                                                                                                                                             | Pinned local+remote payloads, stage-by-default, signatures/notices and no-PATH audit                                      |
| M2 Resolver/stager                      | Local Rust worker: route eligibility, cache resolution, remote staging/probe, paths and rsync argv + focused tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M1; target normalization and tested POSIX/macOS/BSD variants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Server-owned bundle cache, exact target resolution, automatic remote staging and probe                                    |
| M3 Transfer manager + fallback protocol | `apps/server/src/transfer/TransferManager.ts`, `TransferManagerLive.ts`, as thin TS control adapters only; local Rust worker: transport adapters, manifest, hashing and publication; **implementation against the M0-owned schema** (`transfer.proto`, `v1.proto` and `build.rs` are owned by M0; M3 only regenerates and implements, and updates the golden frames `protocol/remote-agent/v1.golden.frames` together with the codec tests); `crates/bigbud-remote-agent/src/transfer/**`; `apps/server/src/ws/wsRpcHandlers.transfer.ts`; `apps/server/src/ws/ws.ts`, `wsRpcContext.ts` (or documented no-change); `server.profile.ts` / `server.ts` composition; agent hello capability (`hello.rs`); evaluate reusing `resource_cleanup.proto` for remote stage cleanup before adding new cleanup messages | M0 and M2; compose only desktop profile; do not add to `remoteAgentServerLayer.ts`; split all >400-line files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Recursive rsync and both setup-free fallbacks; safe manifest/finalize; progress and lifecycle                             |
| M4 Lifecycle and cleanup                | Local Rust worker: durable journal, cancellation, reconciliation and cleanup; TS forwards scoped host-removal, disconnect and quit intents; post-S4 native lifecycle event subscription and TS intent bridge tests; `RemoteAgentManagementSection.host.tsx` / `.actions.ts`. **No desktop quit-path edits:** `main.quitTeardown.ts`, `main.ts`, `backendShutdown.ts`, `AppQuitIntent.ts`, `Manager.process.host.ts` and `Manager.quitPolicy.ts` are terminal-plan owned and are **not** edited by M4                                                                                                                                                                                                                                                                                                          | M3. Transfer shutdown runs from the transfer layer's own scope finalizer, which sends the scoped intent to Rust and reads `AppQuitIntent.resolve` (`apps/server/src/lifecycle/AppQuitIntent.ts`), exactly as `Manager.ts:184` does (`resolveQuitIntent: quitIntent.resolve`). That needs no edit to any terminal-owned file. Enqueue reconnect cleanup only after the native owner reports a durable Connect for the current generation; journal migration only if existing DirectResourceCleanup cannot represent ownership; reap before stage deletion; host removal refuses active transfers | Indexed owned staging, bounded kill, queued reconnect cleanup, confirmed host removal; no deletion outside verified roots |
| M6a Transfer IPC foundation (before M5) | `apps/desktop/src/main.channels.ts`, `preload.ts`, `backend/backendManager.ts` private fd3 bootstrap, `window/ipcHandlers.transfer.ts`, `window/ipcAuthorization.ts` + tests; `apps/web/src/rpc/wsNativeApi.transfer.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | M0; main role only; separate grant-returning picker; exact `provisionAuthority` pattern; private capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Stat, capabilities, scoped picker/grants, forbidden-route denial tests; existing picker output unchanged                  |
| M5 Upload UX                            | `TerminalViewport.paste.logic.ts`, `TerminalViewport.drop.ts`, `TerminalViewport.paste.ts`, `FilesPanel.drop.ts`, `FilesPanel.drop.logic.ts`, `apps/web/src/transfers/transferClient.ts`, `transferStore.ts`, `transferToasts.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M3, M4, M6a; M5 defines and owns store/event schema before M6b begins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Recursive upload on all supported pairs; >10 MiB fallback byte progress; terminal path safeguards                         |
| M6b Download UX                         | `apps/web/src/components/files/FilesPanel.downloads.tsx`, `FileActionsMenu.shared.ts`, `FileTargetContextMenu.tsx`, `FilesPanel.header.tsx`, `fileTransferActions.ts`; desktop IPC implementation remains M6a-owned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | M3, M4, M5, M6a; starts after M5 store/event contract; no duplicate store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Download/save-as, tray and cache; grants and drag-out are authorized                                                      |
| M7 Settings/docs/agent GC               | `FileTransferSettings.tsx`, `TerminalSettingsSection.tsx`, `docs/REMOTE_ACCESS.md`, decision/source docs, agent indexed-stage GC, **terminal-drop staging GC (§U3)**: `Manager.pasteStaging.attach.ts` release hook plus the 24 h TTL sweep of `<home>/.bigbud/transfers/<scope>/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M0–M5 (M5 owns the `terminalDropTransfers` constant that M7 flips); recheck Q1 ownership of `TerminalSettingsSection.tsx`, `paste_staging/store.rs` and tests; serialize `docs/COMMANDS.md` and `justfile` with terminal-plan Q1                                                                                                                                                                                                                                                                                                                                                                | Bundled-rsync toggle defaults on; off selects built-in recursive fallback; safe indexed cleanup; docs, no config mutation |
| W0/W1 Windows key-auth rsync            | Cygwin build, packaging, paths/argv validation and worker integration with the native owner’s scoped rsync launch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | After S4; W1 only after a key-auth rsync go                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Key-only acceleration or built-in fallback; Windows password capability is supplied upstream                              |
| N0a Native addon foundation             | `crates/bigbud-native-drag/**`, loader, prebuild and signing/audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M6a IPC edits after M6a; M1 package edits after M1; crate approval record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Panic-contained addon (process crash isolation only if independently provided), packaged/signed target prebuilds          |
| N0b Native chain/UI                     | `apps/web/src/transfers/dragOutChain.logic.ts`, `quickFetch.ts`, `quickListing.ts`, `activeOutgoingDrag.ts`, native-drag setting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | M3, M5/M6b store, **M7** (settings group), N0a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Partial chain and toggle work across platforms                                                                            |
| N1 macOS                                | `crates/bigbud-native-drag/src/platform/macos*.rs`, promise finalization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | N0a/N0b/M3/M6b                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | File/folder promises on signed/notarized macOS arm64/x64                                                                  |
| N2 Windows                              | `crates/bigbud-native-drag/src/platform/windows*.rs`, virtual-file COM streams                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | N0a/N0b/M3/M6b; independent of W1 (fallback can source data)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Authoritative per-file completion, sync-target behavior and real Explorer proof                                           |
| N3 Linux                                | XDS spike and conditional platform code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | N0a/N0b; partial fallback chain required regardless                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Ship XDS only after target-specific real-host gate; otherwise keep partial chain                                          |
| N4 Drag UX integration                  | File-tree/tray drag source, renderer `activeOutgoingDrag` and in-app DND handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | N0b plus each platform implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | In-app drag unchanged and native/fallback chain verified                                                                  |

### Shared-file owner table

Each shared file has **one owner** (it creates the file or makes the first edit). A later
milestone edits it only **after the owner, and every earlier listed editor, has committed**.
Re-check `git status` before every edit, because terminal work continues in parallel.

| Shared file                                                                                                                                                             | Owner                       | Later editors (in order)                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/constants/websocket.constant.ts`                                                                                                                | M0                          | —                                                                                                                                                                                 |
| `packages/contracts/src/server/rpc.ts` (only if headroom allows), `rpc.transfer.ts`                                                                                     | M0                          | —                                                                                                                                                                                 |
| `packages/contracts/src/server/ipc.ts`, `ipc.nativeApi.ts`, new `ipc.nativeApi.transfer.ts`                                                                             | M0                          | N0a (native-drag bridge members)                                                                                                                                                  |
| `packages/contracts/src/core/settings.ts`, new `settings.fileTransfer.ts`                                                                                               | M0                          | —                                                                                                                                                                                 |
| `protocol/remote-agent/v1.proto`, new `transfer.proto`, `crates/bigbud-protocol/build.rs`                                                                               | M0                          | M3 (implementation only, no schema change)                                                                                                                                        |
| `crates/bigbud-remote-agent/src/session/hello.rs` (transfer capability)                                                                                                 | M3                          | —                                                                                                                                                                                 |
| `scripts/lib/desktop-artifact/resources.ts` (361 lines)                                                                                                                 | M1                          | N0a (`files`/`asarUnpack`, `signExts` gains `.node`)                                                                                                                              |
| `scripts/lib/desktop-artifact/nativeSidecars.ts`, new `transferTools.ts`                                                                                                | M1                          | N0a, W1                                                                                                                                                                           |
| `apps/desktop/scripts/notarize.cjs` (no custom Windows sign hook: default `.exe` signing plus `signExts`)                                                               | M1                          | —                                                                                                                                                                                 |
| `scripts/lib/desktop-artifact/linuxArtifactVerify.ts` (399 lines; split first), `scripts/lib/macos-app-architecture.ts`                                                 | M1                          | N0a                                                                                                                                                                               |
| `.github/workflows/release-desktop-build.yml`, `release-remote-agent-build.yml`, `release.yml`, new `release-transfer-tools-build.yml`, `scripts/lib/release-assets.ts` | M1                          | W0 (spike job), W1, N0a                                                                                                                                                           |
| `scripts/transfer-tools/build-rsync.ts`, `rsync.pins.ts`, `scripts/verify-packaged-transfer-tools.ts`                                                                   | M1                          | W0, W1                                                                                                                                                                            |
| `package.json`, `justfile`, `docs/COMMANDS.md`                                                                                                                          | M1                          | N0a; serialize with the terminal plan                                                                                                                                             |
| `Cargo.toml` (workspace members and profiles), `Cargo.lock`                                                                                                             | N0a                         | SSH owner workspace membership already landed in S4; serialize transfer worker additions with N0a                                                                                 |
| Existing Rust SSH owner and its private client contract                                                                                                                 | SSH prerequisite, before M0 | No transfer-owned implementation of SSH. Coordinate a versioned extension with that owner if a scoped operation is missing; block the affected milestone instead of bypassing it. |
| Local Rust worker resolver, rsync argv and platform paths                                                                                                               | M2                          | M3, W1 (platform dispatch)                                                                                                                                                        |
| `apps/server/src/ws/ws.ts` (handler spread, connection facts)                                                                                                           | M3                          | —                                                                                                                                                                                 |
| `apps/server/src/ws/wsRpcContext.ts` (379 lines; prefer a module-level registry instead)                                                                                | M3                          | — (only with the context owner's agreement)                                                                                                                                       |
| `apps/server/src/server.profile.ts`, `apps/server/src/server.ts` (desktop-only composition)                                                                             | M3                          | —                                                                                                                                                                                 |
| `apps/desktop/src/main.bootstrap.ts`, `backend/backendManager.ts`, `backend/backendBootstrapEnvelope.ts`                                                                | M6a                         | —                                                                                                                                                                                 |
| `apps/desktop/src/preload.ts`, `main.channels.ts`, `window/ipcHandlers.ts`, `window/ipcAuthorization.ts` (+ channel test)                                               | M6a                         | N0a, then N0b                                                                                                                                                                     |
| `apps/web/src/rpc/wsNativeApi.ts`, new `wsNativeApi.transfer.ts`                                                                                                        | M6a                         | M6b                                                                                                                                                                               |
| Post-cutover TS connect/disconnect intent hooks and native generation events                                                                                            | SSH prerequisite            | M4 subscribes to authoritative native state for cleanup and scope teardown; no second guard or reconnect authority.                                                               |
| `apps/server/src/terminal/Layers/Manager.pasteStaging.attach.ts` (release hook; `Manager.ts:187` unchanged)                                                             | M7                          | — (confirm with the terminal owner first)                                                                                                                                         |
| `apps/web/src/components/terminal/TerminalViewport.drop.ts`, `TerminalViewport.paste*.ts`                                                                               | M5                          | N4                                                                                                                                                                                |
| `apps/web/src/components/files/filesPanel.dnd.ts`, `FilesPanel.tree.tsx`                                                                                                | M5                          | M6b, then N4                                                                                                                                                                      |
| `apps/web/src/transfers/transferStore.ts`, `transferToasts.tsx`, `transferClient.ts`                                                                                    | M5                          | M6b, N0b, N4                                                                                                                                                                      |
| `apps/web/src/components/settings/FileTransferSettings.tsx`, `TerminalSettingsSection.tsx`                                                                              | M7                          | N0b (native-drag toggle)                                                                                                                                                          |
| `crates/bigbud-remote-agent/src/paste_staging/store.rs` (+ tests)                                                                                                       | M7                          | —                                                                                                                                                                                 |
| `apps/web/src/components/settings/RemoteAgentManagementSection.host.tsx`, `.actions.ts`                                                                                 | M4                          | —                                                                                                                                                                                 |
| `docs/REMOTE_ACCESS.md`, decision records                                                                                                                               | M7                          | W0 (report), N3 (report)                                                                                                                                                          |

### Files near the 400-line limit (split targets)

New code goes into new dot-notation files. The existing file gains only the minimal wiring shown.

| File (lines at `73cde5bf18`)                                   | Plan                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/backend/backendManager.ts` (398)             | M6a puts grant-key generation and envelope wiring in new `backendManager.transferKey.ts`; ≤2 lines added here, otherwise split the bootstrap-envelope block out first |
| `apps/desktop/src/main.ts` (394)                               | No transfer edits. Native-drag and transfer IPC register from `window/ipcHandlers.transfer.ts` and `nativeDrag/*` through the existing registration call              |
| `packages/contracts/src/server/ipc.nativeApi.ts` (382)         | M0 adds only the import and the `transfers` field (≤3 lines); types live in new `ipc.nativeApi.transfer.ts`                                                           |
| `scripts/lib/desktop-artifact/linuxArtifactVerify.ts` (399)    | M1 first splits the agent and supervisor checks into `linuxArtifactVerify.agents.ts`, then adds the rsync checks to a new `linuxArtifactVerify.transferTools.ts`      |
| `apps/server/src/remote-agent/remoteAgentServerLayer.ts` (399) | **Not edited.** `TransferManagerLive` is composed in `server.profile.ts`/`server.ts` (F-17)                                                                           |

**Shared-file serialization rule:** maintain an implementation-time owner list derived from `git status` for terminal `Manager.*`, `DirectShellLaunch*`, remote-agent terminal and persistence changes. Treat the concurrent terminal-plan Q1 edits to `docs/COMMANDS.md` and `justfile` as serialized with M1/docs work even though those paths were clean at this inspection. The current M7 overlap in `TerminalSettingsSection.tsx`, `paste_staging/store.rs` and `.tests.rs` must be resolved by the actual owning branch before edits. Update `docs/COMMANDS.md` and root `justfile` only if a new command is added, with a single designated owner; do not race the terminal justfile/COMMANDS edits.

### M0: Contracts and protocol types

Define versioned direction/source/destination, manifest entry and limits; snapshots with queued/scanning/running/finalizing/reconciling/done/failed/cancelled/outcomeUnknown, bytes, total, file counts, rate/ETA, per-entry publication evidence and outcomes (including partial results), warnings and typed errors. State comes from Rust; TS does not synthesize a terminal result on cancel, disconnect or worker exit. Include the one-use HMAC grant (§6) in disk-touching RPC inputs only. There is no separate capability. The **transfer capabilities snapshot** (a read-only RPC the web calls at startup and on change) includes **`terminalDrops: boolean`**, the server's `terminalDropTransfers` value, because the web cannot import server modules. When it is false, the web routes terminal drops to legacy paste staging, and the server rejects terminal-drop `transfer.start` calls with a typed `disabled` error. Never echo credentials or grants in events. Keep package schema-only and use direct subpath imports. Add protocol feature negotiation and version mismatch types without changing existing terminal/session semantics.

### M1–M4: Engine, staging, fallback, manager and cleanup

1. M1 packages the local Rust worker for each desktop target (reuse a suitable signed desktop Rust binary/role if qualified). Verify its identity and private control IPC in the installed app. It is independent of optional drag support. M1 builds/pins/signs and packages rsync for each desktop release architecture, every published remote-agent Linux target, and tested Direct SSH macOS x64/arm64 remote hosts. Audit archive provenance, source/notices, reproducibility, executable identity and signature/notarization for each desktop-local and remote-only macOS architecture. Reject non-bundled resolution in tests. Split artifact verifier modules, including `linuxArtifactVerify.ts`, so each source file stays <=399 lines; check `rpc.ts` headroom before adding routes.
2. M2 implements resolution/staging in the local Rust worker, only from the server-owned cache, detects target OS/architecture/ABI from supported agent identity or tested Direct SSH probe, stages the matching bundle automatically, verifies hash/signature and probes the bundled executable. Include full shell script variants: macOS `dscl` parsing before rejecting, BSD `stat`, durability/GC without procfs, Linux GNU/musl and tested supported shell. No PATH probing.
3. M3 implements the server’s TS authorization/control adapter and the local Rust worker with three execution adapters: bundled rsync over structured SSH, versioned built-in remote-agent stream, and transient setup-free recursive stream helper over POSIX Direct SSH. Local and remote paths use private per-transfer temp roots, manifest identity and collision checks. Pass `--confine-root` (mandatory when available, with physical `realpath`/`pwd -P` roots, §4) to the remote side via `--rsync-path` and to the local receiver; adversarial path, symlink and race tests must still pass without it, because it bounds operator and `--files-from` paths, not received names. Ensure atomic same-filesystem finalization, tested cross-filesystem final path, exact sizes, streamed fallback digest and corruption rejection. Limit concurrency and never starve PTY/control frames.
4. M4 implements Rust-owned idempotent commands, per-entry reconciliation (§2), and an indexed journal of exclusively owned workspace/remote stage IDs, identities and cleanup state. Hide only verified owned staging directories. On failure while connected, immediately best-effort remove workspace stage; no retained retry artifact. On crash/disconnect, journal and queue remote cleanup; only retry after reconnect. Kill local children concurrently within §7’s aggregate 500 ms shutdown/disconnect budget, with no network waits; user Cancel has an independent budget and escalation. Assert the 500 ms transfer teardown while the terminal path is within 3,000 ms and the backend force-kill remains at 8,000 ms. Select the lifecycle hook only after verifying ownership and current source; test ordering at that actual hook, and keep remote cleanup out of shutdown/Disconnect network paths. Add “Remove bigbud transfer files” with confirmation, refusal during active transfers, and deletion limited to indexed verified roots. No arbitrary matching directory deletion.

### M6a: Local IPC/capability/grant foundation (before upload UX)

Implement scoped, local-main-only IPC for native path stat, capabilities and grant-returning destination picker. Preserve current picker response exactly; create separate API for `{path, grant}`. Follow `provisionAuthority` route-by-route authorization. The server checks only the one-use HMAC grant (§6) plus the connection's peer facts. The grant key is generated per backend start in main and sent over fd 3. Add denial tests for remote-backend, forwarded, mobile, broad roles, non-loopback `BIGBUD_HOST` without equivalent protection, a grant from a previous backend start, and forged, replayed or out-of-scope grants. Redact secrets in logs and error/event schemas. Do not register these channels under broad renderer role.

### M5: Upload UX

Support terminal drop/paste and file-tree folder/file drop. **Terminal drops routed through the manager ship behind `terminalDropTransfers`, a constant in the transfer module (`apps/server/src/transfer/featureFlags.ts`) that M5 owns. It stays `false` until M7's terminal-drop staging GC (§U3) is merged, and M7 flips it**, so no release ever creates terminal stages without their cleanup. File-tree uploads are unaffected (their stages are swept by M4). Read browser drag hints synchronously in native event handler but classify path authoritatively through M6a stat and server-side lstat. Direct SSH small terminal drops choose bundled rsync by default if paste staging is not available. Manager-routed terminal drops ignore `terminalPasteMaxFileMb` (§U3). Conflicts follow §U1 everywhere. Both transports transfer recursive folders. Fallback uploads >10 MiB emit real acknowledged byte progress, same progress/toast semantics as rsync; Windows fallback message is quiet, clear and reports fallback, not an app-wide blocker. Use separate per-source staging to avoid basename collisions; preserve structure and deliver terminal paths only if session/generation/type-ahead checks pass.

### M6b: Download UX

Implement context actions, Save as for file/folder, tray, reveal-in-folder and drag chip. Use the M6a grant API, not broad file-system IPC. Global transfer store reconnects/watch/replays and keeps progress across component unmount. M5 owns the shared store and event priority schema; M6b only consumes it and must not create a competing store. The transfer manager owns its app-controlled download/drag cache, with a byte cap, indexed TTL cleanup and no renderer-chosen cache path. Keep transfer history metadata for 24 h and redact credentials/grants. Downloads and native drag-out use the same manager and verifiers; tests assert priority values and bridge event count agree with the contract.

### M7: Settings, docs and agent cleanup

Document bundle staging, fallback behavior, cleanup, host support limits, protocol/agent update behavior, license notices, Windows Cygwin, OpenSSH/password limitation and native drag partial support. Add the “Use bundled rsync for file transfers (recommended)” setting, default on for eligible targets; Windows password targets always use built-in. Off selects the built-in recursive fallback and never a system executable. Keep the native drag-out toggle separate and default on; defaults preserve no-extra-setup behavior. Implement agent stage GC from indexed ownership, injected clock tests and marker validation. **M7 owns terminal-drop staging GC (§U3), and turns on `terminalDropTransfers` once it lands:** removal of `<home>/.bigbud/transfers/<scope>/<id>/` on terminal close or restart (through the release hook in `Manager.pasteStaging.attach.ts`, confirmed with the terminal owner), plus the 24 h TTL sweep with marker and owner checks. Never add user git config/ignore changes. Add commands to docs and justfile only if needed and serialize shared-file work.

### W0–W1: Windows rsync (conditional acceleration, never feature gate for other OS)

**W0 (spike, two independent verdicts).**

- **The key-auth rsync verdict:** a reproducible Cygwin build, the actual Windows x64 packaged executable,
  the Cygwin runtime and paths (including the bundled `noacl` fstab with ACL inheritance, and no
  argv element starting with `@`), files and folders in both directions, remote staging and
  cancellation.
- Consume the SSH-owner release capability matrix; W0 does not implement or qualify password unlock. Prove the key-auth rsync child is launched under the owner lease and has no password grant.
- **The Cygwin argv verdict:** the round trip through the real `cygwin1.dll` with
  `windowsVerbatimArguments` (spaces, `'`, `\`, `*?[`, a trailing backslash, UTF-8).

The rsync no-go leaves the recursive built-in fallback active for Windows, including >10 MiB
upload progress.

**W1 (key-auth rsync acceleration, after an rsync go).** Cygwin path mapping, default `.exe` signing
(`rsync.exe`), and DLL package-hash proof (not labelled as Authenticode).

**Password rows:** use the already-qualified owner’s built-in channel only. A missing capability fails as specified in U2/U4–U8. Record end-to-end transfer results in the packaged matrix; no upstream acceptance depends on this result.

### N0a–N4: Native drag-out

N0a provides a panic-contained native addon (not crash isolation unless moved out of process), per-target prebuilds, private IPC authorization and verified electron-builder signing/nested signing. Sign/notarize all macOS arch variants. N0b implements quick-fetch/list/tray fallback and shared UX; its pool is low priority and byte-limited. N1 macOS promises support files/folders. N2 Windows virtual files report completion only after file identity and exact expected size prove the cached file is complete; stale same-size files and symlinks fail. Test sync extraction immediate `E_ABORT` unless authoritative completion is already available. N3 is conditional Linux XDS; Linux partial chain is required regardless. N4 preserves renderer-side in-app drag behavior. Windows fallback is quiet, clear, actionable and not a reason to block macOS/Linux release.

## Risks and decision gates

| Gate/risk                                | Required evidence before release                                                                                                                                                                                                                                                                                                                                                             | Failure behavior                                                                                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GNU rsync license, notices and CVEs      | Maintainer/legal approval for GPL/source obligations; pinned source and reproducible build; release asset includes corresponding source/notices; security review of current pin                                                                                                                                                                                                              | Block rsync release and feature release decision; no silent feature cut or unapproved replacement. Return to user/maintainer for a new decision.                      |
| Windows Cygwin bundle/signing            | W0 proof on Windows 11 **and** Windows 10 22H2; default electron-builder `.exe` signing plus `signExts` `.node` (`winPackager.js:192-196`), no custom hook; Authenticode evidence for `rsync.exe` and the native addon; Cygwin DLL checked against the archived package digest; argv (`windowsVerbatimArguments`, argv0), key-auth `-e` argv/path tests and no credential-broker inheritance | Select built-in recursive fallback on Windows; clearly report rsync route absent. Other OS targets proceed.                                                           |
| Remote pair has no working bundled rsync | Built-in versioned remote-agent transfer passes tree/file upload+download, progress, cancellation, integrity and cleanup tests                                                                                                                                                                                                                                                               | If old agent lacks protocol, typed update/reconnect error; no PATH lookup. Forced-command/unsupported host shown unsupported unless compatible protocol is available. |
| Security authority / IPC                 | Role denial, peer provenance (loopback, no forwarding headers), one-use length-prefixed HMAC grants, key rotation on backend start, replay and scope tests, U7 per-spawn askpass binding, log-redaction tests                                                                                                                                                                                | Block exposure; local-only mode remains unavailable until fixed.                                                                                                      |
| Remote shell differences                 | macOS/Linux script variants and target-specific packaged real-host matrix, including BSD tools and no `/proc`                                                                                                                                                                                                                                                                                | Use built-in supported agent transport or explicitly disclose unsupported pair; do not assume POSIX commands on Windows SSH.                                          |
| Cleanup data loss                        | Owned marker/index tests, no-outside deletion, user config/git unaffected, shutdown budgets and reconnect hook proof                                                                                                                                                                                                                                                                         | Disable cleanup operation on uncertain ownership; leave item queued for retry and surface warning. Never broaden deletion.                                            |
| Huge-file performance                    | Benchmark no duplicate full-file hash pass, bounded fallback buffering, concurrency limits and accurate progress                                                                                                                                                                                                                                                                             | Adjust streaming/chunking; never weaken verified size/identity or fallback digest checks.                                                                             |
| Native drag/signing                      | Packaged signing/notarization, panic containment (or proven process crash isolation), real Finder/Explorer/X11-XDS checks                                                                                                                                                                                                                                                                    | Keep partial chain; do not block other platforms on Linux XDS or Windows native drag failure.                                                                         |

The release gate includes every applicable target pair and test row below. A target cannot be declared supported because one path works: it must either pass the bundled-rsync route or the setup-free recursive fallback on that pair. Record explicit unsupported rows (prior agent, stock Windows SSH/forced command without endpoint) and user-visible remedy.

## Testing and validation

The test names below are planned names/subsystems; implementation should follow repository naming conventions and split tests/files to <=399 source/test lines. Conflict tests follow §U1 (auto-rename, never overwrite, never merge, never prompt). Use focused commands only. Never run `bun test`; do not run workspace-wide commands without user approval. Plan-only validation for this revision is separately recorded in handoff.

### Focused unit / contract tests

| Area                          | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract/protocol             | feature negotiation; supported and old-agent handshake; bounded frame sizes; event priority enum and bridge count consistent; secret/grant/capability absent from serialized events/errors/logs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| IPC authorization             | transfer channels allowed only on the local main role; deny broad roles, remote-backend, forwarded and mobile routes and an unprotected non-loopback server; grants: forged, replayed, expired, out-of-scope (wrong parent, basename, direction or target) and from a previous backend start are all refused; existing picker output unchanged; the separate picker returns an exact scoped grant                                                                                                                                                                                                                                                                                                                        |
| Paths/manifest                | legacy `ssh:user@host` normalization; usernames, IPv6; symlink/special files, directory cycles, traversal, Unicode/case collisions, race replacement, manifest count/depth/size limits; enabled `--confine-root` reaches the actual receiver; adversarial confinement still passes with it disabled                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Bundle/resolution             | exact desktop/remote architecture and ABI selection, including signed/notarized macOS local/remote variants; automatic local and remote staging; hash/version/signature mismatch; fail-fast when synchronous target is not cached; poison PATH and fake system rsync proving it is never executed                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Rsync completion/progress     | `%i %n` early-log and post-transfer `%b`/rename fixture on each target; no publication until both completion and verified final file, or successful exit plus verification as fallback; authoritative regular-file identity and exact-size check; same-size stale file/symlink rejection; very large file does not receive duplicate full hashing; interrupt/error cases                                                                                                                                                                                                                                                                                                                                                 |
| Fallback transfer             | recursive nested upload and download, >10 MiB byte progress, stream backpressure, cancellation, disconnect, corruption rejected by streaming digest, bounded memory/concurrency, partial chunk cleanup and retry restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Finalization                  | same-filesystem atomic rename, cross-filesystem temp-copy/flush/verify/rename, no partial visible final, collision and replacement behavior, ACL/permission policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cleanup                       | immediate connected-failure stage cleanup; journal/index ownership; hide only verified stage; no deletion outside owned roots; abrupt loss and reconnect sweep; scoped reconnect hook confirmed against owner/source; no network wait in shutdown; aggregate 500 ms local transfer teardown, terminal teardown ≤3,000 ms within backend force-kill 8,000 ms, with four or more children; user Cancel separate                                                                                                                                                                                                                                                                                                            |
| Platform scripts              | macOS `dscl` parser, BSD `stat`, GC/durability without procfs; Linux glibc/musl, x64/arm64; Windows Cygwin/PowerShell path and signature; test all script variants per supported target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Native drag                   | Finder/Explorer native route, Windows sync target `E_ABORT` <50ms unless verified-complete file, per-file progress/completion identity/exact size, stale same-size file/symlink denial, quick fetch/tray/Download fallback, in-app drag during native session; cache TTL/size-cap cleanup ownership                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Conflicts (§U1)               | every entry point (Downloads, Save as, file-tree upload, terminal drop, macOS/XDS drag finalize) × file/directory: existing same-type and different-type destinations get `name (2)`, `(3)`…; never overwrite or merge; the extension rule (`report (2).pdf`, `.env (2)`, `archive.tar (2).gz`); the 255-byte stem truncation; a concurrent-creation race uses no-clobber publication and takes the next suffix; in-tree case-fold and NFC/NFD collisions on probed folding destinations rename later entries deterministically and are listed in warnings; a case-sensitive destination renames nothing; a Save-as target that appears after the dialog is not replaced; Windows-invalid names are refused, not renamed |
| Windows password (§U2, U4–U8) | Inject the owner capability/error, verify no rsync probe/stage/spawn and no second auth prompt; test idle/resume with terminal leases intact during a built-in transfer. Native SSH authentication qualifications are upstream evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Terminal staging (§U3)        | manager-routed terminal drops ignore `terminalPasteMaxFileMb` but enforce free space and numeric limits; the path is `<home>/.bigbud/transfers/<scope>/<id>/<n>/<basename>` with `0700` directories; removed on terminal close and restart; the 24 h TTL sweep (injected clock) checks marker and owner and never touches anything outside `<home>/.bigbud/transfers` or inside `~/.bigbud/agent`                                                                                                                                                                                                                                                                                                                        |
| rsync contract                | the exact baseline argv (`--secluded-args`, `--no-h`, `--info=progress2`, `--out-format=%i %b %n`, `--no-links`, no `--inplace`); `--confine-root` present in the **remote** argv via `--rsync-path`, plus confinement still holding with it removed; the `-e` encoder against rsync's tokenizer (doubled quotes, space-only splitting) with fake-ssh argv round trips; `host:path` only with `-l` inside `-e` before `--`; host rejection cases; `shell: false`; the environment allow-list drops every `RSYNC_*`; `CYGWIN=noglob` on Windows; the popt config call absent                                                                                                                                              |
| POSIX Direct SSH fallback     | the `dd`-loop framing under `env -i` with GNU, BSD (macOS) and busybox: three back-to-back records (0 B, 1 B, 7.9 MiB) arrive byte-exact; large-file `put` and `get` with the trailer digest; the per-call sentinel discards rc-file noise; hashing happens during write with no second pass; traversal and absolute paths are rejected on both sides; a corrupted record fails; cancel mid-record cleans the stage and closes the private master; at most 1 channel on a shared password master (configurable to 2); opening a terminal during a transfer succeeds with `MaxSessions=10`; Windows has no file-count cap                                                                                                 |
| macOS payload                 | `lipo -archs` = `x86_64 arm64`; system-only `otool -L`; `codesign --verify --strict` plus the hardened-runtime flag; built with `MACOSX_DEPLOYMENT_TARGET`; notarized as part of the app (no bare-binary stapling or `spctl`); each slice runs `--version` natively; the same universal file is staged to macOS remotes of both architectures                                                                                                                                                                                                                                                                                                                                                                            |
| UI                            | terminal drop and paste of files/folders, file-tree recursive drop, fallback progress >10 MiB, Windows fallback copy/no blocker, no stale terminal path insertion after type-ahead or generation change, tray survives unmount/reconnect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Target-pair and release proof matrix

Run each desktop release target against each remote-agent released Linux target: desktop {macOS arm64, macOS x64, Linux x64, Windows x64 on Windows 11, Windows x64 on Windows 10 22H2 (inbox OpenSSH 8.1p1)} × agent {Linux x86_64 glibc, Linux arm64 glibc, Linux x86_64 musl, Linux arm64 musl} (20 pairs). In addition, exercise the same five desktop configurations (macOS arm64, macOS x64, Linux x64, Windows 11 x64, Windows 10 22H2 x64) against Direct SSH POSIX {macOS x64, macOS arm64, Linux x86_64 glibc, Linux arm64 glibc, Linux x86_64 musl, Linux arm64 musl} (30 pairs). For each pair, prove the expected bundled-rsync path when the target auth mode is eligible and that package is available, then force staging/probe failure to prove setup-free fallback upload and download (remote-agent stream for agent pairs; transient helper for Direct SSH POSIX pairs). If W0 is no-go, Windows x64 pair evidence is fallback-only and must prove no system rsync is attempted. Include nested folders, file >10 MiB, cancellation, disconnect/reconnect cleanup, integrity fault and poisoned PATH.

**Throughput targets** (recorded per pair, on a 1 Gbit LAN host and on the Debian VPS):

- the rsync route reaches at least 80 % of `scp` throughput for one 1 GB file;
- the POSIX Direct SSH fallback reaches at least 50 % of `scp` for one 1 GB file (4 MiB `get`
  chunks) and at least 10 MB/s aggregate for 10,000 small files over one channel;
- the agent fallback reaches at least 25 MB/s on the LAN host without raising PTY echo latency
  above 50 ms (p95).

A miss is a release blocker for that route on that pair, not a silent pass.

Add real Direct SSH POSIX target rows for supported macOS x64/arm64 and Linux x86_64/arm64 hosts with diverse shell utilities. Add separate cases for stock Windows OpenSSH, forced-command, old-agent protocol and unknown/unsupported agent target; each must demonstrate compatible setup-free endpoint or render the explicit unsupported/update outcome. Do not claim test coverage for a host OS/architecture without released artifact or reproducible manual evidence.

For packaging, verify macOS x64 and arm64 payloads (universal or correct arch-specific) are independently signed/notarized and selected correctly; desktop Linux x64; Windows x64 Cygwin runtime and actual signing; remote Linux architecture/ABI matching. Ensure no system rsync was invoked by placing trap executables earlier in PATH and by tracing actual process path. Release evidence contains path/hash/signature provenance and command output, with no secrets or user data.

### Real SSH integration and manual checks

Use a disposable local SSH test host or explicitly approved test environment only. Exercise key and password paths, reusable ControlMaster semantics, IPv6/user normalization, denied shell/forced command, agent version mismatch and target-specific startup. No live user host or credential is used for plan validation.

Manual packaged checks: drag file/folder into terminal and remote file tree on macOS/Windows/Linux; transfer both directions; progress and cancel above 10 MiB using rsync and forced fallback; Finder/Explorer native drag and fallback; reconnect cleanup; Direct SSH and agent host-removal confirmation/refusal while active; no user git configuration or ignore mutation. Windows no-go UX must remain quiet/clear and not block macOS/Linux. Record each matrix row and signed artifact identity.

**Windows password-host rows (U4, U5)**, each on Windows 11 (inbox OpenSSH) and Windows 10 22H2
(inbox 8.1p1):

- unlock succeeds after verification, and a wrong password gives the POSIX error text;
- the remote-agent connection, a real ConPTY `-tt` terminal and a relay come up;
- a Direct SSH file-tree listing and preview work;
- with rsync enabled, upload and download recursive folders via each supported built-in adapter; verify bytes/digests, >10 MiB byte progress, cancellation and cleanup. Assert zero rsync probes, staging, grants or spawns. An incompatible old agent gives the typed update/reconnect remedy without ending the session;
- no console window ever appears, and no process hangs on a hidden prompt;
- with only background polling running, the secret expires after 10 minutes; background checks
  show "Paused: unlock to resume" (no failure toast); the terminal and relay retain their original leases and keep running; the next
  user action asks to unlock; after unlock, monitor and read-only inspection resume without a replacement session; independently confirm a real disconnect revokes leases;
- Disconnect and quit wipe the secret (verified with a debug counter, never by dumping memory).
- Separately run the key-auth route with a qualified bundle and with forced fallback. The former exercises real Cygwin argv and absence of broker access; neither depends on the native Windows password capability.

### Repository-defined focused validation after implementation

- TypeScript/Vitest: `bun run --cwd apps/server vitest run <explicit transfer test files>`; web browser tests: `bun run --cwd apps/web test:browser <explicit transfer browser test files>` when Playwright is installed. Never `bun test`.
- Rust: focused `cargo fmt --check` only for changed crate layout as repository tooling permits; `cargo test --locked -p bigbud-remote-agent <focused test target>` and scoped Clippy for affected crate. Workspace checks require approval.
- Desktop/package: focused scripts for artifact verification and target smoke checks. Read each script's effects before invocation; use temp output outside the project where supported.
- Documentation: run only `oxfmt --check docs/plans/2026-11-21-remote-file-transfer-rsync-plan.md` and a focused relative-link check for this file; neither may write project files. Do not run broad lint/format/type/test scans or implementation checks for this plan revision.

### Acceptance criteria mapped to evidence

| Criterion                                                                        | Must pass                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recursive folder/file transfer, upload and download on supported pairs           | M3 fallback and rsync tests; target-pair matrix; UI M5/M6 tests                                                                                                                                                                  |
| Bundled/staged rsync only, local and remote, no setup/PATH use                   | M1/M2 resolution tests; poisoned-PATH process trace; packaged release proof                                                                                                                                                      |
| Windows build failure automatically falls back; fallback upload >10 MiB progress | W0 no-go simulation; M5 fallback toast/progress test and real Windows matrix                                                                                                                                                     |
| Native drag-out with native mechanisms and platform fallback                     | N1/N2/N3 conditional tests; N0b/N4 UI tests and packaged Finder/Explorer checks                                                                                                                                                  |
| Safe authorization, grant, source/destination confinement and redaction          | M6a denial/replay/redaction tests plus path/finalize fault injection                                                                                                                                                             |
| Correct progress, cancellation, cleanup and no leftovers                         | unit, integration and concurrent shutdown/cancel budget tests; reconnect cleanup evidence                                                                                                                                        |
| Safe publication and integrity                                                   | same/cross-filesystem finalization tests, fallback streamed digest corruption test, rsync identity+size proof                                                                                                                    |
| Released support claims accurate                                                 | all 20 agent/desktop pairs plus all 30 Direct SSH POSIX/desktop pairs (Windows 10 and 11 counted separately), plus the Windows password-host rows and separately documented unsupported cases; release workflow/archive evidence |
| Windows password hosts work (U4/U5) on Windows 11 and Windows 10                 | S4 capability evidence for the build, plus the separate Windows password-host **transfer** manual rows here.                                                                                                                     |
| No user config/ignore mutation                                                   | explicit before/after repository/workspace test and code-path audit                                                                                                                                                              |
| Host cleanup is narrowly scoped                                                  | host-removal active-transfer refusal, marker/index validation, and no deletion outside owned tool/staging roots                                                                                                                  |

## Plan validity

- **Source audit expired for implementation.** The revision 7.8 audit at `c7724dddd8` predates the Rust SSH owner. The cross-plan review on `dev` at `9102a63611` checked the ownership boundary and milestone dependencies, not runtime parity or every source anchor.
- **Before M0:** record the accepted S4 build, commit, owner protocol version and capability matrix. Recheck the actual source paths, lifecycle hooks, packaging targets and shared-file owners against that checkout; update this section with the results. Do not start M0 on the strength of the historical audit or a changed SHA alone.
- **Historical anchors from revision 7.8, not current implementation instructions:**
  - `sshSession.ts:45-54,236-344,350-366,368-383`;
  - `backendManager.ts:219,268` (fd-3 bootstrap);
  - `provisionAuthority` in `ws.ts` and `server.ts`;
  - `ProcessLedger` (`apps/server/src/process-ledger/`);
  - `DirectResourceCleanup*` (`apps/server/src/deletion/Layers/`);
  - `ws.ts` (167 lines).
- **Target matrix:** unchanged from revision 7.2. The desktop builds macOS arm64/x64, Linux x64
  and Windows x64; there are six local workspace-agent sidecars; and SSH remote-agent targets are
  Linux x86_64/aarch64, glibc and musl. Confirm the live tag assets before shipping.
- **Not yet proven:** Direct SSH and forced-command behaviour across a real-host matrix. Windows
  stock OpenSSH is not presumed to offer a POSIX shell.
- **The plan expires if** any of these change: the branch or commit; the desktop or agent target
  workflows; protocol versioning; IPC authority or roles; the terminal lifecycle hook; the
  packaging or signing implementation; the pinned rsync; or release behaviour. Re-inspect
  ownership before each milestone.
- **External facts kept from earlier revisions:**
  - rsync's `-e` tokenizer and `-l` placement (`main.c` `do_cmd`);
  - the client-only `poptReadDefaultConfig` (`options.c`);
  - Electron's `startDrag` contract and the V8 memory cage;
  - Microsoft's Shell data-transfer guidance;
  - the Win32-OpenSSH #2115 askpass report.

  Bundled toolchain and signing documentation must be read at implementation time.

## Handoff notes

**Implementation order:** S4 accepted and native contract/version recorded → M0 → M1 and M6a where ownership permits → M2 → M3 (including the dedicated native data-channel proof) → M4 → M5 → M6b → M7. W0 follows M1 pins; W1 follows the key-auth rsync verdict. N0a package changes serialize after M1 and IPC changes after M6a, then N0b and platform-specific N1–N4. No TS SSH helper or W2 password milestone.

**Do not reopen:** D1–D4, U1–U8 (2026-11-22; U8 accepts and states the same-user-malware limit of U7; U7 is the per-spawn askpass binding: nonce, native owner-only pipe, client-pid and parent-ssh check, single use, auth phase only, explicit target), the rsync invocation contract (no `-r` with `--files-from`), the universal macOS payload, the `dd`-loop framed records plus large-file channels for the POSIX fallback, the one-use HMAC grant model, the no-replace publication rules, recursive folder uploads across supported hosts, fallback progress over 10 MiB, bundled local+remote rsync with no system fallback, automatic stage/probe, Mac remote support, native drag-out with fallbacks, safe cleanup without user config/ignore mutation. Reopen only with new verified evidence and explicit user/maintainer decision.

**Implementation and release gates:** both §2 proofs (large agent transfer with no TS payloads and preserved terminal responsiveness; fault-injected cancellation/restart and lost publication acknowledgement without duplicate writes); release-artifact matrix verification; approved/security-reviewed GNU rsync pin and GPL/source gate; recursive setup-free fallback and agent protocol compatibility; local-only IPC authority proof; Windows W0 and signing/password checks; verified scoped lifecycle hook and ownership; real-host Direct SSH/forced-command compatibility. These are evidence gates, not permission to guess unresolved policy. Implementation may proceed only after S4 acceptance is verified and shared-path ownership is refreshed. Conflict policy (§U1), terminal staging and TTL (§U3) and Windows password behaviour (§U2) are settled. Follow the shared-file owner table. Stock Windows SSH and unsupported old-agent conditions must remain visibly bounded; do not promise impossible parity.

**Historical revision logs below:** earlier routing, placeholder publication and deadline descriptions document superseded designs; implement the current §§U1–U8, §4 and W0–W1 and the linked SSH prerequisite instead.

## Revision 7.2 review map

| #   | Peer finding                                                                                                                                                                      | Plan location                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | Conflict policy matrix per operation × file/directory remains pending user choice                                                                                                 | User decisions; §2 routing; conflict tests gated       |
| 2   | Operation × size × kind × route availability, small tree transfers, legacy-only `terminalPasteMaxFileMb`, terminal target/TTL pending                                             | §2 routing matrix; User decisions                      |
| 3   | Executable POSIX Direct SSH fallback, framed protocol or safe archive qualification, exact probes, no unsafe extract/ForceCommand bypass                                          | §4 invocation/fallback constraints; M3; release matrix |
| 4   | fd3 private launch key; grants bound to operation/expiry/nonce/webContents; local role/provenance and non-loopback/Tailscale denial                                               | §6; M6a; IPC tests                                     |
| 5   | Reuse/justify ProcessLedger, process groups and durable DirectResourceCleanup vs SQLite journal; reap before deletion                                                             | §7; §11; M4; cleanup tests                             |
| 6   | Existing POSIX SSH args/ControlPath; no server password retention; Windows Master/password decision pending                                                                       | §4; §11; W0–W2; User decisions                         |
| 7   | macOS/Windows native drag threading, progress, folder type, STA/MTA, GIT, synchronous fail-fast                                                                                   | §8; §11; N1/N2                                         |
| 8   | Exact safe rsync flags, `%i %b %n`, `--info=progress2`, no `-h`, symlink/special/inplace/partial exclusions, rooted args/env tests                                                | §4 invocation constraints; §6; tests                   |
| 9   | Universal/per-architecture macOS audit/sign/notarize                                                                                                                              | §1, §4, §8; M1/N1; release proof                       |
| 10  | Full owner matrix including RPC, WebSocket, server, proto, bootstrap, migrations, settings, package/release/assets; split large source                                            | §10; milestone owner matrix                            |
| 11  | Current HEAD/status and non-exhaustive dirty ownership refreshed; peer owns terminal/deletion/capabilities; no concurrent plan edit                                               | F-15; Plan validity                                    |
| 12  | Dedicated agent fallback channel ≤256 KiB with credits, bounded backpressure, fairness/latency and legacy compatibility                                                           | §4–5; fallback tests                                   |
| 13  | Ordinary Direct SSH rsync does not depend on agent version; only agent fallback negotiates capability                                                                             | F-13; §5; protocol tests                               |
| 14  | Exact scoped quit/disconnect hook, verified lifecycle ownership, 3 s terminal within 8 s desktop quit, concurrent transfer 500 ms/no network                                      | §7; §10; M4; cleanup tests                             |
| 15  | Numeric caps, MaxSessions typed error/probe, complete paginated manifests beyond 10,000 entries, free-space checks                                                                | §5; fallback tests; target integration                 |
| 16  | NTFS and macOS case/Unicode normalization collision behavior                                                                                                                      | §3/§6; path tests                                      |
| 17  | Cygwin source/LGPL, Windows 11 inbox SSH hangs/large streams, no bundled Cygwin SSH                                                                                               | §11; W0–W2; licensing gate                             |
| 18  | Linux XDS only with actual supported X11/Ozone session                                                                                                                            | §8; §11; N3                                            |
| 19  | Verify installed electron-builder signing contract; narrow signing scope; no third-party DLL resign; panic boundary ≠ crash isolation; no unverified ArrayBuffer/asar assumptions | §8; §11; N0a                                           |
| 20  | Kill switch/downgrade and release.yml/release-assets publication                                                                                                                  | §11; M1; rollout risks                                 |
| 21  | Content-addressed no-clobber remote stage, validated home/hash, lease-aware cross-desktop GC, proven musl/arch                                                                    | §4; §11; M1/M2                                         |
| 22  | Workspace stage distinct name, marker, OS visibility and verified ownership cleanup                                                                                               | §6–7; M4                                               |
| 23  | Stale citations, status/date, owner and milestone ordering corrected                                                                                                              | Metadata; F-15; Plan validity; owner matrix            |

## Revision 7.3 changes and verification of the 23 findings

User answers folded in: U1 (the conflict-policy table and shared naming helper), U2 (the win32
unlock-time capture, a session-only zeroed `Buffer` cleared on Disconnect, quit or 10 minutes idle,
no OTP or passcode answers, POSIX unchanged) and U3 (terminal drops ignore
`terminalPasteMaxFileMb`, staged at `<home>/.bigbud/transfers/<scope>/<id>/`, deleted after 24 h
or on close or restart, GC owned by M7). Each is backed by tests.

Each of the 23 findings was re-checked against the body.

| Item checked                                              | State found in 7.2                                                                                                                                                                               | Action in 7.3                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1 Conflict table                                          | Placeholder (pending)                                                                                                                                                                            | Filled from U1; tests added                                                                                 |
| 2 D2 routing (operation × kind × size)                    | Present (§2 table)                                                                                                                                                                               | Terminal destination and TTL filled (U3)                                                                    |
| 3 POSIX Direct SSH fallback mechanism                     | Left as "framed records **or** tar/pax" for the implementer, which is an open design choice                                                                                                      | **Settled:** framed records with `head -c`, per-record digest and acknowledgements; tar/pax rejected; tests |
| 4 HMAC grant key via bootstrap envelope, header rejection | Partial: fd-3 key and grant binding present; HMAC construction and forwarding-header list missing                                                                                                | Restored: HMAC fields, fd-3 delivery, nonce replay, explicit header and peer list                           |
| 5 ProcessLedger and process-group reuse                   | Present (§11)                                                                                                                                                                                    | Kept                                                                                                        |
| 6 SSH args and ControlPath; password retention            | Pending Windows decision                                                                                                                                                                         | POSIX settled unchanged; Windows per U2                                                                     |
| 7 Native-drag threading spikes                            | Present (§8, §11)                                                                                                                                                                                | Kept                                                                                                        |
| 8 rsync invocation contract                               | Partial: `--secluded-args`, `%i %b %n`, `shell: false`, `CYGWIN=noglob` present; `--no-h`, the tokenizer rule, host handling, the env allow-list and `--confine-root` via `--rsync-path` missing | Restored as a pinned contract with tests                                                                    |
| 9 Universal or verified macOS payload                     | Left as "universal or per-arch"                                                                                                                                                                  | **Settled:** one universal signed and notarized binary for local and remote use; verification steps         |
| 10 Full owner matrix                                      | Milestone-level only; W and N rows vague                                                                                                                                                         | Added a shared-file owner table with ordered later editors; W0–W2 files named                               |
| 11 Current HEAD and dirty ownership                       | Baseline `9e5e9a635a`, dirty list stale                                                                                                                                                          | Re-baselined to `73cde5bf18` (clean); F-15 and Plan validity refreshed                                      |
| 12–22                                                     | Present as mapped in the 7.2 review map                                                                                                                                                          | Spot-checked in the body; kept                                                                              |
| 23 Stale citations                                        | `Manager.ts` line, `wsRpcContext.ts` length                                                                                                                                                      | `Manager.ts:187`; `wsRpcContext.ts` 379 lines                                                               |

## Revision 7.4 changes (18 review issues, plus user answers U4 and U5)

| #   | Issue                                                 | Resolution                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `head -c` reads ahead on macOS and busybox (verified) | The fallback is redesigned: one SSH exec channel per file (`cat` until EOF), batched `mkdirs` and `verify-rename` (line `read` only), multiplexed over the password `ControlPath` or a transfer-owned private ControlMaster on POSIX, and one connection per channel on Windows. GNU `head -c` single-stream mode only after a probe proves it. Back-to-back tests through macOS `head` and busybox. |
| 2   | The environment allow-list broke the ssh contract     | The environment is `sshClientProcessEnv()` minus `RSYNC_*` and `CVSIGNORE`, plus `LC_ALL` and `CYGWIN=noglob`. ssh is resolved to the same executable and used as the first `-e` token. ProxyCommand and `ensureSshAgentEnv` tests.                                                                                                                                                                  |
| 3   | win32 password unlock cannot succeed today            | Facts recorded. **User answer U4: make them work** for the agent, the file tree and transfers. A win32 unlock path, per-connection askpass, the shared `sshSpawnEnv.ts`; the "win32 args unchanged" constraint is removed; the `skipIf(win32)` tests are replaced.                                                                                                                                   |
| 4   | Windows 10 OpenSSH 8.1p1 lacks `SSH_ASKPASS_REQUIRE`  | **User answer U5: support it.** The legacy trigger (no console, stdin not a console, `DISPLAY`), Windows 10 22H2 in W0, W2 and the matrix; a failed proof goes back to the user.                                                                                                                                                                                                                     |
| 5   | `--confine-root` per direction                        | Upload: the remote stage root. Download: the remote validated source root, plus the local receiver confined to the local stage. Both tested.                                                                                                                                                                                                                                                         |
| 6   | Bind rsync to the manifest                            | `--files-from=- --from0` on stdin with explicit `-r`; a stage-versus-manifest check (count, path, type, size) before publication.                                                                                                                                                                                                                                                                    |
| 7   | `%n` escaping                                         | `--8-bit-output`, with control characters decoded from `\#ooo`; matched against manifest entries; UTF-8, NFD and control-character tests.                                                                                                                                                                                                                                                            |
| 8   | Remote folder no-clobber nests                        | An exact `publish-dir` algorithm (reserve with `mkdir`, move top-level entries including dotfiles with empty-glob guards, verify, `rmdir` the stage, roll back); GNU, BSD and busybox tests.                                                                                                                                                                                                         |
| 9   | The server cannot check `webContents.id`              | The single server-checked token is the one-use length-prefixed HMAC grant; the separate capability and the webContents binding are dropped; a fresh key on every backend start; replay and old-key tests.                                                                                                                                                                                            |
| 10  | U3 cleanup during Disconnect cannot start ssh         | Queued in the pending queue. Sweep triggers: after Connect, before each terminal drop, and every 30 minutes while connected. Tests.                                                                                                                                                                                                                                                                  |
| 11  | Files near 400 lines                                  | A split-targets table (`backendManager.ts`, `main.ts`, `ipc.nativeApi.ts`, `sshSession.ts`, `remoteAgentServerLayer.ts`).                                                                                                                                                                                                                                                                            |
| 12  | M4 quit files are terminal-owned                      | Desktop quit edits removed from M4: a scope finalizer plus a read-only quit-intent subscription, or an owner-approved ≤5-line hook with a shared-table row.                                                                                                                                                                                                                                          |
| 13  | Cygwin                                                | The bundled `noacl` fstab, an ACL-inheritance check, and an assertion that no argv element starts with `@`.                                                                                                                                                                                                                                                                                          |
| 14  | D2 wording                                            | "Must"; single terminal files ≤10 MiB use paste staging when the agent has `terminal.paste-staging`, otherwise rsync.                                                                                                                                                                                                                                                                                |
| 15  | Kill switch                                           | The `fileTransfersEnabled` setting plus `BIGBUD_DISABLE_FILE_TRANSFERS`; M3 enforces and M7 owns the UI; a mid-transfer test.                                                                                                                                                                                                                                                                        |
| 16  | macOS payload checks                                  | `codesign --verify --strict` plus a hardened-runtime flag check; notarized through the app (no bare-binary stapling or `spctl`); `MACOSX_DEPLOYMENT_TARGET`; Linux static/`ldd` checks.                                                                                                                                                                                                              |
| 17  | Signing                                               | Default `.exe` signing; `signExts` `[".exe", ".node"]`; `signDlls` stays false; no allow-list hook (`winPackager.js:192-196`).                                                                                                                                                                                                                                                                       |
| 18  | Small fixes                                           | `-l` only with a user; `/usr/bin/env` in `--rsync-path`; golden frames updated in M3; `resource_cleanup.proto` reuse evaluated; stale `9e5e9a635a` removed; M3 consumes the M0-owned proto; glibc builds noted as transitional; a 3.5.2 `B`/`B/s` progress fixture; N0b after M7.                                                                                                                    |

## Revision 7.5 changes (17 review issues, plus user answer U6)

| #   | Issue                                          | Resolution                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | `-r` with `--files-from` copies whole subtrees | `--recursive` dropped. The manifest lists every file and directory (including empty ones), relying on the implied `-R`/`--dirs`. The stage check is kept, with an extra-file test.                                                                                          |
| 2   | Shared password master versus `MaxSessions`    | At most 1 fallback channel on a shared master (configurable to 2), with small files batched. Test: opening a terminal during a transfer still succeeds with `MaxSessions=10`.                                                                                               |
| 3   | The 2,000-file Windows cap; framing            | Cap removed. Small files use `read -r` header plus `dd bs=$remaining count=1                                                                                                                                                                                                | tee                                                                                                                         | wc -c`loops; large files use`cat`until EOF.`head -c` probe mode dropped. Back-to-back tests on GNU, BSD and busybox. |
| 4   | U4 covered too few spawn sites                 | Askpass variables go into `sshClientProcessEnv()` on win32; the secret is served over a per-user ACL pipe keyed by target. The full spawn-site list, a static bypass test, owner rows, and W2 before M3.                                                                    |
| 5   | No-clobber primitives unreachable from Node    | `localPublish.ts`: `fs.link`+`unlink`, an `open(wx)` placeholder fallback, POSIX `mkdir` reserve plus rename onto the empty directory, and Windows reserve plus move entries.                                                                                               |
| 6   | Cygwin argv rebuild                            | `windowsVerbatimArguments` plus a Cygwin `"` encoder (reject `"`, control characters and a leading `@`); a W0 round trip through the real `cygwin1.dll`.                                                                                                                    |
| 7   | `ConnectTimeout` does not bound prompts        | A 20 s auth-phase deadline on every win32 password spawn, long-lived ones included; a test with a fake `ssh.exe` that blocks on a prompt.                                                                                                                                   |
| 8   | The 8.1 trigger restated from source           | `DISPLAY` plus `SSH_ASKPASS` (`/dev/tty` always fails on win32; `readpass.c:149-190`); the no-console and detached requirements dropped; a ConPTY `-tt` W0 criterion added.                                                                                                 |
| 9   | Stale text                                     | Purged the framed-record/`head -c` tests, stapling, launch capability and cross-window text, the Windows-11-only proofs and the signing hook, "four desktop targets", and `--confine-root` "optional". `--confine-root` semantics restated. U4–U6 added to "Do not reopen". |
| 10  | Fallback integrity                             | Hash during write (`tee`), a `get` trailer digest, a per-call sentinel against rc-file noise, and the SSH MAC plus exact size as the basis.                                                                                                                                 |
| 11  | `publish-dir` clobbering                       | `mkdir -m 700` reserve, a per-entry intrusion check, `mv -n`, per-entry verification, `chmod` last, and an `ln`-failure existence check with a placeholder or `unsupportedFilesystem`.                                                                                      |
| 12  | Numeric floors                                 | ≥100,000 entries and ≥128 depth, paged; aggregate bounded only by free space; no limit refuses a listable folder.                                                                                                                                                           |
| 13  | Grant scope, drops, retry                      | Parent directory plus basename with U1 suffixes; drops attested by main; retry reuses the recorded authorization for 24 h.                                                                                                                                                  |
| 14  | Sweep before unlock; liveness                  | An after-unlock trigger; auth-required means deferral; a remote lock file plus 10-minute mtime quiescence before deletion.                                                                                                                                                  |
| 15  | M4 quit                                        | The scope finalizer reads `AppQuitIntent.resolve`, as `Manager.ts:184` does; the conditional branch is removed.                                                                                                                                                             |
| 16  | Partial dir, `%n`, ControlMaster path          | An absolute per-transfer `--partial-dir` outside the tree; a two-field `%n` parser that strips the trailing `/` and decodes `\#ooo` only; the private master under the existing `/tmp` mkdtemp root.                                                                        |
| 17  | Split targets and Cygwin layout                | `linuxArtifactVerify.ts` (399) added to the split table; layout `rsync/bin/{rsync.exe,cygwin1.dll,…}` and `rsync/etc/fstab`.                                                                                                                                                |
| U6  | Idle timer                                     | "Only things you do": an `origin: "user"                                                                                                                                                                                                                                    | "background"` flag (default background), terminal-input touch, a paused state for background callers, and fake-clock tests. |

## Revision 7.6 changes (15 review issues, plus user answer U7)

| #   | Issue                                            | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Absolute `--partial-dir` breaks `--confine-root` | `--partial-dir` and `--partial` removed; rsync's in-stage temporaries are used; a test checks an interrupted transfer leaves nothing outside the stage.                                                                                                                                                                                                                                                                                                                                            |
| 2   | The FIFO hash covered only the first chunk       | One hasher per file, one writer held on fd 3 across the loop, bytes counted by part size, then close and `wait`; a 1 MiB in 16 KiB writes test.                                                                                                                                                                                                                                                                                                                                                    |
| 3   | The lock inside the stage pollutes publish       | A transfer root holding `payload/`, the marker and the lock as siblings; refreshers per route (a fallback `kill -0` loop, an rsync `lease` call, or quiescence); a "no bigbud files published" test.                                                                                                                                                                                                                                                                                               |
| 4   | Same-user pipe fetch (security)                  | **User answer U7, not acceptable.** Per-spawn nonce, a native owner-only DACL pipe in the supervisor, `GetNamedPipeClientProcessId` plus a parent-ssh check, single use, auth phase only, explicit target.                                                                                                                                                                                                                                                                                         |
| 5   | The auth deadline killed silent commands         | The timer stops on askpass "served" plus `Authenticated to` (`LogLevel=VERBOSE` on a dedicated stderr pipe); only unauthenticated spawns are killed; a silent 60 s command test.                                                                                                                                                                                                                                                                                                                   |
| 6   | `#`/`;` entries and trailing slashes             | Entries are sent as `./<relpath>` with no trailing slash; tests for `#a`, `;b` and an empty directory.                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | Physical-cwd confinement                         | `realpath` / `pwd -P` for every confine and stage root, using the same string as the destination; a macOS `/tmp` test.                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | argv0 under verbatim arguments                   | Explicit, `"`-encoded argv0; a W0 test with a space in the rsync.exe path.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 9   | Windows directory publish                        | Rename straight to a nonexistent candidate; any error means the next n; no `mkdir` probe; a Windows CI test.                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Per-master session budget                        | One budget per master (default 1, up to 2), shared by all transfers and both routes, with the rest queued; an 8-terminals-plus-3-transfers test under `MaxSessions=10`.                                                                                                                                                                                                                                                                                                                            |
| 11  | Fallback download batching                       | `get-batch` with `F`/`D` records, exact size from an open fd with short-read checks, per-file trailers, server-parsed lengths; a 10,000-files test.                                                                                                                                                                                                                                                                                                                                                |
| 12  | U6 touches                                       | `touch(targetId)` at every user-facing handler entry; a test per handler.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 13  | Centralised spawn and coverage                   | A branded `SshSpawnSpec` required by `spawnSsh`, `runSshCommand` and `runSshLocalCommand`; a lint rule over every child-process API; `peerRelay.ssh.ts:157` and `localTerminalHost.directSsh.ts` added.                                                                                                                                                                                                                                                                                            |
| 14  | Split W2                                         | W2a (platform-neutral plumbing) before M3; W2b (win32 askpass, U7, unlock) after the W0 password verdict; handoff order updated.                                                                                                                                                                                                                                                                                                                                                                   |
| 15  | Stale text and small logic                       | Header and worktree re-baselined to `a494f2d63c`; per-launch capability removed from M0 and M6a; M3 confine-root no longer "optional"; M1 and risk signing text corrected; "five desktop configurations"; `rsyncAskpass.windows.ts` replaced; table pipes escaped; a trap rollback with a moved-list; retry authority in memory only; drop-grant wording; askpass variables cleared for non-askpass supervisor children; `terminalDropTransfers` gate between M5 and M7; `-8` rationale corrected. |

## Revision 7.7 changes (12 review issues, plus user answer U8)

| #   | Issue                                    | Resolution                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | U7 failed for real spawn shapes          | Absolute `ssh.exe` with `shell: false` in every variant; no sync ssh spawns for password targets (codex `--version` and `runSshLocalCommandSync` uses move to async); the supervisor holds a process handle and creation time; an rsync ancestor chain; tests per spawn shape.           |
| 2   | `get-batch` not buildable                | Self-framed `C <n>` 64 KiB chunks from fd 4 into a private `mktemp -d` chunk file, a `T <k> <total> <sha256>` trailer, and a typed mismatch with no desync; large `get` uses the same framing; shrink and growth tests on GNU, BSD and busybox.                                          |
| 3   | win32 host trust                         | A `BIGBUD_ASKPASS=trust` role through the same binding answers `yes` only for the exact approved prompt; `sshHostTrust.ts` in W2b; the `skipIf(win32)` host-trust test replaced; "never answers host-key" scoped to the password role.                                                   |
| 4   | Threat model and pipe hardening          | **User answer U8: accept and state plainly.** A random per-session pipe name, `FILE_FLAG_FIRST_PIPE_INSTANCE`, `PIPE_REJECT_REMOTE_CLIENTS`, and askpass checking `GetNamedPipeServerProcessId`.                                                                                         |
| 5   | `LogLevel=VERBOSE` pollutes stderr       | Dropped. The timer stops on askpass served or process exit; the single-use nonce ends later prompts; a ConPTY output-unchanged test was added.                                                                                                                                           |
| 6   | Refresher held the channel               | The refresher runs with `</dev/null >/dev/null 2>&1`; a test checks the channel closes within 1 s.                                                                                                                                                                                       |
| 7   | The branded spec did not force migration | An opaque spec with module-private argv; spawn variants (async, Effect, runProcess, PTY with `onPid`); a compiler-API check script wired into `bun lint`, CI and COMMANDS; `sshHostTrust.ts`, `sshVerification.ts` and `sshSession.ts` added.                                            |
| 8   | W0/W2b cycle                             | W0-password (a), a throwaway trigger spike, gates starting W2b; (b), the full criteria, is W2b's acceptance gate.                                                                                                                                                                        |
| 9   | Owner tables and supervisor availability | Rows for the supervisor proto, generated code and server codec, the `touch()` handlers and `sshHostTrust.ts`; `sshCommand.ts` ordered W2a → M3 → W2b; `askpassUnavailable` when the supervisor is unmanaged, disabled or restarting; the dev-mode note.                                  |
| 10  | Session budget accounting                | Every transfer ssh command runs inside its granted session budget, one after another; the root is created after the grant; shared masters rely on quiescence.                                                                                                                            |
| 11  | Retry contradiction                      | In-memory reuse for up to 24 h within one backend lifetime; a fresh grant after a restart.                                                                                                                                                                                               |
| 12  | Low                                      | 0-byte part creation with `set -C`; the large-`get` framing; `lstat` to tell a collision from `EACCES`/`EXDEV`; the `terminalDropTransfers` constant owned by M5 and flipped by M7; re-baselined to `3c9670e3a3`; `ForwardX11=no`; ProxyJump password hosts rejected with a typed error. |

## Revision 7.8 changes (final pass)

**Fixed (non-Windows):**

| #   | Issue                                | Resolution                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | Unbounded fallback reads; throughput | Reads stop at the listed size, then a one-byte growth probe gives `sourceChangedDuringTransfer`. 4 MiB chunks for large `get`, 64 KiB for `get-batch`. Throughput targets added to the release matrix.                                                                          |
| 9   | Read-side path safety                | `[ -f ] && [ ! -L ]` plus the `cd -P` parent check before every read open, re-checked after the open; symlink, FIFO and parent-swap race tests on GNU, BSD and busybox.                                                                                                         |
| 12  | The web cannot read the server flag  | `terminalDrops: boolean` in the M0 capabilities snapshot; the web falls back to paste staging, and the server rejects terminal-drop starts when it is false.                                                                                                                    |
| Low | Small items                          | macOS `wc` padding normalised with `$(( ))` and `%d`, with whitespace-tolerant parsing; ctime instead of mtime for quiescence; sweeps counted in the session budget; grant fields for `removeHostFiles` and multi-source drops; metadata and F-15 re-baselined to `c7724dddd8`. |

**Recorded, not fixed (Windows):** issues 1–7, 10 and 11, plus the Windows Low items, are in "Open
Windows issues (for external review)" (W-1 to W-12).

## Review log

- Revision 7.2 requirements pass: settled scope is preserved, all 23 supplied peer findings are explicitly mapped, and conflict, terminal staging and Windows password choices remain placeholders rather than inferred defaults.
- Revision 7.2 execution-readiness pass: current branch/SHA and dirty ownership are refreshed; routing, protocol, process ownership, security, staging, lifecycle, platform, package and release integration are specified without claiming unrun validation.
- The supplied peer challenge has 23 findings. No separate `plan-reviewer` tool was available in this execution; this log does not claim a post-edit independent review.
- Revision 7.2 left the plan Draft pending three user choices.
- Revision 7.3 requirements pass: U1–U3 are recorded and reflected in the routing, upload, lifecycle, W2, M7, owner-table and test sections. The settled scope (D1–D4) is preserved.
- Revision 7.3 execution-readiness pass: the two implementer-left design choices (the POSIX fallback mechanism and the macOS payload form) are now settled; the rsync contract and grant construction are concrete; the shared-file ownership is explicit; anchors are re-checked at `73cde5bf18`.
- No `plan-reviewer` tool was available in this run, so no independent post-edit review is claimed.
- Revision 7.4: the 18 review issues are fixed, and the user's U4 and U5 answers are applied (Windows password hosts work for every caller, including Windows 10 8.1p1). The two passes were re-run against the body: requirements coverage (D1–D4, U1–U5) and execution readiness (file ownership and split targets, exact algorithms, tests). No independent post-edit review tool was available.
- Revision 7.5: the 17 review issues are fixed and U6 is applied. Both passes were re-run against the body; stale contradictions were searched and purged outside the historical change logs. No independent post-edit review tool was available.
- Revision 7.6: the 15 review issues are fixed and U7 is applied. Both passes were re-run, and stale contradictions were searched outside the historical change logs. No independent post-edit review tool was available.
- Revision 7.7: the 12 review issues are fixed and U8 is applied; both passes were re-run. No independent post-edit review tool was available.
- Revision 7.8 (final, per the user): the non-Windows issues are fixed, and the Windows issues are recorded for external review. Plan status: ready for implementation for non-Windows work; the Windows sections are pending.
