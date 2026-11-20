import type { DesktopTailscaleRemoteAccessStatus } from "@bigbud/contracts";

export interface TailscaleTakeOverOffer {
  readonly description: string;
  readonly confirmMessage: string;
}

/**
 * "Take over" is offered only when the desktop proved (from a bigbud backend
 * lock recording that loopback port) that this channel's Serve port forwards to
 * another bigbud. A handler for any other service gets no button: bigbud cannot
 * tell what it would break, so the user removes it themselves.
 */
export function resolveTailscaleTakeOverOffer(
  status: DesktopTailscaleRemoteAccessStatus | null | undefined,
): TailscaleTakeOverOffer | null {
  const conflict = status?.conflict;
  if (
    !status ||
    status.serving ||
    !conflict?.canTakeOver ||
    conflict.loopbackPort === null ||
    conflict.bigbudOwnerLabel === null
  ) {
    return null;
  }
  const { bigbudOwnerLabel: owner, loopbackPort } = conflict;
  const address = status.remoteBaseUrl ?? `Tailscale Serve HTTPS port ${status.httpsPort}`;
  return {
    description: `${address} is set up for ${owner} (127.0.0.1:${loopbackPort}), not this app. Take over points it at this app; ${owner} stops being reachable from phones at this address.`,
    confirmMessage: `Point ${address} at this app instead of ${owner} (127.0.0.1:${loopbackPort})?\n\nPhones paired with ${owner} through this address stop reaching it until it is set up again. Other Tailscale Serve routes and ports are not changed.`,
  };
}
