# Remote file editing for SSH workspaces

**Date:** 24 November 2026
**Status:** In progress. E0 and E1 are implemented in the working tree, pending manual UI acceptance over SSH; their status is under Implementation status (E0–E1). E2 and E3 have not started. User decisions 1–5 are recorded on 24 November 2026.
**Owner:** Files/workspace, with the Rust SSH owner, remote agent and release owners at their gates
**Inspected baseline:** `dev` at `65ef17f9df` plus concurrent uncommitted work. Recheck every cited line before implementation.

## Summary

bigbud users can edit local files and files in remote-agent projects. Files in plain **Direct SSH** projects are labelled Read only. Zed's SSH editing works because a remote headless server owns the file, buffer and watcher (see [Zed reference](#zed-reference-what-it-actually-does)). bigbud already has the matching part for **remote-agent** projects: a native agent on the host that performs SHA-256-guarded atomic replacement.

Recommendation, in order:

1. **E0–E1: qualify and harden the remote-agent path that already exists.** Make editability a negotiated server capability instead of target-ID string parsing. Add a safe way to resolve an "outcome unknown" save without reloading the app, retain drafts durably, fence saves on Disconnect, and record live acceptance on a disposable host. This gives SSH users editing now through the remote agent, without new SSH execution paths.
2. **E2: build plain Direct SSH editing only as a native Rust SSH owner verb** in the existing dev-only Files slice: a distinct guarded write, never a degraded overwrite. It must not use the legacy TypeScript `runSshCommand` path or any fallback.
3. **E3: enable Direct SSH editing in production only with the single all-consumer S4 activation** of the [Rust SSH ownership plan](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-plan.md). Until then, production Direct SSH remains Read only, with a clear reason and an "Install remote agent to edit" action.

No phase changes the SSH ownership, transfer, release or cutover gates.

## Related Work

