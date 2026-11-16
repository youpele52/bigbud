import type { VerifiedMobilePublication } from "./mobileOptionalPublication.ts";
import {
  assertMobilePublicationAuthority,
  type MobilePublicationAuthority,
} from "./mobileOptionalPublication.authority.ts";
import { inspectMobilePublication } from "./mobileOptionalPublication.verify.ts";
import {
  runOwnedMobilePublicationRead,
  runOwnedMobilePublicationTeardown,
  runOwnedMobilePublicationLifetime,
} from "./mobileOptionalPublication.work.ts";
interface Proof {
  readonly authority: MobilePublicationAuthority;
  readonly stageId: string;
  readonly consentRevision: number;
  readonly keys: Readonly<Record<string, string>>;
  readonly stageSnapshot: string;
  readonly priorController: boolean;
}
const proofs = new WeakMap<VerifiedMobilePublication, Proof>();

async function inspectProof(proof: Proof, signal: AbortSignal) {
  const verified = await inspectMobilePublication(
    proof.authority,
    proof.stageId,
    proof.consentRevision,
    proof.keys,
    signal,
    proof.priorController,
  );
  if (JSON.stringify(verified.stage) !== proof.stageSnapshot)
    throw new Error("Mobile publication proof changed.");
  assertMobilePublicationAuthority(proof.authority);
  return Object.freeze({
    gatewayPath: verified.files.gatewayPath,
    assetsArchivePath: verified.files.archivePath,
    stageId: proof.stageId,
    releaseId: verified.release.id,
    consentRevision: proof.consentRevision,
    owner: proof.authority.pin,
    publicationController: verified.stage.controller,
    controller: proof.authority.controller,
    compatibility: verified.release.gateway.compatibility,
    gatewayArtifact: verified.release.gateway,
    assetsArtifact: verified.release.assets,
    host: verified.context.host,
  });
}
type MobilePublicationPaths = Awaited<ReturnType<typeof inspectProof>>;
const revalidating = new WeakMap<VerifiedMobilePublication, Promise<MobilePublicationPaths>>();

/** Original proof only; reads join and remain owned until their real IO settles. */
export function revalidateMobilePublicationToken(
  token: VerifiedMobilePublication,
  signal?: AbortSignal,
): Promise<MobilePublicationPaths> {
  try {
    const proof = proofs.get(token);
    if (!proof) throw new Error("Mobile publication requires its original opaque proof.");
    assertMobilePublicationAuthority(proof.authority);
    const prior = signal === undefined ? revalidating.get(token) : undefined;
    if (prior) return prior;
    const job = runOwnedMobilePublicationRead(
      proof.authority,
      (ownedSignal) => inspectProof(proof, ownedSignal),
      signal,
    );
    if (signal === undefined) {
      revalidating.set(token, job);
      void job.then(
        () => revalidating.delete(token),
        () => revalidating.delete(token),
      );
    }
    return job;
  } catch (cause) {
    return Promise.reject(cause);
  }
}

export function mintMobilePublication(
  authority: MobilePublicationAuthority,
  stageId: string,
  consentRevision: number,
  keys: Readonly<Record<string, string>>,
  stageSnapshot: string,
  priorController: boolean,
): VerifiedMobilePublication {
  assertMobilePublicationAuthority(authority);
  const token = Object.freeze({}) as VerifiedMobilePublication;
  proofs.set(token, { authority, stageId, consentRevision, keys, stageSnapshot, priorController });
  return token;
}

/** Borrow the original publication owner inside its serialized, tracked lifetime; no second lease. */
export function withMobilePublicationOwner<A>(
  token: VerifiedMobilePublication,
  operation: (
    context: {
      readonly authority: MobilePublicationAuthority;
      readonly paths: MobilePublicationPaths;
      readonly trustedKeys: Readonly<Record<string, string>>;
      readonly revalidate: () => Promise<MobilePublicationPaths>;
    },
    signal: AbortSignal,
  ) => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  const proof = proofs.get(token);
  if (!proof)
    return Promise.reject(new Error("Original opaque mobile publication proof required."));
  try {
    return runOwnedMobilePublicationRead(
      proof.authority,
      async (ownedSignal) => {
        const paths = await inspectProof(proof, ownedSignal);
        return operation(
          {
            authority: proof.authority,
            paths,
            trustedKeys: proof.keys,
            revalidate: () => inspectProof(proof, ownedSignal),
          },
          ownedSignal,
        );
      },
      signal,
    );
  } catch (cause) {
    return Promise.reject(cause);
  }
}

/** Original-proof cleanup only, even when consent/files/binding no longer authorize launches. */
export function withMobilePublicationTeardown<A>(
  token: VerifiedMobilePublication,
  operation: (authority: MobilePublicationAuthority, signal: AbortSignal) => Promise<A>,
): Promise<A> {
  const proof = proofs.get(token);
  if (!proof)
    return Promise.reject(
      new Error("Original opaque mobile publication proof required for teardown."),
    );
  try {
    return runOwnedMobilePublicationTeardown(proof.authority, (signal) =>
      operation(proof.authority, signal),
    );
  } catch (cause) {
    return Promise.reject(cause);
  }
}

/** Own real process settlement without nesting/holding an artifact IO permit. */
export function withMobilePublicationLifetime<A>(
  token: VerifiedMobilePublication,
  operation: (signal: AbortSignal) => Promise<A>,
  external?: AbortSignal,
): Promise<A> {
  const proof = proofs.get(token);
  if (!proof)
    return Promise.reject(
      new Error("Original opaque publication proof required for process lifetime."),
    );
  try {
    return runOwnedMobilePublicationLifetime(proof.authority, operation, external);
  } catch (cause) {
    return Promise.reject(cause);
  }
}
