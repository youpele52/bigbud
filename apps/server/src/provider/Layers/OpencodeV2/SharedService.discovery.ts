import { Service } from "@opencode/client/service";
import { Schema } from "effect";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { validateOwnedEndpoint } from "./Compatibility.ts";
import { boundV2Response } from "./Client.response.ts";
import { assertV2SharedCapabilities } from "./SharedService.capabilities.ts";
import { assertV2SharedQualifiedVersion } from "./SharedService.compatibility.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import {
  readV2SharedRegistration,
  sameV2SharedRegistration,
  v2SharedRegistrationFile,
  type V2SharedRegistration,
  v2SharedGeneration,
} from "./SharedService.registration.ts";

const Info = Schema.Struct({ version: Schema.String, pid: Schema.Number });

/** Only these startup GETs are permitted; no Location/plugin load or credential inventory. */
export async function readV2SharedServiceJson(
  registration: V2SharedRegistration,
  route: "/api/info" | "/openapi.json",
  options: { readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  const origin = validateOwnedEndpoint(registration.endpoint.url);
  try {
    return await runWithAbortableDeadline({
      operation: "OpenCode v2 shared service read-only probe",
      timeoutMs: 5000,
      ...(options.signal ? { signal: options.signal } : {}),
      run: async (signal) => {
        const response = await (options.fetch ?? globalThis.fetch)(new URL(route, origin), {
          method: "GET",
          headers: Service.headers(registration.endpoint),
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("Service is not ready.");
        }
        return await boundV2Response(response).json();
      },
    });
  } catch {
    throw new V2SharedServiceError(
      route === "/api/info" ? "health" : "compatibility",
      `OpenCode v2 shared service ${route === "/api/info" ? "health" : "API contract"} could not be verified. Check the native service; bigbud did not restart it or submit work.`,
      registration.version,
    );
  }
}

/** Borrow an existing healthy service. Never ensure/start/stop/replace the user's daemon. */
export async function discoverV2SharedService(
  options: {
    readonly file?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
  } = {},
) {
  const file = options.file ?? v2SharedRegistrationFile();
  const registration = await readV2SharedRegistration(file);
  let info;
  try {
    info = Schema.decodeUnknownSync(Info)(
      await readV2SharedServiceJson(registration, "/api/info", options),
    );
  } catch (error) {
    if (error instanceof V2SharedServiceError) throw error;
    throw new V2SharedServiceError(
      "health",
      "OpenCode v2 shared service returned invalid health metadata. Check the native service; no native work was submitted.",
      registration.version,
    );
  }
  if (info.pid !== registration.pid || info.version !== registration.version)
    throw new V2SharedServiceError(
      "generation",
      `OpenCode v2 shared service changed during discovery (reported ${/^2\.\d+\.\d+$/.test(info.version) ? info.version : "unknown version"}). Retry connection; no native work was submitted.`,
      /^2\.\d+\.\d+$/.test(info.version) ? info.version : undefined,
    );
  assertV2SharedQualifiedVersion(info.version);
  const contract = await readV2SharedServiceJson(registration, "/openapi.json", options);
  assertV2SharedCapabilities(contract, info.version);
  if (!sameV2SharedRegistration(registration, await readV2SharedRegistration(file)))
    throw new V2SharedServiceError(
      "generation",
      "OpenCode v2 shared service registration changed during discovery. Retry connection; no native work was submitted.",
      info.version,
    );
  return {
    registration,
    version: info.version,
    // Logical transport identity only, never physical-exit or durable-storage proof.
    generation: v2SharedGeneration(registration),
  };
}
