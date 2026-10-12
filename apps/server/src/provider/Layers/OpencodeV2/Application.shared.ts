import { realpath } from "node:fs/promises";
import { resolveV2SharedConnection } from "./SharedService.descriptor.ts";
import { v2SharedRegistrationFile } from "./SharedService.registration.ts";
import type { V2DevelopmentConfig } from "./Development.config.ts";

/** Never initialize private profiles/plugins when borrowing the TUI's native service. */
export async function readV2SharedApplicationConfig(
  input: { serviceFile?: string },
  workspace: string,
): Promise<V2DevelopmentConfig> {
  const sharedService = await resolveV2SharedConnection(
    input.serviceFile?.trim() || v2SharedRegistrationFile(),
  );
  return {
    workspace: await realpath(workspace),
    process: {
      runtimeTargetId: "local",
      sharedService,
    },
  };
}
