import { ApprovalRequestId, type ProviderKind } from "@bigbud/contracts";
import { ProviderAdapterValidationError } from "./Errors.ts";

const generations = new WeakMap<object, string>();
export function interactionGeneration(owner: object): string {
  const existing = generations.get(owner);
  if (existing) return existing;
  const generation = crypto.randomUUID();
  generations.set(owner, generation);
  return generation;
}

/** The adapter invokes this before any dispatch. IDs minted by bigbud are already unique. */
export function refusePendingInteractions(input: {
  provider: ProviderKind;
  sessionEpoch: number;
  approvals?: ReadonlyMap<string, object>;
  userInputs?: ReadonlyMap<string, object>;
  nativeRequestIds?: boolean;
  generationFor?: (id: string, owner: object) => string;
}): ProviderAdapterValidationError | undefined {
  if (!input.approvals?.size && !input.userInputs?.size) return;
  const requests = (entries: ReadonlyMap<string, object> | undefined) =>
    [...(entries ?? [])].map(([id, owner]) => ({
      requestId: ApprovalRequestId.makeUnsafe(id),
      generation:
        input.generationFor?.(id, owner) ??
        (input.nativeRequestIds ? interactionGeneration(owner) : id),
    }));
  return new ProviderAdapterValidationError({
    provider: input.provider,
    operation: "sendTurn",
    issue: "Resolve or cancel the pending approval or user-input request first.",
    failureClass: "invalid-request",
    turnStartRefusal: {
      kind: "pending-interaction",
      gate: {
        provider: input.provider,
        sessionEpoch: input.sessionEpoch,
        approvalRequests: requests(input.approvals),
        userInputRequests: requests(input.userInputs),
      },
    },
  });
}

/** The turn was not sent, but this adapter cannot certify when its gate closes. */
export function holdUndispatchedInteraction(provider: ProviderKind, sessionEpoch: number) {
  return new ProviderAdapterValidationError({
    provider,
    operation: "sendTurn",
    failureClass: "invalid-request",
    issue:
      "The turn was not sent. It is held for manual recovery because interaction settlement is unconfirmed.",
    turnStartRefusal: {
      kind: "pending-interaction",
      gate: {
        provider,
        sessionEpoch,
        manualRecovery: "discard-and-resend",
        approvalRequests: [],
        userInputRequests: [],
      },
    },
  });
}
