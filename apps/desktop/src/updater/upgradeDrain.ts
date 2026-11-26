import {
  BACKEND_DRAIN_MAX_WAIT_MS,
  requestBackendDrainControl,
} from "@bigbud/shared/backendDrain.client";

import { beginInstalledProcessQuiescence } from "../backend/installedProcessQuiescence";
import type { UpdateInstallDrainOutcome } from "./autoUpdater.install";

export interface UpgradeDrainInput {
  /** The desktop backend's state directory (`ownershipStateDir`). */
  readonly stateDir: string;
  /** Must equal the running backend's `bigbud-server@<version>`. */
  readonly artifactId: string;
  readonly platform: NodeJS.Platform;
  readonly request?: typeof requestBackendDrainControl;
  /** Fences backend restarts once the drained backend begins its own shutdown. */
  readonly onDrained?: () => void;
}

const KEPT_RUNNING = "The upgrade was not started; bigbud and your terminals keep running.";

/**
 * U5/U8 updater entry: asks the running backend to drain with UI consent before
 * any install preparation. Cancel, timeout or any refusal aborts the upgrade.
 * Windows has no drain control yet, so the updater keeps its existing path there.
 */
export function createUpgradeDrain(
  input: UpgradeDrainInput,
): () => Promise<UpdateInstallDrainOutcome> {
  const request = input.request ?? requestBackendDrainControl;
  const onDrained = input.onDrained ?? beginInstalledProcessQuiescence;
  return async () => {
    if (input.platform === "win32")
      return { kind: "skipped", reason: "the backend drain control is not supported on Windows" };
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request({
        stateDir: input.stateDir,
        artifactId: input.artifactId,
        consent: "ui",
        waitMs: BACKEND_DRAIN_MAX_WAIT_MS,
      });
    } catch {
      return {
        kind: "failed",
        message: `The running backend's drain control is unavailable. ${KEPT_RUNNING}`,
      };
    }
    if (!response.ok)
      return { kind: "failed", message: `${response.error.message} ${KEPT_RUNNING}` };
    switch (response.status) {
      case "drained":
        onDrained();
        return { kind: "drained" };
      case "cancelled":
      case "timeout":
        return { kind: "cancelled", message: `The upgrade was cancelled. ${KEPT_RUNNING}` };
      case "busy":
        return { kind: "failed", message: `Another upgrade drain is running. ${KEPT_RUNNING}` };
      default:
        return {
          kind: "failed",
          message: `The backend refused the upgrade drain (${response.status}). ${KEPT_RUNNING}`,
        };
    }
  };
}
