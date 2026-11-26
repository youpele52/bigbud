import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { boundV2Response } from "./Client.response.ts";
import { opencodeV2Sdk } from "./Client.sdk.ts";
import { validateOwnedEndpoint } from "./Compatibility.ts";
import { parseV2CanonicalCandidate } from "./NativeCompatibility.version.ts";
import { assertV2SharedCapabilities } from "./SharedService.capabilities.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";

/** Echo only a bounded canonical version; untrusted native text never reaches diagnostics. */
function safeVersion(version: string): string | undefined {
  return /^\d+\.\d+\.\d+$/.test(version) && version.length <= 50 ? version : undefined;
}

/**
 * Owned and SSH runtimes accept every stable `2.x` release; the live API contract,
 * not a patch-number pin, authorizes work. The isolated development launcher keeps
 * its exact qualification pin.
 */
export function assertV2OwnedVersion(version: string): void {
  if (!parseV2CanonicalCandidate(version))
    throw new V2SharedServiceError(
      "compatibility",
      `OpenCode ${safeVersion(version) ?? "unknown version"} is unsupported. Owned and SSH mode require a stable 2.x runtime with the required API contract; bigbud did not substitute another binary.`,
      safeVersion(version),
    );
}

/**
 * Verify the same consumed OpenAPI contract shared mode requires before admitting
 * work, using the owner-selected loopback endpoint and credential. The endpoint
 * stays loopback-only and redirects are refused.
 */
export async function verifyV2OwnedContract(input: {
  readonly endpoint: string;
  readonly password: string;
  readonly version: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  assertV2OwnedVersion(input.version);
  const origin = validateOwnedEndpoint(input.endpoint);
  const headers = opencodeV2Sdk().Service.headers({
    url: origin,
    auth: { type: "basic", username: "opencode", password: input.password },
  });
  let contract: unknown;
  try {
    contract = await runWithAbortableDeadline({
      operation: "OpenCode v2 owned API contract",
      timeoutMs: 5000,
      ...(input.signal ? { signal: input.signal } : {}),
      run: async (signal) => {
        const response = await globalThis.fetch(new URL("/openapi.json", origin), {
          method: "GET",
          headers,
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new V2SharedServiceError(
            "compatibility",
            "OpenCode v2 owned API contract could not be read; no native work was submitted.",
            input.version,
          );
        }
        return await boundV2Response(response).json();
      },
    });
  } catch (error) {
    if (error instanceof V2SharedServiceError) throw error;
    throw new V2SharedServiceError(
      "compatibility",
      "OpenCode v2 owned API contract could not be verified; no native work was submitted.",
      input.version,
    );
  }
  assertV2SharedCapabilities(contract, input.version);
}
