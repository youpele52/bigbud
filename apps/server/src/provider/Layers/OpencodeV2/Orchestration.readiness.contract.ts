import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";

/** Fixed field names are safe diagnostics; never retain native RPC values or request bodies. */
export class V2BootstrapContractError extends V2NativeCompatibilityError {
  constructor(
    readonly fields: readonly string[],
    nativeVersion: string,
  ) {
    super(
      "bootstrap-contract-incompatible",
      `selected Location bootstrap differs in ${fields.join(", ")}; setup must verify the required contract.`,
      nativeVersion,
    );
  }
}

export function assertV2BootstrapContract(
  info: Record<string, unknown>,
  expected: {
    issuer: string;
    protocol: string;
    artifactDigest: string;
    bootstrapDigest: string;
    bootstrapAbi: string;
    compatibilityDigest: string;
    schemaDigest: string;
    nativeVersion: string;
    tools: readonly string[];
  },
) {
  const fields = Object.entries(expected)
    .filter(([key, value]) =>
      key === "tools"
        ? JSON.stringify((info.tools as string[]).toSorted()) !==
          JSON.stringify(expected.tools.toSorted())
        : info[key] !== value,
    )
    .map(([key]) => key);
  if (fields.length) throw new V2BootstrapContractError(fields, expected.nativeVersion);
}
