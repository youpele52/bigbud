# Attach External Clients Without Owning OpenCode

**OpenCode explicitly supports third-party applications connecting to its existing service through the official network client.** Its Build guide says: “Connect to OpenCode with the same client used by the TUI and desktop app.” This fits bigbud’s requirement to reuse the user’s accounts, session history, and configuration without hosting another runtime. However, ordinary native startup and the documentation’s local-client example permit service creation; bigbud must deliberately choose discovery-only attachment. Upstream documents authentication helpers and live-stream resubscription, but does not prescribe bigbud’s logical ownership, physical-storage identity, or uncertain-submission policies. This report separates those boundaries rather than repeating a capability matrix. Evidence was reviewed on **2026-10-11**, with native implementation claims pinned to **2.0.24**, commit `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`; this is not a maintainer consultation or cross-platform runtime qualification. ([Build guide](https://opencode.ai/v2/docs/build/))

## The network client attaches; the SDK hosts

The client guide recommends `@opencode/client` when an application “connects to an OpenCode server over the network.” Its Promise and Effect interfaces expose the native HTTP contract. Attachment therefore delegates sessions and execution to the existing service, using its configured accounts and project configuration rather than copying credentials, reading SQLite, or introducing a parallel account/history store. Correct Location selection still matters: connecting to the same endpoint does not mean every project has identical configuration. ([Client guide](https://opencode.ai/v2/docs/build/client#javascript))

By contrast, `@opencode/sdk` “hosts OpenCode directly inside your application” and returns an “explicitly owned host,” routing requests in memory without an HTTP listener. That is an official but different architecture: **embedding does not satisfy borrowing an already-running native service without lifecycle ownership**. Neither first-party client usage nor sharing the API contract establishes an SLA or universal feature parity. ([SDK overview](https://opencode.ai/v2/docs/build/sdk#overview))

| Upstream documented                                                 | bigbud decision                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Network client is used by TUI/desktop; SDK owns an embedded host.   | Attach with the client; do not embed or provision a fallback runtime.                |
| `discover()` never starts; `ensure()` starts when needed.           | Discover only; unavailable services produce user guidance, not lifecycle escalation. |
| `Service.headers(endpoint)` supplies native authentication.         | Keep discovery and credentials in the trusted backend, outside the browser.          |
| Global subscriptions are live-only; subscribe again after recovery. | Rediscover, resubscribe, and reconcile authoritative session reads.                  |
| Sessions expose IDs, Location, metadata, inbox, and messages.       | Logical bindings, journals, and ownership checks are our proposed policies.          |
| Plugin RPC requires a configured implementing server plugin.        | Invoke already-configured extensions only; do not install or inject plugins.         |

## Discovery provides an endpoint, not storage attestation

The official example uses `Service.ensure()`, but the same page explicitly states: “`Service.discover()` returns a healthy registered endpoint without starting a process.” The main client is browser-compatible; local service helpers are Node-only. For macOS, Linux, and Windows, this supports one backend attachment design rather than three daemon-management implementations; it **does not prove identical runtime behavior** on all three. bigbud’s prohibition on start, stop, restart, reconfiguration, and automatic fallback is a stricter product policy, not OpenCode’s default lifecycle behavior. ([Local service documentation](https://opencode.ai/v2/docs/build/client#local-background-service))

Pinned source calls registration the “complete discovery contract” and discovery a “Read-only lookup: registration file plus health check and version gate. Never spawns; escalation to ensure() is the caller’s policy.” It expressly excludes CLI-owned service configuration. “Complete” concerns finding and authenticating an endpoint—not attesting durable storage. ([Pinned discovery contract](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/effect/service.ts#L14-L30))

The probe derives credentials from registration, checks `/api/info`, and compares PID/version. Its default path respects `XDG_STATE_HOME`, otherwise using the home state directory; avoid hard-coded platform guesses. These checks identify a registered process, **not the same physical database**. ([Pinned probe](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/service-probe.ts#L17-L83))

Authentication needs release-tied care: the documentation shows a generic Bearer example, whereas the pinned native middleware recognizes Basic credentials and session cookies. This discrepancy is not evidence that Bearer works for the installed native service. Follow the matching official `Service.headers(endpoint)` helper rather than manually crafting authorization; keeping native credentials out of browser code is bigbud’s security boundary. ([Pinned authorization](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/server/src/middleware/authorization.ts#L30-L69))

## Recovery repairs state; global events do not replay

Upstream states: “Subscriptions are live-only, with no replay or automatic reconnection.” Source failure ends subscriptions; clients must subscribe again after recovery. Thus global `/api/event` supplies live notifications, not sequence-cursor replay. bigbud’s proposed recovery adds authoritative session, inbox, message, form, and permission reads to repair missed state; bounded retries, persisted journals, and no automatic resend after uncertain admission remain **bigbud decisions**, not upstream exactly-once guarantees. ([Stream contract](https://opencode.ai/v2/docs/build/client#stream-events))

The separate experimental session log reads after an exclusive aggregate sequence and optionally follows live events. That session-scoped durable facility must not be described as replay of the global stream or every transient delta. ([Pinned session-log contract](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/protocol/src/groups/session.ts#L724-L740))

## Shared execution preserves authority, not isolation

The API describes itself as an “Experimental HttpApi surface”; session, permission, and event groups are experimental. No reviewed source promises future API compatibility through semver. bigbud’s version/capability gates require independent acceptance criteria. ([API reference](https://opencode.ai/v2/docs/api/#overview))

Permissions are not an OS sandbox: shell retains the host user’s filesystem, process, and network authority; `always` saves project-scoped approvals. “No native administrative writes” must mean no bigbud-managed account/configuration/plugin/service changes—not zero native writes: authorized sessions persist history and can execute ordinary edits. ([Permissions](https://opencode.ai/v2/docs/permissions#directories))

## Conclusion

Approve attachment architecture separately from identity and protection policy. Upstream does **not** recommend logical metadata ownership as a replacement for physical-storage identity, nor establish that physical identity is unnecessary. Accepting logical lineage across copied/imported stores, retiring storage probes, and revising protected-directory guarantees are distinct bigbud tradeoffs requiring separate review before implementation.
