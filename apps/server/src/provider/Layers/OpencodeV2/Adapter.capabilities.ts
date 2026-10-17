import type { ProviderAdapterCapabilities } from "../../Services/ProviderAdapter.ts";

import { PROVIDER_SUBAGENT_CAPABILITIES } from "../../providerSubagents.capabilities.ts";
/** Application wrappers and executing adapters expose the same guarded runtime operations. */
export const V2_EXECUTION_CAPABILITIES = {
  durableLearningReview: true,
  supportsAttachments: true,
  sessionModelSwitch: "in-session",
  subagents: PROVIDER_SUBAGENT_CAPABILITIES.opencodeV2,
  sessionRecovery: "resume-restart",
  conversationRewind: "unsupported",
  conversationFork: "unsupported",
  supportsSteer: false,
  turnControl: {
    nativeSteer: false,
    interruptTarget: "current-session",
    activeTurnInspection: "best-effort",
    continuation: false,
  },
} as const satisfies ProviderAdapterCapabilities;
