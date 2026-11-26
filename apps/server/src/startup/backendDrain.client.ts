import {
  requestBackendDrainControl,
  type BackendDrainClientInput,
} from "@bigbud/shared/backendDrain.client";

import type { BackendDrainResponse } from "./backendDrain.protocol.ts";

export type { BackendDrainClientInput };

/** One bounded request to the same-user backend control socket (shared with the desktop). */
export async function requestBackendDrain(
  input: BackendDrainClientInput,
): Promise<BackendDrainResponse> {
  return (await requestBackendDrainControl(input)) as BackendDrainResponse;
}
