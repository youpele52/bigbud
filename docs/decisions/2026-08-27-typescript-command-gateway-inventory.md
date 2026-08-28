# TypeScript Command Gateway Ingress Inventory

Date: 2026-08-27

This inventory classifies project/thread mutation ingress for the TypeScript
command gateway. TypeScript remains the only authority for canonical command
validation, admission, ordering, SQLite transactions, receipts, outcomes, and
canonical event history. Rust delivery handles only committed event delivery,
replay, fencing, backpressure, and application ACK.

| Path                                        | Source       | Classification                                                                      | Normalization                                           | Stable ID                               | Admission/fence                                                       | Side effects                                                                         |
| ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `orchestration.dispatchCommand` desktop RPC | `desktop`    | canonical gateway command                                                           | `normalizeDispatchCommand`                              | client command ID                       | startup readiness queue, orchestration queue, prepare/deletion fences | post-commit terminal close for archive                                               |
| mobile `orchestration.dispatchCommand`      | `mobile`     | canonical gateway command                                                           | `normalizeDispatchCommand`, mobile allow-list           | client command ID                       | startup readiness queue, orchestration queue, prepare/deletion fences | none in transaction                                                                  |
| automation create/update/delete handlers    | `automation` | canonical gateway command for target thread metadata/create/delete                  | handler-built normalized commands                       | server command ID                       | startup readiness queue, orchestration queue, prepare/deletion fences | schedule repository writes are infrastructure lifecycle                              |
| bootstrap turn/shell commands               | `desktop`    | canonical gateway child commands plus infrastructure Git/setup effects              | parent normalized command; deterministic child commands | parent/client ID and server child IDs   | cross-transport bootstrap lock plus orchestration queue/fences        | bootstrap recipe is persisted before Git; setup script runs after canonical dispatch |
| shell command execution                     | `desktop`    | canonical activity commands plus infrastructure process execution                   | `normalizeDispatchCommand`                              | client command ID plus server child IDs | startup readiness queue, orchestration queue, prepare/deletion fences | shell process execution is outside canonical transaction                             |
| orchestration tools                         | `internal`   | gateway command or documented post-commit reaction                                  | typed helper input                                      | server/invocation IDs                   | orchestration queue/fences                                            | browser/computer/workspace actions are infrastructure operations                     |
| provider runtime ingestion/reactors         | `provider`   | post-commit provider/runtime reaction producing canonical internal commands         | provider event mappers                                  | provider/runtime deterministic IDs      | orchestration queue/fences                                            | provider calls remain outside SQLite transaction                                     |
| retention                                   | `internal`   | canonical retention delete command plus infrastructure retention policy state       | typed retention command                                 | run/item command ID                     | retention claim inside command transaction plus deletion fences       | legacy recovery repositories are infrastructure-only                                 |
| projection repositories and migrations      | `internal`   | permitted direct projection/migration writes                                        | schema-decoded rows                                     | migration/replay owned                  | SQLite transaction or migration runner                                | no canonical command decision authority                                              |
| Git/browser/computer/workspace/terminal RPC | `desktop`    | authorized infrastructure operation unless it emits canonical project/thread events | operation schema                                        | operation-specific                      | subsystem-specific bounds                                             | no canonical project/thread mutation outside gateway                                 |

Static searches reconciled for this implementation:

- `orchestrationEngine.dispatch` direct ingress is concentrated behind
  `dispatchNormalizedCommand`, bootstrap/shell helpers, and internal reactors.
- Public desktop/mobile canonical mutation ingress routes through
  `dispatchNormalizedCommand`.
- `dispatchNormalizedCommand` requires the `CommandGateway` service; absence is
  a runtime construction error, not a silent direct-engine bypass.
- The gateway authorizes public `desktop`, `mobile`, and `automation` calls only
  with authenticated-session scope. `internal`, `provider`, and `startup`
  sources require internal scope.
- Bootstrap Git identity uses `orchestration_bootstrap_recipes` before Git.
- Remote bootstrap commands persist `executionTargetId` and requested branch in
  the same recipe before remote Git work; changed retry identity conflicts
  before a second remote Git operation.
- Command idempotency uses `orchestration_command_receipt_claims` and digest
  columns on `orchestration_command_receipts`.

Unknown project/thread mutation paths are blockers and must be added here before
moving them.
