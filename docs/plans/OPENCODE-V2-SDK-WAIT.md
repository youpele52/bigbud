# OpenCode V2 SDK Migration Reassessment

**Original decision:** 11 August 2026

**Reassessed:** 29 September 2026

**Status:** Upstream publication blocker resolved; production migration still gated

**Owner:** bigbud

## Verdict

The issue raised in the original note was real, but its central upstream blocker is no longer an issue:

- OpenCode now publishes the supported external network client as `@opencode/client`.
- OpenCode V2 is released, documented, and has a public V1-to-V2 migration guide.
- The network client is generated from the same contract as the server API.

This does **not** make migration a dependency-only upgrade. bigbud's OpenCode adapter uses V1 contracts extensively, while OpenCode V2 intentionally breaks the server API, event model, prompts, user-input flow, plugins, and tools. KiloCode has also not completed its OpenCode V2 migration, so the shared OpenCode/KiloCode adapter cannot move to V2 as one unit.

**Decision:** stop waiting for a public SDK, but do not replace the production V1 integration yet. The next safe step is a separate OpenCode V2 adapter and compatibility investigation, while retaining the current V1 path for KiloCode.

See [`2026-09-29-opencode-v2-bigbud-fit-assessment.md`](./2026-09-29-opencode-v2-bigbud-fit-assessment.md) for the capability matrix, source/runtime findings, proposed architecture, and production gates.

## What Changed Since the Original Decision

### Resolved

| Original concern                                | Current evidence                                                                                                     | Result              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------- |
| External network client was private/unpublished | `@opencode/client` is public on npm; `latest` is `2.0.19`                                                            | Resolved            |
| Consumer namespace was unsettled                | Official docs name `@opencode/client` and show `OpenCode.make(...)`                                                  | Resolved            |
| No supported migration guide                    | OpenCode publishes **Migrate from V1** and a generated V2 API reference                                              | Resolved            |
| V2 was beta/transitional                        | `@opencode/client@2.0.0` was published on 11 September 2026; `2.0.19` on 29 September 2026                           | Resolved, but young |
| `sdk-next` was in-process only                  | The embedded-host product is now documented separately as `@opencode/sdk`; it is not the network client bigbud needs | Clarified           |

The expected package name changed. The supported network package is `@opencode/client`, not the earlier internal `@opencode-ai/client`. The latter still has prerelease tags and should not be selected for bigbud's integration.

### Still Material

1. **OpenCode V2 is a breaking protocol migration.** The official guide explicitly identifies the server API/client and plugin API as breaking changes.
2. **Live events are intentionally volatile.** `client.event.subscribe()` has no replay or automatic reconnection. Events can be missed during disconnects, and slow consumers can overflow the stream.
3. **The durable replay endpoint is experimental and is not currently usable as a standard-server recovery foundation.** `client.session.log({ sessionID, after, follow })` exposes an aggregate-sequenced session log, but ordinary `opencode serve` startup leaves event persistence disabled. A `2.0.19` runtime probe returned only `log.synced` after seven live lifecycle events.
4. **KiloCode is not ready to share this migration.** Kilo's open migration epic describes its released runtime as V1-based and calls for a staged V2 strangler migration. bigbud currently reuses its OpenCode adapter and V1 SDK contracts for both providers.
5. **The stable V2 release is recent.** Nineteen patch releases exist, but only about eighteen days separate `2.0.0` and `2.0.19`. That demonstrates active correction, not yet a long stability window.

## Impact on bigbud

### Current Integration

bigbud currently depends on `@opencode-ai/sdk@^1.17.13` and imports `@opencode-ai/sdk/v2`. Despite the `/v2` import name, these are the generated contracts for the V1 server architecture, not the released OpenCode 2 client.

The production adapter depends on V1 operations including:

- `session.create`, `session.delete`, `session.abort`, `session.status`, and `session.children`
- `session.promptAsync` and `session.messages`
- `event.subscribe`
- `permission.list` and `permission.reply`
- `question.list` and `question.reply`
- `mcp.add`, `mcp.connect`, and `mcp.disconnect`
- `tool.ids`
- `config.providers` and `provider.list`

### V2 Is Not a Mechanical Rename

The released client contains most required capabilities, but several contracts have different ownership or semantics:

| bigbud V1 dependency                                  | OpenCode V2 direction                                                          | Migration consequence                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `{ data, error }` responses                           | Unwrapped values; declared errors throw                                        | Rewrite error handling and deadline wrappers            |
| `session.promptAsync(...)`                            | `session.prompt(...)` with delivery/resume semantics                           | Rework prompt admission and completion settlement       |
| Per-prompt model, system, variant, and tool overrides | Session/model selection, instruction/plugin, and permission-oriented contracts | Re-design turn configuration; do not blindly map fields |
| `session.status()`                                    | `session.active()` plus durable session events/messages                        | Rework authoritative liveness inspection                |
| `question.list/reply`                                 | Session forms (`session.forms.*`)                                              | Re-map user-input state and answers                     |
| `permission.reply({ requestID, reply })`              | Session-scoped reply with `decision` and optional feedback                     | Update identifiers and approval mapping                 |
| `event.subscribe()`                                   | Live-only shared stream                                                        | Preserve explicit retry and reconciliation              |
| Message polling and live events                       | Projected message APIs plus experimental `session.log()`                       | Reconcile from projected state; do not assume replay    |
| `tool.ids()` and V1 local tool/plugin behavior        | V2 plugin transforms and MCP catalogs                                          | Rework capability discovery and tool filtering          |
| Directory header/query behavior                       | Explicit Location values                                                       | Validate local, SSH, and remote-workspace scoping       |

