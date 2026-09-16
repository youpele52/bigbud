import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import type { RemoteAgentConnectionBindings } from "./remoteAgentOwners.ts";
import { releaseRemoteAgentPin } from "./remoteAgentInstall.registry.transitions.ts";

/** Releases a superseded connection only when durable reference state is known to be empty. */
export async function releaseSupersededRemoteAgentConnection(input: {
  readonly bindings: RemoteAgentConnectionBindings;
  readonly control: RemoteAgentControl;
  readonly target: string;
  readonly previousConnectionId: string | undefined;
  readonly currentConnectionId: string;
}): Promise<void> {
  if (!input.previousConnectionId || input.previousConnectionId === input.currentConnectionId)
    return;
  const hasReferences = input.bindings.hasDurableReferences
    ? await input.bindings
        .hasDurableReferences(input.target, input.previousConnectionId)
        .catch(() => undefined)
    : undefined;
  if (hasReferences !== false) return;
  await input.control.registry.update((current) =>
    current.currentConnectionId === input.currentConnectionId
      ? releaseRemoteAgentPin(current, `connection:${input.previousConnectionId}`)
      : current,
  );
}

/** Recheck every retained logical route after owner disposal or startup recovery. */
export async function reconcileSupersededRemoteAgentConnections(input: {
  readonly bindings: RemoteAgentConnectionBindings;
  readonly control: RemoteAgentControl;
  readonly target: string;
  readonly currentConnectionId?: string;
}): Promise<void> {
  const state = await input.control.registry.read();
  const currentConnectionId = input.currentConnectionId ?? state.currentConnectionId ?? undefined;
  if (!currentConnectionId) return;
  const candidates = input.bindings.listConnectionIds
    ? await input.bindings.listConnectionIds(input.target)
    : state.pins
        .filter((pin) => pin.owner.startsWith("connection:"))
        .map((pin) => pin.owner.slice("connection:".length));
  for (const previousConnectionId of new Set(candidates))
    await releaseSupersededRemoteAgentConnection({
      bindings: input.bindings,
      control: input.control,
      target: input.target,
      previousConnectionId,
      currentConnectionId,
    });
}
