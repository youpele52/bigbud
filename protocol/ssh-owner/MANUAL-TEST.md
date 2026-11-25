# SSH owner manual test runbook

**Development handoff:** Run just one opted-in normal app at a time. Start with the macOS instructions below; the isolated proof commands are separate and do not count as normal-app verification. S0 is closed for contracts and local baselines; release evidence remains deferred to the hard Pre-cutover qualification gate. No production owner is active, no S1–S4 phase is accepted, and transfers stay gated. See the [ownership plan](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-plan.md) and [qualification ledger](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-ledger.md).

## macOS: normal-app dev opt-in

From `/Users/youpele/DevWorld/bigbud`, run `BIGBUD_SSH_OWNER=1 bun run dev:desktop`. For the browser, use `BIGBUD_SSH_OWNER=1 bun run dev` and open the web URL printed by the dev runner. Both build or locate the native owner automatically and open the normal app on a fresh private development profile. No live SSH host, user key, or existing bigbud profile is used.

1. In **Projects → Remote Workspaces**, click **Add remote workspace**. Select **From SSH config → rust-ssh-owner-dev** and keep **Direct SSH** selected. The dialog shows **Rust SSH owner (development)**. Click **Connect**, then **Browse**. Check and approve the disposable host fingerprint. Open **picker's folders; literal**, click **Use this folder**, then **Add remote workspace**.
2. Open the new workspace's thread. Press **⌘⇧E** for Files. Expect `alpha`, `Z repo`, and `not a folder`; open `not a folder` and look for `fixture`. Automatic refresh, writes, search, and binary HTTP previews are not part of this slice.
3. Press **⌘J** to open the terminal with the automatic shell. At the `BIGBUD_SSH_OWNER_DEV_PTY_READY>` prompt, run `echo $((17+25)); pwd -P`. Expect `42` and the selected disposable directory. The dev owner supports one pane per launch, with a 30-minute lease limit; restart the dev command for a fresh pane after testing `exit` or Disconnect.
4. With the pane live, reopen **Add remote workspace**, select the same fixture, and click **Disconnect**. **Browse** should report `Remote workspace is disconnected. Connect it to continue.` Reload the UI or reopen the picker in the same run and verify it still refuses until you click **Connect**. The existing pane is not automatically reopened. Restarting the entire dev command creates a new disposable profile, not a same-profile restart test.

Close the app and run `env -u BIGBUD_SSH_OWNER bun run dev:desktop` (or `env -u BIGBUD_SSH_OWNER bun run dev`) to turn the owner off. The opt-in does not support arbitrary hosts or credentials; unsupported managed SSH fails closed rather than using the legacy executor. Packaged releases cannot enable this dev path.

**Observed on macOS arm64:** The normal browser-backed app approved the fixture key, saved the workspace, opened its tree and text preview, and ran a command whose result was computed by the real interactive SSH shell. A natural exit and a Disconnect with the pane live both settled the durable terminal route. Browsing after a renderer reload was denied until explicit Connect. The normal Electron dev build reached startup with Rust selected; the full click-through was run in Chromium, not repeated in Electron.

**User-confirmed on macOS (2026-11-23):** The user launched the normal Electron dev app with `BIGBUD_SSH_OWNER=1 bun run dev:desktop` and reported that the Mac version works. This confirms their Mac test only; it does not approve any Git or release action, or qualify Linux or Windows.

## Linux: normal-app picker (browser verified)

On an approved disposable Linux runner, from that host's checkout root, run `BIGBUD_SSH_OWNER=1 bun run dev` and open the printed local URL. For Electron, the corresponding command is `BIGBUD_SSH_OWNER=1 bun run dev:desktop`; it additionally needs native Electron dependencies and a graphical session. Run only one of these commands at a time. Use the repository's Node, Bun, and Rust toolchains and native workspace dependencies. The candidate needs a non-root account, system OpenSSH client and server tools, a non-setuid `/usr/bin/bwrap` with `--disable-userns`, and working unprivileged user and network namespaces. Do not loosen system restrictions to make the launch pass. Setup refuses to start rather than substituting host SSH if namespace or daemon setup fails.

In **Projects → Remote Workspaces → Add remote workspace**, choose **From SSH config → rust-ssh-owner-dev**, leave **Direct SSH** selected, and verify the **Rust SSH owner (development)** indicator. Click **Connect → Browse**, approve the displayed fingerprint, and open **picker's folders; literal**; expect `alpha` and `Z repo`. Click **Disconnect** and try **Browse** again. It must refuse, including after a UI reload, until explicit **Connect**. To verify Files, select that exact fixture root, click **Use this folder → Add remote workspace**, open the new thread, and use **Ctrl+Shift+E**. Open `not a folder`; expect `fixture`. The Linux direct SSH terminal, writes, watches, and binary HTTP previews are not enabled. Stop the runner before launching any other instance; to use ordinary development again, run `env -u BIGBUD_SSH_OWNER bun run dev`.

