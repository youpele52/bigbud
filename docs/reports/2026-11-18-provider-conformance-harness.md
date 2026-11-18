# Provider conformance harness (WP-5D)

Date: 2026-11-18. Plan: [remote completion plan, M4](../plans/2026-11-17-remote-completion-plan.md).
Builds on [WP-5C](2026-11-18-provider-provisioning-action.md) and
[WP-5A/5B](2026-11-18-provider-provisioning-recipes.md).

The harness is built and self-tested. **No live conformance has run yet.** A live run needs
the user's provider credentials on each host, so it is the user's run (checklist below). The
self-test runs against a mock provider and never counts as acceptance.

## What it does

`apps/server/scripts/providerConformance/driver.ts` drives a remote backend through its
authenticated client Unix socket. That is the surface with D10 setup authority. It runs per
tuple and per provider, then writes a dated JSON and markdown matrix to
`~/bigbud-conformance-results/provider-conformance-<mode>-<time>.{json,md}`.

- **Transports.**
  - `local`: run on the host. It uses `remote-backend.sock` and the account's client token,
    like the measurement tool.
  - `relay`: run from the laptop. It opens one `ssh <target> exec <node> <relay entry>
<authority>` per HTTP connection. The remote relay adds the token, so the token never
    leaves the host.
  - RPC framing is reused from `remoteBackendMeasure.client.ts`.
- **Observation.** Only `orchestration.replayEvents`, read from each thread's creation
  sequence. That is the same data a reconnecting client replays.
- **Isolation.**
  - The harness creates only `bigbud-conformance-project-*` and
    `bigbud-conformance-thread-<row>-*`, in a disposable `~/bigbud-conformance-work-<time>/`
    on the host.
  - Each row gets a fresh thread, and its session is stopped when the row ends.
  - Provider settings are never changed.
- **Cleanup and restore.**
  - The journal (`restore-journal.json`) is written before every create.
  - Cleanup stops sessions, deletes threads, verifies the deletion (archiving any thread that
    refuses to go), then deletes the project. The work directory is removed only when every
    step succeeds.
  - `--restore <localWorkDir>` replays cleanup from the journal.
- **Safety.**
  - No vendor installer ever runs.
  - `server.provisionProvider` is called only for Copilot and only with `--provision-copilot`.
    It runs on the client socket, and the job is then polled through `server.copilotRuntime`
    status.
  - Session rows run only when the provider's provisioning state is `ready`. For OpenCode v2,
    that means its shared service is already healthy. The harness never starts it.
- **`--dry-run`** lists the planned rows without contacting anything.
- **`--self-test`** uses the in-process mock backend and mock provider. Its report is headed
  "SELF-TEST … No acceptance", with `acceptance: "none"`.

## Rows

Each row ends as `pass`, `fail`, `unsupported-by-provider` or `not-run`, with a reason.
`version-rejection` is backend-scoped and runs once per tuple. All other rows run per provider.

