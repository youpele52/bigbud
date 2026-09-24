# OpenCode V2 SDK Wait Decision

**Date:** 11 August, 2026
**Status:** Deferred
**Owner:** bigbud

## Summary

Do not migrate bigbud to OpenCode's current `/api/*` contracts yet. Wait until the external network client is public, stable, well-tested, and proven reliable in production integrations.

## Current State

- bigbud uses published `@opencode-ai/sdk` APIs, although the `/v2` import path still exposes legacy unprefixed server endpoints.
- OpenCode's current `/api/*` client surface remains beta and its consumer namespace is not finalized.
- `@opencode-ai/client`, the intended network client for apps like bigbud, is private and unpublished.
- `@opencode-ai/sdk-next` is private, in-process only, and unsuitable for bigbud's subprocess, SSH, and KiloCode architecture.

## Decision

- Do not adopt `client.v2.*`, private OpenCode packages, or direct `/api/*` calls as bigbud's primary integration.
- Do not rewrite stable session, event, permission, question, or reconnect behavior around transitional contracts.
- Continue applying necessary compatibility fixes to the existing integration only.

## Revisit Gate

Reconsider migration only when all of these are true:

- OpenCode publishes and documents its network client for external consumers.
- The API and client namespaces are declared stable.
- OpenCode provides a supported migration guide from legacy SDK endpoints.
- Durable events, reconnects, permissions, questions, tools, MCP, and remote directory scoping are documented and tested.
- KiloCode compatibility is confirmed or has a deliberate separate strategy.
- Several releases have passed without significant SDK or API regressions.

## Sources

- [OpenCode architecture](https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md)
- [OpenCode network client](https://github.com/anomalyco/opencode/blob/dev/packages/client/README.md)
- [OpenCode SDK Next](https://github.com/anomalyco/opencode/blob/dev/packages/sdk-next/README.md)
- [OpenCode V1 API migration](https://github.com/anomalyco/opencode/blob/dev/packages/app/V1_API_MIGRATION.md)