On the 4 GiB Debian guest, the contracts watch process hit the memory limit. The Linux owner opt-in now skips that watcher but still builds contracts before the server and UI. This command was verified in the disposable guest:

```sh
cd /home/bbdev/checkout
export PATH="/home/bbdev/tools/bin:/home/bbdev/tools/node-v24.13.1-linux-arm64/bin:/home/bbdev/tools/bun-1.3.9/package/bin:/home/bbdev/tools/rust-1.95.0/bin:$PATH"
TURBO_TELEMETRY_DISABLED=1 BIGBUD_SSH_OWNER=1 BIGBUD_NO_BROWSER=1 bun run dev
```

**Observed on Debian 13 arm64:** The normal browser app discovered the Rust owner, refused first use until explicit Ed25519 approval, listed `alpha` and `Z repo` through system OpenSSH 10.0p2, rejected browsing after Disconnect and renderer reload, and listed again after explicit Connect. All four Linux fixture tests also passed. Bun reported a nonfatal keybindings watch error on the dev profile control socket; the picker continued to work. The normal Files panel also opened the saved fixture workspace and displayed its text preview through the same Rust owner. Linux Electron and direct SSH terminals were not verified.

The separate [installed Linux agent test](/Users/youpele/DevWorld/bigbud/apps/server/src/ssh/sshOwnerPickerProof.agentProxyInstalledLinux.test.ts) passed twice in the same guest with a native development agent at protocol 1.9. Rust-owned SSH reached the same installed supervisor epoch and instance as the direct Unix-socket control; ending stdin drained both streams and exited 0 without stopping the supervisor. This is isolated evidence; normal app agent routing and the signed deployment graph remain unqualified.

**Client relay component (not a final platform build):** In the same disposable Linux guest, the [approved-profile test](/Users/youpele/DevWorld/bigbud/apps/server/src/ssh/sshOwnerPickerProof.clientRelay.test.ts) uses the real bundled relay over one native, pinned SSH channel. It verifies the binary HTTP response and local child reap only. With the guest toolchain PATH above:

```sh
cd /home/bbdev/checkout
cargo build --offline --locked -p bigbud-ssh-owner --bin bigbud-ssh-owner
bun run --cwd /home/bbdev/checkout/apps/server tsdown --config /home/bbdev/checkout/apps/server/tsdown.clientRelay.config.ts
BIGBUD_TEST_SSH_OWNER_PICKER_PROOF=1 bun run --cwd /home/bbdev/checkout/apps/server vitest run /home/bbdev/checkout/apps/server/src/ssh/sshOwnerPickerProof.clientRelay.test.ts
```

## Linux: normal-app pre-pinned jump picker

On the approved Debian scratch runner, run the normal dev command inside a private network namespace. The outer namespace contains the dev server and browser. The fixture creates its own nested namespace for stock OpenSSH and the two daemons.

```sh
cd /home/bbdev/workspace-mode-proof.1MZti8
export PATH="/home/bbdev/tools/bin:/home/bbdev/tools/node-v24.13.1-linux-arm64/bin:/home/bbdev/tools/bun-1.3.9/package/bin:/home/bbdev/tools/rust-1.95.0/bin:$PATH"
export BIGBUD_SSH_OWNER=1 BIGBUD_SSH_OWNER_LINUX_JUMP=approved-disposable BIGBUD_NO_BROWSER=1
/usr/bin/bwrap --unshare-net --unshare-pid --die-with-parent --bind / / --dev /dev --proc /proc -- /bin/bash
```

Run `bun run dev` in that private shell and open the printed Vite URL in a browser in the same namespace. In **Projects → Remote Workspaces → Add remote workspace**, select **From SSH config → workspace** with **Direct SSH**. The fixture advertises folder browsing and explicitly states that first-use approval is unavailable. Click **Connect → Browse**, open **jump-fixture-folder**, and choose **Use this folder**. The save action stays disabled. Click **Disconnect**, confirm **Browse** refuses, then explicitly **Connect** and browse again. This opt-in uses generated pins for two private daemons. The ordinary direct fixture remains the default for source dev when the jump opt-in is absent.

## Linux: jump picker first-use approvals

In the same approved Debian scratch namespace, use `BIGBUD_SSH_OWNER_LINUX_JUMP=first-use-disposable` in the normal dev command. The separate pre-pinned opt-in remains available. This mode starts with both fixture pins empty.

