import type { ClientRelaySshOwner } from "./clientRelay.ssh.owner.ts";

type SelectedOwnerClient = ClientRelaySshOwner;
type WithOwner = (
  executionTargetId: string,
  operation: (client: SelectedOwnerClient) => Promise<unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Minimal structural view of the selected dev owner session. The full session is
 * a union across platforms; this module only needs the exact target and the
 * picker's single-owner queue.
 */
export interface SelectedRelaySession {
  readonly targetId: string;
  readonly picker: { readonly withOwner?: unknown };
}

/**
 * Product relay port for the selected dev domain. Only the exact selected target
 * is admitted, and every channel goes through the picker's queue, alias
 * admission and close fence. An owner without the typed relay verb is a typed
 * refusal, never a legacy launch.
 */
export function makeSelectedClientRelayOwner(session: SelectedRelaySession): ClientRelaySshOwner {
  const withOwner = session.picker.withOwner;
  if (typeof withOwner !== "function")
    throw new Error("The selected SSH owner exposes no picker operation queue.");
  // The dev picker is generic over a narrow owner slice; the private client it
  // wraps also implements this port. Narrow once here, after the runtime check.
  const call = withOwner as WithOwner;
  return Object.freeze<ClientRelaySshOwner>({
    async openClientRelay(request, signal) {
      signal.throwIfAborted();
      if (request.executionTargetId !== session.targetId)
        throw new Error("The selected SSH owner does not serve this relay target.");
      const lease = await call(
        request.executionTargetId,
        async (client) => {
          if (typeof client.openClientRelay !== "function")
            throw new Error("The selected SSH owner does not support the typed relay port.");
          return client.openClientRelay(request, signal);
        },
        signal,
      );
      signal.throwIfAborted();
      return lease as Awaited<ReturnType<ClientRelaySshOwner["openClientRelay"]>>;
    },
  });
}
