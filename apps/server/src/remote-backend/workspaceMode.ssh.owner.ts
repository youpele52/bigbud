import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import {
  decodeWorkspaceModeRecord,
  decideReservation,
  encodeWorkspaceModeRecord,
  isValidWorkspaceModeIdentity,
  sameIdentity,
  sha256Hex,
  type WorkspaceModeIdentity,
  type WorkspaceModeStore,
} from "./workspaceMode.record.ts";

export interface WorkspaceModeSshScope {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
}

export interface WorkspaceModeSshObservation extends WorkspaceModeSshScope {
  readonly physicalRoot: string;
  readonly identity: WorkspaceModeIdentity;
  /** Zero means no generation has been published yet. */
  readonly generation: number;
  /** Private, single-use proof owner capability; never returned to product clients. */
  readonly publicationToken?: Uint8Array;
}

type WorkspaceModeSshFailure = {
  readonly kind: "failed";
  readonly reason: "refused" | "unavailable" | "missing-folder" | "unsafe-storage";
};

export type WorkspaceModeSshInspectOutcome =
  | {
      readonly kind: "ready";
      readonly observation: WorkspaceModeSshObservation;
      readonly currentRecord: string | null;
    }
  | { readonly kind: "unsupported"; readonly reason: "not-linux" | "no-machine-id" }
  | WorkspaceModeSshFailure;

export type WorkspaceModeSshPublishOutcome =
  | { readonly kind: "committed" | "conflict" | "uncertain" }
  | WorkspaceModeSshFailure;

export interface WorkspaceModeSshOwner {
  /**
   * Admit the exact target and root and verify SSH trust. Resolve physical root, account and
   * machine identity on the host; inspect only the derived reservation location. Preserve the
   * private-storage checks and the bounded read-race retry budget (four attempts). Report a
   * genuinely unsupported host separately from unavailable owner/transport.
   */
  readonly inspectWorkspaceMode: (
    request: WorkspaceModeSshScope,
    signal: AbortSignal,
  ) => Promise<WorkspaceModeSshInspectOutcome>;
  /**
   * Reverify target trust and resolve the requested root on the host again. Require the same
   * physical root, host, account and digest; derive the storage path, never accept one from the
   * caller. Compare-and-publish only the canonical next laptop-runtime claim (no conversion)
   * from the observed generation, using the existing exclusive publication and durability rules.
   * Only a confirmed CAS loss is a conflict. If dispatch or the durable result is uncertain, do
   * not retry; report uncertainty.
   * Both operations are fixed recipes and must honor the operation deadline in their signal.
   */
  readonly publishWorkspaceMode: (
    request: {
      readonly observation: WorkspaceModeSshObservation;
      readonly nextRecord: string;
    },
    signal: AbortSignal,
  ) => Promise<WorkspaceModeSshPublishOutcome>;
}

export interface WorkspaceModeSshOwnerSelection {
  readonly owner: WorkspaceModeSshOwner;
  /** A selected store serves one root so publish cannot borrow an inspection of another alias. */
  readonly workspaceRoot: string;
}

export function assertWorkspaceModeSshRoot(root: string): void {
  if (
    typeof root !== "string" ||
    !root.startsWith("/") ||
    [...root].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    throw new Error(
      "Workspace folders on SSH hosts must be absolute paths without control characters.",
    );
  }
}

const failureMessages = {
  refused: "The SSH owner refused the workspace mode operation.",
  unavailable: "The SSH owner could not complete the workspace mode operation.",
  "missing-folder": "The workspace does not exist on the host or is not a folder.",
  "unsafe-storage": "Workspace mode storage is unsafe.",
} as const;
const uncertain = "Workspace mode publication could not be confirmed.";

