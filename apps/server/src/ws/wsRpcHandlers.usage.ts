import { Effect, Schema } from "effect";
import {
  ServerGetUsageSummaryInput,
  ServerUsageError,
  type ServerUsageRange,
  type ServerUsageSummaryResult,
  WS_METHODS,
} from "@bigbud/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
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
  createdAt: string;
  createdAtMs: number;
  provider: string;
  model: string;
  interactionMode: string;
};

function emptyUsageAccumulator(): UsageAccumulator {
  return {
    usedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    turnCount: 0,
  };
}

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

function addUsage(target: UsageAccumulator, entry: UsageAccumulator) {
  target.usedTokens += entry.usedTokens;
  target.inputTokens += entry.inputTokens;
  target.cachedInputTokens += entry.cachedInputTokens;
  target.outputTokens += entry.outputTokens;
  target.reasoningOutputTokens += entry.reasoningOutputTokens;
  target.turnCount += entry.turnCount;
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
): ServerUsageSummaryResult {
  const totals = emptyUsageAccumulator();
  const bucketMap = new Map<string, UsageAccumulator>();
  const providerMap = new Map<string, UsageAccumulator>();
  const modelMap = new Map<string, UsageAccumulator>();
  const modeMap = new Map<string, number>();

  for (const entry of entries) {
    addUsage(totals, entry);

    const bucketStart = getBucketStart(entry.createdAt, range);
    const bucket = bucketMap.get(bucketStart) ?? emptyUsageAccumulator();
    addUsage(bucket, entry);
    bucketMap.set(bucketStart, bucket);

    const provider = providerMap.get(entry.provider) ?? emptyUsageAccumulator();
    addUsage(provider, entry);
    providerMap.set(entry.provider, provider);

    const model = modelMap.get(entry.model) ?? emptyUsageAccumulator();
    addUsage(model, entry);
    modelMap.set(entry.model, model);

    modeMap.set(entry.interactionMode, (modeMap.get(entry.interactionMode) ?? 0) + 1);
  }

  const providers = sortBreakdownEntries(
    Array.from(providerMap.entries(), ([label, usage]) => ({
      id: label,
      label,
      usedTokens: usage.usedTokens,
      turnCount: usage.turnCount,
    })),
  );
  const models = sortBreakdownEntries(
    Array.from(modelMap.entries(), ([label, usage]) => ({
      id: label,
      label,
      usedTokens: usage.usedTokens,
      turnCount: usage.turnCount,
    })),
  );
  const buckets = Array.from(bucketMap.entries(), ([bucketStart, usage]) => ({
    bucketStart,
    usedTokens: usage.usedTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    turnCount: usage.turnCount,
  })).toSorted((left, right) => left.bucketStart.localeCompare(right.bucketStart));

  const favoriteMode =
    Array.from(modeMap.entries()).toSorted(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? null;

  return {
    range,
    generatedAt: new Date().toISOString(),
    totals,
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
          const rows = yield* context.projectionSnapshotQuery.getUsageEntries(
            rangeStart?.toISOString() ?? null,
          );
          const entries: UsageEntry[] = rows.flatMap((row) => {
            const createdAt = parseValidDate(row.createdAt);
            return createdAt
              ? [
                  {
                    ...row,
                    createdAt: createdAt.toISOString(),
                    createdAtMs: createdAt.getTime(),
                    turnCount: 1,
                  },
                ]
              : [];
          });

          return buildUsageSummary(entries, input.range);
        }).pipe(Effect.mapError((cause) => toUsageError(cause, "Failed to load usage summary"))),
        { "rpc.aggregate": "server" },
      ),
  };
}
