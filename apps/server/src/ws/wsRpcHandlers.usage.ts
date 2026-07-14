import { Effect, Schema } from "effect";
import {
  ServerGetUsageSummaryInput,
  ServerUsageError,
  type ServerUsageRange,
  type ServerUsageSummaryResult,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { usageProviderCoverage } from "../orchestration/usageAccountingSupport.ts";
import type { WsRpcContext } from "./wsRpcContext";

type UsageAccumulator = {
  usedTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  turnCount: number;
};

type UsageEntry = UsageAccumulator & {
  contributionId: string;
  threadId: string;
  turnId: string | null;
  turnKey: string;
  createdAt: string;
  createdAtMs: number;
  provider: string;
  model: string;
  interactionMode: string;
};

type UsageGroup = Omit<UsageAccumulator, "turnCount"> & {
  turnKeys: Set<string>;
};

function toUsageError(cause: unknown, message: string) {
  return Schema.is(ServerUsageError)(cause)
    ? cause
    : new ServerUsageError({
        message,
        cause,
      });
}

function parseValidDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getRangeStart(range: ServerUsageRange, now: Date): Date | null {
  switch (range) {
    case "24h":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":
      return null;
  }
}

function getBucketStart(isoDate: string, range: ServerUsageRange) {
  const date = new Date(isoDate);
  if (range === "all") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
  } else if (range === "24h") {
    date.setUTCMinutes(0, 0, 0);
  } else {
    date.setUTCHours(0, 0, 0, 0);
  }
  return date.toISOString();
}

function emptyUsageGroup(): UsageGroup {
  return {
    usedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnKeys: new Set<string>(),
  };
}

function addUsage(target: UsageGroup, entry: UsageEntry) {
  target.usedTokens += entry.usedTokens;
  target.inputTokens += entry.inputTokens;
  target.cachedInputTokens += entry.cachedInputTokens;
  target.outputTokens += entry.outputTokens;
  target.reasoningOutputTokens += entry.reasoningOutputTokens;
  target.turnKeys.add(entry.turnKey);
}

function completeUsageGroup(group: UsageGroup): UsageAccumulator {
  return {
    usedTokens: group.usedTokens,
    inputTokens: group.inputTokens,
    cachedInputTokens: group.cachedInputTokens,
    outputTokens: group.outputTokens,
    reasoningOutputTokens: group.reasoningOutputTokens,
    turnCount: group.turnKeys.size,
  };
}

function sortBreakdownEntries<T extends { usedTokens: number; label: string }>(entries: T[]) {
  return entries.toSorted(
    (left, right) => right.usedTokens - left.usedTokens || left.label.localeCompare(right.label),
  );
}

function computeStreakDays(entries: ReadonlyArray<UsageEntry>) {
  if (entries.length === 0) {
    return 0;
  }

  const dayKeys = new Set(entries.map((entry) => entry.createdAt.slice(0, 10)));
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);

  let streakDays = 0;
  while (dayKeys.has(cursor.toISOString().slice(0, 10))) {
    streakDays += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return streakDays;
}

function buildUsageSummary(
  entries: ReadonlyArray<UsageEntry>,
  range: ServerUsageRange,
  historyStatus: ServerUsageSummaryResult["historyStatus"],
): ServerUsageSummaryResult {
  const totals = emptyUsageGroup();
  const bucketMap = new Map<string, UsageGroup>();
  const providerMap = new Map<string, UsageGroup>();
  const modelMap = new Map<string, UsageGroup>();
  const modeMap = new Map<string, Set<string>>();

  for (const entry of entries) {
    addUsage(totals, entry);

    const bucketStart = getBucketStart(entry.createdAt, range);
    const bucket = bucketMap.get(bucketStart) ?? emptyUsageGroup();
    addUsage(bucket, entry);
    bucketMap.set(bucketStart, bucket);

    const provider = providerMap.get(entry.provider) ?? emptyUsageGroup();
    addUsage(provider, entry);
    providerMap.set(entry.provider, provider);

    const model = modelMap.get(entry.model) ?? emptyUsageGroup();
    addUsage(model, entry);
    modelMap.set(entry.model, model);

    const modeTurns = modeMap.get(entry.interactionMode) ?? new Set<string>();
    modeTurns.add(entry.turnKey);
    modeMap.set(entry.interactionMode, modeTurns);
  }

  const providers = sortBreakdownEntries(
    Array.from(providerMap.entries(), ([label, group]) => ({
      id: label,
      label,
      ...completeUsageGroup(group),
    })),
  );
  const models = sortBreakdownEntries(
    Array.from(modelMap.entries(), ([label, group]) => ({
      id: label,
      label,
      ...completeUsageGroup(group),
    })),
  );
  const buckets = Array.from(bucketMap.entries(), ([bucketStart, group]) => ({
    bucketStart,
    ...completeUsageGroup(group),
  })).toSorted((left, right) => left.bucketStart.localeCompare(right.bucketStart));

  const favoriteMode =
    Array.from(modeMap.entries()).toSorted(
      (left, right) => right[1].size - left[1].size || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? null;

  return {
    range,
    generatedAt: new Date().toISOString(),
    historyStatus,
    providerCoverage: usageProviderCoverage(),
    totals: completeUsageGroup(totals),
    buckets,
    providers,
    models,
    favoriteProvider: providers[0] ?? null,
    favoriteModel: models[0] ?? null,
    favoriteMode,
    streakDays: computeStreakDays(entries),
  };
}

export function makeWsRpcUsageHandlers(context: WsRpcContext) {
  return {
    [WS_METHODS.serverGetUsageSummary]: (input: typeof ServerGetUsageSummaryInput.Type) =>
      observeRpcEffect(
        WS_METHODS.serverGetUsageSummary,
        Effect.gen(function* () {
          const rangeStart = getRangeStart(input.range, new Date());
          const [rows, historyStatus] = yield* Effect.all([
            context.projectionSnapshotQuery.getUsageEntries(rangeStart?.toISOString() ?? null),
            context.projectionSnapshotQuery.getUsageHistoryStatus(),
          ]);
          const entries: UsageEntry[] = rows.flatMap((row) => {
            const createdAt = parseValidDate(row.createdAt);
            return createdAt
              ? [
                  {
                    ...row,
                    createdAt: createdAt.toISOString(),
                    createdAtMs: createdAt.getTime(),
                    turnKey: `${row.threadId}:${row.turnId ?? row.contributionId}`,
                    turnCount: 1,
                  },
                ]
              : [];
          });

          return buildUsageSummary(entries, input.range, historyStatus);
        }).pipe(Effect.mapError((cause) => toUsageError(cause, "Failed to load usage summary"))),
        { "rpc.aggregate": "server" },
      ),
  };
}
