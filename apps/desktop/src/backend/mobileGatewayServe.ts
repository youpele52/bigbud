import {
  enableDesktopTailscaleRemoteAccess,
  hasDesktopServeTarget,
  type DesktopTailscaleRemoteAccessStatus,
} from "./tailscaleRemoteAccess";
import type { ServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";

/** Stage a ready gateway before changing only bigbud's owned Serve route. */
export async function attachMobileGatewayToServe(input: {
  readonly port: number;
  readonly ownership: ServeOwnershipStore;
  readonly start: () => Promise<void>;
  readonly assertCanMutate?: () => void;
  readonly stop: () => Promise<void>;
  readonly run?: Parameters<typeof enableDesktopTailscaleRemoteAccess>[1];
}): Promise<DesktopTailscaleRemoteAccessStatus> {
  const previous = input.ownership.read();
  if (previous === null || !(await hasDesktopServeTarget(previous, input.run))) {
    throw new Error("Recorded Serve target is no longer present; migration cancelled.");
  }
  try {
    await input.start();
  } catch (error) {
    await input.stop();
    throw error;
  } // Keep existing target on readiness failure.
  let attempted = false;
  const staged: ServeOwnershipStore = {
    read: () => previous,
    write: () => undefined,
    clear: () => undefined,
  };
  try {
    // Treat a failed command as possibly applied; rollback still checks the live target.
    const status = await enableDesktopTailscaleRemoteAccess(input.port, input.run, staged, {
      existingPort: previous,
      onMutation: () => {
        input.assertCanMutate?.();
        attempted = true;
      },
    });
    if (!status.serving) throw new Error("Mobile gateway Serve target was not confirmed.");
    input.ownership.write(input.port);
    return status;
  } catch (error) {
    const rollbackOwner: ServeOwnershipStore = {
      read: () => input.port,
      write: (port) => input.ownership.write(port),
      clear: () => input.ownership.clear(),
    };
    try {
      if (attempted && (await hasDesktopServeTarget(input.port, input.run))) {
        const restored = await enableDesktopTailscaleRemoteAccess(
          previous,
          input.run,
          rollbackOwner,
          { existingPort: input.port, onMutation: () => undefined },
        );
        if (!restored.serving)
          throw new Error("Serve rollback was not confirmed.", { cause: error });
      }
    } catch {
      // A concurrent foreign mapping must be preserved, never forced back.
      throw new Error("Mobile gateway setup failed and Serve rollback needs attention.", {
        cause: error,
      });
    } finally {
      await input.stop();
    }
    throw error;
  }
}