function validateObservation(scope: WorkspaceModeSshScope, observed: WorkspaceModeSshObservation) {
  assertWorkspaceModeSshRoot(observed.physicalRoot);
  const { hostIdentity, accountUid, realpathSha256 } = observed.identity;
  const identity = Object.freeze({ hostIdentity, accountUid, realpathSha256 });
  if (
    observed.executionTargetId !== scope.executionTargetId ||
    observed.workspaceRoot !== scope.workspaceRoot ||
    typeof hostIdentity !== "string" ||
    !isValidWorkspaceModeIdentity(identity) ||
    realpathSha256 !== sha256Hex(observed.physicalRoot) ||
    !Number.isSafeInteger(observed.generation) ||
    observed.generation < 0
  ) {
    throw new Error("Invalid SSH workspace mode observation.");
  }
  return Object.freeze({
    ...scope,
    physicalRoot: observed.physicalRoot,
    identity,
    generation: observed.generation,
    ...(observed.publicationToken === undefined
      ? {}
      : { publicationToken: Uint8Array.from(observed.publicationToken) }),
  });
}

export function makeOwnedSshWorkspaceModeStore(
  executionTargetId: string,
  timeoutMs: number,
  { owner, workspaceRoot }: WorkspaceModeSshOwnerSelection,
): WorkspaceModeStore {
  if (parseSshExecutionTarget(executionTargetId)?.executionTargetId !== executionTargetId) {
    throw new Error("Invalid SSH workspace mode target.");
  }
  assertWorkspaceModeSshRoot(workspaceRoot);
  const scope = Object.freeze({ executionTargetId, workspaceRoot });
  let latestInspection = 0;
  let inspected:
    | { observation: WorkspaceModeSshObservation; current: ReturnType<typeof decodeCurrent> }
    | undefined;

  return {
    async inspect(root) {
      if (root !== scope.workspaceRoot)
        throw new Error("SSH workspace mode root was not selected.");
      const inspection = ++latestInspection;
      inspected = undefined;
      const signal = AbortSignal.timeout(timeoutMs);
      const result = await owner.inspectWorkspaceMode(scope, signal);
      signal.throwIfAborted();
      if (result.kind === "failed") throw new Error(failureMessages[result.reason]);
      if (
        result.kind === "unsupported" &&
        (result.reason === "not-linux" || result.reason === "no-machine-id")
      ) {
        return { kind: "unsupported", reason: result.reason };
      }
      if (result.kind !== "ready") throw new Error("Invalid SSH workspace mode inspection result.");
      const observation = validateObservation(scope, result.observation);
      const current = decodeCurrent(result.currentRecord, observation);
      if (inspection === latestInspection) inspected = { observation, current };
      return { kind: "ready", identity: observation.identity, current };
    },
    async publish(next) {
      const nextRecord = encodeWorkspaceModeRecord(next);
      if (!inspected || next.owner === null) {
        throw new Error("SSH workspace mode publication requires an inspected reservation claim.");
      }
      const { observation, current } = inspected;
      const decision = decideReservation(
        observation.identity,
        current,
        "laptop-runtime",
        next.owner,
      );
      if (decision.kind !== "publish" || encodeWorkspaceModeRecord(decision.next) !== nextRecord) {
        throw new Error(
          "SSH workspace mode publication does not match the inspected reservation claim.",
        );
      }
      // Consume the observation before dispatch; only the caller's read-only reconciliation may
      // determine whether an ambiguous write landed. Never synthesize a conflict from that failure.
      inspected = undefined;
      const signal = AbortSignal.timeout(timeoutMs);
      let result: WorkspaceModeSshPublishOutcome;
      try {
        result = await owner.publishWorkspaceMode({ observation, nextRecord }, signal);
        signal.throwIfAborted();
      } catch (cause) {
        throw new Error(uncertain, { cause });
      }
      if (result?.kind === "committed" || result?.kind === "conflict") return result.kind;
      if (result?.kind === "failed") throw new Error(failureMessages[result.reason]);
      throw new Error(uncertain);
    },
  };
}

function decodeCurrent(raw: string | null, observation: WorkspaceModeSshObservation) {
  const current = raw === null ? null : Object.freeze(decodeWorkspaceModeRecord(raw));
  if (
    (current?.generation ?? 0) !== observation.generation ||
    (current !== null && !sameIdentity(current, observation.identity))
  ) {
    throw new Error("SSH workspace mode record does not match its observation.");
  }
  return current;
}
