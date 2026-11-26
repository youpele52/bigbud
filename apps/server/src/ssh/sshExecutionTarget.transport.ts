import { parseSshExecutionTarget, type SshExecutionTransport } from "./sshExecutionTarget.ts";

const TRANSPORTS: ReadonlyArray<SshExecutionTransport> = ["agent", "direct-ssh"];

function sshTargetParams(executionTargetId: string | null | undefined): URLSearchParams | null {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) return null;
  const raw = target.executionTargetId.slice("ssh:".length).trim();
  return raw.includes("=") ? new URLSearchParams(raw) : new URLSearchParams({ host: raw });
}

/** Every connection parameter except `transport`, in a stable order. */
function sshLocationKey(executionTargetId: string | null | undefined): string | null {
  const params = sshTargetParams(executionTargetId);
  if (!params) return null;
  params.delete("transport");
  params.sort();
  return params.toString();
}

/**
 * True when two SSH targets address the same host, user, port, auth and key and differ only in
 * how bigbud connects (`transport`). Any other difference, or a non-SSH target, is a real move.
 */
export function isTransportOnlyTargetChange(
  previousExecutionTargetId: string | null | undefined,
  nextExecutionTargetId: string | null | undefined,
): boolean {
  if (!previousExecutionTargetId || previousExecutionTargetId === nextExecutionTargetId)
    return false;
  const previous = sshLocationKey(previousExecutionTargetId);
  return previous !== null && previous === sshLocationKey(nextExecutionTargetId);
}

/**
 * The exact target first, then the same SSH target with each other transport (explicit or
 * process default), both in place and appended, so an ID built before a switch is recognized.
 */
export function sshExecutionTargetTransportVariants(executionTargetId: string): string[] {
  const variants = [executionTargetId];
  const params = sshTargetParams(executionTargetId);
  if (!params) return variants;
  for (const transport of [...TRANSPORTS, undefined]) {
    const inPlace = new URLSearchParams(params);
    const appended = new URLSearchParams(params);
    appended.delete("transport");
    if (transport) {
      inPlace.set("transport", transport);
      appended.append("transport", transport);
    } else inPlace.delete("transport");
    for (const candidate of [inPlace, appended]) {
      const id = `ssh:${candidate.toString()}`;
      if (!variants.includes(id)) variants.push(id);
    }
  }
  // Legacy bare-host form (`ssh:dev-1`) for targets with no parameter besides host/transport.
  const host = params.get("host");
  if (host && [...params.keys()].every((key) => key === "host" || key === "transport")) {
    const bare = `ssh:${host}`;
    if (!variants.includes(bare)) variants.push(bare);
  }
  return variants;
}
