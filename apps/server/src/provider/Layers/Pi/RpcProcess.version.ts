export const PI_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const PI_VERSION_PROBE_MAX_BYTES = 4_096;

/** agent_settled was introduced in Pi 0.80.4, independently of who installed the runtime. */
export function piVersionCapabilities(output: string) {
  const match = output.trim().match(/^(?:pi\s+v?)?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/i);
  if (!match)
    throw new Error(
      "Pi --version did not report a supported semantic version; cannot select the RPC lifecycle safely.",
    );
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return {
    supportsAgentSettled: major! > 0 || minor! > 80 || (minor === 80 && patch! >= 4),
    supportsPromptDisposition: major! > 0 || minor! >= 99,
  };
}
