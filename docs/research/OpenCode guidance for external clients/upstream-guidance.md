# OpenCode upstream integration guidance

## What integration architecture does upstream actually recommend?

### Takeaway

**Upstream explicitly positions the network client for applications connecting to an existing server.** This is not merely our architectural inference. Its Build guide says: “Connect to OpenCode with the same client used by the TUI and desktop app.” The client guide says: “Use it when your application connects to an OpenCode server over the network.” [Build](https://opencode.ai/v2/docs/build/); [Client](https://opencode.ai/v2/docs/build/client#javascript)

| Concern                 | Upstream position                         | bigbud-specific choice                   |
| ----------------------- | ----------------------------------------- | ---------------------------------------- |
| Existing native service | Network `@opencode/client`                | Attach; do not embed another host        |
| Local discovery         | `discover()` explicitly does not start    | Never escalate to `ensure()`             |
| Authentication          | Official `Service.headers(endpoint)`      | Keep credentials in trusted backend      |
| Recovery                | Raw subscriptions are live-only           | Rediscover, resubscribe, reconcile reads |
| Feature extensions      | Configured plugin RPC                     | Optional already-installed plugins only  |
| Durable identity        | No reviewed binding/DB-attestation policy | Preserve independent safeguards          |

### Cited Findings

- The SDK instead “hosts OpenCode directly inside your application,” assembling a server and routing calls in memory, with an “explicitly owned host.” It is an alternative product architecture, not an attachment mechanism. [SDK](https://opencode.ai/v2/docs/build/sdk#overview)
- The Effect client returns typed Effects/Streams and decoded schemas; its Node-only service entrypoint supports discovery. [Effect client](https://opencode.ai/v2/docs/build/client/effect#local-background-service)
- Plugins provide hooks/transforms beyond ordinary client operations; custom methods/events can run on the server and be called by clients. Crucially: “The server plugin still needs to be configured and running.” Importing a contract is not installation. [Plugin RPC](https://opencode.ai/v2/docs/build/plugins/rpc#subscribe)

### Inferences

- Network attachment best fits bigbud’s stated reuse/no-lifecycle requirements. Upstream offers multiple integration modes; it does not prescribe embedding for every third-party application.

### Gaps

- No reviewed source guarantees permanent compatibility for third-party clients. The official API calls itself “Experimental HttpApi surface”; session, permission, and event groups are also experimental. A stable executable release is not a frozen API promise. [API](https://opencode.ai/v2/docs/api/#overview)

## How should discovery, authentication, and identity be interpreted?

### Takeaway

The official sample uses `ensure()`, but the same page explicitly documents the required alternative: “`Service.discover()` returns a healthy registered endpoint without starting a process.” [Client](https://opencode.ai/v2/docs/build/client#local-background-service)

### Cited Findings

- Pinned 2.0.24 source says registration is the “complete discovery contract” and discovery is “Read-only lookup: registration file plus health check and version gate. Never spawns; escalation to ensure() is the caller’s policy.” CLI-owned service configuration is not read. [Pinned service helper](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/effect/service.ts#L14-L30)
- The native helper derives Basic credentials from registration, probes `/api/info`, and checks PID/version against registration. This checks a registered process, not physical database identity. [Pinned probe](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/service-probe.ts#L27-L83)
- Remote/browser pairing uses one-use expiring links and session cookies; configuration changes stop the background server. Therefore CORS changes are not harmless connection setup under these constraints. [Web connections](https://opencode.ai/v2/docs/cli/web#access)
- Troubleshooting says: “Do not delete or edit service files or the database”; it documents `OPENCODE_DB` overrides. [Troubleshooting](https://opencode.ai/v2/docs/troubleshooting#service-files)

### Inferences

- Use discovery/auth helpers in bigbud’s Node/backend boundary, never `ensure`, restart, or service reconfiguration. Apply bigbud’s stable `>=2.0.24 <3` gate and required-operation checks; upstream does not prescribe that range.
- Do not treat URL, PID, registration ID, or logical session ownership as proof of the same physical DB. Missing upstream attestation guidance does **not** authorize weakening existing protections.

### Gaps

- No reviewed official guidance specifies physical-DB attestation or durable external-client binding. Native storage-directory protection remains bigbud’s unresolved safety review.
- Authentication discrepancy: the client guide illustrates Bearer headers, but pinned native authorization accepts Basic credentials/session cookies, not Bearer authentication. Use the native helper, not that generic example. [Pinned authorization](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/server/src/middleware/authorization.ts#L30-L37)

## What recovery behavior is documented versus merely demonstrated?

### Takeaway

“Subscriptions are live-only, with no replay or automatic reconnection.” Re-subscription after recovery is explicit guidance; durable binding, journaling, and uncertain-send policy are not. [Client](https://opencode.ai/v2/docs/build/client#stream-events)

### Cited Findings

- API supports sessions with location/IDs/metadata, durable prompt admission, inbox reads, and messages. Its separate **experimental session log** accepts an exclusive sequence cursor and optional live following; that is not replay for the global event subscription. [API](https://opencode.ai/v2/docs/api/)
- TUI/desktop use a higher-level connection loop with timeouts/resubscription; cached reads are invalidated on disconnect. The source explicitly says: “Reconnect invalidates cached reads; active UI owners decide what to sync again.” These demonstrate implementation, not prescribed external-client policy. [Connection](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/solid/connection.ts#L147-L181); [Data](https://github.com/anomalyco/opencode/blob/e7a34f09bfd9134dfade5a8ddb843f7030bc9a69/packages/client/src/solid/data.ts#L1-L4)
- Approval handling is client responsibility; `always` saves project-scoped approvals. Shell retains the host user’s filesystem/process/network authority. [Permissions](https://opencode.ai/v2/docs/permissions#approvals)

### Inferences

- Persist bigbud-owned session bindings and prompt journals; recover through verified session/inbox/message reads, and do not automatically resend uncertain submissions. This is **bigbud policy**, not an upstream exactly-once guarantee. Preserve native permissions/configuration.

### Gaps

- Research retrieved 2026-10-11. Source pins: 2.0.24 `e7a34f09bfd9134dfade5a8ddb843f7030bc9a69`; 2.0.26 `9b4ec5714d481559990db0a816d5dec19541a814`. Promise client documentation is identical at both pins and inspected newer `dev` ref `38454c6e9c51f9eb1f98fcec0060ef434f378bb8`; service implementations differ. Do not transplant newer behavior or interpret native-client recovery as a guarantee.