- [One Rust owner for SSH](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-plan.md): Direct SSH writes are C05 consumer rows. The dev-only exception orders work as picker → files → terminal. S4 is the only production activation.
- [S3/S4 gap audit and backlog](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-23-rust-ssh-ownership-s3-s4-backlog.md), item 3, "Files slice completion": writes over 48 KiB, read→write denial and the per-verb limit table. E2 is the editor-specific part of that item.
- [S0 workspace contracts](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-workspace-contracts.md), rows C05 "conditional overwrite → distinct guarded write" and "create-only → distinct exclusive write", plus point 1 on byte budgets and point 2 on scope and path resolution.
- [S0 qualification ledger](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-ledger.md): the C05 bounded-write checkpoints and the browse-only "Normal Linux dev browser jump selection" lane.
- [Remote agent completion plan](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-17-remote-completion-plan.md): agent capability negotiation, backend-scoped storage (WP-3C) and the remote-backend window (`?backend=`).
- [Remote workspace disconnect](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-06-remote-workspace-disconnect-plan.md) and [remote thread reconnect](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-21-remote-thread-reconnect-plan.md): sticky Disconnect and bounded reconnect, which saves must respect.
- [Remote file transfer](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-21-remote-file-transfer-rsync-plan.md): a separate data plane with auto-rename and no overwrite. Editor saves do not depend on or replace it.
- Zed primary sources: [remote development guide](https://zed.dev/docs/remote-development) and upstream code pinned at [`6501df15765d`](https://github.com/zed-industries/zed/tree/6501df15765d66d6c2a2b66b1eb22434ccef3f86), the same revision used by the ownership plan.

## Zed reference: what it actually does

Traced at [`6501df15765d`](https://github.com/zed-industries/zed/tree/6501df15765d66d6c2a2b66b1eb22434ccef3f86); permalinks below use that revision. I spot-checked the save request, handler, `RealFs::save`, `has_conflict`, the overwrite prompt and the proxy restart in the pinned source. This section is a behavioral summary, not transplanted code.

- **Architecture.** The [guide](https://zed.dev/docs/remote-development) runs the UI locally and a version-matched headless `zed-remote-server` on the host. That server holds the source, language servers, tasks and terminals over one SSH ControlMaster. It says unsaved changes are persisted locally and restored when the project reopens.
- **Save request and acknowledgement.** The client sends [`SaveBuffer`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/proto/proto/buffer.proto#L47-L65), which contains a buffer ID, a version vector and an optional new path, and **no content**. Edits were already streamed to the server's replica as `UpdateBuffer` operations ([client](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/project/src/buffer_store.rs#L136-L165)). The [server handler](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/project/src/buffer_store.rs#L1465-L1504) waits for that version without a timeout, saves the replica's current text, and replies `BufferSaved { version, mtime }`.
- **Write.** [`LocalWorktree::write_file`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/worktree/src/worktree.rs#L1871-L1945) preserves line ending, encoding and BOM. [`RealFs::save`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/fs/src/fs.rs#L1137-L1153) creates parents, truncates the target in place, writes through a buffer and flushes. There is no temporary file, no fsync, and no disk check at write time. [`atomic_write`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/fs/src/fs.rs#L1091-L1135) exists but is not used for buffer saves. In-place writes keep the inode, mode, owner and hard links, but a crash can leave a partial file.
- **External edits and conflict.** The server watcher pushes the file's disk state and mtime to the client ([buffer store](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/project/src/buffer_store.rs#L492-L650)). A clean buffer reloads. A dirty one becomes [`has_conflict`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/language/src/buffer.rs#L2482-L2500), which means the disk mtime is newer and there are unsaved edits. Saving then [prompts](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/workspace/src/pane.rs#L2302-L2375) Overwrite, Discard Edits or Cancel. Conflicts are detected ahead of time from the watcher and mtime, and the write itself is last-writer-wins. A change that the watcher has not yet reported, or one that keeps the same mtime, is overwritten.
- **Reconnect and unknown outcome.** [`remote_client.rs`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/remote/src/remote_client.rs#L607-L815) uses a 5 s heartbeat, a bounded reconnect and a replay queue of unacknowledged messages on both sides. A lost `BufferSaved` is therefore replayed rather than surfaced as unknown. No receive-side dedupe was found, which is harmless only because a save means "write the current replica". On final disconnect, buffers become read-only. The daemon exits after 10 idle minutes, and a fresh (non-reconnect) proxy [replaces a running server](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/remote_server/src/server.rs#L981-L1010). Unsaved drafts survive a client restart through [local editor serialization](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/editor/src/items.rs#L1462-L1534) of the contents and mtime. On restore the draft is re-applied, and `has_conflict` catches disk changes.
- **Paths and read-only.** Buffer paths are worktree-relative and reject absolute paths or `..` escapes. Worktree roots are otherwise unrestricted, and symlinks are followed. The server marks unwritable files `Read`, but this agent found no writable flag in the client protos. Binary files are refused.

**What bigbud adopts:** a host-side writer, worktree-relative paths, preservation of line endings, encoding and BOM, watcher-driven conflict display with an explicit overwrite choice, client-side draft persistence that is reconciled on restore, and read-only state on disconnect.

**What bigbud deliberately does differently:**

- It sends content with a SHA-256 precondition enforced at write time, instead of a replicated buffer with no write-time check.
- It uses same-directory atomic replacement instead of in-place truncation.
- It uses operation IDs, typed `unknown` outcomes and read-back instead of transport replay.
- It uses durable Disconnect and generation fences instead of Zed's single proxy lifetime.
- It reports a negotiated, server-side writable capability.

Zed shows that remote editing needs a process on the host that owns the write. For bigbud, that is the existing remote agent or, after S4, the Rust SSH owner's verb. It is never an ad hoc TypeScript SSH command.

## Problem

A user can open a file in a plain Direct SSH project and see it, but cannot save it. The [recovery strip](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/FilePreview.editRecovery.tsx#L22-L25) shows "Read only" for `transport=direct-ssh`. Remote-agent projects are editable, but nobody has recorded acceptance of that path against a live host. It also has gaps that matter more over a network than locally:

- An "outcome unknown" save permanently blocks the draft until the app reloads, and the reload discards that draft.
- Drafts exist only in renderer memory.
- Editability is inferred from the target-ID string rather than from what the server actually composed.

## Goals

- Edit, Save and reopen a text file in a remote SSH project through the normal Files UI, with the saved bytes verified on disk.
- Never silently overwrite a change that was visible when the save checked the file, and never apply the same save twice after an ambiguous outcome.
- Keep the user's draft across a transport loss, reconnect, backend restart and app restart, until it is saved, resolved or deliberately discarded.
- A save never dials SSH, reconnects, or bypasses a durable Disconnect. No save uses ambient SSH, a TypeScript SSH launcher or a fallback route.
- Read-only states say why and offer the next action.
- No regression in local or remote-agent editing.

## Non-Goals

- No collaborative editing, CRDT/operation replication, three-way merge or remote LSP. These are Zed features that bigbud does not need for this.
- No binary, non-UTF-8, symlink or special-file editing. No create, rename or delete from the editor. Create-only remains a separate verb.
- No change to SSH ownership phases, the dev-only exception, Pre-cutover qualification, S4, transfer M0, or release lanes. Production Direct SSH editing does not ship before S4.
- No guarded-write support added to the legacy TypeScript SSH path, and no per-target production rollout.
- No live user profiles or hosts in tests.

## Current State

"Deployed" means the code is composed on a shipped production path. "Dev-only" means it is composed only under the selected development SSH owner profile. "Code-only" means it exists but is not composed for this purpose.

| Path                       | Status                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web eligibility            | Deployed                          | [fileEditEligibility.ts:13-33](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditEligibility.ts#L13-L33); [test cases](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditEligibility.test.ts#L7-L21)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Allows local targets and `ssh:` targets whose query has `transport=agent`, when there is a full read with a SHA-256 and the file is ≤ 512 KiB. This is string inference, not a server capability. `direct-ssh`, legacy `ssh:dev`, WSL and `remote-agent:` are refused.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Web save                   | Deployed                          | [fileEditDrafts.write.ts:33-114](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.write.ts#L33-L114); [state](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.state.ts#L3-L4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 650 ms autosave. Sends full contents, `expectedSha256` = base hash and a fresh `operationId`. Classifies errors as `not-dispatched`, `terminal` or `unknown`; only `not-dispatched` can be retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Web drafts                 | Deployed                          | [fileEditDrafts.state.ts:49](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.state.ts#L49); [fileEditDrafts.ts:15-22](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.ts#L15-L22), [116-119](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.ts#L116-L119), [211-224](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.ts#L211-L224)                                                                                                                                                                                                                                                                                                                      | Drafts live in a module-level `Map`. They survive closing the panel and a WebSocket reconnect, but not a reload or restart; `beforeunload` only warns. An `unknown` failure ignores any later read-back and can never be retried, so the only way out is a reload that loses the draft. Conflicts allow "Discard draft" only; there is no compare, overwrite or save-as-copy action.                                                                                                                                                                                                                                                                                                                    |
| WebSocket handler          | Deployed                          | [wsRpcHandlers.workspace.ts:21-48, 147-156](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/wsRpcHandlers.workspace.ts#L21-L48)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Maps conflict by operation name plus message regex, and passes `writeDisposition` through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Backend routing            | Deployed                          | [WorkspaceRuntime.ts:23-36](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace-runtime/Layers/WorkspaceRuntime.ts#L23-L36); [remoteAgentServerLayer.ts:332-399](/Users/youpele/DevWorld/bigbud/apps/server/src/remote-agent/remoteAgentServerLayer.ts#L332-L399)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | When agent composition is configured, agent targets (`isRemoteAgentExecutionTarget`) go to `RemoteWorkspaceRuntime` and everything else goes to the local `WorkspaceFileSystem`. Without that composition, every remote target uses the local layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Local conditional write    | Deployed                          | [WorkspaceFileSystem.write.ts:47-78, 165-200, 251-262, 287-321](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/Layers/WorkspaceFileSystem.write.ts#L47-L78)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Checks the hash, then writes a same-directory temporary file with the original mode and renames it over the target. It refuses a symlink and requires the real path to stay inside the root. A per-path semaphore serializes **bigbud's** writes only; there is a check-to-rename window against other writers. `realpath` on a missing file makes a guarded save of a deleted file fail as `terminal`.                                                                                                                                                                                                                                                                                                 |
| Remote-agent guarded write | Deployed (agent composition)      | [WorkspaceRuntime.remote.write.ts:21-104](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace-runtime/Layers/WorkspaceRuntime.remote.write.ts#L21-L104); [workspace_handlers.rs:241-287](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/session/workspace_handlers.rs#L241-L287); [files.rs](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/workspace/files.rs) (pre-E1 baseline; E1 split it into [files.write.rs](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/workspace/files.write.rs), [files.inplace.rs](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/workspace/files.inplace.rs) and [files.lock.rs](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/workspace/files.lock.rs)) | 512 KiB cap (also [core.rs:27](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/workspace/core.rs#L27)). Takes an advisory `flock` on a sibling `.bigbud-lock-<sha>` file, then: `fstatat(AT_SYMLINK_NOFOLLOW)`, regular-file check, hash compare (conflict returns `current_sha256`), `O_EXCL` 0600 temporary file, `fchmod` to the original mode, `fsync`, `renameat`, parent `fsync`. Missing parents are created. Owner, group, xattrs, ACLs and hard links are not preserved. Lock files are left in user directories. `expected_sha256` has been in the protocol since `workspace.write` first shipped (`5fa33decd2c`), so a guarded request never reaches an agent that ignores it. |
| Agent operation dedupe     | Deployed, memory only             | [operation_handlers.rs:185-215](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/session/operation_handlers.rs#L185-L215); [core.rs:128-130, 178](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/session/core.rs#L128-L130); [main.rs:240-244](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/main.rs#L240-L244)                                                                                                                                                                                                                                                                                                                                                                                                              | Up to 256 operation IDs per `AgentSession`, kept for 24 h. A failed write removes its entry. In supervisor mode one session is restored with a process journal, but the write dedupe table is not journaled: it is lost on agent restart or upgrade. **Verify** whether one session spans client reconnects in every agent mode.                                                                                                                                                                                                                                                                                                                                                                        |
| Direct SSH production      | Deployed (refuses guarded writes) | [WorkspaceFileSystem.write.ts:124-169](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/Layers/WorkspaceFileSystem.write.ts#L124-L169); [WorkspaceFileSystem.ts:97-113](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/Layers/WorkspaceFileSystem.ts#L97-L113)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Refuses `expectedSha256` and `createOnly` before dispatch. An unguarded legacy overwrite remains for other callers: `sh -lc 'mkdir -p … && cat > "$1"'` through `runToolCommand`, which truncates in place, is not atomic and has no hash. Legacy reads (`cat`) return no SHA-256, so the editor cannot reconcile them.                                                                                                                                                                                                                                                                                                                                                                                 |
| Dev SSH owner Files        | Dev-only, exact fixture root      | [ws.ts:63-71, 125](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/ws.ts#L63-L71); [wsSshOwnerDev.workspace.ts:58-59, 211-279](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/wsSshOwnerDev.workspace.ts#L211-L279); [write.rs](/Users/youpele/DevWorld/bigbud/crates/bigbud-ssh-owner/src/bin/ssh_owner/transport/workspace/write.rs)                                                                                                                                                                                                                                                                                                                                                                                                                              | Unguarded overwrite only, ≤ 48 KiB, fixture target and root only. Guarded and create-only writes are refused before dispatch. Native script: shared root walk, `mktemp` sibling, `cat`, `mv -f`, plus bounded success, failure and denied markers. Unconfirmed outcomes are `unknown` and never retried. Owner reads return no SHA-256, so the editor stays ineligible even here. `isWsSshOwnerWorkspaceTarget` matches **every** `ssh:` target, so in this dev profile agent targets are routed to the owner and refused too. That is acceptable only while the profile is fixture-only.                                                                                                               |
| Linux jump lane            | Dev-only, browse only             | [wsSshOwnerDev.ts:40, 71-73](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/wsSshOwnerDev.ts#L71-L73); [ledger](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-ledger.md#normal-linux-dev-browser-jump-selection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | "Folder browsing only". It has no Files, save or terminal eligibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Remote-backend window      | Deployed (P7)                     | [remote completion plan](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-17-remote-completion-plan.md) M2/WP-3B                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The backend runs on the host, so files are local to that backend and use the local conditional write. This is not an SSH editing path, but it is covered by the regression scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Text decoding              | Deployed                          | [WorkspaceFilePreview.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/WorkspaceFilePreview.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Uses fatal UTF-8 decoding and rejects NUL. `TextDecoder` strips a leading UTF-8 BOM by default, while the base hash covers the raw bytes, so saving a BOM file would probably drop the BOM. CRLF handling inside `@pierre/diffs-edit` is unverified. Both need fixtures in E1.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Design

### What guarded replacement guarantees

Plain SSH has no compare-and-swap rename. It also has no mandatory lock: an editor or `sed -i` on the host ignores bigbud's advisory lock. Compare-and-replace is therefore always check-then-rename. What it guarantees:

- **Against changes committed before the check:** detected as a conflict, and nothing is written.
- **Against other bigbud writers using the same lock:** serialized. A second save under the same base sees the new hash and conflicts. This is what makes a guarded retry after read-back safe on the agent path.
- **Against a non-cooperating writer in the check-to-rename window:** **lost update.** Their bytes are replaced. A writer that holds the old inode open and writes after the rename writes to an unlinked file, and that data is also lost from the path. The window is milliseconds on the agent and one script execution over SSH, but it is not zero.
- **Readers:** see the whole old file or the whole new file, never a torn file, on POSIX same-filesystem rename. Durability requires fsync of the file and the directory.
- **Lost identity under rename:** hard links would split, owner and group would become the writer's, and xattrs or ACLs would be dropped. Such files use the in-place mode instead (D3, decision 4).

The plan therefore promises "no silent overwrite of a change visible at check time, and an atomic replacement." It never promises "safe under concurrent writers." To narrow the window, re-check the hash immediately before the rename. After every successful save, read the file back and confirm the watcher's follow-up event matches the saved hash. Any mismatch becomes a visible conflict, never a silent success.

### D1. Negotiated capability and read-only UI

- The server reports `fileEdit` per (target, root) from the backend that is **actually composed**: `{ mode: "guarded" | "readOnly", maxBytes, reason? }`. Reasons include `directSshPendingOwner`, `ownerUnavailable`, `agentTooOld`, `disconnected`, `outsideRoot`, `notText`, `tooLarge`, `symlink` and `notRegular`. Contracts stay schema-only.
- Web eligibility uses this capability and stops parsing `transport=agent`. "Read only" shows the reason. Direct SSH before E3 also offers "Install the remote agent to edit", linked to the existing install flow.
- Remote agent: guarded writes need `workspace.write` 1.0, which every shipped agent advertises. E1 raises it to `workspace.write` **1.1** for the receipt query and result hash (decision 2), with no new capability name. A 1.0 agent keeps today's guarded write; only receipt queries are unavailable.
- Native owner: the editor is eligible only if Hello/grant advertises the `workspaceWrite.guarded` verb **and** the read verb returns a SHA-256.

### D2. Identity and path authorization

- A save is bound to the backend-authorized target, the root (an agent workspace handle or owner grant), a normalized relative path, the target generation, and the base hash observed by a full read from that same backend. Picker and folder-browse authority never grants write. A read→write grant split is required (backlog item 3).
- Refuse a final symlink or a non-regular file. Intermediate components must be resolved on the host without following links outside the root. The agent uses descriptor-relative operations. A shell walk over plain SSH is **not** race-safe ([contracts point 2](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-workspace-contracts.md)). Decision 3 accepts a check-then-rename script for Direct SSH with these races documented in E2 acceptance. No remote helper is required.
- An editor save must not create parent directories. It edits an existing file, so a missing parent or file is a conflict (`actual: missing`), not a create.

### D3. Atomicity and file preservation

Use a same-directory exclusive temporary file, write it, preserve permission bits, fsync it, rename it, then fsync the directory. Remove the temporary file on failure. **Exception (decision 4, Zed's behavior):** some files would be changed by a rename: hard-linked files (`nlink > 1`), and files whose owner or group differs from the writer or whose ACLs or xattrs a rename would drop. Those files are written **in place**, using the same lock and hash check, then a re-check, then truncate and write to the same inode, then `fsync`, then a read-back hash. This keeps links, owner and ACLs. The cost is the same as Zed's: a crash or lost connection mid-write can leave a partial file. The editor therefore treats an unconfirmed in-place write as `unknown` and requires read-back (D6). The result reports `writeMode: "inPlace"` so tests and the UI can tell the two modes apart. Clean up lock files, or move them to a private agent state directory keyed by device and inode (agent hygiene item in E1).

### D4. Expected version and conflict handling

- The version is the SHA-256 of the raw on-disk bytes, not mtime. Zed-style mtime/version vectors are not portable over plain SSH and can be fooled by coarse timestamps. Every guarded result returns the resulting hash, and every conflict returns the current hash.
- Conflict UI keeps the draft and adds **Compare** (draft vs disk), **Keep mine** and **Use disk version**. It never auto-merges.
- **Keep mine is in v1 (decision 5).** It is a new guarded write whose expected hash is the disk hash the user was _shown_, after an explicit confirmation. If the file changes again before the click lands, it conflicts again instead of overwriting the newer change. Zed's equivalent is the "Overwrite" button on its "This file has changed on disk since you started editing it" prompt. That button performs an unconditional in-place write ([pane.rs](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/workspace/src/pane.rs#L2302-L2375), [fs.rs](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/fs/src/fs.rs#L1137-L1153)), so a change made after the prompt appeared is overwritten silently. bigbud keeps the same choice for the user but binds the overwrite to what they actually saw.
- Map conflicts by a typed field from the backend, not message regex (the [handler](/Users/youpele/DevWorld/bigbud/apps/server/src/ws/wsRpcHandlers.workspace.ts#L21-L48) regex is retired).

### D5. Drafts across reconnect and restart

**Decision 1:**

- Remote files use the same autosave as local files (650 ms after the last keystroke). On a remote project, "saved" means the remote host acknowledged the guarded write. The status reads "Saved to host", never just "saved locally".
- A local copy of remote contents exists only for a draft the host has **not** acknowledged: pending, saving, unknown, conflict or error. The copy is deleted as soon as the host acknowledges, or on Discard, Use disk, or Forget of the project or target.
- That copy expires **10 minutes** after its last edit or save attempt. 5 minutes was also offered; 10 is chosen as the safer default for short network drops, and the value is a single named constant.

**Implementation:**

- Use renderer storage with backend-scoped keys (WP-3C pattern). The key is (backend profile, target ID, root, relative path). Each record stores the contents, base hash, last attempt (operation ID, attempted hash, disposition) and a timestamp.
- Bounds: 512 KiB per draft and at most 100 records. A record over budget is refused with a visible message, never dropped silently.
- **Consequence to disclose:** if the host stays unreachable for more than 10 minutes, the stored copy expires. While the app stays open, the in-memory draft is kept and the editor says "Not saved to host — will be lost if bigbud closes". After restart, nothing older than 10 minutes is recovered.
- On restore within the window, the draft is "Recovered" and cannot be saved until a fresh full read in the current generation reconciles it, using the existing `observeFileEditRead` rules.
- Local files keep today's behavior. This retention applies to remote targets only.

### D6. Unknown outcome: read back before retry

- Never retry an `unknown` save automatically. Resolve it explicitly:
  1. Read the full file in the current generation. If hash = attempted hash, the save landed: mark it saved and re-base the draft.
  2. Agent with `workspace.write` 1.1: query the receipt for the `operationId`. If none is found and the agent epoch is unchanged, or the receipt is final, the write did not land. The draft can be retried as a **new** guarded write against the base hash.
  3. Without a receipt, if the fresh read shows the **original** bytes (hash = base hash), allow an explicit retry as a **new** guarded write (new `operationId`) against that same base hash. Re-sending the same `operationId` is not possible: the server's durable write journal ([remoteAgentWorkspaceMutation.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/remote-agent/remoteAgentWorkspaceMutation.ts)) deliberately refuses replay. The new write is still safe, because the original and the retry both check the same base hash and the writer serializes them (agent directory lock, local per-path semaphore): whichever runs second sees changed bytes and conflicts, so the two can never both apply. If the read shows other bytes, the draft becomes a verified conflict (corrected 24 November 2026 during E1).
  4. Plain SSH (E2): the remote script may still run after a local disconnect. The owner must name the staged temporary file deterministically from the `operationId`. "Unknown" resolves only after the owner confirms the remote command exited, or read-back shows the attempted hash, or the staged file is absent **and** a lock-protected guarded retry is used. Without the owner's lock primitive, resolution is "user reviews disk and confirms", never automatic.
- E1 replaces today's permanent block: [fileEditDrafts.ts:116-119](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.ts#L116-L119) is changed to run this resolution, and [`retryFileEditDraft`](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.ts#L211-L224) gains a "resolve unknown" path. Edits made during resolution stay pending.

### D7. Durable Disconnect and generation fencing

- Saves are admitted only for a connected target in the current generation. Autosave never triggers Connect, a reconnect or an SSH dial. While disconnected, pending drafts stay pending with "Saves paused: disconnected".
- If Disconnect commits while a save is in flight, the save is either acknowledged on the same connection before teardown or it becomes `unknown`. A late acknowledgement from an older generation or agent epoch is evidence for read-back only, never a direct "saved".
- After explicit Connect, drafts with an `unknown` attempt run D6. Plain pending drafts resume autosave only after a fresh reconciling read.

### D8. Limits and file types

Text only: fatal UTF-8 with no NUL, ≤ 512 KiB to edit and ≤ 5 MiB to preview. Preserve a UTF-8 BOM and the existing line endings byte-for-byte, with fixtures in E1. Refuse symlinks and special files. Hard-linked and foreign-owned files are written in place (D3). The native owner must stream or chunk content inside its 64 KiB client→owner frames up to 512 KiB, with one digest-bound grant ([contracts point 1](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-workspace-contracts.md)). The 48 KiB proof cap is not a product limit.

### D9. No ambient SSH, no fallback

- A guarded write never degrades to an unguarded overwrite on any path, and an unknown or refused agent save never reroutes through SSH `cat`.
- The legacy TypeScript SSH path is not extended. After S4 it is deleted, according to the ownership plan.
- If the native owner or agent is unavailable, the file is read-only with the reason. Local editing is unaffected.

## Phases

### E0 — Freeze the contract (schema and docs only)

Add schemas for the `fileEdit` capability, typed conflict fields (`conflict`, `currentSha256`, `resultSha256`), and the receipt query in `@bigbud/contracts` subpaths. Write golden vectors for the D2 grant binding. Add the editor's guarded write and receipt rows to the S0 workspace contracts (C05) without changing other rows. Expected result: reviewed contracts with no behavior change.

### E1 — Harden and qualify the deployed local and agent paths

1. Server capability reporting (D1) and web eligibility from capability; retire string inference, keeping identical outcomes for local and agent.
2. Unknown-outcome resolution (D6 steps 1 and 3) for local and agent, plus a receipt query and result hash in the agent, advertised as `workspace.write` 1.1 (D6 step 2).
3. Durable drafts (D5) and Disconnect fencing in the editor (D7).
4. Conflict UI (D4) and typed conflict mapping.
5. Agent hygiene: no parent creation for editor saves, lock-file placement and cleanup, the in-place mode for hard-linked or foreign-owned files, re-check before rename (D3). Local path: apply the same mode selection, and let a deleted file report a conflict instead of a terminal failure.
6. BOM and CRLF preservation fixtures and fixes (D8).

Expected result: remote-agent editing passes the live acceptance below on disposable Linux and macOS hosts, with local editing unchanged.

### E2 — Native guarded write in the dev-only Files slice (with S3 backlog item 3)

Requires E0. Must not start before the ownership plan's Files slice is current; it runs inside that slice's order (picker → files → terminal) and evidence rules.

1. The owner read verb returns a SHA-256 over the exact bytes read.
2. A new `workspaceWrite.guarded` verb with chunked content up to 512 KiB, a digest-bound grant, generation, an `operationId`-derived staging name, hash re-check before rename, typed `conflict`/`terminal`/`unknown` outcomes and the resulting hash. A required tool must be qualified per host profile (for example a SHA-256 utility and `mktemp`): a host without it is `readOnly: hostToolUnavailable`, with no fallback.

   Recommended script shape (decision 3), as one remote execution:
   1. Take a `mkdir`-based lock next to the file, named from the path hash. `flock` is not standard on macOS. A lock left by a crashed run is reclaimed only if it carries the same `operationId` or is older than the write timeout.
   2. Hash the target and compare it with the expected hash.
   3. Write the staged sibling `.bigbud-edit-<operationId>`, set its mode, and `fsync` it where a sync utility is available.
   4. Re-hash the target right before `mv -f`. For a hard-linked or foreign-owned file (decision 4), instead re-hash and then write the bytes into the existing file in place (`cat >` the same path), with no rename.
   5. Remove the lock and print a bounded marker with the resulting hash.

   Accepted limits, recorded in acceptance: a non-cooperating writer between the re-hash and `mv` in step 4 loses its change; the shell path walk is not race-safe; durability depends on the host's `sync`. This is still stronger than Zed's save, which does no check at write time and truncates in place.

3. Route it in `wsSshOwnerDev.workspace.ts` for the fixture target and root only. Keep refusing guarded writes on every other route. Narrow `isWsSshOwnerWorkspaceTarget` to direct SSH targets if agent targets must stay editable in that profile.
4. Record evidence in the ledger under C05. This does not accept S3 and does not enable production.

Expected result: on a disposable host in the dev profile, Direct SSH editing passes the same acceptance as E1, with zero legacy launches.

### E3 — Production Direct SSH editing at S4

Production enables guarded Direct SSH writes only as part of the single all-consumer S4 activation, after Pre-cutover qualification. S4 acceptance records `workspaceWrite.guarded` with its limits and typed errors in the owner capability set. Until then the capability reports `readOnly: directSshPendingOwner`. No per-target or early production rollout.

## Risks And Decision Gates

- **Lost update from non-cooperating writers** is inherent (see the guarantees above). Mitigate it with the pre-rename re-check, post-save read-back and watcher reconciliation, and disclose it in the docs. Do not claim linearizable saves.
- **Remote work outliving disconnect** on plain SSH can apply a write after the UI has given up. D6 step 4 and the deterministic staging name are required before E2 is accepted.
- **Pressure to ship Direct SSH early** through legacy TypeScript: rejected by the ownership decision record. Use the agent route instead.
- **Agent upgrade skew:** receipt support is gated on `workspace.write` 1.1, and 1.0 agents keep guarded write without receipts.
- **Persisted drafts:** remote contents are kept locally only while unacknowledged and for at most 10 minutes (D5). A longer outage loses the stored copy, so the editor must say so.
- **Gates:** E1 needs no SSH-owner gate. E2 is gated by the dev-only exception and the Files slice. E3 is gated by Pre-cutover qualification and S4 acceptance. None of them affects transfer M0.

## Testing And Validation

Focused checks only. Ask before any workspace-wide check.

- **Unit and integration:** `bun run --cwd apps/web vitest run src/components/files/fileEditEligibility.test.ts src/components/files/fileEditDrafts.test.ts src/components/files/fileEditDrafts.recovery.test.ts`; `bun run --cwd apps/server vitest run src/workspace-runtime/Layers/WorkspaceRuntime.remote.test.ts src/workspace/Layers/WorkspaceFileSystem.test.ts src/ws/wsSshOwnerDev.workspace.test.ts`; `cargo test --locked -p bigbud-remote-agent <workspace-write-filter>`; for E2, `cargo test --locked -p bigbud-ssh-owner <workspace-write-filter>`. Add new tests for capability, unknown resolution, receipts, BOM/CRLF, `nlink`, missing parents and Disconnect races.
- **Browser:** extend [FilePreview.edit.browser.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/FilePreview.edit.browser.tsx) and [FilePreview.editRecovery.browser.tsx](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/FilePreview.editRecovery.browser.tsx) via `bun run --cwd apps/web test:browser <file>`.
- **Static:** scoped oxfmt, oxlint, package typechecks, Clippy for affected crates and the 400-line check on changed files.

## Acceptance Criteria

Record each item with host OS and architecture, transport, agent or owner version, and evidence paths. Use disposable hosts and fixture keys only.

1. **Normal UI round trip (agent in E1, Direct SSH in E2/E3):** in the real Files UI, open a text file, edit, Save, close and reopen it, and see the edit. On the host, `sha256sum`/`shasum -a 256` equals the reported result hash. Mode is unchanged. No temporary or lock files are left behind.
2. **External change:** with a draft pending, modify the file on the host. Save reports a conflict with no write, keeps the draft, and Compare / Keep mine / Use disk each produce exactly the expected disk bytes.
3. **Unknown outcome:** withhold the acknowledgement after commit (fault injection), then do the same before commit. The UI shows outcome unknown and blocks retry. Resolution by read-back marks the first case saved and makes the second retryable. The disk shows exactly one application, and the operation log shows no duplicate write.
4. **Disconnect and restart:** Disconnect with a pending draft and with a save in flight. Restart the backend, then the app. The draft survives, no SSH dial occurs while disconnected (trace), explicit Connect reconciles, and a stale-generation acknowledgement does not mark the draft saved.
5. **Refusals:** symlink, outside root, non-UTF-8, BOM/CRLF preserved, over 512 KiB, missing file and agent too old all show the stated read-only or conflict reason, with no dispatch.
6. **In-place mode (decision 4):** edit a hard-linked file and a group-writable file owned by another user. After Save, both link names show the new bytes, the inode, owner, group and mode are unchanged, and the result reports `inPlace`. A conflict injected before the write leaves the file untouched.
7. **Regression:** local editing (including the remote-backend window) and agent editing pass the existing browser and unit suites unchanged. Production Direct SSH stays Read only until E3, with zero legacy `runSshCommand` writes from the editor.
8. SSH ownership, transfer, release and cutover gates are unchanged, which is confirmed by review against the ownership plan and backlog.

## Implementation status (E0–E1, 24 November 2026)

These changes are uncommitted in the shared `dev` checkout. They are implementation evidence, not acceptance: the live criteria below have not been run on a disposable host. An independent code review found 16 issues; the fixes are listed here and the leftovers are under "Not done".

- **E0 contracts.** [project.ts](/Users/youpele/DevWorld/bigbud/packages/contracts/src/workspace/project.ts) adds `ProjectFileEditCapability` (the optional `edit` field on preview results), with reasons `directSshPendingOwner`, `agentTooOld`, `ownerUnavailable` and `unsupportedTarget`. It also adds `resultSha256` on write results and `currentSha256` on write errors.
- **D1 capability.** The local backend reports `guarded` for local targets and `readOnly: directSshPendingOwner` for SSH targets that reach it ([fileEditCapability.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace-runtime/fileEditCapability.ts)). The agent backend reports `guarded` only when the agent advertises `workspace.write`, otherwise `readOnly: agentTooOld`. The web uses the capability when present ([fileEditEligibility.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditEligibility.ts)) and falls back to the target-ID rule only for older servers. "Read only" shows the reason as a tooltip.
- **D3/D8 writes.**
  - **Local** ([WorkspaceFileSystem.write.conditional.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/Layers/WorkspaceFileSystem.write.conditional.ts)):
    - fsyncs the temp file and the directory, and re-checks the hash before the rename;
    - reports a read-back hash;
    - writes hard-linked or foreign-owned files in place, Zed-style: a full write, then fsync, then read-back; any failure after the truncate is reported as `unknown`;
    - keeps an owned file atomic when only its group differs, restoring the group;
    - reports a file deleted mid-save as a conflict;
    - holds the guarded section uninterruptibly, so its lock is kept until the write settles.
  - **Agent** (`workspace.write` 1.1):
    - guarded writes don't create parent directories;
    - verifies the bytes it wrote by reading them back before reporting success; a mismatch fails with `WRITE_VERIFICATION_FAILED`;
    - uses the same in-place and group rules as the local path; a failure after the truncate returns `UNKNOWN_OUTCOME`;
    - locking takes the parent-directory `flock` where the filesystem supports it, plus the per-path `.bigbud-lock-*` file. The lock file stays so that NFS mounts and older agents still exclude each other; lock files are reused, never deleted;
    - lock waits are bounded at 10 s (`WRITE_LOCK_TIMEOUT`, nothing written).
  - **Encoding:** a UTF-8 BOM and CRLF line endings survive an edit and save.
- **D4/D6 conflicts and unknown outcomes.** Conflicts are typed end to end (the message regex is retired). **Compare** shows the verified disk version beside the draft. **Keep mine** saves against exactly the hash shown in Compare, and is refused if a refresh moved the disk version. An unknown save is resolved by a fresh read: the attempted bytes mean saved; the original bytes allow an explicit retry as a new guarded write (corrected D6 step 3); anything else is a conflict. A result hash that differs from the bytes sent is never shown as saved; it triggers a read-back.
- **D5 drafts.** Remote drafts the host has not acknowledged persist in backend-scoped storage ([fileEditDrafts.persist.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.persist.ts)):
  - only edits and save attempts extend the 10-minute window; expired records are physically removed;
  - records are validated, and attempt contents aren't stored twice;
  - a draft over the budget, or dropped because storage is full, shows "will be lost if bigbud closes";
  - local drafts are never stored;
  - recovered drafts can't be saved until a fresh read reconciles them;
  - remote saves show "Saved to host".
- **`workspace.write` versions.** 1.1 means a result hash on success. 1.2 adds the write receipt query (frames 108/109 in [v1.proto](/Users/youpele/DevWorld/bigbud/protocol/remote-agent/v1.proto)).
- **D6 step 2, receipts.** When a guarded remote save loses its response, the server resolves a fresh client once (10 s bound) and asks the agent whether that exact operation (same operation ID and request digest) was applied ([WorkspaceRuntime.remote.writeReceipt.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace-runtime/Layers/WorkspaceRuntime.remote.writeReceipt.ts)).
  - Only a proven "applied" (with the recorded result hash) turns the outcome into success and settles the durable write journal.
  - "Not found", an agent older than 1.2, a resolve failure or a timeout keep the outcome unknown; the editor's read-back rule then applies.
  - The write itself is never resent.
  - Receipts live in the agent session's memory: they survive client reconnects in supervisor mode, but not an agent restart.
- **D7 Disconnect.** While a target is user-disconnected, autosave does not dispatch (so it cannot dial) and shows "Saves paused" ([fileEditDrafts.connection.ts](/Users/youpele/DevWorld/bigbud/apps/web/src/components/files/fileEditDrafts.connection.ts)). After Connect, the draft is re-read first. Autosave resumes only if the host still has the base version; otherwise the draft becomes a conflict. Stale-generation acknowledgements are fenced by the transport and the server's write journal, not by the editor.
- **D5 Forget.** Removing a project drops its drafts from memory and storage.
- **Agent fix.** A write naming an unknown workspace handle left its operation accepted, so a retry was answered as a successful duplicate without writing. It now releases the operation (regression test in [workspace_write.tests.rs](/Users/youpele/DevWorld/bigbud/crates/bigbud-remote-agent/src/session/workspace_write.tests.rs)).
- **Real-agent evidence (macOS arm64, not SSH).** [WorkspaceRuntime.remote.realAgent.test.ts](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace-runtime/Layers/WorkspaceRuntime.remote.realAgent.test.ts) runs a freshly built `bigbud-remote-agent` in ephemeral mode on a temp workspace through the real server save path. Opt in with `BIGBUD_TEST_REMOTE_EDIT_AGENT_BIN=<absolute path>`. Seven cases pass:
  - open, save and reopen, with exact bytes and mode on disk;
  - an external change is refused and its bytes are kept;
  - two saves against one version never both apply;
  - a hard-linked file is edited in place, keeping its inode;
  - a BOM and CRLF line endings are kept;
  - a missing file or its parents are not created;
  - a receipt is answered for an applied save and refused for an unknown operation.
- **Not done:**
  - Reporting whether a write was atomic or in place.
  - ACL/xattr detection.
  - The client reads the negotiated capability minor through a private connection field. A public accessor should replace it once the other thread's connection changes land.
  - Linux run of the real-agent test.
  - **Manual Files UI acceptance over SSH on a disposable host.**

## Files: create and delete (24 November 2026)

**Status:** Implemented in the working tree, pending a manual dev-app test. Remote hosts need an agent rebuilt from this checkout.

### Decisions (user, 24 November 2026)

1. **One add button** in the Files panel header (`FileAddIcon`). It opens a small menu with **New file** and **New folder**. An inline name input then appears in the target folder: the folder last opened in the tree, or the workspace root. Enter creates; Esc cancels. A new file opens in the editor. A name that already exists shows an inline error and nothing is overwritten.
2. **Delete** is one action for files and folders, on local and remote-agent projects. It always asks first. A file prompt reads "Delete README.md?". A folder prompt names the folder and says everything inside is deleted too. Local deletes move to the system Trash. Where the Trash is unavailable, the item is deleted permanently and the prompt says so. Remote-agent deletes are permanent and the prompt says "This can't be undone." There is no checkpoint offer in v1.
3. **Context menu:** a destructive **Delete…** item sits right before **Restore path checkpoint**. Dividers group the items: open | copy | capture checkpoint | Delete… and Restore path checkpoint.
4. **Direct SSH stays read only** for create and delete. The controls are disabled with the existing read-only copy (`FILE_EDIT_READ_ONLY_COPY`).

### Design

- **Capability:** a new `projects.entryActions` RPC reports, for each workspace, whether create file, create folder and delete are allowed and whether delete is permanent. The web does not parse target IDs. Local backend: allowed. Legacy Direct SSH backend: read only. Agent: read only for an action the agent does not advertise (`agentTooOld`), and `ownerUnavailable` when it cannot connect.
- **Create file:** the existing `projects.writeFile` with `createOnly: true` and empty contents. The name must be a single path segment, so no parents are created.
- **Create folder:** `projects.createDirectory`. Locally this is a non-recursive `mkdir` in a real parent inside the realpath of the root, and it fails if the entry exists. On the agent it is `CreateDirectoryRequest/Response` (frames 110/111, capability `workspace.mkdir` 1.0): `mkdirat` relative to a parent opened with `O_NOFOLLOW` at every component.
- **Delete:** `projects.deleteEntry`, which carries the kind the user saw. Locally the parent's realpath must be inside the root's realpath, and the workspace root is refused. A symlink is removed as a link, never followed, and a kind mismatch is refused. The item goes to the Trash (macOS `/usr/bin/trash`, Linux `gio trash`, Windows Recycle Bin via PowerShell); otherwise it is removed with `unlink` or a recursive `rm` that does not follow symlinks. On the agent it is `DeleteEntryRequest/Response` (frames 112/113, capability `workspace.delete` 1.0), descriptor-relative: `fstatat(AT_SYMLINK_NOFOLLOW)`, links unlinked, directories walked with `O_NOFOLLOW`, and a bounded count pass (depth and entries) runs before anything is removed. Both agent requests use `operationId` and a request digest like writes, so a duplicate is answered without acting twice.
- **Refusals:** the legacy local backend reached with an `ssh:` target refuses create folder and delete as `not-dispatched` and never shells out. The dev SSH-owner router (`wsSshOwnerDev.workspace.ts`) is not changed. Its listings carry no actions, and the new RPCs bypass it.
- **Refresh:** the server invalidates workspace entries after each mutation, and the web reloads the parent folder.

### Phases

- **F1 contracts and server:** contracts, WS RPCs, local create folder and delete with Trash, and server tests. Done.
- **F2 agent protocol:** `.proto`, Rust handlers and workspace operations, TS codec and client, golden vectors, and Rust and TS tests. Done.
- **F3 web:** the header add menu, the inline input, Delete in the context menu with dividers, the confirmation dialog, and Direct SSH gating, with logic and browser tests. Done.
- **F4 manual acceptance:** create and delete locally (Trash) and on a disposable host with a rebuilt agent; confirm Direct SSH shows the controls disabled. Pending.

## Decisions (24 November 2026)

1. **Draft retention:** remote files autosave like local files, and a save means the host acknowledged it. Only drafts the host has not acknowledged are kept locally, for at most 10 minutes (D5).
2. **Capability:** extend `workspace.write` with a minor version (1.1). There is no new capability name.
3. **Direct SSH write:** a check-then-rename script with documented race limits is accepted. There is no remote helper. The recommended shape is in E2.
4. **Hard-linked or foreign-owned files: do what Zed does.** These files are written in place, like Zed's [`RealFs::save`](https://github.com/zed-industries/zed/blob/6501df15765d66d6c2a2b66b1eb22434ccef3f86/crates/fs/src/fs.rs#L1137-L1153). The same file is truncated and rewritten, so hard links stay together and owner, group and ACLs are kept. The bigbud lock and both hash checks still apply (D3).
5. **Keep mine:** in v1, as a hash-bound overwrite of the disk version the user was shown (D4).

## Open Questions

None at present. If evidence shows that whole-file in-place writes should replace atomic rename everywhere, that would be a new decision; it is not assumed here.
