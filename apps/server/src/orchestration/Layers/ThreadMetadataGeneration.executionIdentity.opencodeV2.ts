import { realpath } from "node:fs/promises";
import type { ProviderInfo, IntegrationInfo, CredentialEntry } from "@opencode/client";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { hasOpencodeV2NativeTrust } from "@bigbud/shared/opencodeNativeTrust";
import type { V2ConsentAuthority } from "../../provider/Layers/OpencodeV2/Application.consent.ts";
import {
  runAuthorizedV2,
  currentV2RequestContext,
  runV2RequestContext,
} from "../../provider/Layers/OpencodeV2/Client.guard.ts";
import { v2Request } from "../../provider/Layers/OpencodeV2/Client.ts";
import { connectV2TextGeneration } from "../../provider/Layers/OpencodeV2/TextGeneration.connection.ts";
import { v2SharedRegistrationFile } from "../../provider/Layers/OpencodeV2/SharedService.registration.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataProviderConfiguration } from "./ThreadMetadataGeneration.configuration.ts";

// Arbitrary SDK settings/headers/body may override integration authentication or routing.
export function v2MetadataCredentialScope(
  provider: ProviderInfo,
  integration: IntegrationInfo,
  credentials: ReadonlyArray<CredentialEntry>,
) {
  if (
    !provider.integrationID ||
    provider.integrationID !== integration.id ||
    provider.activation === "disabled" ||
    (provider.canonical && provider.canonical !== provider.id) ||
    Object.keys(provider.headers ?? {}).length ||
    Object.keys(provider.body ?? {}).length ||
    Object.keys(provider.settings ?? {}).some(
      (key) =>
        !["timeout", "headerTimeout", "chunkTimeout", "compaction", "encoding"].includes(key),
    ) ||
    integration.connections.length !== 1 ||
    integration.connections[0]?.type !== "credential"
  )
    return null;
  const active = credentials.filter(
    (entry) => entry.integrationID === integration.id && entry.active,
  );
  if (
    active.length !== 1 ||
    active[0]!.value.type === "external" ||
    integration.connections[0].id !== active[0]!.id
  )
    return null;
  return metadataFingerprint(["opencodeV2", "active-credential-scope", active[0]]);
}

/** Public location/provider/integration/active-credential APIs only; never private account tables.
 * Environment/external integrations lack exact credential evidence and remain unavailable.
 */
export async function opencodeV2MetadataIdentity(
  selection: ModelSelection,
  providers: ServerSettings["providers"],
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
  consent: V2ConsentAuthority | undefined,
  signal: AbortSignal,
) {
  const config = providers.opencodeV2;
  if (
    selection.provider !== "opencodeV2" ||
    !selection.subProviderID ||
    !cwd ||
    !consent ||
    !config.enabled ||
    resolveOpencodeV2ConnectionMode(config) !== "shared" ||
    !hasOpencodeV2NativeTrust(config)
  )
    return null;
  return runAuthorizedV2(
    consent,
    config.serviceFile?.trim() || v2SharedRegistrationFile(),
    async () => {
      const context = currentV2RequestContext()!;
      const transport = await realpath(context.transport);
      const directory = await realpath(cwd);
      context.permit.assertCurrent();
      return runV2RequestContext({ ...context, transport, operationSignal: signal }, async () => {
        const connection = await connectV2TextGeneration(transport, signal);
        try {
          const client = connection.client;
          const provider = await v2Request(
            "metadata provider identity",
            (abort) =>
              client.provider.get(
                { providerID: selection.subProviderID!, location: { directory } },
                { signal: abort },
              ),
            { signal },
          );
          if (
            provider.location.directory !== directory ||
            provider.data.id !== selection.subProviderID ||
            !provider.data.integrationID
          )
            return null;
          const integration = await v2Request(
            "metadata integration identity",
            (abort) =>
              client.integration.get(
                { integrationID: provider.data.integrationID!, location: { directory } },
                { signal: abort },
              ),
            { signal },
          );
          if (
            integration.location.directory !== directory ||
            integration.data.id !== provider.data.integrationID ||
            integration.data.connections.some((entry) => entry.type === "env")
          )
            return null;
          const credentials = await v2Request(
            "metadata credential scope",
            (abort) => client.credential.list({ signal: abort }),
            { signal },
          );
          const accountIdentity = v2MetadataCredentialScope(
            provider.data,
            integration.data,
            credentials,
          );
          if (!accountIdentity) return null;
          context.permit.assertCurrent();
          return {
            accountIdentity,
            transport: metadataFingerprint({
              version: 1,
              selection,
              directory,
              config: metadataProviderConfiguration(config),
              descriptor: connection.descriptor,
              provider: provider.data,
              environment,
            }),
          };
        } finally {
          await connection.close();
        }
      });
    },
  );
}
