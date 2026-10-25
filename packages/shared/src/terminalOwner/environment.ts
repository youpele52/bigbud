import { requireContract } from "./errors";

export interface OwnerEnvironmentFacts {
  readonly target: "unix" | "windows";
  readonly runtime: "native" | "electronHost";
  readonly systemDirectory?: string;
  readonly scratchDirectory?: string;
}
/** Construct only fixed values and caller's separately OS-verified facts; never inherit a parent env. */
export function ownerEnvironment(facts: OwnerEnvironmentFacts): Readonly<Record<string, string>> {
  requireContract(
    Object.keys(facts).every((key) =>
      ["target", "runtime", "systemDirectory", "scratchDirectory"].includes(key),
    ) &&
      ["unix", "windows"].includes(facts.target) &&
      ["native", "electronHost"].includes(facts.runtime),
    "ENVIRONMENT_INVALID",
  );
  const path = (value: string | undefined) => {
    requireContract(
      typeof value === "string" &&
        value.length > 0 &&
        value.length <= 1024 &&
        !value.includes("\0") &&
        (facts.target === "unix" ? value.startsWith("/") : /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)),
      "ENVIRONMENT_INVALID",
    );
    return value;
  };
  const environment: Record<string, string> = { LANG: "C", LC_ALL: "C", TZ: "UTC" };
  if (facts.runtime === "electronHost") environment.ELECTRON_RUN_AS_NODE = "1";
  if (facts.target === "windows") environment.SystemRoot = path(facts.systemDirectory);
  else requireContract(facts.systemDirectory === undefined, "ENVIRONMENT_INVALID");
  if (facts.scratchDirectory !== undefined) {
    const scratch = path(facts.scratchDirectory);
    if (facts.target === "unix") environment.TMPDIR = scratch;
    else {
      environment.TEMP = scratch;
      environment.TMP = scratch;
    }
  }
  return Object.freeze(environment);
}
