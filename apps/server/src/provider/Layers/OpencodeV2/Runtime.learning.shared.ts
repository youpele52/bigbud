import type { ModelRef } from "@opencode/client";
import type { V2IsolatedRuntimeOptions, V2StartInput } from "./Runtime.types.ts";
import type { resolveV2RuntimeBinding } from "./Runtime.binding.ts";
import { borrowV2SharedService } from "./SharedService.connection.ts";
import { findSharedSession, prepareSharedCreation } from "./Runtime.sessions.shared.ts";
import { assertV2Model } from "./Runtime.sessions.ts";
import { matchesV2NativeRegistration } from "./Runtime.registration.ts";

/** Terminal reuse verifies exact retained native history without acquiring a hub or mutating it. */
export async function verifyV2SharedLearningHistory(
  options: V2IsolatedRuntimeOptions,
  input: V2StartInput,
  binding: Awaited<ReturnType<typeof resolveV2RuntimeBinding>>,
  model: ModelRef,
) {
  if (!options.config.sharedService) return;
  const process = await borrowV2SharedService(options.config.sharedService);
  try {
    const native = await findSharedSession(process.client, binding.nativeSessionId);
    if (
      !native ||
      !matchesV2NativeRegistration(native, binding) ||
      native.id !== binding.nativeSessionId ||
      native.location.directory !== binding.directory ||
      native.metadata?.bigbud_thread !== input.threadId ||
      native.metadata.bigbud_storage !== binding.storageIdentity ||
      native.metadata.bigbud_provider !== "opencodeV2"
    )
      throw new Error("V2 retained learning history is unverified; no result application.");
    assertV2Model(native.model, model);
    const saved = await prepareSharedCreation(options, input, binding, model, [
      { action: "*", resource: "*", effect: "deny" },
    ]);
    await saved.verify(saved.row);
  } finally {
    await process.close();
  }
}
