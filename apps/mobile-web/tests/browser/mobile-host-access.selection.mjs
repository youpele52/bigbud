const CASES = new Set([
  "host-served-foreign-pair-link",
  "host-served-preserved-foreign-data",
  "hosted-pair-switch-normal",
  "hosted-pair-switch-strict",
  "host-served-existing-session-upgrade",
]);

/** Narrow an existing proof without rewriting its assertions or accepting an empty run. */
export function shouldCaptureHostCase(name) {
  const configured = process.env.MOBILE_HOST_ACCESS_CASES;
  if (configured === undefined) return true;
  const names = configured.split(",");
  if (!names.length || names.some((entry) => !CASES.has(entry)))
    throw new Error("Unknown host-access fixture case selection");
  return names.includes(name);
}
