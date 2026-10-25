import { ownershipStateDir, resolveOwnershipBaseDir } from "@bigbud/shared/backendOwnership.paths";

export interface OwnershipLaunch {
  readonly generation: number;
  readonly stateDir: string;
  readonly launcher: string;
  readonly entry: string;
  readonly inspector: string | null;
}
let launch: OwnershipLaunch | undefined;
export function getOwnershipLaunch(): OwnershipLaunch | undefined {
  return launch;
}

/** Captures the actual child environment after shell hydration, not mutable renderer settings. */
export function recordOwnershipLaunch(
  input: Omit<OwnershipLaunch, "stateDir"> & {
    env: NodeJS.ProcessEnv;
    baseDir: string;
    cwd: string;
  },
): NodeJS.ProcessEnv {
  const base = resolveOwnershipBaseDir(
    input.env.BIGBUD_HOME ?? input.env.T3CODE_HOME ?? input.baseDir,
    input.cwd,
  );
  const stateDir = ownershipStateDir(base, input.env.VITE_DEV_SERVER_URL !== undefined);
  launch = {
    generation: input.generation,
    stateDir,
    launcher: input.launcher,
    entry: input.entry,
    inspector: input.inspector,
  };
  return input.env;
}
