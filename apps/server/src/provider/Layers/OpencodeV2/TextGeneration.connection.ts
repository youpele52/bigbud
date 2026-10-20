import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { readV2SharedServiceJson } from "./SharedService.discovery.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { assertV2TextGenerationContract } from "./TextGeneration.contract.ts";
import type { V2TextGenerationConnection } from "./TextGeneration.native.ts";

/** Verify the optional auxiliary ABI before acquiring any writable native session. */
export async function connectV2TextGeneration(
  serviceFile: string,
  signal: AbortSignal,
): Promise<V2TextGenerationConnection> {
  const config = await readV2SharedApplicationConfig({ serviceFile }, process.cwd());
  signal.throwIfAborted();
  const descriptor = config.process.sharedService;
  const registration = await readV2SharedRegistration(descriptor.registrationFile);
  const contract = await readV2SharedServiceJson(registration, "/openapi.json", { signal });
  assertV2TextGenerationContract(contract);
  signal.throwIfAborted();
  const connection = await borrowV2SharedService(descriptor);
  return {
    client: connection.client,
    storageIdentity: descriptor.storageIdentity,
    descriptor,
    close: connection.close,
  };
}
