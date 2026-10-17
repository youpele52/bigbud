import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";

/** Inactive isolated overrides must not invalidate an already-borrowed shared connection. */
export function v2ApplicationConfigKey(value: {
  binaryPath: string;
  profileRoot: string;
  connectionMode?: "shared" | "isolated";
  serviceFile?: string;
}): string {
  const mode = resolveOpencodeV2ConnectionMode(value);
  return JSON.stringify([
    mode,
    mode === "isolated" ? value.binaryPath : "",
    mode === "isolated" ? value.profileRoot : "",
    value.serviceFile ?? "",
  ]);
}
