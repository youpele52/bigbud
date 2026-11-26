# SSH-owner v1 fixture verification

Run from the repository root after installing the repository's Bun dependencies. The Rust verifier is an isolated, test-only Cargo package. It compiles `v1.proto` with prost and vendored protoc; it does not need a system `protoc`, the product Rust workspace, or a running SSH server. Omit `--offline` on the first run if the locked Rust dependencies are not cached.

```sh
bun run vitest run --config protocol/ssh-owner/vitest.config.ts protocol/ssh-owner/v1.golden.test.ts
bun run --cwd apps/server tsc -p ../../protocol/ssh-owner/tsconfig.verify.json
cargo test --offline --locked --manifest-path protocol/ssh-owner/verify-rust/Cargo.toml --test goldens --test grant_admission
```

`v1.golden.frames` contains `name=hex` records with a four-byte unsigned big-endian length followed by the protobuf `Frame`. Both verifiers independently encode the expected fields and check the stored bytes on read. The Rust verifier decodes into generated types; the TypeScript verifier uses the existing low-level protobuf reader/writer and checks the expected fields and presence. Review changes to these fixtures as wire changes, not routine snapshot refreshes. To independently derive a positive payload, feed the corresponding textproto to `protoc -I protocol/ssh-owner --encode=bigbud.ssh_owner.v1.Frame protocol/ssh-owner/v1.proto` and prepend its byte length.

The negative records cover bad lengths, malformed protobuf, unknown payload/operation/outcome tags, and an unknown error code. These unknown values all use `127`, reserved in `Frame`, `Request`, `Reply`, and `ErrorCode` so a new operation cannot silently turn the fixture into a valid request. The grant and SQLite vectors cover private channel messages in both directions, including a refused storage acknowledgement. The S1 control slice uses directional payload ceilings: **64 KiB client → owner** and **8 MiB owner → client**. The four-byte prefix is additional. The two parsers check the exact cap and cap-plus-one using shared header-only vectors, before reading a payload. Clients select the inbound ceiling from the local endpoint role, not from the received kind. The request cap leaves room for the existing 4,096-character picker path, its UTF-8 bytes, target ID and the control envelope. The reply cap leaves room for bounded legacy stdout, replacement of invalid UTF-8, resolved/home path metadata and per-entry protobuf overhead; it does not increase the picker script's 1 MiB stdout limit. Reject an oversized request locally rather than truncating an identifier or operand; verify that supported saved target/config shapes fit before cutover.

An unsupported major, a missing folder metadata field, and a duplicate request ID with changed path are intentionally representable on the wire. These bytes are inputs for owner/adapter validation, not proof that a live owner rejects them. In particular, an explicitly present `truncated: false` is not the same as missing `truncated`.

## Operand digest vectors

`v1.golden.operands` records a candidate S0 encoding, not an owner admission or persistence contract. Hash the exact ASCII prefix `bigbud.ssh_owner.v1/operands` followed by a NUL byte and the canonical protobuf encoding of the **single selected operation field** from a fresh v1 `Request`. The operation tag is part of the hash input; no request ID, epoch, generation, target ID, grant, or frame header is included. Those bindings must be checked separately. Use SHA-256 over these bytes, not over the originally received protobuf.

- `inspectTrust`, `connect`, and `disconnect`: each is represented by its distinct operation field with an empty body. An empty body is not an omitted operation.
- `approveTrust`: the synthetic opaque challenge bytes are included unchanged.
- `listFolders`: an omitted and an explicitly empty path are the same home operand and normalize to an absent path field. A nonempty path is encoded as supplied in UTF-8. Do not trim, Unicode-normalize, resolve paths, or infer other equivalences for this digest.

## S1 admission invariants

The Rust admission fixture binds synthetic authenticated peers to owner sessions before evaluating a request. The UI control adapter can inspect and approve trust and request Connect/Disconnect; the picker adapter can only list folders. Resolve class, resource and activity origin from authenticated channel or grant state. Treat the submitted grant as an opaque token, never client-authored scope. Only the authenticated dispatcher can mint a grant after product authorization.

Resolve a grant against the session, profile, owner epoch, current target generation, resource, verb, expiry and canonical operand digest before any side effect. Check authorization before returning target state to a caller. A valid grant does not bypass Disconnect: inspect, approve, and list must all fail without accessing the network. Durable Connect/Disconnect transitions have a separate privileged storage path. They cannot be acknowledged on the basis of a control receipt alone.

Consume one-shot grants before dispatch and scope request IDs to the authenticated session. A matching, retained receipt can be returned without dispatch. A changed request using the same ID, a consumed grant on a new ID, or a foreign session cannot trigger a second dispatch. If a receipt is lost, expired or no longer provable, do not issue a new ID to retry an ambiguous mutation. The fixture supplies time, credentials, and resource liveness as test inputs and counts a dummy transport call; it does not implement authentication, live leases, cancellation, or durable receipts.

The fixture verifiers above open no sockets and execute no SSH. The live picker proof exercises inherited handles, one-shot grants and the SQLite handshake. The Unix attachment fixture requires a private socket, an OS peer check and mutual proof of the inherited capability. A replacement client must hydrate storage before admission reopens. These are isolated proofs, not S0 release qualification or a complete S1; runtime cancellation and later catalog operations remain open.

## Live isolated picker proof

From the repository root on non-root macOS with the system OpenSSH client and server:

