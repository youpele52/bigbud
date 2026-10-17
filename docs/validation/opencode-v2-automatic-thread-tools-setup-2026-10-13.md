# OpenCode V2 automatic required-plugin setup: v3 validation

## Scope and status

Latest user direction authorizes **source behavior**, not actual user-native activation. The [automatic-setup plan amendment](../plans/2026-10-13-opencode-v2-automatic-thread-tools-setup-plan.md) supersedes only manual required-plugin installation. Production remains shared-service-only, with automatic actual chat/worktree Location detection, one user-level managed entry, expanded versioned one-time acknowledgement, independent readiness per Location/turn and no optional/per-chat bridge switch.

No actual user-native configuration, account, credential, permission, service or live thread has been changed by this implementation session. All native test writes/processes/prompts belong to disposable owned fixtures and synthetic vendors. No CLI reload/upgrade or git publication occurred. Existing ChatGPT-plan work belongs to another worker and was not edited by this implementation; preserve it in the final worktree snapshot.

**v2 evidence is historical, not v3 green.** The old root notification was already delivered: exit 0, 9/9 tasks, server 1026 files/4433 tests passed, 47 files/104 tests skipped. Frozen v2 manifest SHA-256 remains `c370a43d82fe94ca9ff3a692614f69cb8237b02e29a0409846607e13f6cabea5`; its final ledger retains SHA-256 `6c15f65929104608f88800bc925a8d7cd1f167bd3feadedfc8845344a6903f1a`. Neither immutable manifest was rewritten.

**Current status:** implementation is ready for final frozen-v3 verification and independent parent reviews. Interim passes below are not a full-root or final reviewer-green claim. Child review/fixer agents could not start because the session's subagent depth limit is 1; the parent must run independent functional/code, security and requirements reviews after the v3 freeze. No configuration change to bypass that limit is authorized/needed.

## Implemented boundaries

- `managed-thread-tools-v2` is an explicit expanded persisted acknowledgement; old `host-user-v1` permits no installer/native config reads. Enabling alone, settings-open, health/catalog discovery and hidden learning/review cannot trigger setup.
- Optional trimmed `nativePluginConfigRoot` is config placement only, with clear/default behavior and absolute/NUL/length validation. Changing it synchronously revokes settings/installer/callback authority, not the shared-service identity or chat CWD.
- The public native config-source API must prove the exact selected global root before filesystem mutation. Wrong native environment/override fails without another root or local/private fallback. Native execution qualification is exactly 2.0.26/2.0.27; automatic publication currently fails closed outside macOS ARM64.
- One signed app-owned global autoload shim imports the immutable artifact. Native JSON/JSONC, comments, legacy entries, accounts, models, permissions and other plugins are never rewritten. Existing uniquely verified manual setup is reused without a shim/duplicate namespace.
- Bounded owner/no-follow/ancestor/file-identity checks permit existing safe 0755 user config directories, reject foreign/link/writable/collision paths and never chmod-repair them. First publication is atomic/no-overwrite; upgrades require exact signed prior bytes/inode and defer while enrollment leases may live. Publication locks are signed app-owned evidence; no live/unconfirmed PID is killed or lock stolen.
- Compatible publishers coalesce. Cancelling a waiter detaches without cancelling another authorized waiter; all-waiter cancellation and consent/root revocation fence late publication. Signed reserved/publishing/committed records preserve crash/uncertainty evidence; removed managed entries and unconfirmed absent publication are not recreated automatically.
- Setup RPC infers context from the canonical worktree/project/default. Legacy directory input remains read-only historical projection input, never an installation CWD override. Foreground startup/new-turn verification precedes native create/update/prompt and canonical admission. Models and compatible history remain visible/conserved on setup faults.
- Settings show a config-root override, detected Location, explicit retry and blue/green/amber/red working/success/warning/failure semantics. The automatic UI trigger follows explicit persisted expanded acknowledgement/enable, not opening settings or re-mounting an already acknowledged component. Settings/root/consent changes fence stale responses.
- All five canonical tools, independent once-action approval, native rule order/deny filtering, encrypted/signed callback transport, caller/target ACLs, stable IDs/receipts and read-only incompatible history remain intact.

## Investigation and interim evidence

Official current V2 config/plugin/OpenAPI docs and Context7 V2 documentation were consulted. Autoload/watch/source proof, global/project removal precedence and managed-only upgrades passed in disposable actual 2.0.26 and 2.0.27 services. An early red probe exposed multiple same-ID plugin records when manual and autoload aliases coexist; the installer explicitly reuses a verified manual source without adding a shim and rejects duplicate/foreign namespaces. Do not cite red/transient investigation logs as final-green evidence.

| Interim command                                                                    | Actual result                                          | Retained log/evidence                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| `bun fmt`                                                                          | Exit 0                                                 | `thread-tools-v3-fmt-interim.log`                      |
| `bun lint`                                                                         | Exit 0, warnings only; no test-length policy violation | `thread-tools-v3-lint-interim.log`                     |
| `bun typecheck`                                                                    | Exit 0, 9/9 tasks                                      | `thread-tools-v3-typecheck-interim-root.log`           |
| Focused server new setup/settings suites                                           | 9 files/19 tests passed                                | `thread-tools-v3-core-interim.log`                     |
| Contracts managed settings + shared trust focused suites                           | 1 test each passed                                     | Tool output; final full-root run must cover them again |
| Focused settings Chromium suites                                                   | 3 files/6 tests passed                                 | `thread-tools-v3-browser-interim.log`                  |
| Owned 2.0.26 automatic production dispatch + readiness-failure matrix              | 2 files/2 tests passed                                 | `thread-tools-v3-production-2.0.26-interim.log`        |
| Owned 2.0.27 automatic application suite after orphan-worktree argument correction | 1 file/2 tests passed                                  | `thread-tools-v3-auto-2.0.27-interim.log`              |

Logs reside under `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/`. The earlier seven-file 2.0.27 interim run had a fixture Git-argument failure; its passing six files do **not** make that run green. `git worktree add --orphan -b owned-qualification <path>` fixed the disposable orphan fixture without staging/committing. Final native suites must rerun all affected files on both versions after the freeze.

## Final gate requirements

1. Record immutable v3 dirty-worktree manifest and v2→v3 delta, with separate attribution of preserved concurrent/unrelated work. Audit every authored/materially edited code/test/emitted file against the ≤400-line limit.
2. After freeze, serialize `bun fmt`, `bun lint`, `bun typecheck`, focused server/contract/shared/browser checks, owned-native 2.0.26/2.0.27 suites and **`bun run test`**, never `bun test`. Record exact command lists/environment, exit codes, durations, skipped tests and root task counts in external immutable evidence. A CLI-managed AGENTS formatting toggle is not authored feature code.
3. No source edits while frozen validation runs; any in-scope fix requires a new versioned snapshot and affected/full checks again. Never overwrite v1/v2/v3 manifests or transfer a previous green verdict.
4. Parent independent functional/code, security and requirements reviews compare frozen v3 bytes against the latest goal, this amendment and actual final evidence. Do not claim overall completion before those reviews accept all requirements. Rust/platform/live-vendor checks not executed are not passes; no Rust source is changed by v3.
5. Finalize this v3 ledger only after final evidence is available, retaining its prior frozen digest and a separate final-doc hash/exception record; no other frozen-file deviation is permitted. The v2 historical ledger/manifests remain unchanged.

**Code green:** No final v3 claim yet. **Implementation/Plan green:** No; independent parent review remains pending. No user-native activation or git publication is required to complete source acceptance.