The existing `opencode serve --hostname ... --port ...` process model still exists in OpenCode `2.0.19`, so subprocess ownership itself remains compatible. The API behind that process is not compatible.

## Revisit-Gate Assessment

| Gate from the original note                             | Status               | Evidence                                                                                          |
| ------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| Public documented network client                        | Pass                 | `@opencode/client` docs and npm release                                                           |
| Stable API/client namespace                             | Pass with caution    | Stable `2.0.x` package and official imports; release line is still young                          |
| Supported V1 migration guide                            | Pass                 | Official V1 migration and plugin migration guides                                                 |
| Durable events and reconnect behavior documented/tested | Partial              | Global events are volatile; standard `serve` does not currently persist replayable session events |
| Permissions and user input documented                   | Pass with adaptation | Permission APIs exist; V1 questions became V2 forms                                               |
| Tools and MCP documented                                | Pass with adaptation | MCP APIs exist; plugin/tool contracts are intentionally different                                 |
| Remote directory scoping documented                     | Pass for API shape   | Location is explicit; bigbud's SSH/remote bridge behavior still needs end-to-end proof            |
| KiloCode compatibility confirmed or separated           | Fail                 | Kilo's V2 migration epic remains open; bigbud has no split adapter yet                            |
| Several releases without significant regressions        | Not yet proven       | `2.0.0` is less than three weeks old at reassessment                                              |

## Recommended Next Step

Treat this as a migration-planning issue rather than an SDK-availability issue.

1. Keep `@opencode-ai/sdk` and the current shared adapter for production OpenCode V1 and KiloCode.
2. Introduce a version/capability boundary before changing any provider behavior. OpenCode V2 must not be routed through the KiloCode adapter by accident.
3. Build a narrow OpenCode V2 spike around `@opencode/client` covering:
   - server startup and health;
   - location-scoped model/provider discovery;
   - session create, prompt, interrupt, and completion;
   - permissions and forms;
   - MCP bridge registration;
   - event disconnect, retry, durable-log behavior, projected-state recovery, and duplicate settlement;
   - local and remote-workspace execution.
4. Do not rely on the experimental session log unless a supported server mode begins persisting events. Keep bigbud's existing reconciliation strategy using authoritative session/message reads after stream recovery.
5. Run the V1 and V2 adapters side by side behind explicit runtime detection until parity tests pass.
6. Keep KiloCode on its V1-specific adapter until Kilo publishes a compatible V2 server/client contract or bigbud implements a deliberate Kilo-specific migration.

## Final Classification

- **Was the original issue valid?** Yes.
- **Is the missing public OpenCode V2 network SDK still an issue?** No.
- **Is migrating bigbud to OpenCode V2 now a non-issue?** No. It remains a substantial, provider-specific migration.
- **Should bigbud continue waiting without investigation?** No. Upstream is ready for a bounded adapter spike.
- **Should bigbud switch production immediately?** No. Durable recovery maturity, contract parity, and KiloCode separation remain open gates.

## Sources

### OpenCode

- [V1-to-V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/)
- [JavaScript network client](https://opencode.ai/v2/docs/build/client)
- [Generated V2 API reference](https://opencode.ai/v2/docs/api)
- [Live event subscription contract](https://opencode.ai/v2/docs/api/event/v2-event-subscribe)
- [Experimental durable session log](https://opencode.ai/v2/docs/api/session/v2-session-log)
- [V1 plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Embedded SDK overview](https://opencode.ai/v2/docs/build/sdk)
- [`@opencode/client` on npm](https://www.npmjs.com/package/@opencode/client)
- [OpenCode client source README](https://github.com/anomalyco/opencode/blob/dev/packages/client/README.md)
- [OpenCode SDK source README](https://github.com/anomalyco/opencode/blob/dev/packages/sdk-next/README.md)

### KiloCode

- [Kilo OpenCode 2 strangler migration epic](https://github.com/Kilo-Org/kilocode/issues/12887)

### bigbud Evidence

- `apps/server/package.json`
- `apps/server/src/provider/Layers/Opencode/ServerManager.ts`
- `apps/server/src/provider/Layers/Opencode/Adapter.session.start.ts`
- `apps/server/src/provider/Layers/Opencode/Adapter.session.prompt.ts`
- `apps/server/src/provider/Layers/Opencode/Adapter.session.turn.ts`
- `apps/server/src/provider/Layers/Opencode/Adapter.stream.ts`
- `apps/server/src/orchestration-tools/orchestrationMcpBridge.session.ts`