```sh
cargo build --offline --locked -p bigbud-ssh-owner --bin bigbud-ssh-owner
cargo build --offline --locked -p bigbud-remote-agent --bin bigbud-remote-agent
BIGBUD_TEST_SSH_OWNER_PICKER_PROOF=1 bun run --cwd "$PWD/apps/server" vitest run \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.attachment.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.rollback.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.workspace.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.workspaceLifecycle.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.health.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.websocket.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.git.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.terminalReservation.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.agentProxy.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.agentProxyLifecycle.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.terminalAdapter.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.admission.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.hashedTrust.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.locale.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.cwd.test.ts" \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.terminalRestart.test.ts"
```

The test copies the owner binary to a disposable profile and runs it under a sandbox with one loopback destination. The picker cases use the registered folder-picker request and handler in a test-only RPC group; the separate WebSocket case uses the production route, token check and protocol with isolated layers, not normal app startup. Rust owns the host-key check and launches real system OpenSSH. The TypeScript fixture passes typed requests and executes the existing fenced storage adapter against the profile's real SQLite file. The proof-only channel fields use inherited handles, a profile-domain lock, and one trusted dispatcher; they are not renderer routes or a production attachment or authorization API.

The opt-in flow fails if the binary or daemon cannot start. It covers unknown-host denial, exact-key acceptance, swap between observation and approval, loss and recovery of the loopback listener, durable Disconnect across a new owner and DB binding, changed pinned host, competing owner, forced owner death, missing owner, and version mismatch. There is no TypeScript SSH fallback. Only a direct IPv4 loopback destination, one Ed25519 key, and one private known-hosts file are supported. The alias case resolves a bounded config with `Host` patterns and `HostKeyAlias`, invalidates approvals on observed policy changes, denies applicable `Match exec` before network work, and opens a fresh connection without reusing or closing a separately owned master. The alias includes are restricted to private, bounded files inside the fixture root. A changed include or a new glob match invalidates the frozen policy. This does not cover ambient/system sources, multiple identities or jump/proxy routes. The attachment tests keep the same owner and a real OpenSSH PTY alive across a lost SQLite acknowledgement. A replacement client must authenticate and hydrate the committed flag; the owner confirms the old child exited before completing the rebind. No picker connects until explicit Connect, and the revoked lease cannot close a replacement PTY. The PTY uses a fixed loopback command with a bounded lifetime and no client-supplied input; it does not prove user pane persistence or full terminal migration. A successful new listing after an outage is not an in-flight reconnect guarantee. The rollback rehearsal alternates the real legacy source Bun backend and the Rust proof on the same disposable database. It checks that re-upgrade respects current legacy flag membership rather than an older receipt. This is not the released A/B artifact or production pane-record proof. Full packaged traces remain open. See the [manual test runbook](/Users/youpele/DevWorld/bigbud/protocol/ssh-owner/MANUAL-TEST.md) for macOS commands and Windows inbox preflight; the Windows targets were cross-checked for the portable library, not executed.

## Isolated workspace file consumers

The [workspace owner service](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/Services/WorkspaceFileReadOwner.ts) is supplied only by the isolated test. The real workspace file preview and byte-range consumers still resolve scope through `WorkspacePaths`; only direct SSH then delegates to the owner. A failure in the selected owner never falls back to a legacy command. Normal composition, local reads, and remote-agent reads are unchanged.

The proof owner binds the workspace root at launch and accepts only preview or range operands. The live fixture covers a quoted filename, the exact 5 MiB preview cap, a binary byte range, EOF, root mismatch, and static symlink refusal. The [directory owner service](/Users/youpele/DevWorld/bigbud/apps/server/src/workspace/Services/WorkspaceDirectoryReadOwner.ts) uses a separate root-bound listing request with a 10-second deadline and a 4 MiB capture limit. Rust returns only complete immediate-child file or directory records; the workspace consumer retains legacy normalization, root-level ignore rules and directory-first sorting. The live fixture covers root and nested listings, quoted names, symlink refusal, Disconnect and owner failure without fallback. These fixed recipes do not defend against concurrent remote path replacement or qualify search, writes, or watchers.

## Isolated terminal and remote-agent consumers

The direct-terminal application port uses the existing durable owner store to record an exact target, owner epoch, target generation and lease before dispatch. A separate live proof prepares without starting SSH, rejects a cancelled or consumed token, and opens a fixed command at the approved scope and dimensions. The live PTY accepts sequenced input and resize, and never interprets fixture input as shell code. It is not a production pane implementation.

The remote-agent application port returns a binary duplex lease, separate diagnostics, and confirmed teardown. The native proof carries bytes on separate inherited pipes and runs a real ephemeral macOS agent over pinned OpenSSH. It requires an exact preapproved executable hash and refuses to reuse consumed pipes. The normal managed-runtime validator is unchanged; the real Linux managed-supervisor proxy and persistent stream reattachment are not qualified by this fixture.

## Private SQLite transition digest

The storage transition digest is separate from the picker operand digest. Hash the ASCII string `bigbud.ssh_owner.v1/sqlite-transition` plus NUL, then the target's UTF-8 byte length as an unsigned four-byte big-endian number, the exact target bytes, the expected sequence as unsigned eight-byte big-endian bytes, and a single desired-state byte (`0` connected, `1` disconnected). Store lowercase SHA-256 hex. The epoch and request ID are authenticated and compared separately inside the transaction; they are not part of the digest. The expected sequence must be at most `2^53 − 2`, leaving one exact TypeScript integer for the committed sequence. Four shared vectors cover both states, a changed sequence and a Unicode target near the upper bound. This encoding does not by itself prove a durable commit, writer ownership, or receipt recovery.