| Row                 | Pass condition                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-reuse`     | Provisioning `state` is `ready`, `needs-auth` or `unknown`, with an `executableSource`, and both are identical over a second connection. `missing` fails, `unsupported` (no tuple artifact) is unsupported, `disabled` is not-run                                         |
| `auth-state`        | `needs-auth` is explicit and has a sign-in step. If the provider is authenticated, the row is not-run unless the user signed out and passed `--expect-needs-auth <provider>`                                                                                              |
| `text-turn`         | Turn settles `completed` and the reply contains the per-run token                                                                                                                                                                                                         |
| `attachment`        | A base64 text file is attached and the reply contains its token. Muse: unsupported-by-provider only when an explicit rejection is observed                                                                                                                                |
| `tool-use`          | A `tool.*` activity appears and the reply contains the token from the workspace file                                                                                                                                                                                      |
| `approval`          | In `approval-required` mode: `approval.requested`, then accept, then `approval.resolved`, then `completed` with the token. Pi: unsupported-by-provider (declared)                                                                                                         |
| `question`          | `user-input.requested`, then an answer (`blue`), then `user-input.resolved`, then `completed` with the answer in the reply                                                                                                                                                |
| `cancel`            | `thread.turn.interrupt` sent once the turn is visibly running, and the turn settles `interrupted` or `cancelled`                                                                                                                                                          |
| `disconnect-replay` | Client A starts a turn and disconnects mid-turn. Client B's replay from the pre-turn cursor is `available`, strictly ordered, has no duplicate events, matches a second replay exactly, carries the user message once, settles once as `completed` and contains the reply |
| `duplicate-receipt` | The same `commandId` and payload, sent again from a new connection, returns the original sequence. `getCommandOutcome` reports it accepted. A different payload under that `commandId` is refused. Exactly one user message, one turn start and one settled turn          |
| `version-rejection` | The handshake advertises revision 1, and a WebSocket at revision 1001 is refused with 426                                                                                                                                                                                 |

`unsupported-by-provider` is allowed only where the adapter itself declares the gap
(`DECLARED_UNSUPPORTED` in `rows.ts`):

- Muse attachments: `packages/shared/src/providerAttachments.ts`.
- Pi approvals: `provider/Layers/Pi/Adapter.methods.ts`.

Prompts are fixed (`PROMPTS` in `rows.ts`, listed in every report). Per-run nonces
(`BBCONF-xxxxxxxx`) go only into prompts and workspace files. Model output is never recorded:
the report keeps only booleans such as `tokenInReply`.

## Redaction

Results never copy `executablePath`, provider `message`, model output or user prompts. They
keep only `state`, `executableSource`, `authCheck`, counts and booleans. Every string in the
report is also passed through `redact.ts`, which removes:

- absolute, `~` and Windows paths (repo-relative module references are kept);
- `Bearer`/`Basic`/`token` credentials;
- `sk-`, `gh?_`, `github_pat_`, `xox?-`, `AKIA` and `AIza` keys;
- JWTs;
- `key=value` pairs with secret-like keys;
- URL credentials;
- emails;
- hex runs of 32 or more characters, and base64 runs of 40 or more;
- the run's nonces.

Strings are capped at 300 characters.

## Files

| File                                |      Lines | Role                                                     |
| ----------------------------------- | ---------: | -------------------------------------------------------- |
| `driver.ts`                         |        236 | CLI, dry run, restore, self-test wiring                  |
| `run.ts`                            |        185 | Run order, gating, cleanup                               |
| `rows.ts`                           |        144 | Row ids, statuses, declared gaps, prompts                |
| `rows.context.ts`                   |        131 | Per-provider context, fixtures, thread wrapper           |
| `rows.status.ts`                    |        237 | Install reuse, auth state, Copilot provisioning, version |
| `rows.turns.ts`                     |        235 | Text, attachment, tool, approval, question, cancel       |
| `rows.recovery.ts`                  |        206 | Disconnect + replay, duplicate receipt (pure checks)     |
| `session.ts`                        |        228 | Thread commands, replay paging, view reducer             |
| `client.ts`                         |        199 | Local socket and SSH relay transports                    |
| `workspace.ts`                      |        145 | Disposable workspace, journal                            |
| `cleanup.ts`                        |         86 | Cleanup and restore                                      |
| `report.ts`, `redact.ts`            |    159, 49 | Matrix rendering and redaction                           |
| `mockBackend.ts`, `mockProvider.ts` |   317, 133 | Self-test backend and provider, with fault injection     |
| Tests (4 files + helper)            | ≤ 130 each | See below                                                |

`docs/COMMANDS.md`, the root `package.json` (`provider-conformance`) and the `justfile`
(`just provider-conformance`) have the entry points. No `src/**` file changed.

## Tests and checks

- `run.test.ts` covers the self-test against the mock:
  - every row id appears, and every status occurs;
  - Muse's attachment rejection is observed;
  - Copilot is provisioned only with the flag;
  - only conformance-named threads and projects are created, and all are removed;
  - the self-test reports `acceptance: none`.
- `rows.recovery.test.ts` covers:
  - the replay check: duplicate, reordered, gapped, non-idempotent, missing user message,
    missing reply and multiple settlements;
  - the duplicate-receipt check: each condition on its own;
  - injected mock faults: a duplicate that runs twice, a duplicated replay event, any
    revision accepted, and an ignored interrupt. Each one makes its row fail.
- `rows.status.test.ts` covers:
  - version rejection with 401, no status, accepted, and the wrong advertised revision;
  - the auth-state cases;
  - the completed-turn judgement.
- `report.test.ts` covers:
  - redaction of paths, tokens, emails, nonces and secret pairs;
  - a mock run whose planted executable paths and messages never reach the JSON or markdown;
  - matrix rendering;
  - acceptance labels.

Results:

- **Focused tests:** `bun run --cwd apps/server vitest run scripts/providerConformance/`:
  4 files, 44 tests pass.
- **Formatting and lint:** explicit-path `bunx oxfmt` and `bunx oxlint` on every new file are
  clean.
- **Typecheck:** `bun run --cwd apps/server typecheck` reports no errors in these files.
- **Transport smoke test:** a throwaway local `ws` server on a Unix socket. Handshake, RPC and
  the 426 refusal all worked through both the local-socket backend and a `Duplex.from` stream,
  the same wrapping the SSH relay uses.
- **Not verified:** the harness has not yet run against a real backend.

Mutation check: ten mutants, one at a time, with backups in a private job directory. All ten
were killed:

1. sk-token redaction removed;
2. path redaction removed;
3. replay ordering check removed;
4. duplicate conflict check removed;
5. non-426 status accepted;
6. self-test counted as acceptance;
7. Copilot provisioned without the flag;
8. cleanup skips thread deletion;
9. token-in-reply check removed;
10. any settled outcome counted as cancelled.

Mutants 5 and 9 first survived. That led to `rows.status.test.ts`.

## User M4 checklist (live conformance)

Run this per tuple: glibc Linux **x86_64** and **arm64** (decision 3). On each host, install
and sign in to the providers the backend advertises. Use the manual commands from the
recipes report; bigbud never runs vendor installers. Get the authority with
`bigbud backend status` on the host.

**1. Self-test (laptop, no backend).** Confirm that it prints "No acceptance" and exits 0:

```sh
bun run provider-conformance --self-test
```

**2. Plan.**

```sh
bun run provider-conformance --dry-run --transport relay --provision-copilot
```

**3a. From the laptop over the SSH relay (preferred).** Paths are absolute on the host and
follow the installed graph layout. Check them first with
`ssh <target> ls ~/runtime/backend/runtime/node ~/runtime/backend/server/remote-client-relay/`.

```sh
bun run provider-conformance --transport relay --ssh <target> --authority <32-hex> \
  --relay-node /home/<user>/runtime/backend/runtime/node \
  --relay-entry /home/<user>/runtime/backend/server/remote-client-relay/remoteBackendClientRelay.mjs \
  --tuple linux-x86_64-glibc --provision-copilot
```

**3b. Or on the host, with the graph's private Node.** Copy `remoteBackendMeasure.client.ts`
and `providerConformance/` into one `scripts/` directory, keeping the layout:

```sh
ssh <target> mkdir -p bigbud-conformance-tool/scripts
scp -r apps/server/scripts/remoteBackendMeasure.client.ts apps/server/scripts/providerConformance \
  <target>:bigbud-conformance-tool/scripts/
ssh <target> '~/runtime/backend/runtime/node bigbud-conformance-tool/scripts/providerConformance/driver.ts \
  --authority <32-hex> --tuple linux-arm64-glibc --provision-copilot'
```

**4. Per provider**, as needed:

- Narrow the run with `--providers codex,claudeAgent,…` and `--rows …`.
- Pin a model with `--model codex=<slug>`. The default is the first available advertised
  model.
- Raise `--turn-timeout-ms` (default 180000) for slow providers.
- Leave OpenCode v2 not-run unless its shared service is already running and `ready`.
- `cliProxy` needs the user's proxy service running.

**5. Auth rows.** On one host, sign out of one provider (for example `codex logout`). Then run:

```sh
bun run provider-conformance … --providers codex --rows install-reuse,auth-state \
  --expect-needs-auth codex
```

Sign back in afterwards.

**6. Missing optional SDK (WP-5C note).** Build the graph with `@github/copilot-sdk` in
`absentOptionalExternals`, deploy it, and run with `--providers codex,copilot`. Codex should
pass. Copilot's session rows should fail with `OptionalSdkUnavailableError` on first use, and
bootstrap should be unaffected.

**7. Record.** Attach both `provider-conformance-live-*.md` matrices (one per tuple) to the M4
validation report:

- `acceptance: candidate` means every row passed or is declared unsupported.
- `failed` means at least one row failed or did not run. Review each reason.
- "Cleanup incomplete; rerun with --restore <workDir>" means exactly that (the journal is kept).

## Limits and follow-ups

- A `fail` on `question` or `approval` can mean the model ignored the fixed prompt. The
  reason says so; rerun before treating it as an adapter defect. Codex may need plan mode to
  ask questions, and the harness has no switch for this yet.
- `auth-state` cannot observe _expired_ credentials safely. Only an explicit sign-out is
  exercised.
- The relay transport needs `ws` on the laptop. It is resolved from this checkout's Bun store,
  or from `--ws-module`.
