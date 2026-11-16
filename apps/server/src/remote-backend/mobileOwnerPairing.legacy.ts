import * as Effect from "effect/Effect";
import type { RuntimeMode } from "../startup/config.ts";
import type { MobileRemoteControlShape } from "../mobile/Services/MobileRemoteControl.ts";
type Issuer = MobileRemoteControlShape["createPairing"];

/** The legacy desktop/web RPC keeps its existing behavior; remote issuance has a separate gate. */
export function createLegacyMobilePairing(
  mode: RuntimeMode,
  issue: Issuer,
  input: Parameters<Issuer>[0],
): ReturnType<Issuer> {
  if (mode === "remote")
    return Effect.fail(
      new Error(
        "Remote pairing requires bigbud mobile pair with explicit authority, scope and the verified gateway origin.",
      ),
    );
  return issue(input);
}
