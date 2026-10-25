import type { V2RuntimeSession } from "./Runtime.types.ts";
import { currentV2RequestContext, runV2RequestContext } from "./Client.guard.ts";
import { v2Request } from "./Client.ts";
import {
  nativeFamilyEnvelope,
  nativeFamilyHash,
  V2_NATIVE_FAMILY_PROTOCOL,
  type NativeFamilyMethod,
} from "./Subagents.protocol.ts";

/** Uses the existing exact-wire RPC fetch fence, with a distinct signed protocol and registration. */
export async function callV2NativeFamily(
  owner: V2RuntimeSession,
  signer: { issuer: string; privateKey: string },
  method: NativeFamilyMethod,
  body: Record<string, unknown>,
  nonce: string,
) {
  const input = method === "info" ? {} : nativeFamilyEnvelope(signer.privateKey, method, body);
  const rpcID = `${V2_NATIVE_FAMILY_PROTOCOL}.${signer.issuer}`;
  const run = () =>
    v2Request(
      `native family ${method}`,
      (signal) =>
        owner.lease.process.client.rpc.call(
          {
            rpcID,
            method,
            location: { directory: owner.native.location.directory },
            input: JSON.parse(JSON.stringify(input)),
          },
          { signal },
        ),
      { timeoutMs: 5000 },
    ).then((result) => result.output);
  const context = currentV2RequestContext();
  if (!context) {
    if (owner.sharedTransport) throw new Error("V2 native family RPC consent is unavailable.");
    return run();
  }
  return runV2RequestContext(
    {
      ...context,
      orchestration: {
        rpcID,
        method,
        directory: owner.native.location.directory,
        nativeSessionId: owner.native.id,
        enrollmentNonce: nonce,
        ownerDigest: nativeFamilyHash([owner.storageIdentity, owner.native.id, owner.threadId]),
        bodyDigest: nativeFamilyHash({ input }),
      },
    },
    run,
  );
}
