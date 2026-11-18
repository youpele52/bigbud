import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { resolveCliProxyConfig } from "../../provider/Layers/CliProxy/config.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataProviderConfiguration } from "./ThreadMetadataGeneration.configuration.ts";

/** Gateway credential scope, NOT attestation of a proxy's upstream account or load balancing. */
export function cliProxyMetadataIdentity(
  selection: ModelSelection,
  providers: ServerSettings["providers"],
  environment: NodeJS.ProcessEnv,
) {
  if (selection.provider !== "cliProxy" || !providers.cliProxy.enabled) return null;
  const config = resolveCliProxyConfig(providers.cliProxy.configPath || undefined);
  return {
    accountIdentity: metadataFingerprint([
      "cliProxy",
      "gateway-credential",
      config.baseUrl.toString(),
      config.apiKey,
    ]),
    transport: metadataFingerprint({
      version: 1,
      selection,
      executionTarget: "local",
      config: metadataProviderConfiguration(providers.cliProxy),
      claudeBinary: providers.claudeAgent.binaryPath || "claude",
      configPath: config.configPath,
      endpoint: config.baseUrl.toString(),
      environment,
    }),
  };
}
