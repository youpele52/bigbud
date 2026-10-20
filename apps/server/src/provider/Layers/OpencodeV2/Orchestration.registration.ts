import { V2_THREAD_ACTIONS, V2_THREAD_RPC } from "./Orchestration.protocol.ts";

export const V2_SCOPED_BOOTSTRAP_ABI = "bigbud.thread.bootstrap.v3";
export const V2_SCOPED_REGISTRATION = "bigbud.thread.registration.issuer.v1";
export type V2RegistrationFamily = "legacy" | "scoped";

/** Full issuer identity authorizes registrations; the bounded tool prefix is never an authority. */
export function v2ThreadRegistration(artifact: {
  readonly issuer: string;
  readonly compatibility: { readonly bootstrapAbi: string };
}) {
  if (!/^[a-f0-9]{64}$/.test(artifact.issuer)) throw new Error("V2 registration issuer rejected.");
  const abi = artifact.compatibility.bootstrapAbi;
  if (
    abi !== "bigbud.thread.bootstrap.v1" &&
    abi !== "bigbud.thread.bootstrap.v2" &&
    abi !== V2_SCOPED_BOOTSTRAP_ABI
  )
    throw new Error("V2 registration ABI rejected.");
  const family: V2RegistrationFamily = abi === "bigbud.thread.bootstrap.v1" ? "legacy" : "scoped";
  const id = family === "scoped" ? `bigbud.thread.v2.${artifact.issuer}` : V2_THREAD_RPC;
  const prefix = family === "scoped" ? `bb2_${artifact.issuer.slice(0, 32)}_` : "bigbud_thread_v1_";
  return Object.freeze({
    family,
    issuer: artifact.issuer,
    id,
    filename:
      family === "scoped"
        ? `bigbud-thread-tools-${artifact.issuer}.js`
        : "bigbud-thread-tools-managed.js",
    tools: Object.freeze(V2_THREAD_ACTIONS.map((action) => `${prefix}${action}`)),
    tool: (action: (typeof V2_THREAD_ACTIONS)[number]) => `${prefix}${action}`,
  });
}

export type V2ThreadRegistration = ReturnType<typeof v2ThreadRegistration>;

/** Routing follows the exact signed owner, including cleanup of historical protocols. */
export function v2OwnerRegistration(owner: {
  readonly issuer: string;
  readonly bootstrapAbi?: string;
}) {
  return v2ThreadRegistration({
    issuer: owner.issuer,
    compatibility: {
      bootstrapAbi: owner.bootstrapAbi ?? "bigbud.thread.bootstrap.v1",
    },
  });
}
