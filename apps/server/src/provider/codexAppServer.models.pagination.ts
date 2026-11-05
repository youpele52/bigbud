import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { CodexReadBudget, readCodexPage } from "../codex/codexAppServerManager.pagination.ts";
import { readObject, readString } from "../codex/codexAppServerManager.protocol.ts";
import { parseCodexModelsResult } from "./codexAppServer.models.ts";

/** Shared startup/discovery catalog accumulator; partial catalogs are never authoritative. */
export class CodexModelPages {
  private readonly budget = new CodexReadBudget({
    pages: 1000,
    records: 100_000,
    bytes: 64 * 1024 * 1024,
    timeoutMs: 5000,
  });
  private readonly cursors = new Set<string>();
  private readonly ids = new Set<string>();
  private readonly models: ServerProviderModel[] = [];
  remainingMs(): number {
    return this.budget.remainingMs();
  }
  append(value: unknown): {
    readonly models: readonly ServerProviderModel[];
    readonly nextCursor: string | null;
  } {
    const page = readCodexPage(value, this.cursors, this.budget, true);
    for (const entry of page.data) {
      const model = readObject(entry);
      const id = readString(model, "model") ?? readString(model, "id");
      if (!id?.trim() || this.ids.has(id.trim()))
        throw new Error("Codex model catalog contains a malformed or duplicate model.");
      this.ids.add(id.trim());
    }
    const parsed = parseCodexModelsResult({ data: page.data });
    if (!parsed) throw new Error("Codex model/list returned malformed data.");
    this.models.push(...parsed);
    return { models: this.models, nextCursor: page.nextCursor };
  }
}

export async function listCodexModels(
  request: (params: unknown, timeoutMs: number) => Promise<unknown>,
): Promise<readonly ServerProviderModel[]> {
  const pages = new CodexModelPages();
  let cursor: string | null = null;
  do {
    const page = pages.append(await request({ cursor, limit: 100 }, pages.remainingMs()));
    if (page.nextCursor === null) return page.models;
    cursor = page.nextCursor;
  } while (cursor !== null);
  throw new Error("Codex catalog pagination ended without a complete page.");
}
