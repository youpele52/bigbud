import { formatSshDestination, parseSshExecutionTarget } from "./sshExecutionTarget.ts";

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** Validate the final argv destination, not only the parsed host, before invoking SSH. */
export function validSshMonitorTarget(executionTargetId: string): boolean {
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target || executionTargetId.length > 2_048) return false;
  const destination = formatSshDestination(target);
  if (
    !destination ||
    destination.startsWith("-") ||
    /\s/.test(destination) ||
    hasControlCharacters(destination)
  )
    return false;
  if (target.host.startsWith("-") || (target.host.includes("@") && target.user)) return false;
  if (
    target.port &&
    (!/^\d+$/.test(target.port) || Number(target.port) < 1 || Number(target.port) > 65_535)
  )
    return false;
  return !target.keyPath || !hasControlCharacters(target.keyPath);
}
