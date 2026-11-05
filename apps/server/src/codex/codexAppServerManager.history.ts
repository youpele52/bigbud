import { TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { hasQualifiedCodexModernProtocol } from "./codexAppServerManager.capabilities.ts";
import {
  parseThreadSnapshot,
  readArray,
  readObject,
  readString,
} from "./codexAppServerManager.protocol.ts";
import {
  CodexReadBudget,
  readCodexPage,
  type CodexReadLimits,
} from "./codexAppServerManager.pagination.ts";
import type { CodexSessionContext, CodexThreadSnapshot } from "./codexAppServerManager.types.ts";
import type { TurnOps } from "./codexAppServerManager.turn.ts";
import { readResumeThreadId } from "./codexAppServerManager.utils.ts";

export function codexHistoryMetadataFingerprint(thread: Record<string, unknown>): string {
  return JSON.stringify([
    thread.id,
    thread.historyMode,
    thread.status,
    thread.updatedAt,
    thread.ephemeral,
  ]);
}

/** A final metadata fence detects observable cross-client mutations during pagination. */
export async function verifyCodexHistoryStable(
  context: CodexSessionContext,
  history: CodexThreadSnapshot,
  ops: Pick<TurnOps, "sendRequest">,
) {
  const generation = context.historyGeneration ?? 0;
  const response = await ops.sendRequest(context, "thread/read", {
    threadId: history.threadId,
    includeTurns: false,
  });
  const thread = readObject(response, "thread");
  if (
    context.stopping ||
    generation !== (context.historyGeneration ?? 0) ||
    !thread ||
    readResumeThreadId(context.session) !== history.threadId ||
    codexHistoryMetadataFingerprint(thread) !== history.metadataFingerprint
  )
    throw new Error("Codex native history changed during inspection; outcome is unavailable.");
}

/** Complete, neutral history; never mutates the session or canonical projection. */
export async function readCodexThreadHistory(
  context: CodexSessionContext,
  ops: Pick<TurnOps, "sendRequest">,
  limits?: CodexReadLimits,
): Promise<CodexThreadSnapshot> {
  const threadId = readResumeThreadId(context.session);
  if (!threadId) throw new Error("Session is missing a provider resume thread id.");
  const generation = context.historyGeneration ?? 0;
  const epoch = context.session.sessionEpoch;
  const budget = new CodexReadBudget(limits);
  const assertCurrent = () => {
    budget.remainingMs();
    if (
      context.stopping ||
      epoch !== context.session.sessionEpoch ||
      threadId !== readResumeThreadId(context.session) ||
      generation !== (context.historyGeneration ?? 0)
    ) {
      throw new Error("Codex history changed during the read; the stale snapshot was discarded.");
    }
  };
  const request = async (method: string, params: unknown) => {
    assertCurrent();
    const result = await ops.sendRequest(context, method, params, budget.remainingMs());
    assertCurrent();
    return result;
  };
  const modern = hasQualifiedCodexModernProtocol(context.runtimeVersion);
  if (!modern && context.runtimeVersion !== "0.100.0") {
    throw new Error(
      "Complete Codex history is unavailable for this unqualified runtime version; no mutation was attempted.",
    );
  }
  const metadata = await request("thread/read", { threadId, includeTurns: !modern });
  const thread = readObject(metadata, "thread");
  const responseThreadId =
    readString(thread, "id") ?? (!modern ? readString(metadata, "threadId") : undefined);
  if (responseThreadId !== threadId) throw new Error("Codex history returned a different thread.");
  if (modern) budget.consume(metadata, 0);
  if (!modern || thread?.historyMode === "legacy") {
    const response = modern
      ? await request("thread/read", { threadId, includeTurns: true })
      : metadata;
    const snapshot = parseThreadSnapshot("thread/read", response);
    if (snapshot.threadId !== threadId)
      throw new Error("Codex history returned a different thread.");
    budget.consume(
      response,
      snapshot.turns.length + snapshot.turns.reduce((n, turn) => n + turn.items.length, 0),
    );
    assertCurrent();
    return {
      ...snapshot,
      historyMode: readString(thread, "historyMode"),
      nativeStatus: readString(readObject(thread, "status"), "type"),
      ephemeral: typeof thread?.ephemeral === "boolean" ? thread.ephemeral : undefined,
    };
  }
  if (thread?.historyMode !== "paginated")
    throw new Error("Codex thread history mode is not qualified.");
  const turns: CodexThreadSnapshot["turns"] = [];
  const turnIds = new Set<string>();
  const itemIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = readCodexPage(
      await request("thread/turns/list", {
        threadId,
        cursor,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
      }),
      cursors,
      budget,
    );
    for (const value of page.data) {
      const turn = readObject(value);
      const id = readString(turn, "id");
      if (!id || turnIds.has(id) || !readArray(turn, "items"))
        throw new Error("Codex returned a malformed or duplicate turn.");
      turnIds.add(id);
      let items = readArray(turn, "items")!;
      if (turn?.itemsView === "full") budget.addRecords(items.length);
      if (turn?.itemsView !== "full") {
        items = [];
        const itemCursors = new Set<string>();
        let itemCursor: string | null = null;
        do {
          const itemPage = readCodexPage(
            await request("thread/items/list", {
              threadId,
              turnId: id,
              cursor: itemCursor,
              limit: 100,
              sortDirection: "asc",
            }),
            itemCursors,
            budget,
          );
          for (const entry of itemPage.data) {
            if (readString(entry, "turnId") !== id)
              throw new Error("Codex returned an item from a different turn.");
            const item = readObject(entry, "item");
            if (!item) throw new Error("Codex returned a malformed thread item.");
            items.push(item);
          }
          itemCursor = itemPage.nextCursor;
        } while (itemCursor !== null);
      }
      for (const item of items) {
        const itemId = readString(item, "id");
        if (!itemId || itemIds.has(itemId))
          throw new Error("Codex returned a malformed or duplicate item.");
        itemIds.add(itemId);
      }
      const completedAt =
        typeof turn?.completedAt === "number" &&
        Number.isFinite(turn.completedAt) &&
        turn.completedAt > 0
          ? new Date(turn.completedAt * 1000).toISOString()
          : undefined;
      turns.push({
        id: TurnId.makeUnsafe(id),
        items,
        status: readString(turn, "status"),
        error: turn?.error,
        completedAt,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  assertCurrent();
  return {
    threadId,
    turns,
    historyMode: "paginated",
    nativeStatus: readString(readObject(thread, "status"), "type"),
    ephemeral: typeof thread.ephemeral === "boolean" ? thread.ephemeral : undefined,
    metadataFingerprint: codexHistoryMetadataFingerprint(thread),
  };
}
