export function withBackendNodeOptions(
  env: NodeJS.ProcessEnv,
  backendMaxOldSpaceMb: number | null,
): NodeJS.ProcessEnv {
  if (!backendMaxOldSpaceMb) return env;
  const nextFlag = `--max-old-space-size=${backendMaxOldSpaceMb}`;
  const existingNodeOptions = env.NODE_OPTIONS?.trim();
  if (existingNodeOptions?.includes("--max-old-space-size=")) return env;
  return {
    ...env,
    NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${nextFlag}` : nextFlag,
  };
}
