import { makeOptionalSdk } from "../../optionalSdk.ts";

/**
 * The OpenCode v2 client SDK, loaded by literal dynamic import so a graph without it still
 * bootstraps. Client construction (`makeV2Client`) is synchronous and widely used, so the load
 * is started once when this module evaluates and a missing package is recorded, never thrown:
 * the typed `OptionalSdkUnavailableError` surfaces only when OpenCode v2 is actually used.
 */
const sdk = makeOptionalSdk("@opencode/client", async () => {
  const [client, service] = await Promise.all([
    import("@opencode/client"),
    import("@opencode/client/service"),
  ]);
  return { OpenCode: client.OpenCode, Service: service.Service };
});

await sdk.load().catch(() => undefined);

export const opencodeV2Sdk = sdk.loaded;