Choose **From SSH config → workspace → Direct SSH**, click **Connect → Browse**, and compare the displayed hop 1 fingerprint with the disposable bastion key before approving it. Cancel leaves both pins empty. After approving hop 1, Browse prompts for the destination fingerprint at hop 2. Compare it independently before approving. The folder listing becomes available after both approvals. This fixture supports browsing and connection controls only.

## Windows: normal-app picker candidate (native run pending)

Use only an explicitly approved disposable Windows runner with native repo toolchains and inbox OpenSSH Client. The [Windows picker](/Users/youpele/DevWorld/bigbud/crates/bigbud-ssh-owner/src/bin/ssh_owner/windows_picker.rs) uses the [native dispatcher bridge](/Users/youpele/DevWorld/bigbud/crates/bigbud-ssh-owner/src/bin/ssh_owner/windows_dispatcher.rs) to verify the owner process across the named pipe. Normal dev startup requires an explicit fixture manifest; missing or invalid inputs fail closed. No Windows app, inbox authentication, or real Windows pipe round trip has been verified yet. Password, keyboard-interactive, Files, and terminals are not enabled in this Windows dev slice.

**Runner inputs:** A disposable POSIX-shell `sshd`, listening at `127.0.0.1` as seen by Windows, on a dedicated port above 1023, with a non-root fixture account and fresh Ed25519 keys. The ordinary Windows OpenSSH server with its default shell is not a drop-in endpoint. The runner must already have the fixture provisioned; the app does not install WSL, configure forwarding, or modify an SSH service. In a dedicated current-user-only directory on local NTFS outside `.ssh`, supply `fixture.json`, a synthetic unencrypted Ed25519 `identity` with comment `bigbud-windows-picker-fixture`, and an empty `known_hosts`. Do not leave any sidecar key files there. The manifest has exactly five fields: `kind` (`bigbud-windows-posix-picker-v1`), `host` (`127.0.0.1`), `port`, `user`, and `hostPublicKey` (the fixture's `ssh-ed25519` public key type and base64, no comment). Keep the manifest, key, and pin out of evidence logs.

On that approved runner, substitute the actual **absolute** checkout and manifest paths. Stop other dev instances before starting:

```powershell
Set-Location -LiteralPath 'C:\bigbud-dev\checkout'
$env:BIGBUD_SSH_OWNER = '1'
$env:BIGBUD_SSH_OWNER_WINDOWS_FIXTURE = 'C:\bigbud-dev\picker\fixture.json'
bun run dev:desktop
```

Use **Add remote workspace → From SSH config → rust-ssh-owner-dev → Direct SSH**. Click **Connect → Browse**; require the expected fingerprint before approval, then verify known fixture folders. Disconnect, reload, and retry Browse: it must refuse until explicit Connect. On a separate stopped-and-restarted run, test missing fixture input and a mismatched host fingerprint; neither may launch legacy SSH or approve a new key. Capture Windows edition/build, inbox OpenSSH version, Rust owner and `ssh.exe` ancestry, and redacted RPC outcomes. The [read-only Windows preflight](/Users/youpele/DevWorld/bigbud/protocol/ssh-owner/MANUAL-TEST.md#windows-read-only-inbox-preflight-now) records OS/client versions; it does not pass the app gate. To opt out, stop the dev app and remove both environment variables from the PowerShell session before restarting.

## macOS: run the isolated proof

Use a non-root local account with a simple username and `/bin/sh`, `/bin/bash`, or `/bin/zsh`, installed Bun dependencies and Rust, and system `sandbox-exec` and OpenSSH tools (`ssh`, `ssh-keygen`, `ssh-keyscan`, `sshd`). The fixture refuses system SSH/shell startup hooks it cannot isolate. If preconditions fail, record the blocker; do not use `sudo`, change machine config, or substitute another SSH client.

From the checkout root, using Cargo's default `target` directory:

```sh
cd /Users/youpele/DevWorld/bigbud
cargo build --offline --locked -p bigbud-ssh-owner --bin bigbud-ssh-owner
cargo build --offline --locked -p bigbud-remote-agent --bin bigbud-remote-agent
```

If only the dependency cache is missing, omit `--offline` when fetching is allowed. Once the build succeeds, run:

```sh
(
  unset BIGBUD_SSH_OWNER_PICKER_PROOF_BIN
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
)
```

The [S1 fixture](/Users/youpele/DevWorld/bigbud/apps/server/src/ssh/sshOwnerPickerProof.test.ts) creates and cleans up its own private temporary profile, SQLite DB, Ed25519 keys, known-hosts file, and disposable IPv4 loopback sshd. It runs the registered picker RPC in process, not the normal app or its WebSocket listener. Do not supply a live profile, target, key, or DB. A skipped test is not a pass.

Expected: 21 passing tests across 17 proof files. The live content-search case needs `rg` in the fixture's fixed search paths (`/usr/bin`, `/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`). If it is missing, record the content-search case as blocked, not passed.

- Unknown host is refused before key authentication. A key swap between inspection and approval is rejected, and the old challenge cannot be reused. Exact approval allows key auth and the expected folder list, including Git and `truncated: false` metadata.
- A read fails with the listener down; a **new** read succeeds after sshd restarts. This is not an in-flight reconnect guarantee.
- Disconnect blocks the picker without another endpoint attempt. It stays blocked across a new owner and a reopen of the same fixture DB, until explicit Connect. A changed pinned key is then rejected without overwriting trust.
- A competing owner, forced owner death, absent binary, and incompatible protocol fail closed. No legacy SSH launches are recorded; local SQLite remains usable.
- The alias case lists through a separate `HostKeyAlias` on the fixture’s non-default port. Editing config invalidates a pending approval; an applicable `Match exec` is refused before any new connection, and the helper marker stays absent. A separately owned control master remains alive after the owner disconnects and is not reused for the listing. The alias is loaded from a fixture-local include; modifying an included file or adding a glob match invalidates the policy. These are bounded direct-policy cases, not full OpenSSH config parity or the packaged fallback fence.
- The private Unix attachment case keeps the same owner epoch and process, rejects wrong capabilities and profile bindings without rotating SQLite, and then rebinds the real DB. It recovers Disconnect even when the storage client committed but deliberately withheld the acknowledgement. The fixture now holds a real OpenSSH PTY while the SQLite acknowledgement is lost. The same owner must reap it before acknowledging the replacement client, and a stale lease must not close the new PTY created after Connect. This is a fixed-command fixture, not general pane restoration or Windows named-pipe qualification.
- The local rollback rehearsal closes the real legacy Bun backend before opening the Rust proof, then boots the legacy source and reopens Rust on the same SQLite file. The latest legacy Connect wins over older Rust transition metadata. This does not qualify a signed release pair.
- The isolated workspace test reads a text preview and binary byte ranges through the real workspace service and Rust owner. It checks the 5 MiB preview boundary, EOF, symlink and cross-root refusal, and no legacy fallback on Disconnect or owner failure. The same test checks root and nested directory listings, legacy root-level ignore rules and directory-first sorting, with no fallback on Disconnect or owner death. The lifecycle test adds Git-aware name search, fixed-string content search, a same-size overwrite that triggers a watcher rescan, and a bounded stdin write. It denies symlink writes and checks no legacy fallback after Disconnect or owner failure. These are proof-only; writes exceeding 48 KiB and full remote file behavior remain outside this result.
- The WebSocket case uses the product router and token check. Missing and wrong tokens are refused, a valid token reaches the Rust-backed picker, and owner death never falls back. Unrelated services use test layers.
- The health case preserves approved monitor leases on unavailable samples and revokes them only for observed failure. The Git case checks the scope-bound inside-work-tree probe and porcelain status command, not full status, fetch/push, or an active cancellation.
- The direct-terminal reservation case opens no SSH child until Open receives the matching prepared lease; it checks initial PTY dimensions and refuses cancelled or consumed tokens. The attachment cases also send bounded input and resize an existing live OpenSSH PTY. This is a fixed terminal command, not a production pane or arbitrary shell.
- The inherited agent-pipe case exchanges binary hello frames with a real ephemeral macOS agent over OpenSSH, then confirms local child exit on graceful EOF. No agent payload travels over the proof control channel. The macOS binary is not treated as a supported managed-agent artifact; this does not qualify Linux installed-supervisor proxy or persistent reattachment.

## Linux: audit the disconnected picker before Connect

Use only an approved disposable Linux checkout and generated fixture identities. Build the debug owner first. From the absolute checkout root, with Bun, Node, Bubblewrap, and `strace` already available on `PATH`, run:

```sh
cargo build --offline --locked -p bigbud-ssh-owner --bin bigbud-ssh-owner
umask 077
audit=$(mktemp -d /tmp/bigbud-s1-dns-audit.XXXXXX)
export BIGBUD_TEST_SSH_OWNER_STRACE_FILE="$audit/fixture.trace"
/usr/bin/bwrap --unshare-net --die-with-parent --bind / / --dev /dev -- \
  strace -f -qq -ttt -yy -s 256 \
  -e trace=execve,execveat,connect,sendto,sendmsg,sendmmsg,rename,renameat,renameat2 \
  -o "$BIGBUD_TEST_SSH_OWNER_STRACE_FILE" \
  bun run --cwd "$PWD/apps/server" vitest run \
  "$PWD/apps/server/src/ssh/sshOwnerPickerProof.beforeConnectAudit.linux.test.ts"
```

The test checks owner boot, disconnected requests, Connect, and the first allowed read as separate intervals. Only the fixture daemon's failed local NSS cache lookup is allowed during boot. A successful SSH exec and endpoint dial after Connect verify that the trace is observing the child process. The trace is unredacted disposable fixture data; keep it private and do not use this command on a live profile. The picker and Connect calls go through the selected development application routes over an authenticated WebSocket; the fixture supplies unrelated backend services. This is not a standalone backend-process restart or a packaged release test.

## macOS: ordered host trust and owned key master

Run from a disposable test account or the same approved Mac test environment as the isolated picker. These commands use generated keys and a throwaway loopback `sshd`; neither uses a live bigbud profile, a user's existing SSH master, or a login password.

```sh
cd /Users/youpele/DevWorld/bigbud
cargo build --offline --locked -p bigbud-ssh-owner --bin bigbud-ssh-owner
BIGBUD_TEST_SSH_OWNER_PICKER_PROOF=1 BIGBUD_TEST_SSH_OWNER_POSIX_MASTER=1 \
  bun run --cwd /Users/youpele/DevWorld/bigbud/apps/server vitest run \
  /Users/youpele/DevWorld/bigbud/apps/server/src/ssh/sshOwnerPickerProof.extendedTrust.test.ts \
  /Users/youpele/DevWorld/bigbud/apps/server/src/ssh/sshOwnerPickerProof.posixMaster.test.ts
```

Expect three trust cases and one master case. Trust checks a hashed secondary pin, multi-entry single-file matching, first-user-file-only approval, and refusal before a new SSH connection for a matching revocation or unsupported CA record. The key master test checks reuse of its own foreground client and verifies the separately started disposable master remains alive after the owned one is reaped. This test does not wire master reuse into the app, test password authentication, or qualify owner-crash recovery.

## macOS: run the normal legacy regression separately

Run these from the same checkout root with the owner opt-in unset. The first command checks the normal legacy handlers with local/mocked and launch-recorder fixtures. The second adds a real OpenSSH comparison, still without the owner or a live app/profile.

```sh
(
  unset BIGBUD_TEST_SSH_OWNER_PICKER_PROOF BIGBUD_TEST_PICKER_LOOPBACK
  bun run --cwd apps/server vitest run \
    src/ssh/sshRemoteFolders.test.ts src/ssh/sshConfigDiscovery.test.ts \
    src/ssh/sshHostTrust.test.ts src/ssh/sshTargetDisconnects.guard.test.ts \
    src/ssh/sshPicker.launchRecording.test.ts
)
```

```sh
(
  unset BIGBUD_TEST_SSH_OWNER_PICKER_PROOF
  BIGBUD_TEST_PICKER_LOOPBACK=1 bun run --cwd "$PWD/apps/server" vitest run \
    "$PWD/apps/server/src/ssh/sshPicker.loopback.test.ts"
)
```

The [legacy loopback fixture](/Users/youpele/DevWorld/bigbud/apps/server/src/ssh/sshPicker.loopback.test.ts) should deny an unknown host, approve the exact key, list by public-key auth, reject a wrong pin, and allow a fresh read after sshd returns. A Disconnect must block with zero new SSH/key probes, including after SQLite is rebound, until explicit Connect. Storage rebind here is not a backend process restart. Normal bigbud still uses the legacy executor; that is not a fallback from the Rust proof. Do not launch or repoint the installed app for either section.

## Windows: read-only inbox preflight now

Run in a native PowerShell session for the guest architecture (not a WOW64 or emulated shell). This reads OS and client metadata and runs only the explicit inbox client with `-V`. It does not read SSH config, contact a host, change OpenSSH features/services, or run bigbud. Do not use `ssh -G` on unchecked config: `Match exec` may execute a command.

```powershell
$release = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$os = Get-CimInstance -ClassName Win32_OperatingSystem
[pscustomobject]@{
    OS = $os.Caption
    DisplayVersion = $release.DisplayVersion
    Build = "$($os.BuildNumber).$($release.UBR)"
    Architecture = $env:PROCESSOR_ARCHITECTURE
}
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $ssh -PathType Leaf)) {
    throw "Inbox OpenSSH client is missing at $ssh; record the row as blocked."
}
Get-Item -LiteralPath $ssh | Select-Object -ExpandProperty FullName
& $ssh -V
if ($LASTEXITCODE -ne 0) { throw 'Inbox OpenSSH version probe failed.' }
```

| Required guest                      | What to record now                                                                                                                             | Password trigger to prove later                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10 22H2 x64                 | Build `19045` plus its revision and actual inbox `OpenSSH_for_Windows_8.1p1` version. A different version is not the required 8.1p1 row.       | 8.1p1 lacks `SSH_ASKPASS_REQUIRE`. Prove the legacy `DISPLAY` + `SSH_ASKPASS` trigger with no console and non-console stdin.                  |
| Supported Windows 11 inbox guest(s) | Actual edition/release, build and revision, architecture, inbox path, and full version output. Do not assume one version for all Win11 builds. | Prove `SSH_ASKPASS_REQUIRE=force` where supported by the measured inbox version. Do not infer askpass support from the OS name or `-V` alone. |

Do not replace an unavailable required inbox build with Git for Windows, Cygwin, WSL, a PATH-resolved client, or Windows Server. Save preflight results separately from product evidence: the path above is not proof of the app-resolved SSH image. The existing [offline artifact preflight](/Users/youpele/DevWorld/bigbud/protocol/ssh-owner/release-evidence/README.md) can record supplied Windows measurements and artifact identity; its result is always `preflight-only`.

## Windows: isolated named-pipe tests

In a supported disposable Windows development checkout with Rust and Bun dependencies installed, the named-pipe foundation can be tested separately from SSH:

```powershell
cargo test --locked -p bigbud-ssh-owner --lib windows_owner_pipe
```

Run this on Win10 22H2 x64 and the supported Win11 architectures. It allocates test-only local pipes, touches no live SSH profile, and collects no passwords. A successful local run is not evidence of different-account or remote SMB denial; those require separately isolated peers. The named-pipe test does not enable an owner-enabled bigbud build, ConPTY over SSH, or askpass.

## Windows: S2 native inbox password fixture (not product enablement)

Run only after approval for an identified disposable guest. No new runner is approved by this runbook. Use Win10 22H2 x64 with inbox 8.1p1, and each supported Win11 inbox row with its actual build and architecture. Run the read-only preflight above first. A substituted SSH client, mismatched Win10 client, or missing loopback peer is **blocked**, not passed. The test never reads a real credential, uses an app profile, or starts the bigbud owner.

### Disposable loopback peer

Use an already-approved, disposable Debian/Ubuntu environment with `openssh-server` and PAM already present. Windows must see the three dedicated listeners at `127.0.0.1:22420–22422` (for example, an existing approved WSL guest with localhost forwarding). Do not install or change a shared service, firewall, forwarding configuration, or Windows account to run this. In the disposable POSIX environment only, run the following in a fresh root Bash shell and leave it waiting for Enter. It uses only two reserved synthetic accounts and fresh keys. Do not run it on a regular machine or against a shared account database.

```bash
(
  set -euo pipefail
  test "$(id -u)" -eq 0
  test -d /run/sshd
  for user in bb_s2_password bb_s2_empty; do
    if getent passwd "$user" >/dev/null; then exit 1; fi
  done
  for port in 22420 22421 22422; do
    test -z "$(ss -H -ltn "sport = :$port")"
  done

  work=$(mktemp -d)
  pids=() users=()
  cleanup() {
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
    for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
    for user in "${users[@]}"; do userdel "$user" || return 1; done
    rm -rf -- "$work"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  for user in bb_s2_password bb_s2_empty; do
    useradd -M -N -s /bin/sh "$user"
    users+=("$user")
  done
  printf '%s\n' 'bb_s2_password:public-synthetic-windows-completion-fixture' | chpasswd
  passwd -d bb_s2_empty >/dev/null
  ssh-keygen -q -t ed25519 -N '' -f "$work/host"
  ssh-keygen -q -t ed25519 -N '' -f "$work/wrong"

  start() {
    local port=$1 user=$2; shift 2
    local config="$work/$port.config"
    printf '%s\n' "Port $port" 'ListenAddress 127.0.0.1' \
      "HostKey $work/host" "PidFile $work/$port.pid" "AllowUsers $user" \
      'PermitRootLogin no' 'PubkeyAuthentication no' 'DisableForwarding yes' \
      'PermitTTY no' 'PermitUserRC no' 'LogLevel VERBOSE' \
      'ForceCommand test "$SSH_ORIGINAL_COMMAND" = true' "$@" > "$config"
    /usr/sbin/sshd -t -f "$config"
    /usr/sbin/sshd -D -f "$config" -E "$work/$port.log" &
    pids+=("$!")
    for ((i=0; i<30; i++)); do
      kill -0 "$!"
      if [[ -n $(ss -H -ltn "sport = :$port") ]]; then return 0; fi
      sleep 0.1
    done
    return 1
  }
  start 22420 bb_s2_password 'UsePAM no' 'PasswordAuthentication yes' \
    'PermitEmptyPasswords no' 'KbdInteractiveAuthentication no' 'AuthenticationMethods password'
  start 22421 bb_s2_empty 'UsePAM no' 'PasswordAuthentication yes' \
    'PermitEmptyPasswords yes' 'KbdInteractiveAuthentication no' 'AuthenticationMethods any'
  start 22422 bb_s2_password 'UsePAM yes' 'PasswordAuthentication no' \
    'KbdInteractiveAuthentication yes' 'AuthenticationMethods keyboard-interactive:pam'
  awk '{print FILENAME, $2}' "$work/host.pub" "$work/wrong.pub"
  printf '%s\n' 'Copy only the two public blobs into the Windows fixture inputs.' \
    'Keep this running. Inspect the private per-port logs in this directory before pressing Enter:' "$work"
  read -r _
)
```

Use the `host.pub` blob as the approved key and `wrong.pub` as the alternate pin. Take them directly from the peer setup, not from `ssh-keyscan`. The password listener only allows password; the separate empty-account listener allows SSH's initial `none` request, not a password release. The third listener offers PAM keyboard-interactive only; do not respond to its challenges. Before teardown, corroborate two `Accepted password` events and a `Failed password` after the two positive controls on 22420, one `Accepted none` on 22421, and no accepted authentication on 22422. The mismatched pin and cancelled prompt must not yield another accepted authentication; cancellation may also register a failed attempt. Do not export the raw logs. Press Enter after inspection; this stops the owned listeners and removes the two fixture accounts and temporary peer files. Discard the disposable snapshot if setup or cleanup is interrupted.

### Native Windows run

Use an architecture-matching PowerShell and Rust toolchain in a fresh console in the development checkout. Verify the inbox image's Windows provenance and the helper build source separately; hashes alone do not confer trust. Use `legacy` on the required Win10 8.1p1 row. For a Win11 client that supports `SSH_ASKPASS_REQUIRE`, use `force` to test without `DISPLAY`. If force support is absent or the isolated attempt fails, record that row accordingly; do not relabel a `legacy` run as force evidence. Make no product configuration changes.

```powershell
$ErrorActionPreference = 'Stop'
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$fixture = Join-Path $env:TEMP ('bb-s2-' + [guid]::NewGuid().ToString('N'))
# Use a private, short, ordinary local NTFS path (no junction or reparse point).
New-Item -ItemType Directory -Path $fixture | Out-Null
$variables = @('BIGBUD_S2_FIXTURE_DIR', 'BIGBUD_S2_INBOX_SHA256', 'BIGBUD_S2_HELPER_SHA256',
               'BIGBUD_S2_HOST_PIN', 'BIGBUD_S2_WRONG_HOST_PIN', 'BIGBUD_S2_ASKPASS_TRIGGER')
try {
    $build = Join-Path $fixture 'cargo'
    cargo build --locked -p bigbud-ssh-owner --bin bigbud-ssh-password-helper --target-dir $build
    if ($LASTEXITCODE -ne 0) { throw 'Helper build failed.' }
    $fresh = Join-Path $build 'debug\bigbud-ssh-password-helper.exe'
    Copy-Item -LiteralPath $fresh -Destination $fixture
    $env:BIGBUD_S2_FIXTURE_DIR = $fixture
    $env:BIGBUD_S2_INBOX_SHA256 = (Get-FileHash -LiteralPath $ssh -Algorithm SHA256).Hash
    $env:BIGBUD_S2_HELPER_SHA256 = (Get-FileHash -LiteralPath $fresh -Algorithm SHA256).Hash
    $env:BIGBUD_S2_HOST_PIN = Read-Host 'Approved synthetic host.pub base64 blob'
    $env:BIGBUD_S2_WRONG_HOST_PIN = Read-Host 'Alternate synthetic wrong.pub base64 blob'
    $env:BIGBUD_S2_ASKPASS_TRIGGER = Read-Host 'Trigger variant: legacy or force'
    cargo test --locked -p bigbud-ssh-owner --lib --target-dir $build `
      windows_password_gate::native::probe::completion::inbox::native_inbox_password_qualification `
      -- --exact --ignored --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'Native inbox fixture failed; do not qualify this row.' }
} finally {
    foreach ($var in $variables) { Remove-Item -LiteralPath "Env:$var" -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
```

Require **one test run and passed**, with all seven `PASS:` lines, not merely a Cargo exit of zero. The positive controls require a verified helper receipt and completion of `true` on the same retained inbox process; the wrong-password control requires a receipt but no eligibility. Silent `none` succeeds without a helper or eligibility. Keyboard-interactive-only and wrong host key exit nonzero without any helper connection. Cancellation confirms both retained processes exit and the helper pipe disappears. If the two-second pipe window cannot cover a quiet loopback connection, treat it as failed/inconclusive, not passed. During the native run observe that no extra console appears; the test itself does not inspect the desktop. Record the preflight metadata, verified image hashes/source, selected trigger, redacted client and peer results and cleanup for each row. Keep ConPTY, app-level credential collection/cache/owner admission, release/dev lookup and packaged parity marked **not covered** by this fixture. Product Windows password support must remain disabled pending qualification.

## Windows: pending end-to-end gates, not commands to run today

Wait for an identified owner-enabled dev build and matching packaged x64 NSIS artifact with verified owner/helper inputs. Qualify each supported dev and packaged deployment separately on the required inbox guests; one does not pass for the other. Use a disposable guest or dedicated test account and a private, empty temporary app profile with separate Electron user data (where applicable), DB, home/config, known-hosts, and test keys. Verify those effective paths before any product operation. A temp app state path alone does not establish isolation. Use only an owned disposable sshd on an isolated test network, fresh host identities, and synthetic test credentials. Never share a profile or trust store with the live app or legacy executor; never use ambient agents, real destinations, or real secrets.

| Pending gate                         | Expected evidence when implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host trust and key auth              | Start with empty private known-hosts. Deny first use without authentication, then approve only the fingerprint verified independently from the disposable sshd. Confirm a key-authenticated listing. Swap the host key before approval and after pinning in separate cases; reject before credentials, with no overwrite or alternate route. Key auth is independent of password qualification.                                                                                                                                                                                                                                                                             |
| Durable Disconnect and owner failure | Open a managed connection, Disconnect, and restart the backend and owner against the same private test DB. Prove durable state and no target DNS/SSH attempts or prompts (including background work) until explicit Connect. Cover loss of the commit reply while the owner and a live PTY survive backend restart: rebind storage, reconcile before admitting, revoke only the old generation once, and do not replay or respawn. Missing/incompatible owner means `sshOwnerUnavailable`, local work still available, and zero legacy launches.                                                                                                                            |
| ConPTY and ownership                 | On both inbox rows, verify real input, output ordering, resize and exit, and no extra visible console. On eligible backend restart/keep-mode cases, reattach the same pane, durable binding and SSH process with no second spawn. Default quit/explicit close must obey close policy and not respawn. An unproven exit after owner loss retains the fence; show no replacement pane. Run key and independently qualified password cases.                                                                                                                                                                                                                                    |
| Native askpass/password              | No ControlMaster. Prove the version-specific trigger, verified child/helper binding, single-use release to the right process, and positive acceptance in the same strict password-only probe before caching. Include wrong password, canceled or late/foreign prompt, partial/multi-method and stale-generation results, transport loss after release, and a successful silent no-prompt command that is neither killed nor cached. No stray console or helper environment in unrelated children. Verify wipe on Disconnect/exit/10 minutes without user activity; polling does not reset the clock. Keyboard-interactive is separate; never release a password to OTP/MFA. |
| Capability denials                   | An unqualified password combination returns `windowsPasswordUnsupported` **before** collection, with “Use an SSH key for this host.” A qualified build with a missing helper returns `askpassUnavailable`; an expired secret requires unlock. An absent owner must not prompt. No TypeScript fallback for any of these cases.                                                                                                                                                                                                                                                                                                                                               |

## Record and share redacted evidence

Record one row per case, profile and OS/client combination, using ledger IDs such as `F01` (picker/trust), `F02` (auth), `F04` (PTY), and `F05` (durability). Mark **pass**, **fail**, **blocked**, or **not run**; keep preflight separate. Use the [profile matrix](/Users/youpele/DevWorld/bigbud/docs/plans/2026-11-22-rust-ssh-ownership-s0-profiles.md) for artifact-specific obligations.

- Case ID, approved origin and synthetic target label, auth mode, profile (`D`, `V-E`, `V-B`, `N`, or `R`, as applicable), commit/build and artifact ID/hash/signature or manifest verification. For Windows include signing mode, not an assumption of signing.
- OS release/build, architecture/ABI, runtime/version, resolved OpenSSH image/version (both ends where relevant), default-config compatibility, dev/package lookup root, and owner/helper identity and verification. Mark fields not observed by a fixture as such.
- Expected and actual result or typed error, operand shape/cap, cold/steady latency and reconnect/teardown time. Include exit/signal, image and PID/parent ancestry, spawn counts including wrappers and zero-launch counters for denials, and only redacted argv/env **shape**. Note local-work outcome on owner failure.
- When applicable, note protocol/version and capabilities, redacted epoch/DB domain and start vs. attach, durable Disconnect state across restart, generation/lease outcomes, and same binding plus same process for PTY survival. For leased streams record EOF, cancel and slow-reader behavior where exercised.

Retain only redacted summaries or trace references, not raw logs or profile bundles. Omit passwords, key material, grants/tokens, environment values, real hostnames and personal paths. Tear down only the owned test processes and discard only the private test data; do not modify shared state to make a test pass.
