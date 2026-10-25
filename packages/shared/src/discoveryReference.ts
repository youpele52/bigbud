import type { ServerDiscoveredAgent } from "@bigbud/contracts/server/server.providers.ts";

type DiscoveryEntry = Pick<ServerDiscoveredAgent, "name" | "provider" | "source">;

function sourceRank(source: DiscoveryEntry["source"]): number {
  switch (source) {
    case "project":
      return 0;
    case "user":
      return 1;
    case "config":
      return 2;
    case "plugin":
      return 3;
    case "system":
      return 4;
  }
}

/** Resolve compact references identically for invocation and source-file navigation. */
export function resolveDiscoveryEntry<T extends DiscoveryEntry>(input: {
  readonly entries: ReadonlyArray<T>;
  readonly name: string;
  readonly preferredProvider: string | undefined;
}):
  | { readonly status: "resolved"; readonly entry: T }
  | { readonly status: "missing" }
  | { readonly status: "ambiguous"; readonly entries: Array<T> } {
  const matching = input.entries.filter(
    (entry) => entry.name.trim().toLowerCase() === input.name.trim().toLowerCase(),
  );
  if (matching.length === 0) return { status: "missing" };

  const bigbudEntries = matching.filter((entry) => entry.provider === "bigbud");
  if (bigbudEntries.length === 1) return { status: "resolved", entry: bigbudEntries[0]! };
  if (bigbudEntries.length > 1) return { status: "ambiguous", entries: bigbudEntries };

  const preferredEntry = matching.find((entry) => entry.provider === input.preferredProvider);
  if (preferredEntry) return { status: "resolved", entry: preferredEntry };
  if (matching.length === 1) return { status: "resolved", entry: matching[0]! };

  return {
    status: "ambiguous",
    entries: [...matching].toSorted((left, right) => {
      const bySource = sourceRank(left.source) - sourceRank(right.source);
      return bySource !== 0 ? bySource : left.provider.localeCompare(right.provider);
    }),
  };
}
