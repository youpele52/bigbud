/**
 * Layers for sleep and wake recovery, grouped so `server.ts` only places them.
 *
 * - `RecoveryPersistenceLayerLive`: durable recovery intents and dispatch attempts. Provided
 *   directly to the orchestration engine and the provider service, which write them inside
 *   their own transactions.
 * - `SleepEvidenceLayerLive`: the fd 5 desktop hint reader, and the bridge that wakes delayed
 *   remote-process reattach on `network-online` and `epoch-ended`. `SystemSleepEpochsLive`
 *   itself is provided once at the bottom of the runtime, so every source and the coordinator
 *   share it.
 *
 * @module server.recoveryLayers
 */
import { Layer } from "effect";

import { ProviderDispatchAttemptRepositoryLive } from "./persistence/Layers/ProviderDispatchAttempts.ts";
import { ThreadRecoveryIntentRepositoryLive } from "./persistence/Layers/ThreadRecoveryIntents.ts";
import { DesktopLifecycleHintReaderLive } from "./system-sleep/desktopLifecycleHintReader.ts";
import { RemoteAgentReattachWakeBridgeLive } from "./system-sleep/remoteAgentReattachWakeBridge.ts";

export { SystemSleepEpochsLive } from "./system-sleep/Layers/SystemSleepEpochs.ts";
export { ProviderTurnSupervisorLive } from "./orchestration/Layers/ProviderTurnSupervisor.ts";

export const RecoveryPersistenceLayerLive = Layer.mergeAll(
  ThreadRecoveryIntentRepositoryLive,
  ProviderDispatchAttemptRepositoryLive,
);

export const SleepEvidenceLayerLive = Layer.mergeAll(
  DesktopLifecycleHintReaderLive,
  RemoteAgentReattachWakeBridgeLive,
);
