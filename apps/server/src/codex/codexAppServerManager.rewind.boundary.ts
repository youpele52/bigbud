import type {
  ProviderExactRewindInput,
  ProviderPreparedRewind,
} from "../provider/Services/ProviderRewind.ts";
import type { CodexThreadSnapshot } from "./codexAppServerManager.types.ts";
import { readString } from "./codexAppServerManager.protocol.ts";

/** Native compaction contents alone do not prove manual origin (pre-user automatic compaction exists). */
export function assertCodexRewindBoundary(
  input: ProviderExactRewindInput,
  history: CodexThreadSnapshot,
) {
  const ids = input.expectedTurnIds;
  const target = input.targetTurnCount;
  const expected = new Set(ids);
  let canonical = 0;
  const observed = new Set<string>();
  const exact = history.turns.every((turn) => {
    if (observed.has(turn.id)) return false;
    observed.add(turn.id);
    if (turn.id === ids[canonical]) {
      canonical++;
      return true;
    }
    if (expected.has(turn.id)) return false;
    const itemId = input.maintenanceTurns?.[turn.id];
    return (
      !!itemId &&
      turn.status === "completed" &&
      turn.error == null &&
      turn.items.some(
        (item) =>
          readString(item, "type") === "contextCompaction" && readString(item, "id") === itemId,
      ) &&
      !turn.items.some((item) => readString(item, "type") === "userMessage")
    );
  });
  if (
    !Number.isSafeInteger(target) ||
    target < 0 ||
    target > input.currentTurnCount ||
    input.currentTurnCount !== ids.length ||
    expected.size !== ids.length ||
    input.retainedTurnId !== (ids[target - 1] ?? null) ||
    input.firstRemovedTurnId !== (ids[target] ?? null) ||
    !exact ||
    canonical !== ids.length
  )
    throw new Error(
      "Canonical checkpoints do not identify the complete, exact native turn boundary.",
    );
  return history.turns.map((turn) => turn.id);
}

/** Revert still uses the canonical beforeTurnId; every preceding proven native turn must survive. */
export function retainedCodexTurnIds(input: ProviderPreparedRewind) {
  const ids = input.nativeTurnIds ?? input.expectedTurnIds;
  const end =
    input.firstRemovedTurnId === null ? ids.length : ids.indexOf(input.firstRemovedTurnId);
  if (end < 0)
    throw new Error(
      "The exact first removed native turn is missing from the persisted rewind prefix.",
    );
  return ids.slice(0, end);
}
