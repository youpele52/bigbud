# S4 structural zero-bypass checker

This tool is a **source-shape** check for the legacy SSH launch inventory in [cutover design §a](../../../../docs/plans/2026-11-23-rust-ssh-ownership-s4-cutover-design.md#a-legacy-launch-inventory). It answers one question: does an explicit set of source paths contain the structures that the S4 single activation change set is required to delete or convert?

It does **not** authenticate inputs, run products, inspect artifacts or accept S4. A clean report says `structuralOnly: true` and `s4Accepted: false`. It is not activation, rollback, or transfer M0 approval.

## What it checks

| Rule | Finds                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | SSH-family literals (`ssh`, `ssh.exe`, `ssh-keygen`, `ssh-add`, `ssh-agent`, `ssh-keyscan`) used as a `spawn`/`execFile`/`runProcess`/node-pty `file` argument or a shell command position                         |
| 2    | `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE`, `GIT_SSH_COMMAND`, `GIT_SSH`, `ControlMaster`, `ControlPath`, `ControlPersist` and `-O exit`                                                                                 |
| 3    | Imports of the deleted `sshCommand`, `sshSession`, `sshLocalCommand` or `sshProcess` modules, including type-only imports such as `RunSshCommandInput`                                                             |
| 4    | APIs accepting `executable`, `command`, `sshBinary` or `env` that reach a spawn, inside `ssh/`, `remote-backend/*.ssh*`, `peer-orchestration/`, `terminal-host/*directSsh*`, provider adapters, or `remote-agent/` |
| 5    | `Command::new` with an SSH-family basename in Rust crates other than `bigbud-ssh-owner`                                                                                                                            |

The checker is deliberately conservative. A finding is not proof of a launch, and a clean file is not proof that no launch exists. **Indirect launches are outside this tool**: Git or `gh` invoking `ssh`, OpenSSH `ProxyCommand`/`ProxyJump` helpers, `LocalCommand` and `Match exec` can only be observed by the [cutover process-trace checker](../cutover/README.md). Both checks are required for S4.

## Allowlist

[`allowlist.json`](allowlist.json) lists only the reviewed keep rows:

- row 32 `remoteAgentGit.ts` (`GIT_SSH_COMMAND` in a denial list),
- row 52 `syncShellEnvironment.ts` (`SSH_AUTH_SOCK` on D/V only, U11),
- row 55 `providerConformance` harness paths,
- the `bigbud-ssh-owner` crate for rule 5.

Every entry carries a reason and a reference. Under U9 there is **no** `ssh-keygen` allowlist entry; the parser rejects one. Adding any entry needs review.

## Run locally

It scans only the paths you pass. A missing path is an error; there is no default repository scan.

```sh
bun run vitest run --config protocol/ssh-owner/release-evidence/structural/vitest.config.ts
bun run protocol/ssh-owner/release-evidence/structural/verify.ts apps/server/src/ssh/sshCommand.ts
bun run protocol/ssh-owner/release-evidence/structural/verify.ts apps/server/src/ssh --allowlist protocol/ssh-owner/release-evidence/structural/allowlist.json
```

Exit 1 means at least one non-allowlisted finding. The JSON report includes each file's content SHA-256, each finding's rule/line/symbol, and whether an allowlist entry covered it. Paths are repository-relative where possible; the tool does not fetch, mutate, or scan outside the supplied inputs.

## Limits

- It reads at most 5,000 files and 2 MiB per file.
- It skips `.git`, `node_modules`, `target`, `dist`, `build`, `coverage` and `.turbo`.
- It skips `*.test.*`, `*.spec.*`, `*.browser.*` and fixture directories unless passed as an explicit file.
- It does not resolve aliases, package exports, dynamic `require` shapes, or Rust macros. Those remain review and trace-checker work.
